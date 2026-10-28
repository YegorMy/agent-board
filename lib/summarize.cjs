'use strict';

// Closing summaries: byte-bounded model calls, map-reduce for large threads,
// structural validation with one retry, and the 8 KB summary cap with overflow.
// The model is, in order: CHANNEL_SUMMARIZER_CMD (prompt on stdin, summary on stdout), the adapter in
// <board>/summarizer.json (see lib/adapters), or `codex exec` with its default model.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const adapters = require('./adapters/index.cjs');
const config = require('./summarizer-config.cjs');

const SECTIONS = ['Outcome', 'Decisions', 'Changes made', 'Evidence', 'Corrections', 'Open items'];
const CITED_SECTIONS = ['Decisions', 'Changes made', 'Corrections'];
const SUMMARY_LIMIT = 8192;
const RETRY_RESERVE = 16 * 1024;
const CONCURRENCY = 3;
const CITATION = /\bT\d{4}\.M\d+\b|(?<![\w.])M\d{2,5}\b/g;

class SummarizerError extends Error {}

function bytes(text) {
  return Buffer.byteLength(text, 'utf8');
}

// UTF-8 bytes bound tokens from above, so a byte budget is a safe context bound for any language.
function chunkBudget() {
  return Number(process.env.CHANNEL_CHUNK_BYTES || 200 * 1024);
}

// What the next call will use. Custom command first, then summarizer.json, then the codex default.
// Errors in summarizer.json stop the call: the provider is never switched silently.
function resolve() {
  const command = process.env.CHANNEL_SUMMARIZER_CMD;
  if (command) return { kind: 'custom', command };
  let settings;
  try { settings = config.load(); } catch (error) { throw new SummarizerError(error.message); }
  if (settings) {
    try { adapters.get(settings.adapter); } catch (error) { throw new SummarizerError(`summarizer.json: ${error.message}`); }
    return { kind: 'configured', ...settings };
  }
  return { kind: 'default' };
}

// Names only the program for a custom command, so arguments (which could hold credentials) never land in SUMMARY.md.
function modelLabel(chosen = resolve()) {
  if (chosen.kind === 'custom') {
    return `command ${path.basename(chosen.command.trim().split(/\s+/)[0].replace(/^["']|["']$/g, ''))}`;
  }
  if (chosen.kind === 'configured') return `adapter ${chosen.adapter} · model ${chosen.model} · effort ${chosen.effort}`;
  return 'codex exec (default model)';
}

function header(m, label) {
  return `### ${m.id}${label ? ` ${label}` : ''} · ${m.ts} · ${m.from} → ${m.to} · ${m.kind}`
    + (m.re ? ` · re ${m.re}` : '');
}

function renderMessage(m) {
  return [header(m), `Subject: ${m.subject}`, m.body, m.refs.length ? `Refs: ${m.refs.join(', ')}` : '']
    .filter(Boolean).join('\n') + '\n';
}

function sliceBytes(text, limit) {
  const buf = Buffer.from(text, 'utf8');
  let end = Math.min(limit, buf.length);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

// Splits at line boundaries; a line longer than the limit is cut at a character boundary.
function splitText(text, limit) {
  const parts = [];
  let current = '';
  const flush = () => { if (current) parts.push(current); current = ''; };
  for (const line of text.split(/(?<=\n)/)) {
    let rest = line;
    while (bytes(rest) > limit) {
      flush();
      const head = sliceBytes(rest, limit);
      if (!head) throw new SummarizerError('chunk budget too small to split a message');
      parts.push(head);
      rest = rest.slice(head.length);
    }
    if (bytes(current) + bytes(rest) > limit) flush();
    current += rest;
  }
  flush();
  return parts;
}

// One unit per message; an oversized message becomes labelled parts that keep its id.
function units(messages, limit) {
  const out = [];
  for (const m of messages) {
    const text = renderMessage(m);
    if (bytes(text) <= limit) { out.push({ first: m.id, last: m.id, text }); continue; }
    const pieces = splitText(text.slice(text.indexOf('\n') + 1), limit - 1024);
    pieces.forEach((piece, i) => out.push({
      first: m.id, last: m.id, text: `${header(m, `part ${i + 1}/${pieces.length}`)}\n${piece}\n`,
    }));
  }
  return out;
}

function pack(items, limit) {
  const groups = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    if (current.length && size + bytes(item.text) > limit) { groups.push(current); current = []; size = 0; }
    current.push(item);
    size += bytes(item.text);
  }
  if (current.length) groups.push(current);
  return groups;
}

function joined(group) {
  return group.map((item) => item.text).join('\n');
}

const TEMPLATE = `Output exactly these six sections, in this order, with nothing before or after them:

## Outcome
One to three lines: what the thread concluded or delivered.

## Decisions
One bullet per decision, citing the message id(s) where it was made. If a human ruling is involved,
say so and point to where it is recorded; never present it as your own authority.

## Changes made
Commits, files, installs, pushes and messages sent outside the thread, each citing message ids.

## Evidence
Paths, commits and commands named in the thread that hold the evidence.

## Corrections
Claims later withdrawn or narrowed: cite the claim's id and the correcting id. Write "None." if there were none.

## Open items
Unresolved questions or pending work, with owner, next step and message ids. Write "None." if there are none.

Rules:
- Cite message ids exactly as they appear in the "###" headers, for example (T0007.M012). Cite only ids that appear in the input.
- Every bullet under Decisions, Changes made and Corrections cites at least one id.
- Preserve exact identifiers: commit hashes, paths, issue ids, versions.
- Do not invent facts. When messages conflict, report the final position and list the change under Corrections.
- Short, precise bullets in English.`;

function threadLine(meta, range) {
  return `Thread ${meta.id} — "${meta.title}", opened by ${meta.opened_by}`
    + (meta.continues ? `, continuing ${meta.continues}` : '') + `. Source range: ${range}.`;
}

const PREAMBLE = 'You write the closing summary of a coordination thread between AI agents '
  + 'and the humans they work with. Do not run commands or read files: everything you need is in this message.';

function finalPrompt(meta, range, body, merged) {
  return `${PREAMBLE}\n\n${threadLine(meta, range)}\n\n${merged
    ? 'Below are partial summaries of consecutive parts of the thread, in order. Merge them into one summary. '
      + 'Later parts override earlier ones: drop open items a later part resolved, and record withdrawn or '
      + 'narrowed claims under Corrections. Keep the id citations that support each kept bullet.'
    : 'The thread messages follow the instructions.'}\n\n${TEMPLATE}\n- Keep the whole summary under 7000 bytes.\n\n`
    + `=== ${merged ? 'PARTIAL SUMMARIES' : 'MESSAGES'} ===\n\n${body}`;
}

function mapPrompt(meta, range, index, count, part) {
  return `${PREAMBLE}\n\n${threadLine(meta, range)}\n\nThis is part ${index + 1} of ${count}, covering `
    + `${part.first}–${part.last}. Summarize this part only. Under Open items, also list questions this part `
    + `leaves unresolved; later parts may answer them.\n\n${TEMPLATE}\n- Keep this partial summary under 8000 bytes.\n\n`
    + `=== MESSAGES ===\n\n${part.body}`;
}

function mergePrompt(meta, range, body) {
  return `${PREAMBLE}\n\n${threadLine(meta, range)}\n\nBelow are partial summaries of consecutive parts of the `
    + 'thread, in order. Merge them into one partial summary of the parts they cover; more merging follows. '
    + 'Keep unresolved questions under Open items and every supporting id citation.\n\n'
    + `${TEMPLATE}\n- Keep this merged summary under 8000 bytes.\n\n=== PARTIAL SUMMARIES ===\n\n${body}`;
}

function retryPrompt(prompt, draft, failures) {
  return `${prompt}\n\n=== YOUR PREVIOUS DRAFT FAILED THESE CHECKS ===\n${failures.map((f) => `- ${f}`).join('\n')}\n\n`
    + `=== PREVIOUS DRAFT ===\n${draft}\n\nWrite the corrected complete summary now, following every rule above.`;
}

// Builds the process to run: the custom shell command, or the adapter's invocation.
function launch(chosen, work, effort) {
  if (chosen.kind === 'custom') return { bin: '/bin/sh', args: ['-c', chosen.command], env: {}, extract: (stdout) => stdout, missing: 'set CHANNEL_SUMMARIZER_CMD' };
  const configured = chosen.kind === 'configured';
  const adapter = adapters.get(configured ? chosen.adapter : 'codex');
  let call;
  try {
    call = adapter.invocation({ model: configured ? chosen.model : '', effort: configured ? chosen.effort : effort, cwd: work, tmpDir: work });
  } catch (error) { throw new SummarizerError(error.message); }
  return { ...call, missing: configured ? 'run agent-board setup' : 'set CHANNEL_SUMMARIZER_CMD' };
}

function runModel(prompt, phase, effort, chosen = resolve()) {
  const timeoutMs = Number(process.env.CHANNEL_SUMMARIZER_TIMEOUT_MS || 15 * 60 * 1000);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-summary-'));
  let call;
  try {
    // A configured effort applies to every phase.
    call = launch(chosen, work, effort);
  } catch (error) {
    fs.rmSync(work, { recursive: true, force: true });
    return Promise.reject(error);
  }
  const used = chosen.kind === 'configured' ? chosen.effort : effort;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(call.bin, call.args, {
      cwd: work, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...call.env, CHANNEL_SUMMARY_PHASE: phase, CHANNEL_SUMMARY_EFFORT: used },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
    child.stdin.on('error', () => { });
    child.on('error', (error) => {
      clearTimeout(timer);
      fs.rmSync(work, { recursive: true, force: true });
      reject(new SummarizerError(error.code === 'ENOENT'
        ? `${call.bin} not found; install it or ${call.missing}`
        : `${call.bin}: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let text = '';
      let failure = null;
      try { text = call.extract(stdout, work); } catch (error) { failure = error; }
      fs.rmSync(work, { recursive: true, force: true });
      if (signal) return reject(new SummarizerError(`${phase} call stopped by ${signal} (timeout ${timeoutMs} ms)`));
      if (code !== 0) return reject(new SummarizerError(`${phase} call exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
      if (failure) return reject(new SummarizerError(`${phase} call: ${failure.message}`));
      if (!text.trim()) return reject(new SummarizerError(`${phase} call returned an empty summary`));
      resolvePromise(text.trim() + '\n');
    });
    child.stdin.end(prompt);
  });
}

async function pool(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

// Drops anything before the first section heading (for example a title the model added).
function normalize(draft) {
  const start = draft.search(/^## /m);
  return (start > 0 ? draft.slice(start) : draft).trim() + '\n';
}

function parseSections(draft) {
  const sections = [];
  for (const line of draft.split('\n')) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) { sections.push({ name: heading[1], lines: [] }); continue; }
    if (sections.length) sections[sections.length - 1].lines.push(line);
  }
  return sections.map((section) => {
    const items = [];
    const preamble = [];
    for (const line of section.lines) {
      if (/^\s{0,1}([-*]|\d+\.)\s/.test(line)) items.push(line);
      else if (items.length && line.trim()) items[items.length - 1] += `\n${line}`;
      else if (line.trim()) preamble.push(line);
    }
    return { name: section.name, items, preamble: preamble.join('\n') };
  });
}

function citations(text) {
  return text.match(CITATION) || [];
}

function validate(draft, known) {
  const failures = [];
  const sections = parseSections(draft);
  const byName = new Map(sections.map((s) => [s.name, s]));
  for (const name of SECTIONS) if (!byName.has(name)) failures.push(`missing section "## ${name}"`);
  const outcome = byName.get('Outcome');
  if (outcome && !outcome.preamble.trim() && !outcome.items.length) failures.push('empty Outcome');
  const unknown = [...new Set(citations(draft).filter((id) => !known(id)))];
  if (unknown.length) failures.push(`cited ids not in the source: ${unknown.slice(0, 12).join(', ')}`);
  for (const name of CITED_SECTIONS) {
    const bare = (byName.get(name) || { items: [] }).items.filter((item) => !citations(item).length);
    if (bare.length) failures.push(`${bare.length} item(s) under "${name}" cite no message id`);
  }
  return failures;
}

async function summarize(meta, messages, known) {
  if (!messages.length) throw new SummarizerError(`${meta.id} has no messages to summarize`);
  const fit = chunkBudget() - RETRY_RESERVE;
  const range = `${messages[0].id}–${messages[messages.length - 1].id}`;
  const stats = { single: 0, map: 0, merge: 0, reduce: 0, retry: 0 };
  const chosen = resolve();
  const call = (prompt, phase, effort) => { stats[phase]++; return runModel(prompt, phase, effort, chosen); };
  const items = units(messages, fit);
  let prompt;
  let phase;
  if (items.reduce((sum, item) => sum + bytes(item.text), 0) <= fit) {
    prompt = finalPrompt(meta, range, joined(items), false);
    phase = 'single';
  } else {
    const chunks = pack(items, fit).map((group) => ({ first: group[0].first, last: group[group.length - 1].last, body: joined(group) }));
    const partials = await pool(chunks, (chunk, i) => call(mapPrompt(meta, range, i, chunks.length, chunk), 'map', 'low'));
    let level = partials.map((text, i) => ({ first: chunks[i].first, last: chunks[i].last, text: `#### Part ${chunks[i].first}–${chunks[i].last}\n\n${text}` }));
    // Merge recursively until the partials fit one final call, so any thread size is covered.
    while (level.reduce((sum, item) => sum + bytes(item.text), 0) > fit) {
      const groups = pack(level, fit);
      if (groups.length === level.length) throw new SummarizerError('partial summaries are too large to merge within the chunk budget');
      const merged = await pool(groups, (group) => call(mergePrompt(meta, range, joined(group)), 'merge', 'medium'));
      level = groups.map((group, i) => ({ first: group[0].first, last: group[group.length - 1].last, text: `#### Parts ${group[0].first}–${group[group.length - 1].last}\n\n${merged[i]}` }));
    }
    prompt = finalPrompt(meta, range, joined(level), true);
    phase = 'reduce';
  }
  let draft = normalize(await call(prompt, phase, 'medium'));
  let failures = validate(draft, known);
  if (failures.length) {
    draft = normalize(await call(retryPrompt(prompt, draft, failures), 'retry', 'medium'));
    failures = validate(draft, known);
  }
  return { draft, failures, stats, model: modelLabel(chosen), range };
}

// Keeps SUMMARY.md within the cap: Outcome stays whole, the other sections keep items round-robin,
// and everything that does not fit moves to SUMMARY-OVERFLOW.md. Nothing is dropped.
function fitSummary(head, draft, limit = SUMMARY_LIMIT) {
  if (bytes(head + draft) <= limit) return { summary: head + draft, overflow: null, moved: 0 };
  const sections = parseSections(draft);
  const kept = sections.map((s) => ({ ...s, keep: s.name === 'Outcome' ? s.items.length : 0 }));
  const note = 100;
  const render = (list, pick) => list.map((s) => {
    const items = pick(s);
    if (!items.length && !s.preamble && s.name !== 'Outcome') return null;
    return [`## ${s.name}`, '', s.preamble, ...items].filter((part) => part !== '').join('\n');
  }).filter(Boolean).join('\n\n') + '\n';
  let used = bytes(head) + bytes(render(kept, (s) => s.items.slice(0, s.keep))) + note * sections.length;
  for (let progress = true; progress;) {
    progress = false;
    for (const s of kept) {
      if (s.keep >= s.items.length || s.full) continue;
      const cost = bytes(s.items[s.keep]) + 1;
      if (used + cost > limit) { s.full = true; continue; }
      used += cost;
      s.keep++;
      progress = true;
    }
  }
  let moved = 0;
  const summary = head + render(kept, (s) => {
    const rest = s.items.length - s.keep;
    moved += rest;
    return rest ? [...s.items.slice(0, s.keep), `- … ${rest} more item(s) in [SUMMARY-OVERFLOW.md](SUMMARY-OVERFLOW.md)`] : s.items.slice(0, s.keep);
  });
  const overflow = render(kept.filter((s) => s.keep < s.items.length), (s) => s.items.slice(s.keep));
  return { summary, overflow, moved };
}

function sectionText(draft, name) {
  const section = parseSections(draft).find((s) => s.name === name);
  return section ? [section.preamble, ...section.items].filter(Boolean).join(' ') : '';
}

// The only call outside a closing: a short synthetic prompt, nothing from the board.
async function probe(chosen = resolve()) {
  const started = Date.now();
  const text = await runModel('Reply with the single word OK.', 'test', 'low', chosen);
  return { text: text.trim(), ms: Date.now() - started };
}

module.exports = { SummarizerError, resolve, probe, summarize, validate, fitSummary, units, pack, splitText, sectionText, modelLabel, SUMMARY_LIMIT };

'use strict';

// Threaded message board for local AI agents. See README.md for commands, layout and etiquette.

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.cjs');
const summarizer = require('./summarize.cjs');
const { setup } = require('./setup.cjs');
const { ringTmux } = require('./ring-tmux.cjs');
const { installSkill } = require('./install-skill.cjs');

const { fail, ChannelError } = store;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { opts._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return opts;
}

function required(opts, key, hint) {
  if (typeof opts[key] !== 'string') fail(`--${key} ${hint} is required`);
  return opts[key];
}

function agentOpt(opts, key) {
  return store.checkAgentName(required(opts, key, '<agent>'));
}

function toOpt(opts, fallback) {
  return typeof opts.to === 'string' ? store.checkAgentName(opts.to) : fallback;
}

function bodyFrom(opts) {
  if (typeof opts.body === 'string') return opts.body;
  if (typeof opts['body-file'] === 'string') {
    return fs.readFileSync(opts['body-file'] === '-' ? 0 : opts['body-file'], 'utf8').trimEnd();
  }
  return '';
}

function refsFrom(opts) {
  return typeof opts.refs === 'string' ? opts.refs.split(',').map((r) => r.trim()).filter(Boolean) : [];
}

function kindFrom(opts, fallback) {
  const kind = typeof opts.kind === 'string' ? opts.kind : fallback;
  if (!store.KINDS.includes(kind)) fail(`--kind must be one of ${store.KINDS.join(', ')}`);
  return kind;
}

function warn(text) {
  process.stderr.write(`agent-board: ${text}\n`);
}

function sizeWarning(meta) {
  if (meta.message_count > store.WARN_MESSAGES || meta.bytes > store.WARN_BYTES) {
    warn(`${meta.id} has ${meta.message_count} messages (${store.kb(meta.bytes)}). Consider closing it `
      + `(thread close --thread ${meta.id}) and continuing with thread open --continues ${meta.id}.`);
  }
}

// Read commands never create a board, so a wrong directory shows up instead of looking like an empty board.
function boardNote() {
  if (!fs.existsSync(store.paths.dir)) {
    warn(`no board at ${store.paths.dir} yet (the first thread open creates it; use --dir or CHANNEL_DIR to point elsewhere)`);
  }
}

// --- doorbells -----------------------------------------------------------------------------------

function hasDoorbell(spec) {
  return Boolean(spec) && (typeof spec.tmux === 'string' || (Array.isArray(spec.doorbell) && spec.doorbell.length > 0));
}

function ringTargets(entry, explicit) {
  const registry = store.readJson(store.paths.agents) || {};
  if (explicit) return [{ agent: explicit, spec: registry[explicit], explicit: true }];
  const names = entry.to === 'all' ? Object.keys(registry).filter((name) => name !== entry.from) : [entry.to];
  return names.map((agent) => ({ agent, spec: registry[agent], explicit: entry.to !== 'all' }));
}

// Returns null on success, otherwise a one-line reason.
function sendDoorbell(spec, text) {
  if (typeof spec.tmux === 'string') return ringTmux(spec.tmux, text);
  const argv = spec.doorbell.map((part) => String(part).split('{message}').join(text));
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60000 });
  if (result.error) return result.error.message;
  if (result.status !== 0) return (result.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${result.status}`;
  return null;
}

// The post is already saved; a failed doorbell reports the real id and how to retry it.
function ring(entry, explicit) {
  const failures = [];
  const subject = entry.subject.length > 80 ? `${entry.subject.slice(0, 77)}...` : entry.subject;
  const text = `agent-board: ${entry.id} for you (${subject})`;
  for (const { agent, spec, explicit: needed } of ringTargets(entry, explicit)) {
    if (!hasDoorbell(spec)) {
      if (needed) failures.push(`${agent}: no doorbell in agents.json`);
      continue;
    }
    const reason = sendDoorbell(spec, text);
    if (reason) failures.push(`${agent}: ${reason}`);
    else process.stdout.write(`rang ${agent} for ${entry.id}\n`);
  }
  for (const failure of failures) warn(`ring failed for ${failure}; retry with: ring --id ${entry.id}${explicit ? ` --to ${explicit}` : ''}`);
  return failures.length === 0;
}

function ringOpt(opts) {
  return typeof opts.ring === 'string' ? store.checkAgentName(opts.ring) : null;
}

// --- posting -------------------------------------------------------------------------------------

function newEntry(meta, seq, fields) {
  return {
    id: store.messageId(meta, seq), thread: meta.id, seq, ts: store.now(), from: fields.from, to: fields.to,
    kind: fields.kind, re: fields.re || null, subject: fields.subject, body: fields.body, refs: fields.refs,
  };
}

function postableOrFail(meta) {
  if (meta.status === 'archived') {
    fail(`${meta.id} is archived. Open a new thread that continues it: thread open --continues ${meta.id} --title "..."`);
  }
  if (meta.status === 'closing') {
    const closing = store.readJson(path.join(store.threadDir(meta.id), 'closing.json')) || {};
    fail(`${meta.id} is closing (attempt ${closing.attempt_id} by ${closing.by} since ${closing.started_at}); `
      + `posts are refused until the close finishes or ${meta.opened_by} runs thread close --reopen`);
  }
  if (meta.status !== 'open') fail(`${meta.id} is ${meta.status}; posts are refused`);
}

function post(opts) {
  const from = agentOpt(opts, 'from');
  const subject = required(opts, 'subject', '"<one line>"');
  const kind = kindFrom(opts, 'note');
  const parent = typeof opts.re === 'string' ? store.findMessage(opts.re) : null;
  const threadId = typeof opts.thread === 'string' ? opts.thread : (parent ? parent.thread : null);
  if (!threadId) {
    fail('posts need a thread: --thread T0007, or --re <message id> to reply in its thread. '
      + 'Start a topic with: thread open --from <agent> --title "..." --body-file -. List threads with: threads');
  }
  const body = bodyFrom(opts);
  const to = toOpt(opts, parent && parent.from !== from ? parent.from : 'all');
  const explicitRing = ringOpt(opts);
  store.readMeta(threadId);
  const { entry, meta } = store.withLock(store.threadLock(threadId), () => {
    const current = store.readMeta(threadId);
    postableOrFail(current);
    const messages = store.readMessages(threadId);
    const made = newEntry(current, messages.length + 1, { from, to, kind, re: parent && parent.id, subject, body, refs: refsFrom(opts) });
    store.appendMessage(threadId, made);
    const all = [...messages, made];
    store.writeMeta(store.syncMeta(current, all));
    store.renderThread(current, all);
    return { entry: made, meta: current };
  });
  store.refreshIndex();
  process.stdout.write(`posted ${entry.id}\n`);
  sizeWarning(meta);
  if (opts.ring && !ring(entry, explicitRing)) process.exitCode = 3;
}

function continuationHeader(previousId) {
  const meta = store.readMeta(previousId);
  if (meta.status !== 'archived') fail(`${previousId} is ${meta.status}; only archived threads can be continued`);
  const summary = fs.readFileSync(path.join(store.threadDir(previousId), 'SUMMARY.md'), 'utf8').trimEnd();
  return `Continues ${previousId} — "${meta.title}" (summary validation: ${meta.summary_validation}; `
    + `model: ${meta.summary_model}). Its SUMMARY.md follows; the archived messages remain the source `
    + `(read --thread ${previousId} --range ...).\n\n${summary}\n\n---\n\n`;
}

function openThread(opts) {
  const from = agentOpt(opts, 'from');
  const title = required(opts, 'title', '"<topic>"');
  const kind = kindFrom(opts, 'note');
  const to = toOpt(opts, 'all');
  const explicitRing = ringOpt(opts);
  const continues = typeof opts.continues === 'string' ? opts.continues : null;
  const prefix = continues ? continuationHeader(continues) : '';
  const body = prefix + bodyFrom(opts);
  fs.mkdirSync(store.paths.threads, { recursive: true });
  const entry = store.withLock(store.paths.lock, () => {
    const id = store.nextThreadId();
    const tmp = path.join(store.paths.threads, `.${id}.${process.pid}.tmp`);
    fs.mkdirSync(tmp);
    const meta = {
      id, title, status: 'open', opened_by: from, opened_at: store.now(), continues, participants: [],
      message_count: 0, bytes: 0, last_at: null,
      archived_at: null, summary_model: null, summary_validation: null, outcome: null,
    };
    const made = newEntry(meta, 1, {
      from, to, kind, subject: typeof opts.subject === 'string' ? opts.subject : title, body, refs: refsFrom(opts),
    });
    meta.opened_at = made.ts;
    fs.writeFileSync(path.join(tmp, 'messages.jsonl'), JSON.stringify(made) + '\n');
    fs.renameSync(tmp, store.threadDir(id));
    store.writeMeta(store.syncMeta(meta, [made]));
    store.renderThread(meta, [made]);
    store.renderIndex();
    return made;
  });
  process.stdout.write(`posted ${entry.id}\n`);
  if (opts.ring && !ring(entry, explicitRing)) process.exitCode = 3;
}

function ringCommand(opts) {
  const entry = store.findMessage(required(opts, 'id', '<message id>'));
  if (!ring(entry, typeof opts.to === 'string' ? store.checkAgentName(opts.to) : null)) process.exitCode = 3;
}

// --- closing -------------------------------------------------------------------------------------

function closingPath(id) {
  return path.join(store.threadDir(id), 'closing.json');
}

function frozenSha(id, last) {
  const text = fs.readFileSync(store.messagesPath(id), 'utf8');
  const lines = text.split('\n').slice(0, last);
  return store.sha256(lines.join('\n') + '\n');
}

// Phase 1, under the thread lock: check the opener, freeze the range, mark the thread closing.
function beginClose(id, from, opts) {
  store.readMeta(id);
  return store.withLock(store.threadLock(id), () => {
    const meta = store.readMeta(id);
    if (meta.opened_by !== from) fail(`only the opener (${meta.opened_by}) can close ${id}; ask them in the thread`);
    if (meta.status === 'archived') fail(`${id} is already archived`);
    const file = closingPath(id);
    if (meta.status === 'closing') {
      const previous = store.readJson(file);
      if (opts.reopen) {
        fs.rmSync(file, { force: true });
        meta.status = 'open';
        store.writeMeta(meta);
        return null;
      }
      if (!opts.retry) {
        fail(`${id} is closing since ${previous.started_at} (attempt ${previous.attempt_id}). `
          + 'If no close is running, rerun with --retry (same range) or --reopen (back to open)');
      }
      if (frozenSha(id, previous.last) !== previous.source_sha256) fail(`${id} messages changed inside the frozen range; inspect before retrying`);
      const attempt = { ...previous, attempt_id: crypto.randomBytes(6).toString('hex'), started_at: store.now(), retry_of: previous.attempt_id };
      store.writeJson(file, attempt);
      return attempt;
    }
    if (opts.retry || opts.reopen) fail(`${id} is not closing; --retry and --reopen apply only to an interrupted close`);
    const messages = store.readMessages(id);
    const attempt = {
      attempt_id: crypto.randomBytes(6).toString('hex'), by: from, first: 1, last: messages.length,
      source_sha256: frozenSha(id, messages.length), started_at: store.now(),
    };
    store.writeJson(file, attempt);
    meta.status = 'closing';
    store.writeMeta(meta);
    return attempt;
  });
}

function summaryHead(meta, attempt, result, overflowNote) {
  const messages = store.readMessages(meta.id).slice(0, attempt.last);
  const validation = result.failures.length ? `failed: ${result.failures.join('; ')}` : 'ok';
  const calls = Object.entries(result.stats).filter(([, n]) => n).map(([phase, n]) => `${n} ${phase}`).join(', ');
  const lines = [`# ${meta.id} — ${meta.title}`, ''];
  if (result.failures.length) {
    lines.push(`> **WARNING: automatic validation failed** (${result.failures.join('; ')}). `
      + 'Check the cited messages before relying on this summary.', '>');
  }
  lines.push(
    `> Range: ${result.range} (${messages.length} messages, ${store.kb(Buffer.byteLength(messages.map((m) => JSON.stringify(m)).join('\n')))}) · `
      + `participants: ${store.participantsOf(messages).join(', ')} · opened ${meta.opened_at} by ${meta.opened_by}`
      + (meta.continues ? ` · continues ${meta.continues}` : ''),
    `> validation: ${validation} · model: ${result.model} · calls: ${calls}${overflowNote}`,
    `> A map, not authority. Exact wording: read --thread ${meta.id} --range M1-M${attempt.last}.`, '', '');
  return lines.join('\n');
}

function writeSummary(meta, attempt, result, dir) {
  const probe = summaryHead(meta, attempt, result, ' · overflow: 000 items in SUMMARY-OVERFLOW.md');
  const fitted = summarizer.fitSummary(probe, result.draft);
  const note = fitted.moved ? ` · overflow: ${fitted.moved} items in SUMMARY-OVERFLOW.md` : '';
  const head = summaryHead(meta, attempt, result, note);
  const summary = head + fitted.summary.slice(probe.length);
  fs.writeFileSync(path.join(dir, 'SUMMARY.md'), summary);
  if (fitted.overflow) {
    fs.writeFileSync(path.join(dir, 'SUMMARY-OVERFLOW.md'), `# ${meta.id} — overflow of SUMMARY.md\n\n`
      + `Items that did not fit within the ${summarizer.SUMMARY_LIMIT}-byte summary, under their sections.\n\n${fitted.overflow}`);
  }
  return summary;
}

// Phase 3, under the thread lock: finalize only the same attempt over the same bytes.
function finishClose(id, attempt, result) {
  return store.withLock(store.threadLock(id), () => {
    const current = store.readJson(closingPath(id));
    if (!current || current.attempt_id !== attempt.attempt_id) {
      fail(`close attempt ${attempt.attempt_id} is no longer current (now ${current ? `attempt ${current.attempt_id}` : store.readMeta(id).status}); not finalizing`);
    }
    if (frozenSha(id, attempt.last) !== attempt.source_sha256) fail(`${id} messages changed inside the frozen range; not finalizing`);
    const meta = store.readMeta(id);
    const dir = store.threadDir(id);
    writeSummary(meta, attempt, result, dir);
    const outcome = summarizer.sectionText(result.draft, 'Outcome').replace(/\s+/g, ' ').trim().slice(0, 240);
    const validation = result.failures.length ? `failed: ${result.failures.join('; ')}` : 'ok';
    const messages = store.readMessages(id);
    const done = newEntry(meta, messages.length + 1, {
      from: attempt.by, to: 'all', kind: 'done', subject: `Thread closed: ${meta.title}`,
      body: `Archived with summary threads/${id}/SUMMARY.md (validation ${validation}; range ${result.range}).\nOutcome: ${outcome}`,
      refs: [`threads/${id}/SUMMARY.md`],
    });
    store.appendMessage(id, done);
    const all = [...messages, done];
    Object.assign(store.syncMeta(meta, all), {
      status: 'archived', archived_at: done.ts, summary_model: result.model, summary_validation: validation,
      summary_range: result.range, outcome, done_seq: done.seq,
    });
    store.writeMeta(meta);
    fs.rmSync(closingPath(id), { force: true });
    store.renderThread(meta, all);
    return { done, meta };
  });
}

function knownIn(id, last) {
  return (text) => store.messageExists(text, { thread: id, last });
}

async function closeThread(opts) {
  const id = required(opts, 'thread', 'T0007');
  const from = agentOpt(opts, 'from');
  const explicitRing = ringOpt(opts);
  const attempt = beginClose(id, from, opts);
  if (!attempt) {
    store.refreshIndex();
    process.stdout.write(`reopened ${id}\n`);
    return;
  }
  store.refreshIndex();
  process.stdout.write(`closing ${id}: summarizing ${attempt.last} messages (attempt ${attempt.attempt_id})\n`);
  const meta = store.readMeta(id);
  let result;
  try {
    result = await summarizer.summarize(meta, store.readMessages(id).slice(0, attempt.last), knownIn(id, attempt.last));
  } catch (error) {
    if (!(error instanceof summarizer.SummarizerError)) throw error;
    fail(`summarizer failed: ${error.message}. ${id} stays closing with its messages intact; `
      + `rerun thread close --thread ${id} --from ${from} --retry, or --reopen to cancel`);
  }
  const { done, meta: archived } = finishClose(id, attempt, result);
  store.refreshIndex();
  process.stdout.write(`archived ${id} with ${done.id}; summary threads/${id}/SUMMARY.md (validation ${archived.summary_validation})\n`);
  if (result.failures.length) warn(`summary validation failed after one retry: ${result.failures.join('; ')}`);
  if (opts.ring && !ring(done, explicitRing)) process.exitCode = 3;
}

async function summarizeThread(opts) {
  const id = required(opts, 'thread', 'T0007');
  const out = required(opts, 'out', '<file>');
  const meta = store.readMeta(id);
  const messages = store.readMessages(id);
  const result = await summarizer.summarize(meta, messages, knownIn(id, messages.length)).catch((error) => {
    if (error instanceof summarizer.SummarizerError) fail(`summarizer failed: ${error.message}`);
    throw error;
  });
  const attempt = { last: messages.length };
  fs.writeFileSync(out, summaryHead(meta, attempt, result, '') + result.draft);
  process.stdout.write(`preview written to ${out} (validation ${result.failures.length ? `failed: ${result.failures.join('; ')}` : 'ok'})\n`);
}

// --- reading -------------------------------------------------------------------------------------

function unread(opts) {
  const agent = agentOpt(opts, 'for');
  boardNote();
  const cursors = store.readCursors(agent);
  const seen = {};
  let any = false;
  for (const id of store.listThreadIds()) {
    if (typeof opts.thread === 'string' && opts.thread !== id) continue;
    const meta = store.readMeta(id);
    const messages = store.readMessages(id);
    if (!messages.length) continue;
    seen[id] = messages[messages.length - 1].seq;
    const pending = messages.filter((m) => m.seq > (cursors[id] || 0) && store.forAgent(m, agent));
    if (!pending.length) continue;
    any = true;
    if (meta.status === 'archived') {
      const folded = pending.filter((m) => m.seq !== meta.done_seq).length;
      process.stdout.write(`== ${id} · archived · ${meta.title}\n  outcome: ${store.outcomeLine(meta)}\n`
        + `  summary: threads/${id}/SUMMARY.md (validation ${meta.summary_validation})`
        + (folded ? ` · ${folded} unread message(s) folded into it: read --thread ${id} --range M${pending[0].seq}-M${meta.done_seq - 1}` : '')
        + '\n\n');
      continue;
    }
    process.stdout.write(`== ${id} · ${meta.status} · ${meta.title} (${pending.length} new)\n`);
    for (const m of pending) process.stdout.write(store.format(m) + '\n');
  }
  if (!any) process.stdout.write('no unread messages\n');
  if (opts.mark && Object.keys(seen).length) writeMarks(agent, seen);
}

function writeMarks(agent, seen) {
  const cursors = store.readCursors(agent);
  for (const [id, seq] of Object.entries(seen)) cursors[id] = Math.max(cursors[id] || 0, seq);
  store.writeCursors(agent, cursors);
}

function parseRange(text) {
  const match = /^(?:T\d{4}\.)?M(\d+)(?:-(?:T\d{4}\.)?M(\d+))?$/.exec(text);
  if (!match) fail(`--range expects M12-M15 (got ${text})`);
  return [Number(match[1]), Number(match[2] || match[1])];
}

function chain(rootText) {
  const root = store.findMessage(rootText);
  const messages = store.readMessages(root.thread);
  const ids = new Set([root.id]);
  for (const m of messages) if (m.re && ids.has(m.re)) ids.add(m.id);
  return messages.filter((m) => ids.has(m.id));
}

function read(opts) {
  boardNote();
  let messages;
  if (typeof opts.id === 'string') messages = [store.findMessage(opts.id)];
  else if (typeof opts.chain === 'string') messages = chain(opts.chain);
  else if (typeof opts.thread === 'string') {
    if (!store.THREAD_ID.test(opts.thread)) fail(`--thread takes a thread id such as T0007; for a reply chain use --chain ${opts.thread}`);
    const meta = store.readMeta(opts.thread);
    messages = store.readMessages(opts.thread);
    if (typeof opts.range === 'string') {
      const [first, last] = parseRange(opts.range);
      messages = messages.filter((m) => m.seq >= first && m.seq <= last);
    }
    process.stdout.write(`# ${meta.id} · ${meta.status} · ${meta.title}\n\n`);
  } else {
    messages = store.listThreadIds().map(store.readMeta).filter((meta) => meta.status !== 'archived')
      .flatMap((meta) => store.readMessages(meta.id)).sort((a, b) => a.ts.localeCompare(b.ts));
  }
  const last = typeof opts.range === 'string' || typeof opts.id === 'string' ? messages.length : Number(opts.last || 20);
  for (const m of messages.slice(-last)) process.stdout.write(store.format(m) + '\n');
}

function threads(opts) {
  boardNote();
  const status = typeof opts.status === 'string' ? opts.status : 'active';
  const metas = store.listThreadIds().map(store.readMeta).filter((meta) => status === 'all'
    || (status === 'active' ? meta.status !== 'archived' : meta.status === status));
  if (!metas.length) process.stdout.write(`no ${status} threads\n`);
  for (const meta of metas) {
    process.stdout.write(`${meta.id}  ${meta.status.padEnd(9)} ${meta.opened_by.padEnd(7)} ${String(meta.message_count).padStart(3)} msgs `
      + `${store.kb(meta.bytes).padStart(7)}  ${meta.title}\n`);
    if (meta.status === 'archived') process.stdout.write(`      outcome: ${store.outcomeLine(meta)}\n`);
  }
}

// Starts at the current end of every thread and prints one line per later message addressed to the agent.
function watch(opts) {
  const agent = agentOpt(opts, 'for');
  boardNote();
  const offsets = {};
  const scan = (emit) => {
    for (const id of store.listThreadIds()) {
      const file = store.messagesPath(id);
      let size;
      try { size = fs.statSync(file).size; } catch { continue; }
      const from = offsets[id] === undefined ? (emit ? 0 : size) : offsets[id];
      if (size <= from) { offsets[id] = from; continue; }
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const complete = text.slice(0, text.lastIndexOf('\n') + 1);
      offsets[id] = from + Buffer.byteLength(complete);
      if (!emit) continue;
      for (const line of complete.split('\n').filter(Boolean)) {
        const m = JSON.parse(line);
        if (store.forAgent(m, agent)) process.stdout.write(`${m.id} from ${m.from} (${m.kind}): ${m.subject}\n`);
      }
    }
  };
  scan(false);
  setInterval(() => scan(true), 1000);
}

function installSkillCommand(opts) {
  let result;
  try { result = installSkill(opts); } catch (error) { fail(error.message); }
  if (result.refused) process.exitCode = 1;
}

function usage() {
  return `usage: agent-board <command> [options] [--dir <board dir>]
  thread open  --from <agent> --title "<topic>" [--to <agent|all>] [--kind <kind>] [--subject "<line>"]
               [--continues T0003] [--refs a,b] [--body "<text>" | --body-file <path|->] [--ring [agent]]
  post         --from <agent> (--thread T0007 | --re <message id>) --subject "<line>" [--to <agent|all>]
               [--kind <kind>] [--refs a,b] [--body "<text>" | --body-file <path|->] [--ring [agent]]
  thread close --thread T0007 --from <opener> [--retry | --reopen] [--ring [agent]]
  thread summarize --thread T0007 --out <file>     preview a summary without archiving
  unread       --for <agent> [--thread T0007] [--mark]
  read         --thread T0007 [--last N | --range M12-M15] | --id <message id> | --chain <message id> | [--last N]
  threads      [--status active|open|closing|archived|all]
  setup        [--adapter opencode|codex|claude --model <id> --effort <level>] [--show] [--test]
               choose the summarizer (interactive on a terminal; --show prints it, --test makes one model call)
  install-skill [--target claude|codex|opencode|all] [--dry-run] [--uninstall]
               copy the agent skill into ~/.claude/skills and/or ~/.agents/skills (codex and opencode share the latter)
  ring         --id <message id> [--to <agent>]       resend a doorbell without reposting
  watch        --for <agent>                          one stdout line per new message (for monitors)
kinds: ${store.KINDS.join(', ')}
board: ${store.paths.dir} (--dir, else CHANNEL_DIR, else ./${store.DEFAULT_DIR})`;
}

async function main(argv) {
  process.stdout.on('error', (error) => { if (error.code === 'EPIPE') process.exit(0); throw error; });
  const opts = parseArgs(argv);
  if (opts.dir === true) {
    warn('--dir needs a path');
    process.exit(1);
  }
  if (typeof opts.dir === 'string') store.setDir(opts.dir);
  const [name, sub] = opts._;
  const commands = {
    post, unread, read, threads, watch, setup, ring: ringCommand, 'install-skill': installSkillCommand,
    'thread open': openThread, 'thread close': closeThread, 'thread summarize': summarizeThread,
  };
  const command = commands[name === 'thread' ? `thread ${sub}` : name];
  if (!command || opts.help) {
    const asked = !name || name === 'help' || opts.help;
    (asked ? process.stdout : process.stderr).write(usage() + '\n');
    process.exit(asked ? 0 : 1);
  }
  try {
    await command(opts);
  } catch (error) {
    if (!(error instanceof ChannelError)) throw error;
    warn(error.message);
    process.exit(1);
  }
}

module.exports = { main };

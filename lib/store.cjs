'use strict';

// Board storage: paths, locks, threads, cursors and the generated Markdown views.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = '.channel';
const KINDS = ['note', 'question', 'answer', 'proposal', 'claim', 'release', 'done', 'blocker', 'decision-request'];
const THREAD_ID = /^T\d{4}$/;
const STALE_LOCK_MS = 30000;
const WARN_MESSAGES = 40;
const WARN_BYTES = 200 * 1024;
const VIEW_FULL_BYTES = 300 * 1024;
const VIEW_LIMIT = 40;

// Board location: --dir, then CHANNEL_DIR, then ./.channel. The CLI calls setDir before any command.
const paths = {};

function setDir(dir) {
  const root = path.resolve(dir);
  Object.assign(paths, {
    dir: root,
    threads: path.join(root, 'threads'),
    cursors: path.join(root, 'cursors'),
    lock: path.join(root, '.lock'),
    agents: path.join(root, 'agents.json'),
    index: path.join(root, 'INDEX.md'),
  });
}

setDir(process.env.CHANNEL_DIR || DEFAULT_DIR);

class ChannelError extends Error {}

function fail(message) {
  throw new ChannelError(message);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function now() {
  return new Date().toISOString();
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(`cannot read ${path.relative(paths.dir, file)}: ${error.message}`);
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function writeJson(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

function withLock(lock, fn) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Holders keep a lock for milliseconds (the summarizer never runs under one); an old lock means a crash.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmdirSync(lock); } catch { }
      if (Date.now() > deadline) fail(`lock busy: remove ${lock} if no writer is running`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { fs.rmdirSync(lock); }
}

function threadDir(id) {
  return path.join(paths.threads, id);
}

function threadLock(id) {
  return path.join(threadDir(id), '.lock');
}

function listThreadIds() {
  if (!fs.existsSync(paths.threads)) return [];
  return fs.readdirSync(paths.threads).filter((name) => THREAD_ID.test(name)).sort();
}

function nextThreadId() {
  const ids = listThreadIds();
  const max = ids.length ? Number(ids[ids.length - 1].slice(1)) : 0;
  return `T${String(max + 1).padStart(4, '0')}`;
}

function readMeta(id) {
  if (!THREAD_ID.test(id)) fail(`${id} is not a thread id (expected T0007)`);
  const meta = readJson(path.join(threadDir(id), 'meta.json'));
  if (!meta) fail(`no thread ${id}`);
  return meta;
}

function writeMeta(meta) {
  writeJson(path.join(threadDir(meta.id), 'meta.json'), meta);
}

function messagesPath(id) {
  return path.join(threadDir(id), 'messages.jsonl');
}

function parseLines(text, label) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] !== '') fail(`${label} ends with an incomplete line; inspect it before writing`);
  return lines.slice(0, -1).map((line, i) => {
    try { return JSON.parse(line); } catch { fail(`${label}:${i + 1} is not valid JSON`); }
  });
}

function readMessages(id) {
  const file = messagesPath(id);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return text ? parseLines(text, path.relative(paths.dir, file)) : [];
}

function messageId(meta, seq) {
  return `${meta.id}.M${String(seq).padStart(3, '0')}`;
}

// Accepts T0007.M003 and T0007.M3.
function parseMessageId(text) {
  const full = /^(T\d{4})\.M(\d+)$/.exec(text);
  return full ? { thread: full[1], seq: Number(full[2]) } : null;
}

function findMessage(text) {
  const ref = parseMessageId(text);
  if (!ref) fail(`${text} is not a message id (expected T0007.M003)`);
  if (!listThreadIds().includes(ref.thread)) fail(`${text}: no thread ${ref.thread}`);
  const message = readMessages(ref.thread).find((m) => m.seq === ref.seq);
  if (!message) fail(`${text} does not exist`);
  return message;
}

// With a context ({ thread, last }), bare ids (M012) and the context thread's ids must fall inside its frozen range.
function messageExists(text, context) {
  if (context && /^M\d+$/.test(text)) return Number(text.slice(1)) >= 1 && Number(text.slice(1)) <= context.last;
  const ref = parseMessageId(text);
  if (!ref) return false;
  if (context && ref.thread === context.thread) return ref.seq >= 1 && ref.seq <= context.last;
  if (!listThreadIds().includes(ref.thread)) return false;
  return readMessages(ref.thread).some((m) => m.seq === ref.seq);
}

function forAgent(message, agent) {
  return message.from !== agent && (message.to === 'all' || message.to === agent);
}

function format(message) {
  const head = `[${message.id}] ${message.ts} ${message.from} -> ${message.to} (${message.kind})`
    + (message.re ? ` re ${message.re}` : '');
  return `${head}\n  ${message.subject}\n${message.body ? message.body.replace(/^/gm, '    ') + '\n' : ''}`
    + (message.refs.length ? `  refs: ${message.refs.join(', ')}\n` : '');
}

function kb(bytes) {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function renderThread(meta, messages) {
  const bytes = messages.reduce((sum, m) => sum + Buffer.byteLength(JSON.stringify(m)) + 1, 0);
  const shown = bytes <= VIEW_FULL_BYTES ? messages : messages.slice(-VIEW_LIMIT);
  const lines = [`# ${meta.id} — ${meta.title} (generated view; do not edit)`, '',
    `Status: ${meta.status} · opened by ${meta.opened_by} at ${meta.opened_at}`
      + (meta.continues ? ` · continues ${meta.continues}` : '')
      + (meta.archived_at ? ` · archived ${meta.archived_at}` : ''),
    `Showing ${shown.length} of ${messages.length} messages. Source: messages.jsonl.`
      + (meta.status === 'archived' ? ' Summary: SUMMARY.md.' : ''), ''];
  for (const m of shown) {
    lines.push(`## ${m.id} · ${m.from} → ${m.to} · ${m.kind}${m.re ? ` · re ${m.re}` : ''}`, '',
      `**${m.subject}** — ${m.ts}`, '');
    if (m.body) lines.push(m.body, '');
    if (m.refs.length) lines.push(`Refs: ${m.refs.map((r) => `\`${r}\``).join(', ')}`, '');
  }
  writeAtomic(path.join(threadDir(meta.id), 'THREAD.md'), lines.join('\n'));
}

function outcomeLine(meta) {
  return meta.outcome ? meta.outcome : '(no outcome recorded)';
}

// Caller holds the global lock, so renders are serialized and the last one sees every meta update.
function renderIndex() {
  const metas = listThreadIds().map(readMeta);
  const recent = [];
  for (const meta of metas.filter((m) => m.status !== 'archived')) {
    for (const m of readMessages(meta.id).slice(-10)) recent.push(m);
  }
  recent.sort((a, b) => a.ts.localeCompare(b.ts));
  const line = (meta) => `- **${meta.id}** · ${meta.title} · opened by ${meta.opened_by} · `
    + `${meta.message_count} messages, ${kb(meta.bytes)} · last ${meta.last_at}`
    + (meta.continues ? ` · continues ${meta.continues}` : '');
  const lines = ['# Agent board — threads (generated; do not edit)', '',
    'Read open threads in full. For archived threads, read SUMMARY.md instead of the history.', ''];
  for (const [title, status] of [['Open', 'open'], ['Closing', 'closing']]) {
    const group = metas.filter((m) => m.status === status);
    if (status !== 'open' && group.length === 0) continue;
    lines.push(`## ${title}`, '');
    lines.push(...(group.length ? group.map(line) : ['None.']), '');
  }
  const archived = metas.filter((m) => m.status === 'archived').reverse();
  lines.push('## Archived', '');
  lines.push(...(archived.length ? archived.map((meta) => `- **${meta.id}** · ${meta.title} · `
    + `${meta.message_count} messages · archived ${meta.archived_at}`
    + (meta.summary_validation === 'ok' ? '' : ' · summary validation FAILED')
    + `\n  ${outcomeLine(meta)} ([summary](threads/${meta.id}/SUMMARY.md))`) : ['None.']), '');
  lines.push('## Recent activity in open threads', '');
  lines.push(...(recent.length ? recent.slice(-15).map((m) => `- ${m.ts} · ${m.id} · ${m.from} → ${m.to} · ${m.kind} · ${m.subject}`) : ['None.']), '');
  writeAtomic(paths.index, lines.join('\n'));
}

function refreshIndex() {
  withLock(paths.lock, renderIndex);
}

function participantsOf(messages) {
  const names = new Set();
  for (const m of messages) for (const name of [m.from, m.to]) if (name && name !== 'all') names.add(name);
  return [...names].sort();
}

function syncMeta(meta, messages) {
  meta.message_count = messages.length;
  meta.bytes = fs.existsSync(messagesPath(meta.id)) ? fs.statSync(messagesPath(meta.id)).size : 0;
  meta.last_at = messages.length ? messages[messages.length - 1].ts : meta.opened_at;
  meta.participants = participantsOf(messages);
  return meta;
}

function appendMessage(id, entry) {
  fs.appendFileSync(messagesPath(id), JSON.stringify(entry) + '\n');
}

function checkAgentName(agent) {
  if (!/^[\w.-]+$/.test(agent)) fail(`invalid agent name ${agent} (letters, digits, _ . - only)`);
  return agent;
}

function cursorPath(agent) {
  return path.join(paths.cursors, `${checkAgentName(agent)}.json`);
}

function readCursors(agent) {
  const raw = readJson(cursorPath(agent)) || {};
  const cursors = {};
  for (const [key, value] of Object.entries(raw)) if (THREAD_ID.test(key) && Number.isInteger(value)) cursors[key] = value;
  return cursors;
}

function writeCursors(agent, cursors) {
  fs.mkdirSync(paths.cursors, { recursive: true });
  writeJson(cursorPath(agent), cursors);
}

module.exports = {
  DEFAULT_DIR, KINDS, THREAD_ID, WARN_MESSAGES, WARN_BYTES, paths, setDir, ChannelError, fail, sha256, now,
  readJson, writeAtomic, writeJson, withLock, threadDir, threadLock, listThreadIds, nextThreadId, readMeta,
  writeMeta, messagesPath, parseLines, readMessages, messageId, parseMessageId, findMessage, messageExists,
  forAgent, format, kb, renderThread, renderIndex, refreshIndex, outcomeLine, syncMeta, appendMessage,
  participantsOf, checkAgentName, readCursors, writeCursors,
};

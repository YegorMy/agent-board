'use strict';

// Every test works on a fresh scratch board in the OS temp dir. Run: node --test

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const CLI = path.resolve(__dirname, '..', 'bin', 'agent-board.cjs');
const STUB = path.resolve(__dirname, 'stub-summarizer.cjs');

function board() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'));
  return { dir, log: path.join(dir, 'stub.log') };
}

function envFor(b, extra = {}) {
  const env = {
    ...process.env, CHANNEL_DIR: b.dir, CHANNEL_SUMMARIZER_CMD: `"${process.execPath}" "${STUB}"`,
    STUB_LOG: b.log, STUB_MODE: 'ok', ...extra,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

function run(b, args, { input, env, cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env: envFor(b, env), input, cwd, encoding: 'utf8' });
}

function runAsync(b, args, { input, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: envFor(b, env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input || '');
  });
}

function ok(result) {
  assert.equal(result.status, 0, `exit ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result.stdout;
}

function postedId(stdout) {
  return /posted (\S+)/.exec(stdout)[1];
}

function open(b, from, title, extra = []) {
  return postedId(ok(run(b, ['thread', 'open', '--from', from, '--title', title, '--body', `opening ${title}`, ...extra])));
}

function post(b, thread, from, subject, extra = []) {
  return postedId(ok(run(b, ['post', '--thread', thread, '--from', from, '--subject', subject, '--body', `body of ${subject}`, ...extra])));
}

function meta(b, id) {
  return JSON.parse(fs.readFileSync(path.join(b.dir, 'threads', id, 'meta.json'), 'utf8'));
}

function messages(b, id) {
  return fs.readFileSync(path.join(b.dir, 'threads', id, 'messages.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function calls(b) {
  return fs.existsSync(b.log) ? fs.readFileSync(b.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// A stateful stand-in tmux on PATH. FAKE_TMUX_STATE is a JSON list of panes { id, opts, where, command, dead };
// list-panes fills the -F format from it, set-option [-u] changes it, and every other call is appended to TMUX_LOG.
// Knobs: FAKE_LIST_DELAY (ms), FAKE_SET_FAIL / FAKE_UNSET_FAIL (a pane id whose set-option / set-option -u fails).
const FAKE_TMUX = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const file = process.env.FAKE_TMUX_STATE;
const panes = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args[0] === 'list-panes') {
  if (process.env.FAKE_LIST_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_LIST_DELAY));
  const values = (pane) => {
    const [session, rest] = pane.where.split(':');
    const [window, index] = rest.split('.');
    return { pane_id: pane.id, session_name: session, window_index: window, pane_index: index,
      pane_current_command: pane.command, pane_dead: pane.dead ? '1' : '0' };
  };
  const format = args[args.indexOf('-F') + 1];
  for (const pane of panes) {
    process.stdout.write(format.replace(/#\\{([^}]+)\\}/g, (_, key) => (key[0] === '@' ? pane.opts[key] || '' : values(pane)[key])) + '\\n');
  }
  process.exit(0);
}
fs.appendFileSync(process.env.TMUX_LOG, args.join(' ') + '\\n');
if (args[0] === 'set-option') {
  const unset = args.includes('-u');
  const target = args[args.indexOf('-t') + 1];
  const [option, value] = args.filter((arg, i) => !arg.startsWith('-') && args[i - 1] !== '-t').slice(1);
  if (process.env[unset ? 'FAKE_UNSET_FAIL' : 'FAKE_SET_FAIL'] === target) { process.stderr.write('fake tmux: refused\\n'); process.exit(1); }
  const pane = panes.find((candidate) => candidate.id === target);
  if (!pane) { process.stderr.write("can't find pane: " + target + '\\n'); process.exit(1); }
  if (unset) delete pane.opts[option]; else pane.opts[option] = value;
  fs.writeFileSync(file + '.tmp', JSON.stringify(panes));
  fs.renameSync(file + '.tmp', file);
}
`;

function fakeTmux(b) {
  const bin = path.join(b.dir, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'tmux'), FAKE_TMUX, { mode: 0o755 });
  return bin;
}

function boardOption(dir) {
  return `@agent_board_${crypto.createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 12)}`;
}

test('concurrent opens and posts get unique, contiguous ids', async () => {
  const b = board();
  const opens = await Promise.all(Array.from({ length: 8 }, (_, i) => runAsync(b, ['thread', 'open', '--from', 'bob', '--title', `t${i}`, '--body', 'x'])));
  const threadIds = opens.map((r) => { assert.equal(r.status, 0, r.stderr); return postedId(r.stdout).split('.')[0]; });
  assert.deepEqual([...threadIds].sort(), ['T0001', 'T0002', 'T0003', 'T0004', 'T0005', 'T0006', 'T0007', 'T0008']);
  const posts = await Promise.all(Array.from({ length: 20 }, (_, i) => runAsync(b, ['post', '--thread', 'T0001', '--from', i % 2 ? 'bob' : 'ann', '--subject', `p${i}`, '--body', 'y'])));
  const ids = posts.map((r) => { assert.equal(r.status, 0, r.stderr); return postedId(r.stdout); });
  assert.equal(new Set(ids).size, 20);
  const all = messages(b, 'T0001');
  assert.deepEqual(all.map((m) => m.seq), Array.from({ length: 21 }, (_, i) => i + 1));
  assert.equal(all[1].id, 'T0001.M002');
  assert.equal(meta(b, 'T0001').message_count, 21);
  assert.match(fs.readFileSync(path.join(b.dir, 'INDEX.md'), 'utf8'), /T0001.*21 messages/);
});

test('the board lives in --dir, else CHANNEL_DIR, else ./.channel', () => {
  const b = board();
  const cwd = path.join(b.dir, 'project');
  const flagged = path.join(b.dir, 'flagged');
  fs.mkdirSync(cwd);
  ok(run(b, ['thread', 'open', '--from', 'ann', '--title', 'default', '--body', 'x'], { cwd, env: { CHANNEL_DIR: undefined } }));
  assert.ok(fs.existsSync(path.join(cwd, '.channel', 'threads', 'T0001', 'messages.jsonl')));
  ok(run(b, ['thread', 'open', '--from', 'ann', '--title', 'from env', '--body', 'x'], { cwd }));
  assert.equal(meta(b, 'T0001').title, 'from env');
  ok(run(b, ['--dir', flagged, 'thread', 'open', '--from', 'ann', '--title', 'from flag', '--body', 'x'], { cwd }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(flagged, 'threads', 'T0001', 'meta.json'), 'utf8')).title, 'from flag');
  assert.match(ok(run(b, ['threads', '--dir', 'flagged'], { cwd: b.dir })), /T0001 .* from flag/);
  assert.match(run(b, ['threads', '--dir']).stderr, /--dir needs a path/);
});

test('reading a missing board warns and creates nothing', () => {
  const b = board();
  const missing = path.join(b.dir, 'nowhere');
  const result = run(b, ['unread', '--for', 'ann', '--mark'], { env: { CHANNEL_DIR: missing } });
  assert.equal(ok(result), 'no unread messages\n');
  assert.match(result.stderr, /no board at .*nowhere yet/);
  assert.match(ok(run(b, ['threads'], { env: { CHANNEL_DIR: missing } })), /no active threads/);
  assert.ok(!fs.existsSync(missing));
});

test('agent names are free-form but must be safe file names', () => {
  const b = board();
  assert.equal(open(b, 'reviewer-2', 'topic', ['--to', 'Builder.v3']), 'T0001.M001');
  assert.match(ok(run(b, ['unread', '--for', 'Builder.v3'])), /reviewer-2 -> Builder.v3/);
  const bad = run(b, ['post', '--thread', 'T0001', '--from', '../x', '--subject', 's']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /invalid agent name \.\.\/x/);
  assert.match(run(b, ['post', '--thread', 'T0001', '--from', 'ann', '--to', 'a b', '--subject', 's']).stderr, /invalid agent name a b/);
  assert.equal(messages(b, 'T0001').length, 1);
});

test('posts to an archived thread are refused with the continues hint', () => {
  const b = board();
  const first = open(b, 'ann', 'topic');
  ok(run(b, ['thread', 'close', '--thread', 'T0001', '--from', 'ann']));
  const refused = run(b, ['post', '--thread', 'T0001', '--from', 'bob', '--subject', 'late']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /T0001 is archived.*--continues T0001/);
  const reply = run(b, ['post', '--re', first, '--from', 'bob', '--subject', 'late reply']);
  assert.match(reply.stderr, /is archived/);
});

test('only the opener can close a thread', () => {
  const b = board();
  open(b, 'ann', 'topic');
  const refused = run(b, ['thread', 'close', '--thread', 'T0001', '--from', 'bob']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /only the opener \(ann\) can close T0001/);
  assert.equal(meta(b, 'T0001').status, 'open');
});

test('cursors are per thread and unread groups by thread', () => {
  const b = board();
  open(b, 'ann', 'alpha', ['--to', 'bob']);
  open(b, 'ann', 'beta', ['--to', 'bob']);
  const first = ok(run(b, ['unread', '--for', 'bob', '--mark']));
  assert.match(first, /== T0001 · open · alpha/);
  assert.match(first, /== T0002 · open · beta/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.dir, 'cursors', 'bob.json'), 'utf8')), { T0001: 1, T0002: 1 });
  post(b, 'T0002', 'ann', 'second', ['--to', 'bob']);
  post(b, 'T0001', 'bob', 'own message');
  const second = ok(run(b, ['unread', '--for', 'bob']));
  assert.doesNotMatch(second, /T0001/);
  assert.match(second, /T0002.M002/);
  assert.match(ok(run(b, ['unread', '--for', 'bob', '--thread', 'T0001'])), /no unread messages/);
});

test('reply defaults to the parent sender and infers the thread from --re', () => {
  const b = board();
  const first = open(b, 'ann', 'topic', ['--to', 'bob']);
  const reply = postedId(ok(run(b, ['post', '--re', first, '--from', 'bob', '--subject', 'answer'])));
  assert.equal(reply, 'T0001.M002');
  const m = messages(b, 'T0001')[1];
  assert.equal(m.to, 'ann');
  assert.equal(m.re, 'T0001.M001');
  assert.match(ok(run(b, ['read', '--chain', first])), /\[T0001.M001\][\s\S]*\[T0001.M002\]/);
  const noThread = run(b, ['post', '--from', 'bob', '--subject', 'no thread']);
  assert.equal(noThread.status, 1);
  assert.match(noThread.stderr, /posts need a thread/);
});

test('--continues carries the summary header, including a validation warning', () => {
  const b = board();
  open(b, 'ann', 'first topic');
  ok(run(b, ['thread', 'close', '--thread', 'T0001', '--from', 'ann']));
  const next = open(b, 'bob', 'second topic', ['--continues', 'T0001']);
  const body = messages(b, next.split('.')[0])[0].body;
  assert.match(body, /^Continues T0001 — "first topic" \(summary validation: ok/);
  assert.match(body, /## Outcome/);
  assert.match(body, /opening second topic$/);
  assert.equal(meta(b, 'T0002').continues, 'T0001');
  ok(run(b, ['thread', 'close', '--thread', 'T0002', '--from', 'bob'], { env: { STUB_MODE: 'invalid' } }));
  const third = open(b, 'ann', 'third topic', ['--continues', 'T0002']);
  assert.match(messages(b, third.split('.')[0])[0].body, /summary validation: failed:[\s\S]*WARNING: automatic validation failed/);
  const refused = run(b, ['thread', 'open', '--from', 'bob', '--title', 'x', '--continues', 'T0003']);
  assert.match(refused.stderr, /T0003 is open; only archived threads can be continued/);
});

test('validation retries once, then archives with the warning flag', () => {
  const b = board();
  open(b, 'ann', 'topic');
  ok(run(b, ['thread', 'close', '--thread', 'T0001', '--from', 'ann'], { env: { STUB_MODE: 'invalid' } }));
  assert.deepEqual(calls(b).map((c) => c.phase), ['single', 'retry']);
  const m = meta(b, 'T0001');
  assert.equal(m.status, 'archived');
  assert.match(m.summary_validation, /^failed: .*missing section .*cited ids not in the source: T9999.M001/);
  assert.equal(m.summary_model, 'command node');
  const summary = fs.readFileSync(path.join(b.dir, 'threads', 'T0001', 'SUMMARY.md'), 'utf8');
  assert.match(summary, /WARNING: automatic validation failed/);
  assert.match(fs.readFileSync(path.join(b.dir, 'INDEX.md'), 'utf8'), /summary validation FAILED/);

  const c = board();
  open(c, 'ann', 'topic');
  ok(run(c, ['thread', 'close', '--thread', 'T0001', '--from', 'ann'], { env: { STUB_MODE: 'invalid-once' } }));
  assert.deepEqual(calls(c).map((x) => x.phase), ['single', 'retry']);
  assert.equal(meta(c, 'T0001').summary_validation, 'ok');
  assert.doesNotMatch(fs.readFileSync(path.join(c.dir, 'threads', 'T0001', 'SUMMARY.md'), 'utf8'), /WARNING/);
});

test('an unavailable summarizer keeps messages intact; --reopen and --retry recover', () => {
  const b = board();
  open(b, 'ann', 'topic');
  post(b, 'T0001', 'bob', 'reply');
  const file = path.join(b.dir, 'threads', 'T0001', 'messages.jsonl');
  const before = sha(file);
  const failed = run(b, ['thread', 'close', '--thread', 'T0001', '--from', 'ann'], { env: { STUB_MODE: 'fail' } });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /summarizer failed: single call exited 1.*stays closing.*--retry.*--reopen/);
  assert.equal(sha(file), before);
  assert.equal(meta(b, 'T0001').status, 'closing');
  assert.match(run(b, ['post', '--thread', 'T0001', '--from', 'bob', '--subject', 'x']).stderr, /T0001 is closing/);
  assert.match(run(b, ['thread', 'close', '--thread', 'T0001', '--from', 'ann']).stderr, /rerun with --retry .* or --reopen/);
  assert.match(ok(run(b, ['thread', 'close', '--thread', 'T0001', '--from', 'ann', '--reopen'])), /reopened T0001/);
  assert.equal(meta(b, 'T0001').status, 'open');
  assert.ok(!fs.existsSync(path.join(b.dir, 'threads', 'T0001', 'closing.json')));
  post(b, 'T0001', 'bob', 'after reopen');
  run(b, ['thread', 'close', '--thread', 'T0001', '--from', 'ann'], { env: { STUB_MODE: 'fail' } });
  const retried = ok(run(b, ['thread', 'close', '--thread', 'T0001', '--from', 'ann', '--retry']));
  assert.match(retried, /archived T0001 with T0001.M004/);
  const m = meta(b, 'T0001');
  assert.equal(m.summary_range, 'T0001.M001–T0001.M003');
  assert.equal(m.done_seq, 4);
});

test('a missing summarizer program is reported with the way out', () => {
  const b = board();
  open(b, 'ann', 'topic');
  const failed = run(b, ['thread', 'close', '--thread', 'T0001', '--from', 'ann'], { env: { CHANNEL_SUMMARIZER_CMD: undefined, PATH: path.join(b.dir, 'empty') } });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /codex not found; install it or set CHANNEL_SUMMARIZER_CMD.*stays closing/);
  assert.equal(meta(b, 'T0001').status, 'closing');
});

test('a superseded close attempt does not finalize', async () => {
  const b = board();
  open(b, 'ann', 'topic');
  const slow = runAsync(b, ['thread', 'close', '--thread', 'T0001', '--from', 'ann'], { env: { STUB_MODE: 'slow', STUB_DELAY_MS: '2500' } });
  await new Promise((resolve) => setTimeout(resolve, 800));
  ok(run(b, ['thread', 'close', '--thread', 'T0001', '--from', 'ann', '--retry']));
  const late = await slow;
  assert.equal(late.status, 1);
  assert.match(late.stderr, /is no longer current \(now archived\); not finalizing/);
  assert.equal(messages(b, 'T0001').filter((m) => m.kind === 'done').length, 1);
});

test('thread summarize writes a preview and leaves the thread open', () => {
  const b = board();
  open(b, 'ann', 'topic');
  const out = path.join(b.dir, 'preview.md');
  assert.match(ok(run(b, ['thread', 'summarize', '--thread', 'T0001', '--out', out])), /preview written to .*validation ok/);
  assert.match(fs.readFileSync(out, 'utf8'), /^# T0001 — topic[\s\S]*## Outcome/);
  assert.equal(meta(b, 'T0001').status, 'open');
});

test('large threads map-reduce within the byte budget, splitting oversized messages', () => {
  const b = board();
  const budget = 20 * 1024;
  open(b, 'ann', 'big');
  for (let i = 0; i < 70; i++) post(b, 'T0001', i % 2 ? 'bob' : 'ann', `message ${i} ${'ж'.repeat(300)}`);
  ok(run(b, ['post', '--thread', 'T0001', '--from', 'bob', '--subject', 'huge', '--body', `${'Ю'.repeat(3000)}\n`.repeat(3)]));
  ok(run(b, ['thread', 'close', '--thread', 'T0001', '--from', 'ann'], { env: { CHANNEL_CHUNK_BYTES: String(budget) } }));
  const phases = calls(b).map((c) => c.phase);
  assert.ok(phases.filter((p) => p === 'map').length > 3, phases.join(','));
  assert.ok(phases.includes('merge'), phases.join(','));
  assert.equal(phases[phases.length - 1], 'reduce');
  assert.ok(calls(b).every((c) => c.bytes <= budget), 'every call stays within the budget');
  assert.ok(calls(b).filter((c) => c.phase === 'map').reduce((sum, c) => sum + c.parts, 0) >= 2, 'oversized message split into parts');
  assert.equal(meta(b, 'T0001').summary_validation, 'ok');
});

test('splitText keeps multi-byte characters whole and parts within the limit', () => {
  const { splitText } = require('../lib/summarize.cjs');
  const text = `${'щ'.repeat(5000)}\n${'😀'.repeat(900)}\nshort\n`;
  const parts = splitText(text, 1000);
  assert.equal(parts.join(''), text);
  for (const part of parts) assert.ok(Buffer.byteLength(part) <= 1000);
});

test('an oversized summary keeps 8 KB and moves the rest to SUMMARY-OVERFLOW.md', () => {
  const b = board();
  open(b, 'ann', 'topic');
  ok(run(b, ['thread', 'close', '--thread', 'T0001', '--from', 'ann'], { env: { STUB_MODE: 'big' } }));
  const dir = path.join(b.dir, 'threads', 'T0001');
  const summary = fs.readFileSync(path.join(dir, 'SUMMARY.md'), 'utf8');
  const overflow = fs.readFileSync(path.join(dir, 'SUMMARY-OVERFLOW.md'), 'utf8');
  assert.ok(Buffer.byteLength(summary) <= 8192, `summary is ${Buffer.byteLength(summary)} bytes`);
  const moved = Number(/overflow: (\d+) items/.exec(summary)[1]);
  const kept = (summary.match(/^- Change number/gm) || []).length;
  assert.equal(kept + (overflow.match(/^- Change number/gm) || []).length, 120);
  assert.equal(moved, 120 - kept);
  assert.match(summary, /## Open items/);
});

test('ring uses the posted id; a failed doorbell is retried without reposting', () => {
  const b = board();
  const ringLog = path.join(b.dir, 'rings.log');
  const writer = [process.execPath, '-e', "require('fs').appendFileSync(process.env.RING_LOG, process.argv[1] + '\\n')", '{message}'];
  fs.writeFileSync(path.join(b.dir, 'agents.json'), JSON.stringify({ bob: { doorbell: writer }, ann: { doorbell: ['false'] }, carol: { doorbell: null } }));
  open(b, 'ann', 'topic');
  const rang = ok(run(b, ['post', '--thread', 'T0001', '--from', 'ann', '--to', 'bob', '--subject', 'please act', '--ring'], { env: { RING_LOG: ringLog } }));
  assert.match(rang, /posted T0001.M002\nrang bob for T0001.M002/);
  assert.equal(fs.readFileSync(ringLog, 'utf8'), 'agent-board: T0001.M002 for you (please act)\n');
  const failed = run(b, ['post', '--thread', 'T0001', '--from', 'bob', '--to', 'ann', '--subject', 'back', '--ring']);
  assert.equal(failed.status, 3);
  assert.match(failed.stdout, /posted T0001.M003/);
  assert.match(failed.stderr, /ring failed for ann: .*retry with: ring --id T0001.M003/);
  fs.writeFileSync(path.join(b.dir, 'agents.json'), JSON.stringify({ bob: { doorbell: writer }, ann: { doorbell: writer } }));
  assert.match(ok(run(b, ['ring', '--id', 'T0001.M003'], { env: { RING_LOG: ringLog } })), /rang ann for T0001.M003/);
  assert.equal(messages(b, 'T0001').length, 3);
  assert.match(fs.readFileSync(ringLog, 'utf8'), /agent-board: T0001.M003 for you \(back\)/);
});

// A board with a fake tmux. pane() describes a pane tagged on this board, other() one tagged on another board;
// env(panes) resets the fake server to those panes and returns the environment for run().
function tmuxBoard(agents) {
  const b = board();
  const tmuxLog = path.join(b.dir, 'tmux.log');
  const stateFile = path.join(b.dir, 'tmux-state.json');
  const option = boardOption(b.dir);
  if (agents) fs.writeFileSync(path.join(b.dir, 'agents.json'), JSON.stringify(agents));
  open(b, 'ann', 'topic');
  const make = (opts, id, where, command, dead) => ({ id, opts, where: where || 'main:1.0', command: command || 'claude', dead: Boolean(dead) });
  const pane = (id, name, where, command, dead) => make(name ? { [option]: name } : {}, id, where, command, dead);
  const other = (id, name) => make({ '@agent_board_000000000000': name }, id, 'x:0.0', 'zsh');
  const env = (panes, extra = {}) => {
    fs.writeFileSync(stateFile, JSON.stringify(panes));
    return { PATH: `${fakeTmux(b)}${path.delimiter}${process.env.PATH}`, TMUX_LOG: tmuxLog, FAKE_TMUX_STATE: stateFile, TMUX_PANE: undefined, ...extra };
  };
  const logged = () => (fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8') : '');
  const tags = () => Object.fromEntries(JSON.parse(fs.readFileSync(stateFile, 'utf8')).map((p) => [p.id, p.opts[option]]));
  return { b, option, pane, other, env, logged, tags, stateFile };
}

const ringBob = ['post', '--thread', 'T0001', '--from', 'ann', '--to', 'bob', '--subject', 'look', '--ring'];
const ringAll = ['post', '--thread', 'T0001', '--from', 'ann', '--to', 'all', '--subject', 'hello', '--ring'];

test('the pane option is derived from the real board path', () => {
  const one = board();
  const two = board();
  assert.match(boardOption(one.dir), /^@agent_board_[0-9a-f]{12}$/);
  assert.notEqual(boardOption(one.dir), boardOption(two.dir));
  const link = path.join(two.dir, 'link');
  fs.symlinkSync(one.dir, link);
  assert.equal(boardOption(link), boardOption(one.dir));
});

test('a symlinked --dir shares the tag with the real board directory', () => {
  const t = tmuxBoard();
  const link = path.join(board().dir, 'link');
  fs.symlinkSync(t.b.dir, link);
  const env = t.env([t.pane('%3', null)]);
  assert.match(ok(run(t.b, ['--dir', link, 'tag', '--as', 'bob', '--pane', '%3'], { env })), new RegExp(`tagged %3 as bob on this board \\(${t.option}\\)`));
  assert.equal(t.tags()['%3'], 'bob');
  assert.equal(ok(run(t.b, ['tag', '--list'], { env })), 'bob\t%3 (main:1.0 claude)\n');
});

test('ring types into the one pane tagged on this board', () => {
  const t = tmuxBoard();
  const env = t.env([t.pane('%3', 'bob'), t.pane('%4', 'ann'), t.pane('%5', null)]);
  assert.match(ok(run(t.b, ringBob, { env })), /rang bob for T0001.M002/);
  assert.equal(t.logged(), 'send-keys -t %3 -l agent-board: T0001.M002 for you (look)\nsend-keys -t %3 Enter\n');
});

test('two boards with the same agent names ring their own panes', () => {
  const one = tmuxBoard();
  const two = tmuxBoard();
  const panes = [
    { ...one.pane('%3', 'claude'), opts: { [one.option]: 'claude', [two.option]: 'sol' } },
    { ...one.pane('%4', null), opts: { [two.option]: 'claude', [one.option]: 'sol' } },
  ];
  const env = one.env(panes, { TMUX_LOG: path.join(one.b.dir, 'shared.log') });
  const toClaude = ['post', '--thread', 'T0001', '--from', 'ann', '--to', 'claude', '--subject', 'hi', '--ring'];
  ok(run(one.b, toClaude, { env }));
  ok(run(two.b, toClaude, { env }));
  assert.equal(fs.readFileSync(env.TMUX_LOG, 'utf8').split('\n').filter((l) => l.includes('Enter')).join('|'), 'send-keys -t %3 Enter|send-keys -t %4 Enter');
});

test('ring reports zero or several tagged panes and a missing tmux, and ignores other boards', () => {
  const t = tmuxBoard();
  const dir = fs.realpathSync(t.b.dir);
  const none = run(t.b, ringBob, { env: t.env([t.pane('%4', 'ann'), t.other('%6', 'bob')]) });
  assert.equal(none.status, 3);
  assert.match(none.stdout, /posted T0001.M002/);
  assert.ok(none.stderr.includes(`ring failed for bob: no tmux pane is tagged bob on this board; in that agent's pane run: agent-board --dir ${dir} tag --as bob; retry with: ring --id T0001.M002`), none.stderr);

  const two = run(t.b, ringBob, { env: t.env([t.pane('%3', 'bob'), t.pane('%7', 'bob', 'dev:0.1', 'node')]) });
  assert.equal(two.status, 3);
  assert.ok(two.stderr.includes(`ring failed for bob: 2 tmux panes are tagged bob on this board: %3 (main:1.0 claude), %7 (dev:0.1 node); in the right pane run: agent-board --dir ${dir} tag --as bob --replace; retry with:`), two.stderr);
  assert.equal(t.logged(), '');

  const absent = run(t.b, ringBob, { env: { PATH: path.join(t.b.dir, 'empty') } });
  assert.equal(absent.status, 3);
  assert.match(absent.stderr, /ring failed for bob: tmux is not installed or not on PATH/);
  assert.equal(messages(t.b, 'T0001').length, 4);
});

test('dead panes are never rung, never part of --to all, and never conflict in tag', () => {
  const t = tmuxBoard();
  const dead = t.pane('%3', 'bob', 'main:1.0', 'claude', true);
  assert.match(run(t.b, ringBob, { env: t.env([dead]) }).stderr, /no tmux pane is tagged bob on this board/);
  assert.match(ok(run(t.b, ringBob, { env: t.env([dead, t.pane('%5', 'bob')]) })), /rang bob/);
  assert.equal(t.logged(), 'send-keys -t %5 -l agent-board: T0001.M003 for you (look)\nsend-keys -t %5 Enter\n');
  const all = ok(run(t.b, ringAll, { env: t.env([t.pane('%6', 'dave', 'main:2.0', 'claude', true)]) }));
  assert.doesNotMatch(all, /rang/);
  const env = t.env([dead, t.pane('%4', null)]);
  assert.match(ok(run(t.b, ['tag', '--as', 'bob', '--pane', '%4'], { env })), /^tagged %4 as bob/);
  assert.match(run(t.b, ['tag', '--as', 'bob', '--pane', '%3'], { env }).stderr, /no live tmux pane %3/);
  assert.match(run(t.b, ['tag', '--remove', '--pane', '%3'], { env }).stderr, /no live tmux pane %3/);
  assert.equal(ok(run(t.b, ['tag', '--list'], { env })), 'bob\t%4 (main:1.0 claude)\n');
});

test('ring --to all reaches tagged agents missing from agents.json and skips silent ones', () => {
  const t = tmuxBoard({ carol: { doorbell: null }, dave: {}, erin: { doorbell: ['false'] } });
  const env = t.env([t.pane('%3', 'bob'), t.pane('%4', 'ann'), t.pane('%5', 'carol')]);
  const all = run(t.b, ringAll, { env });
  assert.equal(all.status, 3);
  assert.match(all.stdout, /rang bob for T0001.M002/);
  assert.doesNotMatch(all.stdout, /rang (ann|carol|dave)/);
  assert.doesNotMatch(all.stderr, /carol|dave|ann/);
  assert.match(all.stderr, /ring failed for erin: exit 1/);
  assert.equal(t.logged(), 'send-keys -t %3 -l agent-board: T0001.M002 for you (hello)\nsend-keys -t %3 Enter\n');
});

test('doorbell: null is never rung, even with a live tagged pane', () => {
  const t = tmuxBoard({ bob: { doorbell: null } });
  const result = run(t.b, ringBob, { env: t.env([t.pane('%3', 'bob')]) });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /ring failed for bob: agents\.json sets doorbell: null/);
  assert.equal(t.logged(), '');
});

test('a command doorbell works without tmux, and --to all reports no tmux failure when none is needed', () => {
  const ringLog = path.join(board().dir, 'ring.log');
  const writer = [process.execPath, '-e', "require('fs').appendFileSync(process.env.RING_LOG, process.argv[1] + '\\n')", '{message}'];
  const t = tmuxBoard({ bob: { doorbell: writer }, carol: { doorbell: null } });
  const env = { PATH: path.join(t.b.dir, 'empty'), RING_LOG: ringLog };
  const one = run(t.b, ringBob, { env });
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /rang bob for T0001.M002/);
  const all = run(t.b, ringAll, { env });
  assert.equal(all.status, 0, all.stderr);
  assert.equal(all.stderr, '');
  assert.match(all.stdout, /rang bob for T0001.M003/);
  assert.equal(fs.readFileSync(ringLog, 'utf8').split('\n').filter(Boolean).length, 2);
});

test('tag --as tags the pane from TMUX_PANE or --pane, and says what it replaced', () => {
  const t = tmuxBoard();
  const env = t.env([t.pane('%3', null), t.pane('%4', 'ann')]);
  const viaEnv = ok(run(t.b, ['tag', '--as', 'bob'], { env: { ...env, TMUX_PANE: '%3' } }));
  assert.equal(viaEnv, `tagged %3 as bob on this board (${t.option})\n`);
  assert.equal(t.logged(), `set-option -p -t %3 ${t.option} bob\n`);
  const viaFlag = ok(run(t.b, ['tag', '--as', 'bob', '--pane', '%4', '--replace'], { env }));
  assert.equal(viaFlag, `tagged %4 as bob on this board (${t.option}) (was ann)\nuntagged %3\n`);
  assert.deepEqual(t.tags(), { '%3': undefined, '%4': 'bob' });
});

test('re-tagging the pane that already holds the name succeeds without --replace', () => {
  const t = tmuxBoard();
  const env = t.env([t.pane('%3', 'bob')]);
  assert.equal(ok(run(t.b, ['tag', '--as', 'bob', '--pane', '%3'], { env })), `tagged %3 as bob on this board (${t.option})\n`);
  assert.deepEqual(t.tags(), { '%3': 'bob' });
  assert.equal(t.logged(), `set-option -p -t %3 ${t.option} bob\n`);
});

test('tag --as refuses a name held by another pane unless --replace', () => {
  const t = tmuxBoard();
  const env = t.env([t.pane('%3', 'bob'), t.pane('%4', null)]);
  const refused = run(t.b, ['tag', '--as', 'bob', '--pane', '%4'], { env });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /bob is already tagged on this board in: %3 \(main:1\.0 claude\); add --replace/);
  assert.equal(t.logged(), '');
  const replaced = ok(run(t.b, ['tag', '--as', 'bob', '--pane', '%4', '--replace'], { env }));
  assert.equal(replaced, `tagged %4 as bob on this board (${t.option})\nuntagged %3\n`);
  assert.equal(t.logged(), `set-option -p -t %4 ${t.option} bob\nset-option -p -u -t %3 ${t.option}\n`);
});

test('--replace sets the new tag first: a failed set keeps the old holder', () => {
  const t = tmuxBoard();
  const env = t.env([t.pane('%3', 'bob'), t.pane('%4', null)], { FAKE_SET_FAIL: '%4' });
  const result = run(t.b, ['tag', '--as', 'bob', '--pane', '%4', '--replace'], { env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tmux set-option failed: fake tmux: refused/);
  assert.deepEqual(t.tags(), { '%3': 'bob', '%4': undefined });
  assert.doesNotMatch(t.logged(), / -u /);
});

test('--replace reports panes it could not untag after a successful set', () => {
  const t = tmuxBoard();
  const env = t.env([t.pane('%3', 'bob'), t.pane('%5', 'bob'), t.pane('%4', null)], { FAKE_UNSET_FAIL: '%5' });
  const result = run(t.b, ['tag', '--as', 'bob', '--pane', '%4', '--replace'], { env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /tagged %4 as bob/);
  assert.match(result.stdout, /untagged %3/);
  assert.ok(result.stderr.includes(`could not untag %5: tmux set-option failed: fake tmux: refused; fix: agent-board --dir ${fs.realpathSync(t.b.dir)} tag --remove --pane %5`), result.stderr);
  assert.deepEqual(t.tags(), { '%3': undefined, '%5': 'bob', '%4': 'bob' });
});

test('concurrent tag --as for one name on different panes: one wins, one is refused', async () => {
  const t = tmuxBoard();
  const env = t.env([t.pane('%3', null), t.pane('%4', null)], { FAKE_LIST_DELAY: '400' });
  const results = await Promise.all(['%3', '%4'].map((pane) => runAsync(t.b, ['tag', '--as', 'bob', '--pane', pane], { env })));
  assert.deepEqual(results.map((r) => r.status).sort(), [0, 1], results.map((r) => r.stderr).join('\n'));
  assert.match(results.find((r) => r.status === 1).stderr, /already tagged/);
  assert.equal(Object.values(t.tags()).filter((name) => name === 'bob').length, 1);
});

test('tag --list and --remove', () => {
  const t = tmuxBoard();
  const panes = [t.pane('%5', 'bob', 'dev:0.1', 'node'), t.pane('%3', 'ann'), t.pane('%4', null), t.other('%6', 'zed')];
  assert.equal(ok(run(t.b, ['tag', '--list'], { env: t.env(panes) })), 'ann\t%3 (main:1.0 claude)\nbob\t%5 (dev:0.1 node)\n');
  assert.equal(ok(run(t.b, ['tag', '--list'], { env: t.env([t.pane('%4', null)]) })), 'no tmux panes are tagged on this board\n');
  const env = t.env(panes);
  ok(run(t.b, ['tag', '--remove', '--pane', '%5'], { env }));
  assert.equal(t.logged(), `set-option -p -u -t %5 ${t.option}\n`);
  assert.deepEqual(t.tags(), { '%5': undefined, '%3': 'ann', '%4': undefined, '%6': undefined });
  assert.match(ok(run(t.b, ['tag', '--remove', '--pane', '%4'], { env })), /%4 has no tag on this board/);
  assert.equal(t.logged().split('\n').filter(Boolean).length, 1);
});

test('tag validates its input', () => {
  const t = tmuxBoard();
  const env = t.env([t.pane('%3', null)]);
  assert.match(run(t.b, ['tag', '--as', 'bob'], { env }).stderr, /not inside tmux.*--pane %N/);
  assert.match(run(t.b, ['tag', '--as', 'bob', '--pane', 'main'], { env }).stderr, /--pane must look like %3/);
  assert.match(run(t.b, ['tag', '--as', 'bob', '--pane', '%9'], { env }).stderr, /no live tmux pane %9/);
  assert.equal(run(t.b, ['tag', '--as', 'a/b', '--pane', '%3'], { env }).status, 1);
  assert.match(run(t.b, ['tag', '--as', 'bob', '--list'], { env }).stderr, /exactly one of/);
  assert.match(run(t.b, ['tag'], { env }).stderr, /exactly one of/);
  const missing = run(t.b, ['tag', '--list'], { env: { ...env, CHANNEL_DIR: path.join(t.b.dir, 'nowhere') } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no board at .*nowhere/);
  assert.equal(t.logged(), '');
});

test('watch prints one line per new message for the agent', async () => {
  const b = board();
  open(b, 'ann', 'topic', ['--to', 'bob']);
  const child = spawn(process.execPath, [CLI, 'watch', '--for', 'bob'], { env: envFor(b) });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await new Promise((resolve) => setTimeout(resolve, 600));
  post(b, 'T0001', 'ann', 'for bob', ['--to', 'bob']);
  post(b, 'T0001', 'bob', 'own message');
  open(b, 'ann', 'second', ['--to', 'all']);
  const deadline = Date.now() + 5000;
  while (out.split('\n').filter(Boolean).length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill();
  assert.deepEqual(out.split('\n').filter(Boolean), ['T0001.M002 from ann (note): for bob', 'T0002.M001 from ann (note): second']);
});

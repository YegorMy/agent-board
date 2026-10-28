'use strict';

// Summarizer adapters and `agent-board setup`, against stub codex / claude / opencode executables on PATH.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');

const CLI = path.resolve(__dirname, '..', 'bin', 'agent-board.cjs');
const TOOL_STUB = path.resolve(__dirname, 'stub-tool.cjs');
const adapters = require('../lib/adapters/index.cjs');

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-board-${prefix}-`));
}

// A directory holding executables named after the tools that run the stub.
function stubBin(tools = ['codex', 'claude', 'opencode']) {
  const dir = scratch('bin');
  for (const tool of tools) {
    const file = path.join(dir, tool);
    fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${TOOL_STUB}" ${tool} "$@"\n`);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

function setup(tools) {
  const bin = stubBin(tools);
  const log = path.join(bin, 'calls.log');
  const board = scratch('board');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CHANNEL_DIR: board, STUB_LOG: log };
  delete env.CHANNEL_SUMMARIZER_CMD;
  return {
    bin, log, board, env,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    modelCalls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
      .filter((c) => c.stdin !== undefined),
    cli: (args, { env: extra, input } = {}) => spawnSync(process.execPath, [CLI, ...args], {
      env: { ...env, ...extra }, input: input === undefined ? '' : input, encoding: 'utf8', timeout: 30000,
    }),
  };
}

// Runs fn with PATH pointing at the stubs, for calling the adapters in this process.
function withStubs(s, fn) {
  const saved = { PATH: process.env.PATH, STUB_LOG: process.env.STUB_LOG };
  const restore = () => {
    process.env.PATH = saved.PATH;
    if (saved.STUB_LOG === undefined) delete process.env.STUB_LOG; else process.env.STUB_LOG = saved.STUB_LOG;
  };
  process.env.PATH = s.env.PATH;
  process.env.STUB_LOG = s.log;
  let result;
  try { result = fn(); } catch (error) { restore(); throw error; }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

function openThreadWith(s, count = 1) {
  const run = (args) => {
    const r = s.cli(args);
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  run(['thread', 'open', '--from', 'ann', '--title', 'topic', '--body', 'opening']);
  for (let i = 1; i < count; i++) run(['post', '--thread', 'T0001', '--from', 'bob', '--subject', `reply ${i}`, '--body', `body ${i}`]);
}

function writeConfig(s, value) {
  fs.mkdirSync(s.board, { recursive: true });
  fs.writeFileSync(path.join(s.board, 'summarizer.json'), JSON.stringify(value));
}

test('detect reads --version only; a missing binary is reported, not thrown', () => {
  const s = setup(['claude']);
  withStubs(s, () => {
    assert.deepEqual(adapters.get('claude').detect(), { available: true, version: '2.1.312 (Claude Code)' });
  });
  const none = setup([]);
  const saved = process.env.PATH;
  process.env.PATH = none.bin;
  try {
    const found = adapters.get('codex').detect();
    assert.equal(found.available, false);
    assert.match(found.error, /codex not found on PATH/);
  } finally { process.env.PATH = saved; }
  assert.deepEqual(s.calls(), [], 'detect never reaches a catalog or model command');
});

test('catalogs: codex lists visible models with their levels, opencode uses variants, claude only suggests', () => {
  const s = setup();
  withStubs(s, () => {
    const codex = adapters.get('codex').catalog();
    assert.deepEqual(codex.models.map((m) => m.id), ['gpt-6-sol', 'gpt-5.5']);
    assert.deepEqual(codex.models[1].efforts, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(codex.verified, true);

    const opencode = adapters.get('opencode').catalog();
    assert.deepEqual(opencode.models.map((m) => m.id), ['vercel/openai/gpt-6.1-terra', 'lmstudio/local-model']);
    assert.deepEqual(opencode.models[0].efforts, ['low', 'medium', 'high']);
    assert.deepEqual(opencode.models[1].efforts, ['default']);

    const claude = adapters.get('claude').catalog();
    assert.deepEqual(claude.models.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
    assert.equal(claude.verified, false);
    assert.equal(claude.freeText, true);
    assert.match(claude.note, /not a verified availability list/);
  });
  assert.ok(s.calls().every((c) => c.stdin === undefined), 'no catalog command made a model call');
});

test('validate refuses unsupported models and efforts instead of replacing them', () => {
  const s = setup();
  withStubs(s, () => {
    const codex = adapters.get('codex');
    codex.validate({ model: 'gpt-5.5', effort: 'xhigh' });
    assert.throws(() => codex.validate({ model: 'gpt-5.5', effort: 'max' }), /effort "max" is not supported.*low, medium, high, xhigh/);
    assert.throws(() => codex.validate({ model: 'codex-auto-review', effort: 'low' }), /not in the codex catalog/);
    assert.throws(() => codex.validate({ model: 'nope', effort: 'low' }), /not in the codex catalog/);

    const opencode = adapters.get('opencode');
    opencode.validate({ model: 'vercel/openai/gpt-6.1-terra', effort: 'high' });
    opencode.validate({ model: 'lmstudio/local-model', effort: 'default' });
    assert.throws(() => opencode.validate({ model: 'lmstudio/local-model', effort: 'high' }), /choose one of default/);
    assert.throws(() => opencode.validate({ model: 'vercel/openai/gpt-6.1-terra', effort: 'max' }), /effort "max"/);

    const claude = adapters.get('claude');
    claude.validate({ model: 'claude-any-custom-id', effort: 'max' });
    assert.throws(() => claude.validate({ model: 'sonnet', effort: 'ultra' }), /choose one of low, medium, high, xhigh, max/);
    assert.throws(() => claude.validate({ model: '--dangerously-skip-permissions', effort: 'low' }), /not a plain token/);
  });
});

test('invocations: model, effort and the tool-disabling flags, never a bypass flag', () => {
  const dir = '/tmp/work';
  const codex = adapters.get('codex').invocation({ model: 'gpt-6-sol', effort: 'high', cwd: dir, tmpDir: dir });
  assert.equal(codex.bin, 'codex');
  assert.deepEqual(codex.args.slice(0, 5), ['exec', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort="high"']);
  for (const flag of ['--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules']) {
    assert.ok(codex.args.includes(flag), flag);
  }
  assert.ok(codex.args.join(' ').includes('--disable shell_tool --disable hooks --disable plugins --disable apps'));
  assert.equal(codex.args[codex.args.indexOf('-o') + 1], path.join(dir, 'out.md'));
  assert.equal(codex.args[codex.args.length - 1], '-', 'prompt on stdin');
  assert.ok(!adapters.get('codex').invocation({ model: '', effort: 'low', cwd: dir, tmpDir: dir }).args.includes('-m'));

  const claude = adapters.get('claude').invocation({ model: 'sonnet', effort: 'high', cwd: dir, tmpDir: dir });
  assert.equal(claude.bin, 'claude');
  assert.deepEqual(claude.args.slice(0, 7), ['-p', '--model', 'sonnet', '--effort', 'high', '--output-format', 'json']);
  assert.deepEqual(claude.args.slice(claude.args.indexOf('--tools'), claude.args.indexOf('--tools') + 2), ['--tools', '']);
  for (const flag of ['--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence']) {
    assert.ok(claude.args.includes(flag), flag);
  }

  const opencode = adapters.get('opencode').invocation({ model: 'vercel/openai/gpt-6.1-terra', effort: 'high', cwd: dir, tmpDir: dir });
  assert.deepEqual(opencode.args, ['run', '--standalone', '--model', 'vercel/openai/gpt-6.1-terra#high', '--format', 'json']);
  assert.deepEqual(JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT).permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
  assert.equal(opencode.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.deepEqual(adapters.get('opencode').invocation({ model: 'lmstudio/local-model', effort: 'default', cwd: dir, tmpDir: dir }).args.slice(0, 4),
    ['run', '--standalone', '--model', 'lmstudio/local-model']);

  for (const call of [codex, claude, opencode]) {
    assert.doesNotMatch(call.args.join(' '), /dangerously|yolo|bypass|danger-full-access/);
  }
});

test('extract returns only the final answer', () => {
  const dir = scratch('extract');
  fs.writeFileSync(path.join(dir, 'out.md'), 'codex answer\n');
  const codex = adapters.get('codex').invocation({ model: 'm', effort: 'low', cwd: dir, tmpDir: dir });
  assert.equal(codex.extract('{"type":"service"}\nnoise', dir), 'codex answer\n');
  assert.equal(codex.extract('noise', scratch('empty')), '');

  const claude = adapters.get('claude').invocation({ model: 'm', effort: 'low', cwd: dir, tmpDir: dir });
  assert.equal(claude.extract(JSON.stringify({ type: 'result', is_error: false, result: 'claude answer' })), 'claude answer');
  assert.equal(claude.extract(JSON.stringify([{ type: 'system' }, { type: 'result', result: 'from list' }])), 'from list');
  assert.equal(claude.extract('plain text answer'), 'plain text answer');
  assert.throws(() => claude.extract(JSON.stringify({ type: 'result', is_error: true, result: 'rate limited' })), /rate limited/);

  const opencode = adapters.get('opencode').invocation({ model: 'a/b', effort: 'default', cwd: dir, tmpDir: dir });
  const lines = [
    'banner line', JSON.stringify({ type: 'log', message: 'service' }),
    JSON.stringify({ type: 'text', part: { type: 'text', messageID: 'm1', text: 'first message' } }),
    JSON.stringify({ type: 'tool_use', part: { type: 'tool' } }),
    JSON.stringify({ type: 'text', part: { type: 'reasoning', messageID: 'm2', text: 'hidden reasoning' } }),
    JSON.stringify({ type: 'text', part: { type: 'text', messageID: 'm2', text: 'final ' } }),
    JSON.stringify({ type: 'text', part: { type: 'text', messageID: 'm2', text: 'answer' } }),
    JSON.stringify({ type: 'step_finish' }),
  ];
  assert.equal(opencode.extract(lines.join('\n')), 'final answer');
  assert.throws(() => opencode.extract(JSON.stringify({ type: 'error', error: { name: 'ProviderError', data: { message: 'no key' } } })), /no key/);
});

test('setup without a terminal needs every flag and exits 1 at once', () => {
  const s = setup();
  const started = Date.now();
  const result = s.cli(['setup', '--adapter', 'codex']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs --adapter, --model and --effort \(missing: --model, --effort\)/);
  assert.ok(Date.now() - started < 5000, 'does not wait for input');
  assert.equal(fs.existsSync(path.join(s.board, 'summarizer.json')), false);
  assert.deepEqual(s.calls(), []);
});

test('invalid input never writes summarizer.json', () => {
  const s = setup();
  const file = path.join(s.board, 'summarizer.json');
  const cases = [
    [['--adapter', 'codex', '--model', 'gpt-5.5', '--effort', 'max'], /effort "max" is not supported/],
    [['--adapter', 'codex', '--model', 'nope', '--effort', 'low'], /not in the codex catalog/],
    [['--adapter', 'opencode', '--model', 'lmstudio/local-model', '--effort', 'high'], /choose one of default/],
    [['--adapter', 'claude', '--model', 'sonnet', '--effort', 'ultra'], /choose one of low, medium, high, xhigh, max/],
    [['--adapter', 'gemini', '--model', 'x', '--effort', 'low'], /unknown adapter "gemini"/],
  ];
  for (const [flags, message] of cases) {
    const result = s.cli(['setup', ...flags]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
    assert.equal(fs.existsSync(file), false);
  }
  const missingTool = setup([]);
  const none = missingTool.cli(['setup', '--adapter', 'claude', '--model', 'sonnet', '--effort', 'low'], { env: { PATH: missingTool.bin } });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /claude is not usable: claude not found on PATH/);
});

test('valid setup writes summarizer.json atomically and --show reads it without a model call', () => {
  const s = setup();
  const result = s.cli(['setup', '--adapter', 'claude', '--model', 'sonnet', '--effort', 'high']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.board, 'summarizer.json'), 'utf8')),
    { adapter: 'claude', model: 'sonnet', effort: 'high' });
  assert.deepEqual(fs.readdirSync(s.board), ['summarizer.json'], 'no temp file left behind');

  const shown = s.cli(['setup', '--show']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /adapter claude, model sonnet, effort high/);
  assert.equal(s.modelCalls().length, 0);

  const override = s.cli(['setup', '--show'], { env: { CHANNEL_SUMMARIZER_CMD: 'my-summarizer --flag secret' } });
  assert.match(override.stdout, /custom command override.*command my-summarizer/);
  assert.doesNotMatch(override.stdout, /secret/);

  const fresh = setup();
  assert.match(fresh.cli(['setup', '--show']).stdout, /default: codex exec with its default model/);
  assert.deepEqual(s.calls(), [], 'show touched no tool at all');
});

test('setup --test is the one path that calls a model, and reports adapter, model, effort and duration', () => {
  const s = setup();
  const result = s.cli(['setup', '--adapter', 'opencode', '--model', 'vercel/openai/gpt-6.1-terra', '--effort', 'medium', '--test']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /test ok: adapter opencode · model vercel\/openai\/gpt-6\.1-terra · effort medium · \d+\.\d s/);
  const calls = s.modelCalls();
  assert.equal(calls.length, 1);
  assert.match(calls[0].stdin, /^Reply with/);
  assert.ok(fs.existsSync(path.join(s.board, 'summarizer.json')));

  const failing = setup();
  const bad = failing.cli(['setup', '--adapter', 'claude', '--model', 'sonnet', '--effort', 'low', '--test'], { env: { STUB_TOOL_FAIL: 'claude' } });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /test failed: test call exited 1.*provider unavailable/);
  assert.equal(fs.existsSync(path.join(failing.board, 'summarizer.json')), false, 'a failed test writes nothing');
});

test('thread close uses summarizer.json through the adapter and records adapter, model and effort', () => {
  for (const [config, label, check] of [
    [{ adapter: 'claude', model: 'sonnet', effort: 'high' }, 'adapter claude · model sonnet · effort high',
      (c) => assert.deepEqual(c.argv.slice(0, 7), ['-p', '--model', 'sonnet', '--effort', 'high', '--output-format', 'json'])],
    [{ adapter: 'codex', model: 'gpt-6-sol', effort: 'xhigh' }, 'adapter codex · model gpt-6-sol · effort xhigh',
      (c) => assert.deepEqual(c.argv.slice(0, 5), ['exec', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort="xhigh"'])],
    [{ adapter: 'opencode', model: 'vercel/openai/gpt-6.1-terra', effort: 'low' }, 'adapter opencode · model vercel/openai/gpt-6.1-terra · effort low',
      (c) => {
        assert.deepEqual(c.argv, ['run', '--standalone', '--model', 'vercel/openai/gpt-6.1-terra#low', '--format', 'json']);
        assert.match(c.opencodeConfig, /"effect":"deny"/);
      }],
  ]) {
    const s = setup();
    writeConfig(s, config);
    openThreadWith(s, 3);
    const closed = s.cli(['thread', 'close', '--thread', 'T0001', '--from', 'ann']);
    assert.equal(closed.status, 0, closed.stderr);
    const calls = s.modelCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, config.adapter);
    check(calls[0]);
    assert.match(calls[0].stdin, /Thread T0001/, 'prompt arrives on stdin');
    assert.notEqual(calls[0].cwd, s.board);
    assert.ok(calls[0].entries.length <= 1, `runs in an empty temp cwd, found ${calls[0].entries}`);
    const meta = JSON.parse(fs.readFileSync(path.join(s.board, 'threads', 'T0001', 'meta.json'), 'utf8'));
    assert.equal(meta.summary_model, label);
    assert.equal(meta.summary_validation, 'ok');
    const summary = fs.readFileSync(path.join(s.board, 'threads', 'T0001', 'SUMMARY.md'), 'utf8');
    assert.ok(summary.includes(`model: ${label}`), summary.split('\n').slice(0, 6).join('\n'));
    assert.doesNotMatch(summary, /--safe-mode|OPENCODE_CONFIG|service banner|not the answer/);
  }
});

test('the configured effort applies to every phase of a map-reduce close', () => {
  const s = setup();
  writeConfig(s, { adapter: 'claude', model: 'opus', effort: 'max' });
  openThreadWith(s, 1);
  for (let i = 0; i < 60; i++) {
    const r = s.cli(['post', '--thread', 'T0001', '--from', 'bob', '--subject', `m${i}`, '--body', 'x'.repeat(900)]);
    assert.equal(r.status, 0, r.stderr);
  }
  const closed = s.cli(['thread', 'close', '--thread', 'T0001', '--from', 'ann'], { env: { CHANNEL_CHUNK_BYTES: String(20 * 1024) } });
  assert.equal(closed.status, 0, closed.stderr);
  const calls = s.modelCalls();
  assert.ok(calls.length > 3, `${calls.length} calls`);
  assert.ok(calls.every((c) => c.argv[c.argv.indexOf('--effort') + 1] === 'max'), 'every call used the configured effort');
});

test('CHANNEL_SUMMARIZER_CMD still wins over summarizer.json', () => {
  const s = setup();
  writeConfig(s, { adapter: 'claude', model: 'sonnet', effort: 'high' });
  openThreadWith(s, 2);
  const custom = path.join(s.bin, 'custom.cjs');
  fs.writeFileSync(custom, `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(
    '## Outcome\nCustom.\n\n## Decisions\n- d (T0001.M001).\n\n## Changes made\n- c (T0001.M002).\n\n## Evidence\n- e\n\n## Corrections\nNone.\n\n## Open items\nNone.\n')}));`);
  const closed = s.cli(['thread', 'close', '--thread', 'T0001', '--from', 'ann'], {
    env: { CHANNEL_SUMMARIZER_CMD: `"${process.execPath}" "${custom}" --token secret` },
  });
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(s.modelCalls().length, 0, 'the adapter was not called');
  const meta = JSON.parse(fs.readFileSync(path.join(s.board, 'threads', 'T0001', 'meta.json'), 'utf8'));
  assert.equal(meta.summary_model, 'command node');
});

test('a failing adapter never falls back to another provider; a broken summarizer.json stops the close', () => {
  const s = setup();
  writeConfig(s, { adapter: 'claude', model: 'sonnet', effort: 'high' });
  openThreadWith(s, 2);
  const failed = s.cli(['thread', 'close', '--thread', 'T0001', '--from', 'ann'], { env: { STUB_TOOL_FAIL: 'claude' } });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /summarizer failed: single call exited 1.*provider unavailable.*stays closing/);
  assert.deepEqual(s.modelCalls().map((c) => c.tool), ['claude'], 'codex and opencode were not tried');

  writeConfig(s, { adapter: 'claude', model: 'sonnet' });
  const broken = s.cli(['thread', 'close', '--thread', 'T0001', '--from', 'ann', '--retry']);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /summarizer.json needs non-empty string effort/);
  writeConfig(s, { adapter: 'gemini', model: 'x', effort: 'low' });
  assert.match(s.cli(['thread', 'close', '--thread', 'T0001', '--from', 'ann', '--retry']).stderr, /unknown adapter "gemini"/);
  assert.equal(s.modelCalls().length, 1);
});

test('a configured adapter that is not installed points to setup', () => {
  const s = setup([]);
  writeConfig(s, { adapter: 'opencode', model: 'a/b', effort: 'low' });
  openThreadWith(s, 2);
  const failed = s.cli(['thread', 'close', '--thread', 'T0001', '--from', 'ann'], { env: { PATH: s.bin } });
  assert.match(failed.stderr, /opencode not found; install it or run agent-board setup/);
});

test('interactive setup: detected adapters, model filter and number pick, effort pick, confirmation', async () => {
  const s = setup();
  const store = require('../lib/store.cjs');
  const { setup: runSetup } = require('../lib/setup.cjs');
  const previous = store.paths.dir;
  store.setDir(s.board);
  const drive = async (lines, opts = {}) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (d) => { text += d; });
    input.end(lines.join('\n') + '\n');
    try { await withStubs(s, () => runSetup(opts, { input, output, tty: true })); } catch (error) { return { error, text }; }
    return { text };
  };
  try {
    const picked = await drive(['codex', 'gpt-5', '1', '2', 'y']);
    assert.ifError(picked.error);
    assert.match(picked.text, /1\) opencode[\s\S]*2\) codex[\s\S]*3\) claude/);
    assert.match(picked.text, /nothing matches|gpt-5\.5/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.board, 'summarizer.json'), 'utf8')),
      { adapter: 'codex', model: 'gpt-5.5', effort: 'medium' });

    const manual = await drive(['3', 'my-own-model-id', '5', 'yes']);
    assert.ifError(manual.error);
    assert.match(manual.text, /not a verified availability list/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.board, 'summarizer.json'), 'utf8')),
      { adapter: 'claude', model: 'my-own-model-id', effort: 'max' });

    const declined = await drive(['claude', 'sonnet', 'low', 'n']);
    assert.match(declined.error.message, /nothing written/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.board, 'summarizer.json'), 'utf8')).model, 'my-own-model-id');

    const closed = await drive(['claude']);
    assert.match(closed.error.message, /input closed/, 'closed input aborts instead of hanging');
    assert.equal(s.modelCalls().length, 0);
  } finally { store.setDir(previous); }
});

'use strict';

// Works on a temp HOME and a fixture skill dir; never touches the real home. Run: node --test

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { installSkill, MANIFEST } = require('../lib/install-skill.cjs');

const CLI = path.resolve(__dirname, '..', 'bin', 'agent-board.cjs');
const VERSION = require('../package.json').version;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-skill-'));
  const source = path.join(dir, 'src');
  fs.mkdirSync(path.join(source, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: agent-board\n---\none\n');
  fs.writeFileSync(path.join(source, 'agents', 'openai.yaml'), 'a: 1\n');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  return { dir, source, home };
}

function install(s, opts = {}) {
  let text = '';
  const result = installSkill(opts, { home: s.home, source: s.source, out: (t) => { text += t; } });
  return { ...result, text };
}

const claudeDest = (s) => path.join(s.home, '.claude', 'skills', 'agent-board');
const agentsDest = (s) => path.join(s.home, '.agents', 'skills', 'agent-board');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const ONE = '---\nname: agent-board\n---\none\n';

test('fresh install writes both roots with a manifest', () => {
  const s = sandbox();
  const r = install(s);
  assert.equal(r.refused, false);
  for (const dest of [claudeDest(s), agentsDest(s)]) {
    assert.equal(fs.readFileSync(path.join(dest, 'agents', 'openai.yaml'), 'utf8'), 'a: 1\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest, MANIFEST), 'utf8')), {
      tool: 'agent-board', version: VERSION,
      files: { 'SKILL.md': sha(ONE), 'agents/openai.yaml': sha('a: 1\n') },
    });
    assert.ok(!fs.lstatSync(path.join(dest, 'SKILL.md')).isSymbolicLink());
  }
  assert.match(r.text, /installed: .*\.claude.*read by claude/);
  assert.match(r.text, /installed: .*\.agents.*read by codex, opencode; shared root/);
  assert.match(r.text, /note: opencode reads both.*two discovery roots/);
});

test('codex and opencode targets write one shared copy', () => {
  for (const target of ['codex', 'opencode']) {
    const s = sandbox();
    install(s, { target });
    assert.ok(fs.existsSync(agentsDest(s)));
    assert.ok(!fs.existsSync(path.join(s.home, '.claude')));
  }
  const s = sandbox();
  install(s, { target: 'claude' });
  assert.ok(fs.existsSync(claudeDest(s)));
  assert.ok(!fs.existsSync(path.join(s.home, '.agents')));
});

// Fails only the tmp -> dest publish rename (and, when asked, the restore old -> dest) of an update.
function withFailingPublish(s, { failRestore }, fn) {
  const real = fs.renameSync;
  const dest = claudeDest(s);
  fs.renameSync = (from, to) => {
    const isTmp = path.basename(from).endsWith('.tmp');
    if (to === dest && (isTmp || (failRestore && from.endsWith('.tmp.old')))) {
      throw Object.assign(new Error(`ENOSPC: no space left on device, rename '${from}' -> '${to}'`), { code: 'ENOSPC' });
    }
    return real(from, to);
  };
  try { return fn(); } finally { fs.renameSync = real; }
}

test('a failed publish on update restores the previous version and leaves no temp or backup', () => {
  const s = sandbox();
  install(s, { target: 'claude' });
  fs.writeFileSync(path.join(s.source, 'SKILL.md'), 'two\n');
  let text = '';
  assert.throws(() => withFailingPublish(s, { failRestore: false }, () => {
    installSkill({ target: 'claude' }, { home: s.home, source: s.source, out: (t) => { text += t; } });
  }), /ENOSPC/);
  assert.equal(fs.readFileSync(path.join(claudeDest(s), 'SKILL.md'), 'utf8'), ONE);
  assert.ok(fs.existsSync(path.join(claudeDest(s), MANIFEST)));
  assert.deepEqual(fs.readdirSync(path.dirname(claudeDest(s))), ['agent-board']);
  assert.equal(install(s, { target: 'claude' }).refused, false);
  assert.equal(fs.readFileSync(path.join(claudeDest(s), 'SKILL.md'), 'utf8'), 'two\n');
});

test('a failed publish whose restore also fails keeps the backup and names its path', () => {
  const s = sandbox();
  install(s, { target: 'claude' });
  fs.writeFileSync(path.join(s.source, 'SKILL.md'), 'two\n');
  let message = '';
  try {
    withFailingPublish(s, { failRestore: true }, () => install(s, { target: 'claude' }));
  } catch (error) { message = error.message; }
  const names = fs.readdirSync(path.dirname(claudeDest(s)));
  const backup = names.find((name) => name.endsWith('.tmp.old'));
  assert.ok(backup, `backup kept: ${names}`);
  assert.ok(!names.some((name) => name.endsWith('.tmp')));
  assert.ok(message.includes(path.join(path.dirname(claudeDest(s)), backup)), message);
  assert.equal(fs.readFileSync(path.join(path.dirname(claudeDest(s)), backup, 'SKILL.md'), 'utf8'), ONE);
});

test('unknown target is an error', () => {
  assert.throws(() => install(sandbox(), { target: 'vim' }), /--target must be one of/);
});

test('reinstall is unchanged; a source change updates and drops removed files', () => {
  const s = sandbox();
  install(s);
  assert.match(install(s).text, /unchanged: .*\.claude/);
  fs.writeFileSync(path.join(s.source, 'SKILL.md'), 'two\n');
  fs.rmSync(path.join(s.source, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(s.source, 'new.md'), 'n\n');
  const r = install(s);
  assert.match(r.text, /updated: .*\.claude/);
  assert.match(r.text, /~ SKILL\.md/);
  assert.match(r.text, /\+ new\.md/);
  assert.match(r.text, /- agents\/openai\.yaml/);
  assert.equal(fs.readFileSync(path.join(claudeDest(s), 'SKILL.md'), 'utf8'), 'two\n');
  assert.ok(!fs.existsSync(path.join(claudeDest(s), 'agents')));
  const files = JSON.parse(fs.readFileSync(path.join(claudeDest(s), MANIFEST), 'utf8')).files;
  assert.deepEqual(Object.keys(files).sort(), ['SKILL.md', 'new.md']);
  assert.deepEqual(fs.readdirSync(path.dirname(claudeDest(s))), ['agent-board']);
});

test('a foreign dir without manifest is refused and untouched', () => {
  const s = sandbox();
  fs.mkdirSync(claudeDest(s), { recursive: true });
  fs.writeFileSync(path.join(claudeDest(s), 'SKILL.md'), 'mine\n');
  const r = install(s);
  assert.equal(r.refused, true);
  assert.match(r.text, /refused: .*\.claude.*not installed by agent-board/);
  assert.match(r.text, /installed: .*\.agents/);
  assert.deepEqual(fs.readdirSync(claudeDest(s)), ['SKILL.md']);
  assert.equal(fs.readFileSync(path.join(claudeDest(s), 'SKILL.md'), 'utf8'), 'mine\n');
});

test('a user-modified file or an extra file refuses the update and changes nothing', () => {
  const s = sandbox();
  install(s, { target: 'claude' });
  fs.writeFileSync(path.join(s.source, 'SKILL.md'), 'two\n');
  const dest = claudeDest(s);
  fs.writeFileSync(path.join(dest, 'SKILL.md'), 'edited\n');
  let r = install(s, { target: 'claude' });
  assert.equal(r.refused, true);
  assert.match(r.text, /refused: .*modified or missing: SKILL\.md/);
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), 'edited\n');
  fs.writeFileSync(path.join(dest, 'SKILL.md'), ONE);
  fs.writeFileSync(path.join(dest, 'notes.txt'), 'x');
  r = install(s, { target: 'claude' });
  assert.equal(r.refused, true);
  assert.match(r.text, /extra files: notes\.txt/);
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), ONE);
  assert.ok(fs.existsSync(path.join(dest, 'notes.txt')));
});

test('symlinks are refused: root, skill dir, nested dir and file', () => {
  const elsewhere = sandbox();
  fs.writeFileSync(path.join(elsewhere.dir, 'other'), 'o');

  let s = sandbox();
  fs.mkdirSync(path.join(s.home, '.claude'));
  fs.symlinkSync(elsewhere.dir, path.join(s.home, '.claude', 'skills'));
  let r = install(s, { target: 'claude' });
  assert.equal(r.refused, true);
  assert.match(r.text, /skills is a symlink/);
  assert.ok(!fs.existsSync(path.join(elsewhere.dir, 'agent-board')));

  s = sandbox();
  fs.mkdirSync(path.dirname(claudeDest(s)), { recursive: true });
  fs.symlinkSync(elsewhere.dir, claudeDest(s));
  r = install(s, { target: 'claude' });
  assert.equal(r.refused, true);
  assert.match(r.text, /agent-board is a symlink/);

  for (const kind of ['dir', 'file']) {
    s = sandbox();
    install(s, { target: 'claude' });
    const victim = kind === 'dir' ? path.join(claudeDest(s), 'agents') : path.join(claudeDest(s), 'SKILL.md');
    fs.rmSync(victim, { recursive: true });
    fs.symlinkSync(kind === 'dir' ? elsewhere.dir : path.join(elsewhere.dir, 'other'), victim);
    r = install(s, { target: 'claude' });
    assert.equal(r.refused, true);
    assert.match(r.text, /is a symlink/);
    assert.ok(fs.lstatSync(victim).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(elsewhere.dir, 'other'), 'utf8'), 'o');
  }
});

test('dry-run changes nothing', () => {
  const s = sandbox();
  let r = install(s, { 'dry-run': true });
  assert.match(r.text, /would install: .*\.claude/);
  assert.ok(!fs.existsSync(path.join(s.home, '.claude')));
  assert.ok(!fs.existsSync(path.join(s.home, '.agents')));
  install(s);
  fs.writeFileSync(path.join(s.source, 'SKILL.md'), 'two\n');
  r = install(s, { 'dry-run': true });
  assert.match(r.text, /would update/);
  assert.equal(fs.readFileSync(path.join(claudeDest(s), 'SKILL.md'), 'utf8'), ONE);
  r = install(s, { 'dry-run': true, uninstall: true });
  assert.match(r.text, /would remove/);
  assert.ok(fs.existsSync(path.join(claudeDest(s), MANIFEST)));
});

test('uninstall removes only our files and keeps a foreign one', () => {
  const s = sandbox();
  install(s);
  let r = install(s, { uninstall: true });
  assert.match(r.text, /removed: .*\.claude/);
  assert.ok(!fs.existsSync(claudeDest(s)));
  assert.ok(!fs.existsSync(agentsDest(s)));
  assert.match(install(s, { uninstall: true }).text, /not installed/);

  install(s, { target: 'claude' });
  fs.writeFileSync(path.join(claudeDest(s), 'mine.txt'), 'x');
  r = install(s, { target: 'claude', uninstall: true });
  assert.equal(r.refused, true);
  assert.ok(fs.existsSync(path.join(claudeDest(s), 'SKILL.md')));
  fs.rmSync(path.join(claudeDest(s), 'mine.txt'));
  fs.writeFileSync(path.join(s.home, '.claude', 'skills', 'other.txt'), 'x');
  install(s, { target: 'claude', uninstall: true });
  assert.ok(!fs.existsSync(claudeDest(s)));
  assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'other.txt')));
});

test('uninstall refuses a foreign directory', () => {
  const s = sandbox();
  fs.mkdirSync(agentsDest(s), { recursive: true });
  fs.writeFileSync(path.join(agentsDest(s), 'SKILL.md'), 'mine\n');
  const r = install(s, { target: 'codex', uninstall: true });
  assert.equal(r.refused, true);
  assert.ok(fs.existsSync(path.join(agentsDest(s), 'SKILL.md')));
});

test('CLI exits non-zero on refusal, zero otherwise, and honors HOME', () => {
  const s = sandbox();
  const run = (...args) => spawnSync(process.execPath, [CLI, 'install-skill', ...args], { env: { ...process.env, HOME: s.home }, encoding: 'utf8' });
  fs.mkdirSync(agentsDest(s), { recursive: true });
  let r = run('--target', 'codex');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /refused:/);
  r = run('--target', 'claude', '--dry-run');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /would install/);
  assert.ok(!fs.existsSync(path.join(s.home, '.claude')));
  assert.equal(run('--target', 'bogus').status, 1);
});

test('npm pack lists the skill', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-npm-cache-'));
  let r;
  try {
    r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cache], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: { ...process.env, npm_config_cache: cache },
    });
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
  assert.equal(r.status, 0, r.stderr);
  const names = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  assert.ok(names.includes('skills/agent-board/SKILL.md'));
});

'use strict';

// `agent-board install-skill`: copies skills/agent-board into the skill folders of the agent tools.
// Ownership is proven by a manifest of sha256 sums; anything foreign, edited or symlinked is left alone.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SKILL_NAME = 'agent-board';
const MANIFEST = '.agent-board-skill.json';
const DEFAULT_SOURCE = path.resolve(__dirname, '..', 'skills', SKILL_NAME);
const TARGETS = ['claude', 'codex', 'opencode', 'all'];

// codex and opencode both read ~/.agents/skills, so they share one physical root.
const ROOTS = {
  claude: { dir: ['.claude', 'skills'], tools: ['claude'] },
  agents: { dir: ['.agents', 'skills'], tools: ['codex', 'opencode'] },
};
const TARGET_ROOTS = { claude: ['claude'], codex: ['agents'], opencode: ['agents'], all: ['claude', 'agents'] };

class Refusal extends Error {}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function lstat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Relative posix path -> sha256 for every file under dir. Throws Refusal on a symlink or an odd entry.
function walk(dir, base = dir, found = {}) {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const rel = path.relative(base, file).split(path.sep).join('/');
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Refusal(`${rel} is a symlink`);
    if (stat.isDirectory()) walk(file, base, found);
    else if (stat.isFile()) found[rel] = sha256(fs.readFileSync(file));
    else throw new Refusal(`${rel} is not a regular file`);
  }
  return found;
}

function readSource(source) {
  const stat = lstat(source);
  if (!stat || !stat.isDirectory() || !lstat(path.join(source, 'SKILL.md'))) {
    throw new Error(`skill source ${source} has no SKILL.md`);
  }
  let files;
  try { files = walk(source); } catch (error) {
    if (error instanceof Refusal) throw new Error(`skill source ${source}: ${error.message}`);
    throw error;
  }
  delete files[MANIFEST];
  return files;
}

function safeRel(rel) {
  return typeof rel === 'string' && rel !== '' && !path.isAbsolute(rel) && !rel.split('/').some((part) => part === '' || part === '.' || part === '..');
}

// Reads what is installed at dest. Returns null when absent; throws Refusal when it is not ours or was touched.
function inspect(root, dest) {
  const rootStat = lstat(root);
  if (rootStat && rootStat.isSymbolicLink()) throw new Refusal(`${root} is a symlink`);
  if (rootStat && !rootStat.isDirectory()) throw new Refusal(`${root} is not a directory`);
  const stat = lstat(dest);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new Refusal(`${dest} is a symlink`);
  if (!stat.isDirectory()) throw new Refusal(`${dest} is not a directory`);
  const manifestPath = path.join(dest, MANIFEST);
  const manifestStat = lstat(manifestPath);
  if (!manifestStat) throw new Refusal(`${dest} exists without ${MANIFEST}; it is not installed by agent-board`);
  if (!manifestStat.isFile()) throw new Refusal(`${MANIFEST} is not a regular file`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { manifest = null; }
  if (!manifest || manifest.tool !== SKILL_NAME || !manifest.files || typeof manifest.files !== 'object'
    || !Object.keys(manifest.files).every(safeRel)) {
    throw new Refusal(`${MANIFEST} in ${dest} is not an agent-board manifest`);
  }
  const actual = walk(dest);
  delete actual[MANIFEST];
  const modified = Object.keys(manifest.files).filter((rel) => actual[rel] !== manifest.files[rel]);
  const extra = Object.keys(actual).filter((rel) => !(rel in manifest.files));
  if (modified.length || extra.length) {
    const parts = [];
    if (modified.length) parts.push(`modified or missing: ${modified.join(', ')}`);
    if (extra.length) parts.push(`extra files: ${extra.join(', ')}`);
    throw new Refusal(`${parts.join('; ')}; remove or revert them first`);
  }
  return manifest;
}

function removeEmptyDirs(dir, stop) {
  for (let current = dir; current !== stop; current = path.dirname(current)) {
    try { fs.rmdirSync(current); } catch { return; }
  }
}

function stage(root, dest, source, files, version) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, `.${SKILL_NAME}.${process.pid}.tmp`);
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const rel of Object.keys(files)) {
      const target = path.join(tmp, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, ...rel.split('/')), target);
    }
    fs.writeFileSync(path.join(tmp, MANIFEST), JSON.stringify({ tool: SKILL_NAME, version, files }, null, 2) + '\n');
    const old = `${tmp}.old`;
    if (lstat(dest)) {
      fs.renameSync(dest, old);
      try {
        fs.renameSync(tmp, dest);
      } catch (error) {
        // Publishing failed: put the previous version back so it stays discoverable.
        try {
          fs.renameSync(old, dest);
        } catch (restoreError) {
          fs.rmSync(tmp, { recursive: true, force: true });
          throw new Error(`${error.message}; restoring the previous version also failed (${restoreError.message}); `
            + `it is kept at ${old}, move it back to ${dest} by hand`);
        }
        throw error;
      }
      fs.rmSync(old, { recursive: true, force: true });
    } else {
      fs.renameSync(tmp, dest);
    }
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

// Returns { status, details } or throws Refusal. status: install|update|unchanged|remove|absent (dry-run changes nothing).
function handleRoot({ root, dest, source, files, version, uninstall, dryRun }) {
  const current = inspect(root, dest);
  if (uninstall) {
    if (!current) return { status: 'absent', details: [] };
    const details = [...Object.keys(current.files), MANIFEST].map((rel) => `- ${rel}`);
    if (!dryRun) {
      for (const rel of Object.keys(current.files)) fs.rmSync(path.join(dest, ...rel.split('/')), { force: true });
      fs.rmSync(path.join(dest, MANIFEST), { force: true });
      for (const rel of Object.keys(current.files)) removeEmptyDirs(path.dirname(path.join(dest, ...rel.split('/'))), dest);
      try { fs.rmdirSync(dest); } catch { /* not empty: keep it */ }
    }
    return { status: 'remove', details };
  }
  if (!current) {
    if (!dryRun) stage(root, dest, source, files, version);
    return { status: 'install', details: Object.keys(files).map((rel) => `+ ${rel}`) };
  }
  const details = [];
  for (const rel of Object.keys(files)) {
    if (!(rel in current.files)) details.push(`+ ${rel}`);
    else if (current.files[rel] !== files[rel]) details.push(`~ ${rel}`);
  }
  for (const rel of Object.keys(current.files)) if (!(rel in files)) details.push(`- ${rel}`);
  if (!details.length && current.version === version) return { status: 'unchanged', details };
  if (!dryRun) stage(root, dest, source, files, version);
  return { status: 'update', details };
}

const DONE = { install: 'installed', update: 'updated', unchanged: 'unchanged', remove: 'removed', absent: 'not installed' };
const WOULD = { install: 'would install', update: 'would update', unchanged: 'unchanged', remove: 'would remove', absent: 'not installed' };

// Prints one block per physical root and returns { refused } (true when any root was refused).
function installSkill(opts, env = {}) {
  const home = env.home || os.homedir();
  const source = env.source || DEFAULT_SOURCE;
  const out = env.out || ((text) => process.stdout.write(text));
  const version = env.version || require('../package.json').version;
  const target = opts.target === undefined ? 'all' : opts.target;
  if (!TARGETS.includes(target)) throw new Error(`--target must be one of ${TARGETS.join(', ')}`);
  const dryRun = Boolean(opts['dry-run']);
  const uninstall = Boolean(opts.uninstall);
  const files = uninstall ? {} : readSource(source);
  let refused = false;
  for (const key of TARGET_ROOTS[target]) {
    const root = path.join(home, ...ROOTS[key].dir);
    const dest = path.join(root, SKILL_NAME);
    const tools = ROOTS[key].tools;
    const readers = `read by ${tools.join(', ')}${tools.length > 1 ? '; shared root, one copy' : ''}`;
    try {
      const { status, details } = handleRoot({ root, dest, source, files, version, uninstall, dryRun });
      out(`${(dryRun ? WOULD : DONE)[status]}: ${dest} (${readers})\n`);
      for (const line of details) out(`  ${line}\n`);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      refused = true;
      out(`refused: ${dest} (${readers}): ${error.message}\n`);
    }
  }
  if (target === 'all' && !uninstall) {
    out('note: opencode reads both ~/.claude/skills and ~/.agents/skills, so with `all` it can find the '
      + 'skill in two discovery roots. For a single copy in opencode, set OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 or install with --target codex only.\n');
  }
  return { refused };
}

module.exports = { installSkill, MANIFEST };

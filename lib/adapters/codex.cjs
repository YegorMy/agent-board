'use strict';

// codex adapter. Catalog: `codex debug models --bundled` (offline, shipped with the binary).
// Tools: codex has no switch for "no tools"; the shell is bounded by a read-only sandbox and the
// features below are switched off. User config.toml (MCP servers, profiles) and execpolicy rules are not loaded.

const fs = require('node:fs');
const path = require('node:path');
const common = require('./common.cjs');

const BIN = 'codex';
const DISABLED_FEATURES = ['shell_tool', 'hooks', 'plugins', 'apps', 'multi_agent', 'view_image', 'image_generation', 'browser_use', 'computer_use'];

const controls = {
  disabled: [
    `features: ${DISABLED_FEATURES.join(', ')} (codex --disable)`,
    'user config.toml, so user MCP servers and profiles are not loaded (--ignore-user-config)',
    'user and project execpolicy rules (--ignore-rules)',
    'session files on disk (--ephemeral)',
    'writes outside the sandbox: --sandbox read-only, in an empty temp directory',
  ],
  cannot: [
    'codex has no "tools off" switch; a shell can still be offered to the model (unified_exec stays on) and read files the OS allows',
    'only the bundled model catalog is read, which can lag behind what the account can use',
  ],
};

function detect() {
  return common.detectBinary(BIN);
}

function catalog() {
  let parsed;
  try { parsed = JSON.parse(common.catalogOutput(BIN, ['debug', 'models', '--bundled'])); } catch (error) {
    if (error instanceof common.AdapterError) throw error;
    throw new common.AdapterError(`codex debug models --bundled: not JSON (${error.message})`);
  }
  if (!parsed || !Array.isArray(parsed.models)) throw new common.AdapterError('codex debug models --bundled: no "models" list');
  const models = parsed.models.filter((m) => m.visibility === 'list' && typeof m.slug === 'string').map((m) => ({
    id: m.slug, name: m.display_name || m.slug,
    efforts: (m.supported_reasoning_levels || []).map((level) => level.effort),
    defaultEffort: m.default_reasoning_level || null,
  }));
  if (!models.length) throw new common.AdapterError('codex debug models --bundled: no listed models');
  return { models, verified: true, note: 'bundled catalog of this codex build' };
}

function validate(settings, cat = catalog()) {
  common.checkAgainstCatalog('codex', cat, settings);
}

// model may be empty only for the default (no -m) run.
function invocation({ model, effort, cwd, tmpDir }) {
  if (model) common.token(model, 'model');
  common.token(effort, 'effort');
  const outFile = path.join(tmpDir, 'out.md');
  return {
    bin: BIN,
    args: ['exec', ...(model ? ['-m', model] : []), '-c', `model_reasoning_effort="${effort}"`,
      ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
      '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '-C', cwd, '-o', outFile, '-'],
    env: {},
    extract: (stdout, dir) => {
      const file = path.join(dir, 'out.md');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    },
  };
}

module.exports = { name: 'codex', label: 'codex', bin: BIN, controls, detect, catalog, validate, invocation };

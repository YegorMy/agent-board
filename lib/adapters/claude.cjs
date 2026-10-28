'use strict';

// claude adapter. The CLI has no model catalog, so the aliases below are suggestions, not a list of
// what the account can use; any model id is accepted and checked only by the first real call.
// Effort levels come from `claude --help` (--effort). Not every model supports every level.

const common = require('./common.cjs');

const BIN = 'claude';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SUGGESTIONS = ['fable', 'opus', 'sonnet', 'haiku'];

const controls = {
  disabled: [
    'all built-in tools (--tools "")',
    'MCP servers not given on the command line (--strict-mcp-config; none are given)',
    'hooks, plugins, skills, CLAUDE.md and user/project customizations (--safe-mode)',
    'slash commands and skills (--disable-slash-commands)',
    'permission prompts: anything that would prompt is denied (--permission-prompts none)',
    'session files on disk (--no-session-persistence)',
  ],
  cannot: [
    '--bare is not used: it ignores OAuth/keychain login and needs ANTHROPIC_API_KEY',
    'admin-managed (policy) settings still apply under --safe-mode',
    'model ids are not verified against anything before the first call; effort support differs per model',
  ],
};

function detect() {
  return common.detectBinary(BIN);
}

function catalog() {
  return {
    models: SUGGESTIONS.map((id) => ({ id, name: id, efforts: EFFORTS })),
    verified: false, freeText: true,
    note: 'claude has no model catalog: these aliases are suggestions, not a verified availability list; any model id may be typed',
  };
}

function validate({ model, effort }) {
  common.token(model, 'model');
  common.checkEffort('claude', EFFORTS, effort);
}

function invocation({ model, effort }) {
  common.token(model, 'model');
  common.checkEffort('claude', EFFORTS, effort);
  return {
    bin: BIN,
    args: ['-p', '--model', model, '--effort', effort, '--output-format', 'json',
      '--tools', '', '--strict-mcp-config', '--safe-mode', '--disable-slash-commands',
      '--no-session-persistence', '--permission-prompts', 'none'],
    env: {},
    extract,
  };
}

// JSON result object (or a list of events ending in one); anything that is not JSON is taken as plain text.
function extract(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return stdout; }
  const events = Array.isArray(parsed) ? parsed : [parsed];
  const result = events.filter((e) => e && e.type === 'result').pop();
  if (!result) throw new common.AdapterError('claude: no result in the JSON output');
  if (result.is_error) throw new common.AdapterError(`claude reported an error: ${String(result.result || result.subtype || 'unknown').slice(0, 300)}`);
  return typeof result.result === 'string' ? result.result : '';
}

module.exports = { name: 'claude', label: 'claude', bin: BIN, controls, detect, catalog, validate, invocation, EFFORTS };

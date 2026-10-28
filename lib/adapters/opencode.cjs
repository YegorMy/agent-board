'use strict';

// opencode adapter. Catalog: `opencode api --standalone model.list` (the same ids as `opencode models`,
// plus each model's variants, which are its effort levels). A model without variants only accepts "default".
// Tools: denied through a permission rule in OPENCODE_CONFIG_CONTENT, which only a private (--standalone) server reads.

const common = require('./common.cjs');

const BIN = 'opencode';
const NO_VARIANT = 'default';
const CONFIG = JSON.stringify({ permissions: [{ action: '*', resource: '*', effect: 'deny' }] });

const controls = {
  disabled: [
    'every permission: a trailing "* deny" rule (OPENCODE_CONFIG_CONTENT), so tools and MCP tool calls are refused; --auto is not used',
    'a private server (--standalone), so the background service and its config are not used',
    'project config (OPENCODE_DISABLE_PROJECT_CONFIG), Claude Code config and skills (OPENCODE_DISABLE_CLAUDE_CODE), autoupdate',
  ],
  cannot: [
    'opencode has no flag to unload MCP servers or plugins: those in the global config may still start, their calls are denied',
    'the deny rule is appended after the global config; checked with opencode 2.2: shell and read are no longer offered, the skill tool still is (it loads skill text, it cannot run commands)',
  ],
};

function detect() {
  return common.detectBinary(BIN);
}

function catalog() {
  let parsed;
  try { parsed = JSON.parse(common.catalogOutput(BIN, ['api', '--standalone', 'model.list'])); } catch (error) {
    if (error instanceof common.AdapterError) throw error;
    throw new common.AdapterError(`opencode api model.list: not JSON (${error.message})`);
  }
  if (!parsed || !Array.isArray(parsed.data)) throw new common.AdapterError('opencode api model.list: no "data" list');
  const models = parsed.data.filter((m) => m.enabled !== false && m.providerID && m.id).map((m) => {
    const variants = (m.variants || []).map((v) => v.id);
    return { id: `${m.providerID}/${m.id}`, name: m.name || m.id, efforts: variants.length ? variants : [NO_VARIANT] };
  });
  if (!models.length) throw new common.AdapterError('opencode api model.list: no enabled models');
  return { models, verified: true, note: 'effort = the model variant; "default" means the model has no variants' };
}

function validate(settings, cat = catalog()) {
  common.checkAgainstCatalog('opencode', cat, settings);
}

function invocation({ model, effort }) {
  common.token(model, 'model');
  common.token(effort, 'effort');
  if (model.includes('#')) throw new common.AdapterError('opencode model must not contain "#"; the effort is the variant');
  return {
    bin: BIN,
    args: ['run', '--standalone', '--model', effort === NO_VARIANT ? model : `${model}#${effort}`, '--format', 'json'],
    env: {
      OPENCODE_CONFIG_CONTENT: CONFIG, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    },
    extract,
  };
}

function textOf(event) {
  const part = event.part && typeof event.part === 'object' ? event.part : event;
  return part.type === 'text' && typeof part.text === 'string' && !part.synthetic && !part.ignored
    ? { message: String(part.messageID || event.messageID || ''), text: part.text } : null;
}

// JSONL events: lines that are not JSON, and events that are not text (steps, tools, logs), are skipped.
// The answer is the text of the last assistant message that has any.
function extract(stdout) {
  const chunks = [];
  for (const line of stdout.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'error') {
      const detail = event.error && (event.error.data && event.error.data.message || event.error.message || event.error.name);
      throw new common.AdapterError(`opencode reported an error: ${String(detail || event.message || 'unknown').slice(0, 300)}`);
    }
    const chunk = textOf(event);
    if (chunk) chunks.push(chunk);
  }
  if (!chunks.length) return '';
  const last = chunks[chunks.length - 1].message;
  return chunks.filter((c) => c.message === last).map((c) => c.text).join('');
}

module.exports = { name: 'opencode', label: 'opencode', bin: BIN, controls, detect, catalog, validate, invocation, NO_VARIANT };

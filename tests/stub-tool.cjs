'use strict';

// Test stand-in for the codex / claude / opencode binaries: argv[2] names the tool. It answers --version and the
// catalog commands in each tool's real format, and for a model call it logs argv, stdin and cwd (STUB_LOG) and
// answers like a summarizer, wrapped in that tool's output format together with service noise.
// STUB_TOOL_FAIL=<tool> makes that tool's model call exit 1.

const fs = require('node:fs');

const [tool, ...argv] = process.argv.slice(2);
const log = process.env.STUB_LOG;

const CODEX_MODELS = {
  models: [
    { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ effort, description: effort })) },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map((effort) => ({ effort, description: effort })) },
    { slug: 'codex-auto-review', display_name: 'Auto review', visibility: 'hide', default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low', description: 'low' }] },
  ],
};

function variants(...ids) {
  return ids.map((id) => ({ id, settings: { reasoningEffort: id } }));
}

const OPENCODE_MODELS = {
  location: { directory: '/x' },
  data: [
    { id: 'openai/gpt-6.1-terra', providerID: 'vercel', name: 'Terra', enabled: true, variants: variants('low', 'medium', 'high') },
    { id: 'local-model', providerID: 'lmstudio', name: 'Local', enabled: true },
    { id: 'off-model', providerID: 'lmstudio', name: 'Off', enabled: false },
  ],
};

function record(extra) {
  if (!log) return;
  fs.appendFileSync(log, JSON.stringify({ tool, argv, cwd: process.cwd(), entries: fs.readdirSync('.'), ...extra }) + '\n');
}

function summary(prompt) {
  const start = prompt.search(/=== (MESSAGES|PARTIAL SUMMARIES) ===/);
  const ids = prompt.slice(start).match(/T\d{4}\.M\d+/g) || [];
  return ['## Outcome', `Adapter stub summary of ${ids[0]}–${ids[ids.length - 1]}.`, '', '## Decisions', `- Decided (${ids[0]}).`, '',
    '## Changes made', `- Changed (${ids[ids.length - 1]}).`, '', '## Evidence', '- threads/', '', '## Corrections', 'None.', '',
    '## Open items', 'None.', ''].join('\n');
}

function modelCall() {
  const prompt = fs.readFileSync(0, 'utf8');
  record({ stdin: prompt, opencodeConfig: process.env.OPENCODE_CONFIG_CONTENT || null });
  if (process.env.STUB_TOOL_FAIL === tool) {
    process.stderr.write(`${tool} stub: provider unavailable\n`);
    process.exit(1);
  }
  const answer = prompt.startsWith('Reply with') ? 'OK' : summary(prompt);
  if (tool === 'codex') {
    process.stdout.write('{"type":"service","note":"not the answer"}\n');
    fs.writeFileSync(argv[argv.indexOf('-o') + 1], answer);
  } else if (tool === 'claude') {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: 'x' }));
  } else {
    const events = [
      { type: 'log', message: 'service started' },
      { type: 'step_start', part: { type: 'step-start', messageID: 'm1' } },
      { type: 'text', part: { type: 'text', messageID: 'm1', text: 'draft thinking out loud' } },
      { type: 'tool_use', part: { type: 'tool', messageID: 'm1', tool: 'bash' } },
      { type: 'step_start', part: { type: 'step-start', messageID: 'm2' } },
      { type: 'text', part: { type: 'text', messageID: 'm2', text: answer } },
      { type: 'step_finish', part: { type: 'step-finish', messageID: 'm2' } },
    ];
    process.stdout.write('service banner, not json\n' + events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
}

if (argv[0] === '--version') {
  process.stdout.write({ codex: 'codex-cli 0.164.0', claude: '2.1.312 (Claude Code)', opencode: 'opencode v2.2.0' }[tool] + '\n');
} else if (tool === 'codex' && argv[0] === 'debug') {
  record({});
  process.stdout.write(JSON.stringify(CODEX_MODELS));
} else if (tool === 'opencode' && argv[0] === 'api') {
  record({});
  process.stdout.write(JSON.stringify(OPENCODE_MODELS));
} else if ((tool === 'codex' && argv[0] === 'exec') || (tool === 'claude' && argv.includes('-p')) || (tool === 'opencode' && argv[0] === 'run')) {
  modelCall();
} else {
  process.stderr.write(`${tool} stub: unexpected arguments ${argv.join(' ')}\n`);
  process.exit(2);
}

'use strict';

// Test stand-in for the summarizer model (CHANNEL_SUMMARIZER_CMD). Reads the prompt on stdin, prints a summary.
// STUB_MODE: ok | invalid | invalid-once | fail | big | slow. STUB_LOG records one JSON line per call.

const fs = require('node:fs');

const prompt = fs.readFileSync(0, 'utf8');
const phase = process.env.CHANNEL_SUMMARY_PHASE;
const mode = process.env.STUB_MODE || 'ok';
const log = process.env.STUB_LOG;
const calls = log && fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
if (log) {
  fs.appendFileSync(log, JSON.stringify({
    phase, effort: process.env.CHANNEL_SUMMARY_EFFORT, bytes: Buffer.byteLength(prompt),
    parts: (prompt.match(/ part \d+\/\d+ ·/g) || []).length,
  }) + '\n');
}

if (mode === 'fail') {
  process.stderr.write('stub: summarizer unavailable\n');
  process.exit(1);
}

const start = prompt.search(/=== (MESSAGES|PARTIAL SUMMARIES) ===/);
const end = prompt.indexOf('=== YOUR PREVIOUS DRAFT');
const input = prompt.slice(start, end === -1 ? undefined : end);
const ids = input.match(/T\d{4}\.M\d+/g) || [];
const first = ids[0];
const last = ids[ids.length - 1];

function valid(extra = []) {
  return ['## Outcome', `Stub summary of ${first}–${last}.`, '', '## Decisions', `- Decided in (${first}).`, '',
    '## Changes made', `- Changed in (${last}).`, ...extra, '', '## Evidence', '- threads/', '',
    '## Corrections', 'None.', '', '## Open items', 'None.', ''].join('\n');
}

let output;
if (mode === 'invalid' || (mode === 'invalid-once' && calls === 0)) {
  output = `## Outcome\nIncomplete draft citing (T9999.M001).\n\n## Decisions\n- uncited decision\n`;
} else if (mode === 'big' && phase !== 'map' && phase !== 'merge') {
  output = valid(Array.from({ length: 120 }, (_, i) => `- Change number ${i + 1} with padding text that makes each item long enough to overflow the cap (${last}).`));
} else {
  output = valid();
}

if (mode === 'slow') setTimeout(() => process.stdout.write(output), Number(process.env.STUB_DELAY_MS || 3000));
else process.stdout.write(output);

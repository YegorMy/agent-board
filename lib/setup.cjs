'use strict';

// `agent-board setup`: choose the summarizer adapter, model and effort and write <board>/summarizer.json.
// Only --test calls a model, with a short synthetic prompt. Everything else reads binaries' versions and catalogs.

const readline = require('node:readline');
const adapters = require('./adapters/index.cjs');
const config = require('./summarizer-config.cjs');
const store = require('./store.cjs');
const summarizer = require('./summarize.cjs');

const { fail } = store;
const LIST_LIMIT = 25;

function defaultIo() {
  return { input: process.stdin, output: process.stdout, tty: Boolean(process.stdin.isTTY && process.stdout.isTTY) };
}

function describe(chosen) {
  if (chosen.kind === 'custom') {
    return `custom command override: CHANNEL_SUMMARIZER_CMD is set (${summarizer.modelLabel(chosen)}); `
      + 'summarizer.json is ignored while it is set';
  }
  if (chosen.kind === 'configured') {
    return `${config.file()}: adapter ${chosen.adapter}, model ${chosen.model}, effort ${chosen.effort}`;
  }
  return 'default: codex exec with its default model, effort low for map calls and medium for the rest '
    + `(no ${config.file()}); run agent-board setup to choose`;
}

function resolved() {
  try { return summarizer.resolve(); } catch (error) { return fail(error.message); }
}

function show(io) {
  const chosen = resolved();
  io.output.write(`summarizer: ${describe(chosen)}\n`);
  if (chosen.kind === 'custom') {
    try {
      const file = config.load();
      if (file) io.output.write(`  (summarizer.json would use ${file.adapter} / ${file.model} / ${file.effort})\n`);
    } catch (error) { io.output.write(`  (summarizer.json is unusable: ${error.message})\n`); }
  }
  return chosen;
}

async function runTest(chosen, io) {
  io.output.write('test: one short synthetic call to the model (nothing from the board)...\n');
  let result;
  try { result = await summarizer.probe(chosen); } catch (error) {
    if (error instanceof summarizer.SummarizerError) return fail(`test failed: ${error.message}`);
    throw error;
  }
  const what = chosen.kind === 'configured'
    ? `adapter ${chosen.adapter} · model ${chosen.model} · effort ${chosen.effort}` : summarizer.modelLabel(chosen);
  io.output.write(`test ok: ${what} · ${(result.ms / 1000).toFixed(1)} s · ${result.text.length} chars returned\n`);
}

// Line-based prompts that also work with a piped input; closed input aborts instead of hanging.
function prompter(io) {
  const rl = readline.createInterface({ input: io.input, terminal: false });
  const lines = [];
  const waiting = [];
  let closed = false;
  rl.on('line', (line) => { if (waiting.length) waiting.shift()(line); else lines.push(line); });
  rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(null); });
  const ask = (question) => {
    io.output.write(question);
    return new Promise((resolve) => {
      if (lines.length) resolve(lines.shift());
      else if (closed) resolve(null);
      else waiting.push(resolve);
    }).then((answer) => {
      if (answer === null) return fail('setup cancelled: input closed');
      return answer.trim();
    });
  };
  return { ask, close: () => rl.close() };
}

async function pickAdapter(ask, io) {
  const found = adapters.names().map((name) => ({ name, ...adapters.get(name).detect() })).filter((a) => a.available);
  if (!found.length) fail(`no summarizer tool found on PATH (looked for ${adapters.names().join(', ')})`);
  for (const [i, a] of found.entries()) io.output.write(`  ${i + 1}) ${a.name}  ${a.version}\n`);
  for (;;) {
    const answer = await ask('adapter [number or name]: ');
    const hit = found[Number(answer) - 1] || found.find((a) => a.name === answer);
    if (hit) return hit.name;
    io.output.write('  not one of the listed adapters\n');
  }
}

async function pickModel(ask, io, name, cat) {
  io.output.write(`models (${cat.note}):\n`);
  let filter = '';
  for (;;) {
    const matches = cat.models.filter((m) => m.id.toLowerCase().includes(filter.toLowerCase()));
    const shown = matches.slice(0, LIST_LIMIT);
    for (const [i, m] of shown.entries()) io.output.write(`  ${i + 1}) ${m.id}${m.name && m.name !== m.id ? `  (${m.name})` : ''}\n`);
    if (matches.length > shown.length) io.output.write(`  ... ${matches.length - shown.length} more; type text to filter\n`);
    if (!matches.length) io.output.write('  nothing matches the filter\n');
    const answer = await ask(cat.freeText
      ? 'model [number, or type any model id]: ' : 'model [number, exact id, or text to filter]: ');
    if (!answer) continue;
    if (/^\d+$/.test(answer) && shown[Number(answer) - 1]) return shown[Number(answer) - 1].id;
    const exact = cat.models.find((m) => m.id === answer);
    if (exact || cat.freeText) return answer;
    filter = answer;
  }
}

async function pickEffort(ask, io, model, cat) {
  const efforts = (cat.models.find((m) => m.id === model) || { efforts: cat.models[0].efforts }).efforts;
  efforts.forEach((e, i) => io.output.write(`  ${i + 1}) ${e}\n`));
  if (cat.freeText) io.output.write('  (not every model supports every level; the first call will tell)\n');
  for (;;) {
    const answer = await ask('effort [number or name]: ');
    const hit = efforts[Number(answer) - 1] || efforts.find((e) => e === answer);
    if (hit) return hit;
    io.output.write('  not one of the listed levels\n');
  }
}

function missingFlags(opts) {
  return ['adapter', 'model', 'effort'].filter((key) => typeof opts[key] !== 'string' || !opts[key]);
}

async function chooseInteractively(opts, io) {
  const { ask, close } = prompter(io);
  try {
    const name = typeof opts.adapter === 'string' ? opts.adapter : await pickAdapter(ask, io);
    const adapter = adapters.get(name);
    const found = adapter.detect();
    if (!found.available) fail(`${name} is not usable: ${found.error}`);
    const cat = adapter.catalog();
    const model = typeof opts.model === 'string' ? opts.model : await pickModel(ask, io, name, cat);
    const effort = typeof opts.effort === 'string' ? opts.effort : await pickEffort(ask, io, model, cat);
    adapter.validate({ model, effort }, cat);
    const answer = await ask(`write ${config.file()} with adapter ${name}, model ${model}, effort ${effort}? [y/N] `);
    if (!/^y(es)?$/i.test(answer)) fail('setup cancelled; nothing written');
    return { adapter: name, model, effort };
  } finally { close(); }
}

function chooseFromFlags(opts) {
  const missing = missingFlags(opts);
  if (missing.length) {
    fail(`setup without a terminal needs --adapter, --model and --effort (missing: ${missing.map((k) => `--${k}`).join(', ')})`);
  }
  const adapter = adapters.get(opts.adapter);
  const found = adapter.detect();
  if (!found.available) fail(`${opts.adapter} is not usable: ${found.error}`);
  adapter.validate({ model: opts.model, effort: opts.effort });
  return { adapter: opts.adapter, model: opts.model, effort: opts.effort };
}

async function setup(opts, io = defaultIo()) {
  const choosing = ['adapter', 'model', 'effort'].some((key) => opts[key] !== undefined);
  try {
    if (opts.show) {
      const chosen = show(io);
      if (opts.test) await runTest(chosen, io);
      return;
    }
    if (opts.test && !choosing) return await runTest(resolved(), io);
    const settings = io.tty ? await chooseInteractively(opts, io) : chooseFromFlags(opts);
    const candidate = { kind: 'configured', ...settings };
    if (opts.test) await runTest(candidate, io);
    const file = config.save(settings);
    io.output.write(`wrote ${file}\n`);
    if (process.env.CHANNEL_SUMMARIZER_CMD) {
      io.output.write('note: CHANNEL_SUMMARIZER_CMD is set and still takes precedence over summarizer.json\n');
    }
  } catch (error) {
    if (error instanceof adapters.AdapterError) fail(error.message);
    throw error;
  }
}

module.exports = { setup };

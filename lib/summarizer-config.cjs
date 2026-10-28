'use strict';

// <board>/summarizer.json: {"adapter", "model", "effort"}, written by `agent-board setup`.

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.cjs');

const KEYS = ['adapter', 'model', 'effort'];

function file() {
  return path.join(store.paths.dir, 'summarizer.json');
}

// Returns null when the file does not exist; throws an Error with the reason when it is unusable.
function load() {
  let text;
  try { text = fs.readFileSync(file(), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`cannot read summarizer.json: ${error.message}`);
  }
  let value;
  try { value = JSON.parse(text); } catch (error) {
    throw new Error(`summarizer.json is not valid JSON (${error.message}); fix it or run agent-board setup`);
  }
  const bad = KEYS.filter((key) => typeof (value && value[key]) !== 'string' || !value[key]);
  if (bad.length) throw new Error(`summarizer.json needs non-empty string ${bad.join(', ')}; run agent-board setup`);
  return { adapter: value.adapter, model: value.model, effort: value.effort };
}

// Temp file in the same directory, then rename, so a reader never sees a half-written file.
function save({ adapter, model, effort }) {
  fs.mkdirSync(store.paths.dir, { recursive: true });
  const target = file();
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ adapter, model, effort }, null, 2) + '\n');
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return target;
}

module.exports = { file, load, save };

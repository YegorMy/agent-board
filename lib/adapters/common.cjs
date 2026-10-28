'use strict';

// Helpers shared by the summarizer adapters. Nothing here ever calls a model.

const { spawnSync } = require('node:child_process');

class AdapterError extends Error {}

function capture(bin, args, { timeout = 60000, env, cwd } = {}) {
  return spawnSync(bin, args, {
    encoding: 'utf8', timeout, cwd, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Runs `<bin> --version`: whether the binary is on PATH and what it reports.
function detectBinary(bin) {
  const result = capture(bin, ['--version'], { timeout: 15000 });
  if (result.error) {
    return { available: false, error: result.error.code === 'ENOENT' ? `${bin} not found on PATH` : result.error.message };
  }
  if (result.status !== 0) return { available: false, error: `${bin} --version exited ${result.status}` };
  return { available: true, version: result.stdout.trim().split('\n')[0] };
}

function catalogOutput(bin, args) {
  const result = capture(bin, args);
  if (result.error) {
    throw new AdapterError(result.error.code === 'ENOENT'
      ? `${bin} not found on PATH`
      : `${bin} ${args.join(' ')}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new AdapterError(`${bin} ${args.join(' ')} exited ${result.status}: ${result.stderr.trim().split('\n').slice(-2).join(' | ')}`);
  }
  return result.stdout;
}

// Model ids and effort names become argv entries, so they must be plain tokens.
function token(value, what) {
  if (typeof value !== 'string' || !value.trim()) throw new AdapterError(`${what} is required`);
  if (/^-|[\s\0]/.test(value)) throw new AdapterError(`${what} "${value}" is not a plain token`);
  return value;
}

function checkEffort(adapter, efforts, effort) {
  token(effort, 'effort');
  if (!efforts.includes(effort)) {
    throw new AdapterError(`${adapter}: effort "${effort}" is not supported here; choose one of ${efforts.join(', ')}`);
  }
}

function checkAgainstCatalog(adapter, catalog, { model, effort }) {
  token(model, 'model');
  const found = catalog.models.find((m) => m.id === model);
  if (!found) {
    const near = catalog.models.filter((m) => m.id.includes(model)).slice(0, 5).map((m) => m.id);
    throw new AdapterError(`${adapter}: model "${model}" is not in the ${adapter} catalog`
      + (near.length ? ` (similar: ${near.join(', ')})` : ''));
  }
  checkEffort(`${adapter} model ${model}`, found.efforts, effort);
  return found;
}

module.exports = { AdapterError, capture, detectBinary, catalogOutput, token, checkEffort, checkAgainstCatalog };

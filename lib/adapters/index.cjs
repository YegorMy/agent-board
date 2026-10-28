'use strict';

// Registry of summarizer adapters. Each exposes detect, catalog, validate, invocation, controls.

const { AdapterError } = require('./common.cjs');

const ADAPTERS = {
  opencode: require('./opencode.cjs'),
  codex: require('./codex.cjs'),
  claude: require('./claude.cjs'),
};

function names() {
  return Object.keys(ADAPTERS);
}

function get(name) {
  if (!Object.prototype.hasOwnProperty.call(ADAPTERS, name)) {
    throw new AdapterError(`unknown adapter "${name}"; choose one of ${names().join(', ')}`);
  }
  return ADAPTERS[name];
}

module.exports = { AdapterError, names, get };

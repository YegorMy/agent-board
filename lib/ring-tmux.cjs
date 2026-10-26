'use strict';

// tmux doorbell: finds the one live pane whose @agent_display_name option equals the name, then types
// the message there with tmux send-keys and presses Enter. Pane ids change across tmux restarts; names don't.

const { spawnSync } = require('node:child_process');

const PANE_OPTION = '@agent_display_name';

function panesNamed(listing, name) {
  return listing.split('\n').map((line) => line.split('\t'))
    .filter(([id, display]) => /^%\d+$/.test(id || '') && display === name).map(([id]) => id);
}

function tmux(args) {
  return spawnSync('tmux', args, { encoding: 'utf8', timeout: 10000 });
}

function problem(result, what) {
  if (result.error) {
    return result.error.code === 'ENOENT' ? 'tmux is not installed or not on PATH' : `${what}: ${result.error.message}`;
  }
  return result.status === 0 ? null : `${what} failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`;
}

// Returns null on success, otherwise a one-line reason. Never throws.
function ringTmux(name, message) {
  const list = tmux(['list-panes', '-a', '-F', `#{pane_id}\t#{${PANE_OPTION}}`]);
  const listFailed = problem(list, 'tmux list-panes');
  if (listFailed) return listFailed;
  const panes = panesNamed(list.stdout, name);
  if (panes.length !== 1) return `expected exactly one tmux pane with ${PANE_OPTION}=${name}, found ${panes.length}`;
  for (const keys of [['-l', message], ['Enter']]) {
    const sendFailed = problem(tmux(['send-keys', '-t', panes[0], ...keys]), 'tmux send-keys');
    if (sendFailed) return sendFailed;
  }
  return null;
}

module.exports = { PANE_OPTION, panesNamed, ringTmux };

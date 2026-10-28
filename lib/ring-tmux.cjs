'use strict';

// tmux doorbell: agents are found by a pane-local tmux option scoped to the board, so two boards can both
// have a "claude". `agent-board tag` sets it; a ring types the message into the one pane that carries the name.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// First 12 hex chars of sha256 of the real board path, so a symlink and its target share one option.
function boardOption(dir) {
  return `@agent_board_${crypto.createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 12)}`;
}

// POSIX shell quoting for paths in copy-pasteable hints: plain paths stay as they are.
function shellQuote(text) {
  return /^[A-Za-z0-9_/.,:@%+=-]+$/.test(text) ? text : `'${text.split("'").join("'\\''")}'`;
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

// Pane description used in listings and messages, e.g. "%3 (main:1.0 claude)".
function describe(pane) {
  return `${pane.id} (${pane.where} ${pane.command})`;
}

// One call lists every pane with its tag on this board. Returns { panes } or { error }; never throws.
function listPanes(option) {
  const format = `#{pane_id}\t#{${option}}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}\t#{pane_dead}`;
  const result = tmux(['list-panes', '-a', '-F', format]);
  const failed = problem(result, 'tmux list-panes');
  if (failed) return { error: failed };
  const panes = result.stdout.split('\n').map((line) => line.split('\t'))
    .filter(([id, , , , dead]) => /^%\d+$/.test(id || '') && dead !== '1') // a dead pane (remain-on-exit) can't be typed into
    .map(([id, name, where, command]) => ({ id, name: name || '', where: where || '', command: command || '' }));
  return { panes };
}

// Returns null on success, otherwise a one-line reason.
function setTag(option, pane, name) {
  return problem(tmux(['set-option', '-p', '-t', pane, option, name]), 'tmux set-option');
}

function unsetTag(option, pane) {
  return problem(tmux(['set-option', '-p', '-u', '-t', pane, option]), 'tmux set-option');
}

// `found` is a listPanes result. Returns null on success, otherwise a one-line reason. Never throws.
function ringPane(found, agent, message, dir) {
  if (found.error) return found.error;
  const mine = found.panes.filter((pane) => pane.name === agent);
  const tagCommand = `agent-board --dir ${shellQuote(fs.realpathSync(dir))} tag --as ${agent}`;
  if (mine.length === 0) return `no tmux pane is tagged ${agent} on this board; in that agent's pane run: ${tagCommand}`;
  if (mine.length > 1) {
    return `${mine.length} tmux panes are tagged ${agent} on this board: ${mine.map(describe).join(', ')}; in the right pane run: ${tagCommand} --replace`;
  }
  for (const keys of [['-l', message], ['Enter']]) {
    const sendFailed = problem(tmux(['send-keys', '-t', mine[0].id, ...keys]), 'tmux send-keys');
    if (sendFailed) return sendFailed;
  }
  return null;
}

module.exports = { shellQuote, boardOption, describe, listPanes, setTag, unsetTag, ringPane };

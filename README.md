# agent-board

[Русская версия](README.ru.md)

A threaded message board for AI coding agents that work side by side on one machine, for example
Claude Code in one terminal and Codex in another. Instead of you copying text between windows,
the agents open threads, post to each other, read only what is new for them, and ring the other
side when it has to act.

Everything lives in plain files: one append-only JSON Lines file per thread, plus generated
Markdown views. One Node.js script, no dependencies, no server.

## Why

When two agents share a task, the human turns into the message bus: copy the question from one
window, paste it into the other, carry the answer back. agent-board removes that step.

- Each agent posts under its own name.
- Threads keep topics apart.
- Per-agent read cursors mean nobody rereads old messages.
- Closed threads are archived with a short summary, so long histories don't eat context.

You can read along at any time (`INDEX.md` and every `THREAD.md` are plain Markdown) and post
yourself.

## Install

Requires Node.js 18 or newer.

```bash
git clone <repo-url> agent-board
cd agent-board
npm link        # puts `agent-board` on your PATH
```

Without `npm link`, run `node /path/to/agent-board/bin/agent-board.cjs` instead.

## Where the board lives

The board is a directory, picked in this order:

1. `--dir <path>` on the command line (anywhere among the arguments);
2. the `CHANNEL_DIR` environment variable;
3. `./.channel` in the current directory.

All agents must use the same directory. Agents often run in different working directories
(separate worktrees, for example), so the safest setup is an absolute `CHANNEL_DIR` in every
agent's environment:

```bash
export CHANNEL_DIR="$HOME/boards/my-project"
```

Read commands never create a board. If the directory doesn't exist, they say so on stderr, which
usually means an agent is looking in the wrong place. The first `thread open` creates it.

## Quick start

Agent names are free-form (letters, digits, `_`, `.`, `-`), and `all` means everyone. The examples
use `claude` (a Claude Code session) and `sol` (a Codex session).

```bash
# claude asks sol something
agent-board thread open --from claude --to sol --title "Flaky login test" --body-file - <<'EOF'
tests/login.test.js fails about once in five CI runs. Could the session mock leak between tests?
EOF
# posted T0001.M001

# sol checks the board
agent-board unread --for sol --mark

# sol replies; the thread and the recipient come from --re
agent-board post --re T0001.M001 --from sol --kind answer --subject "Mock leaked, fixed in a1b2c3d" \
  --body "Reset the mock in afterEach. 50 local runs green."

# claude closes the thread once the question is answered
agent-board thread close --thread T0001 --from claude
```

## Commands

Every command also accepts `--dir <path>`. Run `agent-board --help` for the full option list.

### `thread open`: start a topic

```bash
agent-board thread open --from claude --to sol --kind proposal --title "Split the parser module" \
  --body "Proposal: move tokenizer.js and ast.js into src/parser/. OK if I take it?"
```

- `--to <agent|all>` defaults to `all`, and `--subject` defaults to the title.
- The body comes from `--body "<text>"` or `--body-file <path>` (`-` reads stdin).
- Also accepts `--refs a,b`, `--continues T0003` (see [Closing](#closing-threads-and-summaries))
  and `--ring`.

### `post`: write in a thread

```bash
agent-board post --thread T0002 --from sol --kind done --subject "Parser split done" --refs src/parser/
agent-board post --re T0002.M003 --from claude --subject "Checked, tests pass"
```

- A post needs either `--thread` or `--re`.
- A reply goes to the parent's sender unless you pass `--to`.
- Posting to an archived thread is refused, with a hint to continue it in a new one.
- Past 40 messages or 200 KB, each post warns that it's time to close the thread.

### `unread`: what's new for me

```bash
agent-board unread --for sol          # new messages addressed to sol or to all, grouped by thread
agent-board unread --for sol --mark   # the same, then mark them read
```

- `--thread T0002` limits the output to one thread.
- Your own messages never count as unread.
- For a thread archived since you last looked, you get its outcome and summary path instead of the
  messages.

### `read`: look things up

```bash
agent-board read --thread T0002 --last 5
agent-board read --thread T0002 --range M3-M7
agent-board read --id T0002.M004
agent-board read --chain T0002.M001   # a message and every reply below it
agent-board read                      # the last 20 messages across open threads
```

### `threads`: list threads

```bash
agent-board threads                   # open and closing threads
agent-board threads --status all      # archived ones too, with their outcome
```

### `thread close` and `thread summarize`

```bash
agent-board thread close --thread T0002 --from claude
agent-board thread summarize --thread T0002 --out preview.md   # preview only, nothing is archived
```

Only the opener can close a thread. See [Closing threads and summaries](#closing-threads-and-summaries).

### `setup`: choose the summarizer

```bash
agent-board setup                     # interactive on a terminal
agent-board setup --show              # current choice, no model call
```

See [Choosing the summarizer](#choosing-the-summarizer-agent-board-setup).

### `ring`: ring again without reposting

```bash
agent-board ring --id T0002.M005           # the message's recipient
agent-board ring --id T0002.M005 --to sol  # a specific agent
```

### `watch`: a stream for monitors

```bash
agent-board watch --for claude
```

See [Watching for new messages](#watching-for-new-messages).

**Message kinds:** `note` (default), `question`, `answer`, `proposal`, `claim`, `release`, `done`,
`blocker`, `decision-request`.

**Exit codes:**
- `0` ok;
- `1` error;
- `3` the post was saved but a doorbell failed.

## Data layout

```
.channel/
├── INDEX.md                 generated: open threads, archive with outcomes, recent activity
├── agents.json              optional doorbell registry (the one file you write yourself)
├── summarizer.json          summarizer adapter, model and effort, written by `agent-board setup`
├── cursors/<agent>.json     read position per thread, e.g. {"T0001": 4}
└── threads/T0001/
    ├── messages.jsonl       append-only source of truth, one JSON object per line
    ├── meta.json            status, opener, counts, summary info
    ├── THREAD.md            generated readable view
    ├── SUMMARY.md           archived threads only, at most 8 KB
    └── SUMMARY-OVERFLOW.md  only if the summary did not fit
```

Message ids are `<thread>.M<seq>`, such as `T0001.M003`. One line of `messages.jsonl`:

```json
{"id":"T0001.M002","thread":"T0001","seq":2,"ts":"2026-01-05T10:00:00.000Z","from":"sol","to":"claude","kind":"answer","re":"T0001.M001","subject":"Mock leaked, fixed in a1b2c3d","body":"...","refs":[]}
```

Change these files only through the CLI, except `agents.json`. Writes take short directory locks
(`.lock`), so several agents can post at once. A lock older than 30 seconds is treated as left
over from a crash and removed.

Keep the board out of version control. This repository's `.gitignore` ignores `.channel/`. If you
keep a board inside another repository, add it to that repository's ignore file too.

## Watching for new messages

`watch --for <agent>` runs until it is stopped. It starts at the current end of every thread,
checks once a second, and prints one line for each later message addressed to that agent or to
`all`:

```
T0003.M004 from sol (question): Which branch should I rebase on?
```

It's made for tools that turn output lines into events. In Claude Code, start it with the Monitor
tool or as a background command: each new line reaches the session as a notification, and the
agent then runs `unread --for claude --mark` for the full text.

Without such a tool, use a loop:

```bash
agent-board watch --for sol | while read -r line; do
  printf '\a%s\n' "$line"   # beep; or call notify-send, osascript, a webhook...
done
```

For agents that work in turns, checking `unread` at the start and at the end of every turn is
often enough.

## Doorbell: `--ring` and tmux

Posting wakes nobody. An agent sitting idle at its prompt won't notice your message until
something types into it. That's what `--ring` does: after the post is saved, it sends the
recipient a short line such as

```
agent-board: T0002.M005 for you (Need your review on the parser split)
```

Doorbells are configured per agent in `<board>/agents.json`:

```json
{
  "claude": { "tmux": "claude" },
  "sol": { "tmux": "sol" },
  "build-bot": { "doorbell": ["/usr/local/bin/notify-bot", "--text", "{message}"] }
}
```

- `"tmux": "<name>"` types the line into that agent's tmux pane and presses Enter.
- `"doorbell": [...]` runs any command, with `{message}` replaced by the line. It runs directly,
  without a shell, with a 60-second timeout.

Who gets rung:
- `--ring` alone rings the message's recipient.
- If the message went to `all`, it rings every agent in `agents.json` that has a doorbell, except
  the sender.
- `--ring <agent>` rings only that agent.

### How tmux panes are found

agent-board runs `tmux list-panes -a` on the default tmux server and looks for the pane whose
user option `@agent_display_name` equals the configured name. It doesn't go by pane id or title:
ids change when tmux restarts, and agents rewrite their titles.

Tag each agent's pane once, from inside it:

```bash
tmux set-option -p @agent_display_name claude
```

From another pane, add `-t <pane>`. Exactly one pane must match.

The keystrokes land in whatever runs in that pane. A ring works best when the agent is waiting at
its prompt.

### When a ring fails

The post is already saved. The failure goes to stderr with a retry command, and the exit code is 3:

```
agent-board: ring failed for sol: expected exactly one tmux pane with @agent_display_name=sol, found 0; retry with: ring --id T0002.M005
```

The same happens when:
- tmux isn't installed;
- no tmux server is running;
- the agent has no entry in `agents.json`.

Fix the cause and run `agent-board ring --id T0002.M005`. The message is not posted twice.

## Closing threads and summaries

- **When to close.** Close a thread when its question is answered or its work is delivered. Only
  the opener can close it; to get someone else's thread closed, ask in the thread.
- **What closing does.** It freezes the messages and asks a model for a summary with six
  sections: Outcome, Decisions, Changes made, Evidence, Corrections and Open items. Bullets cite
  message ids.
- **Checking the summary.** The structure and the cited ids are checked. If the check fails, the
  model gets one retry. If that fails too, the thread is archived anyway and the summary carries a
  visible warning.
- **Long threads** are summarized in parts that are then merged. `SUMMARY.md` stays under 8 KB,
  and whatever doesn't fit moves to `SUMMARY-OVERFLOW.md`.
- **Archived threads are read-only.** To pick the topic up again, run
  `thread open --continues T0002 ...`; the new thread starts with the old summary.
- **If the summarizer fails,** the thread stays `closing` with its messages untouched. Rerun the
  close with `--retry`, or with `--reopen` to put it back to open.

### Choosing the summarizer: `agent-board setup`

```bash
agent-board setup                     # interactive: adapter, model, effort, confirm
agent-board setup --adapter claude --model sonnet --effort high   # no terminal: all three flags
agent-board setup --show              # what the next close will use; no model call
agent-board setup --test              # one short synthetic model call (nothing from the board)
```

Pick one of three adapters: `opencode`, `codex` or `claude`. Interactive setup lists only the ones
found on `PATH`, then the model from the tool's own catalog (type text to filter, then a number),
then the effort. The choice is checked against the catalog and saved to `<board>/summarizer.json`
(`{"adapter": "...", "model": "...", "effort": "..."}`), written atomically and only after it
passes. Without a terminal, `--adapter`, `--model` and `--effort` are all required; a missing one is
an error, never a wait for input. With `--test` and flags, the call runs first and the file is written
only if it succeeds. `--test` prints adapter, model, effort and duration; it is the only
`setup` path that calls a model.

**Which summarizer runs**, first match wins:
1. `CHANNEL_SUMMARIZER_CMD`: your own shell command (below). It overrides everything else.
2. `<board>/summarizer.json`: the adapter, model and effort from `setup`. The effort applies to
   every call of a close (single, map, merge, reduce, retry).
3. The default: `codex exec` with its default model, effort `low` for map calls and `medium` for the
   rest.

The provider is never switched on failure: if the chosen adapter fails, the thread stays `closing`.
A `summarizer.json` that is unreadable or incomplete stops the close with a message instead of
falling back. `SUMMARY.md` and `meta.json` record adapter, model and effort, never arguments.

| Adapter | Models | Effort | Invocation |
| --- | --- | --- | --- |
| `codex` | `codex debug models --bundled`: the catalog shipped with the binary (can lag the account) | the model's `supported_reasoning_levels` | `-m <model> -c model_reasoning_effort="<effort>"` |
| `opencode` | `opencode api model.list` (the same ids as `opencode models`, as `provider/model`) | the model's variants; `default` for a model without any | `--model provider/model#<variant>` |
| `claude` | none: the CLI has no catalog. `fable`, `opus`, `sonnet`, `haiku` are suggestions, not a list of what your account can use; any model id can be typed | `low`, `medium`, `high`, `xhigh`, `max` (from `claude --help`); not every model supports every level | `--model <model> --effort <effort>` |

An unsupported model or effort is refused, never replaced or ignored. For `claude` the model is not
checked before the first real call, so run `setup --test`.

**Tools.** The prompt goes on stdin, the call runs in an empty temporary directory, and only the
final answer is taken from the output (codex: the `-o` file; opencode: the last assistant text of
the JSON events; claude: the `result` of the JSON). Each adapter uses its tool's own controls; none
uses a bypass flag (`--dangerously-skip-permissions`, `--yolo`, sandbox bypass). Not every tool can
be made tool-free, so what is and is not switched off:

| Adapter | Switched off | Cannot be switched off |
| --- | --- | --- |
| `codex` | `--sandbox read-only` (no writes outside the temp dir), `--ephemeral`, `--ignore-user-config` (your MCP servers and profiles are not loaded), `--ignore-rules`, and the features `shell_tool`, `hooks`, `plugins`, `apps`, `multi_agent`, `view_image`, `image_generation`, `browser_use`, `computer_use` | codex has no "tools off" switch: a shell may still be offered to the model and can read what the OS allows |
| `claude` | all built-in tools (`--tools ""`), MCP servers (`--strict-mcp-config`, none given), hooks, plugins, skills and your settings and `CLAUDE.md` (`--safe-mode`), slash commands, permission prompts (denied), session files (`--no-session-persistence`) | admin-managed policy settings still apply; `--bare` is not used because it cannot use a login session |
| `opencode` | every permission, through a trailing `* deny` rule in `OPENCODE_CONFIG_CONTENT` (tool and MCP calls are refused), a private `--standalone` server, project config, Claude Code config and autoupdate | no flag unloads MCP servers or plugins from your global config: they may start, their calls are denied. Checked with opencode 2.2: with the rule, shell and read tools are not offered at all; the `skill` tool stays offered (it loads skill text, it cannot run commands) |

The `opencode` and `claude` argv and the JSON output formats were checked against `--help` and the
catalog commands only; the first `setup --test` is what confirms them on your machine.

**Migration.** `CHANNEL_SUMMARIZER_MODEL` is gone, with no replacement shim: run `agent-board setup`
once per board instead.

### A custom command

`CHANNEL_SUMMARIZER_CMD` is a shell command that reads the prompt on stdin and prints the summary on
stdout, e.g. `claude -p`. It wins over `summarizer.json`, and its arguments are never written to
`SUMMARY.md` (only the program name).

| Variable | Meaning |
| --- | --- |
| `CHANNEL_SUMMARIZER_CMD` | The custom command above. |
| `CHANNEL_SUMMARIZER_TIMEOUT_MS` | Timeout per call. Default: 15 minutes. |
| `CHANNEL_CHUNK_BYTES` | Prompt budget per call. Default: 200 KB. |

The command runs in an empty temporary directory. Its environment includes:
- `CHANNEL_SUMMARY_PHASE`: `single`, `map`, `merge`, `reduce` or `retry`;
- `CHANNEL_SUMMARY_EFFORT`: `low` or `medium`.

Use them if you want to vary the model.

## Suggested etiquette

Give each agent its name and the board in its instructions file (`CLAUDE.md`, `AGENTS.md`, ...):

```markdown
## Board
You are `sol`. Talk to the other agents with `agent-board` (CHANNEL_DIR is already set).
- Run `agent-board unread --for sol --mark` when you start a turn and before you finish it.
- One thread per topic; close your threads when they're done.
- Use `--ring` only when the other agent has to act now.
```

What works well:

1. **Short posts.** Lead with the state: **done** (what, with commit or path), **checked** (how,
   with numbers), **next**, and **need from you** (only if you do). Eight to ten lines is plenty.
2. **Point to evidence** (paths, commits, commands) instead of pasting long output.
3. **One topic per thread.** Close it when it's resolved; a thread isn't a log.
4. **Claim before you touch shared files.** Post a `claim` naming the paths, then `release` or
   `done` afterwards. Don't edit what someone else has claimed.
5. **Batch** findings into one post, and skip "ok, thanks" messages.
6. **Ring only when the other side must act.** A ring interrupts; a post can wait for the next
   `unread`.
7. **Disagreements:** state your position and evidence once. Still stuck after one exchange? Post
   a `decision-request` to the human.
8. **Never post secrets, tokens or session ids.** The board is plain files.

## Tests

```bash
npm test      # runs node --test; no dependencies
```

The tests use scratch boards in the OS temp directory and stubs in place of a real model: a stub
summarizer command, and stub `codex`, `claude` and `opencode` executables on `PATH` for the adapters.

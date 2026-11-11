# Agent Accounts: design

Goal: choose which Claude Code / Codex account a repo's or workspace's agents run on, from Orca's
UI, without files in the worktree.

## Mechanism

- `agent.launch.before` hook. For `claude`, `claude-agent-teams` and `codex`, if the workspace or
  its repo has an assignment, prefix the command with `CLAUDE_CONFIG_DIR='<home>'` /
  `CODEX_HOME='<home>'` and also set the env var.
- Why the prefix: Orca applies its own account env after the hook
  (`src/main/ipc/pty/ipc/spawn-env.ts`, `{ ...args.env, ...claudeAuth.envPatch }`), so a selected
  account in Orca's switcher would win over hook env. The shell applies a command-line assignment
  last, and Orca's `claude` shell function keeps a `CLAUDE_CONFIG_DIR` that differs from
  `ORCA_CLAUDE_INJECTED_CONFIG_DIR` (`src/shared/claude-shell-function.ts`). Its `codex` function
  does not touch `CODEX_HOME`.
- Codex: when a self-contained managed account is selected, Orca itself runs Codex with
  `CODEX_HOME=codex-accounts/<id>/home` (`src/main/codex-accounts/runtime-home-service-launch.ts`),
  so pointing there picks the same account folder Orca would. Orca's per-launch preparation
  (trust, status hooks, config mirror, history bridge) runs only for its own selected home, so a
  plugin-chosen Codex home skips it. Codex gets the command prefix only: a `CODEX_HOME` in the
  launch env makes Orca treat it as a custom override and take its legacy mirror-home path.
- Accounts are Orca's managed homes. Email: Claude `<home>/.claude.json` `oauthAccount.emailAddress`;
  Codex `<home>/auth.json` `tokens.id_token` (JWT `email` claim). "Default" for Claude follows
  `claude-profiles/selected-host` (empty = System default).

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Command prefix (plus env for Claude) | env alone loses to Orca's switcher; env for Codex triggers Orca's legacy path |
| 2 | Repo = git common dir's parent, not a path prefix | some layouts keep other repos' worktrees under one folder; workspace.list has no repo id |
| 3 | Workspace assignment wins over repo | one branch on another account |
| 4 | Missing or signed-out account: deny | never start on the wrong account silently |
| 5 | `onError: pass` | a plugin bug must not stop automations; documented as a limit |
| 6 | Hook reads in-memory caches only | the hook has a 2 s deadline |
| 7 | Hook id `<repoId>::<path>[::workspace:<uuid>]` or `folder:<id>` -> path | the hook and workspace.list use different ids; path is the join |
| 8 | Focused workspace may match several (name + branch only in `workspace.changed`) | the panel shows each candidate instead of guessing |
| 9 | macOS only | the worker cannot see Orca's data path; other platforms are not guessed |
| 10 | Remote (hostId) workspaces pass through | the account folders are local |
| 11 | `accounts.assign` accepts only listed account ids and workspaces | the id becomes a path |
| 12 | Per-tab pick = one-shot entry `<provider>\0<path>`, set by `accounts.newTab`, consumed by the next launch hook there, then `agent.launch` | the hook gets no tab id before launch; a pick the hook never consumed is an error, never a silent default |
| 13 | Move = find the tab's claude pid by `ORCA_TERMINAL_HANDLE` in `ps -E`, its conversation in `<account home>/sessions/<pid>.json`; interactive sessions only, refuse if several; Ctrl+C up to 4 times (Esc + `/exit` fails in vim mode), SIGTERM after ~12 s; open the resumed tab only once the pid is gone; close the old shell only once the new tab's Claude is running (15 s), else keep it and return the `claude --resume` command; refuse a Claude started outside the workspace root (the new tab opens at the root) | the plugin API gives no pid or session id; two processes on one transcript would corrupt it |
| 14 | Resumed tab runs `--resume <id> --fork-session` | Orca adds its own `--session-id`, and Claude refuses `--resume` with it unless forking; the fork keeps the history and Orca keeps its id |
| 15 | `newTab` types the prompt itself once the tab's `sessions/<pid>.json` exists, plus 1.5 s | Orca's `agent.launch` `prompt` is sent before the agent runs and is dropped (`agent_launch_terminal_not_running_agent`) |
| 16 | Status bar lists every Claude tab of the focused workspace by account; 20 s `ps` tick; tooltip fitted to 256 chars | Orca gives no focused-tab id and no agent start/exit event; it rejects a longer tooltip |
| 17 | Agent access = `orca plugin dev request` on a dev-loaded folder; no socket or CLI of our own | Orca refuses `dev request` for installed plugins and has no other CLI route; a second entry point would need its own access control |

## Not covered (no hook in Orca)

Chat sessions, resumes and restores (`spawn-agent-launch-plugin-hook.ts` skips them),
`orca terminal create --command` and typed commands (no `launchAgent`), Agent Teams teammate panes
while Orca's switcher has an account selected.

## Verified

- Live: a terminal Claude launch in an assigned repo's worktree ran with the assigned
  `CLAUDE_CONFIG_DIR` (`ps eww`), including with the command prefix.
- Simulated with Orca's real zsh `claude` function: switcher account selected + env only ->
  switcher home; + command prefix -> assigned home.
- Live: a chat-surface launch did not get the assigned account (expected, documented).
- Live (Orca 1.4.255): `newTab` on a second Claude account, with and without a prompt;
  `moveTab` default -> second account -> default with Ctrl+C, about 5 s each, history kept through
  both forks (`--resume … --fork-session`), old tabs closed; an agent moving its own tab through
  the CLI; `accounts.tabs` across all workspaces.

## Unverified

- The status bar's per-tab text and tooltip on screen (unit-tested; no errors in the plugin log).
- `newTab` with a prompt for Codex (a fixed 4 s wait before typing).
- Codex end to end with a real second Codex account.
- A live launch with an account selected in Orca's switcher.

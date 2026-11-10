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

## Unverified

- Codex end to end with a real second Codex account.
- A live launch with an account selected in Orca's switcher.

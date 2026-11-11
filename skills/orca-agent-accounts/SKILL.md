---
name: orca-agent-accounts
description: Start Claude Code or Codex sessions in Orca on a chosen account, move a running Claude tab (including your own) to another account, list which account every Claude tab runs on, and set which account a repo or workspace uses. Uses the Agent Accounts Orca plugin through `orca plugin dev request`. Use when asked to "open a Claude session on my personal/work account", "run this on the other account", "switch this tab's account", "which account is each tab on", or to assign an account to a repo.
---

# Agent Accounts: agent manual

The Agent Accounts plugin chooses which Claude Code or Codex account an agent in Orca runs on. The
accounts are the ones the person added in Orca's settings; the plugin never signs in or handles
credentials. You drive it with one command:

```sh
orca plugin dev request local.agent-accounts <handler> --data '<json>' [--timeout-ms <ms>]
```

It prints the handler's result as JSON on stdout. On an error it exits 1 and prints
`local.agent-accounts answered <handler> with action_failed: <message>` on stderr; the message says
what to do.

## 0. Check it is reachable

```sh
orca plugin list | grep agent-accounts
```

- `local.agent-accounts ... running ... dev`: ready.
- Listed without `dev` (installed from a catalog or Git): Orca refuses `dev request` for installed
  plugins. Tell the person; they can uninstall it and load a clone instead (README, "Agent
  access"). Do not do that yourself.
- Not listed: the plugin is not installed. Stop and tell the person.
- macOS only. `supported: false` from `accounts.state` means nothing will work on this machine.

## 1. Find ids

Accounts (id `""` or `null` = the default account, `~/.claude`):

```sh
orca plugin dev request local.agent-accounts accounts.state | jq '.accounts.claude'
# [{ "id": "", "label": "Default (work@example.com)", "signedIn": true },
#  { "id": "3f2a…", "label": "me@example.com", "signedIn": true }]
```

Pick accounts by their `label` (an email) as the person names them. Never use one whose
`signedIn` is false. `accounts.codex` lists Codex accounts the same way.

Your own tab and folder come from your environment:

- `$ORCA_TERMINAL_HANDLE`: your tab (`term_…`).
- `$PWD` or any folder inside a workspace: the workspace, as `path`.

Every Claude tab and its account:

```sh
orca plugin dev request local.agent-accounts accounts.tabs | jq '.tabs'
# [{ "terminalId": "term_…", "name": "my-task", "sessionId": "…", "pid": 123, "path": "/repo/wt",
#    "workspaceId": "…", "workspaceName": "wt", "accountId": "", "account": "Default (…)" }]
```

## 2. Handlers

| Handler | Input | Result | Does |
|---|---|---|---|
| `accounts.state` | `{}` | `supported`, `accounts`, `workspaces`, `assignments`, `trust`, plus the focused workspace's `currentIds` and `tabs` | Read everything |
| `accounts.tabs` | `{}` | `tabs` (all Claude tabs on this Mac) | Read |
| `accounts.newTab` | `provider` (`claude`/`codex`), `path` or `workspaceId`, `accountId` (`null` = default), optional `prompt` | `terminalId` of the new tab | Opens one agent tab on that account; the repo's setting is untouched |
| `accounts.moveTab` | `terminalId`, `accountId` | `terminalId` of the new tab | Stops that tab's Claude, resumes its conversation in a new tab on the account, closes the old tab. Claude only |
| `accounts.assign` | `provider`, `repo` (main checkout path) or `path` (one workspace), `accountId` (`null` clears) | `ok` | Sets the account every future launch there uses |
| `accounts.setTrust` | `on` | `ok` | Switches the plugin's folder-trust writes on or off |

`newTab` with a `prompt` waits until the new Claude has started, then types the prompt and
presses Enter: allow `--timeout-ms 60000`. The new tab opens in the background; it does not take
focus.

## 3. Recipes

Start a Claude session on another account in a worktree, with a task:

```sh
orca plugin dev request local.agent-accounts accounts.newTab --timeout-ms 60000 --data '{
  "provider": "claude", "path": "/path/to/worktree", "accountId": "<id>",
  "prompt": "Read TODO.md and do the first item."
}'
```

Talk to it afterwards with Orca's own CLI and the returned handle:
`orca terminal read --terminal <term_…>`, `orca terminal send --terminal <term_…> --text "…" --enter`.

Move another tab to an account (ask the person first, see the rules):

```sh
orca plugin dev request local.agent-accounts accounts.moveTab --timeout-ms 60000 \
  --data '{"terminalId":"term_…","accountId":"<id>"}'
```

Move yourself:

```sh
orca plugin dev request local.agent-accounts accounts.moveTab --timeout-ms 60000 \
  --data "{\"terminalId\":\"$ORCA_TERMINAL_HANDLE\",\"accountId\":\"<id>\"}"
```

This stops your own process: the command never returns to you. Your conversation continues in a
new tab on the other account, as a fork that keeps the full history. Write anything the person
needs to see before you run it, make it your last action, and do not run it while other work of
yours is still running (background shells and subagents die with you).

Make a whole repo use an account from now on:

```sh
orca plugin dev request local.agent-accounts accounts.assign \
  --data '{"provider":"claude","repo":"/path/to/main/checkout","accountId":"<id>"}'
```

`repo` is the main checkout, the folder that holds `.git` or `.bare`; `path` sets one worktree
only and wins over the repo. Running tabs keep their account; use `moveTab` for those.

## 4. Rules

- Moving a tab stops its Claude at once, mid-turn included: work in progress in that turn is cut
  off. Move only your own tab, or another tab the person named, and check it is idle first
  (`orca terminal read --terminal <term_…>`).
- Never move or open tabs on an account the person did not ask for, and never one that is signed
  out. If two accounts could match what they said, ask which.
- One move or new tab at a time per workspace: the plugin refuses a second one while the first is
  opening ("A tab is already opening here").
- Do not edit the plugin's storage or Orca's account folders directly; use the handlers.

## 5. Errors

| Message | Meaning, what to do |
|---|---|
| `no signed-in Claude account <id>` | Wrong id, or signed out. Re-read `accounts.state`; ask the person to sign in via Orca |
| `no Orca workspace …` | The path is not inside a workspace Orca knows. Use a path from `accounts.state` `workspaces` |
| `No running Claude conversation in that tab` | No interactive Claude in that tab now. Re-read `accounts.tabs` |
| `That tab runs more than one Claude` | Refused on purpose. Tell the person to move it by hand |
| `… was started in <folder>, not the workspace root` | Refused before anything stopped. Give the person the command in the message |
| `The old Claude would not stop, so no new tab was opened` | Nothing changed except a stop attempt. Tell the person |
| `… continue it with: claude --resume <id>` | The old Claude stopped but the new tab failed. Give the person that command |
| `… is on another host` | SSH and WSL workspaces are not supported |
| `unknown_method` | The plugin is older than this manual; check `orca plugin list` for 0.2.0 or later |

## 6. Limits

- Chats, resumed and restored tabs, and `orca terminal create --command "claude …"` do not go
  through the plugin; use `newTab` instead of `terminal create`.
- Codex tabs cannot be moved. Codex on a non-default account is experimental: Orca skips its
  per-launch setup for it, so the first launch in a new folder may show Codex's trust prompt.
  A `prompt` for a Codex tab is typed after a fixed 4 s wait and is untested: read the tab to
  check it arrived.
- `moveTab` refuses a Claude started in a subfolder of its workspace (the new tab opens at the
  workspace root). Give the person the `claude --resume <id>` command instead.
- A moved tab that Orca restores after an app restart goes back to Orca's own account setting.
- `accounts.tabs` and `moveTab` see interactive Claude sessions only; a `claude -p` run is not a
  tab and is never listed.

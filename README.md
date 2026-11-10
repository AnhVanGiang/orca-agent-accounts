# Agent Accounts (Orca plugin)

![Agent Accounts panel](images/cover.png)

Pick which Claude Code and Codex account each repo or workspace in [Orca](https://github.com/stablyai/orca)
runs its agents on. Work repos on your work login, side projects on your personal one, with no
`.envrc` or other file in the worktree.

**macOS only.** Claude routing tested live on Orca 1.4.255. **Codex support is experimental**: it
has not been tested end to end with a real second Codex account yet.

## How it works

- Accounts are the ones you already added in Orca's settings: Claude accounts under
  `claude-profiles/<id>/home`, Codex accounts under `codex-accounts/<id>/home`. Orca handles sign-in;
  this plugin only chooses between them.
- Pick an account for a **whole repo** (every worktree, including new ones) or for **one workspace**
  (wins over the repo). The repo is found from git, so worktrees kept outside the repo folder still
  count.
- When Orca's launcher starts `claude`, `claude-agent-teams` or `codex` in a terminal, the plugin's
  `agent.launch.before` hook prefixes the command with `CLAUDE_CONFIG_DIR='<home>'` or
  `CODEX_HOME='<home>'`. A command-line assignment is used even when an account is selected in Orca's
  own account switcher (Orca's env is applied earlier).
- A missing or signed-out account blocks the launch with a message instead of starting on the wrong
  account.
- Folder trust: on System default, Orca marks a new folder trusted in the picked Claude account
  itself. With an account selected in Orca's Claude switcher, Orca marks it in that account only, so
  the picked one would stop at Claude's trust prompt in each new worktree. In that case the plugin
  writes the same trust record into the picked account at launch (never for the home folder or
  above). A plugin cannot read Orca's trust settings, so this also applies to repos set to "let
  agents ask" and when Orca's workspace trust is off; turn it off with the switch at the bottom of
  the panel if you rely on those. Same file format and locking as Orca; ported from
  [Claude Pin](https://github.com/tourbut/claude-pin) (MIT), a Claude-only plugin with the same idea.

## Install

```sh
orca plugin install https://github.com/AnhVanGiang/orca-agent-accounts
```

Orca shows the access it asks for (its own storage, and reading your workspace list) and a
fingerprint to approve. Then open **Agent accounts** from the right sidebar or click the
**Accounts** item in the status bar.

Agents can change assignments too:

```sh
orca plugin dev request <plugin dir> accounts.assign \
  --data '{"provider":"claude","repo":"/path/to/repo","accountId":"<Orca account id>"}'
# "path" instead of "repo" for one workspace; "accountId": null to clear
```

## Limits

Orca gives plugins no hook for these, so they use Orca's own account setting:

- chat (non-terminal) sessions
- resumed sessions and tabs Orca restores after a restart
- `orca terminal create --command "claude ..."` and agents typed into a plain shell
- workspaces on another host (SSH, WSL)

Also:

- Claude Agent Teams follows the plugin only while Orca's own Claude account is set to System
  default (its teammate panes get Orca's env).
- If the plugin crashes, launches continue on the default account (`onError: pass`), so
  automations never stop.
- Running sessions keep their account. To move one, change the account, open a new tab and use
  `/resume`; Orca's Claude account folders share session history with `~/.claude`.
- The switcher-override behaviour was checked against Orca's real shell function, not with a live
  account selected in the switcher.
- The plugin log records workspace paths and the chosen account folder on each launch (local only).
- Codex: Orca prepares only the Codex account selected in its own settings. For a different account
  chosen here, Orca skips its per-launch setup, so the first launch in a new folder may show Codex's
  trust prompt, Orca's agent status for that pane may stay blank, and the account's config/skills
  stay as they were the last time Orca's settings selected it. Orca's own record of the pane's
  account shows Orca's choice, not this plugin's.
- `/resume` in a Codex pane finds older sessions only when Orca's "share history across accounts"
  setting is on and Orca has bridged that account's history.

## Develop

```sh
orca plugin types .      # creates .orca/types, which tsconfig.json extends
orca plugin validate .
orca plugin check .      # renders each panel scenario in src/panel.check.ts
orca plugin test .       # worker/main.test.ts
orca plugin dev load .
```

See [DESIGN.md](DESIGN.md) for the decisions and how Orca's launch path was traced.

## License

MIT. `worker/trust.ts` follows Orca's `claude-folder-trust-file.ts` as ported by Claude Pin (MIT,
tourbut).

# Contributing to Agent Accounts

For agents and humans changing this plugin. To *use* the plugin from an agent, read
[skills/orca-agent-accounts/SKILL.md](skills/orca-agent-accounts/SKILL.md) instead.

## Layout

| Path | What |
|---|---|
| `orca-plugin.json` | Manifest: panel, `agent.launch.before` hook, `workspace.changed` event, status bar item, capabilities |
| `worker/main.ts` | Worker: account discovery, the launch hook, tab discovery, every `accounts.*` handler, the status bar |
| `worker/trust.ts` | Writes Claude's folder-trust record into a picked account (Orca's format and lock) |
| `src/protocol.ts` | Panel/worker/agent contract: every handler's input and output types |
| `src/panel.tsx` | Components panel (`"ui": "components"`), no DOM |
| `worker/main.test.ts`, `src/panel.check.ts` | Worker tests (node:test + `orca/testing`), panel render scenarios |
| `skills/orca-agent-accounts/SKILL.md` | Agent manual; keep it in step with `src/protocol.ts` |
| `DESIGN.md` | Decisions with the reason for each, and what is and is not verified |

## Rules

- A new handler or field goes in `src/protocol.ts` first, then the worker, the agent manual and,
  if people use it, the README.
- The launch hook has a 2 s deadline: it reads in-memory caches only. Slow work (`ps`, file reads
  across accounts) belongs in handlers or the status refresh, never in the hook.
- Never start a launch on an account other than the one asked for: deny instead
  (DESIGN decision 4). Never open a resumed tab while the old Claude still runs (decision 13).
- Process access goes through the exported `sys` object so tests can replace it.
- New access (a capability) changes the approval fingerprint: say so in the change.

## Check a change

```sh
orca plugin types .        # once, and after an Orca update
orca plugin validate .
orca plugin check .        # renders the scenarios in src/panel.check.ts
orca plugin test .         # about 40 s: the move tests wait out real stop timeouts
```

Live, with the folder loaded (`orca plugin dev load .`, which reloads on save):

```sh
K=local.agent-accounts
orca plugin dev request $K accounts.state | jq '.accounts.claude'
orca plugin dev request $K accounts.tabs | jq '.tabs[] | [.terminalId, .account]'
# a throwaway tab on another account, with a prompt:
orca plugin dev request $K accounts.newTab --timeout-ms 60000 \
  --data '{"provider":"claude","path":"'"$PWD"'","accountId":"<id>","prompt":"Reply with: ok"}'
# move it back to the default account; check the new process's CLAUDE_CONFIG_DIR and --resume:
orca plugin dev request $K accounts.moveTab --timeout-ms 60000 --data '{"terminalId":"<term_>","accountId":null}'
ps -Eww -o args= -p <pid> | grep -oE 'CLAUDE_CONFIG_DIR=[^ ]+|--resume [^ ]+'
orca plugin logs $K
```

Close the throwaway tabs afterwards (`orca terminal close --terminal <term_>`), never a tab you
did not open.

## Release

1. Bump `version` in `orca-plugin.json`; update README, DESIGN and the agent manual.
2. All checks above pass; live-check what changed.
3. If the panel changed, rebuild the images from sample data: hide Orca, run
   `orca plugin shot . --scenario "<name>" --theme <dark|light> --width 380 --out <shots>/<name-with-dashes>-<theme>.png`
   for the scenarios `scripts/make_images.py` uses, then `python3 scripts/make_images.py <shots> images`.
   Never shoot the live panel for these: it shows real accounts.
4. Commit and push to `main`, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. The Orca
   directory (the repo has the `orca-plugin` topic) lists the newest `vX.Y.Z` tag within about an
   hour; a version is pinned to its first commit and hash, so never move a pushed tag.

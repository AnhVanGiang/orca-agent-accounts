import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { basename, dirname, join, resolve } from 'node:path'
import type { Activate } from 'orca/worker'
import {
  PROVIDER_NAME,
  PROVIDERS,
  REPO,
  type Account,
  type Assignments,
  type ClaudeTab,
  type Provider,
  type Workspace
} from '../src/protocol'
import { grantTrust } from './trust'

/** Orca's app data folder. macOS only: the worker cannot see Orca's own path, so others are not guessed. */
const SUPPORTED = process.platform === 'darwin'
const ORCA_DATA = join(homedir(), 'Library/Application Support/orca')

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Home of the account picked in Orca's own Claude switcher; '' for System default. */
function selectedClaudeHome(): string {
  try {
    return readFileSync(join(ORCA_DATA, 'claude-profiles', 'selected-host'), 'utf8').trim()
  } catch {
    return ''
  }
}

const claudeEmail = (home: string): string | null =>
  readJson(join(home, '.claude.json'))?.oauthAccount?.emailAddress ?? null

/** Email inside a Codex auth.json: the `email` claim of tokens.id_token (a JWT). */
function codexEmail(authJson: string): string | null {
  const token: unknown = readJson(authJson)?.tokens?.id_token
  if (typeof token !== 'string') return null
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).email ?? null
  } catch {
    return null
  }
}

/**
 * Per provider: which Orca agent ids it covers, the env var that picks the account, where Orca keeps
 * its managed account homes, and how to read the signed-in email of a home.
 */
const SPEC: Record<
  Provider,
  {
    agents: string[]
    env: string
    root: string
    emailOf: (home: string) => string | null
    /** Label for "no assignment": what Orca itself would launch with. */
    defaultLabel: () => string
  }
> = {
  claude: {
    agents: ['claude', 'claude-agent-teams'],
    env: 'CLAUDE_CONFIG_DIR',
    root: join(ORCA_DATA, 'claude-profiles'),
    emailOf: claudeEmail,
    defaultLabel: () => {
      const selected = selectedClaudeHome()
      if (selected) return `Orca's setting (${claudeEmail(selected) ?? 'signed out'})`
      // ~/.claude keeps its .claude.json one level up, in the home folder.
      const mail = claudeEmail(homedir())
      return `Default${mail ? ` (${mail})` : ''}`
    }
  },
  codex: {
    agents: ['codex'],
    env: 'CODEX_HOME',
    root: join(ORCA_DATA, 'codex-accounts'),
    emailOf: (home) => codexEmail(join(home, 'auth.json')),
    // Orca keeps its Codex selection in its settings, which a plugin cannot read.
    defaultLabel: () => "Orca's Codex setting"
  }
}
const homeOf = (p: Provider, accountId: string) => join(SPEC[p].root, accountId, 'home')

/** Process access, swapped out by the tests. */
export const sys = {
  ps: async (): Promise<string> =>
    (await promisify(execFile)('ps', ['-Aww', '-E', '-o', 'pid=,comm=,args='], { maxBuffer: 64 << 20 })).stdout,
  alive: (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  stop: (pid: number): void => process.kill(pid, 'SIGTERM')
}

/**
 * Claude conversations running in Orca terminals: Orca puts the tab's handle in each process's env
 * (ORCA_TERMINAL_HANDLE), and Claude writes `sessions/<pid>.json` (current sessionId, cwd) into the
 * account folder it runs from, which also names the account ('' = ~/.claude).
 */
export async function claudeTabs(): Promise<ClaudeTab[]> {
  const homes = [{ id: '', dir: join(homedir(), '.claude') }]
  try {
    for (const id of readdirSync(SPEC.claude.root)) homes.push({ id, dir: homeOf('claude', id) })
  } catch {
    // No Orca accounts yet.
  }
  const tabs: ClaudeTab[] = []
  for (const line of (await sys.ps()).split('\n')) {
    const pid = /^\s*(\d+)\s+(?:\S*\/)?claude\s/.exec(line)?.[1]
    const terminalId = /\bORCA_TERMINAL_HANDLE=(term_[\w-]+)/.exec(line)?.[1]
    if (!pid || !terminalId) continue
    for (const h of homes) {
      const s = readJson(join(h.dir, 'sessions', `${pid}.json`))
      // Interactive only: a `claude -p` started from inside the tab inherits its handle.
      if (s?.kind === 'interactive' && typeof s.sessionId === 'string' && typeof s.cwd === 'string') {
        const name = typeof s.name === 'string' ? s.name : ''
        tabs.push({ terminalId, pid: Number(pid), sessionId: s.sessionId, path: s.cwd, accountId: h.id, name })
        break
      }
    }
  }
  return tabs
}

async function exited(pid: number, ms: number): Promise<boolean> {
  for (let t = 0; t < ms && sys.alive(pid); t += 100) await new Promise((r) => setTimeout(r, 100))
  return !sys.alive(pid)
}
const providerOfAgent = (agent: string) => PROVIDERS.find((p) => SPEC[p].agents.includes(agent))

export function listAccounts(p: Provider): Account[] {
  const accounts: Account[] = [{ id: '', label: SPEC[p].defaultLabel(), signedIn: true }]
  let ids: string[] = []
  try {
    ids = readdirSync(SPEC[p].root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(homeOf(p, d.name)))
      .map((d) => d.name)
  } catch {
    return accounts
  }
  for (const id of ids) {
    const mail = SPEC[p].emailOf(homeOf(p, id))
    accounts.push({ id, label: mail ?? `${id.slice(0, 8)} (signed out)`, signedIn: mail !== null })
  }
  return accounts
}

/**
 * Repo a workspace belongs to: the main checkout for a linked worktree (its `.git` file points at
 * `<common>/worktrees/<name>`), the folder itself otherwise. Not a path prefix: some layouts keep
 * other repos' worktrees under one folder. Real paths, because git writes real paths.
 */
const repoCache = new Map<string, string>()
export function repoOf(path: string): string {
  const hit = repoCache.get(path)
  if (hit) return hit
  try {
    const dotgit = join(path, '.git')
    let repo = path
    if (!statSync(dotgit).isDirectory()) {
      const gitdir = resolve(path, /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, 'utf8'))![1].trim())
      const common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim())
      // `.git` / `.bare` live inside the repo folder; a real bare repo is its own folder.
      repo = basename(common).startsWith('.') ? dirname(common) : common
    }
    repo = realpathSync(repo)
    repoCache.set(path, repo)
    return repo
  } catch {
    // Not a git checkout (yet), or on another host: its own repo, not cached so it can recover.
    return path
  }
}

/** Workspace assignment wins over its repo's. */
export function accountFor(map: Record<string, string> | undefined, path: string): string | undefined {
  return map?.[path] ?? map?.[REPO + repoOf(path)]
}

/**
 * Path from a hook workspaceId: `<repoId>::<path>`, `<repoId>::<path>::workspace:<uuid>` (folder
 * repo instance), or `folder:<id>` (project-group folder, looked up from the last workspace list).
 */
export function pathOf(workspaceId: string | null, folders: Map<string, string>): string | null {
  if (!workspaceId) return null
  if (workspaceId.startsWith('folder:')) return folders.get(workspaceId) ?? null
  const sep = workspaceId.indexOf('::')
  if (sep < 0) return null
  return workspaceId.slice(sep + 2).replace(/::workspace:[0-9a-f-]{36}$/, '')
}

/**
 * Workspaces that may be the focused one. `workspace.changed` carries only branch + name, and a
 * task slug is reused across repos, so this can return several; callers must not pick one.
 */
export function focusedCandidates(
  list: Workspace[],
  c: { branch: string; displayName: string } | null
): Workspace[] {
  if (!c) return []
  const named = list.filter((w) => w.name === c.displayName)
  const exact = named.filter((w) => (w.branch ?? '') === c.branch)
  return exact.length > 0 ? exact : named
}

const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** The workspace a folder belongs to: the same folder, else the deepest workspace containing it. */
export function workspaceAt(list: Workspace[], path: string): Workspace | undefined {
  const target = real(path)
  let best: Workspace | undefined
  for (const w of list) {
    const root = real(w.path)
    if (target !== root && !target.startsWith(root + '/')) continue
    if (!best || root.length > real(best.path).length) best = w
  }
  return best
}

/** Account name for the status bar: `default`, or the part of the email before the `@`. */
export function shortAccount(accountId: string, label: string | undefined): string {
  if (!accountId) return 'default'
  return label?.includes('@') ? label.split('@')[0] : (label ?? accountId.slice(0, 8))
}

/** `me ×2 · default`: each account once, in first-seen order, with a count past one. */
export function tabSummary(names: string[]): string {
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(' · ')
}

/** Orca refuses a tooltip over 256 characters: keep `tail` and as many of `lines` as fit. */
export function fitTooltip(lines: string[], tail: string[], max = 256): string {
  for (let n = lines.length; n >= 0; n--) {
    const more = n < lines.length ? [`+${lines.length - n} more tabs; see the panel`] : []
    const text = [...lines.slice(0, n), ...more, ...tail].join('\n')
    if (text.length <= max) return text
  }
  return tail.join('\n').slice(0, max)
}

let ticker: ReturnType<typeof setInterval> | undefined
export function deactivate(): void {
  clearInterval(ticker)
}

/** Orca names this machine `local` (src/shared/execution-host.ts); anything else is SSH/WSL. */
export const isRemote = (hostId: string | null | undefined) => Boolean(hostId) && hostId !== 'local'

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
const empty = (): Assignments => ({ claude: {}, codex: {} })

const activate: Activate = async (orca) => {
  // The hook reads these caches instead of calling Orca: it has a 2 s deadline. Its only await is the
  // trust write, bounded at about 250 ms when Claude holds the config lock.
  const load = async (): Promise<Assignments> => ({
    ...empty(),
    ...((await orca.storage.get('assignments')) as Partial<Assignments> | null)
  })
  let assignments = await load()
  let trust = (await orca.storage.get('trust')) !== false
  const folders = new Map<string, string>()
  const remotePaths = new Set<string>()
  let current: { branch: string; displayName: string } | null = null
  let terminals: { id: string; title?: string }[] = []

  async function workspaces(): Promise<Workspace[]> {
    const { workspaces } = await orca.host.call('workspace.list', {})
    remotePaths.clear()
    for (const w of workspaces) {
      if (w.id.startsWith('folder:')) folders.set(w.id, w.path)
      if (isRemote(w.hostId)) remotePaths.add(w.path)
    }
    return workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      branch: w.branch,
      path: w.path,
      repo: isRemote(w.hostId) ? w.path : repoOf(w.path),
      remote: isRemote(w.hostId)
    }))
  }

  async function refreshStatus(): Promise<void> {
    const list = await workspaces()
    const candidates = focusedCandidates(list, current)
    const parts: string[] = []
    const next: string[] = []
    let unsure = false
    for (const p of PROVIDERS) {
      const ids = [...new Set(candidates.map((w) => accountFor(assignments[p], w.path) ?? ''))]
      if (ids.length > 1) unsure = true
      else {
        const label = listAccounts(p).find((a) => a.id === ids[0])?.label ?? 'missing account'
        if (ids[0]) parts.push(`${PROVIDER_NAME[p]}: ${label}`)
        next.push(`New ${PROVIDER_NAME[p]} tabs start on ${ids[0] ? label : 'the default account'}.`)
      }
    }
    // Orca does not say which tab is focused, so show every running Claude tab of this workspace.
    const here = new Set(candidates.map((w) => w.id))
    const titles = new Map(terminals.map((t) => [t.id, t.title ?? '']))
    const labels = new Map(listAccounts('claude').map((a) => [a.id, a.label]))
    const tabs = (await claudeTabs().catch(() => []))
      .filter((t) => here.has(workspaceAt(list, t.path)?.id ?? ''))
      .map((t) => ({
        title: titles.get(t.terminalId) || t.name || 'Claude',
        label: labels.get(t.accountId) ?? 'missing account',
        short: shortAccount(t.accountId, labels.get(t.accountId))
      }))
    const summary = tabSummary(tabs.map((t) => t.short))
    await orca.host.call('statusBar.update', {
      id: 'account',
      text: unsure
        ? 'Accounts: which repo?'
        : summary
          ? `Claude: ${summary}`
          : parts.length
            ? parts.join(' · ')
            : 'Accounts: default',
      tone: !unsure && (parts.length || tabs.some((t) => t.short !== 'default')) ? 'accent' : 'neutral',
      tooltip: unsure
        ? 'Workspaces in several repos share this name; open the panel'
        : fitTooltip(tabs.map((t) => `${t.title}: ${t.label}`), next)
    })
  }

  // A Claude starting or quitting in a tab sends no event; catch it on a slow tick.
  // ponytail: 20 s poll of `ps`; drop it if Orca ever reports agent start/exit to plugins.
  ticker = setInterval(() => void refreshStatus().catch(() => undefined), 20_000)
  ticker.unref?.()

  orca.storage.onDidChange(async ({ key }) => {
    if (key === 'trust') trust = (await orca.storage.get('trust')) !== false
    if (key !== 'assignments') return
    assignments = await load()
    await refreshStatus()
  })

  orca.events.on('workspace.changed', async ({ context }) => {
    current = context ? { branch: context.branch, displayName: context.displayName } : null
    terminals = context?.terminals ?? []
    await refreshStatus()
    // A new tab's Claude writes its session file a moment after the terminal opens.
    setTimeout(() => void refreshStatus().catch(() => undefined), 4000).unref?.()
  })

  /** `<provider>\0<path>` -> account for the next launch there ('' = Orca's default). */
  const oneShot = new Map<string, { accountId: string; used: boolean; resume?: string }>()

  orca.hooks.on('agent.launch.before', async (event, next) => {
    const p = providerOfAgent(event.agent)
    const path = pathOf(event.workspaceId, folders)
    orca.log(`launch agent=${event.agent} workspaceId=${event.workspaceId}`)
    if (!SUPPORTED || !p || !path || remotePaths.has(path)) return
    // A tab opened from the panel's "New tab" picker wins over the assignment, once.
    const pick = oneShot.get(`${p}\0${path}`)
    if (pick) {
      oneShot.delete(`${p}\0${path}`)
      pick.used = true
    }
    const accountId = pick ? pick.accountId : accountFor(assignments[p], path)
    // A moved tab continues its conversation; transcripts are shared across Orca's Claude accounts.
    // Orca's command carries the --session-id it tracks the pane by, and Claude takes --resume with it
    // only as a fork: the new session (Orca's id) starts with the whole conversation.
    const resume = pick?.resume
      ? ` --resume ${shq(pick.resume)}${/(^|\s)--session-id[\s=]/.test(event.command) ? ' --fork-session' : ''}`
      : ''
    if (!accountId) return resume ? next({ ...event, command: event.command + resume }) : undefined
    const home = homeOf(p, accountId)
    const name = `${PROVIDER_NAME[p]} account ${accountId.slice(0, 8)}`
    if (!existsSync(home)) {
      return { deny: `${name} no longer exists. Pick another in the Agent accounts panel.` }
    }
    if (!SPEC[p].emailOf(home)) {
      return {
        deny: `${name} is signed out. Sign in to it in Orca, or pick another in the Agent accounts panel.`
      }
    }
    orca.log(`-> ${SPEC[p].env}=${home}`)
    // Orca trusts the folder in the account it launches with. On System default that is this one
    // (our env survives); with a switcher account selected, Orca's env wins and trust lands there.
    const switcher = p === 'claude' ? selectedClaudeHome() : ''
    if (trust && switcher && resolve(switcher) !== resolve(home)) {
      const outcome = await grantTrust(home, path).catch((e) => `failed: ${String(e)}`)
      orca.log(`trust ${path}: ${outcome}`)
    }
    // Orca sets its own account env after this hook and would win; a command-line assignment is
    // applied by the shell last, and Orca's claude/codex shell functions keep it.
    const command = `${SPEC[p].env}=${shq(home)} ${event.command}${resume}`
    // Codex: prefix only. A CODEX_HOME in the launch env sends Orca down its legacy mirror-home path.
    const env = p === 'claude' ? { ...event.env, [SPEC[p].env]: home } : event.env
    return next({ ...event, command, env })
  })

  // Every Claude tab on this Mac, for agents: the panel only lists the focused workspace's.
  orca.panels.handle('accounts.tabs', async () => {
    const list = await workspaces()
    const labels = new Map(listAccounts('claude').map((a) => [a.id, a.label]))
    return {
      tabs: (await claudeTabs()).map((t) => {
        const ws = workspaceAt(list, t.path)
        return {
          terminalId: t.terminalId,
          name: t.name,
          sessionId: t.sessionId,
          pid: t.pid,
          path: t.path,
          workspaceId: ws?.id ?? null,
          workspaceName: ws?.name ?? null,
          accountId: t.accountId,
          account: labels.get(t.accountId) ?? 'missing account'
        }
      })
    }
  })

  orca.panels.handle('accounts.state', async () => {
    const list = await workspaces()
    const here = new Set(focusedCandidates(list, current).map((w) => w.path))
    const titles = new Map(terminals.map((t) => [t.id, t.title ?? '']))
    const tabs = (await claudeTabs().catch(() => []))
      .filter((t) => here.has(t.path))
      .map((t) => ({
        terminalId: t.terminalId,
        title: titles.get(t.terminalId) || t.name || 'Claude',
        accountId: t.accountId
      }))
    return {
      tabs,
      supported: SUPPORTED,
      accounts: { claude: listAccounts('claude'), codex: listAccounts('codex') },
      workspaces: list,
      assignments,
      currentIds: focusedCandidates(list, current).map((w) => w.id),
      trust
    }
  })

  // ponytail: the pick goes to the next launch of this provider in this workspace; a launch from
  // elsewhere (an automation) in the same workspace within the same second could take it. Key it by
  // terminalId if Orca ever passes that to agent.launch.
  const checkAccount = (provider: Provider, accountId: string | null) => {
    if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider ${provider}`)
    if (accountId && !listAccounts(provider).some((a) => a.id && a.id === accountId && a.signedIn)) {
      throw new Error(`no signed-in ${PROVIDER_NAME[provider]} account ${accountId} in Orca`)
    }
  }

  orca.panels.handle('accounts.newTab', async ({ provider, workspaceId, path, accountId, prompt }) => {
    checkAccount(provider, accountId)
    if (prompt !== undefined && typeof prompt !== 'string') throw new Error('prompt must be a string')
    const list = await workspaces()
    const ws = workspaceId ? list.find((w) => w.id === workspaceId) : path ? workspaceAt(list, path) : undefined
    if (!ws) throw new Error(`no Orca workspace ${workspaceId ?? path ?? '(give workspaceId or path)'}`)
    return openTab(provider, ws, accountId, undefined, prompt || undefined)
  })

  // Moving = stop the tab's Claude, then a new tab on the account resuming the same conversation.
  // Two Claudes writing one transcript would corrupt it, so nothing opens until the old one is gone.
  const moving = new Set<string>()
  orca.panels.handle('accounts.moveTab', async ({ terminalId, accountId }) => {
    checkAccount('claude', accountId)
    const found = (await claudeTabs()).filter((t) => t.terminalId === terminalId)
    if (found.length === 0) throw new Error('No running Claude conversation in that tab.')
    if (found.length > 1) throw new Error('That tab runs more than one Claude; move it by hand.')
    const tab = found[0]
    if (tab.accountId === (accountId ?? '')) throw new Error('That tab is already on this account.')
    const ws = workspaceAt(await workspaces(), tab.path)
    if (!ws) throw new Error(`No Orca workspace at ${tab.path}`)
    if (ws.remote) throw new Error(`${ws.name} is on another host; accounts are local only`)
    // The new tab opens at the workspace root, and Claude looks a conversation up by its folder.
    if (real(tab.path) !== real(ws.path)) {
      throw new Error(`That Claude was started in ${tab.path}, not the workspace root; move it by hand: cd there, then claude --resume ${tab.sessionId}`)
    }
    if (moving.has(terminalId)) throw new Error('That tab is already moving.')
    // Everything that can refuse the new tab is checked before the old Claude is stopped.
    if (oneShot.has(`claude\0${ws.path}`)) throw new Error('A tab is already opening here; try again in a moment.')
    moving.add(terminalId)
    try {
      const send = (text: string, enter = false) =>
        orca.host.call('terminal.sendText', { terminalId, text, enter })
      // Ctrl+C, not Esc + /exit: with vim mode on, Esc leaves insert mode and /exit is never typed.
      // The first press ends a turn or clears the prompt; a second one soon after quits Claude.
      for (let i = 0; i < 4 && sys.alive(tab.pid); i++) {
        await send('\x03')
        await exited(tab.pid, 500)
      }
      if (!(await exited(tab.pid, 10_000))) {
        orca.log(`move ${terminalId}: Ctrl+C did not stop pid ${tab.pid}; SIGTERM`)
        sys.stop(tab.pid)
        if (!(await exited(tab.pid, 3000))) {
          throw new Error('The old Claude would not stop, so no new tab was opened.')
        }
      }
      orca.log(`move ${terminalId}: session ${tab.sessionId} -> account ${accountId ?? 'default'}`)
      let opened: { terminalId: string }
      try {
        opened = await openTab('claude', ws, accountId, tab.sessionId)
        // The launch can fail after the hook (a refused flag, a crash): only a running Claude counts.
        if (!(await claudeStarted(opened.terminalId, 15_000))) {
          throw new Error(`The new tab ${opened.terminalId} did not start Claude in 15 s.`)
        }
      } catch (e) {
        // The old Claude is gone and its tab stays open: say how to get the conversation back.
        const why = e instanceof Error ? e.message : String(e)
        throw new Error(`${why} The old Claude has stopped; continue it with: claude --resume ${tab.sessionId}`)
      }
      // Only now close the old tab's leftover shell. Gone already is fine.
      await send('exit', true).catch(() => undefined)
      return opened
    } finally {
      moving.delete(terminalId)
    }
  })

  async function openTab(
    provider: Provider,
    ws: Workspace,
    accountId: string | null,
    resume?: string,
    prompt?: string
  ) {
    if (ws.remote) throw new Error(`${ws.name} is on another host; accounts are local only`)
    const key = `${provider}\0${ws.path}`
    if (oneShot.has(key)) throw new Error('A tab is already opening here; try again in a moment.')
    const pick = { accountId: accountId ?? '', used: false, resume }
    oneShot.set(key, pick)
    try {
      const { terminalId } = await orca.host.call('agent.launch', { workspaceId: ws.id, agent: provider })
      // The hook may run after agent.launch returns; give it a moment before calling it lost.
      for (let i = 0; i < 50 && !pick.used; i++) await new Promise((r) => setTimeout(r, 100))
      if (!pick.used) {
        throw new Error('The tab opened, but Orca did not ask this plugin, so it is on the default account.')
      }
      if (prompt) await typePrompt(provider, terminalId, prompt)
      return { terminalId }
    } finally {
      if (oneShot.get(key) === pick) oneShot.delete(key)
    }
  }

  /**
   * Orca's own agent.launch `prompt` is sent before the agent runs and is dropped
   * (agent_launch_terminal_not_running_agent), so type it once the tab's Claude has written its
   * session file. Codex has no such file: give it a fixed head start.
   */
  async function typePrompt(provider: Provider, terminalId: string, prompt: string): Promise<void> {
    const ready = provider === 'codex' || (await claudeStarted(terminalId, 30_000))
    if (!ready) throw new Error(`The tab ${terminalId} opened on the account, but its Claude did not start in 30 s, so the prompt was not sent.`)
    // ponytail: fixed pause for the input box to draw; poll terminal.read if a prompt ever lands early.
    await new Promise((r) => setTimeout(r, provider === 'codex' ? 4000 : 1500))
    await orca.host.call('terminal.sendText', { terminalId, text: prompt, enter: true })
  }

  /** Whether an interactive Claude is running in `terminalId` within `ms`. */
  async function claudeStarted(terminalId: string, ms: number): Promise<boolean> {
    for (let t = 0; t < ms; t += 500) {
      if ((await claudeTabs()).some((c) => c.terminalId === terminalId)) return true
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  orca.panels.handle('accounts.setTrust', async ({ on }) => {
    await orca.storage.set('trust', on === true)
    trust = on === true
    return { ok: true as const }
  })

  // Warm the folder/remote caches and the status bar; workspace.changed may not fire again soon.
  void refreshStatus().catch((e) => orca.log(`initial refresh failed: ${String(e)}`))

  // Serialized: the panel and an agent's `dev request` may write at once.
  let writes: Promise<unknown> = Promise.resolve()
  orca.panels.handle('accounts.assign', ({ provider, path, repo, accountId }) => {
    const run = writes.then(async () => {
      if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider ${provider}`)
      const key = repo ? REPO + repo : path
      if (!key) throw new Error('accounts.assign needs path or repo')
      // Only Orca's own account folders and listed workspaces: the id becomes a path.
      if (accountId && !listAccounts(provider).some((a) => a.id && a.id === accountId)) {
        throw new Error(`no ${PROVIDER_NAME[provider]} account ${accountId} in Orca`)
      }
      // Clearing works even after the workspace is gone; setting needs a key that can match.
      const list = accountId ? await workspaces() : []
      if (accountId && (repo ? !list.some((w) => w.repo === repo) : !list.some((w) => w.path === path))) {
        throw new Error(`no Orca workspace ${repo ? `repo ${repo}` : path}`)
      }
      const map = { ...assignments[provider] }
      if (accountId) map[key] = accountId
      else delete map[key]
      const nextAll = { ...assignments, [provider]: map }
      await orca.storage.set('assignments', nextAll)
      assignments = nextAll
      return { ok: true as const }
    })
    writes = run.catch(() => undefined)
    return run
  })
}

export default activate

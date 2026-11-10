import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Activate } from 'orca/worker'
import {
  PROVIDER_NAME,
  PROVIDERS,
  REPO,
  type Account,
  type Assignments,
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
    const candidates = focusedCandidates(await workspaces(), current)
    const parts: string[] = []
    let unsure = false
    for (const p of PROVIDERS) {
      const ids = [...new Set(candidates.map((w) => accountFor(assignments[p], w.path) ?? ''))]
      if (ids.length > 1) unsure = true
      else if (ids[0]) {
        const label = listAccounts(p).find((a) => a.id === ids[0])?.label ?? 'missing account'
        parts.push(`${PROVIDER_NAME[p]}: ${label}`)
      }
    }
    await orca.host.call('statusBar.update', {
      id: 'account',
      text: unsure ? 'Accounts: which repo?' : parts.length ? parts.join(' · ') : 'Accounts: default',
      tone: !unsure && parts.length ? 'accent' : 'neutral',
      tooltip: unsure
        ? 'Workspaces in several repos share this name; open the panel'
        : 'Accounts new Claude and Codex terminal agents start on here'
    })
  }

  orca.storage.onDidChange(async ({ key }) => {
    if (key === 'trust') trust = (await orca.storage.get('trust')) !== false
    if (key !== 'assignments') return
    assignments = await load()
    await refreshStatus()
  })

  orca.events.on('workspace.changed', async ({ context }) => {
    current = context ? { branch: context.branch, displayName: context.displayName } : null
    await refreshStatus()
  })

  orca.hooks.on('agent.launch.before', async (event, next) => {
    const p = providerOfAgent(event.agent)
    const path = pathOf(event.workspaceId, folders)
    orca.log(`launch agent=${event.agent} workspaceId=${event.workspaceId}`)
    if (!SUPPORTED || !p || !path || remotePaths.has(path)) return
    const accountId = accountFor(assignments[p], path)
    if (!accountId) return
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
    const command = `${SPEC[p].env}=${shq(home)} ${event.command}`
    // Codex: prefix only. A CODEX_HOME in the launch env sends Orca down its legacy mirror-home path.
    const env = p === 'claude' ? { ...event.env, [SPEC[p].env]: home } : event.env
    return next({ ...event, command, env })
  })

  orca.panels.handle('accounts.state', async () => {
    const list = await workspaces()
    return {
      supported: SUPPORTED,
      accounts: { claude: listAccounts('claude'), codex: listAccounts('codex') },
      workspaces: list,
      assignments,
      currentIds: focusedCandidates(list, current).map((w) => w.id),
      trust
    }
  })

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

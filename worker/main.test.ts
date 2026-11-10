import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'

// Fake HOME with Orca account folders, set before the worker module reads homedir().
const home = mkdtempSync(join(tmpdir(), 'aa-'))
const data = join(home, 'Library/Application Support/orca')
const claude = (id: string, email?: string) => {
  mkdirSync(join(data, 'claude-profiles', id, 'home'), { recursive: true })
  if (email) {
    writeFileSync(join(data, 'claude-profiles', id, 'home/.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  }
}
claude('p1', 'me@x')
claude('out') // signed out: no .claude.json
// Codex: auth.json whose id_token (a JWT) carries the email claim.
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
mkdirSync(join(data, 'codex-accounts/c1/home'), { recursive: true })
writeFileSync(join(data, 'codex-accounts/c1/home/auth.json'), JSON.stringify({ tokens: { id_token: jwt({ email: 'cx@x' }) } }))
process.env.HOME = home

// Fake repo: main checkout /repo with a linked worktree /repo/.worktrees/w1.
const repo = realpathSync(home) + '/repo'
const wt = join(repo, '.worktrees/w1')
const gitdir = join(repo, '.git/worktrees/w1')
mkdirSync(gitdir, { recursive: true })
mkdirSync(wt, { recursive: true })
writeFileSync(join(gitdir, 'commondir'), '../..\n')
writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`)

const launch = (agent: string, workspaceId: string | null) => ({
  agent,
  workspaceId,
  workspaceKind: 'worktree' as const,
  command: agent === 'codex' ? 'codex' : 'claude',
  env: {}
})

// Orca lists this machine's workspaces with hostId 'local'.
const entry = (id: string, path: string, hostId: string | null = 'local') => ({
  id,
  kind: 'worktree',
  name: id,
  path,
  branch: null,
  hostId
})
const listed = [
  { ...entry('folder:f1', '/wt/notes'), kind: 'folder' },
  entry('a', '/wt/a'),
  entry('ssh', '/wt/ssh', 'host-1'),
  entry('repo', repo)
]

async function mount(assignments: object) {
  const main = await import('./main')
  const host = mockHost({
    storage: { assignments },
    results: { 'workspace.list': { workspaces: listed, truncated: false }, 'statusBar.update': { ok: true } }
  })
  const worker = await mountWorker(main, { host })
  const fire = (agent: string, id: string | null) =>
    worker.hooks.fire('agent.launch.before', launch(agent, id)).then((r) => JSON.stringify(r))
  return { worker, fire }
}

test('routes claude by path, passes the rest, denies a missing account', async () => {
  const { worker, fire } = await mount({ claude: { '/wt/a': 'p1', '/wt/gone': 'nope' } })
  assert.match(await fire('claude', 'repo1::/wt/a'), /CLAUDE_CONFIG_DIR='[^']*claude-profiles\/p1\/home' claude/)
  assert.doesNotMatch(await fire('claude', 'repo1::/wt/other'), /CONFIG_DIR|CODEX_HOME|deny/)
  assert.doesNotMatch(await fire('codex', 'repo1::/wt/a'), /CONFIG_DIR|CODEX_HOME|deny/)
  assert.doesNotMatch(await fire('claude', null), /CONFIG_DIR|deny/)
  assert.match(await fire('claude', 'repo1::/wt/gone'), /deny/)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('routes codex to its Orca account home with CODEX_HOME', async () => {
  const { worker, fire } = await mount({ codex: { [`repo:${repo}`]: 'c1' } })
  assert.match(await fire('codex', `r::${wt}`), /CODEX_HOME='[^']*codex-accounts\/c1\/home' codex/)
  // No CODEX_HOME in env: only the command carries it.
  assert.doesNotMatch(await fire('codex', `r::${wt}`), /"CODEX_HOME"/)
  assert.doesNotMatch(await fire('claude', `r::${wt}`), /CONFIG_DIR|CODEX_HOME|deny/)
  const state = (await worker.request('accounts.state', {})) as { accounts: { codex: { label: string }[] } }
  assert.deepEqual(state.accounts.codex.map((a) => a.label).slice(1), ['cx@x'])
  await worker.deactivate()
})

test('a repo assignment covers its main checkout and worktrees; a workspace pick wins', async () => {
  const main = await import('./main')
  assert.equal(main.repoOf(wt), repo)
  assert.equal(main.repoOf(repo), repo)
  const { worker, fire } = await mount({ claude: { [`repo:${repo}`]: 'p1', [wt]: 'gone' } })
  assert.match(await fire('claude', `r::${repo}`), /claude-profiles\/p1\/home/)
  assert.match(await fire('claude', `r::${wt}`), /deny/)
  await worker.deactivate()
})

test('agent teams, folder ids, signed-out deny, remote workspaces pass', async () => {
  const { worker, fire } = await mount({
    claude: { '/wt/a': 'p1', '/wt/notes': 'p1', '/wt/b': 'out', '/wt/ssh': 'p1' }
  })
  assert.match(await fire('claude-agent-teams', 'repo1::/wt/a'), /p1\/home/)
  assert.match(await fire('claude', 'repo1::/wt/a::workspace:0123abcd-0123-0123-0123-0123456789ab'), /p1\/home/)
  assert.match(await fire('claude', 'repo1::/wt/b'), /signed out/)
  // Caches warm at activation: folder ids and remote hosts resolve without opening the panel.
  assert.match(await fire('claude', 'folder:f1'), /p1\/home/)
  assert.doesNotMatch(await fire('claude', 'repo1::/wt/ssh'), /CONFIG_DIR|deny/)
  await worker.deactivate()
})

test('bare container layout resolves to the container folder', async () => {
  const main = await import('./main')
  const c = join(home, 'bare')
  const g = join(c, '.bare/worktrees/main')
  mkdirSync(g, { recursive: true })
  mkdirSync(join(c, 'main'), { recursive: true })
  writeFileSync(join(g, 'commondir'), '../..\n')
  writeFileSync(join(c, 'main/.git'), `gitdir: ${g}\n`)
  assert.equal(main.repoOf(join(c, 'main')), realpathSync(c))
})

test('a name shared across repos yields every match, never a guess', async () => {
  const main = await import('./main')
  const ws = (id: string, r: string) => ({ id, name: 'feat-x', branch: 'feat/x', path: `/${r}/feat-x`, repo: r, remote: false })
  const list = [ws('a', 'r1'), ws('b', 'r2')]
  assert.equal(main.focusedCandidates(list, { branch: 'feat/x', displayName: 'feat-x' }).length, 2)
  assert.equal(main.focusedCandidates(list, null).length, 0)
})

test('assign: concurrent writes keep both keys; unknown accounts and workspaces are refused', async () => {
  const { worker } = await mount({})
  await Promise.all([
    worker.request('accounts.assign', { provider: 'claude', path: '/wt/a', accountId: 'p1' }),
    worker.request('accounts.assign', { provider: 'codex', repo, accountId: 'c1' })
  ])
  const state = (await worker.request('accounts.state', {})) as { assignments: Record<string, object> }
  assert.deepEqual(state.assignments, { claude: { '/wt/a': 'p1' }, codex: { [`repo:${repo}`]: 'c1' } })
  await assert.rejects(
    worker.request('accounts.assign', { provider: 'claude', path: '/wt/a', accountId: '../../../../tmp/evil' }),
    /no Claude account/
  )
  await assert.rejects(
    worker.request('accounts.assign', { provider: 'claude', path: '/not/listed', accountId: 'p1' }),
    /no Orca workspace/
  )
  // Clearing a key works even when its workspace is gone.
  await worker.request('accounts.assign', { provider: 'claude', path: '/gone', accountId: null })
  await worker.deactivate()
})

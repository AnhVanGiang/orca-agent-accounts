import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

claude('trusty', 'me@x')
writeFileSync(join(data, 'claude-profiles/trusty/home/.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@x' }, keep: 1 }))

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

test('trust: only with a switcher account selected, and off leaves it alone', async () => {
  const cfg = join(data, 'claude-profiles/trusty/home/.claude.json')
  const read = () => JSON.parse(readFileSync(cfg, 'utf8'))
  const selected = join(data, 'claude-profiles/selected-host')
  const { worker, fire } = await mount({ claude: { [wt]: 'trusty' } })
  // System default: Orca trusts the folder in the launch account itself.
  await fire('claude', `r::${wt}`)
  assert.equal(read().projects, undefined)
  // A switcher account selected: Orca trusts there, so the plugin trusts the picked account.
  writeFileSync(selected, join(data, 'claude-profiles/p1/home'))
  await fire('claude', `r::${wt}`)
  assert.equal(read().projects[realpathSync(wt)].hasTrustDialogAccepted, true)
  assert.equal(read().keep, 1)
  await worker.request('accounts.setTrust', { on: false })
  await fire('claude', `r::${repo}`) // not assigned: untouched either way
  assert.equal(read().projects[repo], undefined)
  await worker.deactivate()
  // Off: an assigned workspace is not trusted.
  writeFileSync(cfg, JSON.stringify({ oauthAccount: { emailAddress: 'me@x' } }))
  const off = await mount({ claude: { [wt]: 'trusty' } })
  await off.worker.request('accounts.setTrust', { on: false })
  await off.fire('claude', `r::${wt}`)
  assert.equal(read().projects, undefined)
  await off.worker.deactivate()
  rmSync(selected)
})

test('trust: never the home folder', async () => {
  const { grantTrust } = await import('./trust')
  assert.equal(await grantTrust(join(data, 'claude-profiles/trusty/home'), home), 'too-broad')
  assert.equal(await grantTrust(join(data, 'claude-profiles/trusty/home'), '/'), 'too-broad')
})

test('newTab: the pick wins once, then the assignment; lost or refused launches say so', async () => {
  const main = await import('./main')
  let worker: Awaited<ReturnType<typeof mountWorker>>
  let mode: 'hook' | 'skip' = 'hook'
  let fired: Promise<string> = Promise.resolve('')
  const host = mockHost({
    storage: { assignments: { claude: { [`repo:${repo}`]: 'p1' }, codex: {} } },
    results: {
      'workspace.list': { workspaces: listed, truncated: false },
      'statusBar.update': { ok: true },
      // Not awaited: the harness's hooks.fire waits for pending host calls, this one included. It
      // also covers a hook that runs after agent.launch has returned.
      'agent.launch': ({ agent }: { agent: string }) => {
        if (mode === 'hook') fired = worker.hooks.fire('agent.launch.before', launch(agent, `r::${repo}`)).then((r) => JSON.stringify(r))
        return { terminalId: 't1' }
      }
    }
  })
  worker = await mountWorker(main, { host })
  const tab = (accountId: string | null) => worker.request('accounts.newTab', { provider: 'claude', workspaceId: 'repo', accountId })
  // Default picked in a repo assigned to p1: no prefix.
  assert.deepEqual(await tab(null), { terminalId: 't1' })
  assert.doesNotMatch(await fired, /CONFIG_DIR/)
  await tab('trusty')
  assert.match(await fired, /claude-profiles\/trusty\/home/)
  // Consumed: the next launch is back on the repo's account.
  assert.match(JSON.stringify(await worker.hooks.fire('agent.launch.before', launch('claude', `r::${repo}`))), /p1\/home/)
  await assert.rejects(tab('out'), /no signed-in Claude account/)
  await assert.rejects(tab('../../evil'), /no signed-in/)
  await assert.rejects(worker.request('accounts.newTab', { provider: 'claude', workspaceId: 'ssh', accountId: 'p1' }), /another host/)
  mode = 'skip'
  await assert.rejects(tab('trusty'), /did not ask this plugin/)
  // The lost pick is cleared, so it cannot leak into a later launch.
  assert.match(JSON.stringify(await worker.hooks.fire('agent.launch.before', launch('claude', `r::${repo}`))), /p1\/home/)
  await worker.deactivate()
})

test('moveTab: stops the old Claude, then resumes its conversation on the picked account', async () => {
  const main = await import('./main')
  mkdirSync(join(home, '.claude/sessions'), { recursive: true })
  writeFileSync(join(home, '.claude/sessions/4242.json'), JSON.stringify({ kind: 'interactive', sessionId: 'sess-1', cwd: repo }))
  const real = { ...main.sys }
  let alive = true
  let obeys: 'exit' | 'signal' | 'never' = 'exit'
  const sent: string[] = []
  writeFileSync(join(home, '.claude/sessions/4243.json'), JSON.stringify({ kind: 'interactive', sessionId: 'sess-2', cwd: repo }))
  let started = true // whether the new tab's Claude comes up
  let launched = false
  main.sys.ps = async () =>
    ` 4242 claude claude --x ORCA_TERMINAL_HANDLE=term_t1 HOME=${home}\n 99 zsh -zsh\n` +
    (launched && started ? ' 4243 claude ORCA_TERMINAL_HANDLE=term_t2\n' : '')
  main.sys.alive = () => alive
  main.sys.stop = () => void (obeys === 'signal' && (alive = false))
  let worker: Awaited<ReturnType<typeof mountWorker>>
  let fired: Promise<string> = Promise.resolve('')
  const host = mockHost({
    storage: { assignments: { claude: {}, codex: {} } },
    results: {
      'workspace.list': { workspaces: listed, truncated: false },
      'statusBar.update': { ok: true },
      'terminal.sendText': ({ text }: { text: string }) => {
        sent.push(text)
        if (text === '\x03' && obeys === 'exit' && sent.filter((t) => t === '\x03').length >= 2) alive = false
        return { accepted: true }
      },
      'agent.launch': ({ agent }: { agent: string }) => {
        if (launchFails) throw new Error('launch refused.')
        fired = worker.hooks.fire('agent.launch.before', launch(agent, `r::${repo}`)).then((r) => JSON.stringify(r))
        launched = true
        return { terminalId: 'term_t2' }
      }
    }
  })
  let launchFails = false
  worker = await mountWorker(main, { host })
  const move = () => worker.request('accounts.moveTab', { terminalId: 'term_t1', accountId: 'trusty' })
  assert.deepEqual(await move(), { terminalId: 'term_t2' })
  assert.deepEqual(sent, ['\x03', '\x03', 'exit'])
  assert.match(await fired, /claude-profiles\/trusty\/home' claude --resume 'sess-1'/)
  await assert.rejects(worker.request('accounts.moveTab', { terminalId: 'term_t1', accountId: null }), /already on this account/)
  // The new tab fails after the stop: the error says how to resume, and the old tab stays open.
  alive = true
  launchFails = true
  sent.length = 0
  await assert.rejects(move(), /claude --resume sess-1/)
  assert.deepEqual(sent, ['\x03', '\x03'])
  launchFails = false
  // The new tab opens but its Claude never runs: same hint, and the old tab stays open.
  alive = true
  started = false
  launched = false
  sent.length = 0
  await assert.rejects(move(), /did not start Claude.*claude --resume sess-1/)
  assert.deepEqual(sent, ['\x03', '\x03'])
  started = true
  launched = false
  alive = true
  obeys = 'signal'
  await move()
  obeys = 'never'
  alive = true
  const launches = host.callsOf('agent.launch').length
  await assert.rejects(move(), /would not stop/)
  assert.equal(host.callsOf('agent.launch').length, launches)
  Object.assign(main.sys, real)
  await worker.deactivate()
})

test('status bar: names each account once with a count', async () => {
  const main = await import('./main')
  assert.equal(main.tabSummary(['vg', 'vg', 'default']), 'vg ×2 · default')
  assert.equal(main.tabSummary([]), '')
  assert.equal(main.shortAccount('', 'Default (a@b)'), 'default')
  assert.equal(main.shortAccount('p1', 'me@x'), 'me')
  assert.equal(main.shortAccount('abcdef123', 'abcdef12 (signed out)'), 'abcdef12 (signed out)')
  const fit = main.fitTooltip(Array.from({ length: 30 }, (_, i) => `tab ${i}: someone@example.com`), ['New Claude tabs start on X.'])
  assert.ok(fit.length <= 256)
  assert.match(fit, /^tab 0: .*\n\+\d+ more tabs; see the panel\nNew Claude tabs start on X\.$/s)
})

test('agents: tabs everywhere, newTab by a path inside the workspace with a prompt, per-tab status', async () => {
  const main = await import('./main')
  mkdirSync(join(home, '.claude/sessions'), { recursive: true })
  mkdirSync(join(data, 'claude-profiles/p1/home/sessions'), { recursive: true })
  writeFileSync(join(home, '.claude/sessions/501.json'), JSON.stringify({ kind: 'interactive', sessionId: 's-a', cwd: wt, name: 'one' }))
  writeFileSync(join(data, 'claude-profiles/p1/home/sessions/502.json'), JSON.stringify({ kind: 'interactive', sessionId: 's-b', cwd: wt }))
  writeFileSync(join(home, '.claude/sessions/503.json'), JSON.stringify({ kind: 'print', sessionId: 's-c', cwd: wt }))
  const real = { ...main.sys }
  let launched = false
  main.sys.ps = async () =>
    [
      ' 501 claude claude ORCA_TERMINAL_HANDLE=term_a',
      ' 502 /usr/bin/claude x ORCA_TERMINAL_HANDLE=term_b',
      ' 503 claude -p ORCA_TERMINAL_HANDLE=term_a',
      ...(launched ? [' 501 claude claude ORCA_TERMINAL_HANDLE=term_new'] : [])
    ].join('\n')
  let worker: Awaited<ReturnType<typeof mountWorker>>
  let fired: Promise<string> = Promise.resolve('')
  const withWt = [...listed, entry('w1', wt)]
  const host = mockHost({
    storage: { assignments: { claude: {}, codex: {} } },
    results: {
      'workspace.list': { workspaces: withWt, truncated: false },
      'statusBar.update': { ok: true },
      'agent.launch': ({ agent }: { agent: string }) => {
        fired = worker.hooks.fire('agent.launch.before', launch(agent, `r::${wt}`)).then((r) => JSON.stringify(r))
        launched = true
        return { terminalId: 'term_new' }
      },
      'terminal.sendText': () => ({ accepted: true })
    }
  })
  worker = await mountWorker(main, { host })
  const { tabs } = (await worker.request('accounts.tabs', {})) as { tabs: { terminalId: string; workspaceId: string; account: string; sessionId: string }[] }
  assert.deepEqual(
    tabs.map((t) => [t.terminalId, t.workspaceId, t.account, t.sessionId]),
    [['term_a', 'w1', 'Default', 's-a'], ['term_b', 'w1', 'me@x', 's-b']]
  )
  // A subfolder of the workspace finds it; the prompt goes to Orca's launch.
  await worker.request('accounts.newTab', { provider: 'claude', path: join(wt, 'src'), accountId: 'p1', prompt: 'hi' })
  assert.match(await fired, /p1\/home' claude/)
  // Typed by the plugin once that tab's Claude runs: Orca's own prompt arrives too early.
  assert.deepEqual(host.callsOf('agent.launch').at(-1), { workspaceId: 'w1', agent: 'claude' })
  assert.deepEqual(host.callsOf('terminal.sendText').at(-1), { terminalId: 'term_new', text: 'hi', enter: true })
  launched = false
  await assert.rejects(worker.request('accounts.newTab', { provider: 'claude', path: '/nowhere', accountId: null }), /no Orca workspace/)
  // Focus the worktree: the status bar lists both tabs by account.
  await worker.emit('workspace.changed', { context: { branch: '', displayName: 'w1', terminals: [{ id: 'term_a', title: 'Alpha' }] } })
  const bar = host.callsOf('statusBar.update').at(-1) as { text: string; tooltip: string }
  assert.equal(bar.text, 'Claude: default · me')
  assert.match(bar.tooltip, /^Alpha: Default\n.*: me@x\n/)
  Object.assign(main.sys, real)
  await worker.deactivate()
})

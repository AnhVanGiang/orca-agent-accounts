import {
  atom,
  Callout,
  Card,
  Collapsible,
  Heading,
  IconButton,
  Input,
  on,
  plugin,
  read,
  Row,
  Select,
  Separator,
  set,
  Stack,
  Switch,
  Text,
  type PanelContext
} from 'orca'
import {
  PROVIDER_NAME,
  PROVIDERS,
  REPO,
  type Account,
  type Assignments,
  type Provider,
  type Workspace
} from './protocol'

type State = {
  supported: boolean
  accounts: Record<Provider, Account[]>
  workspaces: Workspace[]
  assignments: Assignments
  currentIds: string[]
  trust: boolean
}

/** Select refuses an empty-string option value, so "no assignment" gets a sentinel. */
const NONE = 'none'
const MAX_RESULTS = 20
const state = atom<State | null>(null)
const filter = atom('')
const error = atom<string | null>(null)
const saveError = atom<string | null>(null)

async function refresh(): Promise<void> {
  try {
    set(state, await plugin.request('accounts.state', {}))
    set(error, null)
  } catch (e) {
    set(error, e instanceof Error ? e.message : String(e))
  }
}

type Target = { path: string } | { repo: string }
async function assign(provider: Provider, target: Target, value: string): Promise<void> {
  try {
    await plugin.request('accounts.assign', {
      provider,
      ...target,
      accountId: value === NONE ? null : value
    })
    set(saveError, null)
  } catch (e) {
    set(saveError, e instanceof Error ? e.message : String(e))
  }
  await refresh()
}

async function setTrust(on: boolean): Promise<void> {
  try {
    await plugin.request('accounts.setTrust', { on })
    set(saveError, null)
  } catch (e) {
    set(saveError, e instanceof Error ? e.message : String(e))
  }
  await refresh()
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(on('workspace.changed', () => void refresh()))
  void refresh()
}

const repoName = (repo: string) => repo.split('/').filter(Boolean).pop() ?? repo
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const labelOf = (s: State, p: Provider, id: string | undefined) =>
  s.accounts[p].find((a) => a.id === (id ?? ''))?.label ?? 'missing account'

/** Default first (as NONE), then Orca's accounts; signed-out ones are shown but not pickable. */
function accountOptions(s: State, p: Provider, none: string, value: string) {
  const options = s.accounts[p].map((a) => ({
    value: a.id || NONE,
    label: a.id ? a.label : none,
    disabled: !a.signedIn
  }))
  // An assignment to a deleted account still shows, so it can be changed.
  return options.some((o) => o.value === value)
    ? options
    : [...options, { value, label: 'missing account', disabled: true }]
}

function RepoPicker(props: { p: Provider; repo: string; s: State; label: string }) {
  const { p, repo, s, label } = props
  const value = s.assignments[p][REPO + repo] ?? NONE
  return (
    <Select
      label={label}
      value={value}
      options={accountOptions(s, p, labelOf(s, p, ''), value)}
      onChange={(v) => void assign(p, { repo }, String(v))}
    />
  )
}

/** The account a workspace's new agents get, and where that comes from. */
function effective(s: State, p: Provider, ws: Workspace) {
  const own = s.assignments[p][ws.path]
  const repo = s.assignments[p][REPO + ws.repo]
  if (own) return { label: labelOf(s, p, own), source: 'Set for this workspace only' }
  if (repo) return { label: labelOf(s, p, repo), source: `Set for all of ${repoName(ws.repo)}` }
  return { label: labelOf(s, p, ''), source: 'Nothing picked here' }
}

function ProviderSection(props: { p: Provider; ws: Workspace; s: State; count: number }) {
  const { p, ws, s, count } = props
  const now = effective(s, p, ws)
  const own = s.assignments[p][ws.path] ?? NONE
  const canOverride = count > 1 || ws.path !== ws.repo
  const onlyDefault = s.accounts[p].length === 1
  return (
    <Stack gap="sm">
      <Heading level={3}>{PROVIDER_NAME[p]}</Heading>
      <Stack gap="none">
        <Text weight="semibold" truncate>
          {now.label}
        </Text>
        <Text muted size="sm">
          {now.source}
        </Text>
      </Stack>
      {onlyDefault ? (
        <Text muted size="xs">
          {`Add a second ${PROVIDER_NAME[p]} account in Orca's settings to pick one here.`}
        </Text>
      ) : (
        <>
          <RepoPicker p={p} repo={ws.repo} s={s} label={`Whole repo (${plural(count, 'workspace')})`} />
          {canOverride ? (
            <Collapsible title="Different account for just this workspace" defaultOpen={own !== NONE}>
              <Select
                label={`${PROVIDER_NAME[p]} account for this workspace only`}
                labelHidden
                value={own}
                options={accountOptions(s, p, 'Same as repo', own)}
                onChange={(v) => void assign(p, { path: ws.path }, String(v))}
              />
            </Collapsible>
          ) : null}
          {p === 'codex' ? (
            <Text muted size="xs">
              Experimental: for a Codex account picked here, Orca skips its folder trust and status
              setup.
            </Text>
          ) : null}
        </>
      )}
    </Stack>
  )
}

function FocusedCard(props: { ws: Workspace; s: State; ambiguous: boolean; count: number }) {
  const { ws, s, ambiguous, count } = props
  return (
    <Card title={ambiguous ? `${ws.name} in ${repoName(ws.repo)}` : ws.name}>
      {ws.remote ? (
        <Text muted size="sm">
          This workspace is on another host. Accounts can only be picked for workspaces on this Mac.
        </Text>
      ) : (
        <Stack gap="md">
          {PROVIDERS.map((p, i) => (
            <Stack key={p} gap="md">
              {i > 0 ? <Separator /> : null}
              <ProviderSection p={p} ws={ws} s={s} count={count} />
            </Stack>
          ))}
        </Stack>
      )}
    </Card>
  )
}

function InUseRow(props: { p: Provider; title: string; detail: string; target: Target }) {
  const { p, title, detail, target } = props
  return (
    <Row gap="sm" align="center" justify="between">
      <Stack gap="none">
        <Text weight="medium" truncate>
          {title}
        </Text>
        <Text muted size="xs" truncate>
          {detail}
        </Text>
      </Stack>
      <IconButton
        icon="close"
        label={`Back to default: ${PROVIDER_NAME[p]} in ${title}`}
        variant="ghost"
        size="sm"
        onPress={() => void assign(p, target, NONE)}
      />
    </Row>
  )
}

export default function Panel() {
  const s = read(state)
  const err = read(error)
  if (err) return <Callout tone="danger" title="Could not load accounts">{err}</Callout>
  if (!s) return <Text muted>Loading accounts…</Text>
  if (!s.supported) {
    return (
      <Callout tone="warning" title="macOS only for now">
        Agent accounts reads the account folders Orca keeps on macOS. It does nothing on this system.
      </Callout>
    )
  }

  const byRepo = new Map<string, Workspace[]>()
  for (const w of s.workspaces) byRepo.set(w.repo, [...(byRepo.get(w.repo) ?? []), w])
  const count = (repo: string) => byRepo.get(repo)?.length ?? 1
  const focused = s.workspaces.filter((w) => s.currentIds.includes(w.id))

  const rows = PROVIDERS.flatMap((p) => [
    ...[...byRepo.keys()]
      .filter((r) => s.assignments[p][REPO + r])
      .map((r) => ({
        p,
        key: `${p}:${REPO}${r}`,
        title: repoName(r),
        detail: `${PROVIDER_NAME[p]} · repo · ${plural(count(r), 'workspace')} · ${labelOf(s, p, s.assignments[p][REPO + r])}`,
        target: { repo: r } as Target
      })),
    ...s.workspaces
      .filter((w) => s.assignments[p][w.path])
      .map((w) => ({
        p,
        key: `${p}:${w.id}`,
        title: w.name,
        detail: `${PROVIDER_NAME[p]} · workspace in ${repoName(w.repo)} · ${labelOf(s, p, s.assignments[p][w.path])}`,
        target: { path: w.path } as Target
      }))
  ])

  const q = read(filter).trim().toLowerCase()
  const matches = q
    ? [...byRepo.entries()]
        .filter(
          ([r, ws]) =>
            !ws.some((w) => w.remote) &&
            (repoName(r).toLowerCase().includes(q) ||
              ws.some((w) => w.name.toLowerCase().includes(q) || (w.branch ?? '').toLowerCase().includes(q)))
        )
        .map(([r]) => r)
    : []
  const pickable = PROVIDERS.filter((p) => s.accounts[p].length > 1)

  return (
    <Stack gap="md">
      {read(saveError) ? (
        <Callout tone="danger" title="Could not save">{read(saveError)}</Callout>
      ) : null}
      {focused.length > 1 ? (
        <Callout tone="warning">
          {`${focused.length} workspaces are named ${focused[0].name}, and Orca does not say which one is focused. Pick in the right repo below.`}
        </Callout>
      ) : null}
      {focused.map((ws) => (
        <FocusedCard key={ws.id} ws={ws} s={s} ambiguous={focused.length > 1} count={count(ws.repo)} />
      ))}
      {focused.length === 0 ? (
        <Callout tone="neutral">Focus a workspace to pick its accounts.</Callout>
      ) : null}

      <Heading level={2}>In use</Heading>
      <Stack gap="sm">
        {rows.map((r) => (
          <InUseRow key={r.key} p={r.p} title={r.title} detail={r.detail} target={r.target} />
        ))}
        {PROVIDERS.map((p) => (
          <Text key={p} muted size="sm">
            {`${PROVIDER_NAME[p]}: ${rows.some((r) => r.p === p) ? 'everything else' : 'everything'} → ${labelOf(s, p, '')}`}
          </Text>
        ))}
      </Stack>

      {pickable.length ? (
        <Collapsible title="Assign another repo">
          <Stack gap="sm">
            <Input
              label="Find a repo"
              labelHidden
              type="search"
              placeholder={`Find one of ${byRepo.size} repos`}
              value={read(filter)}
              onChange={(v) => set(filter, v)}
            />
            {matches.slice(0, MAX_RESULTS).map((r) => (
              <Stack key={r} gap="xs">
                <Text weight="medium">{`${repoName(r)} (${plural(count(r), 'workspace')})`}</Text>
                {pickable.map((p) => (
                  <RepoPicker key={p} p={p} repo={r} s={s} label={PROVIDER_NAME[p]} />
                ))}
              </Stack>
            ))}
            {matches.length > MAX_RESULTS ? (
              <Text muted size="xs">
                {matches.length - MAX_RESULTS} more; type more of the name.
              </Text>
            ) : null}
          </Stack>
        </Collapsible>
      ) : null}

      <Separator />
      <Switch
        label="Trust workspaces for picked Claude accounts"
        checked={s.trust}
        onChange={(on) => void setTrust(on)}
      />
      <Text muted size="xs">
        With an account selected in Orca's Claude switcher, Orca trusts new folders in that account
        only, so a picked account would stop at Claude's trust prompt. This writes the trust there
        too, even for repos set to "let agents ask" in Orca. Turn it off if you rely on that.
      </Text>
      <Text muted size="xs">
        Applies to Claude and Codex agents Orca's launcher starts in a terminal. Running sessions keep
        their account; move one with /resume in a new tab. Chats, resumed and restored tabs, `orca
        terminal create --command`, and agents typed into a plain shell use Orca's own account setting.
      </Text>
    </Stack>
  )
}

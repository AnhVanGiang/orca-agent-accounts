// Panel <-> worker contract, read by src/panel.tsx and worker/main.ts.

/** Storage key prefix for a repo-wide assignment. */
export const REPO = 'repo:'

export const PROVIDERS = ['claude', 'codex'] as const
export type Provider = (typeof PROVIDERS)[number]
export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' }

/** id '' is the provider's own default home (~/.claude, ~/.codex). */
export type Account = { id: string; label: string; signedIn: boolean }
/** `repo` = main checkout path, shared by all of a repo's worktrees. `remote` = on another host. */
export type Workspace = {
  id: string
  name: string
  branch: string | null
  path: string
  repo: string
  remote: boolean
}
/** A Claude conversation running in an Orca terminal. `accountId` '' = ~/.claude. */
export type ClaudeTab = {
  terminalId: string
  pid: number
  sessionId: string
  path: string
  accountId: string
  /** Claude's own session name, shown when Orca gives no tab title. */
  name: string
}
/** What the panel sees of a tab in the focused workspace. */
export type TabInfo = { terminalId: string; title: string; accountId: string }
/** Worktree path, or `repo:<main checkout path>`, -> Orca account id. */
export type Assignments = Record<Provider, Record<string, string>>

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging
  interface PluginRequests {
    'accounts.state': {
      input: Record<string, never>
      output: {
        /** False off macOS: Orca's account folders are only located there. */
        supported: boolean
        accounts: Record<Provider, Account[]>
        workspaces: Workspace[]
        assignments: Assignments
        /** Workspaces matching the focused one; several when a name is reused across repos. */
        currentIds: string[]
        /** Claude tabs running in the focused workspace. */
        tabs: TabInfo[]
        /** Mark a workspace trusted in its assigned Claude account at launch (default on). */
        trust: boolean
      }
    }
    'accounts.assign': {
      /** One of path (this workspace) or repo (all its workspaces); null accountId clears. */
      input: { provider: Provider; path?: string; repo?: string; accountId: string | null }
      output: { ok: true }
    }
    'accounts.newTab': {
      /** Open a new agent tab on this account (null = Orca's default), whatever the repo or
       *  workspace is assigned. The workspace: `workspaceId` (an id from accounts.state) or `path`
       *  (any folder inside it). `prompt` is submitted once the agent is ready. */
      input: {
        provider: Provider
        workspaceId?: string
        path?: string
        accountId: string | null
        prompt?: string
      }
      output: { terminalId: string }
    }
    'accounts.tabs': {
      /** Every Claude conversation running in an Orca terminal on this Mac. */
      input: Record<string, never>
      output: {
        tabs: {
          terminalId: string
          name: string
          sessionId: string
          pid: number
          path: string
          workspaceId: string | null
          workspaceName: string | null
          accountId: string
          account: string
        }[]
      }
    }
    'accounts.moveTab': {
      /** Stop the tab's Claude and reopen its conversation on this account (null = default). */
      input: { terminalId: string; accountId: string | null }
      output: { terminalId: string }
    }
    'accounts.setTrust': {
      input: { on: boolean }
      output: { ok: true }
    }
  }
}

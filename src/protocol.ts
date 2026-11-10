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
      }
    }
    'accounts.assign': {
      /** One of path (this workspace) or repo (all its workspaces); null accountId clears. */
      input: { provider: Provider; path?: string; repo?: string; accountId: string | null }
      output: { ok: true }
    }
  }
}

import { defineCheck } from 'orca/testing'

const ws = (id: string, name: string, branch: string, path: string, repo: string) => ({
  id,
  name,
  branch,
  path,
  repo,
  remote: false
})

const state = {
  supported: true,
  accounts: {
    claude: [
      { id: '', label: 'Default (work@example.com)', signedIn: true },
      { id: 'p1', label: 'me@example.com', signedIn: true },
      { id: 'p2', label: 'p2 (signed out)', signedIn: false }
    ],
    codex: [{ id: '', label: "Orca's Codex setting", signedIn: true }]
  },
  workspaces: [
    ws('w1', 'app', 'main', '/r/app', '/r/app'),
    ws('w2', 'fix-x', 'fix/x', '/r/app/.worktrees/fix-x', '/r/app'),
    ws('w3', 'ops', 'main', '/r/ops', '/r/ops'),
    ws('w4', 'feat-y', 'feat/y', '/r/ops/.wt/feat-y', '/r/ops')
  ],
  assignments: { claude: { 'repo:/r/ops': 'p1', '/r/app/.worktrees/fix-x': 'p1' }, codex: {} },
  currentIds: ['w2'],
  tabs: [{ terminalId: 'term_1', title: 'fix-x agent', accountId: '' }],
  trust: true
}

const withCodex = {
  ...state,
  accounts: {
    ...state.accounts,
    codex: [...state.accounts.codex, { id: 'c1', label: 'me@example.com', signedIn: true }]
  },
  assignments: { ...state.assignments, codex: { 'repo:/r/app': 'c1' } }
}

export default defineCheck({
  loaded: { requests: { 'accounts.state': state } },
  'codex account added': { requests: { 'accounts.state': withCodex } },
  'tabs on two accounts': {
    requests: {
      'accounts.state': {
        ...state,
        tabs: [
          { terminalId: 'term_1', title: 'fix-x: review', accountId: '' },
          { terminalId: 'term_2', title: 'fix-x: tests', accountId: 'p1' },
          { terminalId: 'term_3', title: 'fix-x: docs', accountId: 'p1' }
        ]
      }
    }
  },
  'name in two repos': {
    requests: {
      'accounts.state': {
        ...state,
        workspaces: [...state.workspaces, ws('w5', 'fix-x', 'fix/x', '/r/ops/.wt/fix-x', '/r/ops')],
        currentIds: ['w2', 'w5']
      }
    }
  },
  'deleted account': {
    requests: {
      'accounts.state': { ...state, assignments: { claude: { 'repo:/r/app': 'gone' }, codex: {} } }
    }
  },
  'remote workspace': {
    requests: {
      'accounts.state': {
        ...state,
        workspaces: [{ ...state.workspaces[1], remote: true }, ...state.workspaces.slice(2)]
      }
    }
  },
  'not macOS': { requests: { 'accounts.state': { ...state, supported: false } } },
  'no focused workspace': { requests: { 'accounts.state': { ...state, currentIds: [] } } }
})

// Marks a workspace as trusted in an assigned Claude account, as Orca does for the account it
// launches with. Without it, every new worktree stops at Claude's trust prompt in that account.
// Same file format and locking as Orca's src/main/claude/claude-folder-trust-file.ts; ported via
// Claude Pin (github.com/tourbut/claude-pin, MIT).
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export type TrustOutcome = 'granted' | 'unchanged' | 'missing-config' | 'locked' | 'unreadable' | 'too-broad'

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Claude reads legacy `.config.json` first, else `.claude.json`, both in CLAUDE_CONFIG_DIR. */
const configFile = (home: string) =>
  existsSync(join(home, '.config.json')) ? join(home, '.config.json') : join(home, '.claude.json')

/** Claude looks a folder up by its NFC-normalized path; cover the symlinked and real forms. */
function keysOf(path: string): string[] {
  const forms = [resolve(path)]
  try {
    forms.push(realpathSync.native(path))
  } catch {}
  return [...new Set(forms.map((f) => normalize(f.normalize('NFC'))))]
}

/** Trust covers everything below a folder, so never the home folder, its parents or root. */
function tooBroad(folder: string): boolean {
  if (dirname(folder) === folder) return true
  const down = relative(folder, homedir())
  return down === '' || (!down.startsWith('..') && !isAbsolute(down))
}

function read(file: string): Json | null {
  try {
    const c: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isObject(c) && (c.projects === undefined || isObject(c.projects)) ? c : null
  } catch {
    return null
  }
}

const trusted = (c: Json, keys: string[]) =>
  keys.some((k) => {
    const e = (c.projects as Json | undefined)?.[k]
    return isObject(e) && e.hasTrustDialogAccepted === true
  })

export async function grantTrust(home: string, workspace: string): Promise<TrustOutcome> {
  const file = configFile(home)
  if (!existsSync(file)) return 'missing-config'
  const keys = keysOf(workspace)
  if (keys.some(tooBroad)) return 'too-broad'
  const first = read(file)
  if (!first) return 'unreadable'
  if (trusted(first, keys)) return 'unchanged'

  // Claude (proper-lockfile) locks `<file>.lock` as a directory, at the literal path.
  const lock = `${file}.lock`
  let held = false
  for (let i = 0; i < 5 && !held; i++) {
    try {
      mkdirSync(lock)
      held = true
    } catch {
      await sleep(50)
    }
  }
  if (!held) return 'locked'
  try {
    // Synchronous from here to the rename, so Claude's own writer cannot interleave.
    const current = read(file)
    if (!current) return 'unreadable'
    if (trusted(current, keys)) return 'unchanged'
    const projects: Json = { ...(current.projects as Json | undefined) }
    for (const k of keys) {
      const e = projects[k]
      projects[k] = isObject(e) ? { ...e, hasTrustDialogAccepted: true } : { hasTrustDialogAccepted: true }
    }
    const target = realpathSync(file) // keep a symlinked config a symlink
    const temp = `${target}.agent-accounts-${randomUUID()}.tmp`
    const mode = statSync(target).mode & 0o777
    try {
      writeFileSync(temp, `${JSON.stringify({ ...current, projects }, null, 2)}\n`, { flag: 'wx', mode })
      chmodSync(temp, mode) // undo umask narrowing
      renameSync(temp, target)
    } finally {
      rmSync(temp, { force: true })
    }
    return 'granted'
  } finally {
    rmdirSync(lock)
  }
}

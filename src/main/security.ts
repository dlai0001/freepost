/**
 * Collection secret-leak guardrails (PLAN.md §3 "Leak guardrails").
 *
 * The `.freepost/` folder holds request history and any acquired secrets, and
 * carries a self-regenerating `.gitignore` of `*`. These helpers add the two
 * companion guardrails: a check that nothing under `.freepost/` is actually
 * tracked by git (someone may have `git add -f`'d it), and restrictive file
 * permissions on the folder. Both are best-effort and never throw.
 */
import { execFile } from 'child_process'
import { chmod } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * Paths under `.freepost/` that git is tracking, if the collection is a git
 * repo. A non-empty result means secrets/history may be committed despite the
 * ignore file — the caller should warn prominently. Empty when the folder is
 * not a git repo, git is unavailable, or nothing is tracked.
 */
export async function trackedSecrets(root: string): Promise<string[]> {
  if (!existsSync(join(root, '.git'))) return []
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--', '.freepost'], {
      cwd: root
    })
    return stdout.split('\0').filter((p) => p.trim() !== '')
  } catch {
    return [] // git missing / not a repo / any failure — guardrail is best-effort
  }
}

/**
 * Tighten permissions on the `.freepost/` folder to owner-only (0700). No-op on
 * platforms/filesystems that don't support POSIX modes (e.g. Windows).
 */
export async function secureFreepostDir(dir: string): Promise<void> {
  try {
    await chmod(dir, 0o700)
  } catch {
    /* best-effort */
  }
}

/** Restrict a single file to owner read/write (0600). Best-effort. */
export async function secureFile(file: string): Promise<void> {
  try {
    await chmod(file, 0o600)
  } catch {
    /* best-effort */
  }
}

/**
 * Environment-file CRUD operations (create/write/delete/rename/duplicate).
 *
 * The renderer's environment-management screen drives these through the
 * `env:*` IPC channels. They live here (not inline in ipc-handlers) so the
 * filesystem behaviour — canonical serialization, `environments/` placement,
 * `.local` secret-suffix preservation, collision guards — is unit-testable
 * without the Electron IPC layer.
 */
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { dirname, join, relative, sep } from 'path'
import { isLocalEnv, sanitizeEnvName, serializeEnvFile } from '../core/env'
import { readEnvFile } from './execute'

/** Collection-relative, forward-slashed path (matches the rest of the IPC surface). */
function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/')
}

/** Filename for a base env name, honoring the git-ignored `.local` secret suffix. */
function envFilename(base: string, local: boolean): string {
  return `${base}${local ? '.local' : ''}.env.json`
}

/**
 * Create a new, empty environment under `environments/`.
 * `local` routes it to a git-ignored `*.local.env.json` for secrets.
 * Returns the new collection-relative path; throws if the name is invalid or
 * the file already exists.
 */
export async function createEnv(args: {
  root: string
  name: string
  local: boolean
}): Promise<string> {
  const base = sanitizeEnvName(args.name)
  if (base === '') throw new Error('Invalid environment name')
  const dir = join(args.root, 'environments')
  await fs.mkdir(dir, { recursive: true })
  const abs = join(dir, envFilename(base, args.local))
  if (existsSync(abs)) throw new Error('Environment already exists')
  await fs.writeFile(abs, serializeEnvFile({}))
  return toRel(args.root, abs)
}

/** Overwrite an environment file with `values` in canonical (sorted) form. */
export async function writeEnv(args: {
  root: string
  path: string
  values: Record<string, string>
}): Promise<void> {
  const abs = join(args.root, args.path)
  await fs.mkdir(dirname(abs), { recursive: true })
  await fs.writeFile(abs, serializeEnvFile(args.values))
}

/** Delete an environment file. */
export async function deleteEnv(args: { root: string; path: string }): Promise<void> {
  await fs.rm(join(args.root, args.path))
}

/**
 * Rename an environment in place (same folder, same secret-ness). Returns the
 * new collection-relative path; throws if the target name already exists.
 */
export async function renameEnv(args: {
  root: string
  path: string
  newName: string
}): Promise<string> {
  const base = sanitizeEnvName(args.newName)
  if (base === '') throw new Error('Invalid environment name')
  const oldAbs = join(args.root, args.path)
  const newAbs = join(dirname(oldAbs), envFilename(base, isLocalEnv(args.path)))
  if (newAbs !== oldAbs && existsSync(newAbs)) throw new Error('Environment already exists')
  await fs.rename(oldAbs, newAbs)
  return toRel(args.root, newAbs)
}

/**
 * Copy an environment's variables into a new file (same folder, same
 * secret-ness). Returns the new collection-relative path; throws if the target
 * already exists.
 */
export async function duplicateEnv(args: {
  root: string
  path: string
  newName: string
}): Promise<string> {
  const base = sanitizeEnvName(args.newName)
  if (base === '') throw new Error('Invalid environment name')
  const oldAbs = join(args.root, args.path)
  const newAbs = join(dirname(oldAbs), envFilename(base, isLocalEnv(args.path)))
  if (existsSync(newAbs)) throw new Error('Environment already exists')
  const values = readEnvFile(args.root, args.path)
  await fs.writeFile(newAbs, serializeEnvFile(values))
  return toRel(args.root, newAbs)
}

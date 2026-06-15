/**
 * Resolve the node binary path for Electron apps.
 *
 * When launched from Dock/Launchpad, macOS provides a minimal PATH that
 * doesn't include nvm, Homebrew, or Volta. This module finds the node
 * binary by checking common installation paths as fallback.
 *
 * Uses lazy resolution (not at module load time) to ensure PATH fixes
 * in main.ts have a chance to run first.
 */

import * as fs from 'fs'
import * as path from 'path'

const HOME = process.env.HOME || process.env.USERPROFILE || ''

interface NodeCandidate {
  type: 'versioned'
  dir: string
  binSubpath: string  // path from version dir to node binary
}

interface DirectCandidate {
  type: 'direct'
  path: string
}

type Candidate = NodeCandidate | DirectCandidate

function getCandidates(): Candidate[] {
  if (process.platform === 'darwin') {
    return [
      { type: 'versioned', dir: path.join(HOME, '.nvm', 'versions', 'node'), binSubpath: 'bin/node' },
      { type: 'versioned', dir: path.join(HOME, '.fnm', 'node-versions'), binSubpath: 'installation/bin/node' },
      { type: 'direct', path: '/opt/homebrew/bin/node' },
      { type: 'direct', path: '/usr/local/bin/node' },
      { type: 'direct', path: path.join(HOME, '.volta', 'bin', 'node') },
    ]
  } else if (process.platform === 'linux') {
    return [
      { type: 'versioned', dir: path.join(HOME, '.nvm', 'versions', 'node'), binSubpath: 'bin/node' },
      { type: 'versioned', dir: path.join(HOME, '.fnm', 'node-versions'), binSubpath: 'installation/bin/node' },
      { type: 'direct', path: '/usr/local/bin/node' },
      { type: 'direct', path: '/usr/bin/node' },
      { type: 'direct', path: path.join(HOME, '.volta', 'bin', 'node') },
    ]
  } else {
    // Windows
    const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local')
    return [
      { type: 'versioned', dir: path.join(HOME, 'AppData', 'Roaming', 'nvm'), binSubpath: 'node.exe' },
      { type: 'direct', path: 'C:\\Program Files\\nodejs\\node.exe' },
      { type: 'direct', path: path.join(HOME, '.volta', 'bin', 'node.exe') },
      // Claude Code iex installer bundled node
      { type: 'direct', path: path.join(LOCALAPPDATA, 'Programs', 'claude-code', 'node.exe') },
      { type: 'direct', path: path.join(HOME, '.claude', 'local', 'node.exe') },
      // fnm on Windows
      { type: 'versioned', dir: path.join(LOCALAPPDATA, 'fnm_multishells'), binSubpath: 'node.exe' },
      { type: 'versioned', dir: path.join(HOME, '.fnm', 'node-versions'), binSubpath: 'installation/node.exe' },
    ]
  }
}

/**
 * Compare two semver-like version strings (e.g., "v20.19.3" vs "v18.0.0").
 * Returns positive if a > b, negative if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Find the latest node binary in a versioned directory (e.g., ~/.nvm/versions/node/).
 * Only considers versions with major >= minimumMajor (default 18).
 * Returns the absolute path to the node binary, or null if not found.
 */
export function findLatestInVersionedDir(dir: string, binSubpath: string, minimumMajor: number = MINIMUM_NODE_MAJOR): string | null {
  try {
    let versions = fs.readdirSync(dir).filter(v => v.startsWith('v'))
    if (minimumMajor > 0) {
      versions = versions.filter(v => parseMajorVersion(v) >= minimumMajor)
    }
    if (versions.length === 0) return null
    versions.sort(compareVersions)
    const latest = versions[versions.length - 1]
    const nodeBin = path.join(dir, latest, binSubpath)
    if (fs.existsSync(nodeBin)) return nodeBin
  } catch { /* directory doesn't exist */ }
  return null
}

/** Minimum Node.js major version required by @anthropic-ai/claude-code */
const MINIMUM_NODE_MAJOR = 18

/**
 * Get the major version from a version string like "v16.14.0" or "20.11.0".
 */
function parseMajorVersion(versionStr: string): number {
  return parseInt(versionStr.replace(/^v/, '').split('.')[0], 10) || 0
}

/**
 * Resolve a node binary to a real path (following symlinks), then read its version.
 * Returns the major version number, or 0 if the version cannot be determined.
 */
function getNodeMajorVersion(nodePath: string): number {
  try {
    // Resolve symlinks to get to the actual binary
    const realPath = fs.realpathSync(nodePath)
    const { execSync } = require('child_process') as typeof import('child_process')
    const versionOutput = execSync(`"${realPath}" --version`, {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    }).trim()
    return parseMajorVersion(versionOutput)
  } catch {
    return 0
  }
}

/**
 * Scan process.env.PATH for a node binary that meets the minimum version requirement.
 */
function findNodeInPath(): string | null {
  const pathDirs = (process.env.PATH || '').split(path.delimiter)
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of pathDirs) {
    if (!dir) continue
    const candidate = path.join(dir, nodeName)
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        // Verify the version is compatible
        const major = getNodeMajorVersion(candidate)
        if (major >= MINIMUM_NODE_MAJOR) return candidate
      }
    } catch { /* skip */ }
  }
  return null
}

/**
 * Resolve the node binary path.
 *
 * Resolution order:
 * 1. Check version-managed directories (nvm, fnm) first — these contain
 *    explicitly installed versions, and we can pick the latest compatible one.
 * 2. Check current PATH for a compatible node binary.
 * 3. Check common installation locations (Homebrew, system, volta).
 * 4. Fallback: use Electron's own binary with ELECTRON_RUN_AS_NODE=1.
 */
export function resolveNodePath(): string {
  // 1. Check version-managed directories FIRST (nvm, fnm).
  //    These always have the user's preferred/managed versions and are more
  //    likely to be up-to-date than a stray /usr/local/bin/node from years ago.
  for (const entry of getCandidates()) {
    if (entry.type === 'versioned') {
      const found = findLatestInVersionedDir(entry.dir, entry.binSubpath, MINIMUM_NODE_MAJOR)
      if (found) return found
    }
  }

  // 2. Check current PATH (with version filter).
  const fromPath = findNodeInPath()
  if (fromPath) return fromPath

  // 3. Check direct installation locations.
  for (const entry of getCandidates()) {
    if (entry.type === 'direct') {
      try {
        if (fs.existsSync(entry.path)) {
          const major = getNodeMajorVersion(entry.path)
          if (major >= MINIMUM_NODE_MAJOR) return entry.path
        }
      } catch { /* skip */ }
    }
  }

  // 4. Fallback: use Electron's own binary with ELECTRON_RUN_AS_NODE=1
  //    This makes the Electron binary behave as a plain Node.js runtime.
  return process.execPath
}

// Lazy cached resolution
let cachedPath: string | null = null
let usingElectronFallback = false

/**
 * Get the resolved node binary path (lazy, cached).
 * First call triggers resolution; subsequent calls return cached result.
 */
export function getNodeExecutable(): string {
  if (cachedPath === null) {
    cachedPath = resolveNodePath()
    usingElectronFallback = cachedPath === process.execPath
  }
  return cachedPath
}

/**
 * Whether the resolved node binary is Electron's own binary (fallback).
 * When true, ELECTRON_RUN_AS_NODE=1 must be set in the subprocess env.
 */
export function isElectronFallback(): boolean {
  getNodeExecutable() // ensure resolution
  return usingElectronFallback
}

/**
 * Get extra bin directories for PATH augmentation (nvm, fnm, etc.).
 * Returns an array of bin directories that contain node.
 *
 * Not used internally — exported for external consumers and testing.
 */
export function getExtraNodePaths(): string[] {
  const extraPaths: string[] = []
  for (const entry of getCandidates()) {
    if (entry.type === 'versioned') {
      const found = findLatestInVersionedDir(entry.dir, entry.binSubpath)
      if (found) extraPaths.push(path.dirname(found))
    }
  }
  return extraPaths
}

/**
 * Reset cached path (for testing only).
 */
export function _resetCache(): void {
  cachedPath = null
}

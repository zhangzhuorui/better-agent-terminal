/**
 * Secret store: encrypts API keys using Electron safeStorage.
 *
 * On macOS this uses Keychain, on Windows DPAPI, on Linux libsecret/kwallet
 * (with `--password-store=basic` fallback). Falls back to plain text storage
 * with a warning when safeStorage is not available (e.g. in non-Electron
 * environments).
 */

import { safeStorage } from 'electron'
import { logger } from './logger'

const PLAIN_PREFIX = 'plain:'
const ENC_PREFIX = 'enc:'

/** Encrypt a plaintext secret. Returns a string safe to write into settings.json. */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(plaintext)
      return ENC_PREFIX + buf.toString('base64')
    }
  } catch (err) {
    logger.error('[secret-store] encrypt failed, falling back to plaintext', err)
  }
  // Fallback: store as plaintext (still scoped to user-only file permissions)
  return PLAIN_PREFIX + plaintext
}

/** Decrypt a value previously produced by encryptSecret. Returns '' on failure. */
export function decryptSecret(stored: string): string {
  if (!stored) return ''
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length)
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')
      return safeStorage.decryptString(buf)
    } catch (err) {
      logger.error('[secret-store] decrypt failed', err)
      return ''
    }
  }
  // Legacy/unknown — assume plaintext (back-compat)
  return stored
}

/** True when the encryption backend is available (Keychain/DPAPI/libsecret). */
export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

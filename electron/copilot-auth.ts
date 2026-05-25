/**
 * GitHub Device Flow for Copilot Chat authentication.
 *
 * Flow:
 *  1. POST github.com/login/device/code → device_code + user_code + verification_uri
 *  2. Open verification_uri in browser, user enters user_code
 *  3. Poll POST github.com/login/oauth/access_token until access_token is returned
 *  4. The resulting access_token is stored (encrypted) and exchanged for a
 *     short-lived Copilot session token on every chat request.
 *
 * We use the public VS Code Insiders client_id which is the canonical Editor
 * client for Copilot Chat.
 */

import { shell } from 'electron'
import { logger } from './logger'

// VS Code Insiders client_id (public, hard-coded in VS Code source)
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'

export interface DeviceFlowStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export interface DeviceFlowResult {
  ok: boolean
  accessToken?: string
  error?: string
}

/** Step 1: request a new device code. */
export async function startDeviceFlow(): Promise<DeviceFlowStart | null> {
  try {
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Editor-Version': 'better-agent-terminal/1.0',
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        scope: 'read:user',
      }),
    })

    if (!res.ok) {
      logger.error('[copilot-auth] device/code returned', res.status)
      return null
    }
    const data = await res.json() as {
      device_code: string
      user_code: string
      verification_uri: string
      expires_in: number
      interval: number
    }

    // Open the verification page in the user's browser
    try {
      await shell.openExternal(data.verification_uri)
    } catch { /* user can copy the URL */ }

    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval,
    }
  } catch (err) {
    logger.error('[copilot-auth] startDeviceFlow failed', err)
    return null
  }
}

/** Step 2: poll for the access token. Resolves when user finishes auth. */
export async function pollForAccessToken(deviceCode: string, intervalSec: number, expiresInSec: number): Promise<DeviceFlowResult> {
  const deadline = Date.now() + expiresInSec * 1000
  let interval = Math.max(intervalSec, 5) * 1000

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval))

    try {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: COPILOT_CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })

      if (!res.ok) continue

      const data = await res.json() as {
        access_token?: string
        token_type?: string
        error?: string
        interval?: number
      }

      if (data.access_token) {
        return { ok: true, accessToken: data.access_token }
      }

      switch (data.error) {
        case 'authorization_pending':
          continue
        case 'slow_down':
          interval += 5000
          continue
        case 'expired_token':
          return { ok: false, error: 'Device code expired. Please try again.' }
        case 'access_denied':
          return { ok: false, error: 'Authorization denied by user.' }
        default:
          if (data.error) {
            return { ok: false, error: `OAuth error: ${data.error}` }
          }
      }
    } catch (err) {
      logger.error('[copilot-auth] poll error', err)
      // Continue polling on network errors
    }
  }

  return { ok: false, error: 'Timed out waiting for authorization.' }
}

/** Verify a stored GitHub access_token by exchanging it for a Copilot session token. */
export async function verifyAccessToken(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        'Authorization': `token ${accessToken}`,
        'Accept': 'application/json',
      },
    })
    return res.ok
  } catch {
    return false
  }
}

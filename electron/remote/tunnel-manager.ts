import { networkInterfaces } from 'os'
import { logger } from '../logger'

export type TunnelMode = 'tailscale' | 'lan'

export interface TunnelResult {
  url: string
  token: string
  mode: TunnelMode
}

/**
 * Detect network IPs for mobile QR code connection.
 * Priority: Tailscale IP (100.x.x.x) > LAN IP.
 */
export function getConnectionUrl(port: number, token: string): TunnelResult | { error: string } {
  const tailscaleIp = getTailscaleIp()
  if (tailscaleIp) {
    const url = `ws://${tailscaleIp}:${port}`
    logger.log(`[TunnelManager] Tailscale IP found: ${url}`)
    return { url, token, mode: 'tailscale' }
  }

  const lanIp = getLanIp()
  if (lanIp) {
    const url = `ws://${lanIp}:${port}`
    logger.log(`[TunnelManager] LAN fallback: ${url}`)
    return { url, token, mode: 'lan' }
  }

  return { error: 'No network interface found' }
}

function getTailscaleIp(): string | null {
  const nets = networkInterfaces()
  for (const iface of Object.values(nets)) {
    if (!iface) continue
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal && net.address.startsWith('100.')) {
        return net.address
      }
    }
  }
  return null
}

function getLanIp(): string | null {
  const nets = networkInterfaces()
  for (const iface of Object.values(nets)) {
    if (!iface) continue
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('100.')) {
        return net.address
      }
    }
  }
  return null
}

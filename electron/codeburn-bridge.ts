import { spawn, execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { logger } from './logger'

export interface CodeburnReportOptions {
  period?: 'today' | 'week' | 'month' | '30days'
  provider?: 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi' | 'copilot' | 'all'
  project?: string
  exclude?: string
}

let cachedCliPath: string | null = null
let systemNodePath: string | null | undefined = undefined

function exists(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

/** 查找 codeburn CLI 可执行文件路径 */
function resolveCodeburnCli(): string | null {
  if (cachedCliPath) return cachedCliPath

  const candidates: string[] = []

  // 1. 开发环境 / 未打包：从项目根目录 node_modules 查找
  // vite-plugin-electron 在 dev 模式下 process.cwd() 通常是项目根目录
  candidates.push(path.join(process.cwd(), 'node_modules', 'codeburn', 'dist', 'cli.js'))

  // 2. 打包后 asarUnpack 路径
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'codeburn', 'dist', 'cli.js'),
      path.join(process.resourcesPath, 'app', 'node_modules', 'codeburn', 'dist', 'cli.js'),
    )
  }

  // 3. __dirname 相对路径（dev 和某些 prod 场景）
  candidates.push(path.join(__dirname, '..', 'node_modules', 'codeburn', 'dist', 'cli.js'))
  candidates.push(path.join(__dirname, '..', '..', 'node_modules', 'codeburn', 'dist', 'cli.js'))

  // 4. 使用 require.resolve（如果 CommonJS 兼容层可用）
  try {
    const resolved = require.resolve('codeburn/dist/cli.js')
    if (resolved) candidates.push(resolved)
  } catch { /* ignore */ }

  for (const p of candidates) {
    if (exists(p)) {
      cachedCliPath = p
      logger.log('[codeburn] resolved:', p)
      return cachedCliPath
    }
  }

  logger.warn('[codeburn] CLI not found. Searched:\n' + candidates.join('\n'))
  return null
}

/** 检测系统是否有 Node >= 22 */
function findSystemNode(): string | null {
  if (systemNodePath !== undefined) return systemNodePath

  try {
    const version = execSync('node --version', { encoding: 'utf-8', timeout: 5000 }).trim()
    const major = parseInt(version.replace(/^v/, '').split('.')[0], 10)
    if (major >= 22) {
      systemNodePath = 'node'
      logger.log(`[codeburn] system Node ${version} ok`)
      return systemNodePath
    }
    logger.log(`[codeburn] system Node ${version} < 22`)
  } catch {
    logger.log('[codeburn] system Node not found')
  }

  systemNodePath = null
  return null
}

/** 运行 codeburn report --format json */
export async function runCodeburnReport(options: CodeburnReportOptions = {}): Promise<unknown | null> {
  const cliPath = resolveCodeburnCli()
  if (!cliPath) {
    logger.warn('[codeburn] codeburn CLI not available')
    return null
  }

  const args = ['report', '--format', 'json']
  if (options.period) args.push('--period', options.period)
  if (options.provider && options.provider !== 'all') args.push('--provider', options.provider)
  if (options.project) args.push('--project', options.project)
  if (options.exclude) args.push('--exclude', options.exclude)

  const systemNode = findSystemNode()
  const useElectronRuntime = !systemNode
  const execPath = systemNode || process.execPath
  const env = useElectronRuntime
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' }
    : { ...process.env }

  if (useElectronRuntime) {
    logger.log('[codeburn] using Electron as Node runtime')
  }

  return new Promise((resolve) => {
    const proc = spawn(execPath, [cliPath, ...args], {
      env,
      timeout: 30000,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        logger.error(`[codeburn] exited ${code}, stderr:`, stderr.slice(0, 500))
        resolve(null)
        return
      }

      const jsonStart = stdout.lastIndexOf('\n{')
      const jsonString = jsonStart >= 0 ? stdout.slice(jsonStart + 1).trim() : stdout.trim()

      try {
        const report = JSON.parse(jsonString)
        resolve(report)
      } catch (e) {
        logger.error('[codeburn] JSON parse failed. stdout:', stdout.slice(0, 200))
        resolve(null)
      }
    })

    proc.on('error', (err) => {
      logger.error('[codeburn] spawn error:', err)
      resolve(null)
    })
  })
}

export function isCodeburnAvailable(): boolean {
  return resolveCodeburnCli() !== null
}

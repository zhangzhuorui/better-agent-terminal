import type { CreatePtyOptions } from './index'

interface ElectronAPI {
  platform: 'win32' | 'darwin' | 'linux'
  pty: {
    create: (options: CreatePtyOptions) => Promise<boolean>
    write: (id: string, data: string) => Promise<void>
    resize: (id: string, cols: number, rows: number) => Promise<void>
    kill: (id: string) => Promise<boolean>
    restart: (id: string, cwd: string, shell?: string) => Promise<boolean>
    getCwd: (id: string) => Promise<string | null>
    onOutput: (callback: (id: string, data: string) => void) => () => void
    onExit: (callback: (id: string, exitCode: number) => void) => () => void
  }
  workspace: {
    save: (data: string) => Promise<boolean>
    load: () => Promise<string | null>
    detach: (workspaceId: string) => Promise<boolean>
    reattach: (workspaceId: string) => Promise<boolean>
    getDetachedId: () => string | null
    onDetached: (callback: (workspaceId: string) => void) => () => void
    onReattached: (callback: (workspaceId: string) => void) => () => void
  }
  settings: {
    save: (data: string) => Promise<boolean>
    load: () => Promise<string | null>
    getShellPath: (shell: string) => Promise<string>
  }
  dialog: {
    selectFolder: () => Promise<string | null>
    selectImages: () => Promise<string[]>
    confirm: (message: string, title?: string) => Promise<boolean>
  }
  image: {
    readAsDataUrl: (filePath: string) => Promise<string>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
    openPath: (folderPath: string) => Promise<string>
  }
  app: {
    openNewInstance: (profileId: string) => Promise<void>
    getLaunchProfile: () => Promise<string | null>
    setDockBadge: (count: number) => Promise<void>
  }
  update: {
    check: () => Promise<unknown>
    getVersion: () => Promise<string>
  }
  clipboard: {
    saveImage: () => Promise<string | null>
    writeImage: (filePath: string) => Promise<boolean>
  }
  claude: {
    startSession: (sessionId: string, options: { cwd: string; prompt?: string; permissionMode?: string; model?: string }) => Promise<boolean>
    sendMessage: (sessionId: string, prompt: string, images?: string[], options?: { contextPackageIds?: string[]; analyticsSource?: 'user' | 'automation' }) => Promise<boolean>
    stopSession: (sessionId: string) => Promise<boolean>
    onMessage: (callback: (sessionId: string, message: unknown) => void) => () => void
    onToolUse: (callback: (sessionId: string, toolCall: unknown) => void) => () => void
    onToolResult: (callback: (sessionId: string, result: unknown) => void) => () => void
    onResult: (callback: (sessionId: string, result: unknown) => void) => () => void
    onError: (callback: (sessionId: string, error: string) => void) => () => void
    onStream: (callback: (sessionId: string, data: unknown) => void) => () => void
    onStatus: (callback: (sessionId: string, meta: unknown) => void) => () => void
    onModeChange: (callback: (sessionId: string, mode: string) => void) => () => void
    setPermissionMode: (sessionId: string, mode: string) => Promise<boolean>
    setModel: (sessionId: string, model: string) => Promise<boolean>
    setEffort: (sessionId: string, effort: string) => Promise<boolean>
    set1MContext: (sessionId: string, enable: boolean) => Promise<boolean>
    resetSession: (sessionId: string) => Promise<boolean>
    getSupportedModels: (sessionId: string) => Promise<Array<{ value: string; displayName: string; description: string }>>
    getAccountInfo: (sessionId: string) => Promise<{ email?: string; organization?: string; subscriptionType?: string } | null>
    getSupportedCommands: (sessionId: string) => Promise<Array<{ name: string; description: string; argumentHint: string }>>
    getSessionMeta: (sessionId: string) => Promise<Record<string, unknown> | null>
    getUsage: () => Promise<{ fiveHour: number | null; sevenDay: number | null; fiveHourReset: string | null; sevenDayReset: string | null } | null>
    resolvePermission: (sessionId: string, toolUseId: string, result: { behavior: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[]; message?: string; dontAskAgain?: boolean }) => Promise<boolean>
    resolveAskUser: (sessionId: string, toolUseId: string, answers: Record<string, string>) => Promise<boolean>
    listSessions: (cwd: string) => Promise<Array<{ sdkSessionId: string; timestamp: number; preview: string; messageCount: number; customTitle?: string; firstPrompt?: string; gitBranch?: string; createdAt?: number; summary?: string }>>
    resumeSession: (sessionId: string, sdkSessionId: string, cwd: string, model?: string) => Promise<boolean>
    forkSession: (sessionId: string) => Promise<{ newSdkSessionId: string } | null>
    stopTask: (sessionId: string, taskId: string) => Promise<boolean>
    restSession: (sessionId: string) => Promise<boolean>
    wakeSession: (sessionId: string) => Promise<boolean>
    isResting: (sessionId: string) => Promise<boolean>
    archiveMessages: (sessionId: string, messages: unknown[]) => Promise<boolean>
    loadArchived: (sessionId: string, offset: number, limit: number) => Promise<{ messages: unknown[]; total: number; hasMore: boolean }>
    clearArchive: (sessionId: string) => Promise<boolean>
    onHistory: (callback: (sessionId: string, items: unknown[]) => void) => () => void
    onPermissionRequest: (callback: (sessionId: string, data: unknown) => void) => () => void
    onAskUser: (callback: (sessionId: string, data: unknown) => void) => () => void
    onAskUserResolved: (callback: (sessionId: string, toolUseId: string) => void) => () => void
    onPermissionResolved: (callback: (sessionId: string, toolUseId: string) => void) => () => void
    onSessionReset: (callback: (sessionId: string) => void) => () => void
    onPromptSuggestion: (callback: (sessionId: string, suggestion: string) => void) => () => void
  }
  git: {
    getGithubUrl: (folderPath: string) => Promise<string | null>
    getBranch: (cwd: string) => Promise<string | null>
    getLog: (cwd: string, count?: number) => Promise<Array<{ hash: string; author: string; date: string; message: string }>>
    getDiff: (cwd: string, commitHash?: string, filePath?: string) => Promise<string>
    getDiffFiles: (cwd: string, commitHash?: string) => Promise<Array<{ status: string; file: string }>>
    getStatus: (cwd: string) => Promise<Array<{ status: string; file: string }>>
    getRoot: (cwd: string) => Promise<string | null>
  }
  fs: {
    readdir: (dirPath: string) => Promise<Array<{ name: string; path: string; isDirectory: boolean }>>
    readFile: (filePath: string) => Promise<{ content?: string; error?: string; size?: number }>
    search: (dirPath: string, query: string) => Promise<Array<{ name: string; path: string; isDirectory: boolean }>>
    watch: (dirPath: string) => Promise<boolean>
    unwatch: (dirPath: string) => Promise<boolean>
    onChanged: (callback: (dirPath: string) => void) => () => void
  }
  profile: {
    list: () => Promise<{ profiles: Array<{ id: string; name: string; type: 'local' | 'remote'; remoteHost?: string; remotePort?: number; remoteToken?: string; createdAt: number; updatedAt: number }>; activeProfileId: string }>
    create: (name: string, options?: { type?: 'local' | 'remote'; remoteHost?: string; remotePort?: number; remoteToken?: string }) => Promise<{ id: string; name: string; type: 'local' | 'remote'; createdAt: number; updatedAt: number }>
    save: (profileId: string) => Promise<boolean>
    load: (profileId: string) => Promise<unknown>
    delete: (profileId: string) => Promise<boolean>
    rename: (profileId: string, newName: string) => Promise<boolean>
    update: (profileId: string, updates: { remoteHost?: string; remotePort?: number; remoteToken?: string }) => Promise<boolean>
    duplicate: (profileId: string, newName: string) => Promise<{ id: string; name: string; createdAt: number; updatedAt: number } | null>
    get: (profileId: string) => Promise<{ id: string; name: string; type: 'local' | 'remote'; remoteHost?: string; remotePort?: number; remoteToken?: string } | null>
    getActiveId: () => Promise<string>
    setActiveId: (profileId: string) => Promise<void>
  }
  remote: {
    startServer: (port?: number, token?: string) => Promise<{ port: number; token: string } | { error: string }>
    stopServer: () => Promise<boolean>
    serverStatus: () => Promise<{ running: boolean; port: number | null; clients: Array<{ label: string; connectedAt: number }> }>
    connect: (host: string, port: number, token: string, label?: string) => Promise<{ connected: boolean } | { error: string }>
    disconnect: () => Promise<boolean>
    clientStatus: () => Promise<{ connected: boolean; info: { host: string; port: number } | null }>
    testConnection: (host: string, port: number, token: string) => Promise<{ ok: boolean }>
  }
  tunnel: {
    getConnection: () => Promise<{ url: string; token: string; mode: string } | { error: string }>
  }
  system: {
    onResume: (callback: () => void) => () => void
  }
  debug: {
    log: (...args: unknown[]) => void
  }
  contextPackage: {
    list: () => Promise<unknown[]>
    get: (id: string) => Promise<unknown | null>
    create: (input: { name: string; description?: string; content: string; tags?: string[]; workspaceRoot?: string }) => Promise<unknown>
    update: (id: string, updates: Partial<{ name: string; description?: string; content: string; tags?: string[]; workspaceRoot?: string }>) => Promise<unknown | null>
    delete: (id: string) => Promise<boolean>
  }
  analytics: {
    getSummary: () => Promise<unknown>
  }
  automation: {
    list: () => Promise<unknown[]>
    saveAll: (jobs: unknown[]) => Promise<boolean>
    runNow: (id: string) => Promise<{ ok: boolean; error?: string }>
  }
  snippet: {
    getAll: () => Promise<unknown[]>
    getById: (id: number) => Promise<unknown | null>
    create: (input: { title: string; content: string; format?: string; category?: string; tags?: string; isFavorite?: boolean }) => Promise<unknown>
    update: (id: number, updates: Partial<{ title?: string; content?: string; format?: string; category?: string; tags?: string; isFavorite?: boolean }>) => Promise<unknown>
    delete: (id: number) => Promise<boolean>
    toggleFavorite: (id: number) => Promise<unknown>
    search: (query: string) => Promise<unknown[]>
    getCategories: () => Promise<string[]>
    getFavorites: () => Promise<unknown[]>
  }
  contentSearch: {
    searchMessages: (sessionId: string, query: string) => Promise<unknown[]>
    searchContextPackages: (query: string) => Promise<unknown[]>
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}

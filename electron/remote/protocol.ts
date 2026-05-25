export type RemoteFrameType = 'invoke' | 'invoke-result' | 'invoke-error' | 'event' | 'auth' | 'auth-result' | 'ping' | 'pong'

export interface RemoteFrame {
  type: RemoteFrameType
  id: string
  channel?: string
  args?: unknown[]
  result?: unknown
  error?: string
  token?: string
}

// Channels proxied to remote host
export const PROXIED_CHANNELS = new Set([
  // PTY
  'pty:create', 'pty:write', 'pty:resize', 'pty:kill', 'pty:restart', 'pty:get-cwd',
  // Claude
  'claude:start-session', 'claude:send-message', 'claude:stop-session',
  // Platform extensions
  'contextPackage:list', 'contextPackage:get', 'contextPackage:create', 'contextPackage:update', 'contextPackage:delete',
  'contextPackage:generateMetadata', 'contextPackage:enrichMetadata', 'contextPackage:metadataStatus',
  'contextRetrieval:recommend', 'contextRetrieval:plan', 'contextRetrieval:cacheStats', 'contextRetrieval:clearCache', 'contextRetrieval:rebuildIndex',
  'analytics:getSummary', 'analytics:getCodeburnReport', 'analytics:isCodeburnAvailable',
  'automation:list', 'automation:saveAll', 'automation:runNow',
  'claude:set-permission-mode', 'claude:set-model', 'claude:set-effort', 'claude:set-1m-context', 'claude:reset-session',
  'claude:get-supported-models', 'claude:get-account-info', 'claude:get-supported-commands', 'claude:get-session-meta',
  'claude:resolve-permission', 'claude:resolve-ask-user',
  'claude:list-sessions', 'claude:resume-session', 'claude:fork-session', 'claude:stop-task', 'claude:rest-session',
  'claude:wake-session', 'claude:is-resting',
  'claude:archive-messages', 'claude:load-archived', 'claude:clear-archive',
  'claude:get-usage',
  'contentSearch:session-messages', 'contentSearch:context-packages',
  // Injection rules
  'injectionRule:list', 'injectionRule:create', 'injectionRule:update', 'injectionRule:delete', 'injectionRule:evaluate',
  // Trace store
  'trace:query', 'trace:stats', 'trace:trim',
  // Audit engine
  'audit:report', 'audit:trim',
  // Retrieval engine
  'search:content', 'search:files',
  // MCP
  'mcp:list', 'mcp:get', 'mcp:create', 'mcp:update', 'mcp:delete', 'mcp:healthCheck',
  // Workflow
  'workflow:list', 'workflow:get', 'workflow:create', 'workflow:update', 'workflow:delete',
  'workflow:execute', 'workflow:executions', 'workflow:getExecution', 'workflow:cancelExecution',
  // Workspace
  'workspace:save', 'workspace:load',
  // Settings
  'settings:save', 'settings:load', 'settings:get-shell-path',
  // Agent
  'agent:check-local-configs',
  // Built-in agent (in-process HTTP backend)
  'builtin-agent:start-session', 'builtin-agent:send-message', 'builtin-agent:stop-session',
  'builtin-agent:get-session-state', 'builtin-agent:set-model', 'builtin-agent:get-models',
  // Secret store
  'secret:encrypt', 'secret:decrypt', 'secret:isEncryptionAvailable',
  // Copilot auth
  'copilot-auth:start', 'copilot-auth:poll', 'copilot-auth:verify',
  // Git
  'git:branch', 'git:log', 'git:diff', 'git:diff-files', 'git:status', 'git:get-github-url', 'git:getRoot',
  'git:stash', 'git:blame', 'git:branchGraph',
  // FS
  'fs:readdir', 'fs:readFile', 'fs:search',
  // Snippet
  'snippet:getAll', 'snippet:getById', 'snippet:create', 'snippet:update',
  'snippet:delete', 'snippet:toggleFavorite', 'snippet:search',
  'snippet:getCategories', 'snippet:getFavorites',
  // Profile
  'profile:list', 'profile:load', 'profile:get-active-id', 'profile:set-active',
])

// Events pushed from host to remote clients
export const PROXIED_EVENTS = new Set([
  'pty:output', 'pty:exit',
  'claude:message', 'claude:tool-use', 'claude:tool-result',
  'claude:stream', 'claude:result', 'claude:error',
  'claude:status', 'claude:permission-request', 'claude:permission-resolved', 'claude:ask-user', 'claude:ask-user-resolved',
  'claude:modeChange', 'claude:history', 'claude:prompt-suggestion', 'claude:session-reset', 'claude:context-plan',
  // Built-in agent events
  'builtin-agent:message', 'builtin-agent:status', 'builtin-agent:stream',
  'builtin-agent:result', 'builtin-agent:error',
  'fs:changed',
  'workspace:detached', 'workspace:reattached',
  'system:resume',
])

/**
 * Agent 預設配置
 * 定義支援的 AI Agent CLI 工具及其屬性
 */

export interface AgentPreset {
  id: string;
  name: string;
  icon: string;
  color: string;
  command?: string;  // 可選的自動啟動命令
  /** Agent 類型：sdk = 深度 SDK 整合（如 Claude），cli = 終端 CLI 工具（如 Codex），api = API 呼叫（如 Gemini） */
  type: 'sdk' | 'cli' | 'api' | 'none';
  /** 是否需要 API Key */
  requiresApiKey?: boolean;
  /** API Key 環境變數名稱 */
  apiKeyEnvVar?: string;
  /** 支援額外參數 */
  supportsArgs?: boolean;
  /** 安裝/文件連結 */
  docsUrl?: string;
  /** 是否支援深度工作流編排（等待完成、工具呼叫追蹤） */
  supportsWorkflow?: boolean;
}

export type AgentPresetId = 'claude-code' | 'gemini-cli' | 'codex-cli' | 'copilot-cli' | 'none';

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: '✦',
    color: '#d97706',
    command: 'claude --continue',
    type: 'sdk',
    requiresApiKey: false,
    supportsArgs: true,
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    supportsWorkflow: true,
  },
  {
    id: 'codex-cli',
    name: 'Codex',
    icon: '⬡',
    color: '#10a37f',
    command: 'codex',
    type: 'cli',
    requiresApiKey: true,
    apiKeyEnvVar: 'OPENAI_API_KEY',
    supportsArgs: true,
    docsUrl: 'https://github.com/openai/codex',
    supportsWorkflow: true,
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    icon: '◇',
    color: '#4285f4',
    command: 'gemini',
    type: 'cli',
    requiresApiKey: true,
    apiKeyEnvVar: 'GOOGLE_API_KEY',
    supportsArgs: false,
    docsUrl: 'https://ai.google.dev/',
    supportsWorkflow: false,
  },
  {
    id: 'copilot-cli',
    name: 'GitHub Copilot',
    icon: '⬢',
    color: '#6e40c9',
    command: 'gh copilot',
    type: 'cli',
    requiresApiKey: false,
    supportsArgs: false,
    docsUrl: 'https://docs.github.com/en/copilot',
    supportsWorkflow: false,
  },
  {
    id: 'none',
    name: 'Terminal',
    icon: '⌘',
    color: '#888888',
    type: 'none',
  },
];

/** 取得所有非 Terminal 的 Agent 預設 */
export function getAgentPresets(): AgentPreset[] {
  return AGENT_PRESETS.filter(p => p.id !== 'none');
}

export function getAgentPreset(id: string): AgentPreset | undefined {
  return AGENT_PRESETS.find(p => p.id === id);
}

export function getDefaultAgentPreset(): AgentPreset {
  return AGENT_PRESETS.find(p => p.id === 'claude-code') || AGENT_PRESETS[0];
}

/** 判斷 Agent 是否支援深度工作流編排 */
export function agentSupportsWorkflow(presetId: string): boolean {
  const preset = getAgentPreset(presetId);
  return preset?.supportsWorkflow ?? false;
}

/** 判斷 Agent 類型 */
export function getAgentType(presetId: string): 'sdk' | 'cli' | 'api' | 'none' {
  const preset = getAgentPreset(presetId);
  return preset?.type ?? 'none';
}

/** 判斷是否為 SDK 整合型 Agent（目前有 Claude Code） */
export function isSdkAgent(presetId: string): boolean {
  return getAgentType(presetId) === 'sdk';
}

/** 判斷是否為 CLI 型 Agent（Codex、Gemini、Copilot） */
export function isCliAgent(presetId: string): boolean {
  return getAgentType(presetId) === 'cli';
}

/**
 * Intent Classifier — local rule-based extraction of task type and tech stack
 * from user prompts. No external API calls, fully privacy-preserving.
 */

export type TaskIntent =
  | 'debug'
  | 'refactor'
  | 'write'
  | 'test'
  | 'docs'
  | 'review'
  | 'optimize'
  | 'explain'
  | 'setup'
  | 'general'

export interface TechStack {
  languages: string[]
  frameworks: string[]
  tools: string[]
}

export interface IntentResult {
  intents: TaskIntent[]
  confidence: number
  techStack: TechStack
  extractedKeywords: string[]
}

const INTENT_RULES: Record<TaskIntent, string[]> = {
  debug: ['debug', 'fix', 'error', 'bug', 'crash', 'exception', 'broken', 'fails', 'not working', 'doesn\'t work', 'won\'t', 'traceback', 'segmentation fault', 'null pointer', 'undefined', 'issue'],
  refactor: ['refactor', 'rewrite', 'restructure', 'clean up', 'cleanup', 'simplify', 'modernize', 'migrate', 'upgrade', 'deprecat', 'legacy', 'technical debt'],
  write: ['write', 'create', 'implement', 'build', 'add', 'generate', 'develop', 'new feature', 'support', 'introduce'],
  test: ['test', 'testing', 'unit test', 'e2e', 'spec', 'jest', 'vitest', 'mocha', 'coverage', 'mock', 'assert', 'benchmark', 'performance test'],
  docs: ['document', 'readme', 'comment', 'jsdoc', 'swagger', 'api doc', 'changelog', 'guide', 'tutorial', 'explain how'],
  review: ['review', 'audit', 'check', 'validate', 'verify', 'inspect', 'analyze code', 'code review', 'security audit', 'lint'],
  optimize: ['optimize', 'performance', 'speed', 'memory', 'cpu', 'cache', 'bottleneck', 'slow', 'lag', 'efficient', 'async', 'parallel', 'concurrent'],
  explain: ['explain', 'how does', 'why', 'what is', 'describe', 'understand', 'clarify', 'meaning', 'purpose', 'concept'],
  setup: ['setup', 'install', 'configure', 'deploy', 'docker', 'ci/cd', 'pipeline', 'build', 'environment', 'init', 'scaffold', 'boilerplate'],
  general: [],
}

const TECH_LANGUAGES: Record<string, string[]> = {
  typescript: ['typescript', 'ts', '.ts', 'tsx', '.tsx'],
  javascript: ['javascript', 'js', '.js', 'jsx', '.jsx', 'node.js', 'nodejs'],
  python: ['python', 'py', '.py', 'django', 'flask', 'fastapi'],
  rust: ['rust', 'cargo', 'rs', '.rs', 'tokio', 'axum'],
  go: ['golang', 'go', '.go', 'gin', 'echo'],
  java: ['java', 'spring', 'springboot', 'maven', 'gradle', '.java'],
  'c++': ['c++', 'cpp', 'cxx', '.cpp', '.hpp', '.cc'],
  c: [' c ', '.c', '.h', 'clang'],
  csharp: ['csharp', 'c#', '.cs', 'dotnet', '.net'],
  ruby: ['ruby', 'rails', 'rb', '.rb'],
  php: ['php', 'laravel', 'symfony', '.php'],
  swift: ['swift', 'swiftui', '.swift', 'ios'],
  kotlin: ['kotlin', 'ktor', '.kt', '.kts', 'android'],
  scala: ['scala', 'akka', '.scala'],
  sql: ['sql', 'postgresql', 'mysql', 'sqlite', 'prisma'],
  shell: ['bash', 'zsh', 'shell', 'sh', 'powershell', 'pwsh', 'cmd'],
  yaml: ['yaml', 'yml', 'docker-compose'],
  json: ['json', 'json schema'],
  css: ['css', 'scss', 'sass', 'less', 'tailwind', 'styled-components'],
  html: ['html', 'htm', 'jsx', 'tsx', 'vue', 'svelte'],
  markdown: ['markdown', 'md', 'mdx'],
}

const TECH_FRAMEWORKS: Record<string, string[]> = {
  react: ['react', 'next.js', 'nextjs', 'remix', 'gatsby'],
  vue: ['vue', 'vue.js', 'nuxt', 'nuxt.js', 'pinia'],
  angular: ['angular', 'ng ', 'angular.js'],
  svelte: ['svelte', 'sveltekit'],
  electron: ['electron', 'electron forge'],
  express: ['express', 'express.js'],
  nestjs: ['nestjs', 'nest.js'],
  django: ['django'],
  flask: ['flask'],
  fastapi: ['fastapi'],
  rails: ['ruby on rails', 'rails'],
  laravel: ['laravel'],
  spring: ['spring', 'spring boot', 'springboot'],
  flutter: ['flutter', 'dart'],
  reactnative: ['react native'],
  terraform: ['terraform', 'pulumi', 'cdktf'],
  kubernetes: ['kubernetes', 'k8s', 'helm', 'kubectl'],
  docker: ['docker', 'dockerfile', 'docker-compose', 'container'],
  aws: ['aws', 'amazon web services', 'lambda', 's3', 'ec2', 'cloudformation'],
  azure: ['azure', 'azure devops', 'arm template'],
  gcp: ['gcp', 'google cloud', 'firebase'],
}

const TECH_TOOLS: Record<string, string[]> = {
  git: ['git', 'github', 'gitlab', 'bitbucket', 'merge', 'commit', 'branch', 'pull request', 'pr '],
  webpack: ['webpack', 'vite', 'rollup', 'esbuild', 'parcel', 'bundler'],
  jest: ['jest', 'vitest', 'mocha', 'chai', 'cypress', 'playwright'],
  eslint: ['eslint', 'prettier', 'stylelint', 'biome'],
  prisma: ['prisma', 'orm', 'drizzle'],
  redis: ['redis', 'cache'],
  mongo: ['mongodb', 'mongoose', 'mongo'],
  postgres: ['postgresql', 'postgres', 'psql'],
  mysql: ['mysql', 'mariadb'],
  graphql: ['graphql', 'apollo', 'relay', 'hasura'],
  websocket: ['websocket', 'socket.io', 'ws ', 'webrtc'],
  grpc: ['grpc', 'protobuf', 'proto'],
  openapi: ['openapi', 'swagger', 'rest api', 'api spec'],
}

function countMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase()
  return keywords.reduce((sum, kw) => sum + (lower.includes(kw.toLowerCase()) ? 1 : 0), 0)
}

function extractMatches(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase()
  return keywords.filter(kw => lower.includes(kw.toLowerCase()))
}

export function classifyIntent(prompt: string): IntentResult {
  const lower = prompt.toLowerCase()
  const words = lower.split(/[^a-z0-9]+/).filter(w => w.length >= 2)

  // Intent scoring
  const intentScores: Record<string, number> = {}
  for (const [intent, keywords] of Object.entries(INTENT_RULES)) {
    if (intent === 'general') continue
    let score = 0
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) {
        score += kw.length >= 8 ? 1.5 : kw.length >= 5 ? 1.2 : 1.0
      }
    }
    if (score > 0) intentScores[intent] = score
  }

  const sortedIntents = Object.entries(intentScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => k as TaskIntent)

  const intents: TaskIntent[] = sortedIntents.length > 0 ? sortedIntents : ['general']
  const maxScore = Math.max(0, ...Object.values(intentScores))
  const confidence = Math.min(1, maxScore / 3)

  // Tech stack extraction
  const languages: string[] = []
  const frameworks: string[] = []
  const tools: string[] = []

  for (const [name, keywords] of Object.entries(TECH_LANGUAGES)) {
    if (countMatches(lower, keywords) > 0 && !languages.includes(name)) {
      languages.push(name)
    }
  }

  for (const [name, keywords] of Object.entries(TECH_FRAMEWORKS)) {
    if (countMatches(lower, keywords) > 0 && !frameworks.includes(name)) {
      frameworks.push(name)
    }
  }

  for (const [name, keywords] of Object.entries(TECH_TOOLS)) {
    if (countMatches(lower, keywords) > 0 && !tools.includes(name)) {
      tools.push(name)
    }
  }

  // Extracted keywords (file-like paths + tech identifiers)
  const fileLike = prompt.match(/[\w@./-]+\.(?:ts|tsx|js|jsx|json|css|scss|md|py|rs|go|java|yml|yaml)/g) ?? []
  const identifiers = prompt.match(/\b[A-Za-z_$][\w$]{2,}\b/g) ?? []
  const extractedKeywords = [...new Set([...fileLike, ...identifiers])].slice(0, 8)

  return {
    intents,
    confidence,
    techStack: { languages, frameworks, tools },
    extractedKeywords,
  }
}

/** Boost a context package score based on intent/tech-stack alignment. */
export function scoreByIntent(
  intent: IntentResult,
  pkgMetadata?: {
    language?: string
    framework?: string
    autoTags?: string[]
    keywords?: string[]
    summary?: string
    shortSummary?: string
  }
): { boost: number; reasons: string[] } {
  if (!pkgMetadata) return { boost: 0, reasons: [] }
  const reasons: string[] = []
  let boost = 0

  const metaText = `${pkgMetadata.language ?? ''} ${pkgMetadata.framework ?? ''} ${pkgMetadata.autoTags?.join(' ') ?? ''} ${pkgMetadata.keywords?.join(' ') ?? ''} ${pkgMetadata.summary ?? ''}`.toLowerCase()

  // Language match
  for (const lang of intent.techStack.languages) {
    if (metaText.includes(lang.toLowerCase())) {
      boost += 0.08
      reasons.push(`${lang} language match`)
    }
  }

  // Framework match
  for (const fw of intent.techStack.frameworks) {
    if (metaText.includes(fw.toLowerCase())) {
      boost += 0.1
      reasons.push(`${fw} framework match`)
    }
  }

  // Tool match
  for (const tool of intent.techStack.tools) {
    if (metaText.includes(tool.toLowerCase())) {
      boost += 0.06
      reasons.push(`${tool} tool match`)
    }
  }

  // Intent-specific tag matching
  for (const intentType of intent.intents) {
    if (metaText.includes(intentType.toLowerCase())) {
      boost += 0.05
      reasons.push(`${intentType} intent match`)
    }
  }

  return { boost: Math.min(0.35, boost), reasons }
}

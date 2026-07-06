/**
 * Unit tests for electron/context-structured-compressor.ts
 *
 * Run: npx tsx tests/context-structured-compressor.test.ts
 */

import * as assert from 'assert'
import {
  detectContentType,
  compressJson,
  compressTypeScript,
  compressMarkdown,
  buildRetrieveIdMap,
  compressWithRetrieveIds,
  decompressRetrieveIds,
  compressStructured,
} from '../electron/context-structured-compressor'
import { estimateTokens } from '../electron/context-metadata-engine'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ❌ ${name}`)
    console.log(`     ${(e as Error).message}`)
    failed++
  }
}

// === detectContentType ===
console.log('\ndetectContentType:')

test('detects JSON object', () => {
  assert.strictEqual(detectContentType('{"a": 1}'), 'json')
})

test('detects JSON array', () => {
  assert.strictEqual(detectContentType('[1, 2, 3]'), 'json')
})

test('detects markdown', () => {
  assert.strictEqual(detectContentType('# Title\n\nBody'), 'markdown')
})

test('detects code', () => {
  assert.strictEqual(detectContentType('function foo() { return 1 }'), 'code')
})

test('detects text', () => {
  assert.strictEqual(detectContentType('Hello world'), 'text')
})

// === compressJson ===
console.log('\ncompressJson:')

test('minifies JSON and samples arrays', () => {
  const arr = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `item-${i}` }))
  const content = JSON.stringify({ items: arr }, null, 2)
  const result = compressJson(content)
  assert.strictEqual(result.mode, 'json')
  assert.ok(result.tokenEstimate < result.originalTokens, 'should reduce tokens')
  assert.ok(result.body.includes('items omitted'), 'should sample large arrays')
})

// === compressTypeScript ===
console.log('\ncompressTypeScript:')

test('elides function bodies not matching query', () => {
  const content = `
export function keepMe() {
  const x = 1
  return x + 1
}

function dropMe() {
  const y = 2
  return y * 2
}
`
  const result = compressTypeScript(content, [])
  assert.strictEqual(result.mode, 'code')
  assert.ok(result.body.includes('keepMe'), 'should keep exported function name')
  assert.ok(result.body.includes('dropMe'), 'should keep private function name')
  assert.ok(!result.body.includes('const y = 2'), 'should elide private function body')
})

test('preserves body for query term match', () => {
  const content = `
function targetFunc() {
  const secret = 42
  return secret
}
`
  const result = compressTypeScript(content, ['targetfunc'])
  assert.ok(result.body.includes('secret = 42'), 'should preserve body for query match')
})

test('elides nested function bodies once without offset corruption', () => {
  const content = `
function outer() {
  function inner() {
    const x = 1
    return x
  }
  return inner()
}
`
  const result = compressTypeScript(content, [])
  assert.ok(result.body.includes('function outer()'), 'should keep outer signature')
  assert.ok(!result.body.includes('const x = 1'), 'should elide nested body')
  assert.ok(!result.body.includes('function inner() { /* body omitted'), 'nested function body should not appear as separate replacement')
  assert.strictEqual((result.body.match(/body omitted/g) || []).length, 1, 'should emit exactly one body-omitted replacement')
})

// === compressMarkdown ===
console.log('\ncompressMarkdown:')

test('preserves headings and code blocks', () => {
  const content = `# Title

First paragraph with some text here.
Second sentence in the same paragraph.

\`\`\`ts
const x = 1
\`\`\`
`
  const result = compressMarkdown(content, [])
  assert.strictEqual(result.mode, 'markdown')
  assert.ok(result.body.includes('# Title'), 'should keep heading')
  assert.ok(result.body.includes('const x = 1'), 'should keep code block')
})

// === retrieve-ID ===
console.log('\nretrieve-ID compression:')

test('builds map for long identifiers', () => {
  const content = 'function veryLongFunctionName() {}'
  const map = buildRetrieveIdMap(content)
  assert.ok(Object.keys(map).length > 0, 'should create retrieve IDs')
  const compressed = compressWithRetrieveIds(content, map)
  assert.ok(compressed !== content, 'should compress content')
  assert.strictEqual(decompressRetrieveIds(compressed, map), content, 'should round-trip')
})

test('round-trips multiple retrieve IDs without substring corruption', () => {
  const content = 'function alphaBetaGammaDelta() { return oneTwoThreeFourFiveSixSevenEightNineTen }'
  const map: Record<string, string> = {
    '@r1@': 'alphaBetaGammaDelta',
    '@r10@': 'oneTwoThreeFourFiveSixSevenEightNineTen',
  }
  const compressed = compressWithRetrieveIds(content, map)
  const decompressed = decompressRetrieveIds(compressed, map)
  assert.strictEqual(decompressed, content, 'should round-trip without @r1@ corrupting @r10@')
})

// === compressStructured dispatch ===
console.log('\ncompressStructured dispatch:')

test('returns structured variant for JSON', () => {
  const content = JSON.stringify({ a: 1, b: 2 })
  const result = compressStructured(content)
  assert.strictEqual(result.mode, 'json')
})

test('returns structured variant for markdown', () => {
  const content = '# Doc\n\nParagraph one. Paragraph two.'
  const result = compressStructured(content)
  assert.strictEqual(result.mode, 'markdown')
})

test('falls back to text for plain prose', () => {
  const content = 'This is just plain text without any structure.'
  const result = compressStructured(content)
  assert.strictEqual(result.mode, 'text')
  assert.strictEqual(result.body, content)
})

// === token estimation ===
console.log('\ntoken estimation:')

test('JSON uses lower density than text', () => {
  const json = '{"key1": "value one", "key2": "value two", "key3": "value three"}'
  assert.ok(estimateTokens(json, 'json') < estimateTokens(json, 'text'), 'json should have lower token estimate')
})

// === Summary ===
console.log(`\n${'='.repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

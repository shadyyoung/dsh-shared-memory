/**
 * BM25 index/query benchmark (no Harness required).
 * Builds 10k synthetic memories and times index construction + queries.
 * Run with `node test/search-bench.mjs`.
 */
import assert from 'node:assert/strict'
import { SearchIndex, tokenizeForIndex } from '../index.js'

const WORDS = ['共享', '记忆', '插件', '检索', '索引', '项目', '任务', '偏好', '验证', '部署', '设计', '测试']
const LATIN = ['memory', 'plugin', 'search', 'index', 'project', 'task', 'cursor', 'codex', 'claude', 'workbuddy']

function makeRecord(index) {
  const parts = []
  for (let i = 0; i < 12; i++) {
    parts.push(WORDS[(index * 7 + i * 3) % WORDS.length])
    if (i % 3 === 0) parts.push(LATIN[(index * 5 + i) % LATIN.length])
  }
  return { id: `mem_${index}`, text: parts.join(' '), tags: [WORDS[index % WORDS.length]] }
}

const COUNT = 10000
const records = Array.from({ length: COUNT }, (_, index) => makeRecord(index))

const buildStart = performance.now()
const index = new SearchIndex()
for (const record of records) index.add(record)
const buildMs = performance.now() - buildStart
assert.equal(index.docLengths.size, COUNT)

const queries = ['共享记忆', '插件检索', 'cursor', '项目 部署', 'memory index', '不存在的词组xyz']
const queryTimes = []
for (let round = 0; round < 5; round++) {
  for (const query of queries) {
    const start = performance.now()
    const scores = index.score(tokenizeForIndex(query))
    queryTimes.push(performance.now() - start)
    assert.ok(scores.size >= 0)
  }
}
const averageQueryMs = queryTimes.reduce((sum, value) => sum + value, 0) / queryTimes.length
const maxQueryMs = Math.max(...queryTimes)

console.log(`records: ${COUNT}`)
console.log(`index build: ${buildMs.toFixed(0)} ms`)
console.log(`query avg: ${averageQueryMs.toFixed(2)} ms · max: ${maxQueryMs.toFixed(2)} ms`)

assert.ok(buildMs < 12000, `index build too slow: ${buildMs.toFixed(0)}ms`)
assert.ok(averageQueryMs < 80, `average query too slow: ${averageQueryMs.toFixed(2)}ms`)
assert.ok(maxQueryMs < 250, `max query too slow: ${maxQueryMs.toFixed(2)}ms`)
console.log('\nSearch benchmark passed.')

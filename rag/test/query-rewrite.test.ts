import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewriteQueryForRetrieval } from '../src/lib/kb/retrieve/index.js';

test('lexical retrieval removes question framing but keeps topic terms', () => {
  assert.equal(rewriteQueryForRetrieval('日志位置是什么？'), '日志');
  assert.equal(rewriteQueryForRetrieval('服务默认端口和日志位置分别是什么？'), '服务默认端口和日志');
  assert.equal(rewriteQueryForRetrieval('审计日志的保留周期是多少？'), '审计日志的保留');
});

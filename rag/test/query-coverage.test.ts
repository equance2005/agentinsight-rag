import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryCoverage } from '../src/lib/kb/answer/gates.js';
import type { RetrievedChunk } from '../src/lib/kb/types.js';

function hit(content: string): RetrievedChunk {
  return {
    chunkId: 'chunk-1',
    documentId: 'doc-1',
    documentTitle: 'fixture.md',
    content,
    locator: {},
    headingPath: null,
    score: 1,
    ranks: { fused: 1 },
    kind: 'chunk',
  };
}

test('query coverage ignores common Chinese question phrasing', () => {
  const log = [hit('日志默认保留 30 天，存放于 /var/log/kb 目录。')];
  const secret = [hit('所有敏感信息必须存储在密钥管理服务中。')];

  assert.ok(queryCoverage('日志存放在哪里？', log) >= 0.34);
  assert.ok(queryCoverage('敏感信息应该存在哪里？', secret) >= 0.34);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeBaseEngine } from '../src/lib/kb/index.js';
import { originMatches } from '../src/server/public-api.js';
import { Retriever } from '../src/lib/kb/retrieve/index.js';
import { evidenceGate } from '../src/lib/kb/answer/gates.js';
import type { LlmProvider } from '../src/lib/kb/ports.js';
import { parseConnection, validateImages } from '../src/lib/kb/providers/user-connection.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kb-security-'));
}

test('安全：文档范围同时约束关键词检索', async () => {
  const dir = tempDir();
  const engine = new KnowledgeBaseEngine({ databasePath: ':memory:' });
  try {
    writeFileSync(join(dir, 'a.md'), '# A\n\n共享关键词 alpha。', 'utf8');
    writeFileSync(join(dir, 'b.md'), '# B\n\n共享关键词 alpha。', 'utf8');
    const kb = engine.createKnowledgeBase({ name: 'scoped-search' });
    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });
    const docs = engine.listDocuments(kb.id);
    const a = docs.find((doc) => doc.title === 'a.md')!;
    const result = await engine.retrieve({ kbId: kb.id, query: 'alpha', documentIds: [a.id] });

    assert.ok(result.hits.length > 0, '范围内文档应命中');
    assert.ok(result.hits.every((hit) => hit.documentId === a.id), '范围外文档不得进入结果');
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('检索：英文实体支持连写与带空格的模糊写法', async () => {
  const dir = tempDir();
  const engine = new KnowledgeBaseEngine({ databasePath: ':memory:' });
  try {
    writeFileSync(join(dir, 'agent.md'), '# Agent Insight\n\nAgent Insight 提供智能体工程分析能力。', 'utf8');
    const kb = engine.createKnowledgeBase({ name: 'fuzzy-entity' });
    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });
    const compact = await engine.retrieve({ kbId: kb.id, query: 'agentinsight', topK: 6 });
    const prefix = await engine.retrieve({ kbId: kb.id, query: 'agentinsig', topK: 6 });
    const spaced = await engine.retrieve({ kbId: kb.id, query: 'Agent Insight', topK: 6 });
    assert.ok(compact.hits.some((hit) => hit.content.includes('Agent Insight')));
    assert.ok(prefix.hits.some((hit) => hit.content.includes('Agent Insight')));
    assert.ok(spaced.hits.some((hit) => hit.content.includes('Agent Insight')));
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('性能：明确英文实体查询走本地证据快捷路径', async () => {
  let calls = 0;
  const llm: LlmProvider = {
    modelId: 'test',
    async complete() {
      calls++;
      return { text: '{"decision":"no_evidence"}', usage: null };
    },
    async *stream() { yield ''; },
  };
  const result = await evidenceGate('agentinsight', [{
    chunkId: 'chunk_1', documentId: 'doc_1', documentTitle: 'guide.md',
    content: 'Agent Insight 提供智能体工程分析能力。', locator: {}, headingPath: null,
    score: 1, ranks: { fused: 1 }, kind: 'chunk',
  }], llm);
  assert.equal(result.decision, 'answerable');
  assert.equal(calls, 0, '明确实体命中不应额外调用证据 LLM');
});

test('安全：会话不能跨知识库或站点复用', async () => {
  const engine = new KnowledgeBaseEngine({ databasePath: ':memory:' });
  try {
    const first = engine.createKnowledgeBase({ name: 'first' });
    const second = engine.createKnowledgeBase({ name: 'second' });
    const created = await engine.ask({ kbId: first.id, query: 'hello', siteKey: 'a.example' });

    await assert.rejects(
      engine.ask({ kbId: second.id, query: 'cross-kb', conversationId: created.conversationId }),
      /会话不存在或不属于该知识库/,
    );
    await assert.rejects(
      engine.ask({
        kbId: first.id,
        query: 'cross-site',
        conversationId: created.conversationId,
        siteKey: 'b.example',
      }),
      /会话不属于当前站点/,
    );
  } finally {
    engine.close();
  }
});

test('安全：来源白名单按主机严格匹配', () => {
  assert.equal(originMatches('localhost:3000', 'http://localhost:3000'), true);
  assert.equal(originMatches('*.example.com', 'https://app.example.com'), true);
  assert.equal(originMatches('*.example.com', 'https://evil.com/example.com'), false);
  assert.equal(originMatches('https://example.com', 'http://example.com'), false);
});

test('检索：embedding 故障默认降级，并允许显式禁止降级', async () => {
  const engine = new KnowledgeBaseEngine({ databasePath: ':memory:' });
  try {
    const kb = engine.createKnowledgeBase({ name: 'fallback' });
    await engine.addQaPair({ kbId: kb.id, question: '默认端口是多少', answer: '默认端口是 3000' });
    const embedder = {
      modelId: 'offline', dim: 2,
      async embed() { throw new Error('provider unavailable'); },
      async embedQuery() { throw new Error('provider unavailable'); },
    };
    const retriever = new Retriever(engine.repo, engine.vectorStore, embedder);
    const result = await retriever.retrieve({ kbId: kb.id, query: '默认端口', topK: 6 });
    assert.equal(result.mode, 'keyword-only');
    assert.equal(result.semanticDegraded, true);
    assert.ok(result.hits.length > 0);
    await assert.rejects(retriever.retrieve({ kbId: kb.id, query: '默认端口', topK: 6, allowKeywordFallback: false }),
      /provider unavailable/);
  } finally {
    engine.close();
  }
});

test('检索：模型切换后不能混用旧模型向量，余弦分数保持正确', async () => {
  const engine = new KnowledgeBaseEngine({ databasePath: ':memory:' });
  try {
    const kb = engine.createKnowledgeBase({ name: 'models' });
    await engine.vectorStore.upsert([
      { id: 'v1', kbId: kb.id, documentId: null, vector: Float32Array.of(3, 4), meta: { kind: 'qa', model: 'old', dim: 2 } },
      { id: 'v2', kbId: kb.id, documentId: null, vector: Float32Array.of(0, 2), meta: { kind: 'qa', model: 'old', dim: 2 } },
    ]);
    const query = { kbId: kb.id, vector: Float32Array.of(6, 8), topK: 5 };
    assert.deepEqual(await engine.vectorStore.search({ ...query, model: 'new' }), []);
    const hits = await engine.vectorStore.search({ ...query, model: 'old' });
    assert.equal(hits[0].id, 'v1');
    assert.ok(Math.abs(hits[0].score - 1) < 1e-12);
    assert.ok(Math.abs(hits[1].score - 0.8) < 1e-12);
    assert.deepEqual(await engine.vectorStore.search({ ...query, model: 'old', documentIds: [] }), []);
  } finally {
    engine.close();
  }
});

test('安全：模型连接与图片输入校验限制范围', () => {
  assert.deepEqual(parseConnection({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test' }), {
    provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test',
  });
  assert.throws(() => parseConnection({ provider: 'unknown', model: 'x', apiKey: 'k' }), /支持的模型/);
  assert.throws(() => parseConnection({ provider: 'openai', model: 'x', apiKey: 'bad\nkey' }), /有效的 API Key/);
  assert.throws(() => validateImages([{ data: 'aGVsbG8=', mimeType: 'image/png' }]), /图片内容与类型不符/);
});


/**
 * 回答依据与拒答测试（验收 E 组）。
 *
 * 用可控的假 LLM 精确驱动三道闸门，验证：
 *  - 四类问题分别产出 answerable / partial / conflict / no_evidence
 *  - 拒答路径不调用 LLM（硬性行为断言）
 *  - 引用可反查、可定位
 *  - 无引用支撑的陈述句比例为 0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeBaseEngine } from '../src/lib/kb/index.js';
import type { EmbeddingProvider, LlmMessage, LlmOptions, LlmProvider } from '../src/lib/kb/ports.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kb-answer-'));
}

/** 确定性假 embedding：字符频率向量，让语义相近的文本真的靠近。 */
class FakeEmbedder implements EmbeddingProvider {
  readonly modelId = 'fake-embed';
  readonly dim = 64;

  private vectorize(text: string): Float32Array {
    const vector = new Float32Array(this.dim);
    for (const ch of text) {
      // 用字符码分散到不同维度，保证「相同用词」产生高余弦相似度
      vector[ch.codePointAt(0)! % this.dim] += 1;
    }
    let norm = 0;
    for (const v of vector) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    return vector;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.vectorize(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.vectorize(text);
  }
}

/**
 * 可编程假 LLM。
 *
 * 按提示词特征分派响应，从而独立控制「证据闸门」与「claim 校验」的返回值。
 * 同时记录调用次数，用于断言拒答路径不触发模型调用。
 */
class FakeLlm implements LlmProvider {
  readonly modelId = 'fake-llm';
  calls = 0;
  responses: Array<{ match: RegExp; reply: string }> = [];

  async complete(messages: LlmMessage[], _options?: LlmOptions) {
    this.calls++;
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const user = messages.find((m) => m.role === 'user')?.content ?? '';

    for (const response of this.responses) {
      if (response.match.test(system) || response.match.test(user)) {
        return { text: response.reply, usage: { input: 10, output: 20 } };
      }
    }
    return { text: '默认回答 [1]', usage: { input: 10, output: 5 } };
  }

  async *stream(messages: LlmMessage[], options?: LlmOptions): AsyncIterable<string> {
    const result = await this.complete(messages, options);
    // 按字符切块，模拟真实流式增量
    for (const chunk of result.text.match(/.{1,8}/gs) ?? []) yield chunk;
  }
}

const EVIDENCE_MARKER = /证据充分性判定器/;
const CLAIM_MARKER = /忠实度校验器/;
const ANSWER_MARKER = /知识库问答助手/;

function makeEngine(llm: LlmProvider | null, embedder: EmbeddingProvider | null) {
  return new KnowledgeBaseEngine({ databasePath: ':memory:', embedder, llm });
}

function seedKnowledge(dir: string): void {
  writeFileSync(
    join(dir, 'deploy.md'),
    [
      '# 部署手册',
      '',
      '## 端口配置',
      '',
      '服务默认监听端口为 3000，可以通过配置文件修改。',
      '',
      '## 数据库',
      '',
      '数据库默认端口是 5432，连接池上限为 20。',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(dir, 'ops.md'),
    [
      '# 运维手册',
      '',
      '## 日志',
      '',
      '日志默认保留 30 天，存放于 /var/log/kb 目录。',
      '',
    ].join('\n'),
    'utf8',
  );
}

test('E: 有明确答案时给出可定位的引用', async () => {
  const dir = tempDir();
  const llm = new FakeLlm();
  llm.responses = [
    { match: EVIDENCE_MARKER, reply: '{"decision":"answerable","reason":"片段直接给出了端口号","missing":[]}' },
    {
      match: ANSWER_MARKER,
      reply: '服务默认监听端口为 3000。[1]',
    },
    {
      match: CLAIM_MARKER,
      reply: '{"claims":[{"claim":"服务默认监听端口为 3000","verdict":"supported","citations":[1]}]}',
    },
  ];

  const engine = makeEngine(llm, new FakeEmbedder());
  try {
    seedKnowledge(dir);
    const kb = engine.createKnowledgeBase({ name: 'answerable' });
    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });

    const result = await engine.ask({ kbId: kb.id, query: '服务默认端口是多少' });

    assert.equal(result.gate.decision, 'answerable', '证据充分时应判定为可答');
    assert.ok(result.answer.includes('3000'), '回答应包含正确答案');
    assert.ok(result.citations.length > 0, '回答必须带引用');

    // 引用可反查到文档与定位
    const citation = result.citations[0];
    const detail = engine.getChunkWithSource(citation.chunkId);
    assert.ok(detail, '引用必须能反查到片段');
    assert.equal(detail!.document?.title, 'deploy.md', '引用来源文档应正确');
    assert.ok(
      detail!.locator.headingPath?.includes('端口配置'),
      `引用应定位到具体章节，实际：${JSON.stringify(detail!.locator)}`,
    );

    // 无引用支撑的陈述句比例为 0
    assert.equal(result.unsupportedClaimCount, 0, '不应存在无引用支撑的陈述');
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E: 答案跨多个文档时每条陈述各自挂引用', async () => {
  const dir = tempDir();
  const llm = new FakeLlm();
  llm.responses = [
    { match: EVIDENCE_MARKER, reply: '{"decision":"answerable","reason":"两个片段分别覆盖端口与日志","missing":[]}' },
    { match: ANSWER_MARKER, reply: '数据库端口是 5432。[1] 日志保留 30 天。[2]' },
    {
      match: CLAIM_MARKER,
      reply:
        '{"claims":[{"claim":"数据库端口是 5432","verdict":"supported","citations":[1]},{"claim":"日志保留 30 天","verdict":"supported","citations":[2]}]}',
    },
  ];

  const engine = makeEngine(llm, new FakeEmbedder());
  try {
    seedKnowledge(dir);
    const kb = engine.createKnowledgeBase({ name: 'cross-doc' });
    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });

    const result = await engine.ask({ kbId: kb.id, query: '数据库端口和日志保留期分别是多少' });

    assert.equal(result.gate.decision, 'answerable');
    assert.equal(result.citations.length, 2, '跨文档回答应挂两条引用');

    // 两条引用应指向不同文档，证明确实做了跨文档整合
    const sources = new Set(result.citations.map((c) => c.documentTitle));
    assert.equal(sources.size, 2, `引用应来自两个不同文档，实际：${[...sources].join(',')}`);

    // 每条引用都能反查到内容
    for (const citation of result.citations) {
      const detail = engine.getChunkWithSource(citation.chunkId);
      assert.ok(detail, `引用 [${citation.index}] 应能反查`);
      assert.ok(detail!.chunk.content.length > 0);
    }
    assert.equal(result.unsupportedClaimCount, 0);
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E: 知识库未覆盖时拒答，且不调用 LLM', async () => {
  const dir = tempDir();
  const llm = new FakeLlm();
  const engine = makeEngine(llm, new FakeEmbedder());
  try {
    seedKnowledge(dir);
    const kb = engine.createKnowledgeBase({ name: 'no-evidence' });
    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });

    const before = llm.calls;
    // 询问与知识库完全无关的主题
    const result = await engine.ask({ kbId: kb.id, query: '如何申请火星移民签证的面试预约' });

    assert.equal(result.gate.decision, 'no_evidence', '知识库未覆盖时应拒答');
    assert.equal(result.gate.stage, 'retrieval', '应在检索闸门就判定，而非依赖模型');
    assert.equal(result.citations.length, 0, '拒答不应给出引用');
    assert.equal(
      llm.calls,
      before,
      '检索闸门拒答时**不得调用 LLM**——这是防止编造的关键保证',
    );

    // 回答文本应说明无法回答，并给出可行下一步
    assert.match(result.answer, /无法可靠回答/, '拒答话术应明确');
    assert.ok(result.gate.suggestions.length > 0, '拒答应提示用户可补充的方向');
    assert.ok(!/火星/.test(result.answer.replace(/火星移民签证的面试预约/g, '')), '不应臆造具体答案');
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E: 证据冲突时并列呈现，不擅自择一', async () => {
  const dir = tempDir();
  const llm = new FakeLlm();
  llm.responses = [
    {
      match: EVIDENCE_MARKER,
      reply:
        '{"decision":"conflict","reason":"两份文档给出的数据库端口不一致","conflicts":[{"topic":"数据库端口","claims":[{"text":"新版文档写明端口是 5432","citations":[1]},{"text":"旧版文档写明端口是 3306","citations":[2]}]}]}',
    },
  ];

  const engine = makeEngine(llm, new FakeEmbedder());
  try {
    seedKnowledge(dir);
    // 第二份文档给出冲突说法
    writeFileSync(
      join(dir, 'legacy.md'),
      ['# 数据库端口说明（旧版）', '', '数据库默认端口是 3306，连接池上限为 20。', ''].join('\n'),
      'utf8',
    );

    const kb = engine.createKnowledgeBase({ name: 'conflict' });
    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });

    const result = await engine.ask({ kbId: kb.id, query: '数据库默认端口是多少' });

    assert.equal(result.gate.decision, 'conflict', '证据矛盾时应判定为冲突');
    assert.match(result.answer, /不一致|存在不一致/, '回答应说明资料冲突');
    assert.ok(result.gate.conflicts && result.gate.conflicts.length > 0, '应给出结构化冲突组');

    // 两个矛盾说法都应出现，模型不得只挑一个
    const allClaims = result.gate.conflicts!.flatMap((group) => group.claims.map((c) => c.text));
    assert.ok(allClaims.some((text) => text.includes('5432')), '应列出 5432 的说法');
    assert.ok(allClaims.some((text) => text.includes('3306')), '应列出 3306 的说法');
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E: 部分可答时标注缺失部分', async () => {
  const dir = tempDir();
  const llm = new FakeLlm();
  llm.responses = [
    {
      match: EVIDENCE_MARKER,
      reply: '{"decision":"partial","reason":"只覆盖了端口，没有覆盖数据迁移方案","missing":["数据迁移方案"]}',
    },
    { match: ANSWER_MARKER, reply: '端口为 3000。[1] 资料中没有关于数据迁移方案的内容。' },
    {
      match: CLAIM_MARKER,
      reply: '{"claims":[{"claim":"端口为 3000","verdict":"supported","citations":[1]}]}',
    },
  ];

  const engine = makeEngine(llm, new FakeEmbedder());
  try {
    seedKnowledge(dir);
    const kb = engine.createKnowledgeBase({ name: 'partial' });
    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });

    const result = await engine.ask({ kbId: kb.id, query: '端口是多少，数据迁移方案是什么' });

    assert.equal(result.gate.decision, 'partial', '部分覆盖应判定为部分可答');
    assert.ok(result.gate.missing && result.gate.missing.length > 0, '应明确列出缺失的信息点');
    assert.ok(result.citations.length > 0, '部分可答仍应给出已有证据的引用');
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E: 生成后校验发现矛盾陈述时降级', async () => {
  const dir = tempDir();
  const llm = new FakeLlm();
  llm.responses = [
    { match: EVIDENCE_MARKER, reply: '{"decision":"answerable","reason":"证据一致","missing":[]}' },
    { match: ANSWER_MARKER, reply: '服务默认监听端口为 8080。[1]' },
    {
      match: CLAIM_MARKER,
      // 答案说的 8080 与文档中的 3000 矛盾
      reply: '{"claims":[{"claim":"服务默认监听端口为 8080","verdict":"contradicted","citations":[1]}]}',
    },
  ];

  const engine = makeEngine(llm, new FakeEmbedder());
  try {
    seedKnowledge(dir);
    const kb = engine.createKnowledgeBase({ name: 'post-check' });
    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });

    const result = await engine.ask({ kbId: kb.id, query: '服务默认端口是多少' });

    assert.equal(result.gate.stage, 'post-check', '应由生成后校验触发降级');
    assert.equal(result.gate.decision, 'partial', '存在矛盾陈述时不应维持可答');
    assert.ok(result.unsupportedClaimCount > 0, '应统计出无引用支撑的陈述');
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E: 引用编号越界时被丢弃，不产生点不开的引用', async () => {
  const dir = tempDir();
  const llm = new FakeLlm();
  llm.responses = [
    { match: EVIDENCE_MARKER, reply: '{"decision":"answerable","reason":"ok","missing":[]}' },
    // 模型标注了不存在的 [1] 与越界的 [9]
    { match: ANSWER_MARKER, reply: '端口是 3000。[1] 另外还有一项配置参见 [9]。' },
    { match: CLAIM_MARKER, reply: '{"claims":[]}' },
  ];

  const engine = makeEngine(llm, new FakeEmbedder());
  try {
    seedKnowledge(dir);
    const kb = engine.createKnowledgeBase({ name: 'citation-bounds' });
    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });

    const result = await engine.ask({ kbId: kb.id, query: '服务默认端口是多少' });

    for (const citation of result.citations) {
      assert.ok(citation.index >= 1, '引用编号应合法');
      const detail = engine.getChunkWithSource(citation.chunkId);
      assert.ok(detail, `引用 [${citation.index}] 必须能反查到片段`);
    }
    assert.ok(
      !result.citations.some((c) => c.index === 9),
      '越界的引用编号应被丢弃',
    );
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E: 不配置模型时不崩溃，返回带引用的原文片段', async () => {
  const dir = tempDir();
  const engine = makeEngine(null, null);
  try {
    seedKnowledge(dir);
    const kb = engine.createKnowledgeBase({ name: 'no-model' });
    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });

    const result = await engine.ask({ kbId: kb.id, query: '数据库默认端口' });

    assert.ok(result.retrieval.hits.length > 0, '无模型时检索仍应工作');
    assert.ok(result.answer.length > 0, '应返回可读内容而非空回答');
    assert.equal(result.retrieval.mode, 'keyword-only', '无 embedding 时应降级为纯关键词模式');
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

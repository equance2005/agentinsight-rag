/**
 * 摄取与增量同步测试（验收 A 组、B 组）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeBaseEngine } from '../src/lib/kb/index.js';
import { createFixtures, writeGapDoc } from './fixtures.js';
import type { EmbeddingProvider } from '../src/lib/kb/ports.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kb-test-'));
}

/** 无 embedding / 无 LLM 的纯本地引擎，用于验证基础链路不依赖外部服务。 */
function makeEngine(): KnowledgeBaseEngine {
  return new KnowledgeBaseEngine({ databasePath: ':memory:', embedder: null, llm: null });
}

/**
 * 计数用 embedding 实现。
 *
 * 增量同步的核心验收指标是「实际重算了多少 embedding」，
 * 用一个确定性假实现精确计数，比只看 chunk 数更贴近真实成本。
 */
class CountingEmbedder implements EmbeddingProvider {
  readonly modelId = 'test-embed';
  readonly dim = 8;
  calls: string[][] = [];

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    return texts.map((text) => {
      const vector = new Float32Array(this.dim);
      for (let i = 0; i < text.length; i++) {
        vector[i % this.dim] += text.charCodeAt(i) / 1000;
      }
      return vector;
    });
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embed([text]);
    return vector;
  }
}

test('A: 五种格式都能被解析，并产出可定位的片段', async () => {
  const dir = tempDir();
  const engine = makeEngine();
  try {
    const fixtures = await createFixtures(dir);
    const kb = engine.createKnowledgeBase({ name: 'formats' });

    // 只导入受支持的格式，zip 单独在下一个用例验证
    const { stats } = await engine.importDirectory({
      kbId: kb.id,
      directory: dir,
      include: ['*.md', '*.txt', '*.docx', '*.xlsx', '*.pdf'],
    });

    assert.equal(stats.failed, 0, '五种格式都不应解析失败');

    const docs = engine.listDocuments(kb.id);
    const byName = new Map(docs.map((doc) => [doc.title, doc]));
    for (const name of ['guide.md', 'notes.txt', 'manual.docx', 'metrics.xlsx', 'spec.pdf']) {
      assert.ok(byName.has(name), `缺少文档 ${name}`);
      assert.equal(byName.get(name)?.parseStatus, 'ok', `${name} 解析状态应为 ok`);
    }

    // --- Markdown：应有标题路径定位 ---
    const mdDoc = byName.get('guide.md')!;
    const mdChunks = engine.listChunks(mdDoc.id);
    assert.ok(mdChunks.length > 0, 'markdown 应产出片段');
    assert.ok(
      mdChunks.some((chunk) => chunk.headingPath?.includes('安装')),
      'markdown 片段应带出标题路径',
    );
    assert.ok(
      mdChunks.every((chunk) => chunk.locator.lineStart !== undefined),
      'markdown 片段应有行号定位',
    );

    // --- Excel：应有 sheet 与单元格范围定位 ---
    const xlsxDoc = byName.get('metrics.xlsx')!;
    const xlsxChunks = engine.listChunks(xlsxDoc.id);
    assert.ok(xlsxChunks.length > 0, 'excel 应产出片段');
    assert.ok(
      xlsxChunks.some((chunk) => chunk.locator.sheet === '销售目标'),
      'excel 片段应带出工作表名',
    );
    assert.ok(
      xlsxChunks.some((chunk) => chunk.locator.cellRange !== undefined),
      'excel 片段应带出单元格范围',
    );

    // --- PDF：应逐页提取并带出页码定位 ---
    const pdfDoc = byName.get('spec.pdf')!;
    const pdfChunks = engine.listChunks(pdfDoc.id);
    assert.ok(pdfChunks.length > 0, 'pdf 应产出片段');

    const pages = new Set(pdfChunks.map((chunk) => chunk.locator.page));
    assert.ok(pages.has(1), 'pdf 应包含第 1 页的定位');
    assert.ok(
      pdfChunks.every((chunk) => chunk.locator.page !== undefined),
      '每个 pdf 片段都应带页码',
    );

    // 两页文本都应被提取到（可能落在同一片段，因此检查内容而非片段数）
    const pdfText = pdfChunks
      .map((chunk) => `${chunk.content}${chunk.locator.pageEnd ? `\n[p${chunk.locator.page}-${chunk.locator.pageEnd}]` : ''}`)
      .join('\n');
    assert.ok(pdfText.includes('key management service'), 'pdf 第 1 页文本应被提取');
    assert.ok(pdfText.includes('audit logs'), 'pdf 第 2 页文本应被提取');

    const spansToPage2 = pdfChunks.some(
      (chunk) => chunk.locator.page === 2 || (chunk.locator.pageEnd ?? 1) >= 2,
    );
    assert.ok(spansToPage2, '应能识别出内容跨越到第 2 页');

    // --- docx：应解析出正文内容 ---
    const docxDoc = byName.get('manual.docx')!;
    const docxText = engine
      .listChunks(docxDoc.id)
      .map((chunk) => chunk.content)
      .join('\n');
    assert.ok(docxText.includes('9800'), 'docx 正文应被正确提取');
    assert.ok(docxText.includes('退款'), 'docx 第二章内容应被提取');
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A: 不支持的文件被显式记为失败，而不是静默跳过', async () => {
  const dir = tempDir();
  const engine = makeEngine();
  try {
    await createFixtures(dir);
    const kb = engine.createKnowledgeBase({ name: 'unsupported' });

    // include 全部文件，zip 会进来
    const { stats } = await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*'] });

    assert.ok(stats.failed >= 1, `不支持的 zip 应计入失败，实际 failed=${stats.failed}`);
    const failed = engine.listDocuments(kb.id).filter((doc) => doc.parseStatus === 'error');
    assert.equal(failed.length, 1, '应有一条失败记录');
    assert.ok(failed[0].parseError, '失败记录必须带错误原因');
    assert.match(failed[0].parseError!, /不支持的文件格式/, '错误信息应说明原因');
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B: 修改一个段落只重算受影响的片段，不做全量重建', async () => {
  const dir = tempDir();
  const embedder = new CountingEmbedder();
  const engine = new KnowledgeBaseEngine({ databasePath: ':memory:', embedder, llm: null });
  try {
    const fixtures = await createFixtures(dir);
    const kb = engine.createKnowledgeBase({ name: 'incremental' });

    const first = await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });
    const embeddingsAfterFirst = first.stats.embeddingsComputed;
    assert.ok(embeddingsAfterFirst > 1, '首次导入应为多个片段计算 embedding');

    // 第二次导入、内容未变 → 应全部跳过，且不产生任何 embedding 调用
    embedder.calls.length = 0;
    const second = await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });
    assert.equal(second.stats.unchanged, 1, '内容未变应判定为 unchanged');
    assert.equal(second.stats.updated, 0, '内容未变不应触发更新');
    assert.equal(second.stats.chunksCreated, 0, '内容未变不应重建片段');
    assert.equal(embedder.calls.length, 0, '内容未变不应调用 embedding');

    // 改写其中一个不相关的段落
    const original = readFileSync(fixtures.markdown, 'utf8');
    writeFileSync(fixtures.markdown, original.replace('超时时间默认 30 秒', '超时时间默认 60 秒'), 'utf8');

    embedder.calls.length = 0;
    const third = await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });
    assert.equal(third.stats.updated, 1, '内容变化应触发更新');

    // 核心断言：只重算受影响的片段，其余复用已有向量
    assert.ok(
      third.stats.embeddingsComputed < embeddingsAfterFirst,
      `增量重算的 embedding 数(${third.stats.embeddingsComputed})应少于全量(${embeddingsAfterFirst})`,
    );
    assert.ok(third.stats.embeddingsReused > 0, '未受影响的片段应复用已有向量');

    const totalEmbedded = embedder.calls.reduce((sum, batch) => sum + batch.length, 0);
    assert.equal(
      totalEmbedded,
      third.stats.embeddingsComputed,
      '实际调用 embedding 的文本数应与统计一致',
    );
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B: contentHash 对相同内容稳定，可用于跨文档复用', async () => {
  const dir = tempDir();
  const engine = makeEngine();
  try {
    await createFixtures(dir);

    // 两个文件包含完全相同的段落
    const shared = '# 共享章节\n\n这是两个文件都包含的同一段落内容。\n';
    writeFileSync(join(dir, 'dup-a.md'), shared, 'utf8');
    writeFileSync(join(dir, 'dup-b.md'), shared, 'utf8');

    const kb = engine.createKnowledgeBase({ name: 'dedup' });
    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['dup-*.md'] });

    const docs = engine.listDocuments(kb.id);
    assert.equal(docs.length, 2);

    const hashesA = new Set(engine.listChunks(docs[0].id).map((chunk) => chunk.contentHash));
    const hashesB = new Set(engine.listChunks(docs[1].id).map((chunk) => chunk.contentHash));

    const overlap = [...hashesA].filter((hash) => hashesB.has(hash));
    assert.ok(overlap.length > 0, '相同内容应产生相同的 contentHash，从而支持 embedding 复用');
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B: 源文件删除后，全量模式会清理对应文档', async () => {
  const dir = tempDir();
  const engine = makeEngine();
  try {
    const fixtures = await createFixtures(dir);
    const kb = engine.createKnowledgeBase({ name: 'prune' });

    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md', '*.txt'] });
    assert.equal(engine.listDocuments(kb.id).length, 2);

    unlinkSync(fixtures.text);
    const result = await engine.importDirectory({
      kbId: kb.id,
      directory: dir,
      include: ['*.md', '*.txt'],
      mode: 'full',
    });

    assert.equal(result.stats.deleted, 1, '源中已删除的文件应从知识库移除');
    assert.equal(engine.listDocuments(kb.id).length, 1);
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B: 问答对可录入并被检索命中', async () => {
  const dir = tempDir();
  const engine = makeEngine();
  try {
    await createFixtures(dir);
    const kb = engine.createKnowledgeBase({ name: 'qa' });
    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });

    await engine.addQaPair({
      kbId: kb.id,
      question: '如何重置管理员密码',
      answer: '在登录页点击「忘记密码」，通过注册邮箱接收重置链接。',
      tags: ['账号'],
    });

    const retrieval = await engine.retrieve({ kbId: kb.id, query: '管理员密码怎么重置', topK: 5 });
    assert.ok(retrieval.hits.length > 0, '问答对应能被召回');
    assert.ok(
      retrieval.hits.some((hit) => hit.kind === 'qa'),
      '召回结果中应包含问答对类型',
    );
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B: 内容增删改查与来源反查', async () => {
  const dir = tempDir();
  const engine = makeEngine();
  try {
    await createFixtures(dir);
    const kb = engine.createKnowledgeBase({ name: 'crud' });
    await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['*.md'] });

    const doc = engine.listDocuments(kb.id)[0];
    const chunks = engine.listChunks(doc.id);
    assert.ok(chunks.length > 0);

    // 查：片段能反查来源文档与定位
    const detail = engine.getChunkWithSource(chunks[0].id);
    assert.ok(detail, '应能查到片段及其来源');
    assert.equal(detail!.document?.id, doc.id, '来源文档应正确');
    assert.ok(detail!.locator.lineStart !== undefined, '应带出定位信息');

    // 改：修改片段内容后仍可查到
    const updated = await engine.updateChunk(chunks[0].id, '这是被人工修改后的内容。');
    assert.ok(updated);
    assert.ok(updated!.content.includes('人工修改'));

    // 增：再写入一个草稿文档
    writeGapDoc(join(dir, 'faq.md'));
    const added = await engine.importDirectory({ kbId: kb.id, directory: dir, include: ['faq.md'] });
    assert.equal(added.stats.added, 1);

    // 删：删除片段
    assert.equal(engine.deleteChunk(chunks[1].id), true);
    assert.equal(engine.listChunks(doc.id).length, chunks.length - 1);
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

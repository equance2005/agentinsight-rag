/**
 * 摄取流水线：扫描 → 判变更 → 解析 → 分块 → embedding → 事务写入。
 *
 * 增量同步的核心机制：
 *  1. 文档级：sha256 + mtime + parseVersion + chunkConfigVersion 任一变化才重新解析
 *  2. 分块级：对新旧 chunk 做 contentHash 差集，只有新哈希才计算 embedding
 *  3. embedding 缓存键为 (model, dim, contentHash)，跨文档、跨知识库复用
 *
 * 这样「改一段落」只会重算受影响的少数块，而不是整篇重建。
 */

import { randomUUID } from 'node:crypto';
import type {
  Chunker,
  DocumentSource,
  EmbeddingProvider,
  VectorStore,
} from '../ports.js';
import type { Chunk, IngestJob, IngestMode, IngestStats, SourceDocument } from '../types.js';
import { ParseError } from '../types.js';
import type { KnowledgeBaseRepository } from '../store/repository.js';
import { computeContentHash, estimateTokens } from './chunker.js';
import { defaultRegistry, type ParserRegistry } from './parsers/registry.js';
import { hashFile } from '../sources/local-directory.js';

export interface IngestOptions {
  kbId: string;
  source: DocumentSource;
  mode?: IngestMode;
  chunker: Chunker;
  embedder: EmbeddingProvider | null;
  vectorStore: VectorStore;
  registry?: ParserRegistry;
  /** 删除源中已不存在的文档；全量模式下默认开启。 */
  pruneMissing?: boolean;
  onProgress?: (event: IngestProgress) => void;
}

export interface IngestProgress {
  phase: 'scan' | 'parse' | 'embed' | 'write' | 'done';
  current: number;
  total: number;
  detail: string;
}

export class Ingestor {
  constructor(
    private readonly repo: KnowledgeBaseRepository,
    private readonly registry: ParserRegistry = defaultRegistry,
  ) {}

  async run(options: IngestOptions): Promise<{ job: IngestJob; stats: IngestStats }> {
    const mode = options.mode ?? 'incremental';
    const kb = this.repo.findKnowledgeBase(options.kbId);
    if (!kb) throw new Error(`知识库不存在：${options.kbId}`);

    const job = this.repo.createIngestJob(kb.id, mode);
    const startedAt = Date.now();
    const stats: IngestStats = {
      scanned: 0,
      added: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      failed: 0,
      chunksCreated: 0,
      chunksDeleted: 0,
      embeddingsComputed: 0,
      embeddingsReused: 0,
      durationMs: 0,
    };

    try {
      // --- 扫描 ---
      options.onProgress?.({ phase: 'scan', current: 0, total: 0, detail: '枚举源文档' });
      const entries = await options.source.list();
      stats.scanned = entries.length;

      const existingDocs = new Map(
        this.repo
          .listDocuments(kb.id)
          .filter((doc) => doc.sourcePath !== null)
          .map((doc) => [doc.sourcePath as string, doc]),
      );

      const seenKeys = new Set<string>();

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        seenKeys.add(entry.key);
        options.onProgress?.({
          phase: 'parse',
          current: i + 1,
          total: entries.length,
          detail: entry.relativePath,
        });

        try {
          const outcome = await this.syncDocument({
            kbId: kb.id,
            entry,
            existing: existingDocs.get(entry.key) ?? null,
            source: options.source,
            chunker: options.chunker,
            chunkConfigVersion: kb.chunkConfigVersion,
            embedder: options.embedder,
            vectorStore: options.vectorStore,
            stats,
            mode,
            onProgress: options.onProgress,
          });

          if (outcome === 'added') stats.added++;
          else if (outcome === 'updated') stats.updated++;
          else stats.unchanged++;
        } catch (error) {
          stats.failed++;
          await this.recordFailure(kb.id, entry, error, options, stats);
        }
      }

      // --- 清理源中已删除的文档 ---
      const pruneMissing = options.pruneMissing ?? mode === 'full';
      if (pruneMissing) {
        for (const [sourcePath, doc] of existingDocs) {
          if (seenKeys.has(sourcePath)) continue;
          const removedChunks = doc.chunkCount;
          await options.vectorStore.deleteByDocument(doc.id);
          this.repo.deleteDocument(doc.id);
          stats.deleted++;
          stats.chunksDeleted += removedChunks;
        }
      }

      stats.durationMs = Date.now() - startedAt;
      this.repo.finishIngestJob(job.id, 'ok', stats, null);
      options.onProgress?.({ phase: 'done', current: entries.length, total: entries.length, detail: '完成' });

      return { job: { ...job, status: 'ok', stats, finishedAt: new Date().toISOString() }, stats };
    } catch (error) {
      stats.durationMs = Date.now() - startedAt;
      this.repo.finishIngestJob(job.id, 'error', stats, (error as Error).message);
      throw error;
    }
  }

  /** 处理单个文档，返回是否发生实际变更。 */
  private async syncDocument(input: {
    kbId: string;
    entry: Awaited<ReturnType<DocumentSource['list']>>[number];
    existing: SourceDocument | null;
    source: DocumentSource;
    chunker: Chunker;
    chunkConfigVersion: string;
    embedder: EmbeddingProvider | null;
    vectorStore: VectorStore;
    stats: IngestStats;
    mode: IngestMode;
    onProgress?: (event: IngestProgress) => void;
  }): Promise<'added' | 'updated' | 'unchanged'> {
    const materialized = await input.source.materialize(input.entry);

    try {
      const sha256 = input.entry.sha256 ?? (await hashFile(materialized.path));
      const parser = this.registry.resolve(materialized.fileName, materialized.mimeType);

      // 解析器版本参与变更判定：换了更优解析器后应能重新解析
      const parserVersion = parser ? `${parser.name}@1` : 'unsupported@1';

      // --- 文档级变更判定 ---
      const unchanged =
        input.existing !== null &&
        input.existing.sha256 === sha256 &&
        input.existing.parseVersion === parserVersion &&
        input.existing.chunkConfigVersion === input.chunkConfigVersion &&
        input.existing.parseStatus === 'ok';

      if (unchanged && input.mode === 'incremental') return 'unchanged';

      // --- 解析 ---
      const parseResult = await this.registry.parse({
        path: materialized.path,
        fileName: materialized.fileName,
        mimeType: materialized.mimeType,
      });

      // --- 分块 ---
      const drafts = input.chunker.chunk(parseResult.blocks);

      // --- 增量差异：复用已有 chunk 的 embedding ---
      const existingChunks = input.existing
        ? this.repo.listChunksByDocument(input.existing.id)
        : [];
      const existingByHash = new Map(existingChunks.map((chunk) => [chunk.contentHash, chunk]));

      // 收集本库所有已有向量（按 contentHash 找实体），实现跨文档复用
      const globalByHash = this.repo.mapChunksByHash(input.kbId);
      const qaByHash = this.repo.mapQaByHash(input.kbId);

      const toEmbed: Array<{ index: number; hash: string; content: string }> = [];
      const resolved: Array<{
        id: string;
        content: string;
        contentHash: string;
        tokenCount: number;
        locator: (typeof drafts)[number]['locator'];
        headingPath: string[] | null;
        reuseChunkId: string | null;
      }> = [];

      for (let i = 0; i < drafts.length; i++) {
        const draft = drafts[i];
        const hash = computeContentHash(draft.content, draft.headingPath);

        const reused =
          existingByHash.get(hash) ??
          globalByHash.get(hash) ??
          (qaByHash.has(hash) ? undefined : undefined);

        resolved.push({
          id: `chk_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          content: draft.content,
          contentHash: hash,
          tokenCount: draft.tokenCount || estimateTokens(draft.content),
          locator: draft.locator,
          headingPath: draft.headingPath,
          reuseChunkId: reused ? reused.id : null,
        });

        if (!reused && input.embedder) {
          toEmbed.push({ index: i, hash, content: draft.content });
        }
        if (reused) input.stats.embeddingsReused++;
      }

      // --- embedding：只为新内容计算 ---
      const embeddingByHash = new Map<string, Float32Array>();
      if (input.embedder && toEmbed.length > 0) {
        input.onProgress?.({
          phase: 'embed',
          current: 0,
          total: toEmbed.length,
          detail: `${input.entry.relativePath}：${toEmbed.length} 个新片段`,
        });

        // 同一批内去重，避免同内容重复调用
        const uniqueByHash = new Map<string, string>();
        for (const item of toEmbed) if (!uniqueByHash.has(item.hash)) uniqueByHash.set(item.hash, item.content);

        const hashes = [...uniqueByHash.keys()];
        const texts = hashes.map((hash) => uniqueByHash.get(hash) as string);

        // 分批调用。默认 16 是因为部分服务端（如阿里云百炼）限制单次 input 不超过 20 条；
        // 批次过大会直接返回 InvalidParameter 而整批失败。
        const vectors = await this.embedInBatches(input.embedder, texts, 16);
        hashes.forEach((hash, index) => embeddingByHash.set(hash, vectors[index]));

        input.stats.embeddingsComputed += texts.length;
        input.onProgress?.({
          phase: 'embed',
          current: texts.length,
          total: texts.length,
          detail: input.entry.relativePath,
        });
      }

      // --- 写入 ---
      const chunkRows = resolved.map((item, index) => {
        const vector = embeddingByHash.get(item.contentHash);
        return {
          id: item.id,
          kbId: input.kbId,
          ordinal: index,
          content: item.content,
          contentHash: item.contentHash,
          tokenCount: item.tokenCount,
          locator: item.locator,
          headingPath: item.headingPath,
          embeddingModel: vector && input.embedder ? input.embedder.modelId : null,
          embeddingDim: vector && input.embedder ? input.embedder.dim : null,
        };
      });

      const previousCount = input.existing?.chunkCount ?? 0;
      const document = this.repo.upsertDocument({
        id: input.existing?.id,
        kbId: input.kbId,
        title: input.entry.title || input.entry.relativePath,
        sourcePath: input.entry.key,
        sourceUrl: null,
        mimeType: materialized.mimeType,
        sizeBytes: input.entry.sizeBytes,
        sha256,
        mtime: input.entry.mtime,
        parseStatus: 'ok',
        // 告警与错误分开记录：解析成功但存在样式/文本层等非致命问题时，
        // 之前把告警写进 parseError，导致 CLI 把「有告警」显示成「错误」。
        parseError: null,
        parseWarnings: parseResult.warnings,
        parseVersion: parserVersion,
        chunkConfigVersion: input.chunkConfigVersion,
        chunkCount: chunkRows.length,
      });

      // 先清旧向量，再写新 chunk（chunk id 每次都变，避免残留悬挂向量）
      if (input.existing) {
        await input.vectorStore.deleteByDocument(input.existing.id);
        input.stats.chunksDeleted += previousCount;
      }

      this.repo.replaceDocumentChunks(document.id, chunkRows);

      if (input.embedder) {
        // 新计算的向量 + 从同库相同内容复用的向量，一起写入向量表
        const reusable = await this.fetchReusableVectors(
          chunkRows.map((row) => row.contentHash),
          input.embedder,
          globalByHash,
        );

        const vectorItems = chunkRows
          .map((row) => {
            const vector = embeddingByHash.get(row.contentHash) ?? reusable.get(row.contentHash);
            if (!vector) return null;
            return {
              id: row.id,
              kbId: input.kbId,
              documentId: document.id,
              vector,
              meta: { kind: 'chunk' as const, model: input.embedder!.modelId, dim: input.embedder!.dim },
            };
          })
          .filter((item): item is NonNullable<typeof item> => item !== null);

        if (vectorItems.length > 0) await input.vectorStore.upsert(vectorItems);
      }

      input.stats.chunksCreated += chunkRows.length;
      return input.existing ? 'updated' : 'added';
    } finally {
      await materialized.cleanup?.();
    }
  }

  /** 解析或入库失败时，必须留下可见记录，不能静默跳过。 */
  private async recordFailure(
    kbId: string,
    entry: Awaited<ReturnType<DocumentSource['list']>>[number],
    error: unknown,
    options: IngestOptions,
    stats: IngestStats,
  ): Promise<void> {
    const isParseError = error instanceof ParseError;
    const message = error instanceof Error ? error.message : String(error);
    const detail = isParseError && error.detail ? `${message}（${error.detail}）` : message;

    const existing = this.repo.findDocumentBySource(kbId, entry.key, null);
    // 失败文档要清掉旧 chunk，否则会留下与当前源不一致的陈旧内容
    if (existing) {
      await options.vectorStore.deleteByDocument(existing.id);
      stats.chunksDeleted += existing.chunkCount;
    }

    this.repo.upsertDocument({
      id: existing?.id,
      kbId,
      title: entry.title || entry.relativePath,
      sourcePath: entry.key,
      sourceUrl: null,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256 ?? '',
      mtime: entry.mtime,
      parseStatus: 'error',
      parseError: detail,
      parseWarnings: [],
      parseVersion: 'failed@1',
      chunkConfigVersion: this.repo.findKnowledgeBase(kbId)?.chunkConfigVersion ?? 'v1',
      chunkCount: 0,
    });
  }

  /**
   * 分批调用 embedding，保证顺序与输入一致。
   *
   * 批大小需要保守：阿里云百炼限制单次 input ≤ 20 条，OpenAI 限制更大但没必要冒险。
   * 批次失败会带上批内首条文本的前缀，便于定位是内容问题还是配额问题。
   */
  private async embedInBatches(
    embedder: EmbeddingProvider,
    texts: string[],
    batchSize: number,
  ): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      try {
        const vectors = await embedder.embed(batch);
        if (vectors.length !== batch.length) {
          throw new Error(`返回数量不匹配：期望 ${batch.length}，实际 ${vectors.length}`);
        }
        results.push(...vectors);
      } catch (error) {
        throw new Error(
          `embedding 调用失败（第 ${Math.floor(i / batchSize) + 1} 批，共 ${texts.length} 条）：` +
            `${(error as Error).message}`,
        );
      }
    }
    return results;
  }

  /**
   * 从同库其他 chunk 中取回相同 contentHash 的向量。
   *
   * 相同内容的 chunk 在不同文档间共享同一个向量值，因此改一段落时
   * 未受影响的片段可以直接复用，不需要再次调用 embedding。
   */
  private async fetchReusableVectors(
    hashes: string[],
    embedder: EmbeddingProvider,
    globalByHash: Map<string, Chunk>,
  ): Promise<Map<string, Float32Array>> {
    const result = new Map<string, Float32Array>();
    if (hashes.length === 0) return result;

    const db = this.repo.raw();
    for (const hash of hashes) {
      const sourceChunk = globalByHash.get(hash);
      if (!sourceChunk) continue;
      const row = db
        .prepare('SELECT vec, dim FROM kb_vector WHERE id = ? AND model = ?')
        .get(sourceChunk.id, embedder.modelId) as Record<string, unknown> | undefined;
      if (!row) continue;
      const buf = Buffer.from(row.vec as Uint8Array);
      const dim = Number(row.dim);
      result.set(hash, new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + dim * 4)));
    }
    return result;
  }

  /** 相关知识库级别的向量补算（用于 Q&A 录入与 reindex 等旁路场景）。 */
  async embedTexts(
    kbId: string,
    embedder: EmbeddingProvider,
    vectorStore: VectorStore,
    items: Array<{ id: string; kind: 'chunk' | 'qa'; documentId: string | null; text: string; contentHash: string }>,
  ): Promise<number> {
    if (items.length === 0) return 0;

    // 去重后计算：同一内容在同一批内只调用一次
    const unique = new Map<string, string>();
    for (const item of items) if (!unique.has(item.contentHash)) unique.set(item.contentHash, item.text);

    const hashes = [...unique.keys()];
    const vectors = await this.embedInBatches(
      embedder,
      hashes.map((hash) => unique.get(hash) as string),
      16,
    );
    const byHash = new Map<string, Float32Array>();
    hashes.forEach((hash, index) => byHash.set(hash, vectors[index]));

    const vectorItems = items
      .map((item) => {
        const vector = byHash.get(item.contentHash);
        if (!vector) return null;
        return {
          id: item.id,
          kbId,
          documentId: item.documentId,
          vector,
          meta: { kind: item.kind, model: embedder.modelId, dim: embedder.dim },
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    await vectorStore.upsert(vectorItems);
    return vectorItems.length;
  }
}

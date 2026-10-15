/**
 * 知识库引擎门面。
 *
 * 这是宿主与 CLI 唯一需要接触的入口：把存储、检索、闸门、生成装配在一起，
 * 并暴露管理、问答、反馈三类操作。
 *
 * 通用性：本模块不感知任何宿主专有概念，宿主通过 DocumentSource 注入知识来源。
 */

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDatabase, type SqliteDatabase } from './store/sqlite-driver.js';
import { migrate, readSchemaVersion, SCHEMA_VERSION } from './store/schema.js';
import { KnowledgeBaseRepository } from './store/repository.js';
import { SqliteVectorStore } from './store/sqlite-vector-store.js';
import { StructureAwareChunker, computeContentHash, DEFAULT_CHUNK_OPTIONS } from './ingest/chunker.js';
import { Ingestor } from './ingest/pipeline.js';
import { Retriever, LexicalOverlapReranker } from './retrieve/index.js';
import { generateAnswer, streamAnswer, TimingCollector, type GenerateOptions, type StreamEvent } from './answer/generator.js';
import { DEFAULT_THRESHOLDS, type GateThresholds } from './answer/gates.js';
import { LocalDirectorySource } from './sources/local-directory.js';
import type {
  Chunker,
  DocumentSource,
  EmbeddingProvider,
  LlmProvider,
  Reranker,
  VectorStore,
} from './ports.js';
import type {
  AnswerResult,
  Citation,
  Chunk,
  Conversation,
  Feedback,
  IngestJob,
  IngestStats,
  KnowledgeBase,
  Locator,
  Message,
  QaPair,
  SourceDocument,
  StageTimings,
  UnresolvedIssue,
  UnresolvedReason,
  WidgetConfig,
} from './types.js';

export interface EngineConfig {
  /** SQLite 数据库路径；':memory:' 用于测试。 */
  databasePath: string;
  embedder?: EmbeddingProvider | null;
  llm?: LlmProvider | null;
  /** 公开给插件的可选生成模型名称；为空时使用 llm.modelId。 */
  llmModels?: string[];
  vectorStore?: VectorStore;
  chunker?: Chunker;
  reranker?: Reranker | null;
  thresholds?: Partial<GateThresholds>;
  /** 会话历史保留轮数（一问一答算一轮）。 */
  historyTurns?: number;
  /** SQLite 驱动覆盖。 */
  driver?: string;
}

export interface AskOptions {
  kbId: string;
  query: string;
  conversationId?: string;
  /** 嵌入站点标识，用于区分来源。 */
  siteKey?: string;
  topK?: number;
  documentIds?: string[];
  /** 是否执行生成后 claim 校验；false 可减少一次模型往返。 */
  claimCheck?: boolean;
  /** 请求级生成模型覆盖。 */
  model?: string;
  /** 插件请求提供的临时模型连接信息。 */
  apiKey?: string;
  baseUrl?: string;
  images?: import('./ports.js').ImageAttachment[];
  /** 请求级提供方，例如网页端临时连接的 Claude。 */
  llm?: LlmProvider;
  signal?: AbortSignal;
}

/** streamAnswer 的 done 事件负载。 */
interface StreamDonePayload {
  answer: string;
  citations: Citation[];
  gate: AnswerResult['gate'];
  claimChecks: AnswerResult['claimChecks'];
  unsupportedClaimCount: number;
  usage: { input: number; output: number } | null;
  timings?: StageTimings;
}

export class KnowledgeBaseEngine {
  readonly repo: KnowledgeBaseRepository;
  readonly vectorStore: VectorStore;
  private readonly db: SqliteDatabase;
  private readonly ingestor: Ingestor;
  private readonly retriever: Retriever;
  private readonly chunker: Chunker;
  private readonly embedder: EmbeddingProvider | null;
  private readonly llm: LlmProvider | null;
  private readonly llmModels: string[];
  private readonly thresholds: GateThresholds;
  private readonly historyTurns: number;
  /** 是否输出分阶段耗时日志；KB_LOG_TIMINGS=0 可关闭（批量评测场景）。 */
  private readonly logTimingsEnabled: boolean;
  /** 是否执行生成后 claim 级校验；KB_CLAIM_CHECK=0 可关闭以省一次 LLM 往返。 */
  private readonly claimCheckEnabled: boolean;

  constructor(config: EngineConfig) {
    if (config.databasePath !== ':memory:') {
      mkdirSync(dirname(config.databasePath), { recursive: true });
    }
    this.db = openDatabase(config.databasePath, config.driver);

    // 先执行迁移建表，再读版本号：全新数据库此时还没有 kb_meta 表。
    migrate(this.db);

    const version = readSchemaVersion(this.db);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `数据库 schema 版本 ${version} 高于本程序支持的 ${SCHEMA_VERSION}，请升级 kb-assistant`,
      );
    }

    this.repo = new KnowledgeBaseRepository(this.db);
    this.vectorStore = config.vectorStore ?? new SqliteVectorStore(this.db);
    this.chunker = config.chunker ?? new StructureAwareChunker();
    this.embedder = config.embedder ?? null;
    this.llm = config.llm ?? null;
    this.llmModels = [...new Set((config.llmModels ?? [this.llm?.modelId ?? '']).filter(Boolean))];
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(config.thresholds ?? {}) };
    this.historyTurns = config.historyTurns ?? 5;
    this.logTimingsEnabled = process.env.KB_LOG_TIMINGS !== '0' && process.env.KB_LOG_TIMINGS !== 'false';
    this.claimCheckEnabled = process.env.KB_CLAIM_CHECK !== '0' && process.env.KB_CLAIM_CHECK !== 'false';
    this.ingestor = new Ingestor(this.repo);
    this.retriever = new Retriever(
      this.repo,
      this.vectorStore,
      this.embedder,
      config.reranker === undefined ? new LexicalOverlapReranker() : config.reranker,
    );
  }

  close(): void {
    this.db.close();
  }

  availableLlmModels(): string[] {
    return [...this.llmModels];
  }

  // -------------------------------------------------------------------------
  // 知识库管理
  // -------------------------------------------------------------------------

  createKnowledgeBase(input: {
    name: string;
    description?: string;
    embeddingModel?: string | null;
    embeddingDim?: number | null;
    allowedOrigins?: string[];
    widgetConfig?: Partial<WidgetConfig>;
    generatePublicKey?: boolean;
  }): KnowledgeBase {
    const existing = this.repo.findKnowledgeBase(input.name);
    if (existing) throw new Error(`知识库名称已存在：${input.name}`);

    return this.repo.createKnowledgeBase({
      name: input.name,
      description: input.description ?? null,
      chunkConfigVersion: this.chunker.version,
      embeddingModel: input.embeddingModel ?? this.embedder?.modelId ?? null,
      embeddingDim: input.embeddingDim ?? this.embedder?.dim ?? null,
      publicKey: input.generatePublicKey === false ? null : `pk_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      allowedOrigins: input.allowedOrigins ?? [],
      widgetConfig: input.widgetConfig,
    });
  }

  getKnowledgeBase(idOrName: string): KnowledgeBase | null {
    return this.repo.findKnowledgeBase(idOrName);
  }

  getKnowledgeBaseByPublicKey(publicKey: string): KnowledgeBase | null {
    return this.repo.findKnowledgeBaseByPublicKey(publicKey);
  }

  listKnowledgeBases(): KnowledgeBase[] {
    return this.repo.listKnowledgeBases();
  }

  updateKnowledgeBase(id: string, patch: Parameters<KnowledgeBaseRepository['updateKnowledgeBase']>[1]): KnowledgeBase {
    return this.repo.updateKnowledgeBase(id, patch);
  }

  deleteKnowledgeBase(id: string): boolean {
    void this.vectorStore.deleteByKb(id);
    this.syncVectorCache();
    return this.repo.deleteKnowledgeBase(id);
  }

  /** 直连数据库改写过向量后调用，避免内存缓存与库不一致。 */
  private syncVectorCache(): void {
    if (this.vectorStore instanceof SqliteVectorStore) this.vectorStore.invalidate();
  }

  // -------------------------------------------------------------------------
  // 摄取
  // -------------------------------------------------------------------------

  /** 从本地目录导入，支持 include/exclude 选择全部或部分文件。 */
  async importDirectory(input: {
    kbId: string;
    directory: string;
    include?: string[];
    exclude?: string[];
    mode?: 'full' | 'incremental';
    recursive?: boolean;
    pruneMissing?: boolean;
    onProgress?: (event: { phase: string; current: number; total: number; detail: string }) => void;
  }): Promise<{ job: IngestJob; stats: IngestStats }> {
    const source = new LocalDirectorySource({
      root: input.directory,
      include: input.include,
      exclude: input.exclude,
      recursive: input.recursive,
    });
    return this.ingest({ ...input, source });
  }

  /** 用任意 DocumentSource 摄取，宿主可自行实现来源。 */
  async ingest(input: {
    kbId: string;
    source: DocumentSource;
    mode?: 'full' | 'incremental';
    pruneMissing?: boolean;
    onProgress?: (event: { phase: string; current: number; total: number; detail: string }) => void;
  }): Promise<{ job: IngestJob; stats: IngestStats }> {
    this.syncVectorCache();
    const result = await this.ingestor.run({
      kbId: input.kbId,
      source: input.source,
      mode: input.mode,
      pruneMissing: input.pruneMissing,
      chunker: this.chunker,
      embedder: this.embedder,
      vectorStore: this.vectorStore,
      onProgress: input.onProgress as never,
    });
    this.syncVectorCache();
    return result;
  }

  listIngestJobs(kbId: string, limit?: number): IngestJob[] {
    return this.repo.listIngestJobs(kbId, limit);
  }

  // -------------------------------------------------------------------------
  // 内容管理（增删改查）
  // -------------------------------------------------------------------------

  listDocuments(kbId: string): SourceDocument[] {
    return this.repo.listDocuments(kbId);
  }

  getDocument(id: string): SourceDocument | null {
    return this.repo.findDocument(id);
  }

  deleteDocument(id: string): boolean {
    const doc = this.repo.findDocument(id);
    if (!doc) return false;
    void this.vectorStore.deleteByDocument(id);
    this.syncVectorCache();
    return this.repo.deleteDocument(id);
  }

  /** 查询知识内容：返回片段及其来源定位。 */
  listChunks(documentId: string): Chunk[] {
    return this.repo.listChunksByDocument(documentId);
  }

  getChunkWithSource(id: string): {
    chunk: Chunk;
    document: SourceDocument | null;
    locator: Locator;
  } | null {
    const chunk = this.repo.findChunk(id);
    if (!chunk) return null;
    return {
      chunk,
      document: this.repo.findDocument(chunk.documentId),
      // 与检索结果保持同一定位形状：调用方只依赖 locator 就能还原完整位置
      locator: chunk.headingPath?.length
        ? { ...chunk.locator, headingPath: chunk.headingPath }
        : chunk.locator,
    };
  }

  /** 修改片段内容；改动后该片段需要重新计算 embedding。 */
  async updateChunk(id: string, content: string): Promise<Chunk | null> {
    const chunk = this.repo.findChunk(id);
    if (!chunk) return null;

    const hash = computeContentHash(content, chunk.headingPath);
    const tokenCount = Math.ceil(content.length / 2);
    this.repo.updateChunkContent(id, content, hash, tokenCount);

    await this.vectorStore.delete([id]);
    this.syncVectorCache();

    if (this.embedder) {
      await this.ingestor.embedTexts(chunk.kbId, this.embedder, this.vectorStore, [
        { id, kind: 'chunk', documentId: chunk.documentId, text: content, contentHash: hash },
      ]);
      this.syncVectorCache();
    }

    return this.repo.findChunk(id);
  }

  deleteChunk(id: string): boolean {
    void this.vectorStore.delete([id]);
    this.syncVectorCache();
    return this.repo.deleteChunk(id);
  }

  countChunks(kbId: string): number {
    return this.repo.countChunks(kbId);
  }

  /**
   * 补算缺失的向量。
   *
   * 场景：知识库在「未配置 embedding」时建立，当时只写入片段没有向量；
   * 之后配置好 embedding 再做增量同步，只有新增片段会计算向量，
   * 存量片段仍然没有 —— 表现为「chunk 数 29，向量数 6」，
   * 语义通道实际上只覆盖了一小部分内容。
   *
   * 这个操作幂等：已有向量的片段会被跳过。
   */
  async backfillEmbeddings(kbId: string): Promise<{
    scanned: number;
    computed: number;
    skipped: number;
    failed: number;
    durationMs: number;
  }> {
    const started = Date.now();

    if (!this.embedder) {
      throw new Error(
        '未配置 embedding 模型，无法补算向量。请先设置 KB_EMBEDDING_MODEL 与 KB_EMBEDDING_DIM。',
      );
    }

    const kb = this.repo.findKnowledgeBase(kbId);
    if (!kb) throw new Error(`知识库不存在：${kbId}`);

    // 找出没有对应向量的片段：按模型维度判断，避免与旧模型的向量混用
    const rows = this.repo
      .raw()
      .prepare(
        `SELECT c.id AS id, c.document_id AS document_id, c.content AS content, c.content_hash AS content_hash
         FROM kb_chunk c
         LEFT JOIN kb_vector v ON v.id = c.id AND v.model = ?
         WHERE c.kb_id = ? AND v.id IS NULL
         ORDER BY c.ordinal`,
      )
      .all(this.embedder.modelId, kb.id) as Array<Record<string, unknown>>;

    const stats = { scanned: 0, computed: 0, skipped: 0, failed: 0, durationMs: 0 };

    const items: Array<{
      id: string;
      kind: 'chunk' | 'qa';
      documentId: string | null;
      text: string;
      contentHash: string;
    }> = rows.map((row) => ({
      id: String(row.id),
      kind: 'chunk' as const,
      documentId: String(row.document_id),
      text: String(row.content),
      contentHash: String(row.content_hash),
    }));

    // 问答对同样需要向量
    const qaRows = this.repo
      .raw()
      .prepare(
        `SELECT q.id AS id, q.question AS question, q.answer AS answer, q.content_hash AS content_hash
         FROM kb_qa_pair q
         LEFT JOIN kb_vector v ON v.id = q.id AND v.model = ?
         WHERE q.kb_id = ? AND v.id IS NULL`,
      )
      .all(this.embedder.modelId, kb.id) as Array<Record<string, unknown>>;

    for (const row of qaRows) {
      items.push({
        id: String(row.id),
        kind: 'qa',
        documentId: null,
        text: `问：${row.question}\n答：${row.answer}`,
        contentHash: String(row.content_hash),
      });
    }

    stats.scanned = items.length;

    if (items.length === 0) {
      stats.durationMs = Date.now() - started;
      return stats;
    }

    // 分批调用，单批失败不影响其余批次。
    // 批大小取 16：阿里云百炼限制单次 input ≤ 20 条。
    const BATCH = 16;
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      try {
        const count = await this.ingestor.embedTexts(
          kb.id,
          this.embedder,
          this.vectorStore,
          batch,
        );
        stats.computed += count;
        stats.skipped += batch.length - count;
      } catch (error) {
        stats.failed += batch.length;
        console.error(
          `[kb] 补算向量失败（第 ${Math.floor(i / BATCH) + 1} 批，共 ${items.length} 条）：` +
            `${(error as Error).message}`,
        );
      }
    }

    this.syncVectorCache();
    stats.durationMs = Date.now() - started;
    return stats;
  }

  // -------------------------------------------------------------------------
  // 问答对
  // -------------------------------------------------------------------------

  async addQaPair(input: { kbId: string; question: string; answer: string; tags?: string[]; id?: string }): Promise<QaPair> {
    const contentHash = computeContentHash(`问：${input.question}\n答：${input.answer}`, null);
    const pair = this.repo.upsertQaPair({
      id: input.id,
      kbId: input.kbId,
      question: input.question,
      answer: input.answer,
      contentHash,
      tags: input.tags ?? [],
      embeddingModel: this.embedder?.modelId ?? null,
      embeddingDim: this.embedder?.dim ?? null,
    });

    if (this.embedder) {
      await this.ingestor.embedTexts(input.kbId, this.embedder, this.vectorStore, [
        {
          id: pair.id,
          kind: 'qa',
          documentId: null,
          text: `问：${input.question}\n答：${input.answer}`,
          contentHash,
        },
      ]);
      this.syncVectorCache();
    }

    return pair;
  }

  listQaPairs(kbId: string): QaPair[] {
    return this.repo.listQaPairs(kbId);
  }

  deleteQaPair(id: string): boolean {
    void this.vectorStore.delete([id]);
    this.syncVectorCache();
    return this.repo.deleteQaPair(id);
  }

  /**
   * 反馈闭环：补录问答对，并把指定的未解决问题标记为已处理。
   */
  async resolveIssueWithQaPair(input: {
    kbId: string;
    issueIds: string[];
    question: string;
    answer: string;
    tags?: string[];
  }): Promise<{ qaPair: QaPair; resolvedCount: number }> {
    const qaPair = await this.addQaPair({
      kbId: input.kbId,
      question: input.question,
      answer: input.answer,
      tags: input.tags,
    });
    const resolvedCount = this.repo.resolveUnresolvedIssues(input.issueIds, qaPair.id);
    return { qaPair, resolvedCount };
  }

  // -------------------------------------------------------------------------
  // 问答
  // -------------------------------------------------------------------------

  /** 检索（可单独调用，用于调试与验收）。 */
  async retrieve(options: {
    kbId: string;
    query: string;
    topK?: number;
    documentIds?: string[];
  }) {
    return this.retriever.retrieve({
      kbId: options.kbId,
      query: options.query,
      topK: normalizeTopK(options.topK),
      documentIds: options.documentIds,
    });
  }

  private async buildGenerateOptions(options: AskOptions, timing: TimingCollector): Promise<{
    generate: GenerateOptions;
    conversation: Conversation;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
  }> {
    const kb = this.repo.findKnowledgeBase(options.kbId);
    if (!kb) throw new Error(`知识库不存在：${options.kbId}`);

    const conversation = timing.measure('context', () => {
      if (!options.conversationId) return this.repo.createConversation(kb.id, options.siteKey ?? 'default');

      const existing = this.repo.findConversation(options.conversationId);
      if (!existing || existing.kbId !== kb.id) {
        throw new Error('会话不存在或不属于该知识库');
      }
      // siteKey 是公开插件的隔离边界。CLI/内部调用不传 siteKey，保留
      // 继续管理同一知识库会话的能力。
      if (options.siteKey && existing.siteKey !== options.siteKey) {
        throw new Error('会话不属于当前站点');
      }
      return existing;
    });

    // 检索通常会等待 embedding 网络请求；先启动它，再读取本地会话历史，
    // 两段耗时可以重叠，减少用户感知到的总等待时间。
    const retrievalPromise = timing.measureAsync('retrieval', () =>
      this.retriever.retrieve({
        kbId: kb.id,
        query: options.query,
        topK: normalizeTopK(options.topK),
        documentIds: options.documentIds,
      }),
    );

    const history = timing.measure('context', () =>
      this.repo
        .recentMessages(conversation.id, this.historyTurns * 2)
        .map((message) => ({ role: message.role, content: message.content })),
    );
    const retrieval = await retrievalPromise;

    return {
      conversation,
      history,
      generate: {
        query: options.query,
        retrieval,
        history,
        llm: options.llm ?? this.llm,
        model: options.model,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        images: options.images,
        thresholds: this.thresholds,
        timing,
        // 环境变量可以全局关闭校验；请求参数只能进一步关闭，不能绕过该配置重新开启。
        claimCheck: this.claimCheckEnabled && options.claimCheck !== false,
        signal: options.signal,
      },
    };
  }

  /** 非流式问答：完整执行三道闸门并落库。 */
  async ask(options: AskOptions): Promise<AnswerResult> {
    const timing = new TimingCollector();
    const { generate, conversation } = await this.buildGenerateOptions(options, timing);

    const result = await generateAnswer(generate);

    const userMessage = this.repo.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: options.query,
      citations: [],
      gateDecision: null,
      modelId: null,
      latencyMs: null,
    });

    const latencyMs = timing.totalMs;
    const assistantMessage = this.repo.appendMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: result.answer,
      citations: result.citations,
      gateDecision: result.gate.decision,
      retrieval: {
        mode: generate.retrieval.mode,
        topScore: generate.retrieval.topScore,
        hitCount: generate.retrieval.hits.length,
        hits: generate.retrieval.hits.map((hit) => ({
          chunkId: hit.chunkId,
          score: hit.score,
          documentTitle: hit.documentTitle,
          ranks: hit.ranks,
        })),
        semanticDegraded: generate.retrieval.semanticDegraded,
      },
      claimChecks: result.claimChecks,
      modelId: this.llm?.modelId ?? null,
      latencyMs,
      tokenUsage: result.usage,
    });

    void userMessage;

    // 未解决问题自动入 backlog，供维护者复查
    this.recordUnresolvedIfNeeded(
      conversation.kbId,
      options.query,
      result.gate.decision,
      generate.retrieval,
      assistantMessage.id,
    );

    this.logTimings(options.query, result.timings);

    return {
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      answer: result.answer,
      citations: result.citations,
      gate: result.gate,
      retrieval: generate.retrieval,
      claimChecks: result.claimChecks,
      unsupportedClaimCount: result.unsupportedClaimCount,
      modelId: this.llm?.modelId ?? null,
      tokenUsage: result.usage,
      latencyMs,
      timings: result.timings,
    };
  }

  /**
   * 输出分阶段耗时。
   *
   * 由 KB_LOG_TIMINGS 控制（默认开启）：设为 0 或 false 可关闭，
   * 避免在批量评测场景刷屏。
   */
  private logTimings(query: string, t: StageTimings): void {
    if (!this.logTimingsEnabled) return;
    const parts = [
      `检索 ${t.retrievalMs}ms`,
      t.localGateMs > 0 ? `闸门① ${t.localGateMs}ms` : null,
      t.evidenceGateMs > 0 ? `证据闸门 ${t.evidenceGateMs}ms` : null,
      t.generateMs > 0 ? `生成 ${t.generateMs}ms` : null,
      t.claimCheckMs > 0 ? `校验 ${t.claimCheckMs}ms` : null,
      t.contextMs > 0 ? `上下文 ${t.contextMs}ms` : null,
    ].filter((p): p is string => p !== null);

    console.log(
      `[kb] 查询 ${t.totalMs}ms | ${parts.join(' | ')} ` +
        `| LLM ${t.llmCalls} 次 / 输入 ${t.inputChars} 字符 | ${truncate(query, 24)}`,
    );
  }

  /** 流式问答：逐事件产出，结束后落库。 */
  async *askStream(options: AskOptions): AsyncGenerator<StreamEvent & { conversationId?: string }> {
    const timing = new TimingCollector();
    const { generate, conversation } = await this.buildGenerateOptions(options, timing);

    this.repo.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: options.query,
      citations: [],
      gateDecision: null,
      modelId: null,
      latencyMs: null,
    });

    yield { type: 'gate', data: { conversationId: conversation.id } } as StreamEvent & {
      conversationId?: string;
    };

    let final: StreamDonePayload | null = null;

    for await (const event of streamAnswer(generate)) {
      if (event.type === 'done') {
        final = event.data as StreamDonePayload;
        continue;
      }
      if (event.type === 'gate') continue; // 已在上面发出（带 conversationId）
      yield event;
    }

    if (final) {
      const latencyMs = timing.totalMs;
      const timings = final.timings ?? timing.toStageTimings();
      const assistantMessage = this.repo.appendMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: final.answer,
        citations: final.citations,
        gateDecision: final.gate.decision,
        retrieval: {
          mode: generate.retrieval.mode,
          topScore: generate.retrieval.topScore,
          hitCount: generate.retrieval.hits.length,
          semanticDegraded: generate.retrieval.semanticDegraded,
        },
        claimChecks: final.claimChecks,
        modelId: this.llm?.modelId ?? null,
        latencyMs,
        tokenUsage: final.usage,
      });

      this.recordUnresolvedIfNeeded(
        conversation.kbId,
        options.query,
        final.gate.decision,
        generate.retrieval,
        assistantMessage.id,
      );

      this.logTimings(options.query, timings);

      yield {
        type: 'done',
        data: {
          conversationId: conversation.id,
          messageId: assistantMessage.id,
          answer: final.answer,
          citations: final.citations,
          gate: final.gate,
          claimChecks: final.claimChecks,
          unsupportedClaimCount: final.unsupportedClaimCount,
          latencyMs,
          modelId: this.llm?.modelId ?? null,
          timings,
          retrieval: {
            mode: generate.retrieval.mode,
            topScore: generate.retrieval.topScore,
            hitCount: generate.retrieval.hits.length,
            semanticDegraded: generate.retrieval.semanticDegraded,
          },
        },
      };
    }
  }

  /** 拒答、部分可答与证据冲突都要进 backlog，供维护者补充知识。 */
  private recordUnresolvedIfNeeded(
    kbId: string,
    query: string,
    decision: AnswerResult['gate']['decision'],
    retrieval: AnswerResult['retrieval'],
    messageId: string,
  ): void {
    let reason: UnresolvedReason | null = null;
    if (decision === 'no_evidence') {
      reason = retrieval.hits.length === 0 ? 'no_recall' : 'low_evidence';
    } else if (decision === 'conflict') {
      reason = 'contradiction';
    }
    if (!reason) return;

    this.repo.createUnresolvedIssue({
      kbId,
      query,
      reason,
      evidence: {
        messageId,
        decision,
        retrievalMode: retrieval.mode,
        topScore: retrieval.topScore,
        hitCount: retrieval.hits.length,
        semanticDegraded: retrieval.semanticDegraded,
        semanticDegradeReason: retrieval.semanticDegradeReason,
      },
    });
  }

  // -------------------------------------------------------------------------
  // 对话历史与反馈
  // -------------------------------------------------------------------------

  getConversation(id: string): Conversation | null {
    return this.repo.findConversation(id);
  }

  getMessages(conversationId: string, limit = 50): Message[] {
    return this.repo.recentMessages(conversationId, limit);
  }

  getMessage(id: string): Message | null {
    return this.repo.findMessage(id);
  }

  /** 提交认可 / 不认可反馈。不认可会自动进入未解决问题 backlog。 */
  submitFeedback(input: {
    messageId: string;
    rating: 'up' | 'down';
    reason?: string;
    comment?: string;
  }): Feedback {
    const message = this.repo.findMessage(input.messageId);
    if (!message) throw new Error(`消息不存在：${input.messageId}`);

    const feedback = this.repo.createFeedback({
      messageId: input.messageId,
      rating: input.rating,
      reason: input.reason ?? null,
      comment: input.comment ?? null,
    });

    // 只在「第一次点踩」时生成待办：用户改主意反复提交不该刷出多条重复问题。
    // 但重新点踩时要刷新已有待办的证据，保证维护者看到的是最新说明。
    if (input.rating === 'down') {
      const conversation = this.repo.findConversation(message.conversationId);
      if (conversation) {
        const messages = this.repo.recentMessages(conversation.id, 50);
        const index = messages.findIndex((item) => item.id === message.id);
        const question = index > 0 ? messages[index - 1] : null;
        const query = question?.role === 'user' ? question.content : message.content.slice(0, 200);

        const evidence = {
          messageId: message.id,
          feedbackId: feedback.id,
          feedbackReason: input.reason ?? null,
          comment: input.comment ?? null,
          gateDecision: message.gateDecision,
          answer: message.content.slice(0, 1000),
        };

        this.repo.upsertDownvoteIssue({ kbId: conversation.kbId, query, evidence });
      }
    }

    return feedback;
  }

  listFeedback(options?: { status?: 'open' | 'handled'; limit?: number }): Feedback[] {
    return this.repo.listFeedback(options);
  }

  markFeedbackHandled(id: string): boolean {
    return this.repo.updateFeedbackStatus(id, 'handled');
  }

  // -------------------------------------------------------------------------
  // 维护者复查
  // -------------------------------------------------------------------------

  listUnresolvedIssues(kbId: string, options?: { status?: 'open' | 'handled' | 'dismissed'; limit?: number }): UnresolvedIssue[] {
    return this.repo.listUnresolvedIssues(kbId, options);
  }

  /**
   * 知识缺口报告：把未解决问题按原因与问题文本聚类，便于批量补充。
   */
  knowledgeGapReport(kbId: string): {
    total: number;
    byReason: Record<string, number>;
    topQueries: Array<{ query: string; count: number; reasons: string[]; ids: string[] }>;
  } {
    const issues = this.repo.listUnresolvedIssues(kbId, { status: 'open', limit: 500 });
    const byReason: Record<string, number> = {};
    const grouped = new Map<string, { count: number; reasons: Set<string>; ids: string[] }>();

    for (const issue of issues) {
      byReason[issue.reason] = (byReason[issue.reason] ?? 0) + 1;
      // 归一化后聚类：去空白、转小写，便于把同一问题的不同问法合并
      const key = issue.query.replace(/\s+/g, '').toLowerCase();
      const entry = grouped.get(key) ?? { count: 0, reasons: new Set<string>(), ids: [] };
      entry.count += 1;
      entry.reasons.add(issue.reason);
      entry.ids.push(issue.id);
      grouped.set(key, entry);
    }

    return {
      total: issues.length,
      byReason,
      topQueries: [...grouped.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 20)
        .map(([, entry]) => ({
          query: issues.find((issue) => issue.id === entry.ids[0])?.query ?? '',
          count: entry.count,
          reasons: [...entry.reasons],
          ids: entry.ids,
        })),
    };
  }

  dismissIssue(id: string): boolean {
    return this.repo.updateUnresolvedStatus(id, 'dismissed');
  }

  /** 待办按原因的数量分布，用于清理前的确认。 */
  countIssuesByReason(kbId: string, status: 'open' | 'handled' | 'dismissed' = 'open') {
    return this.repo.countIssuesByReason(kbId, status);
  }

  /**
   * 批量关闭待办。
   *
   * 典型用途：清理某次 bug 期间集中产生的无效待办。
   * 支持按 id 或按原因 + 时间范围，后者更安全（不会误伤新问题）。
   */
  closeIssues(
    kbId: string,
    filter: {
      ids?: string[];
      reason?: UnresolvedReason;
      before?: string;
      status?: 'handled' | 'dismissed';
    },
  ): number {
    if (!filter.ids?.length && !filter.reason && !filter.before) {
      throw new Error(
        '必须指定筛选条件（--ids / --reason / --before），避免误关全部待办',
      );
    }
    return this.repo.bulkUpdateIssues({
      kbId,
      ids: filter.ids,
      reason: filter.reason,
      before: filter.before,
      status: filter.status ?? 'dismissed',
    });
  }

  /** 反馈统计（按知识库可选）。 */
  feedbackStats(kbId?: string) {
    return this.repo.feedbackStats(kbId);
  }

  // -------------------------------------------------------------------------
  // 统计
  // -------------------------------------------------------------------------

  stats(kbId: string): {
    documents: number;
    chunks: number;
    qaPairs: number;
    vectors: number;
    openIssues: number;
  } {
    const documents = this.repo.listDocuments(kbId);
    return {
      documents: documents.length,
      chunks: this.repo.countChunks(kbId),
      qaPairs: this.repo.listQaPairs(kbId).length,
      vectors: 0, // 由外部异步查询填充，避免 stats 变成异步接口
      openIssues: this.repo.listUnresolvedIssues(kbId, { status: 'open' }).length,
    };
  }

  async vectorCount(kbId: string): Promise<number> {
    return this.vectorStore.count(kbId);
  }

  /** 默认分块参数，供 CLI/文档展示。 */
  chunkOptions(): typeof DEFAULT_CHUNK_OPTIONS {
    return DEFAULT_CHUNK_OPTIONS;
  }
}

export function defaultDatabasePath(): string {
  return process.env.KB_DATABASE_PATH ?? join(process.cwd(), 'data', 'kb.db');
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

export type { GenerateOptions, StreamEvent };

/** 统一限制外部传入的召回数量，避免负数、Infinity 或超大值进入 SQL LIMIT。 */
function normalizeTopK(value: number | undefined): number {
  if (value === undefined) return 6;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error('topK 必须是 1 到 50 之间的整数');
  }
  return value;
}

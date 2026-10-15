/**
 * 仓储层：负责领域类型与 SQL 行之间的映射。
 *
 * 所有写操作走业务方法，不暴露裸 SQL 给上层，避免引擎散落存储细节。
 */

import { randomUUID } from 'node:crypto';
import type { SqliteDatabase, SqliteStatement } from './sqlite-driver.js';
import type {
  Chunk,
  Citation,
  Conversation,
  Feedback,
  FeedbackRating,
  FeedbackStatus,
  IngestJob,
  IngestMode,
  IngestStats,
  IngestStatus,
  KnowledgeBase,
  Locator,
  Message,
  MessageRole,
  ParseStatus,
  QaPair,
  SourceDocument,
  UnresolvedIssue,
  UnresolvedReason,
  UnresolvedStatus,
  WidgetConfig,
} from '../types.js';
import { DEFAULT_WIDGET_CONFIG } from '../types.js';
import { expandForIndex } from '../retrieve/tokenizer.js';

const nowIso = () => new Date().toISOString();

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

export class KnowledgeBaseRepository {
  constructor(private readonly db: SqliteDatabase) {}

  // -------------------------------------------------------------------------
  // 知识库
  // -------------------------------------------------------------------------

  createKnowledgeBase(input: {
    name: string;
    description?: string | null;
    chunkConfigVersion: string;
    embeddingModel?: string | null;
    embeddingDim?: number | null;
    publicKey?: string | null;
    allowedOrigins?: string[];
    widgetConfig?: Partial<WidgetConfig>;
  }): KnowledgeBase {
    const id = `kb_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO kb_knowledge_base
         (id, name, description, chunk_config_version, embedding_model, embedding_dim,
          public_key, allowed_origins, widget_config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.description ?? null,
        input.chunkConfigVersion,
        input.embeddingModel ?? null,
        input.embeddingDim ?? null,
        input.publicKey ?? null,
        JSON.stringify(input.allowedOrigins ?? []),
        JSON.stringify({ ...DEFAULT_WIDGET_CONFIG, ...input.widgetConfig }),
        ts,
        ts,
      );
    const kb = this.findKnowledgeBase(id);
    if (!kb) throw new Error(`创建知识库失败：${id}`);
    return kb;
  }

  findKnowledgeBase(idOrName: string): KnowledgeBase | null {
    const row = this.db
      .prepare('SELECT * FROM kb_knowledge_base WHERE id = ? OR name = ?')
      .get(idOrName, idOrName) as Record<string, unknown> | undefined;
    return row ? mapKnowledgeBase(row) : null;
  }

  findKnowledgeBaseByPublicKey(publicKey: string): KnowledgeBase | null {
    const row = this.db
      .prepare('SELECT * FROM kb_knowledge_base WHERE public_key = ?')
      .get(publicKey) as Record<string, unknown> | undefined;
    return row ? mapKnowledgeBase(row) : null;
  }

  listKnowledgeBases(): KnowledgeBase[] {
    const rows = this.db
      .prepare('SELECT * FROM kb_knowledge_base ORDER BY created_at')
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapKnowledgeBase);
  }

  updateKnowledgeBase(
    id: string,
    patch: Partial<
      Pick<
        KnowledgeBase,
        'name' | 'description' | 'embeddingModel' | 'embeddingDim' | 'allowedOrigins' | 'widgetConfig' | 'publicKey'
      >
    >,
  ): KnowledgeBase {
    const current = this.findKnowledgeBase(id);
    if (!current) throw new Error(`知识库不存在：${id}`);
    const next: KnowledgeBase = { ...current, ...patch, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE kb_knowledge_base SET
           name = ?, description = ?, embedding_model = ?, embedding_dim = ?,
           public_key = ?, allowed_origins = ?, widget_config = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.description,
        next.embeddingModel,
        next.embeddingDim,
        next.publicKey,
        JSON.stringify(next.allowedOrigins),
        JSON.stringify(next.widgetConfig),
        next.updatedAt,
        id,
      );
    return next;
  }

  deleteKnowledgeBase(id: string): boolean {
    const result = this.db.prepare('DELETE FROM kb_knowledge_base WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // 文档
  // -------------------------------------------------------------------------

  findDocumentBySource(kbId: string, sourcePath: string | null, sourceUrl: string | null): SourceDocument | null {
    const row = sourcePath
      ? (this.db
          .prepare('SELECT * FROM kb_document WHERE kb_id = ? AND source_path = ?')
          .get(kbId, sourcePath) as Record<string, unknown> | undefined)
      : (this.db
          .prepare('SELECT * FROM kb_document WHERE kb_id = ? AND source_url = ?')
          .get(kbId, sourceUrl) as Record<string, unknown> | undefined);
    return row ? mapDocument(row) : null;
  }

  findDocument(id: string): SourceDocument | null {
    const row = this.db.prepare('SELECT * FROM kb_document WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapDocument(row) : null;
  }

  listDocuments(kbId: string): SourceDocument[] {
    const rows = this.db
      .prepare('SELECT * FROM kb_document WHERE kb_id = ? ORDER BY source_path IS NULL, source_path, source_url')
      .all(kbId) as Array<Record<string, unknown>>;
    return rows.map(mapDocument);
  }

  upsertDocument(input: {
    id?: string;
    kbId: string;
    title: string;
    sourcePath: string | null;
    sourceUrl: string | null;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    mtime: string;
    parseStatus: ParseStatus;
    parseError: string | null;
    parseWarnings?: string[];
    parseVersion: string;
    chunkConfigVersion: string;
    chunkCount: number;
  }): SourceDocument {
    const ts = nowIso();
    const warningsJson = JSON.stringify(input.parseWarnings ?? []);
    const existing = input.id ? this.findDocument(input.id) : null;

    if (existing) {
      this.db
        .prepare(
          `UPDATE kb_document SET
             title = ?, source_path = ?, source_url = ?, mime_type = ?, size_bytes = ?,
             sha256 = ?, mtime = ?, parse_status = ?, parse_error = ?, parse_warnings = ?,
             parse_version = ?, chunk_config_version = ?, chunk_count = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.title,
          input.sourcePath,
          input.sourceUrl,
          input.mimeType,
          input.sizeBytes,
          input.sha256,
          input.mtime,
          input.parseStatus,
          input.parseError,
          warningsJson,
          input.parseVersion,
          input.chunkConfigVersion,
          input.chunkCount,
          ts,
          existing.id,
        );
      const updated = this.findDocument(existing.id);
      if (!updated) throw new Error(`更新文档失败：${existing.id}`);
      return updated;
    }

    const id = input.id ?? `doc_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    this.db
      .prepare(
        `INSERT INTO kb_document
         (id, kb_id, title, source_path, source_url, mime_type, size_bytes, sha256, mtime,
          parse_status, parse_error, parse_warnings, parse_version, chunk_config_version, chunk_count,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kbId,
        input.title,
        input.sourcePath,
        input.sourceUrl,
        input.mimeType,
        input.sizeBytes,
        input.sha256,
        input.mtime,
        input.parseStatus,
        input.parseError,
        warningsJson,
        input.parseVersion,
        input.chunkConfigVersion,
        input.chunkCount,
        ts,
        ts,
      );
    const created = this.findDocument(id);
    if (!created) throw new Error(`创建文档失败：${id}`);
    return created;
  }

  deleteDocument(id: string): boolean {
    return this.db.prepare('DELETE FROM kb_document WHERE id = ?').run(id).changes > 0;
  }

  // -------------------------------------------------------------------------
  // 分块
  // -------------------------------------------------------------------------

  listChunksByDocument(documentId: string): Chunk[] {
    const rows = this.db
      .prepare('SELECT * FROM kb_chunk WHERE document_id = ? ORDER BY ordinal')
      .all(documentId) as Array<Record<string, unknown>>;
    return rows.map(mapChunk);
  }

  /** 全库扫描 contentHash → chunkId，供增量差异计算。 */
  mapChunksByHash(kbId: string): Map<string, Chunk> {
    const rows = this.db
      .prepare('SELECT * FROM kb_chunk WHERE kb_id = ? ORDER BY ordinal')
      .all(kbId) as Array<Record<string, unknown>>;
    const map = new Map<string, Chunk>();
    for (const row of rows) {
      const chunk = mapChunk(row);
      if (!map.has(chunk.contentHash)) map.set(chunk.contentHash, chunk);
    }
    return map;
  }

  findChunk(id: string): Chunk | null {
    const row = this.db.prepare('SELECT * FROM kb_chunk WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapChunk(row) : null;
  }

  findChunks(ids: string[]): Chunk[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM kb_chunk WHERE id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>;
    return rows.map(mapChunk);
  }

  /**
   * 用一组新 chunk 替换某个文档的全部 chunk。
   *
   * 在单个事务内完成 delete-then-insert，避免中途失败导致文档半更新。
   */
  replaceDocumentChunks(
    documentId: string,
    chunks: Array<{
      id: string;
      kbId: string;
      ordinal: number;
      content: string;
      contentHash: string;
      tokenCount: number;
      locator: Locator;
      headingPath: string[] | null;
      embeddingModel: string | null;
      embeddingDim: number | null;
    }>,
  ): void {
    // FTS 索引需要按 rowid 维护；先取出旧 rowid 以便精确清理
    const oldRowIds = (
      this.db.prepare('SELECT rowid FROM kb_chunk WHERE document_id = ?').all(documentId) as Array<
        Record<string, unknown>
      >
    ).map((row) => Number(row.rowid));

    const del = this.db.prepare('DELETE FROM kb_chunk WHERE document_id = ?');
    const ins = this.db.prepare(
      `INSERT INTO kb_chunk
       (id, kb_id, document_id, ordinal, content, content_hash, token_count, locator,
        heading_path, embedding_model, embedding_dim, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const delFts = this.db.prepare('DELETE FROM kb_chunk_fts WHERE rowid = ?');
    const insFts = this.db.prepare('INSERT INTO kb_chunk_fts(rowid, content, heading) VALUES (?, ?, ?)');
    const lastRowId = this.db.prepare('SELECT last_insert_rowid() AS id');
    const ts = nowIso();

    this.db.exec('BEGIN');
    try {
      del.run(documentId);
      for (const rowId of oldRowIds) delFts.run(rowId);

      for (const chunk of chunks) {
        ins.run(
          chunk.id,
          chunk.kbId,
          documentId,
          chunk.ordinal,
          chunk.content,
          chunk.contentHash,
          chunk.tokenCount,
          JSON.stringify(chunk.locator),
          chunk.headingPath ? JSON.stringify(chunk.headingPath) : null,
          chunk.embeddingModel,
          chunk.embeddingDim,
          ts,
        );
        const newRowId = Number((lastRowId.get() as Record<string, unknown>).id);
        insFts.run(
          newRowId,
          expandForIndex(chunk.content),
          chunk.headingPath ? expandForIndex(chunk.headingPath.join(' ')) : '',
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  insertChunk(input: {
    id: string;
    kbId: string;
    documentId: string;
    ordinal: number;
    content: string;
    contentHash: string;
    tokenCount: number;
    locator: Locator;
    headingPath: string[] | null;
    embeddingModel: string | null;
    embeddingDim: number | null;
  }): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO kb_chunk
           (id, kb_id, document_id, ordinal, content, content_hash, token_count, locator,
            heading_path, embedding_model, embedding_dim, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.kbId,
          input.documentId,
          input.ordinal,
          input.content,
          input.contentHash,
          input.tokenCount,
          JSON.stringify(input.locator),
          input.headingPath ? JSON.stringify(input.headingPath) : null,
          input.embeddingModel,
          input.embeddingDim,
          nowIso(),
        );

      const rowId = Number(
        (this.db.prepare('SELECT last_insert_rowid() AS id').get() as Record<string, unknown>).id,
      );
      this.db
        .prepare('INSERT INTO kb_chunk_fts(rowid, content, heading) VALUES (?, ?, ?)')
        .run(rowId, expandForIndex(input.content), input.headingPath ? expandForIndex(input.headingPath.join(' ')) : '');

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  updateChunkContent(id: string, content: string, contentHash: string, tokenCount: number): boolean {
    const row = this.db.prepare('SELECT rowid FROM kb_chunk WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return false;
    const rowId = Number(row.rowid);

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `UPDATE kb_chunk SET content = ?, content_hash = ?, token_count = ?,
             embedding_model = NULL, embedding_dim = NULL
           WHERE id = ?`,
        )
        .run(content, contentHash, tokenCount, id);

      // 关键词索引必须同步更新，否则改完内容仍按旧文本命中
      this.db.prepare('DELETE FROM kb_chunk_fts WHERE rowid = ?').run(rowId);
      const heading = this.db.prepare('SELECT heading_path FROM kb_chunk WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      const headingText = heading?.heading_path ? parseJson<string[] | null>(heading.heading_path, null) : null;
      this.db
        .prepare('INSERT INTO kb_chunk_fts(rowid, content, heading) VALUES (?, ?, ?)')
        .run(rowId, expandForIndex(content), headingText ? expandForIndex(headingText.join(' ')) : '');

      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteChunk(id: string): boolean {
    const row = this.db.prepare('SELECT rowid FROM kb_chunk WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return false;
    const rowId = Number(row.rowid);

    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM kb_chunk_fts WHERE rowid = ?').run(rowId);
      this.db.prepare('DELETE FROM kb_chunk WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  countChunks(kbId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM kb_chunk WHERE kb_id = ?').get(kbId);
    return row ? Number(row.n) : 0;
  }

  // -------------------------------------------------------------------------
  // 问答对
  // -------------------------------------------------------------------------

  upsertQaPair(input: {
    id?: string;
    kbId: string;
    question: string;
    answer: string;
    contentHash: string;
    tags: string[];
    embeddingModel: string | null;
    embeddingDim: number | null;
  }): QaPair {
    const ts = nowIso();
    if (input.id) {
      const existing = this.findQaPair(input.id);
      if (existing) {
        const row = this.db.prepare('SELECT rowid FROM kb_qa_pair WHERE id = ?').get(input.id) as
          | Record<string, unknown>
          | undefined;
        const rowId = row ? Number(row.rowid) : null;

        this.db.exec('BEGIN');
        try {
          this.db
            .prepare(
              `UPDATE kb_qa_pair SET question = ?, answer = ?, content_hash = ?, tags = ?,
                 embedding_model = ?, embedding_dim = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              input.question,
              input.answer,
              input.contentHash,
              JSON.stringify(input.tags),
              input.embeddingModel,
              input.embeddingDim,
              ts,
              input.id,
            );

          if (rowId !== null) {
            this.db.prepare('DELETE FROM kb_qa_fts WHERE rowid = ?').run(rowId);
            this.db
              .prepare('INSERT INTO kb_qa_fts(rowid, question, answer) VALUES (?, ?, ?)')
              .run(rowId, expandForIndex(input.question), expandForIndex(input.answer));
          }
          this.db.exec('COMMIT');
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }

        const updated = this.findQaPair(input.id);
        if (!updated) throw new Error(`更新问答对失败：${input.id}`);
        return updated;
      }
    }

    const id = input.id ?? `qa_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO kb_qa_pair
           (id, kb_id, question, answer, content_hash, tags, embedding_model, embedding_dim, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.kbId,
          input.question,
          input.answer,
          input.contentHash,
          JSON.stringify(input.tags),
          input.embeddingModel,
          input.embeddingDim,
          ts,
          ts,
        );

      const rowId = Number(
        (this.db.prepare('SELECT last_insert_rowid() AS id').get() as Record<string, unknown>).id,
      );
      this.db
        .prepare('INSERT INTO kb_qa_fts(rowid, question, answer) VALUES (?, ?, ?)')
        .run(rowId, expandForIndex(input.question), expandForIndex(input.answer));

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const created = this.findQaPair(id);
    if (!created) throw new Error(`创建问答对失败：${id}`);
    return created;
  }

  findQaPair(id: string): QaPair | null {
    const row = this.db.prepare('SELECT * FROM kb_qa_pair WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapQaPair(row) : null;
  }

  findQaPairs(ids: string[]): QaPair[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM kb_qa_pair WHERE id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>;
    return rows.map(mapQaPair);
  }

  listQaPairs(kbId: string): QaPair[] {
    const rows = this.db
      .prepare('SELECT * FROM kb_qa_pair WHERE kb_id = ? ORDER BY created_at')
      .all(kbId) as Array<Record<string, unknown>>;
    return rows.map(mapQaPair);
  }

  mapQaByHash(kbId: string): Map<string, QaPair> {
    const map = new Map<string, QaPair>();
    for (const pair of this.listQaPairs(kbId)) {
      if (!map.has(pair.contentHash)) map.set(pair.contentHash, pair);
    }
    return map;
  }

  deleteQaPair(id: string): boolean {
    const row = this.db.prepare('SELECT rowid FROM kb_qa_pair WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return false;
    const rowId = Number(row.rowid);

    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM kb_qa_fts WHERE rowid = ?').run(rowId);
      this.db.prepare('DELETE FROM kb_qa_pair WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // 摄取任务
  // -------------------------------------------------------------------------

  createIngestJob(kbId: string, mode: IngestMode): IngestJob {
    const id = `job_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const startedAt = nowIso();
    this.db
      .prepare(
        'INSERT INTO kb_ingest_job(id, kb_id, mode, status, started_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, kbId, mode, 'running', startedAt);
    return { id, kbId, mode, status: 'running', stats: null, error: null, startedAt, finishedAt: null };
  }

  finishIngestJob(id: string, status: IngestStatus, stats: IngestStats | null, error: string | null): void {
    this.db
      .prepare('UPDATE kb_ingest_job SET status = ?, stats = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(status, stats ? JSON.stringify(stats) : null, error, nowIso(), id);
  }

  listIngestJobs(kbId: string, limit = 10): IngestJob[] {
    const rows = this.db
      .prepare('SELECT * FROM kb_ingest_job WHERE kb_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(kbId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      kbId: String(row.kb_id),
      mode: String(row.mode) as IngestMode,
      status: String(row.status) as IngestStatus,
      stats: parseJson<IngestStats | null>(row.stats, null),
      error: row.error === null ? null : String(row.error),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
    }));
  }

  // -------------------------------------------------------------------------
  // 对话
  // -------------------------------------------------------------------------

  createConversation(kbId: string, siteKey: string): Conversation {
    const id = `conv_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const createdAt = nowIso();
    this.db
      .prepare('INSERT INTO kb_conversation(id, kb_id, site_key, created_at) VALUES (?, ?, ?, ?)')
      .run(id, kbId, siteKey, createdAt);
    return { id, kbId, siteKey, createdAt };
  }

  findConversation(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM kb_conversation WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      kbId: String(row.kb_id),
      siteKey: String(row.site_key),
      createdAt: String(row.created_at),
    };
  }

  /** 取最近若干轮消息，用于多轮上下文。按时间正序返回。 */
  recentMessages(conversationId: string, limit: number): Message[] {
    // 内层取最近 N 条（倒序），外层再翻正序。
    // 必须显式选出 rowid：外层是对子查询的查询，SELECT * 不会带出隐式列。
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT rowid AS rid, * FROM kb_message
           WHERE conversation_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?
         ) ORDER BY created_at ASC, rid ASC`,
      )
      .all(conversationId, limit) as Array<Record<string, unknown>>;
    return rows.map(mapMessage);
  }

  appendMessage(input: {
    conversationId: string;
    role: MessageRole;
    content: string;
    citations: Citation[];
    gateDecision: string | null;
    retrieval?: unknown;
    claimChecks?: unknown;
    modelId: string | null;
    latencyMs: number | null;
    tokenUsage?: unknown;
  }): Message {
    const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO kb_message
         (id, conversation_id, role, content, citations, gate_decision, retrieval,
          claim_checks, model_id, latency_ms, token_usage, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.role,
        input.content,
        JSON.stringify(input.citations),
        input.gateDecision,
        input.retrieval === undefined ? null : JSON.stringify(input.retrieval),
        input.claimChecks === undefined ? null : JSON.stringify(input.claimChecks),
        input.modelId,
        input.latencyMs,
        input.tokenUsage === undefined ? null : JSON.stringify(input.tokenUsage),
        createdAt,
      );
    return {
      id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      citations: input.citations,
      gateDecision: (input.gateDecision as Message['gateDecision']) ?? null,
      modelId: input.modelId,
      latencyMs: input.latencyMs,
      createdAt,
    };
  }

  findMessage(id: string): Message | null {
    const row = this.db.prepare('SELECT * FROM kb_message WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapMessage(row) : null;
  }

  // -------------------------------------------------------------------------
  // 反馈与未解决问题
  // -------------------------------------------------------------------------

  /**
   * 写入反馈。同一条回答只保留一条记录（唯一索引保证）。
   *
   * 重复提交时**更新**已有记录而不是插入：用户改主意（先赞后踩）
   * 是合理行为，但库里不该留下两条互相矛盾的评价。
   * 返回 `changed` 让调用方知道是新建还是覆盖。
   */
  createFeedback(input: {
    messageId: string;
    rating: FeedbackRating;
    reason?: string | null;
    comment?: string | null;
  }): Feedback & { changed: 'created' | 'updated' } {
    const now = nowIso();
    const existing = this.db
      .prepare('SELECT * FROM kb_feedback WHERE message_id = ?')
      .get(input.messageId) as Record<string, unknown> | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE kb_feedback SET rating = ?, reason = ?, comment = ?, status = 'open', updated_at = ?
           WHERE message_id = ?`,
        )
        .run(input.rating, input.reason ?? null, input.comment ?? null, now, input.messageId);

      return {
        id: String(existing.id),
        messageId: input.messageId,
        rating: input.rating,
        reason: input.reason ?? null,
        comment: input.comment ?? null,
        // 用户重新表态后需要重新进入待办，因此状态回到 open
        status: 'open',
        createdAt: String(existing.created_at),
        changed: 'updated',
      };
    }

    const id = `fb_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    this.db
      .prepare(
        `INSERT INTO kb_feedback(id, message_id, rating, reason, comment, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.messageId,
        input.rating,
        input.reason ?? null,
        input.comment ?? null,
        'open',
        now,
        now,
      );
    return {
      id,
      messageId: input.messageId,
      rating: input.rating,
      reason: input.reason ?? null,
      comment: input.comment ?? null,
      status: 'open',
      createdAt: now,
      changed: 'created',
    };
  }

  listFeedback(options: { status?: FeedbackStatus; limit?: number } = {}): Feedback[] {
    const limit = options.limit ?? 50;
    const rows = options.status
      ? (this.db
          .prepare('SELECT * FROM kb_feedback WHERE status = ? ORDER BY created_at DESC LIMIT ?')
          .all(options.status, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM kb_feedback ORDER BY created_at DESC LIMIT ?')
          .all(limit) as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      id: String(row.id),
      messageId: String(row.message_id),
      rating: String(row.rating) as FeedbackRating,
      reason: row.reason === null ? null : String(row.reason),
      comment: row.comment === null ? null : String(row.comment),
      status: String(row.status) as FeedbackStatus,
      createdAt: String(row.created_at),
    }));
  }

  /** 反馈统计：用于管理台展示与回归验证。 */
  feedbackStats(kbId?: string): { up: number; down: number; open: number; handled: number } {
    const scope = kbId
      ? `JOIN kb_message m ON m.id = f.message_id
         JOIN kb_conversation c ON c.id = m.conversation_id
         WHERE c.kb_id = ?`
      : '';
    const params = kbId ? [kbId] : [];
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN f.rating = 'up' THEN 1 ELSE 0 END) AS up,
           SUM(CASE WHEN f.rating = 'down' THEN 1 ELSE 0 END) AS down,
           SUM(CASE WHEN f.status = 'open' THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN f.status = 'handled' THEN 1 ELSE 0 END) AS handled
         FROM kb_feedback f ${scope}`,
      )
      .get(...params) as Record<string, unknown> | undefined;

    return {
      up: Number(row?.up ?? 0),
      down: Number(row?.down ?? 0),
      open: Number(row?.open ?? 0),
      handled: Number(row?.handled ?? 0),
    };
  }

  updateFeedbackStatus(id: string, status: FeedbackStatus): boolean {
    return this.db.prepare('UPDATE kb_feedback SET status = ? WHERE id = ?').run(status, id).changes > 0;
  }

  createUnresolvedIssue(input: {
    kbId: string;
    query: string;
    reason: UnresolvedReason;
    evidence: Record<string, unknown>;
  }): UnresolvedIssue {
    const id = `iss_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO kb_unresolved_issue
         (id, kb_id, query, reason, evidence, status, resolved_by_qa_pair_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, ?)`,
      )
      .run(id, input.kbId, input.query, input.reason, JSON.stringify(input.evidence), ts, ts);
    return {
      id,
      kbId: input.kbId,
      query: input.query,
      reason: input.reason,
      evidence: input.evidence,
      status: 'open',
      resolvedByQaPairId: null,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  /**
   * 写入「用户点踩」产生的待办，按 messageId 去重。
   *
   * 同一条回答被反复点踩时更新已有条目而不是新增，避免 backlog 被同一个问题刷屏。
   * 若该条此前已处理（handled/dismissed），重新点踩会置回 open —— 说明问题仍在。
   */
  upsertDownvoteIssue(input: {
    kbId: string;
    query: string;
    evidence: Record<string, unknown>;
  }): UnresolvedIssue {
    const messageId = String(input.evidence.messageId ?? '');
    const existing = messageId
      ? (this.db
          .prepare(
            `SELECT * FROM kb_unresolved_issue
             WHERE kb_id = ? AND reason = 'user_downvote'
               AND json_extract(evidence, '$.messageId') = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(input.kbId, messageId) as Record<string, unknown> | undefined)
      : undefined;

    if (existing) {
      const ts = nowIso();
      this.db
        .prepare(
          `UPDATE kb_unresolved_issue
           SET query = ?, evidence = ?, status = 'open', updated_at = ?
           WHERE id = ?`,
        )
        .run(input.query, JSON.stringify(input.evidence), ts, String(existing.id));

      return {
        ...mapUnresolvedIssue(existing),
        query: input.query,
        evidence: input.evidence,
        status: 'open',
        updatedAt: ts,
      };
    }

    return this.createUnresolvedIssue({
      kbId: input.kbId,
      query: input.query,
      reason: 'user_downvote',
      evidence: input.evidence,
    });
  }

  listUnresolvedIssues(
    kbId: string,
    options: { status?: UnresolvedStatus; limit?: number } = {},
  ): UnresolvedIssue[] {
    const limit = options.limit ?? 100;
    const rows = options.status
      ? (this.db
          .prepare(
            'SELECT * FROM kb_unresolved_issue WHERE kb_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(kbId, options.status, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM kb_unresolved_issue WHERE kb_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(kbId, limit) as Array<Record<string, unknown>>);
    return rows.map(mapUnresolvedIssue);
  }

  findUnresolvedIssue(id: string): UnresolvedIssue | null {
    const row = this.db.prepare('SELECT * FROM kb_unresolved_issue WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapUnresolvedIssue(row) : null;
  }

  /** 反馈闭环：补录问答对后，把相关问题标记为已处理。 */
  resolveUnresolvedIssues(ids: string[], qaPairId: string): number {
    if (ids.length === 0) return 0;
    const stmt = this.db.prepare(
      `UPDATE kb_unresolved_issue SET status = 'handled', resolved_by_qa_pair_id = ?, updated_at = ?
       WHERE id = ?`,
    );
    const ts = nowIso();
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const id of ids) changed += stmt.run(qaPairId, ts, id).changes;
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return changed;
  }

  updateUnresolvedStatus(id: string, status: UnresolvedStatus): boolean {
    return (
      this.db
        .prepare('UPDATE kb_unresolved_issue SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, nowIso(), id).changes > 0
    );
  }

  /**
   * 批量更新待办状态。
   *
   * 支持按 id 列表或按「原因 + 时间段」批量处理 —— 后者用于清理
   * 测试阶段产生的 historial 残留（例如某次 bug 期间集中出现的 low_evidence）。
   */
  bulkUpdateIssues(filter: {
    kbId: string;
    ids?: string[];
    reason?: UnresolvedReason;
    before?: string;
    status: UnresolvedStatus;
  }): number {
    const clauses = ['kb_id = ?'];
    const params: unknown[] = [filter.kbId];

    if (filter.ids && filter.ids.length > 0) {
      clauses.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }
    if (filter.reason) {
      clauses.push('reason = ?');
      params.push(filter.reason);
    }
    if (filter.before) {
      clauses.push('created_at < ?');
      params.push(filter.before);
    }

    const result = this.db
      .prepare(
        `UPDATE kb_unresolved_issue SET status = ?, updated_at = ?
         WHERE ${clauses.join(' AND ')}`,
      )
      .run(filter.status, nowIso(), ...params);

    return result.changes;
  }

  /** 按原因统计待办数量，用于清理前的确认。 */
  countIssuesByReason(kbId: string, status: UnresolvedStatus = 'open'): Array<{ reason: string; count: number }> {
    const rows = this.db
      .prepare(
        `SELECT reason, COUNT(*) AS n FROM kb_unresolved_issue
         WHERE kb_id = ? AND status = ? GROUP BY reason ORDER BY n DESC`,
      )
      .all(kbId, status) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ reason: String(row.reason), count: Number(row.n) }));
  }

  /** 暴露底层 db 供 FTS 等特化查询使用。 */
  raw(): SqliteDatabase {
    return this.db;
  }
}

// ---------------------------------------------------------------------------
// 行 → 领域类型
// ---------------------------------------------------------------------------

function mapKnowledgeBase(row: Record<string, unknown>): KnowledgeBase {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description === null ? null : String(row.description),
    chunkConfigVersion: String(row.chunk_config_version),
    embeddingModel: row.embedding_model === null ? null : String(row.embedding_model),
    embeddingDim: row.embedding_dim === null ? null : Number(row.embedding_dim),
    publicKey: row.public_key === null ? null : String(row.public_key),
    allowedOrigins: parseJson<string[]>(row.allowed_origins, []),
    widgetConfig: { ...DEFAULT_WIDGET_CONFIG, ...parseJson<Partial<WidgetConfig>>(row.widget_config, {}) },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapDocument(row: Record<string, unknown>): SourceDocument {
  return {
    id: String(row.id),
    kbId: String(row.kb_id),
    title: String(row.title),
    sourcePath: row.source_path === null ? null : String(row.source_path),
    sourceUrl: row.source_url === null ? null : String(row.source_url),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    mtime: String(row.mtime),
    parseStatus: String(row.parse_status) as ParseStatus,
    parseError: row.parse_error === null ? null : String(row.parse_error),
    parseWarnings: parseJson<string[]>(row.parse_warnings, []),
    parseVersion: String(row.parse_version),
    chunkConfigVersion: String(row.chunk_config_version),
    chunkCount: Number(row.chunk_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapChunk(row: Record<string, unknown>): Chunk {
  return {
    id: String(row.id),
    kbId: String(row.kb_id),
    documentId: String(row.document_id),
    ordinal: Number(row.ordinal),
    content: String(row.content),
    contentHash: String(row.content_hash),
    tokenCount: Number(row.token_count),
    locator: parseJson<Locator>(row.locator, {}),
    headingPath: row.heading_path === null ? null : parseJson<string[] | null>(row.heading_path, null),
    embeddingModel: row.embedding_model === null ? null : String(row.embedding_model),
    embeddingDim: row.embedding_dim === null ? null : Number(row.embedding_dim),
    createdAt: String(row.created_at),
  };
}

function mapQaPair(row: Record<string, unknown>): QaPair {
  return {
    id: String(row.id),
    kbId: String(row.kb_id),
    question: String(row.question),
    answer: String(row.answer),
    contentHash: String(row.content_hash),
    tags: parseJson<string[]>(row.tags, []),
    embeddingModel: row.embedding_model === null ? null : String(row.embedding_model),
    embeddingDim: row.embedding_dim === null ? null : Number(row.embedding_dim),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: String(row.role) as MessageRole,
    content: String(row.content),
    citations: parseJson<Citation[]>(row.citations, []),
    gateDecision: row.gate_decision === null ? null : (String(row.gate_decision) as Message['gateDecision']),
    modelId: row.model_id === null ? null : String(row.model_id),
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    createdAt: String(row.created_at),
  };
}

function mapUnresolvedIssue(row: Record<string, unknown>): UnresolvedIssue {
  return {
    id: String(row.id),
    kbId: String(row.kb_id),
    query: String(row.query),
    reason: String(row.reason) as UnresolvedReason,
    evidence: parseJson<Record<string, unknown>>(row.evidence, {}),
    status: String(row.status) as UnresolvedStatus,
    resolvedByQaPairId: row.resolved_by_qa_pair_id === null ? null : String(row.resolved_by_qa_pair_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export type { SqliteStatement };

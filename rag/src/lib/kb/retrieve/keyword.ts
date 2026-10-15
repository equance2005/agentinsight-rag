/**
 * 关键词召回：SQLite FTS5 + 中文 bigram 展开。
 *
 * 索引侧写入 expandForIndex() 的结果，查询侧用 buildMatchExpression() 构造
 * OR 查询；两边共用同一套切分规则，保证中文子串可命中。
 */

import type { SqliteDatabase } from '../store/sqlite-driver.js';
import { buildMatchExpression, expandForIndex } from './tokenizer.js';

export interface KeywordHit {
  id: string;
  kind: 'chunk' | 'qa';
  score: number;
  /** 命中的查询词元数，用于排序 tie-break。 */
  matchedTerms: number;
}

export interface KeywordSearchOptions {
  kbId: string;
  query: string;
  topK: number;
  documentIds?: string[];
}

export class KeywordRetriever {
  constructor(private readonly db: SqliteDatabase) {}

  search(options: KeywordSearchOptions): KeywordHit[] {
    const match = buildMatchExpression(options.query);
    if (!match) return [];
    // 显式传入空文档集合表示「不允许命中任何文档」。问答对没有
    // document_id，也不能绕过这个过滤条件。
    if (options.documentIds && options.documentIds.length === 0) return [];

    // 命中词元数：FTS5 不直接给，用「命中的不同词元」近似 —— 这里以
    // 各词元的召回集合大小作为区分度信号，由 SQL 的 bm25 承担主要排序。
    const chunkHits = this.query(
      `SELECT c.id AS id, bm25(kb_chunk_fts) AS rank
       FROM kb_chunk_fts f
       JOIN kb_chunk c ON c.rowid = f.rowid
       WHERE kb_chunk_fts MATCH ? AND c.kb_id = ?
       ORDER BY rank
       LIMIT ?`,
      match,
      options,
      'chunk',
    );

    const qaHits = this.query(
      `SELECT q.id AS id, bm25(kb_qa_fts) AS rank
       FROM kb_qa_fts f
       JOIN kb_qa_pair q ON q.rowid = f.rowid
       WHERE kb_qa_fts MATCH ? AND q.kb_id = ?
       ORDER BY rank
       LIMIT ?`,
      match,
      options,
      'qa',
    );

    // 两路合并：bm25 为负值且越小越相关，转成「越大越好」的分数
    const merged = new Map<string, KeywordHit>();
    for (const hit of [...chunkHits, ...qaHits]) {
      if (!merged.has(hit.id)) merged.set(hit.id, hit);
    }

    return [...merged.values()]
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, options.topK);
  }

  private query(
    sql: string,
    match: string,
    options: KeywordSearchOptions,
    kind: 'chunk' | 'qa',
  ): KeywordHit[] {
    // 关键词通道也必须遵守 documentIds；此前只有向量通道过滤，导致
    // 指定文档范围时仍可能把范围外的关键词命中带进融合结果。
    if (options.documentIds && kind === 'qa') return [];

    const documentFilter =
      kind === 'chunk' && options.documentIds
        ? ` AND c.document_id IN (${options.documentIds.map(() => '?').join(',')})`
        : '';
    const scopedSql = sql.replace(' AND c.kb_id = ?', ` AND c.kb_id = ?${documentFilter}`);
    const params: unknown[] = [match, options.kbId, ...(options.documentIds ?? []), options.topK * 2];
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = this.db.prepare(scopedSql).all(...params) as Array<Record<string, unknown>>;
    } catch {
      // FTS 语法异常不应中断请求；退化为无结果
      return [];
    }

    return rows.map((row) => {
      const bm25 = Number(row.rank ?? 0);
      return {
        id: String(row.id),
        kind,
        // bm25 越负越相关：-bm25 后越大越好；加常数避免全负
        score: -bm25,
        matchedTerms: 1,
      };
    });
  }
}

/**
 * 维护 FTS 索引。chunk / 问答对写入后由仓储层调用。
 *
 * 不使用触发器：索引文本是原文的展开形式（含 bigram），
 * 无法用 SQL 表达式表达，必须在应用层计算。
 */
export function indexChunk(
  db: SqliteDatabase,
  chunkId: string,
  content: string,
  headingPath: string | null,
): void {
  const rowid = rowIdOf(db, 'kb_chunk', chunkId);
  if (rowid === null) return;
  db.prepare('INSERT INTO kb_chunk_fts(rowid, content, heading) VALUES (?, ?, ?)').run(
    rowid,
    expandForIndex(content),
    headingPath ? expandForIndex(headingPath.replace(/[\[\]",]/g, ' ')) : '',
  );
}

export function indexQaPair(db: SqliteDatabase, qaId: string, question: string, answer: string): void {
  const rowid = rowIdOf(db, 'kb_qa_pair', qaId);
  if (rowid === null) return;
  db.prepare('INSERT INTO kb_qa_fts(rowid, question, answer) VALUES (?, ?, ?)').run(
    rowid,
    expandForIndex(question),
    expandForIndex(answer),
  );
}

export function unindexChunk(db: SqliteDatabase, chunkId: string): void {
  // 用 external content 的 delete 命令需要原文本；这里改用 rowid 直接删。
  // kb_chunk_fts 非 external content 表，可直接 DELETE。
  const rowid = rowIdOf(db, 'kb_chunk', chunkId);
  if (rowid !== null) db.prepare('DELETE FROM kb_chunk_fts WHERE rowid = ?').run(rowid);
  void chunkId;
}

export function unindexQaPair(db: SqliteDatabase, qaId: string): void {
  const rowid = rowIdOf(db, 'kb_qa_pair', qaId);
  if (rowid !== null) db.prepare('DELETE FROM kb_qa_fts WHERE rowid = ?').run(rowid);
}

function rowIdOf(db: SqliteDatabase, table: 'kb_chunk' | 'kb_qa_pair', id: string): number | null {
  const row = db.prepare(`SELECT rowid FROM ${table} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? Number(row.rowid) : null;
}

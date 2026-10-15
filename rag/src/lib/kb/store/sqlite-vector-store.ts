/**
 * SQLite 向量存储：Float32 BLOB + 内存缓存 + 暴力余弦。
 *
 * 适用规模：万级 chunk（见 recommendedMaxVectors）。
 * 超出后应切换到 pgvector 或独立向量库实现 —— 接口完全一致。
 *
 * 缓存策略：按 kbId 懒加载全部向量到内存（Float32Array 连续存储 + id 索引），
 * 写入时同步失效。暴力余弦在 10k×768 维下约 5–10ms，满足交互式问答。
 */

import type { SqliteDatabase } from './sqlite-driver.js';
import type { VectorHit, VectorItem, VectorSearchQuery, VectorStore } from '../ports.js';

interface CacheEntry {
  /** 连续存储的向量，第 i 条占用 [i*dim, (i+1)*dim)。 */
  data: Float32Array;
  dim: number;
  ids: string[];
  kinds: Array<'chunk' | 'qa'>;
  documentIds: Array<string | null>;
  /** 向量范数在缓存加载时计算，避免每次查询重复计算。 */
  norms: Float64Array;
  /** 按 model+dim 分组，避免不同模型的向量互相比较。 */
  byModel: Map<string, number[]>;
}

export class SqliteVectorStore implements VectorStore {
  readonly name = 'sqlite-brute-force';
  readonly recommendedMaxVectors = 50_000;

  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly db: SqliteDatabase) {}

  async upsert(items: VectorItem[]): Promise<void> {
    if (items.length === 0) return;

    const stmt = this.db.prepare(
      `INSERT INTO kb_vector(id, kb_id, document_id, kind, model, dim, vec)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kb_id = excluded.kb_id,
         document_id = excluded.document_id,
         kind = excluded.kind,
         model = excluded.model,
         dim = excluded.dim,
         vec = excluded.vec`,
    );

    this.db.exec('BEGIN');
    try {
      for (const item of items) {
        stmt.run(
          item.id,
          item.kbId,
          item.documentId,
          item.meta.kind,
          item.meta.model,
          item.meta.dim,
          Buffer.from(item.vector.buffer, item.vector.byteOffset, item.vector.byteLength),
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    for (const kbId of new Set(items.map((item) => item.kbId))) {
      this.cache.delete(kbId);
    }
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const stmt = this.db.prepare('DELETE FROM kb_vector WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const id of ids) stmt.run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.cache.clear();
  }

  async deleteByDocument(documentId: string): Promise<void> {
    this.db.prepare('DELETE FROM kb_vector WHERE document_id = ?').run(documentId);
    this.cache.clear();
  }

  async deleteByKb(kbId: string): Promise<void> {
    this.db.prepare('DELETE FROM kb_vector WHERE kb_id = ?').run(kbId);
    this.cache.delete(kbId);
  }

  async count(kbId: string): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM kb_vector WHERE kb_id = ?')
      .get(kbId);
    return row ? Number(row.n) : 0;
  }

  async search(query: VectorSearchQuery): Promise<VectorHit[]> {
    const entry = this.loadCache(query.kbId, query.vector.length);
    if (!entry || entry.ids.length === 0) return [];

    const allowed = query.documentIds ? new Set(query.documentIds) : null;
    const minScore = query.minScore ?? 0;
    const q = query.vector;
    const dim = entry.dim;

    // 指定模型时严格匹配：相同维度不代表不同模型共享语义空间。
    const indexed = query.model === undefined ? null : entry.byModel.get(query.model);
    if (query.model !== undefined && (!indexed || indexed.length === 0)) return [];
    let queryNormSquared = 0;
    for (const value of q) queryNormSquared += value * value;
    const queryNorm = Math.sqrt(queryNormSquared);

    const hits: VectorHit[] = [];
    const total = entry.ids.length;
    for (let position = 0; position < (indexed ? indexed.length : total); position++) {
      const i = indexed ? indexed[position] : position;
      if (allowed) {
        const docId = entry.documentIds[i];
        if (!docId || !allowed.has(docId)) continue;
      }
      const offset = i * dim;
      let dot = 0;
      for (let d = 0; d < dim; d++) {
        const a = entry.data[offset + d];
        const b = q[d];
        dot += a * b;
      }
      const denom = entry.norms[i] * queryNorm;
      const score = denom === 0 ? 0 : dot / denom;
      if (score >= minScore) {
        hits.push({ id: entry.ids[i], score, kind: entry.kinds[i] });
      }
    }

    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return hits.slice(0, query.topK);
  }

  /** 使某个知识库的缓存失效（例如直接改库后）。 */
  invalidate(kbId?: string): void {
    if (kbId) this.cache.delete(kbId);
    else this.cache.clear();
  }

  private loadCache(kbId: string, dim: number): CacheEntry | null {
    const cached = this.cache.get(kbId);
    if (cached && cached.dim === dim) return cached;

    const rows = this.db
      .prepare(
        'SELECT id, document_id, kind, model, dim, vec FROM kb_vector WHERE kb_id = ? AND dim = ? ORDER BY id',
      )
      .all(kbId, dim) as Array<Record<string, unknown>>;

    if (rows.length === 0) {
      const empty: CacheEntry = {
        data: new Float32Array(0),
        dim,
        ids: [],
        kinds: [],
        documentIds: [],
        norms: new Float64Array(0),
        byModel: new Map(),
      };
      this.cache.set(kbId, empty);
      return empty;
    }

    const data = new Float32Array(rows.length * dim);
    const ids: string[] = [];
    const kinds: Array<'chunk' | 'qa'> = [];
    const documentIds: Array<string | null> = [];
    const norms = new Float64Array(rows.length);
    const byModel = new Map<string, number[]>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      ids.push(String(row.id));
      kinds.push(row.kind === 'qa' ? 'qa' : 'chunk');
      documentIds.push(row.document_id ? String(row.document_id) : null);

      const buf = Buffer.from(row.vec as Uint8Array);
      const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      data.set(vec.subarray(0, dim), i * dim);
      let normSquared = 0;
      for (let d = 0; d < dim; d++) {
        const value = data[i * dim + d];
        normSquared += value * value;
      }
      norms[i] = Math.sqrt(normSquared);

      const model = String(row.model ?? '');
      const bucket = byModel.get(model);
      if (bucket) bucket.push(i);
      else byModel.set(model, [i]);
    }

    const entry: CacheEntry = { data, dim, ids, kinds, documentIds, norms, byModel };
    this.cache.set(kbId, entry);
    return entry;
  }
}

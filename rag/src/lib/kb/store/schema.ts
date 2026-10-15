/**
 * 数据库 schema 与迁移。
 *
 * 使用纯 SQL 定义，不依赖 ORM，便于在 SQLite / Postgres 之间保持语义一致。
 * 向量列在 SQLite 下为 BLOB（Float32 小端），Postgres 部署时由 pgvector 实现替换。
 */

import type { SqliteDatabase } from './sqlite-driver.js';
import { expandForIndex } from '../retrieve/tokenizer.js';

export const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS kb_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_knowledge_base (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  description         TEXT,
  chunk_config_version TEXT NOT NULL,
  embedding_model     TEXT,
  embedding_dim       INTEGER,
  public_key          TEXT UNIQUE,
  allowed_origins     TEXT NOT NULL DEFAULT '[]',
  widget_config       TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_document (
  id                  TEXT PRIMARY KEY,
  kb_id               TEXT NOT NULL REFERENCES kb_knowledge_base(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  source_path         TEXT,
  source_url          TEXT,
  mime_type           TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL DEFAULT 0,
  sha256              TEXT NOT NULL,
  mtime               TEXT NOT NULL,
  parse_status        TEXT NOT NULL DEFAULT 'pending',
  parse_error         TEXT,
  parse_warnings      TEXT NOT NULL DEFAULT '[]',
  parse_version       TEXT NOT NULL,
  chunk_config_version TEXT NOT NULL,
  chunk_count         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_document_source
  ON kb_document(kb_id, source_path);
CREATE INDEX IF NOT EXISTS idx_kb_document_kb ON kb_document(kb_id);

CREATE TABLE IF NOT EXISTS kb_chunk (
  id              TEXT PRIMARY KEY,
  kb_id           TEXT NOT NULL REFERENCES kb_knowledge_base(id) ON DELETE CASCADE,
  document_id     TEXT NOT NULL REFERENCES kb_document(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  token_count     INTEGER NOT NULL DEFAULT 0,
  locator         TEXT NOT NULL DEFAULT '{}',
  heading_path    TEXT,
  embedding_model TEXT,
  embedding_dim   INTEGER,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_doc ON kb_chunk(document_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_kb_hash ON kb_chunk(kb_id, content_hash);

CREATE TABLE IF NOT EXISTS kb_qa_pair (
  id              TEXT PRIMARY KEY,
  kb_id           TEXT NOT NULL REFERENCES kb_knowledge_base(id) ON DELETE CASCADE,
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]',
  embedding_model TEXT,
  embedding_dim   INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_qa_kb ON kb_qa_pair(kb_id);

CREATE TABLE IF NOT EXISTS kb_ingest_job (
  id          TEXT PRIMARY KEY,
  kb_id       TEXT NOT NULL REFERENCES kb_knowledge_base(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL,
  status      TEXT NOT NULL,
  stats       TEXT,
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_kb_job_kb ON kb_ingest_job(kb_id, started_at DESC);

-- 关键词召回：FTS5。
--
-- 关键点：unicode61 分词器把一整串中文当成单个词元（实测「数据库默认端口是」= 1 token），
-- 因此中文子串查询完全无法命中。解决办法是在写入时把中文切成 bigram 并
-- 拼进被索引的文本，查询侧做同样的切分（见 retrieve/keyword.ts）。
-- 英文仍按词切分，不受影响。
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunk_fts USING fts5(
  content,
  heading,
  tokenize='unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_qa_fts USING fts5(
  question,
  answer,
  tokenize='unicode61'
);

-- 向量表：Float32 BLOB + 元数据，供 SQLite 暴力余弦实现使用
CREATE TABLE IF NOT EXISTS kb_vector (
  id          TEXT PRIMARY KEY,
  kb_id       TEXT NOT NULL,
  document_id TEXT,
  kind        TEXT NOT NULL,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vec         BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_vector_kb ON kb_vector(kb_id);
CREATE INDEX IF NOT EXISTS idx_kb_vector_doc ON kb_vector(document_id);

CREATE TABLE IF NOT EXISTS kb_conversation (
  id         TEXT PRIMARY KEY,
  kb_id      TEXT NOT NULL REFERENCES kb_knowledge_base(id) ON DELETE CASCADE,
  site_key   TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_message (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES kb_conversation(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  citations       TEXT NOT NULL DEFAULT '[]',
  gate_decision   TEXT,
  retrieval       TEXT,
  claim_checks    TEXT,
  model_id        TEXT,
  latency_ms      INTEGER,
  token_usage     TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_message_conv ON kb_message(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS kb_feedback (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES kb_message(id) ON DELETE CASCADE,
  rating     TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  reason     TEXT,
  comment    TEXT,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 唯一索引不在这里建：老库里可能已有重复记录，必须先经 applyAlterations
-- 去重后才能成功创建。见 migrateFeedback()。
CREATE INDEX IF NOT EXISTS idx_kb_feedback_status ON kb_feedback(status, created_at DESC);

CREATE TABLE IF NOT EXISTS kb_unresolved_issue (
  id                 TEXT PRIMARY KEY,
  kb_id              TEXT NOT NULL REFERENCES kb_knowledge_base(id) ON DELETE CASCADE,
  query              TEXT NOT NULL,
  reason             TEXT NOT NULL,
  evidence           TEXT NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'open',
  resolved_by_qa_pair_id TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_unresolved ON kb_unresolved_issue(kb_id, status, created_at DESC);
`;

export function migrate(db: SqliteDatabase): void {
  db.exec(SCHEMA_SQL);
  const previousVersion = readSchemaVersion(db);
  applyAlterations(db);
  if (previousVersion < 2) rebuildFtsIndexes(db);
  db.prepare(
    `INSERT INTO kb_meta(key, value) VALUES('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
}

/** FTS 索引内容依赖应用层的 token 展开规则，规则升级时必须重建旧索引。 */
function rebuildFtsIndexes(db: SqliteDatabase): void {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM kb_chunk_fts; DELETE FROM kb_qa_fts;');

    const chunks = db.prepare('SELECT rowid, content, heading_path FROM kb_chunk').all() as Array<Record<string, unknown>>;
    const chunkStmt = db.prepare('INSERT INTO kb_chunk_fts(rowid, content, heading) VALUES (?, ?, ?)');
    for (const row of chunks) {
      const heading = row.heading_path === null || row.heading_path === undefined
        ? ''
        : String(row.heading_path).replace(/[\[\]",]/g, ' ');
      chunkStmt.run(Number(row.rowid), expandForIndex(String(row.content ?? '')), expandForIndex(heading));
    }

    const qaPairs = db.prepare('SELECT rowid, question, answer FROM kb_qa_pair').all() as Array<Record<string, unknown>>;
    const qaStmt = db.prepare('INSERT INTO kb_qa_fts(rowid, question, answer) VALUES (?, ?, ?)');
    for (const row of qaPairs) {
      qaStmt.run(Number(row.rowid), expandForIndex(String(row.question ?? '')), expandForIndex(String(row.answer ?? '')));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 增量列迁移。
 *
 * SQLite 的 CREATE TABLE IF NOT EXISTS 不会给已存在的表补列或加索引，
 * 因此新增字段/约束必须在这里显式处理，否则老库升级后会报错或缺少约束。
 */
function applyAlterations(db: SqliteDatabase): void {
  const columns = (db.prepare('PRAGMA table_info(kb_document)').all() as Array<Record<string, unknown>>).map(
    (row) => String(row.name),
  );

  if (!columns.includes('parse_warnings')) {
    db.exec(`ALTER TABLE kb_document ADD COLUMN parse_warnings TEXT NOT NULL DEFAULT '[]'`);
  }

  migrateFeedback(db);
}

/**
 * 反馈表迁移：补 updated_at、去重、建唯一索引。
 *
 * 建唯一索引前必须先清理历史重复：老版本允许对同一条回答先点赞再点踩，
 * 直接建索引会失败。保留策略是**保留最新一条**，因为用户的最终态度
 * 比中间过程更有意义；被覆盖的 down 记录对应的待办会保留在 backlog 里，
 * 不会因为去重而丢失问题线索。
 */
function migrateFeedback(db: SqliteDatabase): void {
  const feedbackColumns = (
    db.prepare('PRAGMA table_info(kb_feedback)').all() as Array<Record<string, unknown>>
  ).map((row) => String(row.name));

  if (feedbackColumns.length === 0) return; // 全新库由 SCHEMA_SQL 建好

  if (!feedbackColumns.includes('updated_at')) {
    db.exec(`ALTER TABLE kb_feedback ADD COLUMN updated_at TEXT`);
    // 老记录没有更新时间，用创建时间兜底
    db.exec(`UPDATE kb_feedback SET updated_at = created_at WHERE updated_at IS NULL`);
  }

  const duplicates = db
    .prepare(
      `SELECT message_id, COUNT(*) AS n FROM kb_feedback
       GROUP BY message_id HAVING n > 1`,
    )
    .all() as Array<Record<string, unknown>>;

  if (duplicates.length > 0) {
    const keepLatest = db.prepare(
      `SELECT id FROM kb_feedback WHERE message_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    );
    const removeOthers = db.prepare(
      `DELETE FROM kb_feedback WHERE message_id = ? AND id != ?`,
    );

    db.exec('BEGIN');
    try {
      for (const row of duplicates) {
        const messageId = String(row.message_id);
        const keep = keepLatest.get(messageId) as Record<string, unknown> | undefined;
        if (keep) removeOthers.run(messageId, String(keep.id));
      }
      db.exec('COMMIT');
      console.log(
        `[kb] 反馈表去重：合并了 ${duplicates.length} 条重复记录（保留每条回答的最新反馈）`,
      );
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_feedback_message ON kb_feedback(message_id)`);
}

export function readSchemaVersion(db: SqliteDatabase): number {
  const row = db.prepare(`SELECT value FROM kb_meta WHERE key = 'schema_version'`).get();
  return row ? Number(row.value) : 0;
}

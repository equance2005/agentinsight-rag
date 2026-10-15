/**
 * SQLite 驱动的可插拔适配层。
 *
 * 默认使用 Node 22+ 内置的 `node:sqlite`（零原生依赖，无需编译或下载预编译包）。
 * 若安装了 better-sqlite3，可通过环境变量 KB_SQLITE_DRIVER=better-sqlite3 切换。
 * 两者暴露同一组最小接口，仓储层与向量存储只依赖 `SqliteDatabase`。
 */

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  readonly driver: string;
}

type DriverFactory = (path: string) => SqliteDatabase;

function openNodeSqlite(path: string): SqliteDatabase {
  // 动态 require：node:sqlite 在 Node 22 之前不存在，不能在模块顶层静态导入。
  const req = createRequire(import.meta.url);
  const mod = req('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint };
        get(...p: unknown[]): Record<string, unknown> | undefined;
        all(...p: unknown[]): Record<string, unknown>[];
      };
      close(): void;
    };
  };
  const db = new mod.DatabaseSync(path);
  return {
    driver: 'node:sqlite',
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    close: () => db.close(),
  };
}

function openBetterSqlite(path: string): SqliteDatabase {
  const req = createRequire(import.meta.url);
  const Better = req('better-sqlite3') as new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint };
      get(...p: unknown[]): Record<string, unknown> | undefined;
      all(...p: unknown[]): Record<string, unknown>[];
    };
    close(): void;
  };
  const db = new Better(path);
  return {
    driver: 'better-sqlite3',
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    close: () => db.close(),
  };
}

const FACTORIES: Record<string, DriverFactory> = {
  'node:sqlite': openNodeSqlite,
  'better-sqlite3': openBetterSqlite,
};

export function openDatabase(path: string, driver?: string): SqliteDatabase {
  const requested = driver ?? process.env.KB_SQLITE_DRIVER;
  const candidates = requested
    ? [requested]
    : hasNodeSqlite()
      ? ['node:sqlite', 'better-sqlite3']
      : ['better-sqlite3', 'node:sqlite'];

  const failures: string[] = [];
  for (const name of candidates) {
    const factory = FACTORIES[name];
    if (!factory) {
      failures.push(`${name}: 未知驱动`);
      continue;
    }
    try {
      return factory(path);
    } catch (error) {
      failures.push(`${name}: ${(error as Error).message}`);
    }
  }
  throw new Error(
    `无法打开 SQLite 数据库（尝试了 ${candidates.join(', ')}）：\n  ${failures.join('\n  ')}\n` +
      `请升级到 Node 22+（内置 node:sqlite），或安装 better-sqlite3。`,
  );
}

let nodeSqliteAvailable: boolean | null = null;

export function hasNodeSqlite(): boolean {
  if (nodeSqliteAvailable !== null) return nodeSqliteAvailable;
  try {
    const req = createRequire(import.meta.url);
    req('node:sqlite');
    nodeSqliteAvailable = true;
  } catch {
    nodeSqliteAvailable = false;
  }
  return nodeSqliteAvailable;
}

import { createRequire } from 'node:module';

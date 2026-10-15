/**
 * .env 文件加载。
 *
 * 用 Node 内置的 process.loadEnvFile（Node 20.12+），不引入 dotenv 依赖。
 * 加载顺序：先 .env.local 后 .env —— 前者优先，符合「本地覆盖」的直觉，
 * 且已存在的真实环境变量始终优先于文件值，方便临时用命令行覆盖。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface EnvLoadResult {
  loaded: string[];
  skipped: string[];
}

export function loadEnvFiles(cwd = process.cwd()): EnvLoadResult {
  const candidates = ['.env.local', '.env'];
  const loaded: string[] = [];
  const skipped: string[] = [];

  // process.loadEnvFile 在 Node 20.12+ 才存在；缺失时静默跳过，不影响运行
  const load = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (typeof load !== 'function') {
    return { loaded, skipped: candidates.map((name) => `${name}（当前 Node 不支持自动加载）`) };
  }

  for (const name of candidates) {
    const filePath = join(cwd, name);
    if (!existsSync(filePath)) {
      skipped.push(name);
      continue;
    }
    try {
      // loadEnvFile 不会覆盖已存在的变量，因此命令行传入的值始终优先
      load.call(process, filePath);
      loaded.push(name);
    } catch (error) {
      skipped.push(`${name}（${(error as Error).message}）`);
    }
  }

  return { loaded, skipped };
}

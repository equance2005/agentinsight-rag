/**
 * ESM 解析钩子。
 *
 * - `node:test` → 进程内极简测试框架（避开 node:test 的 spawn）
 * - `./x.js` → 同目录 `./x.ts`（Node 原生类型剥离不重写说明符）
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const FRAMEWORK_URL = pathToFileURL(join(process.cwd(), 'scripts', 'test-framework.ts')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:test') {
    return { url: FRAMEWORK_URL, shortCircuit: true };
  }

  if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : join(process.cwd(), 'index.js');
    const resolvedPath = join(dirname(parentPath), specifier);

    if (!existsSync(resolvedPath)) {
      const tsPath = resolvedPath.replace(/\.js$/, '.ts');
      if (existsSync(tsPath)) {
        return nextResolve(pathToFileURL(tsPath).href, context);
      }
    }
  }

  return nextResolve(specifier, context);
}

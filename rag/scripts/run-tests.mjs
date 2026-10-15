/**
 * 测试运行器。
 *
 * 不使用 `node --test`：它通过 spawn 子进程收集结果，在受限沙箱下会 EPERM。
 * 改为在单进程内跑完全部用例文件。
 *
 * 用法：node --experimental-transform-types --import ./scripts/register.mjs scripts/run-tests.mjs [文件名片段]
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const testDir = join(process.cwd(), 'test');
const pattern = process.argv[2];
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .filter((name) => (pattern ? name.includes(pattern) : true))
  .sort();

if (files.length === 0) {
  console.error(`未找到测试文件（pattern=${pattern ?? '全部'}）`);
  process.exit(1);
}

const loadFailures = [];

for (const file of files) {
  process.stdout.write(`\n=== ${file} ===\n`);
  try {
    await import(pathToFileURL(join(testDir, file)).href);
  } catch (error) {
    loadFailures.push({ file, error });
    process.stdout.write(`  ✖ 文件加载失败：${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof Error && error.stack) {
      process.stdout.write(`${error.stack.split('\n').slice(0, 8).join('\n')}\n`);
    }
  }
}

// 全部文件注册完毕后再统一执行
const { runRegisteredTests } = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'test-framework.ts')).href
);
const summary = await runRegisteredTests();

process.stdout.write(`\n${'='.repeat(64)}\n`);
process.stdout.write(`通过：${summary.passed}    失败：${summary.failed + loadFailures.length}\n`);

if (summary.failures.length > 0) {
  process.stdout.write('\n失败用例：\n');
  for (const item of summary.failures) {
    process.stdout.write(`\n  ✖ ${item.name}\n`);
    process.stdout.write(`${item.message.split('\n').slice(0, 10).map((line) => `    ${line}`).join('\n')}\n`);
  }
}
if (loadFailures.length > 0) {
  process.stdout.write('\n加载失败的文件：\n');
  for (const item of loadFailures) process.stdout.write(`  ✖ ${item.file}\n`);
}

process.exit(summary.failed + loadFailures.length > 0 ? 1 : 0);

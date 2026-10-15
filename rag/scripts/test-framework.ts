/**
 * 极简测试框架（进程内执行）。
 *
 * 为什么不用 node:test：它默认 spawn 子进程运行测试文件，
 * 在受限沙箱下会 EPERM。这里提供同样的 API 形状（test / describe），
 * 但完全在当前进程内执行，并通过 import 钩子把 `node:test` 重定向到这里。
 */

type TestFn = () => void | Promise<void>;

interface TestCase {
  name: string;
  fn: TestFn;
  skip: boolean;
}

const registry: TestCase[] = [];
let currentSuite = '';

interface Summary {
  passed: number;
  failed: number;
  failures: Array<{ name: string; message: string }>;
  finished: boolean;
}

const summary: Summary = { passed: 0, failed: 0, failures: [], finished: false };
(globalThis as Record<string, unknown>).__testSummary = summary;

export function test(name: string, fn: TestFn): void {
  registry.push({ name: currentSuite ? `${currentSuite} › ${name}` : name, fn, skip: false });
}

export function it(name: string, fn: TestFn): void {
  test(name, fn);
}

export function describe(name: string, fn: () => void): void {
  const previous = currentSuite;
  currentSuite = previous ? `${previous} › ${name}` : name;
  try {
    fn();
  } finally {
    currentSuite = previous;
  }
}

// 本项目暂不需要生命周期钩子，保留空实现以免 import 报错
export function before(): void {}
export function after(): void {}
export function beforeEach(): void {}
export function afterEach(): void {}

/**
 * 执行已注册的用例。
 *
 * 由 run-tests.mjs 在所有测试文件 import 完成后显式调用 ——
 * 不能在注册时自动调度，否则第一个文件的用例会在其余文件加载前就跑完。
 */
export async function runRegisteredTests(): Promise<Summary> {
  if (summary.finished) return summary;
  summary.finished = true;

  for (const testCase of registry) {
    if (testCase.skip) continue;
    try {
      await testCase.fn();
      summary.passed++;
      process.stdout.write(`  ✔ ${testCase.name}\n`);
    } catch (error) {
      summary.failed++;
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      summary.failures.push({ name: testCase.name, message });
      process.stdout.write(`  ✖ ${testCase.name}\n    ${message.split('\n')[0]}\n`);
    }
  }

  return summary;
}

export function registeredCount(): number {
  return registry.length;
}

/**
 * 插件打包：把 src/widget/index.ts 打成单文件 IIFE，输出到 public/kb-widget.js。
 *
 * 用 Node 内置的类型剥离（node:module 的 stripTypeScriptTypes）而不是自写正则，
 * 保证类型语法处理由运行时负责，不会因语法变体出错。
 * 这样也无需引入 esbuild/rollup 这类需要 spawn 子进程的工具。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const root = process.cwd();
const sourcePath = join(root, 'src', 'widget', 'index.ts');

let source;
try {
  source = readFileSync(sourcePath, 'utf8');
} catch {
  console.error(`找不到插件源码：${sourcePath}`);
  process.exit(1);
}

let stripped;
try {
  // 用 transform 模式：插件里用了构造函数参数属性（private readonly config），
  // strip-only 模式不支持这类需要生成代码的语法。
  stripped = stripTypeScriptTypes(source, { mode: 'transform', sourceMap: false });
} catch (error) {
  console.error(`类型剥离失败：${error.message}`);
  process.exit(1);
}

// 剥离后剩下的 ESM 语法需要去掉：IIFE 内不能有 import/export
stripped = stripped
  .replace(/^import\s+[^;]*;\s*$/gm, '')
  .replace(/^export\s+(function|class|const|let|var)\b/gm, '$1')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
  .replace(/^export\s+type\s+[^;]*;\s*$/gm, '');

const banner = `/*!
 * 知识库助手网页插件
 * 由 scripts/build-widget.mjs 从 src/widget/index.ts 生成，请勿直接修改本文件。
 */`;

const output = `${banner}
(function () {
  'use strict';
${indent(stripped, 2)}

  // 自动初始化：DOM 就绪后按 script 标签的 data-* 配置挂载
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit, { once: true });
  } else {
    autoInit();
  }
})();
`;

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line))
    .join('\n');
}

const outDir = join(root, 'public');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'kb-widget.js');
writeFileSync(outPath, output, 'utf8');

// 语法自检：解析失败则说明产物不可用，必须让构建失败
try {
  new Function(output);
} catch (error) {
  console.error(`产物语法检查失败：${error.message}`);
  rmSync(outPath, { force: true });
  process.exit(1);
}

console.log(`已生成 ${outPath}`);
console.log(`  源码：${sourcePath}`);
console.log(`  产物：${(output.length / 1024).toFixed(1)} KB`);

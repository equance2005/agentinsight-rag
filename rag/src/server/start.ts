/**
 * 服务端启动入口。
 *
 * 用法：kb serve [--port 8787] [--host 127.0.0.1]
 */

import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { KbServer } from './server.js';
import { loadEnvFiles } from '../lib/kb/env-file.js';

async function main(): Promise<void> {
  // 先加载 .env，保证后续读取到的就是配置好的值
  const envFiles = loadEnvFiles();
  if (envFiles.loaded.length > 0) {
    console.log(`[kb] 已加载配置文件：${envFiles.loaded.join(', ')}`);
  }

  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const hostArg = args.indexOf('--host');

  const port = Number(
    portArg >= 0 && args[portArg + 1] ? args[portArg + 1] : (process.env.PORT ?? 8787),
  );
  const host =
    hostArg >= 0 && args[hostArg + 1] ? args[hostArg + 1] : (process.env.HOST ?? '127.0.0.1');

  const publicDir = resolve(process.cwd(), 'public');
  const uploadDir = resolve(process.cwd(), 'data', 'uploads');
  mkdirSync(uploadDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });

  const server = new KbServer({ port, host, publicDir, uploadDir });
  const { url } = await server.listen();

  console.log('知识库助手服务已启动');
  console.log(`  服务地址：  ${url}`);
  console.log(`  插件脚本：  ${url}/api/public/kb/widget.js`);
  console.log(`  管理台：    ${url}/demo/`);
  console.log(`  外部测试页：${url}/demo/external.html`);
  console.log(`  静态目录：  ${publicDir}`);
  console.log('\n按 Ctrl+C 停止。');

  const shutdown = async () => {
    console.log('\n正在停止服务…');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

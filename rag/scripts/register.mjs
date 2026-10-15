/**
 * 模块解析注册入口。
 *
 * 1) 把 `node:test` 重定向到进程内的极简测试框架
 * 2) 把 `.js` 说明符解析到对应的 `.ts` 源文件
 *
 * 用法：node --experimental-strip-types --import ./scripts/register.mjs <入口>
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./hooks.mjs', pathToFileURL('./scripts/'));

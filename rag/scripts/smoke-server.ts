/** 服务端在线检查：静态资源、公开契约、SSE 与拒答路径。 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KbServer } from '../src/server/server.ts';
import { KnowledgeBaseEngine } from '../src/lib/kb/index.ts';

const workDir = mkdtempSync(join(tmpdir(), 'kb-live-'));
const docDir = join(workDir, 'docs');
mkdirSync(docDir, { recursive: true });
writeFileSync(
  join(docDir, 'ops.md'),
  '# 运维手册\n\n## 数据库\n\n数据库默认端口是 5432，连接池上限为 20。\n',
  'utf8',
);

const engine = new KnowledgeBaseEngine({ databasePath: join(workDir, 'kb.db'), embedder: null, llm: null });
const server = new KbServer({
  port: 0,
  host: '127.0.0.1',
  publicDir: join(process.cwd(), 'public'),
  uploadDir: join(workDir, 'up'),
  engine,
});
const { url } = await server.listen();
const kb = engine.createKnowledgeBase({ name: 'live' });
await engine.importDirectory({ kbId: kb.id, directory: docDir, include: ['*.md'] });
const key = kb.publicKey!;

const results: string[] = [];
const check = (name: string, pass: boolean, detail: string) =>
  results.push(`${pass ? '✔' : '✖'} ${name}\n    ${detail}`);

// 根路径重定向
const root = await fetch(`${url}/`, { redirect: 'manual' });
check('根路径重定向到管理台', root.status === 302 && root.headers.get('location') === '/demo/', `HTTP ${root.status} → ${root.headers.get('location')}`);

// 管理台页面
const demo = await fetch(`${url}/demo/`);
check('管理台页面可访问', demo.ok && (await demo.text()).includes('验收清单'), `HTTP ${demo.status}`);

// 外部测试页
const external = await fetch(`${url}/demo/external.html`);
const externalHtml = await external.text();
check(
  '外部测试页可访问且不含宿主专有接口',
  external.ok && !/\/api\/(trace|execution|skills|experiments)/.test(externalHtml),
  `HTTP ${external.status}，只引用 /api/public/kb/`,
);

// 插件产物
const widget = await fetch(`${url}/api/public/kb/widget.js`);
const widgetCode = await widget.text();
check(
  '插件产物可获取且跨域可读',
  widget.ok && widget.headers.get('access-control-allow-origin') === '*',
  `HTTP ${widget.status}，CORS=${widget.headers.get('access-control-allow-origin')}，${(widgetCode.length / 1024).toFixed(1)}KB`,
);

// 公开配置
const config = await fetch(`${url}/api/public/kb/${kb.id}/config`, { headers: { 'x-kb-key': key } });
check('公开配置接口需要有效 key', config.ok, `HTTP ${config.status}`);

const noKey = await fetch(`${url}/api/public/kb/${kb.id}/config`);
check('缺少 key 时拒绝访问', noKey.status === 401, `HTTP ${noKey.status}`);

// SSE 流式
const sse = await fetch(
  `${url}/api/public/kb/${kb.id}/chat/stream?message=${encodeURIComponent('数据库默认端口是多少')}`,
  { headers: { 'x-kb-key': key } },
);
const sseText = await sse.text();
const events = [...sseText.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
check(
  'SSE 流式事件完整',
  events.includes('meta') && events.includes('delta') && events.includes('done'),
  `事件：${[...new Set(events)].join(' → ')}`,
);

// 拒答路径
const refusal = await fetch(`${url}/api/public/kb/${kb.id}/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-kb-key': key },
  body: JSON.stringify({ message: '如何申请火星移民签证的面试预约' }),
}).then((r) => r.json());
check(
  '未覆盖问题被拒答',
  refusal.gate?.decision === 'no_evidence' && refusal.citations?.length === 0,
  `裁决 ${refusal.gate?.decision}，引用 ${refusal.citations?.length} 条`,
);

console.log('服务端在线检查');
console.log('='.repeat(64));
for (const line of results) console.log(line);

const failed = results.filter((r) => r.startsWith('✖')).length;
console.log(`\n通过：${results.length - failed}    失败：${failed}`);

await server.close();
engine.close();
try {
  rmSync(workDir, { recursive: true, force: true });
} catch {
  /* Windows 下句柄释放延迟，忽略 */
}
process.exitCode = failed > 0 ? 1 : 0;

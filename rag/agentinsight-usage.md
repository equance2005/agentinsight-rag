# Agent Insight 知识库助手：完整使用指南

本文说明如何部署、导入知识、接入 Agent Insight，以及如何在 Agent Insight 中安全地使用知识库问答、Trace/Run 诊断、Dataset 和 Skill 相关能力。

本文对应本仓库当前实现。仓库内的知识库引擎、CLI、HTTP 公开接口和网页插件已经实现；Agent Insight 的页面感知、Trace/Run 数据读取和需要用户确认的写入动作属于宿主适配层，应通过 `DocumentSource`、公开接口或宿主自己的受控 API 接入。

## 1. 系统组成

系统分为三层：

1. **通用知识库层**：负责文档解析、分块、关键词/向量检索、引用、拒答、反馈和增量同步。
2. **服务与客户端层**：提供 CLI、管理台上传、HTTP API 和 `kb-widget.js` 网页插件。
3. **Agent Insight 适配层**：读取当前页面或当前选中的 Trace、Run、Dataset、Skill 等对象，把可授权的数据转换成知识来源或问答上下文，并在执行任何写入动作前展示预览、来源和目标对象，等待用户确认。

通用知识库层不直接依赖 Agent Insight 的 `Execution`、`Trace`、`Run`、`Experiment` 或 `Skill` 数据结构。这样可以继续独立运行，也可以嵌入 Agent Insight 或其他网站。

## 2. 安装和启动

要求 Node.js 20 或更高版本，推荐 Node.js 22 或更高版本。

```powershell
npm install
npm run build:widget
npm run typecheck
```

启动服务：

```powershell
npm run serve
```

默认地址：

```text
http://127.0.0.1:8787
```

可用页面：

- 管理台：`http://127.0.0.1:8787/demo/`
- 外部测试页：`http://127.0.0.1:8787/demo/external.html`
- 插件脚本：`http://127.0.0.1:8787/api/public/kb/widget.js`

自定义端口和监听地址：

```powershell
npm run serve -- --port 8787 --host 127.0.0.1
```

生产环境应通过反向代理提供 HTTPS，并将服务绑定到受控网卡或内网地址。

## 3. 密钥和配置安全

### 3.1 配置文件规则

复制示例配置：

```powershell
Copy-Item .env.example .env.local
```

只在本地 `.env.local` 中填写真实值。仓库已将 `.env`、`.env.local`、数据库文件和 `data/` 加入忽略列表。

配置文件加载顺序为：

1. `.env.local`
2. `.env`
3. 操作系统环境变量

环境变量优先级最高。

### 3.2 配置项

```dotenv
KB_DATABASE_PATH=./data/kb.db

# 可选：语义检索
KB_EMBEDDING_MODEL=<embedding-model>
KB_EMBEDDING_DIM=<embedding-dimension>
KB_EMBEDDING_BASE_URL=https://<provider>/v1
KB_EMBEDDING_API_KEY=<embedding-api-key>

# 可选：生成式回答
KB_LLM_MODEL=<llm-model>
KB_LLM_BASE_URL=https://<provider>/v1
KB_LLM_API_KEY=<llm-api-key>
KB_LLM_TEMPERATURE=0.2
KB_LLM_MAX_TOKENS=1024
```

没有配置 embedding 时仍可使用关键词检索；没有配置 LLM 时仍会返回带引用的检索原文。配置 embedding 后，需要为已有内容执行：

```powershell
npm run cli -- reindex <知识库名称>
```

检查配置和端点连通性：

```powershell
npm run cli -- doctor
```

### 3.3 上传前的密钥检查

提交到 GitHub 前执行：

```powershell
rg -n --hidden -S "sk-[A-Za-z0-9]|pk_[A-Za-z0-9]|API_KEY=|TOKEN=|SECRET=" . `
  -g '!node_modules' -g '!data' -g '!.git' -g '!.env' -g '!.env.local'
```

结果中只能出现示例占位符或文档说明，不能出现真实密钥。若真实密钥曾经出现在提交、日志、截图或公开仓库中，应立即撤销并重新生成，不能只删除文本。

文档中的示例统一使用以下占位符：

```text
<embedding-api-key>
<llm-api-key>
pk_xxxxxxxxxxxxxxxxxxxx
kb_xxxxxxxxxxxxxxxxxxxx
```

`KB_EMBEDDING_API_KEY` 和 `KB_LLM_API_KEY` 是模型供应商密钥；`pk_...` 是知识库公开 key。三者不能混用。

## 4. 创建知识库

创建名为 `main` 的知识库：

```powershell
npm run cli -- create main --description "Agent Insight 产品和运行数据知识库"
```

如果只允许 Agent Insight 页面或指定站点调用，可以配置来源白名单：

```powershell
npm run cli -- create main `
  --description "Agent Insight 产品和运行数据知识库" `
  --origins "https://insight.example.com,localhost:3000"
```

查看 ID、公开 key、域名白名单和导入统计：

```powershell
npm run cli -- show main
```

输出中的：

- `id：kb_...` 用于路径和插件配置
- `公开 key：pk_...` 用于 `x-kb-key` 鉴权

公开 key 可以访问公开问答和上传接口，但不能代替管理端权限，也不能直接执行 Agent Insight 数据写入。

由于当前公开上传、列表和删除接口使用同一个 `public key` 鉴权，浏览器页面中的 key 不应被当作管理员密钥使用。若普通访客不应管理文档，请把管理台放在受控后台或内部网络中，并通过域名白名单、反向代理或服务端权限再次限制。

## 5. 导入知识文档

### 5.1 CLI 导入目录

```powershell
npm run cli -- import main "D:\knowledge-base\docs"
```

只导入指定类型：

```powershell
npm run cli -- import main "D:\knowledge-base\docs" `
  --include "*.md,*.markdown,*.txt,*.docx,*.xlsx,*.xls,*.pdf"
```

排除归档和临时目录：

```powershell
npm run cli -- import main "D:\knowledge-base\docs" `
  --exclude "archive/**,tmp/**"
```

`*.md` 会匹配任意子目录中的 Markdown 文件。默认会跳过 `node_modules`、`.git`、隐藏目录、Office 临时文件和常见下载临时文件。

### 5.2 增量同步

日常更新使用：

```powershell
npm run cli -- sync main "D:\knowledge-base\docs"
```

系统会使用文件内容哈希、修改时间、解析器版本和分块配置判断变更。只修改一个段落时，通常只重新计算受影响片段的 embedding。

源目录删除的文件也要删除时：

```powershell
npm run cli -- import main "D:\knowledge-base\docs" --prune
```

以当前目录为完整权威来源，执行全量同步：

```powershell
npm run cli -- import main "D:\knowledge-base\docs" --full
```

只有在目录确实包含完整资料时才使用 `--full`。

### 5.3 管理台上传

打开 `/demo/`，填写知识库 ID 或名称以及公开 key，选择全部或部分文件，点击“上传并导入”。

解析失败会显式显示，并可通过以下命令复核：

```powershell
npm run cli -- docs main
```

### 5.4 支持格式和限制

查看当前注册的格式：

```powershell
npm run cli -- formats
```

当前支持 Markdown、文本、Word `.docx`、Excel `.xlsx/.xls/.xlsm` 和 PDF。扫描件或图片型 PDF 没有文本层时会出现告警，需要 OCR 后再导入。旧版 Word `.doc` 需要先转换为 `.docx`。

HTTP multipart 上传的单次请求体上限约为 64 MB；大批量资料请拆分多次上传或使用 CLI 同步。

## 6. HTTP 上传和问答

启动服务后，使用知识库 ID 和公开 key：

```powershell
curl.exe -X POST `
  "http://127.0.0.1:8787/api/public/kb/kb_xxxxxxxxxxxxxxxxxxxx/upload" `
  -H "x-kb-key: pk_xxxxxxxxxxxxxxxxxxxx" `
  -F "files=@D:\knowledge-base\manual.md" `
  -F "files=@D:\knowledge-base\faq.pdf"
```

请求也可以使用 `?key=...`，但生产环境推荐请求头：

```powershell
curl.exe -X POST `
  "http://127.0.0.1:8787/api/public/kb/kb_xxxxxxxxxxxxxxxxxxxx/chat" `
  -H "content-type: application/json" `
  -H "x-kb-key: pk_xxxxxxxxxxxxxxxxxxxx" `
  -d '{"message":"服务默认端口是多少？"}'
```

主要公开接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/public/kb/widget.js` | 获取网页插件 |
| `GET` | `/api/public/kb/:kbId/config` | 获取插件配置 |
| `POST` | `/api/public/kb/:kbId/upload` | 上传和导入文档 |
| `GET` | `/api/public/kb/:kbId/documents` | 查看文档列表与解析状态（管理台） |
| `DELETE` | `/api/public/kb/:kbId/documents/:documentId` | 删除文档及其检索向量（管理台） |
| `POST` | `/api/public/kb/:kbId/chat` | 非流式问答 |
| `GET` | `/api/public/kb/:kbId/chat/stream` | SSE 流式问答 |
| `GET` | `/api/public/kb/:kbId/chunks/:chunkId` | 查看引用原文和定位 |
| `GET` | `/api/public/kb/:kbId/conversations/:id` | 获取会话历史 |
| `POST` | `/api/public/kb/feedback` | 提交回答反馈 |

回答结果包含引用、检索模式、闸门结论和耗时信息。`no_evidence` 表示证据不足，系统不会让模型凭空补全。

## 7. 嵌入 Agent Insight 页面

### 7.1 基础插件接入

在 Agent Insight 的前端页面中加入：

```html
<script
  src="https://kb.example.com/api/public/kb/widget.js"
  data-kb-id="kb_xxxxxxxxxxxxxxxxxxxx"
  data-api-key="pk_xxxxxxxxxxxxxxxxxxxx"
  data-api-base="https://kb.example.com"
  data-title="Agent Insight Copilot"
  data-welcome="我可以根据产品文档和已授权的运行数据回答问题。">
</script>
```

插件默认使用 Shadow DOM 隔离样式。严格 CSP 环境可设置：

```html
data-mode="iframe"
```

### 7.2 Agent Insight 页面上下文

页面感知应由 Agent Insight 宿主完成。推荐流程：

1. 页面路由或用户选择变化时，宿主生成结构化上下文。
2. 上下文只包含当前用户有权查看的字段。
3. 宿主把上下文作为问答请求的附加信息或临时 `DocumentSource`。
4. 回答中的每个结论都标注来源类型：知识库文档、Trace/Run、Dataset、Skill 或未覆盖。
5. 涉及创建 Dataset、修改 Prompt、修改 Evaluator、关闭问题或其他写入动作时，只生成预览，不直接执行。
6. 用户确认后，宿主调用 Agent Insight 自己的受控写入 API，并记录审计信息。

建议的上下文结构：

```typescript
type AgentInsightContext = {
  pageType: 'trace' | 'run' | 'dataset' | 'skill' | 'experiment' | 'other';
  objectId?: string;
  objectTitle?: string;
  selectedFields?: Record<string, unknown>;
  relatedIds?: string[];
  capturedAt: string;
  permissionScope: string[];
};
```

不要通过扫描浏览器 URL、读取无关 DOM 或直接连接数据库来推断对象；应使用 Agent Insight 已有的页面状态、API 或明确的宿主回调。

### 7.3 三条推荐路由

**知识库问答路由**

- 用户询问产品功能、部署方式、规范或操作方法
- 使用通用知识库检索
- 返回文档片段和引用定位
- 没有足够证据时明确拒答

**当前页面分析路由**

- 用户询问当前 Trace/Run 的步骤、模型、工具调用、错误和耗时
- 使用宿主提供的当前对象上下文
- 回答只能引用已读取的字段
- 未采集字段必须明确说明“当前上下文未提供”

**协作执行路由**

- 用户要求生成 Dataset、Evaluator、筛选条件、Prompt 修改草案或 Skill 优化建议
- 先生成预览，包括目标对象、字段来源、拟写入内容和影响范围
- 用户明确确认后再执行写入
- 取消、超时或未确认时不得写入平台

## 8. Agent Insight 数据接入示例

如果 Agent Insight 中的对象需要进入知识库，可以实现 `DocumentSource`：

```typescript
import type { DocumentSource, SourceEntry } from '../src/lib/kb/ports.js';

export class AgentInsightDocsSource implements DocumentSource {
  readonly name = 'agent-insight-docs';

  async list(): Promise<SourceEntry[]> {
    const docs = await listAuthorizedInsightDocuments();
    return docs.map((doc) => ({
      key: doc.id,
      relativePath: `agent-insight/${doc.id}.md`,
      title: doc.title,
      mimeType: 'text/markdown',
      sizeBytes: Buffer.byteLength(doc.markdown, 'utf8'),
      mtime: doc.updatedAt,
    }));
  }

  async materialize(entry: SourceEntry) {
    const doc = await getAuthorizedInsightDocument(entry.key);
    const path = await writeTemporaryFile(`${entry.key}.md`, doc.markdown);

    return {
      path,
      fileName: `${entry.key}.md`,
      mimeType: 'text/markdown',
      cleanup: async () => removeTemporaryFile(path),
    };
  }
}
```

摄取：

```typescript
await engine.ingest({
  kbId: knowledgeBaseId,
  source: new AgentInsightDocsSource(),
  mode: 'incremental',
});
```

`list()` 返回稳定 ID 和更新时间，`materialize()` 返回临时文件。引擎会继续执行解析、分块、哈希差集和向量更新。

## 9. Trace、Run、Dataset、Skill 的回答边界

### Trace/Run

可回答：执行步骤、模型调用、工具调用、错误、耗时、输入输出摘要和已采集字段。

不可推断：未采集的内部状态、没有证据支持的根因、用户权限范围外的数据。

### Dataset

可回答：名称、字段、样例、当前筛选条件、已知失败模式和统计信息，前提是这些字段已被授权读取。

### Skill

可回答：名称、版本、输入输出约定、已读取的代码或文档片段，以及基于证据的改进建议。

缺少版本、源码或参考答案时，应明确标记信息缺失，不能自行补造。

### 写入操作

以下操作必须经过确认：

- 创建或修改 Dataset
- 创建或修改 Evaluator
- 修改 Prompt 或 Skill
- 批量筛选、标注或关闭平台对象
- 任何会改变 Agent Insight 数据的操作

确认卡片至少展示目标对象、字段变更、数据来源、预计影响范围和撤销方式。

## 10. FAQ 录入和维护

录入固定问答：

```powershell
npm run cli -- qa add main `
  --question "服务默认端口是多少？" `
  --answer "服务默认监听端口为 3000。" `
  --tags "部署,端口"
```

查看问答对：

```powershell
npm run cli -- qa ls main
```

查看未解决问题：

```powershell
npm run cli -- feedback main --issues
npm run cli -- gaps main
```

补录后关闭问题：

```powershell
npm run cli -- resolve main `
  --issue issue_xxxxxxxxxxxxxxxxxxxx `
  --question "新的问题" `
  --answer "有依据的标准答案"
```

用户点踩、证据不足、冲突证据和完全未召回的问题会进入 backlog，适合定期复查。

## 11. 运行验证清单

首次部署：

```powershell
npm run typecheck
npm run build:widget
npm test
npm run acceptance
npm run cli -- doctor
```

知识库验证：

```powershell
npm run cli -- formats
npm run cli -- show main
npm run cli -- docs main
npm run cli -- search main "一个已知问题" --top 5
npm run cli -- ask main "一个已知问题"
```

Agent Insight 集成验证：

1. 在普通产品文档问题上能返回引用。
2. 在当前 Trace/Run 页面能读取正确的对象 ID 和授权字段。
3. 切换页面后不会继续使用上一个对象的上下文。
4. 当前上下文没有字段时会明确说明缺失。
5. 未确认时不会创建或修改 Dataset、Evaluator、Prompt 或 Skill。
6. API 请求只访问预期的公开接口和 Agent Insight 受控 API。
7. 浏览器、服务日志和错误响应不会打印模型密钥或公开 key 完整值。

## 12. 常见问题

**401：public key 无效**

确认使用的是 `kb show main` 输出的 `pk_...`，不要把 `kb_...`、模型供应商的 `sk-...` 或 `.env.local` 中的模型密钥填到 `data-api-key`。

**403：来源不允许**

检查 `--origins` 配置以及请求的 `Origin`。开发时可暂不设置白名单，生产环境应明确限制来源。

**文件已上传但未新增**

通常表示文件内容未变化。执行 `npm run cli -- docs main` 查看已有文档；需要重建向量时执行 `npm run cli -- reindex main`。

**PDF 没有可检索内容**

扫描件通常只有图片，没有文本层。先使用 OCR 生成可搜索 PDF，再重新导入。

**回答被拒答**

检查 `search` 结果、文档是否导入成功、向量是否完整以及 `kb gaps main`。拒答是证据不足保护机制，不应通过提示词强行绕过。

## 13. GitHub 发布前检查

发布前确认：

```powershell
git status --short
git diff -- docs/agentinsight-usage.md README.md
rg -n --hidden -S "sk-[A-Za-z0-9]|pk_[A-Za-z0-9]{12,}|KB_.*API_KEY=.+" . `
  -g '!node_modules' -g '!data' -g '!.git' -g '!.env' -g '!.env.local'
```

只提交：

- 源代码
- `.env.example`
- 脱敏后的文档
- 测试和脚本

不要提交：

- `.env.local`
- `data/` 下的数据库、上传暂存文件和日志
- 包含真实密钥的终端输出、截图或示例请求
- Agent Insight 用户数据、Trace 内容或内部 API 响应

如果密钥曾经被提交过，即使后来删除文件，也要在供应商后台撤销旧密钥并生成新密钥，然后再发布仓库。


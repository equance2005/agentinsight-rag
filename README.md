# Agent Insight + RAG

这个仓库包含两个可以联动运行的服务：

- `agent-insight/`：Agent Insight 平台与 Copilot，默认运行在 `3000`。
- `rag/`：独立知识库服务，默认运行在 `8787`。

Copilot 的请求流程是：

```text
当前 Trace/Execution 查询
        +
RAG 知识库引用检索
        ↓
合并证据
        ↓
Agent Insight 活动模型统一回答
```

## 启动 RAG

```bash
cd rag
npm install
npm run build:widget
npm run serve
```

RAG 管理台：`http://127.0.0.1:8787/demo/`

先创建或导入知识库，并记录 `kb show <知识库>` 输出的知识库 ID 和 `public key`。

## 启动 Agent Insight

在 Ubuntu/WSL 中：

```bash
cd agent-insight
npm install
npx prisma generate
bash scripts/develop_start.sh
```

Agent Insight：`http://127.0.0.1:3000`

## 配置 Copilot 使用 RAG

在 Agent Insight 运行环境的 `.env` 或管理的 Agent Insight 环境文件中配置：

```dotenv
AGENT_INSIGHT_RAG_BASE_URL=http://127.0.0.1:8787
AGENT_INSIGHT_RAG_KB_ID=kb_xxxxxxxxxxxxxxxx
AGENT_INSIGHT_RAG_API_KEY=pk_xxxxxxxxxxxxxxxx
AGENT_INSIGHT_RAG_ORIGIN=http://127.0.0.1:3000
```

配置后重启 Agent Insight。Copilot 会并行读取当前页面的 Trace/Execution 证据和 RAG 引用片段，再使用 Agent Insight 的活动模型生成答案。

RAG 服务不可用时，Copilot 会保留 Trace-only 回答；RAG 配置不会写入浏览器，也不会提交到 Git。

## 代码边界

RAG 只负责知识库管理、混合检索和引用；Agent Insight 只负责 Trace 上下文、Copilot 路由、模型生成和工作流确认。桥接代码位于 `agent-insight/src/lib/copilot/rag.ts`，调用 RAG 的公开问答接口并提取 `citations[].snippet` 作为知识证据。

## 不提交的内容

不要提交 `.env`、`.env.local`、数据库文件、`data/`、`node_modules/`、`.next/` 或模型 API Key。

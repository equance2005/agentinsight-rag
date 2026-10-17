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

## 一键启动两个项目

Windows + Ubuntu/WSL 环境下，推荐直接双击仓库根目录的 `start-all.cmd`。
也可以在 PowerShell 中执行：

```powershell
.\start-all.ps1
```

也可以直接双击 `start-all.cmd`，它会自动调用上面的 PowerShell 脚本；如果直接双击
`.ps1` 被记事本打开，请使用这个 `.cmd` 文件。

脚本会分别打开两个 PowerShell 窗口：RAG 在 Windows/Node 中运行，Agent Insight 按下面的
Ubuntu/WSL 步骤运行。脚本只会在对应项目缺少 `node_modules` 时安装依赖；需要强制重新同步依赖时使用：

```powershell
.\start-all.ps1 -Install
```

依赖已经安装后也可以明确跳过安装：

```powershell
.\start-all.ps1 -SkipInstall
```

如果 PowerShell 禁止执行脚本，可以显式绕过当前进程的策略：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-all.ps1
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

### 获取知识库 ID 和 public key

在 `rag` 目录执行：

```bash
cd rag
npm run cli -- ls
```

先查看已有知识库。如果还没有知识库，创建一个：

```bash
npm run cli -- create agentinsight-docs
```

然后查看详情：

```bash
npm run cli -- show agentinsight-docs
```

也可以把知识库 ID 传给 `show`：

```bash
npm run cli -- show kb_xxxxxxxxxxxxxxxx
```

从输出中复制两项：

- `id` 或 `kbId`：形如 `kb_xxxxxxxxxxxxxxxx`，填入 `AGENT_INSIGHT_RAG_KB_ID`。
- `public key`：形如 `pk_xxxxxxxxxxxxxxxx`，填入 `AGENT_INSIGHT_RAG_API_KEY`。

知识库 ID 和 public key 必须来自同一条 `kb show` 输出，不能把模型 API Key（例如 `sk-...`）当作 RAG public key。

知识库也可以通过管理台查看：打开 `http://127.0.0.1:8787/demo/`，在知识库管理区域选择目标知识库，复制其 ID 和 public key。若管理台只显示脱敏值，优先使用 CLI 的 `kb show` 输出。

## 启动 Agent Insight

在 Ubuntu/WSL 中：

```bash
cd agent-insight
npm install
npx prisma generate
bash scripts/develop_start.sh
```

Agent Insight：`http://localhost:3000`

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

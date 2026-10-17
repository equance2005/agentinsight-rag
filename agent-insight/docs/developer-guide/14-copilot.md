# Copilot 上下文与工作流

## API

- `POST /api/copilot/chat`：加载当前上下文，执行意图路由，返回带来源的回答和结构化 `plan`。`plan.steps` 只描述读取、分析和待确认写操作；它不直接写入存储。请求应携带 `x-witty-api-key` 或登录用户；可选 `images` 数组传入最多 4 个 `data:image/{png|jpeg|webp|gif};base64,...` 图片上下文。
- `POST /api/copilot/workflows/preview`：只生成工作流草稿，不写入数据。
- `POST /api/copilot/workflows/confirm`：校验短时确认令牌后调用现有 Dataset/Evaluator 写入存储。
- `GET /api/copilot/runs?id=...`：读取当前用户自己的跨模块 TodoList。
- `PATCH /api/copilot/runs/:id/steps/:stepId`：更新当前用户自己的步骤状态；领域写操作仍必须调用对应 Preview/Confirm 或领域 API。

上下文 envelope 定义在 `src/lib/copilot/contracts.ts`。页面只提交 `pageType`、`objectType`、稳定 `objectId` 和可选快照；服务端按用户权限重新读取权威数据。

模型连接复用 `/api/eval/settings` 与 `/modelconfig/registry` 的活动配置。Copilot 不在浏览器保存模型密钥；图片仅随当前请求传递给活动模型。

RAG 证据桥接位于 `src/lib/copilot/rag.ts`。它调用 `POST {AGENT_INSIGHT_RAG_BASE_URL}/api/public/kb/{AGENT_INSIGHT_RAG_KB_ID}/chat`，使用 `x-kb-key` 鉴权、`claimCheck:false` 减少一次 RAG 校验调用，并提取返回的 citations.snippet 作为 `kind=knowledge` 证据。RAG 请求失败会记录为缺失信息，不会阻断 Trace-only Copilot。

## 上下文适配器

`src/lib/copilot/context.ts` 当前适配：

- `execution/task`：Execution、Session interactions、AgentDebug 报告。
- `dataset/case`：AgentDataset 字段和有限样例。
- `skillVersion`：Skill 与指定/当前版本内容。
- `evaluation`：复用实验详情 API 的只读聚合。

Trace 交互限制为首尾窗口，超出部分在 `missing` 中声明；敏感值使用轨迹事实层的脱敏函数处理。

## 工作流确认

`src/lib/copilot/planner.ts` 根据意图生成有限步骤计划：知识问答、当前对象分析、Trace 回流 Dataset、Evaluator 草稿和运行筛选分别映射到只读工具、分析工具或确认式写工具。计划是 UI 和模型之间的执行摘要，不替代领域 API；领域 API 仍负责鉴权、参数校验、幂等和最终写入。

跨模块计划持久化在 `CopilotRun` / `CopilotRunStep`，状态只允许 `pending`、`in_progress`、`done`、`blocked`；模型不保存原始思维链，只保存步骤标题、工具名、依赖和结果摘要。复杂 Trace 诊断走 `src/lib/copilot/react.ts` 的有界只读循环，最多 4 步并在建议之后停在人工确认点。

预览令牌绑定 `user`、操作和草稿内容，并在十分钟后过期。Trace→Dataset 保存复用 `agent_datasets_storage`；Evaluator 草稿复用 `user_evaluators_storage` 和自动注册逻辑。重复确认按 Trace 来源或评估器名称幂等处理。

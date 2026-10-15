# Copilot 上下文与工作流

## API

- `POST /api/copilot/chat`：加载当前上下文，执行意图路由并返回带来源的回答。请求应携带 `x-witty-api-key` 或登录用户；可选 `images` 数组传入最多 4 个 `data:image/{png|jpeg|webp|gif};base64,...` 图片上下文。
- `POST /api/copilot/workflows/preview`：只生成工作流草稿，不写入数据。
- `POST /api/copilot/workflows/confirm`：校验短时确认令牌后调用现有 Dataset/Evaluator 写入存储。

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

预览令牌绑定 `user`、操作和草稿内容，并在十分钟后过期。Trace→Dataset 保存复用 `agent_datasets_storage`；Evaluator 草稿复用 `user_evaluators_storage` 和自动注册逻辑。重复确认按 Trace 来源或评估器名称幂等处理。

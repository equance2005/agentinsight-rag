# Agent Insight Copilot 上下文与工作流协作：方案设计

## 上下文契约

前端通过 Copilot context envelope 传入当前页面对象：

```ts
type CopilotContextEnvelope = {
  pageType: 'trace' | 'diagnosis' | 'dataset' | 'evaluation' | 'skill' | 'unknown';
  objectType: 'execution' | 'task' | 'dataset' | 'case' | 'evaluation' | 'skillVersion' | 'unknown';
  objectId?: string;
  objectIds?: string[];
  user: string;
  snapshot?: {
    title?: string;
    summary?: string;
    selectedFields?: string[];
  };
  capturedAt: string;
};
```

`objectId/objectIds` 是稳定标识；`snapshot` 只是页面已经展示的最小摘要，服务端仍按权限重新读取权威数据。没有上下文时，助手只能走通用知识库问答或请求用户补充对象。

## 服务端分层

- `src/lib/copilot/context/`：按 `pageType` 注册上下文适配器，读取 Trace、诊断、Dataset、Evaluation、Skill Version，并输出统一 `EvidenceBlock`。
- `src/lib/copilot/router/`：将用户输入判为 `knowledge`、`context_analysis`、`how_to`、`workflow_draft`、`workflow_execute` 或 `clarify`。路由结果包含命中的上下文和理由，供审计。
- `src/lib/copilot/workflows/`：只生成草稿和确认令牌；Dataset 回流复用现有 `trace-drafts` 与 `backflow`，Evaluator/Skill 草稿复用 Workbench 会话。
- `src/app/api/copilot/`：统一流式问答入口、上下文检查、草稿预览和确认执行 API。

## API 契约

`POST /api/copilot/chat` 接收 `{ message, context, conversationId }`，返回流式消息和 `route`、`sources`、`draft` 元数据。

`POST /api/copilot/workflows/preview` 只读生成草稿：

```ts
{ action: 'trace_to_dataset' | 'evaluator_draft' | 'run_filter', context, input }
```

返回 `{ previewId, action, target, changes, sources, missing, expiresAt }`。

`POST /api/copilot/workflows/confirm` 接收 `{ previewId, confirmationToken }`。服务端再次校验用户、上下文对象、目标对象和草稿哈希后，调用现有写入服务；重复确认返回同一结果。

## 写入安全

- `workflow_execute` 只有在显式确认令牌有效时才可执行。
- 预览包含字段级来源和缺失字段；缺失参考答案时保留 `pending`，不生成默认答案。
- 确认令牌短时有效且绑定 `user + action + target + draftHash`。
- 所有预览、确认、取消和失败事件写入审计日志；不把 API Key 或完整敏感 Trace 写入日志。

## 前端接入

在 `Trace`、诊断、Dataset、Evaluation、Skill Version 页面复用一个 Copilot 侧栏。页面只负责生成 envelope 和打开侧栏；上下文适配、路由、证据和草稿由服务端完成。工作流草稿在侧栏中以字段表、来源标记、缺失项和确认按钮呈现。

## RAG 证据桥接

Copilot 可选调用独立 RAG 服务的公开问答接口，提取 `citations[].snippet` 作为知识证据，并与当前页面的 Trace/Execution 证据合并后交给 Agent Insight 活动模型统一生成。配置由 `AGENT_INSIGHT_RAG_BASE_URL`、`AGENT_INSIGHT_RAG_KB_ID`、`AGENT_INSIGHT_RAG_API_KEY` 和可选的 `AGENT_INSIGHT_RAG_ORIGIN` 提供。桥接失败只增加 `missing` 信息，不阻断页面上下文回答。

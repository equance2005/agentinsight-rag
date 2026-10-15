# Agent Insight Copilot 上下文与工作流协作：开发计划

## P0：上下文与只读分析

1. 增加 Copilot context 类型、适配器接口和用户隔离查询函数。
2. 接入 Trace/Execution、AgentDebug、Dataset/Case、SkillVersion 四类上下文。
3. 增加统一 `POST /api/copilot/chat`，复用现有模型配置和流式协议。
4. 在 Trace 详情页和 Skill 详情页接入 Copilot 侧栏。
5. 为路由、权限、上下文缺失、长 Trace 限制补测试。

## P1：草稿和预览

1. 接入 `trace_to_dataset` 预览，复用 `extractTaskArtifacts`、字段映射和 Trace 回流模型。
2. 接入 `evaluator_draft`，生成可编辑的目标、输入字段、评分规则和待补充项。
3. 接入 `run_filter` 只读筛选，返回查询条件、范围和可回查的 Execution 链接。
4. 统一前端 DraftCard、SourceChip、MissingField 和 ConfirmBar 组件。

## P2：确认执行与审计

1. 增加短时预览记录和确认令牌存储；优先使用现有持久化方式，避免复制 Dataset/Evaluator 数据模型。
2. 确认时调用现有 Dataset 回流、Workbench 会话和评测 API。
3. 实现幂等、取消、过期和权限变更检查。
4. 增加端到端验收：方法咨询不写入、未确认不写入、确认后可回查、重复确认不重复写入。

## 验证命令

- `npm run test`
- 目标页面浏览器验收：Trace、诊断、Dataset/Evaluation、Skill Version 各一条路径。
- 工作流边界：缺对象、缺目标、缺参考答案、无权限、重复确认、过期确认。

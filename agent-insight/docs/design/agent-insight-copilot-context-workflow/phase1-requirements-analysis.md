# Agent Insight Copilot 上下文与工作流协作：需求分析

## 背景

通用知识库助手已经提供独立问答、引用、拒答、多轮会话和嵌入插件。Agent Insight 还需要让助手理解用户当前查看的工程对象，并把分析结果连接到已有的 Trace、诊断、评测数据集、Evaluator 和 Skill 工作流。

## 范围

本需求覆盖规划文档的第二、三阶段：

- 页面上下文：Trace/Execution、诊断结果、Dataset/Case、Evaluation/Experiment、Skill/Version。
- 只读分析：执行摘要、模型/工具/Skill 调用解释、诊断结果解读、数据集/评测结果说明、Skill 代码解读。
- 工作流协作：运行筛选、基于 Trace 生成评测样例草稿、Evaluator 草稿和已有能力的预览/确认执行。
- 意图路由：区分知识问答、页面分析、方法咨询和写操作请求；歧义时澄清。

不在本期范围：跨页面长期记忆、自动修改 Prompt、自动发布 Skill、自动创建实验、替换现有评测执行引擎。

## 现有能力复用

| 目标能力 | 现有实现 | 复用方式 |
|-|-|-|
| Trace 读取 | `Execution`、`Session`、`AgentTraceView`、`/api/observe/*` | 通过稳定 `executionId/taskId` 读取最小快照 |
| 诊断 | `agent-debug` 与 skills-analysis API | 返回已有报告和证据定位，不重新推断数据库事实 |
| Trace 回流 | `/api/agent-datasets/trace-drafts`、`TraceBackflowDialog`、`/api/agent-datasets/backflow` | 生成草稿后复用现有字段映射与保存逻辑 |
| 数据集/评测 | `AgentEvalDataset`、`Config`、Evaluation/Experiment API | 只读摘要、Case 和结果；写入走现有确认接口 |
| Skill | `Skill`、`SkillVersion`、skill workbench | 读取当前版本文件；Evaluator 草稿进入现有工作台会话 |
| 对话 | `@assistant-ui/react`、`agent-adapter`、skill-opt chat | 新增 Copilot context envelope，保留流式消息协议 |

## 验收场景

1. 在 Trace 详情页询问“模型、工具和 Skill 分别做了什么”，回答能引用具体步骤或字段。
2. 在诊断结果页询问问题含义，回答能标明诊断报告中的证据和未知信息。
3. 在 Dataset/Evaluation 页面询问样例结构、失败模式和指标，回答不以通用知识库替代页面数据。
4. 在 Skill 版本页询问代码行为，回答能指向当前 Skill/Version 和文件内容。
5. “如何基于 Trace 创建评测样例”只返回方法说明；“基于当前 Trace 创建评测样例”生成可编辑草稿。
6. 未指定 Trace、目标 Dataset 或写操作范围时先澄清，不执行写入。
7. 保存 Dataset 样例、Evaluator 或筛选结果前显示目标对象、字段变化、来源和待补充字段；取消不产生写入。

## 约束

- 上下文由宿主页面显式传入，不能通过猜 URL、扫描 DOM 或全表查询推断。
- 只把回答当前问题所需的字段传给模型，长 Trace 必须摘要化并保留证据定位。
- Trace 未提供的参考答案、评分标准或期望 Skill 不得补造，必须标为待补充。
- 所有用户数据查询按当前登录用户隔离。

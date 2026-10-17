# Copilot 编排与跨模块任务计划

## 目标

让 Copilot 负责意图识别、有限规划和证据解释，领域 API 负责鉴权、参数校验、幂等和实际写入。

## 阶段二：有界诊断循环

Trace 诊断只允许三类工具：读取当前 Trace、检索 RAG 知识、生成诊断建议。服务端最多执行 4 步；任何写入、删除、发布和实验启动都必须停止在 `awaiting_confirmation`，转交现有 Preview/Confirm API。

## 阶段三：持久化 TodoList

跨模块任务保存为 `CopilotRun` 与 `CopilotRunStep`。Step 只保存计划、依赖、状态和结果摘要，不保存模型原始思维链。状态由服务端更新，模型只能提出下一步建议。

典型计划：

```text
Trace → Dataset → Evaluator → Experiment → Result analysis → Skill change → Regression experiment
```

所有步骤都绑定当前用户。写步骤需要确认令牌；失败步骤可以标记 `blocked`，不会自动跳过依赖。

## 验收

- 诊断循环最多 4 步，工具集合固定，返回证据来源和待确认动作。
- 用户可以创建、读取和更新自己的 CopilotRun/Step。
- 其他用户无法读取或更新该任务。
- TodoList 不执行 SQL 或直接写领域表；执行仍调用已有 Dataset、Evaluator、Experiment 和 Skill API。

# Agent Insight Copilot

Copilot 会根据当前页面显式传入的对象读取上下文。支持 Trace/Execution、诊断报告、评测数据集和 Skill 版本；没有选择对象时只能回答通用知识或要求补充对象。

侧栏底部提供模型选择入口和图片上传入口。模型连接统一在 `/modelconfig/registry` 管理，图片只作为本次问题的多模态上下文发送，不会写入知识库。

使用 Copilot 前需要保持 Agent Insight 登录状态；若模型密钥失效，侧栏会提供模型注册页入口重新连接。

要让 Copilot 同时使用 RAG 知识库，在 Agent Insight 运行环境配置 `AGENT_INSIGHT_RAG_BASE_URL`、`AGENT_INSIGHT_RAG_KB_ID` 和 `AGENT_INSIGHT_RAG_API_KEY`。提问时会并行读取当前 Trace 与 RAG 引用片段，再由 Agent Insight 模型统一回答。RAG 暂时不可用时，Copilot 会退化为只使用页面上下文。

在 Trace 页面可以询问模型、工具、Skill 调用和失败步骤；在 Dataset/Evaluation 页面可以询问样例、字段和评测结果；在 Skill 页面可以询问当前版本代码。回答会列出来源对象和定位信息。

Copilot 会区分方法咨询和写操作请求。询问“如何基于 Trace 创建样例”只返回步骤；明确要求“基于当前 Trace 创建样例”时，侧栏会生成草稿，展示字段、来源和缺失信息。只有点击确认后才保存到数据集或评估器，取消不会写入。

Trace 回流草稿不会自动填写缺失参考答案。Trace 只能证明执行过程，不能证明期望答案；缺失内容会标记为待补充。

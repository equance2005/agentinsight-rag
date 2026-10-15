# 通用知识库助手：Phase 2 需求设计

## 1. 总体架构

```text
入口层    CLI (agent-insight kb ...)          网页管理台 /kb
              └──────────────┬────────────────────┘
                             ↓  共用同一 service（禁止两条实现）
引擎层    src/lib/kb/
          ingest   → parse → chunk → embed → upsert
          retrieve → 关键词召回 ∥ 语义召回 → RRF 融合 → 重排
          answer   → 闸门①检索 → 闸门②证据 → 流式生成 → 闸门③校验
                             ↓
          /api/public/kb/*  （面向插件的公开契约）
                             ↓
交付层    kb-widget.js（单文件，Shadow DOM）
          ├─ 宿主 A：Agent Insight 之外任意网页
          └─ 宿主 B：Agent Insight 页面（经适配层）
```

关键约束：`src/lib/kb/**` 只依赖自身类型与 `VectorStore / EmbeddingProvider / LLMProvider` 抽象接口，**不 import** 任何 Agent Insight 专有模型。

## 2. 目录结构

```text
src/lib/kb/
  index.ts                 对外统一入口
  types.ts                 Document / Chunk / Retrieval / Citation / Answer 契约
  ports.ts                 VectorStore / EmbeddingProvider / LLMProvider / Reranker / DocumentSource 接口
  ingest/
    registry.ts            解析器注册表（按扩展名 / MIME 分派）
    parsers/{markdown,text,docx,xlsx,pdf}.ts
    chunker.ts             结构感知分块 + locator 产出
    embedder.ts            embedding 调用与缓存
    pipeline.ts            摄取编排、增量差异、任务状态
  retrieve/
    keyword.ts             关键词召回（SQLite FTS / Postgres tsvector）
    semantic.ts            语义召回
    fusion.ts              RRF 融合
    rerank.ts              可选重排
    index.ts
  answer/
    gates.ts               三道闸门
    prompt.ts              带引用生成提示词
    generator.ts           流式生成与引用抽取
  feedback/                反馈与 backlog
  store/
    sqlite-vector-store.ts 默认实现
    pgvector-vector-store.ts
```

## 3. 数据模型

新增 Prisma 模型（前缀 `Kb` 以与既有模型区分）：

| 模型 | 关键字段 | 说明 |
|-|-|-|
| `KbKnowledgeBase` | id, name, description, embeddingModel, chunkConfigJson, visibility | 知识库；记录分块与 embedding 配置版本 |
| `KbDocument` | id, kbId, title, sourcePath, sourceUrl, mimeType, sha256, sizeBytes, mtime, parseStatus, parseError, parseVersion | 源文档；`sha256` + `mtime` 是增量同步判据 |
| `KbChunk` | id, kbId, documentId, ordinal, content, contentHash, tokenCount, locatorJson, embeddingModel, embeddingDim, embedding, headingPath | 知识片段；`locatorJson` 承载定位信息 |
| `KbQaPair` | id, kbId, question, answer, contentHash, embedding, tags | 问答对，独立记录类型 |
| `KbIngestJob` | id, kbId, mode(full/incremental), status, statsJson, error, startedAt, finishedAt | 摄取任务与统计 |
| `KbConversation` | id, kbId, sessionKey, siteKey, createdAt | 会话；`siteKey` 标识嵌入站点 |
| `KbMessage` | id, conversationId, role, content, citationsJson, gateDecision, latencyMs, modelId, tokenUsage | 消息；`gateDecision` 记录闸门裁决 |
| `KbFeedback` | id, messageId, rating(up/down), reason, comment, status(open/handled) | 反馈 |
| `KbUnresolvedIssue` | id, kbId, query, reason(no_recall/low_evidence/contradiction/user_downvote), evidenceJson, status, resolvedByQaPairId | 未解决问题 backlog |

`locatorJson` 结构：`{ page?, sheet?, cellRange?, headingPath?, charStart?, charEnd?, blockIndex? }`。定位信息在解析阶段一次产出，后续不得补算。

`vector` 字段在 SQLite 实现下为 `Bytes`（Float32 BLOB）；在 Postgres 实现下由迁移脚本改为 `vector(dim)` 并建 HNSW 索引。两种实现的 `VectorStore` 接口一致。

## 4. 摄取流水线

```text
扫描(DocumentSource) → 过滤(include/exclude) → 判变更(sha256+mtime)
   → [变更] 解析 → 分块(带 locator) → chunk 哈希差集 → [新 chunk] 计算 embedding
   → 事务内 delete-then-insert
```

- **判变更**：`sha256` 未变且 `parseVersion` / `chunkConfigVersion` 未变 → 跳过整篇。
- **分块差异**：文档变更后不再全篇重算 embedding，仅对 `contentHash` 不在旧集合中的 chunk 计算。
- **embedding 缓存**：键为 `(embeddingModel, dim, contentHash)`，跨文档、跨知识库复用。
- **解析**：按注册表分派到 `parsers/*`；失败写入 `parseStatus=error` 与 `parseError`，**不静默跳过**。
- **问答对**：走独立 upsert 路径，不经过解析与分块。

### 4.1 分块策略

采用结构感知分块（structure-aware），而非固定窗口：

- Markdown / docx / PDF：按标题层级与段落边界切分，保留 `headingPath`。
- Excel：按 sheet → 表头 → 数据行分组切分，保留 `sheet` 与 `cellRange`。
- 目标 chunk 尺寸约 400–800 token，相邻 chunk 保留重叠以避免答案被切断。
- 每个 chunk 额外产出：`headingPath`（拼接到正文前作为上下文）、`contentHash`、原文引用的 locator。

## 5. 检索与融合

- **关键词召回**：SQLite 下用 FTS5 虚表；Postgres 下用 `tsvector` + GIN。两者仅实现差异，`Retriever` 接口一致。
- **语义召回**：`EmbeddingProvider` 生成 query 向量，`VectorStore` 取 top-k。
- **融合**：RRF（`k=60`），原因是关键词分与余弦分不可比，RRF 无需归一化即可稳定合并。
- **重排**：可选，配置了 Reranker 时对融合结果重排取 top-n；未配置则按融合顺序截断。
- **降级**：未配置 embedding 或调用失败 → 自动退化为纯关键词模式，功能不中断，并在响应中标注 `retrievalMode`。
- **元数据过滤**：支持按 kbId、标签、时间范围、指定文档集合过滤。

## 6. 三道闸门（拒答的实现核心）

不做「靠 prompt 提示模型说不知道」，而是三道强制门控：

**闸门① 检索闸门** —— 无召回，或融合 / 重排最高分低于阈值 `T_recall` → 判定 `no_evidence`，**直接拒答且不调用 LLM**。此门控同时消除编造可能性与无效 token 成本。

**闸门② 证据闸门** —— 对召回的 top-n 做覆盖度与一致性判定，输出三种态：

- `answerable`：存在高置信、相互一致的证据 → 正常生成。
- `partial`：部分子问题有证据、部分缺失 → 生成时**显式标注已答部分与缺失部分**，并提示可补充的材料。
- `conflict`：多份证据互相矛盾 → 不擅自择一，**并列呈现冲突证据与各自来源**。
- 无有效证据 → `no_evidence`，拒答。

**闸门③ 生成后校验** —— 将答案拆分为 claims，逐条判定 `supported / contradicted / not_covered`，并校验每个 claim 至少绑定一个已召回 chunk：

- 存在 `contradicted` 或无引用的关键 claim → 降级为拒答或改写为「部分可答」。
- 校验复用既有 claim 级忠实度判定逻辑（`src/prompts/result-faithfulness-prompt.ts` 的裁决口径），**不另起一套判定标准**。

每轮问答落 `gateDecision`，使拒答行为可被事后审计与调参。

## 7. 引用与定位

- 引用单元 = `{ chunkId, documentId, documentTitle, locator, snippet, score }`。
- 生成时要求模型输出结构化引用标记，后端按 chunkId 回填真实定位信息，**不接受模型自述的来源**。
- 前端点击引用 → 打开来源文档并定位（PDF 跳页并高亮、Excel 定位 sheet 与单元格、Markdown/txt 定位标题与字符区间）。
- 硬性断言：可回答问题的答案中，无引用支撑的陈述句比例为 0。

## 8. CLI 设计

新增 `agent-insight kb` 子命令，挂载于既有 `bin/cli.js` 的 commands 映射，实现放 `scripts/kb/*.js`，与既有命令保持同一风格。

| 命令 | 作用 |
|-|-|
| `kb create <name>` | 创建知识库 |
| `kb import <kb> <dir>` | 导入目录；`--include` / `--exclude` 支持 glob 选择全部或部分文件 |
| `kb sync <kb>` | 增量同步；`--watch` 交由 `chokidar` 持续监听 |
| `kb ls` / `kb show <kb>` | 查看知识库与文档列表 |
| `kb rm <kb> <doc>` | 删除文档或知识片段 |
| `kb qa add <kb>` | 录入手工问答对 |
| `kb search <kb> <query>` | 直接检索，用于调试与验证 |
| `kb serve` | 启动服务端 |

CLI 与网页调用**同一 service 层**，禁止两套实现；一致性由「同一文档经两条入口产出 chunk 集合相同」的测试断言保证。

## 9. 公开契约与插件

### 9.1 公开 API

面向插件与外部系统，只依赖知识库自身资源，不涉及任何专有接口：

| 路由 | 作用 |
|-|-|
| `POST /api/public/kb/:kbId/chat` | 流式问答（SSE），返回增量文本、引用与闸门裁决 |
| `GET /api/public/kb/:kbId/config` | 插件读取站点配置（标题、欢迎语、主题） |
| `POST /api/public/kb/feedback` | 提交反馈 |
| `GET /api/public/kb/:kbId/documents/:docId` | 引用定位所需的文档访问 |
| `GET /api/public/kb/widget.js` | 插件产物 |

鉴权：站点级 public key（配置在知识库上）+ 域名白名单。public key 只允许调用上述只读 / 问答路由，**不允许**访问管理台、摄取与维护者路由。

管理台路由走既有鉴权体系，路径为 `/api/kb/*`（需登录）。

### 9.2 插件

单文件产物 `kb-widget.js`，集成方式：

```html
<script src="https://<host>/api/public/kb/widget.js"
        data-kb-id="kb_xxx" data-api-key="pk_xxx" data-title="产品助手"></script>
```

- **样式隔离**：全部 DOM 挂载于 Shadow DOM，避免与宿主 CSS 互相污染。
- **流式**：优先 SSE；不支持时退化为 `fetch` + `ReadableStream` 读取。
- **多轮**：会话上下文由服务端按 `conversationId` 维护，插件侧只持有会话标识，避免前端状态丢失导致上下文断裂。
- **兜底**：对严格 CSP 站点提供 iframe 模式（`data-mode="iframe"`）；iframing 只作为备选，不作为主路径（高度、滚动与移动端体验较差）。
- 插件代码中**不得出现** Agent Insight 专有路径、Trace / Run 概念或内部鉴权方式。

## 10. 反馈闭环

- 每条回答记录：query、召回列表与分数、闸门裁决、prompt、模型、耗时、token 用量。
- 服务端识别四类未解决问题并入 backlog：`no_recall` / `low_evidence` / `contradiction` / `user_downvote`。
- 维护者视图：按问题聚类展示知识缺口，可直接在缺口处补录问答对或补充文档段落。
- 闭环验证：对未解决问题补录问答对后，同一问题转为可回答，对应 `KbUnresolvedIssue.status` 转为已处理。

## 11. 通用性边界

- 硬约束：`src/lib/kb/**` 不 import `Execution` / `Trace` / `Run` / `Experiment` / `Skill` 等专有模型。
- Agent Insight 集成为**适配层**：一个 `DocumentSource` 实现（把内部文档视为知识来源）+ 一个页面入口，不修改引擎。
- 门禁：新增静态检查，扫描 `src/lib/kb/**` 中是否出现专有模型标识，出现即失败。
- 验收证据：同一份 `kb-widget.js` 在外部静态测试网页与 Agent Insight 页面表现一致。

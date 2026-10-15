# 通用知识库助手：Phase 3 开发计划

## 1. 实施顺序

按「先证据链、后体验层」推进：先让解析与引用定位这条最难返工的地基跑通，再做插件与管理台，最后收口拒答调参与通用性边界。

1. **地基**：类型契约、`ports.ts` 接口、Prisma 模型与迁移、`VectorStore` 的 SQLite 默认实现。
2. **摄取**：解析器注册表与五种格式解析器、结构感知分块与 `locator` 产出、embedding 缓存、增量差异与任务状态。
3. **检索**：关键词召回、语义召回、RRF 融合、可选重排、降级路径。
4. **回答**：三道闸门、带引用生成、流式接口、引用回填。
5. **入口**：CLI `kb` 子命令；管理台页面与 `/api/kb/*` 路由。
6. **插件**：`kb-widget.js` 打包、公开契约路由、外部测试网页与 Agent Insight 双宿主集成。
7. **闭环**：反馈记录、backlog、维护者复查视图、补录后闭环验证。
8. **收口**：静态解耦门禁、六组验收场景执行、用户指南与开发者指南更新。

## 2. 实现文件

- `prisma/schema.prisma`（新增 `Kb*` 模型）
- `src/lib/kb/types.ts`、`src/lib/kb/ports.ts`、`src/lib/kb/index.ts`
- `src/lib/kb/ingest/{registry,chunker,embedder,pipeline}.ts`
- `src/lib/kb/ingest/parsers/{markdown,text,docx,xlsx,pdf}.ts`
- `src/lib/kb/retrieve/{keyword,semantic,fusion,rerank,index}.ts`
- `src/lib/kb/answer/{gates,prompt,generator}.ts`
- `src/lib/kb/feedback/*`、`src/lib/kb/store/{sqlite-vector-store,pgvector-vector-store}.ts`
- `src/app/api/kb/**`（管理台路由）、`src/app/api/public/kb/**`（公开契约路由与 `widget.js`）
- `src/app/kb/**`（管理台页面）
- `src/widget/kb/**`（插件源码与打包脚本，产物落 `public/`）
- `bin/cli.js`（新增 `kb` 命令映射）、`scripts/kb/*.js`
- `docs/user-guide/knowledge-base/**`、`docs/developer-guide/**` 对应页
- `test/kb/**`（单元、契约、端到端）

插件打包为独立构建产物，不进入 Next.js 应用包；其源码不引用 `src/lib/kb` 之外的应用代码。

## 3. 测试矩阵

| 层 | 场景 |
|-|-|
| 解析单元 | 五种格式各含正常 / 边界样本：含表格 PDF、多 sheet Excel、合并单元格、空文件、损坏文件、超大文件；断言正文与 `locator` 正确 |
| 分块单元 | 标题层级切分、表格不跨 chunk 断裂、重叠窗口、`contentHash` 稳定性（同内容不同路径应同哈希） |
| 增量单元 | 改一段落 → 断言重算 chunk 数远小于全量；改文件名不改内容 → 断言零重算；删文档 → 断言级联清理 |
| 检索单元 | 关键词命中、语义命中、RRF 融合顺序、无 embedding 时降级、元数据过滤 |
| 闸门单元 | 四类输入（有明确证据 / 部分证据 / 无证据 / 冲突证据）分别产出 `answerable / partial / no_evidence / conflict`；断言 `no_evidence` 路径**不产生 LLM 调用** |
| 引用契约 | 答案中每个引用可反查 chunk 与 locator；断言无引用陈述句比例为 0 |
| CLI 单元 | `create / import / sync / ls / show / rm / qa add / search` 各命令行为与退出码 |
| 契约 | 同一文档经 CLI 与经网页入口导入，产出 chunk 集合一致（内容哈希比对） |
| 插件 | 在外部静态测试网页与 Agent Insight 页面各集成一次，断言除站点标识外请求路径与响应行为一致；断言插件网络请求不涉及专有接口 |
| 端到端 | 覆盖六组验收场景（见下） |
| 通用性门禁 | 静态扫描 `src/lib/kb/**` 不得出现专有模型标识 |
| 性能 | 万级 chunk 下检索延迟、增量同步耗时与重算量、流式首字节延迟 |

## 4. 验收矩阵

| 组 | 场景 | 通过判据 |
|-|-|-|
| A 创建与格式 | CLI 导入本地目录；网页上传全部文件；网页选择部分文件；md/txt/docx/xlsx/pdf 各导入一次 | 五种格式正文与定位信息正确；无法解析文件有显式错误记录；`--include` / `--exclude` 生效 |
| B 管理与增量 | 增删改查知识内容；修改源文件触发增量同步；录入问答对 | 查得到内容与来源；重算 chunk 数受限于受影响范围（计数断言）；问答对可被检索命中 |
| C 插件集成 | 外部静态网页集成 + Agent Insight 页面集成 | 两处均完成普通文档问答；行为一致；无专有接口依赖 |
| D 多轮与交互 | 多轮追问、流式输出、悬浮入口与对话框 | 上下文保持；增量呈现；悬浮入口与对话框在桌面与移动端可用 |
| E 依据与拒答 | 有答案 / 跨多文档 / 未覆盖 / 证据冲突 四类问题 | 答案准确；引用可定位；未覆盖问题明确拒答并提示补充；冲突证据并列呈现不擅自择一 |
| F 反馈闭环 | 不认可反馈、无法回答问题记录、维护者复查、补录后复验 | 反馈与未解决问题落库可见；补录知识后同一问题转为可回答 |

量化断言（必须记录数值，不得只报定性结论）：

- 可回答问题中无引用支撑陈述句比例 = 0。
- 拒答率与误拒率同时记录。
- 增量同步重算 chunk 数与全量重建 chunk 数的比值。
- 双宿主插件行为差异集合为空。

## 5. 完成标准

- 六组验收场景均有可重复执行脚本与结果记录。
- 单元、契约、端到端测试通过；`npm run test`、`npm run build`、`npm run lint` 通过；仓库既有失败需与本功能隔离说明。
- 静态解耦门禁通过。
- 用户指南覆盖集成说明（CLI、网页、插件嵌入三段式），开发者指南覆盖架构、契约与扩展方式。
- Git 工作树只包含本功能文件，不提交 API Key、上传的文档样本、向量缓存或构建产物。
- 未经用户进一步授权不 push、不创建 MR、不启动常驻 dev server；需要跑 dev 并做浏览器验证时先询问用户。

## 6. 验证记录

（待开发完成后补充）

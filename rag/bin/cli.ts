/**
 * 命令行入口。
 *
 * 与网页端共用同一个 KnowledgeBaseEngine，不存在两套实现 ——
 * 一致性由「同一文档经两条入口产出相同 chunk 集合」的测试断言保证。
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { KnowledgeBaseEngine, defaultDatabasePath } from '../src/lib/kb/index.js';
import { loadModelProviders, type ModelEnvironment } from '../src/lib/kb/providers/openai-compat.js';
import { loadEnvFiles } from '../src/lib/kb/env-file.js';
import { defaultRegistry } from '../src/lib/kb/ingest/parsers/registry.js';

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const [rawKey, inlineValue] = token.slice(2).split('=');
      const key = rawKey;
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags };
}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function list(value: string | boolean | undefined): string[] | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function openEngine(): { engine: KnowledgeBaseEngine; env: ModelEnvironment } {
  // 加载 .env.local / .env，使 CLI 与服务端读取同一份配置
  loadEnvFiles();
  const env = loadModelProviders();
  const engine = new KnowledgeBaseEngine({
    databasePath: defaultDatabasePath(),
    embedder: env.embedder,
    llm: env.llm,
  });
  return { engine, env };
}

function printModelStatus(env: ModelEnvironment): void {
  const embed = env.embedder ? `${env.embedder.modelId} (dim=${env.embedder.dim})` : '未配置（纯关键词检索）';
  const llm = env.llm ? env.llm.modelId : '未配置（返回检索原文）';
  console.log(`  向量模型：${embed}`);
  console.log(`  生成模型：${llm}`);
}

/** 插件反馈面板的原因 id → 中文标签，便于维护者阅读。 */
const FEEDBACK_REASON_LABELS: Record<string, string> = {
  no_answer: '答非所问',
  incomplete: '信息不完整',
  wrong: '内容有误',
  no_source: '引用不相关',
  outdated: '资料已过时',
};

/** 未解决问题的原因 → 中文标签。 */
const ISSUE_REASON_LABELS: Record<string, string> = {
  no_recall: '完全未召回',
  low_evidence: '证据不足',
  contradiction: '证据冲突',
  user_downvote: '用户点踩',
};

const HELP = `kb-assistant — 通用知识库问答助手
用法：kb <命令> [参数]

命令：
  create <名称>                 创建知识库
                                  --description <说明>
                                  --origins <域名,域名>   允许嵌入的域名白名单
  ls                            列出全部知识库
  show <kb>                     查看知识库详情（文档、问答对、未解决问题）
  import <kb> <目录>            导入本地目录
                                  --include <glob,glob>   只导入匹配的文件
                                  --exclude <glob,glob>   排除匹配的文件
                                  --full                  全量重建（默认增量）
                                  --prune                 清理源中已删除的文档
  sync <kb> <目录>              增量同步（等价于 import 的增量模式）
  docs <kb>                     列出知识库中的文档
  rm <kb> <documentId>          删除文档
  rm-chunk <chunkId>            删除单个知识片段
  qa add <kb>                   录入问答对
                                  --question <问题> --answer <答案> --tags <标签,标签>
  qa ls <kb>                    列出手工问答对
  qa rm <id>                    删除问答对
  search <kb> <查询>            直接检索（调试用）
                                  --top <n>               返回条数（默认 5）
  reindex <kb>                  补算缺失的向量（配置 embedding 后对存量内容执行）
  ask <kb> <问题>               发起一次问答
                                  --conversation <id>     延续多轮对话
  feedback <kb>                 查看反馈与未解决问题
                                  --issues                只列未解决问题
  issues <kb>                   未解决问题总览（按原因分布 + 最近明细）
  issues <kb> close             批量关闭待办（必须指定筛选条件）
                                  --reason <原因>          按原因
                                  --before <日期>          早于该时间
                                  --ids <id,id>            按 id
                                  --handled                标记为已处理（默认 dismissed）
  resolve <kb>                  补录知识并关闭未解决问题（反馈闭环）
                                  --issue <id,id> --question <问题> --answer <答案>
  gaps <kb>                     知识缺口报告（按问题聚类）
  formats                       列出支持的文档格式
  doctor                        配置自检（检查模型配置并实际探测连通性）
  help                          显示本帮助

环境变量（也可写入 .env.local 或 .env 文件）：
  KB_DATABASE_PATH          数据库文件路径（默认 ./data/kb.db）

  — 语义检索（不配置则退化为纯关键词检索）—
  KB_EMBEDDING_MODEL        向量模型名
  KB_EMBEDDING_DIM          向量维度（必填，需与模型一致）
  KB_EMBEDDING_BASE_URL     OpenAI 兼容端点（默认 https://api.openai.com）
  KB_EMBEDDING_API_KEY      密钥
  KB_EMBEDDING_DOC_PREFIX   文档侧指令前缀（E5/BGE 等模型需要）
  KB_EMBEDDING_QUERY_PREFIX 查询侧指令前缀

  — 生成式回答（不配置则返回检索原文）—
  KB_LLM_MODEL              生成模型名
  KB_LLM_BASE_URL           OpenAI 兼容端点
  KB_LLM_API_KEY            密钥
  KB_LLM_TEMPERATURE        采样温度（默认 0.2）
  KB_LLM_MAX_TOKENS         最大输出长度
`;

async function main(): Promise<number> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));

  if (!command || command === 'help' || flags.help) {
    console.log(HELP);
    return 0;
  }

  if (command === 'formats') {
    console.log('支持的文档格式：');
    for (const ext of defaultRegistry.supportedExtensions()) console.log(`  ${ext}`);
    return 0;
  }

  // doctor 需要在打开引擎前就给出配置结论，且要真实探测端点连通性
  if (command === 'doctor') {
    loadEnvFiles();
    const env = loadModelProviders();
    await runDoctor(env);
    return 0;
  }

  const { engine, env } = openEngine();

  try {
    switch (command) {
      case 'create': {
        const name = positionals[0];
        if (!name) throw new Error('用法：kb create <名称>');
        const kb = engine.createKnowledgeBase({
          name,
          description: str(flags.description),
          allowedOrigins: list(flags.origins) ?? [],
        });
        console.log(`已创建知识库：${kb.name}`);
        console.log(`  id：${kb.id}`);
        console.log(`  公开 key：${kb.publicKey}`);
        printModelStatus(env);
        return 0;
      }

      case 'ls': {
        const kbs = engine.listKnowledgeBases();
        if (kbs.length === 0) {
          console.log('尚无知识库，使用 `kb create <名称>` 创建。');
          return 0;
        }
        console.log('名称\t文档\t片段\t问答对\t未解决\tid');
        for (const kb of kbs) {
          const stats = engine.stats(kb.id);
          console.log(
            `${kb.name}\t${stats.documents}\t${stats.chunks}\t${stats.qaPairs}\t${stats.openIssues}\t${kb.id}`,
          );
        }
        return 0;
      }

      case 'show': {
        const kb = requireKb(engine, positionals[0]);
        const stats = engine.stats(kb.id);
        const vectorCount = await engine.vectorCount(kb.id);

        console.log(`知识库：${kb.name}`);
        console.log(`  id：${kb.id}`);
        console.log(`  公开 key：${kb.publicKey ?? '(未生成)'}`);
        console.log(`  允许域名：${kb.allowedOrigins.length ? kb.allowedOrigins.join(', ') : '(未限制)'}`);
        console.log(`  文档：${stats.documents}    片段：${stats.chunks}    向量：${vectorCount}`);
        console.log(`  问答对：${stats.qaPairs}    未解决问题：${stats.openIssues}`);
        printModelStatus(env);

        // 向量数与片段数不匹配时语义检索只覆盖了一部分内容，
        // 这是「明明有文档却检索不到」的常见原因，必须主动提示。
        const expected = stats.chunks + stats.qaPairs;
        if (env.embedder && vectorCount < expected) {
          console.log(
            `\n  ⚠ 向量不完整：应有 ${expected} 条，实际 ${vectorCount} 条。` +
              `\n    语义检索目前只能覆盖已建立向量的部分内容。` +
              `\n    执行 \`kb reindex ${kb.name}\` 补算缺失的向量。`,
          );
        } else if (!env.embedder && stats.chunks > 0) {
          console.log(
            `\n  ⚠ 当前未配置 embedding 模型，检索为纯关键词模式。` +
              `\n    配置模型后执行 \`kb reindex ${kb.name}\` 建立向量索引。`,
          );
        }

        const jobs = engine.listIngestJobs(kb.id, 3);
        if (jobs.length > 0) {
          console.log('\n最近导入任务：');
          for (const job of jobs) {
            const s = job.stats;
            console.log(
              `  [${job.status}] ${job.mode}  ${s ? `新增${s.added} 更新${s.updated} 未变${s.unchanged} 失败${s.failed} 耗时${s.durationMs}ms` : ''}`,
            );
            if (job.error) console.log(`      错误：${job.error}`);
          }
        }
        return 0;
      }

      case 'import':
      case 'sync': {
        const kb = requireKb(engine, positionals[0]);
        const directory = positionals[1];
        if (!directory) throw new Error(`用法：kb ${command} <kb> <目录>`);

        const absDir = resolve(directory);
        if (!existsSync(absDir)) throw new Error(`目录不存在：${absDir}`);

        const include = list(flags.include);
        const exclude = list(flags.exclude);
        console.log(`导入目录：${absDir}`);
        console.log(`  筛选：include=${include?.join(',') ?? '(全部支持格式)'} exclude=${exclude?.join(',') ?? '(无)'}`);

        let lastPhase = '';
        const result = await engine.importDirectory({
          kbId: kb.id,
          directory: absDir,
          include,
          exclude,
          mode: command === 'sync' ? 'incremental' : flags.full ? 'full' : 'incremental',
          pruneMissing: Boolean(flags.prune) || Boolean(flags.full),
          onProgress: (event) => {
            if (event.phase === 'done') return;
            const key = `${event.phase}`;
            if (key !== lastPhase) {
              lastPhase = key;
              console.log(`  [${event.phase}] ${event.detail}`);
            }
          },
        });

        const s = result.stats;
        console.log('\n导入完成：');
        console.log(`  扫描 ${s.scanned}    新增 ${s.added}    更新 ${s.updated}    未变 ${s.unchanged}    删除 ${s.deleted}    失败 ${s.failed}`);
        console.log(`  片段：新建 ${s.chunksCreated}，清理 ${s.chunksDeleted}`);
        console.log(`  向量：计算 ${s.embeddingsComputed}，复用 ${s.embeddingsReused}`);
        console.log(`  耗时：${s.durationMs}ms`);

        if (s.failed > 0) {
          console.log('\n解析失败的文档：');
          for (const doc of engine.listDocuments(kb.id).filter((d) => d.parseStatus === 'error')) {
            console.log(`  ✖ ${doc.title}`);
            console.log(`      ${doc.parseError}`);
          }
          // 失败是可感知的事实，但不作为命令失败返回，便于批量导入时继续处理其余文件
        }
        return 0;
      }

      case 'docs': {
        const kb = requireKb(engine, positionals[0]);
        const docs = engine.listDocuments(kb.id);
        if (docs.length === 0) {
          console.log('该知识库尚无文档。');
          return 0;
        }
        console.log('状态\t片段\t标题\t来源');
        let warningCount = 0;
        for (const doc of docs) {
          // 状态列区分「成功但有告警」，避免把非致命问题读成失败
          const status =
            doc.parseStatus === 'ok'
              ? doc.parseWarnings.length > 0
                ? '⚠'
                : '✓'
              : doc.parseStatus === 'error'
                ? '✖'
                : '…';
          console.log(`${status}\t${doc.chunkCount}\t${doc.title}\t${doc.sourcePath ?? doc.sourceUrl ?? ''}`);

          if (doc.parseStatus === 'error' && doc.parseError) {
            console.log(`\t\t解析失败：${doc.parseError.replace(/\n/g, '\n\t\t        ')}`);
          } else if (doc.parseWarnings.length > 0) {
            warningCount++;
            console.log(`\t\t解析告警（不影响使用，片段已正常建立）：`);
            for (const warning of doc.parseWarnings.slice(0, 4)) console.log(`\t\t  · ${warning}`);
            if (doc.parseWarnings.length > 4) {
              console.log(`\t\t  · …另有 ${doc.parseWarnings.length - 4} 条同类告警`);
            }
          }
        }
        if (warningCount > 0) {
          console.log(`\n提示：${warningCount} 个文档存在解析告警，但内容已成功建立索引，可正常检索。`);
        }
        return 0;
      }

      case 'rm': {
        const kb = requireKb(engine, positionals[0]);
        const docId = positionals[1];
        if (!docId) throw new Error('用法：kb rm <kb> <documentId>');
        const doc = engine.getDocument(docId);
        if (!doc || doc.kbId !== kb.id) throw new Error(`文档不存在于该知识库：${docId}`);
        console.log(engine.deleteDocument(docId) ? `已删除文档：${doc.title}` : '删除失败');
        return 0;
      }

      case 'rm-chunk': {
        const chunkId = positionals[0];
        if (!chunkId) throw new Error('用法：kb rm-chunk <chunkId>');
        console.log(engine.deleteChunk(chunkId) ? `已删除片段：${chunkId}` : '片段不存在');
        return 0;
      }

      case 'qa': {
        const sub = positionals[0];
        if (sub === 'add') {
          const kb = requireKb(engine, positionals[1]);
          const question = str(flags.question);
          const answer = str(flags.answer);
          if (!question || !answer) throw new Error('用法：kb qa add <kb> --question "..." --answer "..."');
          const pair = await engine.addQaPair({
            kbId: kb.id,
            question,
            answer,
            tags: list(flags.tags) ?? [],
          });
          console.log(`已录入问答对：${pair.id}`);
          return 0;
        }
        if (sub === 'ls') {
          const kb = requireKb(engine, positionals[1]);
          const pairs = engine.listQaPairs(kb.id);
          if (pairs.length === 0) {
            console.log('该知识库尚无手工问答对。');
            return 0;
          }
          for (const pair of pairs) {
            console.log(`[${pair.id}]`);
            console.log(`  问：${pair.question}`);
            console.log(`  答：${pair.answer}`);
            if (pair.tags.length) console.log(`  标签：${pair.tags.join(', ')}`);
          }
          return 0;
        }
        if (sub === 'rm') {
          const id = positionals[1];
          if (!id) throw new Error('用法：kb qa rm <id>');
          console.log(engine.deleteQaPair(id) ? `已删除问答对：${id}` : '问答对不存在');
          return 0;
        }
        throw new Error('用法：kb qa <add|ls|rm> ...');
      }

      case 'reindex': {
        const kb = requireKb(engine, positionals[0]);
        if (!env.embedder) {
          console.error('未配置 embedding 模型，无法补算向量。');
          console.error('请先在 .env.local 中设置 KB_EMBEDDING_MODEL 与 KB_EMBEDDING_DIM。');
          return 1;
        }

        const before = await engine.vectorCount(kb.id);
        const total = engine.countChunks(kb.id) + engine.listQaPairs(kb.id).length;
        console.log(`知识库「${kb.name}」`);
        console.log(`  片段+问答对：${total}`);
        console.log(`  当前向量：  ${before}`);
        console.log(`  待补算：    ${total - before}\n`);

        if (total - before === 0) {
          console.log('向量已完整，无需补算。');
          return 0;
        }

        console.log('开始补算（已分批调用 embedding，可中断后重跑）…');
        const result = await engine.backfillEmbeddings(kb.id);

        console.log('\n补算完成：');
        console.log(`  扫描 ${result.scanned}    成功 ${result.computed}    跳过 ${result.skipped}    失败 ${result.failed}`);
        console.log(`  耗时 ${result.durationMs}ms`);
        console.log(`  当前向量：${await engine.vectorCount(kb.id)}`);
        return result.failed > 0 ? 1 : 0;
      }

      case 'search': {
        const kb = requireKb(engine, positionals[0]);
        const query = positionals.slice(1).join(' ');
        if (!query) throw new Error('用法：kb search <kb> <查询>');
        const topK = Number(str(flags.top) ?? 5);

        const result = await engine.retrieve({ kbId: kb.id, query, topK });
        console.log(`检索模式：${result.mode}${result.semanticDegraded ? `（降级：${result.semanticDegradeReason}）` : ''}`);
        console.log(`最高分：${result.topScore.toFixed(4)}    命中：${result.hits.length}    耗时：${result.elapsedMs}ms\n`);

        for (const hit of result.hits) {
          const where = describeLocator(hit.locator);
          console.log(`[${hit.score.toFixed(4)}] ${hit.documentTitle}${where}`);
          console.log(`    ${hit.content.replace(/\n/g, ' ').slice(0, 160)}`);
          console.log(`    chunkId=${hit.chunkId} ranks=${JSON.stringify(hit.ranks)}`);
        }
        return 0;
      }

      case 'ask': {
        const kb = requireKb(engine, positionals[0]);
        const query = positionals.slice(1).join(' ');
        if (!query) throw new Error('用法：kb ask <kb> <问题>');

        const result = await engine.ask({
          kbId: kb.id,
          query,
          conversationId: str(flags.conversation),
        });

        console.log(`裁决：${result.gate.decision}（阶段：${result.gate.stage}）`);
        console.log(`依据：${result.gate.reason}`);
        console.log(`检索：${result.retrieval.mode}，最高分 ${result.retrieval.topScore.toFixed(4)}，命中 ${result.retrieval.hits.length}`);
        console.log(`会话：${result.conversationId}`);
        console.log('\n--- 回答 ---');
        console.log(result.answer);

        if (result.citations.length > 0) {
          console.log('\n--- 引用 ---');
          for (const citation of result.citations) {
            console.log(`[${citation.index}] ${citation.documentTitle}${describeLocator(citation.locator)}`);
            console.log(`    chunkId=${citation.chunkId}`);
          }
        }
        if (result.claimChecks.length > 0) {
          const unsupported = result.claimChecks.filter((check) => check.verdict !== 'supported');
          console.log(`\n校验：${result.claimChecks.length} 条陈述，${unsupported.length} 条无引用支撑`);
          for (const check of unsupported) {
            console.log(`  ⚠ [${check.verdict}] ${check.claim}`);
          }
        }
        return 0;
      }

      case 'feedback': {
        const kb = requireKb(engine, positionals[0]);
        if (flags.issues) {
          const issues = engine.listUnresolvedIssues(kb.id, { status: 'open' });
          if (issues.length === 0) {
            console.log('没有未解决的问题。');
            return 0;
          }
          console.log(`未解决问题（${issues.length}）：`);
          for (const issue of issues) {
            console.log(`\n[${issue.id}] ${issue.reason}  ${issue.createdAt}`);
            console.log(`  问题：${issue.query}`);
            const evidence = issue.evidence as Record<string, unknown>;
            if (evidence.topScore !== undefined) {
              console.log(`  检索：${evidence.retrievalMode} 最高分 ${Number(evidence.topScore).toFixed(4)} 命中 ${evidence.hitCount}`);
            }
          }
          return 0;
        }

        const feedbackList = engine.listFeedback({ limit: 50 });
        const issues = engine.listUnresolvedIssues(kb.id, { status: 'open' });
        const stats = engine.feedbackStats(kb.id);

        // 先给概览，再看明细：维护者通常先关心「有多少要处理」
        console.log(
          `反馈：👍 ${stats.up}    👎 ${stats.down}（待处理 ${stats.open}，已处理 ${stats.handled}）`,
        );
        console.log(`未解决问题：${issues.length}\n`);

        if (feedbackList.length === 0) {
          console.log('尚无反馈记录。');
          return 0;
        }

        for (const item of feedbackList) {
          const icon = item.rating === 'up' ? '👍' : '👎';
          console.log(`${icon} [${item.status}] ${item.createdAt}`);
          // 原因来自插件的原因面板，翻译成中文便于维护者快速归类
          if (item.reason) {
            const labels = item.reason
              .split(',')
              .map((id) => FEEDBACK_REASON_LABELS[id.trim()] ?? id.trim())
              .join('、');
            console.log(`   原因：${labels}`);
          }
          if (item.comment) console.log(`   说明：${item.comment}`);
          console.log(`   id=${item.id}  messageId=${item.messageId}`);
        }

        if (stats.open > 0) {
          console.log(`\n提示：用 \`kb feedback ${kb.name} --handle <feedbackId>\` 标记已处理。`);
        }
        return 0;
      }

      case 'issues': {
        // 待办的独立入口：查看分布、按条件批量关闭
        const kb = requireKb(engine, positionals[0]);
        const sub = positionals[1];

        if (sub === 'close' || flags.close) {
          const ids = list(flags.ids);
          const reason = str(flags.reason);
          const before = str(flags.before);

          if (!ids && !reason && !before) {
            console.error('必须指定筛选条件，避免误关全部待办。');
            console.error('用法示例：');
            console.error(`  kb issues ${kb.name} close --reason low_evidence --before 2026-10-14`);
            console.error(`  kb issues ${kb.name} close --ids iss_xxx,iss_yyy`);
            return 1;
          }

          const count = engine.closeIssues(kb.id, {
            ids,
            reason: reason as never,
            before,
            status: flags.handled ? 'handled' : 'dismissed',
          });
          console.log(`已关闭 ${count} 条待办（状态：${flags.handled ? 'handled' : 'dismissed'}）`);
          return 0;
        }

        const distribution = engine.countIssuesByReason(kb.id, 'open');
        const total = distribution.reduce((sum, item) => sum + item.count, 0);

        console.log(`知识库「${kb.name}」未解决问题：${total}`);
        if (total === 0) return 0;

        console.log('\n按原因分布：');
        for (const item of distribution) {
          console.log(`  ${ISSUE_REASON_LABELS[item.reason] ?? item.reason}（${item.reason}）  ${item.count}`);
        }

        const issues = engine.listUnresolvedIssues(kb.id, { status: 'open', limit: 30 });
        console.log(`\n最近 ${issues.length} 条：`);
        for (const issue of issues) {
          const evidence = issue.evidence as Record<string, unknown>;
          const tag = ISSUE_REASON_LABELS[issue.reason] ?? issue.reason;
          console.log(`\n[${issue.id}] ${tag}  ${issue.createdAt.slice(0, 19)}`);
          console.log(`  问题：${issue.query}`);
          if (evidence.feedbackReason) {
            const labels = String(evidence.feedbackReason)
              .split(',')
              .map((id) => FEEDBACK_REASON_LABELS[id.trim()] ?? id.trim())
              .join('、');
            console.log(`  用户反馈：${labels}`);
          }
          if (evidence.comment) console.log(`  用户说明：${evidence.comment}`);
        }

        console.log('\n清理示例：');
        console.log(`  kb issues ${kb.name} close --reason low_evidence --before <日期>`);
        return 0;
      }

      case 'gaps': {
        const kb = requireKb(engine, positionals[0]);
        const report = engine.knowledgeGapReport(kb.id);
        console.log(`未解决问题总数：${report.total}`);
        if (report.total === 0) {
          console.log('当前没有知识缺口。');
          return 0;
        }
        console.log('\n按原因分布：');
        for (const [reason, count] of Object.entries(report.byReason)) {
          console.log(`  ${reason}: ${count}`);
        }
        console.log('\n高频未解决问题：');
        for (const item of report.topQueries) {
          console.log(`  ×${item.count}  ${item.query}`);
          console.log(`        原因：${item.reasons.join(', ')}    可处理 id：${item.ids.join(',')}`);
        }
        return 0;
      }

      case 'resolve': {
        const kb = requireKb(engine, positionals[0]);
        const issueIds = list(flags.issue);
        const question = str(flags.question);
        const answer = str(flags.answer);
        if (!issueIds || !question || !answer) {
          throw new Error(
            '用法：kb resolve <kb> --issue "<id,id>" --question "..." --answer "..."\n' +
              '提示：先运行 `kb gaps <kb>` 获取待处理的 issue id。',
          );
        }

        const result = await engine.resolveIssueWithQaPair({
          kbId: kb.id,
          issueIds,
          question,
          answer,
        });
        console.log(`已补录问答对：${result.qaPair.id}`);
        console.log(`已关闭未解决问题：${result.resolvedCount} 条`);

        // 立即复验：同一个问题现在应当可被检索命中
        const verify = await engine.retrieve({ kbId: kb.id, query: question, topK: 3 });
        const hit = verify.hits.some((item) => item.kind === 'qa');
        console.log(`\n复验：以原问题检索 → ${hit ? '✓ 已命中补录的问答对' : '✖ 未命中，请检查问题措辞'}`);
        return hit ? 0 : 1;
      }

      default:
        console.error(`未知命令：${command}\n`);
        console.log(HELP);
        return 1;
    }
  } finally {
    engine.close();
  }
}

/**
 * 配置自检。
 *
 * 只检查「变量是否设置」是不够的：key 过期、端点写错、维度不匹配都会在
 * 真正用的时候才暴露。因此这里实际发一次请求做探测。
 */
async function runDoctor(env: ModelEnvironment): Promise<void> {
  const envFiles = loadEnvFiles();

  console.log('配置自检');
  console.log('='.repeat(52));
  console.log(`配置文件：${envFiles.loaded.length ? envFiles.loaded.join(', ') : '未找到 .env.local / .env'}`);
  console.log(`数据库：  ${defaultDatabasePath()}`);

  console.log('\n模型能力：');
  if (env.embedder) {
    console.log('  ✔ 语义检索已启用');
    console.log(`      模型：${env.embedder.modelId}`);
    console.log(`      维度：${env.embedder.dim}`);
    console.log(`      端点：${process.env.KB_EMBEDDING_BASE_URL ?? 'https://api.openai.com'}`);
  } else {
    console.log('  ✖ 语义检索未启用 —— 检索将退化为纯关键词模式');
  }

  if (env.llm) {
    console.log('  ✔ 生成式回答已启用');
    console.log(`      模型：${env.llm.modelId}`);
    console.log(`      端点：${process.env.KB_LLM_BASE_URL ?? 'https://api.openai.com'}`);
  } else {
    console.log('  ✖ 生成式回答未启用 —— 将返回检索到的原文片段');
  }

  console.log('\n连通性探测：');

  if (env.embedder) {
    try {
      const started = Date.now();
      const vector = await env.embedder.embedQuery('连通性探测');
      const ok = vector.length === env.embedder.dim;
      console.log(
        `  ${ok ? '✔' : '✖'} embedding 调用成功（${Date.now() - started}ms，返回 ${vector.length} 维）`,
      );
      if (!ok) {
        console.log(`      维度不匹配：期望 ${env.embedder.dim}，实际 ${vector.length}。请修正 KB_EMBEDDING_DIM`);
      }
    } catch (error) {
      console.log(`  ✖ embedding 调用失败：${(error as Error).message}`);
    }
  } else {
    console.log('  – 跳过 embedding 探测（未配置）');
  }

  if (env.llm) {
    try {
      const started = Date.now();
      const result = await env.llm.complete([{ role: 'user', content: '回复"ok"两个字符即可' }], {
        maxTokens: 16,
      });
      console.log(`  ✔ 生成模型调用成功（${Date.now() - started}ms）：${JSON.stringify(result.text.slice(0, 40))}`);
    } catch (error) {
      console.log(`  ✖ 生成模型调用失败：${(error as Error).message}`);
    }
  } else {
    console.log('  – 跳过生成模型探测（未配置）');
  }

  if (env.notes.length > 0) {
    console.log('\n说明：');
    for (const note of env.notes) console.log(`  · ${note}`);
    console.log('\n配置方法见 docs/integration.md，或直接创建 .env.local 文件。');
  }
}

function requireKb(engine: KnowledgeBaseEngine, nameOrId: string | undefined) {  if (!nameOrId) throw new Error('缺少知识库名称或 id');
  const kb = engine.getKnowledgeBase(nameOrId);
  if (!kb) throw new Error(`知识库不存在：${nameOrId}（用 \`kb ls\` 查看）`);
  return kb;
}

function describeLocator(locator: {
  page?: number;
  pageEnd?: number;
  sheet?: string;
  cellRange?: string;
  headingPath?: string[];
  lineStart?: number;
  lineEnd?: number;
}): string {
  const parts: string[] = [];
  if (locator.page !== undefined) {
    parts.push(locator.pageEnd && locator.pageEnd !== locator.page ? `第${locator.page}-${locator.pageEnd}页` : `第${locator.page}页`);
  }
  if (locator.sheet) parts.push(`工作表「${locator.sheet}」`);
  if (locator.cellRange) parts.push(locator.cellRange);
  if (locator.headingPath?.length) parts.push(locator.headingPath.join(' > '));
  if (locator.lineStart !== undefined) {
    parts.push(
      locator.lineEnd && locator.lineEnd !== locator.lineStart
        ? `第${locator.lineStart}-${locator.lineEnd}行`
        : `第${locator.lineStart}行`,
    );
  }
  return parts.length > 0 ? `（${parts.join('，')}）` : '';
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

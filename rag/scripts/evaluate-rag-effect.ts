/**
 * Run the versioned RAG golden set with deterministic providers.
 *
 * This measures retrieval/citation/gate contracts without requiring external
 * model credentials. Replace the fixture documents and providers with a real
 * corpus/model for production-quality answer evaluation.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { KnowledgeBaseEngine } from '../src/lib/kb/index.ts';
import type { EmbeddingProvider, LlmMessage, LlmOptions, LlmProvider } from '../src/lib/kb/ports.ts';

type Case = {
  id: string;
  category: string;
  query: string;
  expectedDecision: 'answerable' | 'partial' | 'conflict' | 'no_evidence';
  requiredTerms: string[];
  requiredDocuments: string[];
};

type CaseResult = {
  id: string;
  category: string;
  pass: boolean;
  decision: string;
  expectedDecision: string;
  citations: number;
  citedDocuments: string[];
  retrievalDocuments: string[];
  retrievalSnippets: string[];
  requiredTermsCovered: boolean;
  requiredDocumentsCovered: boolean;
  unsupportedClaimCount: number;
  latencyMs: number;
  failure?: string;
};

class DeterministicEmbedder implements EmbeddingProvider {
  readonly modelId = 'golden-fake-embed';
  readonly dim = 96;

  private vector(text: string): Float32Array {
    const result = new Float32Array(this.dim);
    for (const char of text.toLowerCase()) result[char.codePointAt(0)! % this.dim] += 1;
    let norm = 0;
    for (const value of result) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (let index = 0; index < result.length; index += 1) result[index] /= norm;
    return result;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(text => this.vector(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.vector(text);
  }
}

class DeterministicLlm implements LlmProvider {
  readonly modelId = 'golden-fake-llm';
  private readonly decisions: Map<string, Case>;

  constructor(cases: Case[]) {
    this.decisions = new Map(cases.map(item => [item.query, item]));
  }

  async complete(messages: LlmMessage[], _options?: LlmOptions) {
    const system = messages.find(message => message.role === 'system')?.content ?? '';
    const user = messages.find(message => message.role === 'user')?.content ?? '';
    // Prefer the longest case first: a shorter golden query can be a prefix of
    // a compound query (for example the conflict case includes the plain
    // database-port question).
    const query = [...this.decisions.keys()].sort((a, b) => b.length - a.length).find(item => user.includes(item)) ?? '';
    const item = this.decisions.get(query);

    if (system.includes('证据充分性判定器')) {
      if (item?.expectedDecision === 'conflict') {
        return {
          text: JSON.stringify({
            decision: 'conflict',
            reason: '测试集明确要求验证新旧资料冲突',
            conflicts: [{ topic: '数据库端口', claims: [{ text: '新版端口为 5432', citations: [1] }, { text: '旧版端口为 3306', citations: [2] }] }],
          }),
          usage: { input: 100, output: 80 },
        };
      }
      if (item?.expectedDecision === 'partial') {
        return { text: JSON.stringify({ decision: 'partial', reason: '只覆盖问题的一部分', missing: ['问题中未提供的部分'] }), usage: { input: 100, output: 40 } };
      }
      if (item?.expectedDecision === 'no_evidence') {
        return { text: JSON.stringify({ decision: 'no_evidence', reason: '测试集要求知识库未覆盖时拒答', missing: [] }), usage: { input: 100, output: 30 } };
      }
      return { text: JSON.stringify({ decision: 'answerable', reason: '测试片段覆盖问题', missing: [] }), usage: { input: 100, output: 30 } };
    }

    if (system.includes('忠实度校验器')) {
      return { text: JSON.stringify({ claims: [] }), usage: { input: 100, output: 20 } };
    }

    const blocks = [...user.matchAll(/\[(\d+)\][^\n]*\n([\s\S]*?)(?=\n\n---|$)/g)];
    const answer = blocks.slice(0, 6).map(block => `${block[2].replace(/\s+/g, ' ').trim()} [${block[1]}]`).join('\n\n');
    return { text: answer || '没有足够的资料。', usage: { input: 100, output: 80 } };
  }

  async *stream(messages: LlmMessage[], options?: LlmOptions): AsyncIterable<string> {
    const result = await this.complete(messages, options);
    yield result.text;
  }
}

function seedDocuments(directory: string): void {
  const documents: Record<string, string> = {
    'deploy.md': '# 部署手册\n\n## 端口配置\n\n服务默认监听端口为 3000，可以通过配置文件修改。\n\n## 数据库\n\n数据库默认端口是 5432，连接池上限为 20。\n',
    'ops.md': '# 运维手册\n\n## 日志\n\n日志默认保留 30 天，存放于 /var/log/kb 目录。\n',
    'billing.md': '# 退款政策\n\n购买后 7 天内可以无理由退款，超过 7 天不予退款。\n\n退款申请需要提供订单号。\n',
    'security.md': '# 安全规范\n\n所有敏感信息必须存储在密钥管理服务中。\n\n审计日志保留 180 天。\n',
    'legacy.md': '# 数据库端口说明（旧版）\n\n数据库默认端口是 3306。\n注意：本条记录来自旧版文档，与新版不一致。\n',
  };
  for (const [name, content] of Object.entries(documents)) writeFileSync(join(directory, name), content, 'utf8');
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

async function main(): Promise<void> {
  const cases = JSON.parse(readFileSync(resolve('evaluation/golden-set.json'), 'utf8')) as Case[];
  const workDir = mkdtempSync(join(tmpdir(), 'rag-golden-evaluation-'));
  const docsDir = join(workDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  const engine = new KnowledgeBaseEngine({
    databasePath: join(workDir, 'kb.db'),
    embedder: new DeterministicEmbedder(),
    llm: new DeterministicLlm(cases),
  });

  try {
    seedDocuments(docsDir);
    const kb = engine.createKnowledgeBase({ name: 'golden-evaluation' });
    await engine.importDirectory({ kbId: kb.id, directory: docsDir, include: ['*.md'] });

    const results: CaseResult[] = [];
    for (const item of cases) {
      const started = Date.now();
      const answer = await engine.ask({ kbId: kb.id, query: item.query, claimCheck: true });
      const citedDocuments = new Set(answer.citations.map(citation => citation.documentTitle));
      const requiredTermsCovered = item.requiredTerms.every(term => answer.answer.includes(term) || answer.citations.some(citation => citation.snippet.includes(term)));
      const requiredDocumentsCovered = item.requiredDocuments.every(document => citedDocuments.has(document));
      const pass = answer.gate.decision === item.expectedDecision
        && requiredTermsCovered
        && requiredDocumentsCovered
        && (item.expectedDecision === 'no_evidence' ? answer.citations.length === 0 : answer.citations.length > 0);
      results.push({
        id: item.id,
        category: item.category,
        pass,
        decision: answer.gate.decision,
        expectedDecision: item.expectedDecision,
        citations: answer.citations.length,
        citedDocuments: [...citedDocuments],
        retrievalDocuments: answer.retrieval.hits.map(hit => hit.documentTitle),
        retrievalSnippets: answer.retrieval.hits.map(hit => hit.content.slice(0, 120)),
        requiredTermsCovered,
        requiredDocumentsCovered,
        unsupportedClaimCount: answer.unsupportedClaimCount,
        latencyMs: Date.now() - started,
        ...(pass ? {} : { failure: answer.answer.slice(0, 160) }),
      });
    }

    const latencies = results.map(result => result.latencyMs);
    const passed = results.filter(result => result.pass).length;
    const output = {
      generatedAt: new Date().toISOString(),
      dataset: 'evaluation/golden-set.json',
      providerMode: 'deterministic-fixture',
      summary: {
        total: results.length,
        passed,
        failed: results.length - passed,
        passRate: results.length ? passed / results.length : 0,
        p50LatencyMs: percentile(latencies, 0.5),
        p95LatencyMs: percentile(latencies, 0.95),
        citationCoverage: results.length ? results.filter(result => result.requiredDocumentsCovered).length / results.length : 0,
        refusalAccuracy: results.filter(result => result.expectedDecision === 'no_evidence').length
          ? results.filter(result => result.expectedDecision === 'no_evidence' && result.pass).length / results.filter(result => result.expectedDecision === 'no_evidence').length
          : 0,
      },
      results,
    };
    console.log(JSON.stringify(output, null, 2));
    if (output.summary.failed > 0) process.exitCode = 1;
  } finally {
    engine.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();

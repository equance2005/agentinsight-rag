import { createHmac, randomUUID } from 'node:crypto';
import { createAgentDatasetRecord, findAgentDataset, normalizeCase, updateAgentDatasetRecord, type AgentDatasetRecord, type DatasetField } from '@/server/agent_datasets_storage';
import { readUserCustomEvaluators, writeUserCustomEvaluators } from '@/server/user_evaluators_storage';
import { syncCustomEvaluatorRegisteredAgents } from '@/lib/engine/evaluation/custom-llm-evaluator';
import { db } from '@/lib/storage/prisma';
import type { CopilotContextResult, WorkflowInput, WorkflowPreview } from './contracts';

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const secret = () => process.env.COPILOT_PREVIEW_SECRET || process.env.AUTH_SECRET || 'agent-insight-copilot-preview-dev-secret';

function sign(value: string): string {
  return createHmac('sha256', secret()).update(value).digest('base64url');
}

function token(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function decode(value: string): Record<string, unknown> {
  const [body, signature] = value.split('.');
  if (!body || !signature || sign(body) !== signature) throw new Error('确认令牌无效');
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (Number(parsed.expiresAt || 0) < Date.now()) throw new Error('预览已过期，请重新生成');
  return parsed;
}

export function buildTraceDatasetPreview(context: CopilotContextResult, input: WorkflowInput): WorkflowPreview {
  if (context.envelope.objectType !== 'execution' && context.envelope.objectType !== 'task') throw new Error('当前页面不是可回流的 Trace');
  const facts = context.facts as { executionId?: string; taskId?: string; query?: string; actualOutput?: string; interactions?: unknown[] };
  const taskId = String(facts.taskId || facts.executionId || '');
  const executionId = String(facts.executionId || '') || undefined;
  if (!taskId) throw new Error('当前 Trace 没有稳定 taskId');
  const missing = [] as string[];
  if (!String(input.referenceOutput || '').trim() && !String(facts.actualOutput || '').trim()) missing.push('参考答案/预期输出待补充');
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const changes = {
    fields: [
      { key: 'input', label: '输入', type: 'text', source: 'input' },
      { key: 'reference_output', label: '预期输出', type: 'text', source: 'output' },
      { key: 'trajectory', label: '轨迹', type: 'json', source: 'trace' },
    ],
    case: {
      input: String(facts.query || ''),
      expectedOutput: String(input.referenceOutput || facts.actualOutput || ''),
      trajectory: facts.interactions || [],
      traceSource: { taskId, executionId, capturedAt: new Date().toISOString() },
    },
  };
  const previewId = randomUUID();
  const confirmationToken = token({ previewId, user: context.envelope.user, action: 'trace_to_dataset', expiresAt, changes });
  return {
    previewId,
    action: 'trace_to_dataset',
    target: input.datasetId || input.datasetName || '待选择数据集',
    changes,
    sources: context.sources.map(({ content: _content, ...source }) => source),
    missing,
    expiresAt: new Date(expiresAt).toISOString(),
    confirmationToken,
  };
}

export async function confirmTraceDataset(user: string, previewToken: string, input: WorkflowInput): Promise<{ datasetId: string; caseId: string; inserted: boolean }> {
  const payload = decode(previewToken);
  if (payload.user !== user || payload.action !== 'trace_to_dataset') throw new Error('确认令牌与当前用户或操作不匹配');
  const changes = payload.changes as { fields: DatasetField[]; case: Record<string, unknown> };
  const existing = input.datasetId ? await findAgentDataset(user, input.datasetId) : null;
  if (input.datasetId && !existing) throw new Error('目标数据集不存在或无权访问');
  const caseValue = normalizeCase({
    id: randomUUID(),
    input: String(changes.case.input || ''),
    expectedOutput: String(input.referenceOutput || changes.case.expectedOutput || ''),
    evaluationFocus: '', tags: ['copilot-trace'],
    trajectory: JSON.stringify(changes.case.trajectory || []), values: changes.case,
    source: 'trace-backflow', traceSource: changes.case.traceSource,
  });
  const now = new Date().toISOString();
  if (existing) {
    const duplicate = existing.cases.find(item => item.traceSource?.taskId === caseValue.traceSource?.taskId);
    if (duplicate) return { datasetId: existing.id, caseId: duplicate.id, inserted: false };
    const updated: AgentDatasetRecord = { ...existing, cases: [...existing.cases, caseValue], updatedAt: now };
    await updateAgentDatasetRecord(updated);
    return { datasetId: existing.id, caseId: caseValue.id, inserted: true };
  }
  const dataset: AgentDatasetRecord = {
    id: randomUUID(), user, name: input.datasetName || 'Copilot Trace 样例', description: '由 Agent Insight Copilot 预览确认创建',
    targetAgent: '', targetSkill: '', tags: ['copilot-trace'], fields: changes.fields, cases: [caseValue], datasetKind: 'trajectory', createdAt: now, updatedAt: now,
  };
  await createAgentDatasetRecord(dataset);
  return { datasetId: dataset.id, caseId: caseValue.id, inserted: true };
}

export function buildEvaluatorPreview(context: CopilotContextResult, input: WorkflowInput): WorkflowPreview {
  if (!input.evaluatorName?.trim() || !input.instructions?.trim()) throw new Error('评估器名称和评估说明都必须填写');
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const changes = {
    evaluator: {
      id: `custom-${randomUUID()}`,
      name: input.evaluatorName.trim(),
      description: input.instructions.trim(),
      evaluatorType: 'LLM', source: 'custom', category: 'res', targetTypes: ['agent'],
      objectives: [input.instructions.trim()], scenarios: [], runMode: 'Copilot 草稿', scoreRange: '0-100', popularity: 0,
      mappedMetrics: [], status: 'draft', llmConfig: {
        model: '当前用户模型',
        systemPrompt: '根据输入、实际输出与参考输出判断评估结果。必须引用给定证据，不得补造缺失事实。',
        userPrompt: `{{input}}\n\n实际输出：{{output}}\n\n参考输出：{{reference_output}}\n\n评估要求：${input.instructions.trim()}`,
      },
    },
  };
  const previewId = randomUUID();
  const confirmationToken = token({ previewId, user: context.envelope.user, action: 'evaluator_draft', expiresAt, changes });
  return {
    previewId, action: 'evaluator_draft', target: input.evaluatorName.trim(), changes,
    sources: context.sources.map(({ content: _content, ...source }) => source),
    missing: ['评估器草稿需要用户确认评分标准与输入字段'], expiresAt: new Date(expiresAt).toISOString(), confirmationToken,
  };
}

export async function confirmEvaluatorDraft(user: string, previewToken: string): Promise<{ evaluatorId: string; inserted: boolean }> {
  const payload = decode(previewToken);
  if (payload.user !== user || payload.action !== 'evaluator_draft') throw new Error('确认令牌与当前用户或操作不匹配');
  const card = (payload.changes as { evaluator: Record<string, unknown> }).evaluator;
  const existing = await readUserCustomEvaluators(user) as Array<Record<string, unknown>>;
  const sameName = existing.find(item => item.name === card.name);
  if (sameName?.id) return { evaluatorId: String(sameName.id), inserted: false };
  await writeUserCustomEvaluators(user, [...existing, card]);
  await syncCustomEvaluatorRegisteredAgents(user, [...existing, card] as any);
  return { evaluatorId: String(card.id), inserted: true };
}

export async function buildRunFilterPreview(context: CopilotContextResult, input: WorkflowInput): Promise<WorkflowPreview> {
  const query = String(input.instructions || '').trim();
  if (!query) throw new Error('请提供运行筛选条件');
  const tokens = query.toLowerCase().split(/\s+/).filter(item => item.length >= 2).slice(0, 8);
  const rows = await db.findExecutions({ user: context.envelope.user }, { timestamp: 'desc' });
  const matches = rows.filter((row: any) => {
    const haystack = [row.query, row.finalResult, row.agentName, row.framework, row.skill, row.model, row.taskId]
      .map(value => String(value || '').toLowerCase()).join('\n');
    return tokens.every(token => haystack.includes(token));
  }).slice(0, 30).map((row: any) => ({
    executionId: row.id,
    taskId: row.taskId,
    timestamp: row.timestamp,
    agent: row.agentName || row.agent,
    framework: row.framework,
    model: row.model,
    status: row.traceStatus || row.status || null,
  }));
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const changes = { query, count: matches.length, matches };
  const previewId = randomUUID();
  const confirmationToken = token({ previewId, user: context.envelope.user, action: 'run_filter', expiresAt, changes });
  return { previewId, action: 'run_filter', target: '运行列表', changes, sources: [], missing: [], expiresAt: new Date(expiresAt).toISOString(), confirmationToken };
}

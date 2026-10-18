import { createHmac, randomUUID } from 'node:crypto';
import { createAgentDatasetRecord, deleteAgentDataset, findAgentDataset, normalizeCase, readUserAgentDatasets, updateAgentDatasetRecord, type AgentDatasetRecord, type DatasetField } from '@/server/agent_datasets_storage';
import { readUserCustomEvaluators, writeUserCustomEvaluators } from '@/server/user_evaluators_storage';
import { syncCustomEvaluatorRegisteredAgents } from '@/lib/engine/evaluation/custom-llm-evaluator';
import { db } from '@/lib/storage/prisma';
import { prismaRaw } from '@/lib/storage/prisma';
import { startExperimentRun } from '@/lib/engine/experiment/run-experiment';
import { publishWorkbenchSnapshot, publishOptimizationCandidate } from '@/lib/skill-workbench/publish-service';
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

export async function buildDatasetCreatePreview(context: CopilotContextResult, input: WorkflowInput): Promise<WorkflowPreview> {
  const name = String(input.datasetName || '').trim() || 'Copilot 评测数据集';
  const instructions = String(input.instructions || '').trim();
  const knownDatasets = Array.isArray((context.facts as { datasets?: unknown }).datasets)
    ? (context.facts as { datasets: Array<{ id: string; name: string; description?: string; datasetKind?: string; caseCount?: number; fields?: DatasetField[] }> }).datasets
    : [];
  const template = knownDatasets.find(dataset => (
    (instructions && instructions.includes(dataset.name))
      || (/messages\s*日志分析|日志分析.*内置示例/i.test(instructions) && /messages\s*日志分析/i.test(dataset.name))
  ));
  const kindOptions = [
    { kind: 'ideal_output', label: '理想输出评测集', description: '包含输入和理想输出', fields: [{ key: 'input', label: '输入', type: 'text' }, { key: 'reference_output', label: '预期输出', type: 'text' }] },
    { kind: 'trajectory', label: '轨迹评测集', description: 'Agent 运行轨迹评测', fields: [{ key: 'input', label: '输入', type: 'text' }, { key: 'reference_output', label: '预期输出', type: 'text' }, { key: 'trajectory', label: '轨迹', type: 'json' }] },
    { kind: 'reliability', label: '可靠性评测集', description: '含故障注入类型字段', fields: [{ key: 'input', label: '输入', type: 'text' }, { key: 'fault_injection_type', label: '故障注入类型', type: 'text' }, { key: 'reference_output', label: '预期输出', type: 'text' }] },
  ] as const;
  const selectedKind = input.datasetKind || template?.datasetKind || 'ideal_output';
  const selectedOption = kindOptions.find(option => option.kind === selectedKind) || kindOptions[0];
  const fields = template?.fields?.length && !input.datasetKind
    ? template.fields.map(field => ({ ...field }))
    : selectedOption.fields.map(field => ({ ...field }));
  const description = template
    ? `参照「${template.name}」的字段结构创建空数据集，暂不复制 Case。`
    : '由 Agent Insight Copilot 创建，可继续录入评测样例。';
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const changes = {
    dataset: {
      name,
      description,
      datasetKind: selectedKind,
      kindOptions,
      fields,
      caseCount: 0,
      template: template ? {
        id: template.id,
        name: template.name,
        caseCount: template.caseCount || 0,
        description: template.description || '',
      } : null,
    },
  };
  const previewId = randomUUID();
  const confirmationToken = token({ previewId, user: context.envelope.user, action: 'dataset_create', expiresAt, changes });
  return {
    previewId,
    action: 'dataset_create',
    target: name,
    changes,
    sources: template
      ? context.sources.filter(source => source.kind === 'dataset-list').map(({ content: _content, ...source }) => source)
      : [],
    missing: [],
    expiresAt: new Date(expiresAt).toISOString(),
    confirmationToken,
  };
}

export async function confirmDatasetCreate(user: string, previewToken: string, input: WorkflowInput = {}): Promise<{ datasetId: string; inserted: boolean }> {
  const payload = decode(previewToken);
  if (payload.user !== user || payload.action !== 'dataset_create') throw new Error('确认令牌与当前用户或操作不匹配');
  const dataset = (payload.changes as { dataset?: { name?: string; description?: string; datasetKind?: string; fields?: DatasetField[]; kindOptions?: Array<{ kind: string; fields: DatasetField[] }> } }).dataset;
  const name = String(dataset?.name || '').trim();
  if (!name) throw new Error('确认令牌缺少数据集名称');
  const existing = (await readUserAgentDatasets(user)).find(item => item.name === name);
  if (existing) return { datasetId: existing.id, inserted: false };
  const selectedKind = input.datasetKind || dataset?.datasetKind || 'ideal_output';
  const selectedOption = dataset?.kindOptions?.find(option => option.kind === selectedKind);
  const now = new Date().toISOString();
  const record: AgentDatasetRecord = {
    id: randomUUID(),
    user,
    name,
    description: String(dataset?.description || ''),
    targetAgent: '',
    targetSkill: '',
    tags: ['copilot'],
    fields: selectedOption?.fields || (Array.isArray(dataset?.fields) ? dataset.fields : []),
    cases: [],
    datasetKind: selectedKind === 'trajectory' || selectedKind === 'reliability' ? selectedKind : 'ideal_output',
    createdAt: now,
    updatedAt: now,
  };
  await createAgentDatasetRecord(record);
  return { datasetId: record.id, inserted: true };
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
    missing: [], expiresAt: new Date(expiresAt).toISOString(), confirmationToken,
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

export async function buildEvaluatorDeletePreview(context: CopilotContextResult, input: WorkflowInput): Promise<WorkflowPreview> {
  const requestedId = String(input.evaluatorId || '').trim();
  const requestedName = String(input.evaluatorName || '').trim();
  const evaluators = await readUserCustomEvaluators(context.envelope.user) as Array<Record<string, unknown>>;
  const matches = evaluators.filter(item => {
    const id = String(item.id || '').trim();
    const name = String(item.name || '').trim();
    return requestedId ? id === requestedId : requestedName ? name === requestedName : false;
  });
  if (matches.length > 1) throw new Error(`找到多个匹配的自定义评估器，请使用 evaluatorId 指定目标`);
  const evaluator = matches[0];
  if (!evaluator) throw new Error(requestedName ? `未找到名为「${requestedName}」的自定义评估器` : '请先说明要删除的自定义评估器名称');
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const changes = {
    evaluatorId: String(evaluator.id || ''),
    name: String(evaluator.name || ''),
    evaluatorType: String(evaluator.evaluatorType || 'LLM'),
    destructive: true,
  };
  const previewId = randomUUID();
  const confirmationToken = token({ previewId, user: context.envelope.user, action: 'evaluator_delete', expiresAt, changes });
  return {
    previewId,
    action: 'evaluator_delete',
    target: String(evaluator.name || evaluator.id || '自定义评估器'),
    changes,
    sources: [{ id: String(evaluator.id || evaluator.name), kind: 'evaluator', label: `评估器 ${String(evaluator.name || '')}`, locator: `evaluator:${String(evaluator.id || '')}`, href: '/metrics' }],
    missing: ['删除自定义评估器后不可恢复，请确认后继续'],
    expiresAt: new Date(expiresAt).toISOString(),
    confirmationToken,
  };
}

export async function confirmEvaluatorDelete(user: string, previewToken: string): Promise<{ evaluatorId: string; deleted: boolean }> {
  const payload = decode(previewToken);
  if (payload.user !== user || payload.action !== 'evaluator_delete') throw new Error('确认令牌与当前用户或操作不匹配');
  const changes = payload.changes as { evaluatorId?: string; name?: string };
  const evaluatorId = String(changes.evaluatorId || '').trim();
  const name = String(changes.name || '').trim();
  const existing = await readUserCustomEvaluators(user) as Array<Record<string, unknown>>;
  const remaining = existing.filter(item => {
    const sameId = evaluatorId && String(item.id || '').trim() === evaluatorId;
    const sameName = !evaluatorId && name && String(item.name || '').trim() === name;
    return !sameId && !sameName;
  });
  if (remaining.length === existing.length) return { evaluatorId: evaluatorId || name, deleted: false };
  await writeUserCustomEvaluators(user, remaining);
  await syncCustomEvaluatorRegisteredAgents(user, remaining as any);
  return { evaluatorId: evaluatorId || name, deleted: true };
}

export async function buildRunFilterPreview(context: CopilotContextResult, input: WorkflowInput): Promise<WorkflowPreview> {
  const query = String(input.instructions || '').trim();
  if (!query) throw new Error('请提供 Trace 查询条件');
  const normalizedQuery = query.toLowerCase();
  const stopWords = /查询|查找|列出|找出|查看|搜索|筛选|最近|当前|所有|失败|错误|成功|完成|的|个|条|trace|链路|运行|执行|记录|traces|runs|executions|list|find|search|show|filter|recent/gi;
  const tokens = normalizedQuery
    .replace(stopWords, ' ')
    .split(/[\s,，。！？?、:：;；]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2)
    .slice(0, 8);
  const statusFilter = /失败|错误|failed|error/i.test(normalizedQuery)
    ? 'failed'
    : /成功|完成|succeeded|success|completed/i.test(normalizedQuery)
      ? 'success'
      : null;
  const rows = await db.findExecutions({ user: context.envelope.user }, { timestamp: 'desc' });
  const matches = rows.filter((row: any) => {
    const status = String(row.traceStatus || row.status || '').toLowerCase();
    if (statusFilter === 'failed' && !['failed', 'error', 'failure'].some(value => status.includes(value))) return false;
    if (statusFilter === 'success' && !['success', 'completed', 'succeeded', 'done'].some(value => status.includes(value))) return false;
    if (!tokens.length) return true;
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
  const changes = { query, count: matches.length, statusFilter, matches, readOnly: true };
  const previewId = randomUUID();
  const confirmationToken = token({ previewId, user: context.envelope.user, action: 'run_filter', expiresAt, changes });
  return { previewId, action: 'run_filter', target: '运行列表', changes, sources: [], missing: [], expiresAt: new Date(expiresAt).toISOString(), confirmationToken };
}

export async function buildDatasetDeletePreview(context: CopilotContextResult, input: WorkflowInput): Promise<WorkflowPreview> {
  let datasetId = String(input.datasetId || context.envelope.objectId || '').trim();
  let dataset = datasetId ? await findAgentDataset(context.envelope.user, datasetId) : null;
  if (!dataset && input.datasetName?.trim()) {
    const requestedName = input.datasetName.trim();
    const matches = (await readUserAgentDatasets(context.envelope.user)).filter(item => item.name === requestedName);
    if (matches.length > 1) throw new Error(`找到多个名为「${requestedName}」的数据集，请先选择具体数据集`);
    dataset = matches[0] || null;
    datasetId = dataset?.id || '';
  }
  if (!datasetId && !dataset) throw new Error('请先说明要删除的数据集名称，或在页面选择一个数据集');
  if (!dataset) throw new Error('数据集不存在或无权访问');
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const changes = { datasetId: dataset.id, name: dataset.name, caseCount: dataset.cases.length, destructive: true };
  const previewId = randomUUID();
  const confirmationToken = token({ previewId, user: context.envelope.user, action: 'dataset_delete', expiresAt, changes });
  return {
    previewId, action: 'dataset_delete', target: dataset.name, changes,
    sources: [{ id: dataset.id, kind: 'dataset', label: `Dataset ${dataset.name}`, locator: `dataset:${dataset.id}`, href: '/dataset' }],
    missing: ['删除数据集及其样例后不可恢复，请确认后继续'], expiresAt: new Date(expiresAt).toISOString(), confirmationToken,
  };
}

export async function confirmDatasetDelete(user: string, previewToken: string): Promise<{ datasetId: string; deleted: boolean }> {
  const payload = decode(previewToken);
  if (payload.user !== user || payload.action !== 'dataset_delete') throw new Error('确认令牌与当前用户或操作不匹配');
  const changes = payload.changes as { datasetId?: string };
  const datasetId = String(changes.datasetId || '').trim();
  if (!datasetId) throw new Error('确认令牌缺少数据集 ID');
  return { datasetId, deleted: await deleteAgentDataset(user, datasetId) };
}

export async function buildExperimentStartPreview(context: CopilotContextResult, input: WorkflowInput): Promise<WorkflowPreview> {
  const experimentId = String(input.experimentId || context.envelope.objectId || '').trim();
  if (!experimentId) throw new Error('请先选择要启动的实验');
  const experiment = await (prismaRaw as any).experiment.findFirst({
    where: { id: experimentId, user: context.envelope.user },
    include: { _count: { select: { cases: { where: { deletedAt: null } } } } },
  });
  if (!experiment) throw new Error('实验不存在或无权访问');
  const evaluatorIds = (() => { try { const value = JSON.parse(experiment.evaluatorIdsJson || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } })();
  const evaluatorConfigs = (() => { try { return JSON.parse(experiment.evaluatorConfigsJson || '{}'); } catch { return {}; } })();
  const configSnapshot = (() => { try { return JSON.parse(experiment.configSnapshotJson || 'null'); } catch { return null; } })();
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const changes = {
    experimentId: experiment.id,
    name: experiment.name,
    type: experiment.type,
    status: experiment.status,
    agentName: experiment.agentName,
    skillName: experiment.skillName,
    skillVersion: experiment.skillVersion,
    preset: experiment.preset,
    caseCount: experiment._count.cases,
    evaluatorIds,
    evaluatorConfigs,
    configSnapshot,
    requiresConfirmation: true,
  };
  const previewId = randomUUID();
  const confirmationToken = token({ previewId, user: context.envelope.user, action: 'experiment_start', expiresAt, changes });
  return {
    previewId, action: 'experiment_start', target: experiment.name, changes,
    sources: [{ id: experiment.id, kind: 'evaluation', label: `实验 ${experiment.name}`, locator: `experiment:${experiment.id}`, href: `/experiments/${encodeURIComponent(experiment.id)}` }],
    missing: experiment.status === 'running' ? ['实验已经在运行中'] : [],
    expiresAt: new Date(expiresAt).toISOString(), confirmationToken,
  };
}

export async function confirmExperimentStart(user: string, previewToken: string): Promise<{ experimentId: string; status: string; alreadyRunning?: boolean }> {
  const payload = decode(previewToken);
  if (payload.user !== user || payload.action !== 'experiment_start') throw new Error('确认令牌与当前用户或操作不匹配');
  const expected = payload.changes as {
    experimentId?: string;
    name?: string;
    type?: string;
    status?: string;
    agentName?: string | null;
    skillName?: string;
    skillVersion?: number | null;
    preset?: string | null;
    caseCount?: number;
    evaluatorIds?: unknown[];
    evaluatorConfigs?: unknown;
    configSnapshot?: unknown;
  };
  const experimentId = String(expected.experimentId || '').trim();
  if (!experimentId) throw new Error('确认令牌缺少实验 ID');
  const current = await (prismaRaw as any).experiment.findFirst({
    where: { id: experimentId, user },
    include: { _count: { select: { cases: { where: { deletedAt: null } } } } },
  });
  if (!current) throw new Error('实验不存在或无权访问');
  const currentEvaluatorIds = (() => {
    try {
      const value = JSON.parse(current.evaluatorIdsJson || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  })();
  const currentEvaluatorConfigs = (() => { try { return JSON.parse(current.evaluatorConfigsJson || '{}'); } catch { return {}; } })();
  const currentConfigSnapshot = (() => { try { return JSON.parse(current.configSnapshotJson || 'null'); } catch { return null; } })();
  const sameEvaluators = JSON.stringify(currentEvaluatorIds) === JSON.stringify(Array.isArray(expected.evaluatorIds) ? expected.evaluatorIds : []);
  const sameEvaluatorConfigs = JSON.stringify(currentEvaluatorConfigs) === JSON.stringify(expected.evaluatorConfigs ?? {});
  const sameConfigSnapshot = JSON.stringify(currentConfigSnapshot) === JSON.stringify(expected.configSnapshot ?? null);
  if (current.name !== expected.name || current.type !== expected.type || current.status !== expected.status
    || (current.agentName || null) !== (expected.agentName || null) || current.skillName !== expected.skillName
    || (current.skillVersion ?? null) !== (expected.skillVersion ?? null) || (current.preset || null) !== (expected.preset || null)
    || current._count.cases !== Number(expected.caseCount ?? -1) || !sameEvaluators || !sameEvaluatorConfigs || !sameConfigSnapshot) {
    throw new Error('实验配置在确认前已发生变化，请重新预览当前配置');
  }
  const result = await startExperimentRun(experimentId, user);
  if (!result) throw new Error('实验不存在或无权访问');
  return { experimentId, status: result.status, ...(result.alreadyRunning ? { alreadyRunning: true } : {}) };
}

export async function buildSkillPublishPreview(context: CopilotContextResult, input: WorkflowInput): Promise<WorkflowPreview> {
  const sessionId = String(input.sessionId || context.envelope.sessionId || '').trim();
  const recordId = String(input.recordId || '').trim();
  const skillName = String(input.skillName || '').trim();
  if (!sessionId && !recordId) throw new Error('请先选择要发布的 Skill 工作会话或优化候选');
  const changes = recordId
    ? { kind: 'optimization', recordId, skillName, confirmed: true }
    : { kind: 'workbench', sessionId, confirmed: true };
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const previewId = randomUUID();
  const confirmationToken = token({ previewId, user: context.envelope.user, action: 'skill_publish', expiresAt, changes });
  return {
    previewId, action: 'skill_publish', target: skillName || '当前 Skill', changes,
    sources: context.sources.map(({ content: _content, ...source }) => source),
    missing: ['发布前必须通过静态质量门禁，并确认版本变更'], expiresAt: new Date(expiresAt).toISOString(), confirmationToken,
  };
}

export async function confirmSkillPublish(user: string, previewToken: string): Promise<{ skillName?: string; version: number; kind: string }> {
  const payload = decode(previewToken);
  if (payload.user !== user || payload.action !== 'skill_publish') throw new Error('确认令牌与当前用户或操作不匹配');
  const changes = payload.changes as { kind?: string; sessionId?: string; recordId?: string; skillName?: string };
  if (changes.kind === 'optimization') {
    if (!changes.recordId || !changes.skillName) throw new Error('优化候选发布信息不完整');
    const result = await publishOptimizationCandidate({ user, skillName: changes.skillName, recordId: changes.recordId, confirmed: true });
    return { skillName: result.skill.name, version: result.version.version, kind: 'optimization' };
  }
  if (!changes.sessionId) throw new Error('Skill 工作会话 ID 不存在');
  const result = await publishWorkbenchSnapshot({ user, sessionId: changes.sessionId, confirmed: true });
  return { skillName: result.skill.name, version: result.version.version, kind: 'workbench' };
}

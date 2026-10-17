import { db } from '@/lib/storage/prisma';
import { findAgentDataset, readAgentDatasetSummaries } from '@/server/agent_datasets_storage';
import { contextSchema, classifyIntent, type CopilotContextEnvelope, type CopilotContextResult, type CopilotSource } from './contracts';
import { redactAgentTrajectoryPromptValue } from '@/lib/engine/evaluation/agent-trajectory-facts';
import { findAgentDebugReport, parseReportPayload } from '@/lib/engine/agent-debug/report-store';

export type { CopilotContextEnvelope, CopilotContextResult, CopilotSource } from './contracts';

const MAX_SOURCE_CHARS = 8000;

function compact(value: unknown, max = MAX_SOURCE_CHARS): string {
  const sanitized = redactAgentTrajectoryPromptValue(value);
  const text = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
  return text.length <= max ? text : `${text.slice(0, max)}\n…[已截断]`;
}

function parseInteractions(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function executionContext(envelope: CopilotContextEnvelope): Promise<CopilotContextResult> {
  const id = String(envelope.objectId || '').trim();
  const taskId = envelope.objectType === 'task' ? id : '';
  let executions = await db.findExecutions(
    id && envelope.objectType === 'execution' ? { id, user: envelope.user } : { taskId: taskId || id, user: envelope.user },
    { timestamp: 'desc' },
  );
  if (executions.length === 0 && envelope.objectType === 'execution') {
    executions = await db.findExecutions({ taskId: id, user: envelope.user }, { timestamp: 'desc' });
  }
  const execution = executions[0];
  if (!execution) {
    return { envelope, sources: [], facts: {}, missing: ['当前 Trace/Execution 不存在或无权访问'] };
  }
  const session = execution.taskId ? await db.findSessionByTaskId(String(execution.taskId)) : null;
  if (session && session.user !== envelope.user) throw new Error('无权读取该 Trace 会话');
  if (String(session?.interactions ?? '').length > 8 * 1024 * 1024) throw new Error('当前 Trace 超过 8MB，请先在页面选择更小的对象');
  const interactions = parseInteractions(session?.interactions);
  const source: CopilotSource = {
    id: String(execution.id),
    kind: 'trace',
    label: `Trace ${String(execution.id)}`,
    locator: `execution:${String(execution.id)}`,
    href: `/trace?taskId=${encodeURIComponent(String(execution.taskId || execution.id))}`,
    content: compact({
      executionId: execution.id,
      taskId: execution.taskId,
      framework: execution.framework,
      agent: execution.agentName || execution.agent,
      model: execution.model,
      query: execution.query,
      finalResult: execution.finalResult,
      skill: execution.skill,
      skills: execution.skills,
      failures: execution.failures,
    }),
  };
  const sources = [source];
  const selectedSteps = interactions.length <= 40
    ? interactions.map((value, index) => ({ value, index }))
    : [...interactions.slice(0, 20).map((value, index) => ({ value, index })), ...interactions.slice(-20).map((value, index) => ({ value, index: interactions.length - 20 + index }))];
  for (const step of selectedSteps) sources.push({ id: `step-${step.index + 1}`, kind: 'trace-step', label: `执行步骤 ${step.index + 1}`, locator: `interactions[${step.index}]`, href: source.href, content: compact(step.value, 900) });
  const missing = interactions.length === 0 ? ['Trace 没有可解析的 interaction 详情'] : [];
  if (interactions.length > 40) missing.push(`Trace 共 ${interactions.length} 条交互，仅提供首尾各 20 条，不能对省略步骤作断言`);
  if (envelope.pageType === 'diagnosis') {
    const report = await findAgentDebugReport(String(execution.id));
    if (report && report.user !== envelope.user) throw new Error('无权读取该诊断报告');
    if (report?.status === 'done') sources.push({ id: 'diagnosis', kind: 'diagnosis', label: 'AgentDebug 已完成诊断', locator: `AgentDebugReport:${report.id}`, href: `/fault?executionId=${encodeURIComponent(String(execution.id))}`, content: compact(parseReportPayload(report), 14000) });
    else missing.push(`诊断报告尚未完成（${report?.status ?? '未运行'}）`);
  }
  return {
    envelope,
    sources,
    facts: { executionId: execution.id, taskId: execution.taskId, query: execution.query ?? '', actualOutput: execution.finalResult ?? '', interactions: selectedSteps.map(step => step.value), interactionCount: interactions.length },
    missing,
  };
}

async function datasetContext(envelope: CopilotContextEnvelope): Promise<CopilotContextResult> {
  const id = String(envelope.objectId || '').trim();
  const dataset = id ? await findAgentDataset(envelope.user, id) : null;
  if (!dataset) return { envelope, sources: [], facts: {}, missing: ['数据集不存在或无权访问'] };
  const source: CopilotSource = {
    id: dataset.id,
    kind: 'dataset',
    label: `Dataset ${dataset.name}`,
    locator: `dataset:${dataset.id}`,
    href: '/dataset',
    content: compact({
      id: dataset.id, name: dataset.name, description: dataset.description,
      datasetKind: dataset.datasetKind, fields: dataset.fields,
      caseCount: dataset.cases.length,
      cases: (envelope.caseId ? dataset.cases.filter(item => item.id === envelope.caseId) : dataset.cases.slice(0, 10)).map(item => ({ id: item.id, input: compact(item.input, 700), expectedOutput: compact(item.expectedOutput, 700), evaluationFocus: item.evaluationFocus, tags: item.tags })),
    }),
  };
  return { envelope, sources: [source], facts: { datasetId: dataset.id, caseCount: dataset.cases.length }, missing: dataset.cases.length === 0 ? ['数据集目前没有样例'] : [] };
}

async function datasetListContext(envelope: CopilotContextEnvelope): Promise<CopilotContextResult> {
  const datasets = await readAgentDatasetSummaries(envelope.user);
  const source: CopilotSource = {
    id: 'dataset-list',
    kind: 'dataset-list',
    label: `数据集页面（${datasets.length} 个数据集）`,
    locator: 'dataset:list',
    href: '/dataset',
    content: compact({
      page: 'dataset',
      capabilities: ['创建数据集', '导入数据集', '编辑数据集', '删除可编辑数据集', '发起评测'],
      datasetCount: datasets.length,
      datasets: datasets.slice(0, 30).map(dataset => ({
        id: dataset.id,
        name: dataset.name,
        description: dataset.description,
        datasetKind: dataset.datasetKind,
        caseCount: dataset.caseCount,
        fields: dataset.fields,
        readOnly: dataset.user !== envelope.user,
      })),
    }, 14000),
  };
  return {
    envelope,
    sources: [source],
    facts: {
      datasetCount: datasets.length,
      datasetIds: datasets.map(dataset => dataset.id),
      datasets: datasets.slice(0, 30).map(dataset => ({
        id: dataset.id,
        name: dataset.name,
        description: dataset.description,
        datasetKind: dataset.datasetKind,
        caseCount: dataset.caseCount,
        fields: dataset.fields,
      })),
    },
    missing: datasets.length > 30 ? [`当前共有 ${datasets.length} 个数据集，仅展示前 30 个摘要`] : [],
  };
}

async function skillContext(envelope: CopilotContextEnvelope): Promise<CopilotContextResult> {
  const id = String(envelope.objectId || '').trim();
  const skill = await db.findSkill(id, envelope.user);
  if (!skill) return { envelope, sources: [], facts: {}, missing: ['Skill 不存在或无权访问'] };
  const wanted = envelope.version ?? skill.activeVersion;
  const version = Number.isInteger(wanted) ? await db.findSkillVersion(String(skill.id), Number(wanted)) : await db.findLatestSkillVersion(String(skill.id));
  const source: CopilotSource = {
    id: String(skill.id),
    kind: 'skill',
    label: `Skill ${skill.name} v${version?.version ?? '?'}`,
    locator: `skill:${skill.name}@${version?.version ?? '?'}`,
    href: `/skill-opt/${encodeURIComponent(String(skill.name))}/${version?.version ?? 0}`,
    content: compact({ name: skill.name, description: skill.description, version: version?.version, content: version?.content, files: version?.files }),
  };
  return { envelope, sources: [source], facts: { skillId: skill.id, skillName: skill.name, version: version?.version ?? null }, missing: version ? [] : ['Skill 没有可读取的版本内容'] };
}

export async function loadCopilotContext(envelope: CopilotContextEnvelope): Promise<CopilotContextResult> {
  if (!envelope.user) throw new Error('user is required');
  contextSchema.parse(envelope);
  if (!envelope.objectId) {
    if (envelope.pageType === 'dataset') return datasetListContext(envelope);
    return { envelope, sources: [], facts: {}, missing: ['当前页面尚未选择可分析的对象'] };
  }
  if (envelope.objectType === 'execution' || envelope.objectType === 'task') return executionContext(envelope);
  if (envelope.objectType === 'dataset' || envelope.objectType === 'case') return datasetContext(envelope);
  if (envelope.objectType === 'skillVersion') return skillContext(envelope);
  if (envelope.objectType === 'evaluation') {
    const { GET } = await import('@/app/api/experiments/[id]/route');
    const url = new URL('http://copilot.local/api/experiments/' + encodeURIComponent(envelope.objectId));
    url.searchParams.set('user', envelope.user);
    url.searchParams.set('casePageSize', '10');
    if (envelope.caseId) url.searchParams.set('caseId', envelope.caseId);
    const response = await GET(new Request(url), { params: Promise.resolve({ id: envelope.objectId }) });
    if (!response.ok) throw new Error('实验不存在或无权读取');
    const payload = await response.json();
    return { envelope, sources: [{ id: 'experiment', kind: 'evaluation', label: `实验 ${envelope.objectId}`, locator: `Experiment:${envelope.objectId}${envelope.caseId ? `/case:${envelope.caseId}` : ''}`, href: `/experiments/${encodeURIComponent(envelope.objectId)}${envelope.caseId ? `/cases/${encodeURIComponent(envelope.caseId)}` : ''}`, content: compact(payload, 16000) }], facts: { experimentId: envelope.objectId }, missing: ['实验案例仅展示当前页，整体指标使用现有实验 API 聚合结果'] };
  }
  return {
    envelope,
    sources: [],
    facts: {},
    missing: ['当前页面类型尚未接入 Copilot 上下文适配器'],
  };
}

export function routeCopilotIntent(message: string, context: CopilotContextResult) { return classifyIntent(message, context.sources.length > 0); }

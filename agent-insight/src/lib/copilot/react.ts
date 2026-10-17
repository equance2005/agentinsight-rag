import { completeCopilot, type CopilotImage } from './model';
import { loadCopilotContext, type CopilotContextEnvelope } from './context';
import { searchRagKnowledge } from './rag';

export type CopilotReactStep = {
  id: string;
  tool: 'get_trace_context' | 'search_knowledge' | 'generate_diagnosis';
  status: 'done' | 'blocked';
  summary: string;
};

export type CopilotReactResult = {
  mode: 'bounded-react';
  maxSteps: number;
  status: 'awaiting_confirmation' | 'blocked';
  answer: string;
  steps: CopilotReactStep[];
  proposedActions: string[];
  sources: Array<{ id: string; kind: string; label: string; locator: string; href?: string }>;
  missing: string[];
};

const MAX_STEPS = 4;

function diagnosisRequest(message: string): boolean {
  return /诊断|根因|失败步骤|为什么失败|异常原因|排查|diagnos|root cause|failed step/i.test(message);
}

export function isTraceDiagnosisRequest(message: string, context: CopilotContextEnvelope): boolean {
  return (context.objectType === 'execution' || context.objectType === 'task') && diagnosisRequest(message);
}

export async function runBoundedTraceDiagnosis(input: {
  user: string;
  message: string;
  context: CopilotContextEnvelope;
  images?: CopilotImage[];
  modelConfigId?: string;
}): Promise<CopilotReactResult> {
  const steps: CopilotReactStep[] = [];
  const loaded = await loadCopilotContext(input.context);
  steps.push({
    id: 'step-1',
    tool: 'get_trace_context',
    status: loaded.sources.length ? 'done' : 'blocked',
    summary: loaded.sources.length ? `读取 ${loaded.sources.length} 个 Trace 证据块` : '没有读取到当前 Trace',
  });
  if (!loaded.sources.length) {
    return {
      mode: 'bounded-react', maxSteps: MAX_STEPS, status: 'blocked',
      answer: '当前没有可读取的 Trace，无法执行诊断。', steps,
      proposedActions: ['先在链路追踪中选择一条 Trace，再重新发起诊断'],
      sources: [], missing: loaded.missing,
    };
  }

  const rag = await searchRagKnowledge(input.message);
  steps.push({
    id: 'step-2',
    tool: 'search_knowledge',
    status: rag.sources.length ? 'done' : 'blocked',
    summary: rag.sources.length ? `检索到 ${rag.sources.length} 个知识证据块` : '没有检索到相关知识证据',
  });

  const evidence = [...loaded.sources, ...rag.sources]
    .map(source => `SOURCE ${source.id} (${source.label}) [${source.locator}]\n${source.content}`)
    .join('\n\n---\n\n');
  const system = [
    '你是 Agent Insight 的 Trace 诊断 Agent。',
    '这是一个有界只读诊断循环：最多 4 步，只能读取 Trace、检索知识和生成建议，不得执行写入、删除、发布或启动实验。',
    '必须区分 Trace 事实、知识证据和推断；证据不足时明确说明未知。',
    '诊断完成后给出待人工确认的后续动作，不要声称动作已经执行。',
    `证据块：\n${evidence}`,
    [...loaded.missing, ...rag.missing].length ? `已知缺失：${[...loaded.missing, ...rag.missing].join('；')}` : '',
  ].filter(Boolean).join('\n\n');
  const answer = await completeCopilot(input.user, system, input.message, input.images ?? [], undefined, input.modelConfigId);
  steps.push({ id: 'step-3', tool: 'generate_diagnosis', status: 'done', summary: '基于 Trace 和知识证据生成诊断建议' });
  return {
    mode: 'bounded-react', maxSteps: MAX_STEPS, status: 'awaiting_confirmation', answer, steps,
    proposedActions: ['确认后再创建数据集、修改 Skill、创建评估器或启动实验'],
    sources: [...loaded.sources, ...rag.sources].map(({ content: _content, ...source }) => source),
    missing: [...loaded.missing, ...rag.missing],
  };
}

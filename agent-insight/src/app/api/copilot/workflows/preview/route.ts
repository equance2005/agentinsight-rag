import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { contextSchema, workflowInputSchema, type CopilotContextEnvelope } from '@/lib/copilot/contracts';
import { loadCopilotContext } from '@/lib/copilot/context';
import { buildDatasetCreatePreview, buildDatasetDeletePreview, buildEvaluatorPreview, buildExperimentStartPreview, buildRunFilterPreview, buildSkillPublishPreview, buildTraceDatasetPreview } from '@/lib/copilot/workflows';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const auth = await resolveUser(request, typeof body.user === 'string' ? body.user : undefined);
    if (!auth.username) return NextResponse.json({ error: '请先登录 Agent Insight 后再使用 Copilot' }, { status: 401 });
    const action = String(body.action || '');
    const context = { ...contextSchema.parse(body.context || {}), user: auth.username } as CopilotContextEnvelope;
    const loaded = await loadCopilotContext(context);
    const input = workflowInputSchema.parse(body.input || {});
    if (action === 'trace_to_dataset') return NextResponse.json({ preview: buildTraceDatasetPreview(loaded, input) });
    if (action === 'dataset_create') return NextResponse.json({ preview: await buildDatasetCreatePreview(loaded, input) });
    if (action === 'evaluator_draft') return NextResponse.json({ preview: buildEvaluatorPreview(loaded, input) });
    if (action === 'run_filter') return NextResponse.json({ preview: await buildRunFilterPreview(loaded, input) });
    if (action === 'dataset_delete') return NextResponse.json({ preview: await buildDatasetDeletePreview(loaded, input) });
    if (action === 'experiment_start') return NextResponse.json({ preview: await buildExperimentStartPreview(loaded, input) });
    if (action === 'skill_publish') return NextResponse.json({ preview: await buildSkillPublishPreview(loaded, input) });
    return NextResponse.json({ error: '不支持的 Copilot 工作流动作' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '预览失败' }, { status: 400 });
  }
}

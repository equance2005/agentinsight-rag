import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { workflowInputSchema } from '@/lib/copilot/contracts';
import { confirmDatasetDelete, confirmEvaluatorDraft, confirmExperimentStart, confirmSkillPublish, confirmTraceDataset } from '@/lib/copilot/workflows';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const auth = await resolveUser(request, typeof body.user === 'string' ? body.user : undefined);
    if (!auth.username) return NextResponse.json({ error: '请先登录 Agent Insight 后再使用 Copilot' }, { status: 401 });
    const confirmationToken = String(body.confirmationToken || '');
    if (!confirmationToken) return NextResponse.json({ error: 'confirmationToken is required' }, { status: 400 });
    const action = String(body.action || 'trace_to_dataset');
    const result = action === 'evaluator_draft'
      ? await confirmEvaluatorDraft(auth.username, confirmationToken)
      : action === 'dataset_delete'
        ? await confirmDatasetDelete(auth.username, confirmationToken)
        : action === 'experiment_start'
          ? await confirmExperimentStart(auth.username, confirmationToken)
          : action === 'skill_publish'
            ? await confirmSkillPublish(auth.username, confirmationToken)
            : await confirmTraceDataset(auth.username, confirmationToken, workflowInputSchema.parse(body.input || {}));
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '确认执行失败' }, { status: 400 });
  }
}

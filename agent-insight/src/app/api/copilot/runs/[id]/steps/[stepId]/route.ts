import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { updateCopilotRunStep } from '@/lib/copilot/run-store';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, context: { params: Promise<{ id: string; stepId: string }> }) {
  try {
    const body = await request.json().catch(() => ({}));
    const { username } = await resolveUser(request, typeof body.user === 'string' ? body.user : undefined);
    if (!username) return NextResponse.json({ error: '请先登录 Agent Insight 后再使用 Copilot' }, { status: 401 });
    const params = await context.params;
    const status = String(body.status || '');
    if (!['pending', 'in_progress', 'done', 'blocked'].includes(status)) return NextResponse.json({ error: '非法步骤状态' }, { status: 400 });
    const run = await updateCopilotRunStep({ user: username, runId: params.id, stepId: params.stepId, status: status as any, result: body.result, errorMessage: body.errorMessage });
    if (!run) return NextResponse.json({ error: '任务或步骤不存在或无权访问' }, { status: 404 });
    return NextResponse.json({ run });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '更新步骤失败' }, { status: 400 });
  }
}

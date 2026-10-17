import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { getCopilotRun } from '@/lib/copilot/run-store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { username } = await resolveUser(request, searchParams.get('user'));
    if (!username) return NextResponse.json({ error: '请先登录 Agent Insight 后再使用 Copilot' }, { status: 401 });
    const id = String(searchParams.get('id') || '').trim();
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
    const run = await getCopilotRun(username, id);
    if (!run) return NextResponse.json({ error: 'CopilotRun 不存在或无权访问' }, { status: 404 });
    return NextResponse.json({ run });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '读取任务失败' }, { status: 400 });
  }
}

import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { loadCopilotContext, routeCopilotIntent, type CopilotContextEnvelope } from '@/lib/copilot/context';
import { completeCopilot, CopilotModelError, type CopilotImage } from '@/lib/copilot/model';
import { searchRagKnowledge } from '@/lib/copilot/rag';
import { buildCopilotPlan } from '@/lib/copilot/planner';
import { isTraceDiagnosisRequest, runBoundedTraceDiagnosis } from '@/lib/copilot/react';
import { createCopilotRun } from '@/lib/copilot/run-store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const auth = await resolveUser(request, typeof body.user === 'string' ? body.user : undefined);
    const user = auth.username;
    if (!user) return NextResponse.json({ error: '请先登录 Agent Insight 后再使用 Copilot' }, { status: 401 });
    const message = String(body.message || '').trim();
    if (!message) return NextResponse.json({ error: 'message is required' }, { status: 400 });
    const modelConfigId = typeof body.modelConfigId === 'string' && body.modelConfigId.trim()
      ? body.modelConfigId.trim()
      : undefined;
    const images = Array.isArray(body.images) ? body.images.filter((item: unknown): item is CopilotImage => {
      if (!item || typeof item !== 'object') return false;
      const value = item as Record<string, unknown>;
      return typeof value.dataUrl === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(value.dataUrl);
    }).slice(0, 4) : [];
    if (images.reduce((total: number, image: CopilotImage) => total + image.dataUrl.length, 0) > 10_000_000) {
      return NextResponse.json({ error: '图片总大小不能超过 10MB' }, { status: 413 });
    }
    const rawContext = body.context && typeof body.context === 'object' ? body.context : {};
    const context: CopilotContextEnvelope = { ...rawContext, user };
    if (isTraceDiagnosisRequest(message, context)) {
      const diagnosis = await runBoundedTraceDiagnosis({ user, message, context, images, modelConfigId });
      return NextResponse.json({
        answer: diagnosis.answer,
        route: { intent: 'context_analysis', action: undefined, pageType: context.pageType, objectType: context.objectType },
        react: diagnosis,
        sources: diagnosis.sources,
        missing: diagnosis.missing,
      });
    }
    const [loaded, rag] = await Promise.all([
      loadCopilotContext(context),
      searchRagKnowledge(message),
    ]);
    const intent = routeCopilotIntent(message, loaded);
    const plan = buildCopilotPlan(message, intent, loaded);
    const run = await createCopilotRun(user, plan);
    const allSources = [...loaded.sources, ...rag.sources];
    const evidence = allSources.map(source => `SOURCE ${source.id} (${source.label}) [${source.locator}]\n${source.content}`).join('\n\n---\n\n');
    const system = [
      '你是 Agent Insight Copilot。',
      '必须区分页面事实、模型推断和建议。只根据提供的证据块回答；没有证据就明确说未知。',
      '不要声称已经执行任何写入。工作流请求只输出草稿、来源和待补充字段。',
      `当前意图：${intent}`,
      `执行计划（只可按现有工具和页面证据解释；写操作必须先经过预览和用户确认）：${JSON.stringify(plan)}`,
      [...loaded.missing, ...rag.missing].length ? `已知缺失：${[...loaded.missing, ...rag.missing].join('；')}` : '',
      evidence ? `证据块：\n${evidence}` : '当前没有页面证据。',
    ].filter(Boolean).join('\n\n');
    const answer = await completeCopilot(user, system, message, images, undefined, modelConfigId);
    return NextResponse.json({
      answer,
      route: { intent, pageType: context.pageType, objectType: context.objectType },
      plan,
      run,
      sources: allSources.map(source => ({ id: source.id, kind: source.kind, label: source.label, locator: source.locator, href: source.href })),
      missing: [...loaded.missing, ...rag.missing],
    });
  } catch (error) {
    console.error('[copilot/chat]', error);
    const raw = error instanceof Error ? error.message : 'copilot failed';
    const status = error instanceof CopilotModelError ? error.status : /401|authentication|api key|invalid.*key/i.test(raw) ? 401 : 500;
    const message = status === 401
      ? (/auth(?:entication)?\s+required/i.test(raw) ? '请先登录 Agent Insight 后再使用 Copilot。' : '模型 API Key 无效或已过期，请打开模型设置重新连接。')
      : raw;
    return NextResponse.json({ error: message }, { status });
  }
}

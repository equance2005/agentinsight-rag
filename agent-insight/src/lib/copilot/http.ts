import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { resolveUser } from '@/lib/auth/auth';
import { CopilotModelError } from './model';

export async function requireCopilotUser(request: Request): Promise<string> {
  const { username } = await resolveUser(request);
  if (!username) throw new CopilotModelError('请登录后使用 Copilot', 401);
  return username;
}
export function copilotErrorResponse(error: unknown) {
  const status = error instanceof CopilotModelError ? error.status : error instanceof ZodError ? 400 : 500;
  const message = error instanceof ZodError ? '请求参数无效' : error instanceof CopilotModelError ? error.message : '请求未完成，请检查模型配置或稍后重试';
  return NextResponse.json({ error: message }, { status });
}

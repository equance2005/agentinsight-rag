import OpenAI from 'openai';
import { getUserSettings } from '@/lib/storage/server-config';
import { getOpenAICompatibleClientConfig, isModelConnectionReady } from '@/lib/shared/model-connection';

export class CopilotModelError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CopilotModelError';
    this.status = status;
  }
}

export type CopilotImage = { dataUrl: string; mimeType: string; name?: string };

export async function copilotModel(user: string, modelConfigId?: string) {
  const settings = await getUserSettings(user);
  const config = (modelConfigId
    ? settings.configs.find(item => item.id === modelConfigId)
    : undefined) ?? settings.configs.find(item => item.id === settings.activeConfigId);
  if (!config || !isModelConnectionReady(config) || !config.model) throw new CopilotModelError('请先在模型注册页面配置可用模型', 400);
  return { client: new OpenAI({ ...getOpenAICompatibleClientConfig(config), timeout: 90_000, maxRetries: 1 }), model: config.model };
}
export async function completeCopilot(user: string, system: string, prompt: string, images: CopilotImage[] = [], signal?: AbortSignal, modelConfigId?: string) {
  const { client, model } = await copilotModel(user, modelConfigId);
  const content = [
    { type: 'text' as const, text: prompt },
    ...images.map(image => ({ type: 'image_url' as const, image_url: { url: image.dataUrl } })),
  ];
  const response = await client.chat.completions.create({ model, messages: [{ role: 'system', content: system }, { role: 'user', content }] }, { signal });
  const answer = response.choices[0]?.message?.content;
  if (!answer?.trim()) throw new CopilotModelError('模型未返回有效内容', 502);
  return answer;
}

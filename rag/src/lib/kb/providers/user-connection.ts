import type { ImageAttachment, LlmMessage, LlmOptions, LlmProvider } from '../ports.js';
import { OpenAiChatProvider } from './openai-compat.js';

export const PROVIDERS = {
  openai: { label: 'OpenAI · GPT', endpoint: 'https://api.openai.com/v1', vision: true, models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'] },
  gemini: { label: 'Google · Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', vision: true, models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'] },
  claude: { label: 'Anthropic · Claude', endpoint: 'https://api.anthropic.com/v1', vision: true, models: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'] },
  minimax: { label: 'MiniMax', endpoint: 'https://api.minimax.io/v1', vision: false, models: ['MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M2'] },
  deepseek: { label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', vision: false, models: ['deepseek-chat', 'deepseek-reasoner'] },
} as const;

export type ProviderId = keyof typeof PROVIDERS;
export interface ModelConnection { provider: ProviderId; model: string; apiKey: string }

export function parseConnection(value: unknown): ModelConnection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型连接格式无效');
  const data = value as Record<string, unknown>;
  if (typeof data.provider !== 'string' || !Object.hasOwn(PROVIDERS, data.provider)) throw new Error('请选择支持的模型提供商');
  if (typeof data.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(data.model)) throw new Error('模型型号格式无效');
  if (typeof data.apiKey !== 'string' || !data.apiKey.trim() || data.apiKey.length > 512 || /[\r\n]/.test(data.apiKey)) throw new Error('请输入有效的 API Key');
  return { provider: data.provider as ProviderId, model: data.model, apiKey: data.apiKey.trim() };
}

/** 固定官方端点，请求凭证只存在于当前请求的提供方实例。 */
export function createConnectedProvider(connection: ModelConnection): LlmProvider {
  const entry = PROVIDERS[connection.provider];
  if (connection.provider === 'claude') return new ClaudeProvider(connection);
  return new OpenAiChatProvider({ model: connection.model, apiKey: connection.apiKey, baseUrl: entry.endpoint });
}

class ClaudeProvider implements LlmProvider {
  readonly modelId: string;
  constructor(private readonly connection: ModelConnection) { this.modelId = connection.model; }

  private body(messages: LlmMessage[], options: LlmOptions, stream: boolean) {
    const userMessages = messages.filter((message) => message.role !== 'system');
    const lastUser = userMessages.findLastIndex((message) => message.role === 'user');
    return {
      model: this.modelId, max_tokens: options.maxTokens ?? 2048, stream,
      system: messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n'),
      messages: userMessages.map((message, index) => ({ role: message.role, content: index === lastUser && options.images?.length
        ? [{ type: 'text', text: message.content }, ...options.images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }))]
        : message.content })),
    };
  }

  private async request(messages: LlmMessage[], options: LlmOptions, stream: boolean) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
    const response = await fetch(`${PROVIDERS.claude.endpoint}/messages`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': this.connection.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(this.body(messages, options, stream)),
    });
    if (!response.ok) throw new Error(`Claude 请求失败（HTTP ${response.status}），请检查 Key、型号及账户权限`);
    return response;
  }

  async complete(messages: LlmMessage[], options: LlmOptions = {}) {
    const response = await this.request(messages, options, false);
    const data = await response.json() as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number } };
    return { text: (data.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join(''),
      usage: data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens } : null };
  }

  async *stream(messages: LlmMessage[], options: LlmOptions = {}) {
    const response = await this.request(messages, options, true);
    if (!response.body) throw new Error('Claude 未返回流式内容');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const line = event.split('\n').find((entry) => entry.startsWith('data:'));
          if (!line) continue;
          const data = JSON.parse(line.slice(5)) as { type: string; delta?: { text?: string } };
          if (data.type === 'error') throw new Error('Claude 流式生成失败');
          if (data.delta?.text) yield data.delta.text;
        }
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}

export function validateImages(value: unknown): ImageAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4) throw new Error('最多支持 4 张图片');
  let total = 0;
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('图片格式无效');
    const image = item as Record<string, unknown>;
    if (typeof image.data !== 'string' || !image.data || image.data.length > 7_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error('图片数据无效或超过 5MB');
    if (typeof image.mimeType !== 'string' || !/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType)) throw new Error('仅支持 PNG、JPEG、WebP 或 GIF');
    const bytes = Buffer.from(image.data, 'base64'); total += bytes.length;
    const type = bytes.subarray(0, 12);
    const valid = image.mimeType === 'image/png' ? type.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : image.mimeType === 'image/jpeg' ? type[0] === 255 && type[1] === 216 && type[2] === 255
      : image.mimeType === 'image/gif' ? /^GIF8[79]a$/.test(type.subarray(0, 6).toString())
      : type.subarray(0, 4).toString() === 'RIFF' && type.subarray(8, 12).toString() === 'WEBP';
    if (!valid || total > 10 * 1024 * 1024) throw new Error('图片内容与类型不符，或图片总大小超过 10MB');
    return { data: image.data, mimeType: image.mimeType, name: typeof image.name === 'string' ? image.name.slice(0, 160) : '图片' };
  });
}

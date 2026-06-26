import { withRetries, newUsage, postJson } from './base.js';

/**
 * Anthropic API (direct). BYOK: ANTHROPIC_API_KEY.
 * Optional ANTHROPIC_BASE_URL for proxies/gateways (e.g. a LiteLLM passthrough).
 */
export class AnthropicProvider {
  constructor({ maxRetries, requestTimeoutMs }) {
    this.apiKey = process.env.ANTHROPIC_API_KEY;
    this.baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
    this.version = process.env.ANTHROPIC_VERSION || '2023-06-01';
    this.maxRetries = maxRetries;
    this.timeoutMs = requestTimeoutMs;
    this.usage = newUsage();
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set (required for provider "anthropic").');
  }

  async converse({ modelId, system, userText, maxTokens, temperature = 0 }) {
    const data = await withRetries(() => postJson(`${this.baseUrl}/v1/messages`, {
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': this.version },
      timeoutMs: this.timeoutMs,
      body: {
        model: modelId,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [{ role: 'user', content: userText }],
      },
    }), { maxRetries: this.maxRetries, onRetry: () => { this.usage.retries += 1; } });

    const text = (data.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    this.usage.requests += 1;
    this.usage.inputTokens += data.usage?.input_tokens ?? 0;
    this.usage.outputTokens += data.usage?.output_tokens ?? 0;
    return { text, stopReason: data.stop_reason };
  }
}

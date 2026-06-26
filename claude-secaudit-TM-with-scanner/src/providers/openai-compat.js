import { withRetries, newUsage, postJson } from './base.js';

/**
 * Generic OpenAI-compatible chat-completions provider.
 *
 * Used for three concrete providers that all speak the OpenAI
 * /chat/completions schema:
 *
 *   - openrouter : OPENROUTER_API_KEY            -> https://openrouter.ai/api/v1
 *   - azure      : AZURE_OPENAI_API_KEY + endpoint (deployment-based URL)
 *   - ollama     : OLLAMA_HOST (no key)          -> http://localhost:11434/v1
 *
 * The `kind` argument selects how the request URL and auth header are built.
 */
export class OpenAICompatProvider {
  constructor(kind, { maxRetries, requestTimeoutMs }) {
    this.kind = kind;
    this.maxRetries = maxRetries;
    this.timeoutMs = requestTimeoutMs;
    this.usage = newUsage();

    if (kind === 'openrouter') {
      this.apiKey = process.env.OPENROUTER_API_KEY;
      this.baseUrl = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
      if (!this.apiKey) throw new Error('OPENROUTER_API_KEY is not set (required for provider "openrouter").');
    } else if (kind === 'azure') {
      this.apiKey = process.env.AZURE_OPENAI_API_KEY;
      this.endpoint = (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/$/, '');
      this.apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
      if (!this.apiKey) throw new Error('AZURE_OPENAI_API_KEY is not set (required for provider "azure").');
      if (!this.endpoint) throw new Error('AZURE_OPENAI_ENDPOINT is not set (e.g. https://my-res.openai.azure.com).');
    } else if (kind === 'ollama') {
      this.baseUrl = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
      if (!/\/v1$/.test(this.baseUrl)) this.baseUrl += '/v1';
    } else {
      throw new Error(`Unknown OpenAI-compatible provider kind: ${kind}`);
    }
  }

  _urlAndHeaders(modelId) {
    if (this.kind === 'azure') {
      // modelId is the Azure *deployment name*.
      const url = `${this.endpoint}/openai/deployments/${encodeURIComponent(modelId)}/chat/completions?api-version=${this.apiVersion}`;
      return { url, headers: { 'api-key': this.apiKey } };
    }
    const headers = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.kind === 'openrouter') {
      headers['HTTP-Referer'] = process.env.OPENROUTER_REFERER || 'https://github.com/claude-secaudit';
      headers['X-Title'] = 'claude-secaudit';
    }
    return { url: `${this.baseUrl}/chat/completions`, headers };
  }

  async converse({ modelId, system, userText, maxTokens, temperature = 0 }) {
    const { url, headers } = this._urlAndHeaders(modelId);
    const body = {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
      temperature,
      max_tokens: maxTokens,
    };
    // Azure puts the model in the URL; everyone else needs it in the body.
    if (this.kind !== 'azure') body.model = modelId;

    const data = await withRetries(() => postJson(url, {
      headers, body, timeoutMs: this.timeoutMs,
    }), { maxRetries: this.maxRetries, onRetry: () => { this.usage.retries += 1; } });

    const choice = (data.choices && data.choices[0]) || {};
    const text = choice.message?.content || '';
    this.usage.requests += 1;
    this.usage.inputTokens += data.usage?.prompt_tokens ?? 0;
    this.usage.outputTokens += data.usage?.completion_tokens ?? 0;
    return { text, stopReason: choice.finish_reason };
  }
}

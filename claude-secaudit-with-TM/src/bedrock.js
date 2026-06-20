import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';

const RETRYABLE = new Set([
  'ThrottlingException',
  'ServiceUnavailableException',
  'ModelTimeoutException',
  'InternalServerException',
  'ModelNotReadyException',
  'TooManyRequestsException',
]);

export class BedrockClient {
  constructor({ region, profile, maxRetries, requestTimeoutMs }) {
    const clientConfig = { region, requestHandler: { requestTimeout: requestTimeoutMs } };
    if (profile) {
      // Defer credential resolution to the shared ini provider for named profiles.
      process.env.AWS_PROFILE = profile;
    }
    this.client = new BedrockRuntimeClient(clientConfig);
    this.maxRetries = maxRetries;
    this.usage = { inputTokens: 0, outputTokens: 0, requests: 0, retries: 0, failures: 0 };
  }

  /**
   * Single Converse call with manual exponential backoff + jitter.
   * Returns { text, stopReason } or throws after exhausting retries.
   */
  async converse({ modelId, system, userText, maxTokens, temperature = 0 }) {
    let attempt = 0;
    let lastErr;
    while (attempt <= this.maxRetries) {
      try {
        const cmd = new ConverseCommand({
          modelId,
          system: [{ text: system }],
          messages: [{ role: 'user', content: [{ text: userText }] }],
          inferenceConfig: { maxTokens, temperature },
        });
        const res = await this.client.send(cmd);
        this.usage.requests += 1;
        this.usage.inputTokens += res.usage?.inputTokens ?? 0;
        this.usage.outputTokens += res.usage?.outputTokens ?? 0;
        const text = (res.output?.message?.content || [])
          .map((b) => b.text || '')
          .join('');
        return { text, stopReason: res.stopReason };
      } catch (err) {
        lastErr = err;
        const name = err?.name || err?.__type || '';
        const status = err?.$metadata?.httpStatusCode;
        const retryable = RETRYABLE.has(name) || status === 429 || (status >= 500 && status < 600);
        if (!retryable || attempt === this.maxRetries) break;
        this.usage.retries += 1;
        const delay = Math.min(60_000, 1500 * 2 ** attempt) + Math.random() * 1000;
        await new Promise((r) => setTimeout(r, delay));
        attempt += 1;
      }
    }
    this.usage.failures += 1;
    throw lastErr;
  }
}

/**
 * Extract the first valid JSON object/array from a model response that may
 * include surrounding prose or markdown fences.
 */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    // direct parse
    try { return JSON.parse(trimmed); } catch { /* continue */ }
    // bracket-scan for the outermost object/array
    for (const [open, close] of [['{', '}'], ['[', ']']]) {
      const start = trimmed.indexOf(open);
      if (start === -1) continue;
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { break; }
          }
        }
      }
    }
  }
  return null;
}

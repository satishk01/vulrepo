// AWS Bedrock client for Claude on Bedrock.
// Port of backend/app/bedrock_client.py.

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { settings } from './config.js';
import { getLogger } from './logger.js';

const log = getLogger('bedrock');

const MODEL_ID_MAP = {
  'anthropic.claude-sonnet-4-5': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-opus-4-5':   'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-sonnet-4-5':           'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-opus-4-5':             'us.anthropic.claude-opus-4-5-20251101-v1:0',
};

const RETRYABLE_CODES = new Set([
  'ThrottlingException',
  'ServiceUnavailableException',
  'ModelTimeoutException',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class BedrockClient {
  constructor() {
    this.client = new BedrockRuntimeClient({
      region: settings.awsRegion,
      requestHandler: { requestTimeout: settings.bedrockTimeoutSeconds * 1000 },
      maxAttempts: 1, // No SDK-level retries — we handle retries manually
    });
    this.defaultMaxTokens = settings.bedrockMaxTokens;
    log.info({ region: settings.awsRegion, timeout_s: settings.bedrockTimeoutSeconds }, 'bedrock_client_ready');
  }

  resolveModel(modelId) {
    return MODEL_ID_MAP[modelId] || modelId;
  }

  async invoke({ modelId, prompt, maxTokens, system }) {
    const bedrockModelId = this.resolveModel(modelId);
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens || this.defaultMaxTokens,
      messages: [{ role: 'user', content: prompt }],
    };
    if (system) body.system = system;

    let delay = 1000;
    let lastErr = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now();
      try {
        const cmd = new InvokeModelCommand({
          modelId: bedrockModelId,
          body: JSON.stringify(body),
          contentType: 'application/json',
          accept: 'application/json',
        });
        const resp = await this.client.send(cmd);
        const text = Buffer.from(resp.body).toString('utf-8');
        const result = JSON.parse(text);
        const usage = result.usage || {};
        log.info({
          model: bedrockModelId,
          attempt,
          latency_ms: Date.now() - t0,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
        }, 'bedrock_invoke_ok');

        const content = result.content || [];
        if (!content.length) throw new Error('Bedrock returned empty content');
        return content[0].text || '';
      } catch (err) {
        const code = err.name || 'Unknown';
        lastErr = err;
        log.warn({ code, attempt, message: String(err).slice(0, 300) }, 'bedrock_invoke_error');
        if (!RETRYABLE_CODES.has(code) || attempt === 2) throw err;
        await sleep(delay);
        delay *= 2;
      }
    }
    throw new Error(`Bedrock retries exhausted: ${lastErr}`);
  }
}

let _singleton = null;
export function getBedrock() {
  if (!_singleton) _singleton = new BedrockClient();
  return _singleton;
}

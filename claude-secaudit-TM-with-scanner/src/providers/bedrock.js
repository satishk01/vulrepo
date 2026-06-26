import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { withRetries, newUsage } from './base.js';

/**
 * AWS Bedrock provider (retained from the original tool).
 * Credentials: standard AWS credential chain (env vars, shared config/SSO,
 * IAM role). Optionally a named profile via `profile`.
 */
export class BedrockProvider {
  constructor({ region, profile, maxRetries, requestTimeoutMs }) {
    if (profile) process.env.AWS_PROFILE = profile;
    this.region = region;
    this.client = new BedrockRuntimeClient({
      region,
      requestHandler: { requestTimeout: requestTimeoutMs },
    });
    this.maxRetries = maxRetries;
    this.usage = newUsage();
  }

  async converse({ modelId, system, userText, maxTokens, temperature = 0 }) {
    const result = await withRetries(async () => {
      const cmd = new ConverseCommand({
        modelId,
        system: [{ text: system }],
        messages: [{ role: 'user', content: [{ text: userText }] }],
        inferenceConfig: { maxTokens, temperature },
      });
      const res = await this.client.send(cmd);
      const text = (res.output?.message?.content || []).map((b) => b.text || '').join('');
      return { text, stopReason: res.stopReason, usage: res.usage };
    }, { maxRetries: this.maxRetries, onRetry: () => { this.usage.retries += 1; } });

    this.usage.requests += 1;
    this.usage.inputTokens += result.usage?.inputTokens ?? 0;
    this.usage.outputTokens += result.usage?.outputTokens ?? 0;
    return { text: result.text, stopReason: result.stopReason };
  }
}

import { BedrockProvider } from './bedrock.js';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { newUsage } from './base.js';

/**
 * MultiProviderClient — a drop-in replacement for the original BedrockClient.
 *
 * It exposes the SAME contract the analyzer relies on:
 *     await client.converse({ modelId, system, userText, maxTokens, temperature })
 *
 * ...but routes each call to the correct provider based on the model's
 * `provider` field. Providers are created lazily (only when first used) so a
 * scan that only touches Bedrock never needs Google/Azure/etc. credentials.
 *
 * Each resolved model object is { alias, provider, modelId }. The analyzer
 * passes `model.id` as `modelId`; we keep both `.id` and `.modelId` populated.
 *
 * Usage from all sub-providers is aggregated into `client.usage` so the report
 * and console summary work unchanged.
 */
export class MultiProviderClient {
  constructor(opts) {
    this.opts = opts;                 // { region, profile, maxRetries, requestTimeoutMs }
    this.providers = new Map();       // provider key -> instance
    this.usage = newUsage();
  }

  _provider(name) {
    if (this.providers.has(name)) return this.providers.get(name);
    let inst;
    switch (name) {
      case 'bedrock':
        inst = new BedrockProvider(this.opts);
        break;
      case 'anthropic':
        inst = new AnthropicProvider(this.opts);
        break;
      case 'google':
        inst = new GoogleProvider('google', this.opts);
        break;
      case 'vertex':
        inst = new GoogleProvider('vertex', this.opts);
        break;
      case 'openrouter':
        inst = new OpenAICompatProvider('openrouter', this.opts);
        break;
      case 'azure':
        inst = new OpenAICompatProvider('azure', this.opts);
        break;
      case 'ollama':
        inst = new OpenAICompatProvider('ollama', this.opts);
        break;
      default:
        throw new Error(`Unknown provider "${name}".`);
    }
    this.providers.set(name, inst);
    return inst;
  }

  /**
   * Validate that every provider needed by `models` can be constructed
   * (i.e. required credentials are present) BEFORE the scan starts. Throws a
   * single, clear error listing what's missing.
   */
  preflight(models) {
    const needed = new Set(models.map((m) => m.provider));
    const errors = [];
    for (const name of needed) {
      try { this._provider(name); } catch (err) { errors.push(`  • ${name}: ${err.message}`); }
    }
    if (errors.length) {
      throw new Error(`Missing credentials/config for selected providers:\n${errors.join('\n')}`);
    }
  }

  async converse({ provider, modelId, system, userText, maxTokens, temperature = 0 }) {
    const inst = this._provider(provider);
    const before = { i: inst.usage.inputTokens, o: inst.usage.outputTokens, r: inst.usage.requests, rt: inst.usage.retries, f: inst.usage.failures };
    try {
      const out = await inst.converse({ modelId, system, userText, maxTokens, temperature });
      return out;
    } catch (err) {
      this.usage.failures += 1;
      throw err;
    } finally {
      // fold the delta from this provider into the aggregate usage
      this.usage.inputTokens += inst.usage.inputTokens - before.i;
      this.usage.outputTokens += inst.usage.outputTokens - before.o;
      this.usage.requests += inst.usage.requests - before.r;
      this.usage.retries += inst.usage.retries - before.rt;
    }
  }

  /** Per-provider usage breakdown for the report. */
  usageByProvider() {
    const out = {};
    for (const [name, inst] of this.providers) out[name] = { ...inst.usage };
    return out;
  }
}

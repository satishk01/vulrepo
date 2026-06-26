/**
 * Provider + model registry (BYOK).
 *
 * A "model alias" is a short, stable name the user types on the CLI
 * (e.g. `opus-4.8`, `gemini-3.5-or`, `azure-gpt5.5`). Each alias resolves to:
 *
 *   { provider: 'bedrock'|'anthropic'|'google'|'vertex'|'openrouter'|'azure'|'ollama',
 *     modelId:  '<provider-specific model id>' }
 *
 * Nothing here holds a secret. All credentials are supplied by the USER at
 * runtime via environment variables (BYOK). See README "Credentials".
 *
 * You can add/override any alias without editing this file by creating a
 * `secaudit.config.json` with a `models` map (see secaudit.config.example.json).
 *
 * NOTE ON MODEL IDS: provider model IDs and version strings change over time.
 * The defaults below reflect the names requested for this build; verify the
 * exact IDs enabled in YOUR account/region and override in secaudit.config.json
 * if a call returns "model not found".
 */

export const PROVIDERS = ['bedrock', 'anthropic', 'google', 'vertex', 'openrouter', 'azure', 'ollama'];

/**
 * Built-in aliases. Format: alias -> { provider, modelId }
 * Grouped by provider for readability.
 */
export const MODEL_REGISTRY = {
  // ─── AWS Bedrock (retained — original behaviour) ───────────────────────
  // These are Bedrock model IDs / inference-profile IDs. Verify with:
  //   aws bedrock list-foundation-models --by-provider anthropic
  //   aws bedrock list-inference-profiles
  'bedrock-sonnet-4.5': { provider: 'bedrock', modelId: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0' },
  'bedrock-opus-4.5':   { provider: 'bedrock', modelId: 'us.anthropic.claude-opus-4-5-20251101-v1:0' },
  'bedrock-opus-4.7':   { provider: 'bedrock', modelId: 'global.anthropic.claude-opus-4-7-v1:0' },
  'bedrock-opus-4.8':   { provider: 'bedrock', modelId: 'global.anthropic.claude-opus-4-8-v1:0' },
  // Back-compat aliases from the original tool:
  'sonnet-4.5':         { provider: 'bedrock', modelId: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0' },
  'opus-4.6':           { provider: 'bedrock', modelId: 'global.anthropic.claude-opus-4-6-v1:0' },
  'fable-5':            { provider: 'bedrock', modelId: 'global.anthropic.claude-fable-5-v1:0' },

  // ─── Anthropic API (direct, ANTHROPIC_API_KEY) ─────────────────────────
  'anthropic-4.5':      { provider: 'anthropic', modelId: 'claude-sonnet-4-5-20250929' },
  'anthropic-opus-4.7': { provider: 'anthropic', modelId: 'claude-opus-4-7' },
  'anthropic-opus-4.8': { provider: 'anthropic', modelId: 'claude-opus-4-8' },
  'opus-4.7':           { provider: 'anthropic', modelId: 'claude-opus-4-7' },
  'opus-4.8':           { provider: 'anthropic', modelId: 'claude-opus-4-8' },

  // ─── Google Gemini (direct, GOOGLE_API_KEY) ────────────────────────────
  'gemini-3.5':         { provider: 'google', modelId: 'gemini-3.5-pro' },
  'gemini-3.5-flash':   { provider: 'google', modelId: 'gemini-3.5-flash' },

  // ─── Google Vertex AI (GCP project + ADC) ──────────────────────────────
  'vertex-gemini-3.5':  { provider: 'vertex', modelId: 'gemini-3.5-pro' },

  // ─── OpenRouter (OPENROUTER_API_KEY) — unified gateway ─────────────────
  'glm-5.2-or':         { provider: 'openrouter', modelId: 'z-ai/glm-5.2' },
  'anthropic-4.5-or':   { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' },
  'gemini-3.5-or':      { provider: 'openrouter', modelId: 'google/gemini-3.5-pro' },
  'opus-4.8-or':        { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.8' },

  // ─── Azure OpenAI (AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY) ───────
  // modelId here is your Azure *deployment name*. Override in config to match
  // the deployment names you created in your Azure OpenAI resource.
  'azure-gpt4':         { provider: 'azure', modelId: 'gpt-4' },
  'azure-gpt5.5':       { provider: 'azure', modelId: 'gpt-5.5' },

  // ─── Ollama (local, OLLAMA_HOST, no key) ───────────────────────────────
  'ollama-qwen':        { provider: 'ollama', modelId: 'qwen2.5-coder:32b' },
  'ollama-llama':       { provider: 'ollama', modelId: 'llama3.3' },
};

/**
 * Resolve a user-supplied name into { alias, provider, modelId }.
 *
 * Resolution order:
 *   1. user config `models` map         (secaudit.config.json)
 *   2. built-in MODEL_REGISTRY
 *   3. explicit "provider:modelId" syntax (e.g. "openrouter:z-ai/glm-5.2")
 *   4. fall back: treat as a raw Bedrock model id (back-compat)
 */
export function resolveModel(name, userConfig) {
  const raw = String(name).trim();
  const userModels = userConfig?.models || {};

  // 1. user config alias
  if (userModels[raw]) {
    const entry = normalizeEntry(userModels[raw]);
    if (entry) return { alias: raw, ...entry };
  }

  // 2. built-in alias
  if (MODEL_REGISTRY[raw]) {
    return { alias: raw, ...MODEL_REGISTRY[raw] };
  }

  // 3. explicit provider:modelId
  const colon = raw.indexOf(':');
  if (colon > 0) {
    const maybeProvider = raw.slice(0, colon);
    if (PROVIDERS.includes(maybeProvider)) {
      return { alias: raw, provider: maybeProvider, modelId: raw.slice(colon + 1) };
    }
  }

  // 4. back-compat: bare string => Bedrock model id
  return { alias: raw, provider: 'bedrock', modelId: raw };
}

function normalizeEntry(entry) {
  if (typeof entry === 'string') {
    // allow "provider:modelId" or bare bedrock id in config values too
    const colon = entry.indexOf(':');
    if (colon > 0 && PROVIDERS.includes(entry.slice(0, colon))) {
      return { provider: entry.slice(0, colon), modelId: entry.slice(colon + 1) };
    }
    return { provider: 'bedrock', modelId: entry };
  }
  if (entry && typeof entry === 'object' && entry.provider && entry.modelId) {
    return { provider: entry.provider, modelId: entry.modelId };
  }
  return null;
}

import { withRetries, newUsage, postJson } from './base.js';

/**
 * Google Gemini provider with two transports:
 *
 *   kind 'google' : Generative Language API, BYOK via GOOGLE_API_KEY
 *                   (also accepts GEMINI_API_KEY).
 *                   URL: https://generativelanguage.googleapis.com/v1beta/...
 *
 *   kind 'vertex' : Vertex AI on GCP. Uses a bearer access token from
 *                   GOOGLE_VERTEX_ACCESS_TOKEN (obtain via
 *                   `gcloud auth print-access-token`) plus
 *                   GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.
 *
 * Both speak the same generateContent request/response shape.
 */
export class GoogleProvider {
  constructor(kind, { maxRetries, requestTimeoutMs }) {
    this.kind = kind;
    this.maxRetries = maxRetries;
    this.timeoutMs = requestTimeoutMs;
    this.usage = newUsage();

    if (kind === 'google') {
      this.apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
      this.baseUrl = (process.env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
      if (!this.apiKey) throw new Error('GOOGLE_API_KEY (or GEMINI_API_KEY) is not set (required for provider "google").');
    } else if (kind === 'vertex') {
      this.accessToken = process.env.GOOGLE_VERTEX_ACCESS_TOKEN;
      this.project = process.env.GOOGLE_CLOUD_PROJECT;
      this.location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
      if (!this.accessToken) throw new Error('GOOGLE_VERTEX_ACCESS_TOKEN is not set (run: gcloud auth print-access-token).');
      if (!this.project) throw new Error('GOOGLE_CLOUD_PROJECT is not set (required for provider "vertex").');
    } else {
      throw new Error(`Unknown Google provider kind: ${kind}`);
    }
  }

  _urlAndHeaders(modelId) {
    if (this.kind === 'vertex') {
      const host = `https://${this.location}-aiplatform.googleapis.com`;
      const url = `${host}/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${encodeURIComponent(modelId)}:generateContent`;
      return { url, headers: { authorization: `Bearer ${this.accessToken}` } };
    }
    const url = `${this.baseUrl}/models/${encodeURIComponent(modelId)}:generateContent?key=${this.apiKey}`;
    return { url, headers: {} };
  }

  async converse({ modelId, system, userText, maxTokens, temperature = 0 }) {
    const { url, headers } = this._urlAndHeaders(modelId);
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    };

    const data = await withRetries(() => postJson(url, {
      headers, body, timeoutMs: this.timeoutMs,
    }), { maxRetries: this.maxRetries, onRetry: () => { this.usage.retries += 1; } });

    const cand = (data.candidates && data.candidates[0]) || {};
    const text = (cand.content?.parts || []).map((p) => p.text || '').join('');
    const um = data.usageMetadata || {};
    this.usage.requests += 1;
    this.usage.inputTokens += um.promptTokenCount ?? 0;
    this.usage.outputTokens += um.candidatesTokenCount ?? 0;
    return { text, stopReason: cand.finishReason };
  }
}

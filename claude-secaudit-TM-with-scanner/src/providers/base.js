/**
 * Shared retry + usage helpers used by every provider client.
 * Keeps the manual exponential-backoff-with-jitter behaviour from the
 * original Bedrock implementation, generalised across HTTP and SDK errors.
 */

export const DEFAULT_RETRYABLE_NAMES = new Set([
  'ThrottlingException',
  'ServiceUnavailableException',
  'ModelTimeoutException',
  'InternalServerException',
  'ModelNotReadyException',
  'TooManyRequestsException',
]);

export function isRetryable(err) {
  const name = err?.name || err?.__type || '';
  const status = err?.status ?? err?.$metadata?.httpStatusCode;
  if (DEFAULT_RETRYABLE_NAMES.has(name)) return true;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  // network-level
  if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(err?.code)) return true;
  return false;
}

/**
 * Run `fn` (an async producing the result) with retries.
 * `onRetry` is called each time a retry is scheduled (to bump usage counters).
 */
export async function withRetries(fn, { maxRetries, onRetry }) {
  let attempt = 0;
  let lastErr;
  while (attempt <= maxRetries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxRetries) break;
      if (onRetry) onRetry();
      const delay = Math.min(60_000, 1500 * 2 ** attempt) + Math.random() * 1000;
      await new Promise((r) => setTimeout(r, delay));
      attempt += 1;
    }
  }
  throw lastErr;
}

/** Base usage accumulator shared by all clients. */
export function newUsage() {
  return { inputTokens: 0, outputTokens: 0, requests: 0, retries: 0, failures: 0 };
}

/** Minimal fetch wrapper that throws an Error carrying `.status` for retry logic. */
export async function postJson(url, { headers, body, timeoutMs }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(t);
    // normalise abort to a retryable timeout
    if (err.name === 'AbortError') {
      const e = new Error('Request timed out');
      e.code = 'ETIMEDOUT';
      throw e;
    }
    throw err;
  }
  clearTimeout(t);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Extract the first valid JSON object/array from a model response that may
 * include surrounding prose or markdown fences. (Moved here so it is shared
 * across all providers.)
 */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    try { return JSON.parse(trimmed); } catch { /* continue */ }
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

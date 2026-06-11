// Configuration. Loads from .env (via dotenv) and exposes a frozen settings object.
// Mirrors backend/app/config.py.

import 'dotenv/config';

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v, fallback) => {
  if (v === undefined || v === null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

export const settings = Object.freeze({
  // AWS / Bedrock
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  bedrockDefaultModel: process.env.BEDROCK_DEFAULT_MODEL || 'anthropic.claude-sonnet-4-5',
  bedrockMaxTokens: num(process.env.BEDROCK_MAX_TOKENS, 8192),
  bedrockAnalysisMaxTokens: num(process.env.BEDROCK_ANALYSIS_MAX_TOKENS, 16384),
  bedrockTimeoutSeconds: num(process.env.BEDROCK_TIMEOUT, 180),

  // Analysis batching: findings per AI call. At/below this count we use the
  // original single-call path; above it we batch + merge to avoid output
  // truncation (which previously broke the dashboard on large scans).
  analysisBatchSize: num(process.env.ANALYSIS_BATCH_SIZE, 8),

  // Persistence — "s3" or "local"
  storageBackend: (process.env.STORAGE_BACKEND || 's3').toLowerCase(),
  s3Bucket: process.env.S3_BUCKET || '',
  s3Prefix: (process.env.S3_PREFIX || 'uem').replace(/\/+$/, ''),
  localStorageDir: process.env.LOCAL_STORAGE_DIR || '',

  // Secrets
  githubTokenSecretArn: process.env.GITHUB_TOKEN_SECRET_ARN || null,
  githubTokenEnv: process.env.GITHUB_TOKEN || null,

  // Workspace
  workspaceDir: process.env.WORKSPACE_DIR || (process.platform === 'win32' ? 'C:\\uem-workspace' : '/tmp/uem-workspace'),
  maxRepoSizeMb: num(process.env.MAX_REPO_SIZE_MB, 500),
  maxZipSizeMb: num(process.env.MAX_ZIP_SIZE_MB, 200),
  maxFindingsPerScan: num(process.env.MAX_FINDINGS_PER_SCAN, 2000),
  maxUploadBytes: 50 * 1024 * 1024, // 50 MB hard cap on /upload/scan and pentest

  // Server behavior
  port: num(process.env.PORT, 8000),
  host: process.env.HOST || '127.0.0.1',
  rateLimitPerMinute: num(process.env.RATE_LIMIT_PER_MINUTE, 120),
  corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS || '*',
  environment: process.env.ENVIRONMENT || 'dev',
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
});

export function corsOriginList() {
  const v = settings.corsAllowedOrigins.trim();
  if (v === '*') return '*';
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

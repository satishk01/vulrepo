/**
 * Central configuration for claude-secaudit.
 *
 * MODEL IDS: Bedrock model IDs change as AWS releases new versions and
 * regions adopt inference profiles. The aliases below ship with sensible
 * defaults, but you can (and should) verify the exact IDs available in
 * YOUR account/region via:
 *
 *   aws bedrock list-foundation-models --by-provider anthropic --query "modelSummaries[].modelId"
 *   aws bedrock list-inference-profiles --query "inferenceProfileSummaries[].inferenceProfileId"
 *
 * Override any alias without touching code by creating a
 * `secaudit.config.json` in your working directory (see README) or by
 * passing a raw model ID directly to --models.
 */

export const MODEL_ALIASES = {
  // Claude Sonnet 4.5 — fast, strong default for per-file analysis
  'sonnet-4.5': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',

  // Claude Opus 4.x — deepest single-pass reasoning.
  // NOTE: verify the exact Opus version/ID enabled in your Bedrock account
  // (e.g. an Opus 4.6 ID if/when available in your region) and override in
  // secaudit.config.json if it differs.
  'opus-4.6': 'global.anthropic.claude-opus-4-6-v1:0',

  // Claude Fable 5 — Anthropic's newest tier. Verify availability/ID in
  // your Bedrock console and override if needed.
  'fable-5': 'global.anthropic.claude-fable-5-v1:0',
};

export const DEFAULTS = {
  region: process.env.AWS_REGION || 'us-east-1',
  models: ['sonnet-4.5'],
  concurrency: 4,
  maxFileBytes: 300 * 1024,        // skip single files larger than this
  maxChunkChars: 60_000,           // ~15k tokens per chunk
  chunkOverlapLines: 40,
  maxTokensPerResponse: 8192,
  maxRetries: 6,
  requestTimeoutMs: 300_000,
  crossFileBatchChars: 90_000,     // budget for the architecture pass
  outputDir: 'secaudit-report',
};

/** File extensions treated as analyzable source code. */
export const CODE_EXTENSIONS = new Set([
  // web / scripting
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.rb', '.php', '.pl', '.lua',
  // jvm / .net / systems
  '.java', '.kt', '.kts', '.scala', '.groovy',
  '.cs', '.vb', '.fs',
  '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.m', '.mm', '.swift',
  // mobile / other
  '.dart', '.ex', '.exs', '.erl', '.clj', '.r',
  // templates (XSS / SSTI surface)
  '.html', '.htm', '.ejs', '.erb', '.hbs', '.mustache', '.jinja', '.jinja2', '.twig', '.jsp', '.cshtml', '.razor',
  // data / infra-as-code / config (secrets, misconfig surface)
  '.sql', '.graphql', '.proto',
  '.tf', '.tfvars', '.bicep',
  '.yml', '.yaml', '.json', '.toml', '.ini', '.cfg', '.conf', '.env', '.properties', '.xml',
  '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd',
  '.dockerfile', '.gradle',
]);

/** Basenames always analyzed even without a known extension. */
export const CODE_BASENAMES = new Set([
  'dockerfile', 'makefile', 'jenkinsfile', 'vagrantfile', 'procfile',
  '.env', '.env.local', '.env.production', '.env.development', '.env.staging',
  '.npmrc', '.htaccess', 'web.config', 'nginx.conf',
]);

/** Default ignore globs (merged with .gitignore when present). */
export const DEFAULT_IGNORES = [
  '**/node_modules/**', '**/bower_components/**', '**/vendor/**',
  '**/.git/**', '**/.svn/**', '**/.hg/**',
  '**/dist/**', '**/build/**', '**/out/**', '**/target/**', '**/bin/Debug/**', '**/bin/Release/**', '**/obj/**',
  '**/.next/**', '**/.nuxt/**', '**/.output/**', '**/coverage/**', '**/.nyc_output/**',
  '**/__pycache__/**', '**/*.pyc', '**/.venv/**', '**/venv/**', '**/env/**', '**/.tox/**',
  '**/*.min.js', '**/*.min.css', '**/*.map', '**/*.bundle.js',
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/poetry.lock', '**/Cargo.lock', '**/composer.lock', '**/Gemfile.lock',
  '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp', '**/*.svg', '**/*.ico',
  '**/*.pdf', '**/*.zip', '**/*.tar', '**/*.gz', '**/*.7z', '**/*.rar',
  '**/*.woff', '**/*.woff2', '**/*.ttf', '**/*.eot', '**/*.otf',
  '**/*.mp3', '**/*.mp4', '**/*.avi', '**/*.mov',
  '**/*.exe', '**/*.dll', '**/*.so', '**/*.dylib', '**/*.class', '**/*.jar', '**/*.war',
  '**/.idea/**', '**/.vscode/**', '**/.DS_Store',
  '**/secaudit-report/**',
];

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

export const SEVERITY_META = {
  critical: { label: 'Critical', color: '#c0392b', rank: 0 },
  high:     { label: 'High',     color: '#d35400', rank: 1 },
  medium:   { label: 'Medium',   color: '#b7950b', rank: 2 },
  low:      { label: 'Low',      color: '#2471a3', rank: 3 },
  info:     { label: 'Info',     color: '#717d7e', rank: 4 },
};

/** Load optional user config overrides from secaudit.config.json. */
export async function loadUserConfig(cwd) {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const candidates = [path.join(cwd, 'secaudit.config.json')];
  for (const file of candidates) {
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      return { file, ...parsed };
    } catch {
      /* not present or invalid — ignore */
    }
  }
  return null;
}

export function resolveModelId(nameOrId, userConfig) {
  const merged = { ...MODEL_ALIASES, ...(userConfig?.modelAliases || {}) };
  if (merged[nameOrId]) return { alias: nameOrId, id: merged[nameOrId] };
  // Treat anything containing a dot+provider pattern or colon as a raw Bedrock ID
  return { alias: nameOrId, id: nameOrId };
}

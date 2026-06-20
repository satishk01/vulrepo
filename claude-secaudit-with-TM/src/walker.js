import fg from 'fast-glob';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { CODE_EXTENSIONS, CODE_BASENAMES, DEFAULT_IGNORES } from './config.js';

/** Convert .gitignore lines into fast-glob ignore patterns (best effort). */
async function gitignorePatterns(root) {
  try {
    const raw = await readFile(path.join(root, '.gitignore'), 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
      .map((l) => {
        const p = l.replace(/^\//, '').replace(/\/$/, '');
        if (!p.includes('/')) return [`**/${p}`, `**/${p}/**`];
        return [p, `${p}/**`];
      })
      .flat();
  } catch {
    return [];
  }
}

function isAnalyzable(relPath) {
  const base = path.basename(relPath).toLowerCase();
  if (CODE_BASENAMES.has(base)) return true;
  const ext = path.extname(base).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

/** Cheap binary sniff: NUL byte in the first 8KB. */
function looksBinary(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function classify(relPath) {
  const p = relPath.toLowerCase();
  const ext = path.extname(p);
  if (/(^|\/)(test|tests|spec|__tests__|__mocks__)(\/|\.)/.test(p) || /\.(test|spec)\.[a-z]+$/.test(p)) return 'test';
  if (['.tf', '.tfvars', '.bicep'].includes(ext) || p.includes('dockerfile') || /(^|\/)(helm|k8s|kubernetes|terraform|cloudformation|ansible)\//.test(p)) return 'infra';
  if (['.yml', '.yaml', '.json', '.toml', '.ini', '.cfg', '.conf', '.env', '.properties', '.xml'].includes(ext) || path.basename(p).startsWith('.env')) return 'config';
  if (['.html', '.htm', '.ejs', '.erb', '.hbs', '.mustache', '.jinja', '.jinja2', '.twig', '.jsp', '.cshtml', '.razor'].includes(ext)) return 'template';
  if (['.sql'].includes(ext)) return 'database';
  if (['.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd'].includes(ext)) return 'script';
  return 'source';
}

/**
 * Discover analyzable files under `root`.
 * Returns [{ absPath, relPath, size, category }]
 */
export async function discoverFiles(root, { include = [], exclude = [], maxFileBytes }) {
  const gitIgnores = await gitignorePatterns(root);
  const ignore = [...DEFAULT_IGNORES, ...gitIgnores, ...exclude];
  const patterns = include.length ? include : ['**/*'];

  const entries = await fg(patterns, {
    cwd: root,
    ignore,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  });

  const files = [];
  for (const rel of entries) {
    if (!isAnalyzable(rel)) continue;
    const abs = path.join(root, rel);
    try {
      const st = await stat(abs);
      if (st.size === 0) continue;
      if (st.size > maxFileBytes) {
        files.push({ absPath: abs, relPath: rel, size: st.size, category: classify(rel), skipped: 'too-large' });
        continue;
      }
      files.push({ absPath: abs, relPath: rel, size: st.size, category: classify(rel) });
    } catch {
      /* unreadable — skip */
    }
  }
  // Stable order: source code first (highest signal), then templates, db, scripts, config/infra, tests last.
  const order = { source: 0, template: 1, database: 2, script: 3, infra: 4, config: 5, test: 6 };
  files.sort((a, b) => (order[a.category] - order[b.category]) || a.relPath.localeCompare(b.relPath));
  return files;
}

/** Read a file and split it into numbered-line chunks within the char budget. */
export async function readFileChunks(file, { maxChunkChars, chunkOverlapLines }) {
  const buf = await readFile(file.absPath);
  if (looksBinary(buf)) return [];
  const text = buf.toString('utf8');
  const lines = text.split('\n');

  const numbered = lines.map((l, i) => `${String(i + 1).padStart(5, ' ')} | ${l}`);
  const chunks = [];
  let start = 0;
  while (start < numbered.length) {
    let charCount = 0;
    let end = start;
    while (end < numbered.length && charCount + numbered[end].length + 1 <= maxChunkChars) {
      charCount += numbered[end].length + 1;
      end++;
    }
    if (end === start) end = start + 1; // single pathological long line
    chunks.push({
      startLine: start + 1,
      endLine: end,
      content: numbered.slice(start, end).join('\n'),
      ofTotalLines: numbered.length,
    });
    if (end >= numbered.length) break;
    start = Math.max(end - chunkOverlapLines, start + 1);
  }
  return chunks;
}

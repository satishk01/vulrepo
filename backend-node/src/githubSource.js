// GitHub source connector. Port of backend/app/github_source.py.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { settings } from './config.js';
import { getLogger } from './logger.js';

const log = getLogger('github');

const GITHUB_URL_RE = /^https:\/\/(?:[\w.-]+@)?github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i;

export class GitHubScanError extends Error {
  constructor(msg) { super(msg); this.name = 'GitHubScanError'; }
}

export function validateRepoUrl(url) {
  if (!url || typeof url !== 'string') throw new GitHubScanError('repo_url is required');
  const trimmed = url.trim();
  if (!GITHUB_URL_RE.test(trimmed)) {
    throw new GitHubScanError('Invalid GitHub URL. Expected https://github.com/<owner>/<repo>');
  }
  const u = new URL(trimmed);
  let p = u.pathname.replace(/\/+$/, '');
  if (p.endsWith('.git')) p = p.slice(0, -4);
  return `https://github.com${p}`;
}

function authUrl(url, token) {
  if (!token) return url;
  const u = new URL(url);
  u.username = 'x-access-token';
  u.password = token;
  return u.toString();
}

function runCmd(cmd, args, { cwd, timeoutMs = 300_000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ returncode: -1, stdout, stderr: stderr + '\n' + String(err), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ returncode: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

async function dirSizeMb(dir) {
  let total = 0;
  async function walk(d) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try { const s = await stat(p); total += s.size; } catch {}
      }
    }
  }
  await walk(dir);
  return total / (1024 * 1024);
}

async function rmrf(p) {
  try { await fs.rm(p, { recursive: true, force: true }); } catch {}
}

export async function cloneRepo(repoUrl, branch, token) {
  const canonical = validateRepoUrl(repoUrl);
  await fs.mkdir(settings.workspaceDir, { recursive: true });
  const workspace = await mkdtemp(path.join(settings.workspaceDir, 'uem-'));
  const repoPath = path.join(workspace, 'repo');
  const cloneUrl = authUrl(canonical, token);

  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(cloneUrl, repoPath);

  const res = await runCmd('git', args, { timeoutMs: 300_000 });
  if (res.returncode !== 0) {
    let errMsg = res.stderr || '';
    if (token) errMsg = errMsg.replaceAll(token, '***');
    await rmrf(workspace);
    throw new GitHubScanError(`git clone failed: ${errMsg.trim().slice(0, 500)}`);
  }

  const sizeMb = await dirSizeMb(repoPath);
  if (sizeMb > settings.maxRepoSizeMb) {
    await rmrf(workspace);
    throw new GitHubScanError(`Repository is ${Math.round(sizeMb)} MB, exceeds limit of ${settings.maxRepoSizeMb} MB`);
  }

  const sha = await runCmd('git', ['rev-parse', 'HEAD'], { cwd: repoPath, timeoutMs: 10_000 });
  const commitSha = sha.returncode === 0 ? sha.stdout.trim() : 'unknown';

  log.info({ repo_url: canonical, branch: branch || 'default', commit_sha: commitSha, size_mb: Math.round(sizeMb * 10) / 10 }, 'repo_cloned');
  return { workspace, commitSha, repoPath };
}

export async function runSemgrep(repoPath, ruleset = 'p/default') {
  const res = await runCmd('semgrep', ['scan', '--config', ruleset, '--sarif', '--quiet', '--metrics=off', repoPath], { timeoutMs: 1800_000 });
  if (![0, 1].includes(res.returncode)) {
    throw new GitHubScanError(`semgrep failed (rc=${res.returncode}): ${(res.stderr || '').trim().slice(0, 500)}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch (e) {
    throw new GitHubScanError(`semgrep produced invalid JSON: ${e.message}`);
  }
}

export async function scanRepo(repoUrl, branch, token) {
  const clone = await cloneRepo(repoUrl, branch, token);
  try {
    const sarif = await runSemgrep(clone.repoPath);
    sarif._uem_context = sarif._uem_context || {};
    Object.assign(sarif._uem_context, {
      repo_url: validateRepoUrl(repoUrl),
      branch: branch || 'default',
      commit_sha: clone.commitSha,
    });
    return sarif;
  } finally {
    await rmrf(clone.workspace);
  }
}

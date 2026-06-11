// Local filesystem-backed repository. Port of backend/app/local_persistence.py.
// Same public interface as S3Repository so callers don't care which is in use.

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { settings } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger('local-repo');
const nowIso = () => new Date().toISOString();

export class LocalRepository {
  constructor() {
    if (!settings.localStorageDir) {
      throw new Error('LOCAL_STORAGE_DIR env var is required for STORAGE_BACKEND=local');
    }
    this.root = path.resolve(settings.localStorageDir);
    this.prefix = settings.s3Prefix;
    fssync.mkdirSync(this.root, { recursive: true });
    log.info({ root: this.root, prefix: this.prefix }, 'local_repository_ready');
  }

  _p(...parts) {
    return path.join(this.root, this.prefix, ...parts);
  }

  async _putJson(p, body) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(body, null, 2), 'utf-8');
  }

  async _getJson(p) {
    try {
      const data = await fs.readFile(p, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      log.warn({ path: p, error: String(err) }, 'local_read_failed');
      return null;
    }
  }

  async _delete(p) {
    try {
      await fs.rm(p, { recursive: true, force: true });
    } catch (err) {
      log.warn({ path: p, error: String(err) }, 'local_delete_failed');
    }
  }

  async _listJsonIn(dir, limit) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const files = [];
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.json')) {
        const fp = path.join(dir, e.name);
        const stat = await fs.stat(fp);
        files.push({ path: fp, mtime: stat.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return files.slice(0, limit).map((f) => f.path);
  }

  // ---- Sources ----
  async putSource(sourceId, item) {
    const record = { source_id: sourceId, created_at: item.created_at || nowIso(), updated_at: nowIso(), ...item };
    await this._putJson(this._p('sources', `${sourceId}.json`), record);
    return record;
  }
  async getSource(sourceId) {
    return this._getJson(this._p('sources', `${sourceId}.json`));
  }
  async listSources(limit = 100) {
    const files = await this._listJsonIn(this._p('sources'), limit);
    const out = [];
    for (const f of files) {
      const data = await this._getJson(f);
      if (data) out.push(data);
    }
    return out;
  }
  async deleteSource(sourceId) {
    await this._delete(this._p('sources', `${sourceId}.json`));
  }

  // ---- Scans ----
  async putScan(scanId, item) {
    const record = { scan_id: scanId, created_at: item.created_at || nowIso(), updated_at: nowIso(), ...item };
    await this._putJson(this._p('scans', scanId, 'scan.json'), record);
    return record;
  }
  async getScan(scanId) {
    return this._getJson(this._p('scans', scanId, 'scan.json'));
  }
  async listScans(limit = 50) {
    const scansDir = this._p('scans');
    let entries;
    try {
      entries = await fs.readdir(scansDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const dirs = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        const fp = path.join(scansDir, e.name);
        const stat = await fs.stat(fp);
        dirs.push({ path: fp, mtime: stat.mtimeMs });
      }
    }
    dirs.sort((a, b) => b.mtime - a.mtime);
    const out = [];
    for (const d of dirs.slice(0, limit)) {
      const data = await this._getJson(path.join(d.path, 'scan.json'));
      if (data) out.push(data);
    }
    return out;
  }

  // ---- Findings ----
  async putFindings(scanId, findings) {
    const fs2 = findings || [];
    const body = { scan_id: scanId, count: fs2.length, written_at: nowIso(), findings: fs2 };
    await this._putJson(this._p('scans', scanId, 'findings.json'), body);
    return fs2.length;
  }
  async listFindings(scanId, limit = 500) {
    const body = await this._getJson(this._p('scans', scanId, 'findings.json'));
    if (!body) return [];
    return (body.findings || []).slice(0, limit);
  }

  // ---- Analyses ----
  async putAnalysis(scanId, analysis, modelUsed) {
    const record = { scan_id: scanId, model_used: modelUsed, analyzed_at: nowIso(), analysis };
    await this._putJson(this._p('scans', scanId, 'analysis.json'), record);
    return record;
  }
  async getAnalysis(scanId) {
    return this._getJson(this._p('scans', scanId, 'analysis.json'));
  }

  // ---- Jobs ----
  async putJob(jobId, item) {
    const record = { job_id: jobId, created_at: item.created_at || nowIso(), updated_at: nowIso(), ...item };
    await this._putJson(this._p('jobs', `${jobId}.json`), record);
    return record;
  }
  async updateJob(jobId, updates) {
    const current = (await this.getJob(jobId)) || { job_id: jobId, created_at: nowIso() };
    Object.assign(current, updates);
    current.updated_at = nowIso();
    await this._putJson(this._p('jobs', `${jobId}.json`), current);
    return current;
  }
  async getJob(jobId) {
    return this._getJson(this._p('jobs', `${jobId}.json`));
  }
  async listJobs(limit = 50) {
    const files = await this._listJsonIn(this._p('jobs'), limit);
    const out = [];
    for (const f of files) {
      const data = await this._getJson(f);
      if (data) out.push(data);
    }
    return out;
  }
}

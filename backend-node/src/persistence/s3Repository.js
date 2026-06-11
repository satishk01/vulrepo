// S3-backed repository. Port of backend/app/persistence.py.

import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { settings } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger('s3-repo');
const nowIso = () => new Date().toISOString();

const streamToString = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
};

export class S3Repository {
  constructor() {
    if (!settings.s3Bucket) throw new Error('S3_BUCKET env var is required');
    this.bucket = settings.s3Bucket;
    this.prefix = settings.s3Prefix;
    this.s3 = new S3Client({ region: settings.awsRegion });
    log.info({ bucket: this.bucket, prefix: this.prefix }, 's3_repository_ready');
  }

  _key(...parts) {
    return [this.prefix, ...parts].join('/');
  }

  async _putJson(key, body) {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: JSON.stringify(body, null, 2),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));
  }

  async _getJson(key) {
    try {
      const resp = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const text = await streamToString(resp.Body);
      return JSON.parse(text);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async _delete(key) {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      log.warn({ key, error: String(err) }, 's3_delete_failed');
    }
  }

  async _listObjects(prefix, limit) {
    const out = [];
    let ContinuationToken;
    do {
      const resp = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: prefix, ContinuationToken,
      }));
      for (const obj of resp.Contents || []) {
        out.push({ Key: obj.Key, LastModified: obj.LastModified, Size: obj.Size });
        if (out.length >= limit) return out;
      }
      ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return out;
  }

  async _bulkGet(keys) {
    const out = [];
    for (const k of keys) {
      const obj = await this._getJson(k);
      if (obj) out.push(obj);
    }
    return out;
  }

  // ---- Sources ----
  async putSource(sourceId, item) {
    const record = { source_id: sourceId, created_at: item.created_at || nowIso(), updated_at: nowIso(), ...item };
    await this._putJson(this._key('sources', `${sourceId}.json`), record);
    return record;
  }
  async getSource(sourceId) {
    return this._getJson(this._key('sources', `${sourceId}.json`));
  }
  async listSources(limit = 100) {
    const objs = await this._listObjects(this._key('sources') + '/', limit);
    objs.sort((a, b) => b.LastModified - a.LastModified);
    return this._bulkGet(objs.map((o) => o.Key));
  }
  async deleteSource(sourceId) {
    await this._delete(this._key('sources', `${sourceId}.json`));
  }

  // ---- Scans ----
  async putScan(scanId, item) {
    const record = { scan_id: scanId, created_at: item.created_at || nowIso(), updated_at: nowIso(), ...item };
    await this._putJson(this._key('scans', scanId, 'scan.json'), record);
    return record;
  }
  async getScan(scanId) {
    return this._getJson(this._key('scans', scanId, 'scan.json'));
  }
  async listScans(limit = 50) {
    const objs = await this._listObjects(this._key('scans') + '/', limit * 5);
    const scanObjs = objs.filter((o) => o.Key.endsWith('/scan.json'));
    scanObjs.sort((a, b) => b.LastModified - a.LastModified);
    return this._bulkGet(scanObjs.slice(0, limit).map((o) => o.Key));
  }

  // ---- Findings ----
  async putFindings(scanId, findings) {
    const fs2 = findings || [];
    const body = { scan_id: scanId, count: fs2.length, written_at: nowIso(), findings: fs2 };
    await this._putJson(this._key('scans', scanId, 'findings.json'), body);
    return fs2.length;
  }
  async listFindings(scanId, limit = 500) {
    const body = await this._getJson(this._key('scans', scanId, 'findings.json'));
    if (!body) return [];
    return (body.findings || []).slice(0, limit);
  }

  // ---- Analyses ----
  async putAnalysis(scanId, analysis, modelUsed) {
    const record = { scan_id: scanId, model_used: modelUsed, analyzed_at: nowIso(), analysis };
    await this._putJson(this._key('scans', scanId, 'analysis.json'), record);
    return record;
  }
  async getAnalysis(scanId) {
    return this._getJson(this._key('scans', scanId, 'analysis.json'));
  }

  // ---- Jobs ----
  async putJob(jobId, item) {
    const record = { job_id: jobId, created_at: item.created_at || nowIso(), updated_at: nowIso(), ...item };
    await this._putJson(this._key('jobs', `${jobId}.json`), record);
    return record;
  }
  async updateJob(jobId, updates) {
    const current = (await this.getJob(jobId)) || { job_id: jobId, created_at: nowIso() };
    Object.assign(current, updates);
    current.updated_at = nowIso();
    await this._putJson(this._key('jobs', `${jobId}.json`), current);
    return current;
  }
  async getJob(jobId) {
    return this._getJson(this._key('jobs', `${jobId}.json`));
  }
  async listJobs(limit = 50) {
    const objs = await this._listObjects(this._key('jobs') + '/', limit);
    objs.sort((a, b) => b.LastModified - a.LastModified);
    return this._bulkGet(objs.slice(0, limit).map((o) => o.Key));
  }
}

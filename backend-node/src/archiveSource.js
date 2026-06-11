// Archive source connector — zip uploads and s3:// sources.
// Port of backend/app/archive_source.py.

import AdmZip from 'adm-zip';
import { promises as fs } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import path from 'node:path';
import { S3Client, HeadObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { settings } from './config.js';
import { getLogger } from './logger.js';
import { runSemgrep } from './githubSource.js';

const log = getLogger('archive');

export class ArchiveScanError extends Error {
  constructor(msg) { super(msg); this.name = 'ArchiveScanError'; }
}

const S3_URI_RE = /^s3:\/\/([a-z0-9.\-]+)\/(.*)$/i;

export function parseS3Uri(uri) {
  const m = S3_URI_RE.exec((uri || '').trim());
  if (!m) throw new ArchiveScanError(`Invalid S3 URI: ${uri}. Expected s3://bucket/path`);
  return { bucket: m[1], key: m[2] };
}

async function rmrf(p) {
  try { await fs.rm(p, { recursive: true, force: true }); } catch {}
}

function isUnsafeMember(name) {
  // Reject absolute paths and any '..' segments — same logic as the Python version.
  if (name.startsWith('/') || name.startsWith('\\')) return true;
  const parts = name.replaceAll('\\', '/').split('/');
  return parts.includes('..');
}

async function pickCodeRoot(extractedDir) {
  const entries = (await fs.readdir(extractedDir)).filter((e) => !e.startsWith('.'));
  if (entries.length === 1) {
    const single = path.join(extractedDir, entries[0]);
    const s = await stat(single).catch(() => null);
    if (s && s.isDirectory()) return single;
  }
  return extractedDir;
}

async function safeExtract(zip, dest, maxBytes) {
  const entries = zip.getEntries();
  let totalUncompressed = 0;
  for (const entry of entries) {
    const name = entry.entryName;
    if (isUnsafeMember(name)) throw new ArchiveScanError(`Unsafe path in zip: ${name}`);
    const target = path.resolve(dest, name);
    const destReal = path.resolve(dest);
    if (!target.startsWith(destReal + path.sep) && target !== destReal) {
      throw new ArchiveScanError(`Path escapes extraction dir: ${name}`);
    }
    totalUncompressed += entry.header.size;
    if (totalUncompressed > maxBytes) {
      throw new ArchiveScanError(`Uncompressed contents exceed ${Math.floor(maxBytes / (1024 * 1024))} MB cap (zip bomb?)`);
    }
  }
  // Extract after the safety pre-flight passes
  zip.extractAllTo(dest, /* overwrite */ true);
}

export async function extractZipToWorkspace(zipBuffer) {
  await fs.mkdir(settings.workspaceDir, { recursive: true });
  const maxZipBytes = settings.maxZipSizeMb * 1024 * 1024;
  if (zipBuffer.length > maxZipBytes) {
    throw new ArchiveScanError(`Zip is ${Math.floor(zipBuffer.length / (1024 * 1024))} MB; cap is ${settings.maxZipSizeMb} MB`);
  }

  const workspace = await mkdtemp(path.join(settings.workspaceDir, 'uem-zip-'));
  const extractDir = path.join(workspace, 'src');
  await fs.mkdir(extractDir, { recursive: true });

  const maxUncompressed = Math.min(maxZipBytes * 4, settings.maxRepoSizeMb * 1024 * 1024);

  try {
    const zip = new AdmZip(zipBuffer);
    await safeExtract(zip, extractDir, maxUncompressed);
  } catch (err) {
    await rmrf(workspace);
    if (err instanceof ArchiveScanError) throw err;
    throw new ArchiveScanError(`Not a valid zip file: ${err.message}`);
  }

  const codePath = await pickCodeRoot(extractDir);
  log.info({ workspace, code_path: codePath }, 'zip_extracted');
  return { workspace, codePath };
}

function s3() {
  return new S3Client({ region: settings.awsRegion });
}

async function streamToFile(stream, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const handle = await fs.open(targetPath, 'w');
  try {
    for await (const chunk of stream) {
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function fetchS3Source(s3Uri) {
  const { bucket, key } = parseS3Uri(s3Uri);
  const client = s3();

  // Case A: a single .zip
  if (key.toLowerCase().endsWith('.zip')) {
    let head;
    try {
      head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      throw new ArchiveScanError(`S3 object not found or no access: ${s3Uri}: ${err.message || err}`);
    }
    const size = head.ContentLength || 0;
    if (size > settings.maxZipSizeMb * 1024 * 1024) {
      throw new ArchiveScanError(`S3 zip is ${Math.floor(size / (1024 * 1024))} MB; cap is ${settings.maxZipSizeMb} MB`);
    }
    log.info({ uri: s3Uri, size_bytes: size }, 'downloading_s3_zip');
    const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const buf = await streamToBuffer(obj.Body);
    return extractZipToWorkspace(buf);
  }

  // Case B: a prefix
  await fs.mkdir(settings.workspaceDir, { recursive: true });
  const workspace = await mkdtemp(path.join(settings.workspaceDir, 'uem-s3-'));
  const codePath = path.join(workspace, 'src');
  await fs.mkdir(codePath, { recursive: true });

  const prefix = key.endsWith('/') || key === '' ? key : key + '/';
  let totalBytes = 0;
  let fileCount = 0;
  const maxUncompressed = settings.maxRepoSizeMb * 1024 * 1024;

  let ContinuationToken;
  try {
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
      for (const obj of page.Contents || []) {
        const objKey = obj.Key;
        if (!objKey || objKey.endsWith('/')) continue;
        const rel = objKey.startsWith(prefix) ? objKey.slice(prefix.length) : objKey;
        if (isUnsafeMember(rel)) continue;
        const target = path.join(codePath, rel);
        const codeReal = path.resolve(codePath);
        if (!path.resolve(target).startsWith(codeReal + path.sep)) continue;
        totalBytes += obj.Size || 0;
        if (totalBytes > maxUncompressed) {
          throw new ArchiveScanError(`S3 prefix contents exceed ${settings.maxRepoSizeMb} MB cap`);
        }
        const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objKey }));
        await streamToFile(got.Body, target);
        fileCount++;
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  } catch (err) {
    await rmrf(workspace);
    if (err instanceof ArchiveScanError) throw err;
    throw new ArchiveScanError(`S3 sync failed: ${err.message || err}`);
  }

  if (fileCount === 0) {
    await rmrf(workspace);
    throw new ArchiveScanError(`No objects found under ${s3Uri}`);
  }

  log.info({ uri: s3Uri, file_count: fileCount, total_bytes: totalBytes }, 's3_prefix_synced');
  return { workspace, codePath };
}

export async function scanExtracted(extracted) {
  try {
    const sarif = await runSemgrep(extracted.codePath);
    sarif._uem_context = sarif._uem_context || {};
    sarif._uem_context.scanned_path = extracted.codePath;
    return sarif;
  } finally {
    await rmrf(extracted.workspace);
  }
}

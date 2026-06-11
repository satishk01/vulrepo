// Unified Exposure Management — Node.js / Express backend.
// Port of backend/app/main.py.

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';

import { settings, corsOriginList } from './config.js';
import { logger, getLogger } from './logger.js';
import { getBedrock } from './bedrockClient.js';
import { getRepository } from './persistence/index.js';
import { normalizeFindings } from './normalizer.js';
import { buildAnalysisPrompt, buildUnifiedAnalysisPrompt, buildRemediationPrompt, parseJsonLenient } from './promptTemplates.js';
import { runScanAnalysis } from './batchAnalyzer.js';
import { createJob, schedule, updateProgress, JobStatus } from './jobs.js';
import { scanRepo, validateRepoUrl, GitHubScanError } from './githubSource.js';
import { extractZipToWorkspace, fetchS3Source, parseS3Uri, scanExtracted, ArchiveScanError } from './archiveSource.js';
import { extractText, extractFindingsFromText, toNormalized, PenTestParseError } from './pentestParser.js';
import { getGithubToken } from './secrets.js';

const log = getLogger('server');

// -----------------------------------------------------------------------------
// App setup
// -----------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

// Generate/echo a request id and put it on every log
app.use(pinoHttp({
  logger,
  genReqId: (req, res) => {
    const id = req.headers['x-request-id'] || randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
}));

const origins = corsOriginList();
app.use(cors({
  origin: origins === '*' ? true : origins,
  credentials: false,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
}));

// JSON body parser with a sane limit. File uploads use multer below.
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: settings.rateLimitPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  message: { detail: 'Rate limit exceeded' },
}));

// File-upload handler (in-memory; we never write the raw upload to disk).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: settings.maxUploadBytes },
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function httpError(status, detail) {
  const e = new Error(detail);
  e.status = status;
  return e;
}

function parseJsonField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  try { return JSON.parse(value); } catch { throw httpError(400, 'asset_context and org_context must be valid JSON'); }
}

// -----------------------------------------------------------------------------
// Health & meta
// -----------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    environment: settings.environment,
  });
});

app.get('/models', (req, res) => {
  res.json({
    models: [
      { id: 'anthropic.claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: 'Fast, efficient — best for large scan volumes', tier: 'standard' },
      { id: 'anthropic.claude-opus-4-5',   name: 'Claude Opus 4.5',   description: 'Most capable — best for deep risk analysis',  tier: 'premium'  },
    ],
  });
});

// -----------------------------------------------------------------------------
// Multi-file upload (auto-detects type per file, combines findings)
// -----------------------------------------------------------------------------
const PENTEST_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.html', '.htm', '.doc', '.docx']);
const STRUCTURED_EXTENSIONS = new Set(['.json', '.sarif', '.csv', '.xml']);

app.post('/upload/multi', upload.array('files', 20), asyncRoute(async (req, res) => {
  if (!req.files || req.files.length === 0) throw httpError(400, 'At least one file is required');

  const modelId = req.body.model_id || settings.bedrockDefaultModel;
  const assetCtx = parseJsonField(req.body.asset_context, {});
  const orgCtx = parseJsonField(req.body.org_context, {});
  const runAnalysis = (req.body.run_analysis || 'true').toString().toLowerCase() !== 'false';
  const scanId = randomUUID();
  const filenames = req.files.map(f => f.originalname);

  // Capture file buffers before response (multer clears them)
  // Must do this synchronously before any async operations
  const fileCopies = req.files.map(f => ({
    originalname: f.originalname,
    buffer: Buffer.from(f.buffer),
    size: f.size,
  }));

  const jobId = await createJob('multi_upload', {
    scan_id: scanId,
    file_count: req.files.length,
    filenames,
    model_id: modelId,
    run_analysis: runAnalysis,
  });

  schedule(jobId, async () => {
    const allFindings = [];
    const fileResults = [];
    let successCount = 0;

    for (let i = 0; i < fileCopies.length; i++) {
      const file = fileCopies[i];
      const name = (file.originalname || '').toLowerCase();
      const ext = '.' + name.split('.').pop();

      await updateProgress(jobId, `Processing file ${i + 1}/${fileCopies.length}: ${file.originalname}`);

      try {
        if (PENTEST_EXTENSIONS.has(ext)) {
          log.info({ filename: file.originalname }, 'processing_pentest_file');
          let text;
          try {
            text = await extractText(file.originalname, file.buffer);
          } catch (extractErr) {
            log.error({ filename: file.originalname, error: String(extractErr) }, 'text_extraction_failed');
            fileResults.push({ filename: file.originalname, status: 'error', reason: `Text extraction failed: ${extractErr.message}` });
            continue;
          }
          
          if (!text || text.length < 50) {
            log.warn({ filename: file.originalname, textLength: text?.length || 0 }, 'text_too_short');
            fileResults.push({ filename: file.originalname, status: 'skipped', reason: 'Extracted text too short (< 50 chars)' });
            continue;
          }
          
          let extracted;
          try {
            extracted = await extractFindingsFromText(text, getBedrock(), modelId);
          } catch (extractFindErr) {
            log.error({ filename: file.originalname, error: String(extractFindErr) }, 'finding_extraction_failed');
            fileResults.push({ filename: file.originalname, status: 'error', reason: `Finding extraction failed: ${extractFindErr.message}` });
            continue;
          }
          
          if (!Array.isArray(extracted) || extracted.length === 0) {
            log.warn({ filename: file.originalname }, 'no_findings_extracted');
            fileResults.push({ filename: file.originalname, status: 'ok', findings_count: 0, type: 'pentest-report' });
            continue;
          }
          
          const findings = toNormalized(extracted, scanId);
          if (!Array.isArray(findings) || findings.length === 0) {
            log.warn({ filename: file.originalname }, 'findings_normalization_resulted_empty');
            fileResults.push({ filename: file.originalname, status: 'ok', findings_count: 0, type: 'pentest-report' });
            continue;
          }
          
          allFindings.push(...findings);
          successCount++;
          fileResults.push({ filename: file.originalname, status: 'ok', findings_count: findings.length, type: 'pentest-report' });
          log.info({ filename: file.originalname, findingsCount: findings.length }, 'pentest_file_processed');
        } else if (STRUCTURED_EXTENSIONS.has(ext)) {
          log.info({ filename: file.originalname }, 'processing_structured_file');
          let rawText;
          try {
            rawText = file.buffer.toString('utf-8');
          } catch (encodeErr) {
            log.error({ filename: file.originalname, error: String(encodeErr) }, 'utf8_decode_failed');
            fileResults.push({ filename: file.originalname, status: 'error', reason: `File encoding error: ${encodeErr.message}` });
            continue;
          }

          let rawData;
          if (ext === '.csv') {
            rawData = { _raw_csv: rawText, _format: 'csv' };
          } else {
            try {
              rawData = JSON.parse(rawText);
            } catch (parseErr) {
              log.warn({ filename: file.originalname, error: String(parseErr) }, 'json_parse_failed_trying_csv');
              rawData = { _raw_csv: rawText, _format: 'csv' };
            }
          }

          let findings;
          try {
            findings = normalizeFindings(rawData, 'auto', scanId);
          } catch (normErr) {
            log.error({ filename: file.originalname, error: String(normErr) }, 'normalization_failed');
            fileResults.push({ filename: file.originalname, status: 'error', reason: `Normalization failed: ${normErr.message}` });
            continue;
          }
          
          if (!Array.isArray(findings) || findings.length === 0) {
            log.warn({ filename: file.originalname }, 'structured_file_no_findings');
            fileResults.push({ filename: file.originalname, status: 'ok', findings_count: 0, type: 'structured' });
            continue;
          }
          
          allFindings.push(...findings);
          successCount++;
          fileResults.push({ filename: file.originalname, status: 'ok', findings_count: findings.length, type: 'structured' });
          log.info({ filename: file.originalname, findingsCount: findings.length }, 'structured_file_processed');
        } else if (ext === '.xlsx' || ext === '.xls') {
          log.info({ filename: file.originalname }, 'excel_file_not_supported');
          fileResults.push({ filename: file.originalname, status: 'skipped', reason: 'Excel files not yet supported — export as CSV' });
        } else {
          log.info({ filename: file.originalname }, 'processing_unknown_format');
          let text;
          try {
            text = file.buffer.toString('utf-8');
          } catch (encodeErr) {
            log.error({ filename: file.originalname, error: String(encodeErr) }, 'unknown_format_utf8_decode_failed');
            fileResults.push({ filename: file.originalname, status: 'error', reason: `File encoding error: ${encodeErr.message}` });
            continue;
          }
          
          if (text && text.length > 50) {
            let extracted;
            try {
              extracted = await extractFindingsFromText(text, getBedrock(), modelId);
            } catch (extractFindErr) {
              log.error({ filename: file.originalname, error: String(extractFindErr) }, 'unknown_format_finding_extraction_failed');
              fileResults.push({ filename: file.originalname, status: 'error', reason: `Finding extraction failed: ${extractFindErr.message}` });
              continue;
            }
            
            const findings = toNormalized(extracted, scanId);
            if (Array.isArray(findings) && findings.length > 0) {
              allFindings.push(...findings);
              successCount++;
              fileResults.push({ filename: file.originalname, status: 'ok', findings_count: findings.length, type: 'pentest-report' });
              log.info({ filename: file.originalname, findingsCount: findings.length }, 'unknown_format_file_processed');
            } else {
              fileResults.push({ filename: file.originalname, status: 'ok', findings_count: 0, type: 'pentest-report' });
            }
          } else {
            log.warn({ filename: file.originalname, textLength: text?.length || 0 }, 'unknown_format_empty_or_too_short');
            fileResults.push({ filename: file.originalname, status: 'skipped', reason: 'Unrecognized format or empty content' });
          }
        }
      } catch (err) {
        log.error({ filename: file.originalname, error: String(err), stack: err.stack }, 'multi_upload_file_error');
        fileResults.push({ filename: file.originalname, status: 'error', reason: `Unexpected error: ${err.message || String(err)}` });
      }
    }

    log.info({ successCount, totalFiles: fileCopies.length, findingsExtracted: allFindings.length }, 'multi_upload_processing_complete');

    if (successCount === 0) {
      const errorMsg = `No files could be processed successfully. Details: ${fileResults.map(f => `${f.filename}: ${f.reason}`).join('; ')}`;
      log.error({ fileResults }, 'multi_upload_all_files_failed');
      throw new Error(errorMsg);
    }

    let findings = allFindings;
    if (findings.length > settings.maxFindingsPerScan) {
      log.warn({ original: findings.length, kept: settings.maxFindingsPerScan }, 'multi_findings_truncated');
      findings = findings.slice(0, settings.maxFindingsPerScan);
    }

    await updateProgress(jobId, `Saving ${findings.length} findings to database`);
    const repo = await getRepository();
    
    try {
      await repo.putScan(scanId, {
        source_type: 'multi-upload',
        filename: fileCopies.map(f => f.originalname).join(', '),
        scan_type: 'multi',
        findings_count: findings.length,
        files_processed: fileResults.length,
        files_success_count: successCount,
        status: 'ingested',
      });
      log.info({ scanId }, 'scan_metadata_saved');
    } catch (repoErr) {
      log.error({ scanId, error: String(repoErr) }, 'scan_metadata_save_failed');
      throw new Error(`Failed to save scan metadata: ${repoErr.message}`);
    }
    
    try {
      await repo.putFindings(scanId, findings);
      log.info({ scanId, findingsCount: findings.length }, 'findings_saved');
    } catch (repoErr) {
      log.error({ scanId, error: String(repoErr) }, 'findings_save_failed');
      throw new Error(`Failed to save findings: ${repoErr.message}`);
    }

    // Auto-run analysis if findings exist and analysis is requested
    const result = {
      scan_id: scanId,
      files_processed: fileResults.length,
      files_success_count: successCount,
      file_results: fileResults,
      findings_count: findings.length,
    };

    if (runAnalysis && findings.length > 0) {
      try {
        // Batching removes the old single-call truncation limit, so all
        // findings can be analysed (no 100-cap needed).
        const analysisResult = await runScanAnalysis({
          findings,
          bedrock: getBedrock(),
          modelId,
          assetContext: assetCtx,
          orgContext: orgCtx,
          batchSize: settings.analysisBatchSize,
          maxTokens: settings.bedrockAnalysisMaxTokens,
          scanId,
          onProgress: (m) => updateProgress(jobId, m),
        });
        await repo.putAnalysis(scanId, analysisResult, modelId);
        result.analysis_ready = true;
        log.info({ scanId }, 'auto_analysis_completed');
      } catch (analysisErr) {
        // Analysis failure is non-fatal — findings are already saved
        log.error({ scanId, error: String(analysisErr) }, 'auto_analysis_failed');
        result.analysis_error = String(analysisErr.message || analysisErr);
      }
    }
    
    log.info(result, 'multi_upload_job_succeeded');
    return result;
  });

  res.json({
    job_id: jobId,
    scan_id: scanId,
    files_queued: filenames.length,
    message: `${filenames.length} files queued for processing`,
  });
}));

// -----------------------------------------------------------------------------
// Scanner output upload (v1 path)
// -----------------------------------------------------------------------------
app.post('/upload/scan', upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw httpError(400, 'file is required');
  const scanType = req.body.scan_type || 'auto';

  let rawText;
  try {
    rawText = req.file.buffer.toString('utf-8');
  } catch {
    throw httpError(400, 'File must be UTF-8 encoded text');
  }

  let rawData;
  try {
    rawData = JSON.parse(rawText);
  } catch {
    rawData = { _raw_csv: rawText, _format: 'csv' };
  }

  const scanId = randomUUID();
  let findings = normalizeFindings(rawData, scanType, scanId);
  if (findings.length > settings.maxFindingsPerScan) {
    log.warn({ original: findings.length, kept: settings.maxFindingsPerScan }, 'findings_truncated');
    findings = findings.slice(0, settings.maxFindingsPerScan);
  }

  const repo = await getRepository();
  await repo.putScan(scanId, {
    source_type: 'upload',
    filename: req.file.originalname,
    scan_type: scanType,
    findings_count: findings.length,
    status: 'ingested',
  });
  await repo.putFindings(scanId, findings);

  res.json({
    scan_id: scanId,
    filename: req.file.originalname || 'uploaded',
    findings_count: findings.length,
    findings,
    message: `Successfully parsed ${findings.length} findings from ${req.file.originalname}`,
  });
}));

// -----------------------------------------------------------------------------
// Analyze (Bedrock-powered) — job-based with progress
// -----------------------------------------------------------------------------
app.post('/analyze', asyncRoute(async (req, res) => {
  const request = req.body || {};
  if (!Array.isArray(request.findings) || request.findings.length === 0) {
    throw httpError(400, 'No findings provided for analysis');
  }
  const modelId = request.model_id || settings.bedrockDefaultModel;
  const findingsCount = request.findings.length;

  const jobId = await createJob('analyze', {
    scan_id: request.scan_id,
    findings_count: findingsCount,
    model_id: modelId,
  });

  const findingsCopy = [...request.findings];
  const assetCtx = request.asset_context || {};
  const orgCtx = request.org_context || {};
  const scanIdCopy = request.scan_id;

  schedule(jobId, async () => {
    await updateProgress(jobId, `Preparing analysis for ${findingsCount} findings`);

    let analysis;
    try {
      analysis = await runScanAnalysis({
        findings: findingsCopy,
        bedrock: getBedrock(),
        modelId,
        assetContext: assetCtx,
        orgContext: orgCtx,
        batchSize: settings.analysisBatchSize,
        maxTokens: settings.bedrockAnalysisMaxTokens,
        scanId: scanIdCopy,
        onProgress: (m) => updateProgress(jobId, m),
      });
    } catch (err) {
      throw new Error(`Bedrock invocation failed: ${err.message || err}`);
    }

    await updateProgress(jobId, 'Saving analysis results');
    const repo = await getRepository();
    await repo.putAnalysis(scanIdCopy, analysis, modelId);

    return {
      scan_id: scanIdCopy,
      model_used: modelId,
      analyzed_at: new Date().toISOString(),
      findings_analyzed: findingsCount,
      analysis,
    };
  });

  res.json({ job_id: jobId, scan_id: request.scan_id, status: 'queued', message: `Analysis queued for ${findingsCount} findings` });
}));

// -----------------------------------------------------------------------------
// Unified multi-scan analysis (correlate across scans) — job-based
// -----------------------------------------------------------------------------
app.post('/analyze/unified', asyncRoute(async (req, res) => {
  const request = req.body || {};
  const scanIds = request.scan_ids;
  if (!Array.isArray(scanIds) || scanIds.length === 0) {
    throw httpError(400, 'scan_ids array is required (provide 1 or more scan IDs)');
  }
  if (scanIds.length > 10) {
    throw httpError(400, 'Maximum 10 scans can be analyzed together');
  }

  const modelId = request.model_id || settings.bedrockDefaultModel;
  const repo = await getRepository();

  // Fetch findings from all selected scans (do this synchronously before scheduling)
  const scans = [];
  for (const scanId of scanIds) {
    const scan = await repo.getScan(scanId);
    if (!scan) throw httpError(404, `Scan not found: ${scanId}`);
    const findings = await repo.listFindings(scanId, 500);
    scans.push({
      scan_id: scanId,
      source_type: scan.source_type,
      filename: scan.filename || scan.repo_url || scanId,
      findings,
    });
  }

  const totalFindings = scans.reduce((sum, s) => sum + s.findings.length, 0);
  if (totalFindings === 0) {
    throw httpError(400, 'No findings found across the selected scans');
  }

  const jobId = await createJob('unified_analysis', {
    scan_ids: scanIds,
    total_findings: totalFindings,
    scans_count: scans.length,
    model_id: modelId,
  });

  const assetCtx = request.asset_context || {};
  const orgCtx = request.org_context || {};

  schedule(jobId, async () => {
    await updateProgress(jobId, `Preparing unified prompt: ${scans.length} scans, ${totalFindings} findings`);

    const prompt = buildUnifiedAnalysisPrompt({ scans, asset_context: assetCtx, org_context: orgCtx });

    await updateProgress(jobId, `Calling Claude (${modelId.split('.').pop()}) — correlating ${totalFindings} findings across ${scans.length} scans`);

    let resultText;
    try {
      resultText = await getBedrock().invoke({ modelId, prompt, maxTokens: settings.bedrockAnalysisMaxTokens });
    } catch (err) {
      throw new Error(`Bedrock invocation failed: ${err.message || err}`);
    }

    await updateProgress(jobId, 'Parsing AI response & generating diagrams');
    let analysis = parseJsonLenient(resultText);
    if (!analysis && resultText) {
      const mdMatch = resultText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (mdMatch && mdMatch[1]) {
        analysis = parseJsonLenient(mdMatch[1].trim());
      }
    }
    if (!analysis) {
      analysis = { raw_analysis: resultText };
      log.warn({}, 'unified_analysis_parse_failed_storing_raw');
    }

    await updateProgress(jobId, 'Saving unified analysis');
    const unifiedId = `unified_${Date.now()}`;
    const r = await getRepository();
    await r.putAnalysis(unifiedId, analysis, modelId);

    return {
      unified_id: unifiedId,
      scan_ids: scanIds,
      model_used: modelId,
      analyzed_at: new Date().toISOString(),
      total_findings_analyzed: totalFindings,
      scans_analyzed: scans.length,
      analysis,
    };
  });

  res.json({ job_id: jobId, scan_ids: scanIds, status: 'queued', message: `Unified analysis queued: ${scans.length} scans, ${totalFindings} findings` });
}));

// -----------------------------------------------------------------------------
// Single-finding remediation
// -----------------------------------------------------------------------------
app.post('/remediate/:findingId', asyncRoute(async (req, res) => {
  const finding = req.body || {};
  const modelId = req.query.model_id || 'anthropic.claude-sonnet-4-5';
  const prompt = buildRemediationPrompt(finding);
  let resultText;
  try {
    resultText = await getBedrock().invoke({ modelId, prompt });
  } catch (err) {
    throw httpError(502, err.message || String(err));
  }
  const parsed = parseJsonLenient(resultText);
  res.json(parsed || { raw_analysis: resultText });
}));

// -----------------------------------------------------------------------------
// Sources: GitHub
// -----------------------------------------------------------------------------
app.post('/sources/github', asyncRoute(async (req, res) => {
  const p = req.body || {};
  let canonicalUrl;
  try { canonicalUrl = validateRepoUrl(p.repo_url); }
  catch (e) { throw httpError(400, e.message); }

  const sourceId = randomUUID();
  const repo = await getRepository();
  const record = await repo.putSource(sourceId, {
    kind: 'github',
    name: p.name,
    repo_url: canonicalUrl,
    branch: p.branch || null,
    description: p.description || null,
    asset_context: p.asset_context || {},
    org_context: p.org_context || {},
  });
  res.json(record);
}));

app.get('/sources', asyncRoute(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const repo = await getRepository();
  res.json({ sources: await repo.listSources(limit) });
}));

app.get('/sources/:id', asyncRoute(async (req, res) => {
  const repo = await getRepository();
  const src = await repo.getSource(req.params.id);
  if (!src) throw httpError(404, 'Source not found');
  res.json(src);
}));

app.delete('/sources/:id', asyncRoute(async (req, res) => {
  const repo = await getRepository();
  await repo.deleteSource(req.params.id);
  res.json({ deleted: req.params.id });
}));

// -----------------------------------------------------------------------------
// Sources: S3
// -----------------------------------------------------------------------------
app.post('/sources/s3', asyncRoute(async (req, res) => {
  const p = req.body || {};
  try { parseS3Uri(p.s3_uri); } catch (e) { throw httpError(400, e.message); }

  const sourceId = randomUUID();
  const repo = await getRepository();
  const record = await repo.putSource(sourceId, {
    kind: 's3',
    name: p.name,
    s3_uri: p.s3_uri,
    description: p.description || null,
    asset_context: p.asset_context || {},
    org_context: p.org_context || {},
  });
  res.json(record);
}));

// -----------------------------------------------------------------------------
// Trigger source scan (github or s3)
// -----------------------------------------------------------------------------
app.post('/sources/:id/scan', asyncRoute(async (req, res) => {
  const p = req.body || {};
  const repo = await getRepository();
  const src = await repo.getSource(req.params.id);
  if (!src) throw httpError(404, 'Source not found');
  if (!['github', 's3'].includes(src.kind)) {
    throw httpError(400, `Source kind '${src.kind}' not supported`);
  }

  const scanId = randomUUID();
  const jobId = await createJob(`${src.kind}_scan`, {
    source_id: req.params.id,
    scan_id: scanId,
    kind: src.kind,
    model_id: p.model_id,
    run_analysis: p.run_analysis !== false,
  });

  const assetCtx = p.asset_context || src.asset_context || {};
  const orgCtx = p.org_context || src.org_context || {};
  const modelId = p.model_id || settings.bedrockDefaultModel;
  const runAnalysis = p.run_analysis !== false;

  schedule(jobId, async () => {
    const r = await getRepository();
    let sarif;
    let scanMeta;
    if (src.kind === 'github') {
      await updateProgress(jobId, 'Cloning repository');
      const token = await getGithubToken();
      try {
        sarif = await scanRepo(src.repo_url, src.branch, token);
      } catch (e) {
        throw new Error(`GitHub scan failed: ${e.message || e}`);
      }
      scanMeta = {
        source_type: 'github',
        source_id: req.params.id,
        repo_url: src.repo_url,
        branch: src.branch,
        commit_sha: sarif?._uem_context?.commit_sha,
      };
    } else {
      await updateProgress(jobId, 'Fetching source from S3');
      try {
        const extracted = await fetchS3Source(src.s3_uri);
        await updateProgress(jobId, 'Running Semgrep');
        sarif = await scanExtracted(extracted);
      } catch (e) {
        throw new Error(`S3 source scan failed: ${e.message || e}`);
      }
      scanMeta = { source_type: 's3', source_id: req.params.id, s3_uri: src.s3_uri };
    }

    await updateProgress(jobId, 'Normalizing findings');
    let findings = normalizeFindings(sarif, 'sast', scanId);
    if (findings.length > settings.maxFindingsPerScan) {
      findings = findings.slice(0, settings.maxFindingsPerScan);
    }

    await r.putScan(scanId, { ...scanMeta, findings_count: findings.length, status: 'ingested' });
    await r.putFindings(scanId, findings);

    const result = { scan_id: scanId, findings_count: findings.length };
    if (runAnalysis && findings.length) {
      await updateProgress(jobId, 'Running AI analysis');
      try {
        const analysis = await runScanAnalysis({
          findings,
          bedrock: getBedrock(),
          modelId,
          assetContext: assetCtx,
          orgContext: orgCtx,
          batchSize: settings.analysisBatchSize,
          maxTokens: settings.bedrockAnalysisMaxTokens,
          scanId,
          onProgress: (m) => updateProgress(jobId, m),
        });
        await r.putAnalysis(scanId, analysis, modelId);
        result.analysis_ready = true;
      } catch (e) {
        log.error({ error: String(e) }, 'analysis_failed_in_job');
        result.analysis_error = String(e.message || e);
      }
    }
    return result;
  });

  res.json({ job_id: jobId, scan_id: scanId, status: JobStatus.QUEUED });
}));

// -----------------------------------------------------------------------------
// Zip upload (one-shot)
// -----------------------------------------------------------------------------
app.post('/sources/zip/upload', upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw httpError(400, 'file is required');
  if (!(req.file.originalname || '').toLowerCase().endsWith('.zip')) {
    throw httpError(400, 'File must be a .zip');
  }
  const maxZipBytes = settings.maxZipSizeMb * 1024 * 1024;
  if (req.file.size > maxZipBytes) {
    throw httpError(413, `Zip too large (max ${settings.maxZipSizeMb} MB)`);
  }

  const modelId = req.body.model_id || 'anthropic.claude-sonnet-4-5';
  const assetCtx = parseJsonField(req.body.asset_context, {});
  const orgCtx = parseJsonField(req.body.org_context, {});
  const runAnalysis = (req.body.run_analysis || 'true').toString().toLowerCase() !== 'false';

  const scanId = randomUUID();
  const jobId = await createJob('zip_scan', {
    scan_id: scanId,
    filename: req.file.originalname,
    size_bytes: req.file.size,
    model_id: modelId,
    run_analysis: runAnalysis,
  });
  const content = req.file.buffer;
  const resolvedModel = modelId || settings.bedrockDefaultModel;

  schedule(jobId, async () => {
    const r = await getRepository();
    await updateProgress(jobId, 'Extracting zip');
    let sarif;
    try {
      const extracted = await extractZipToWorkspace(content);
      await updateProgress(jobId, 'Running Semgrep');
      sarif = await scanExtracted(extracted);
    } catch (e) {
      throw new Error(`Zip scan failed: ${e.message || e}`);
    }

    await updateProgress(jobId, 'Normalizing findings');
    let findings = normalizeFindings(sarif, 'sast', scanId);
    if (findings.length > settings.maxFindingsPerScan) {
      findings = findings.slice(0, settings.maxFindingsPerScan);
    }

    await r.putScan(scanId, {
      source_type: 'zip',
      filename: req.file.originalname,
      findings_count: findings.length,
      status: 'ingested',
    });
    await r.putFindings(scanId, findings);

    const result = { scan_id: scanId, findings_count: findings.length };
    if (runAnalysis && findings.length) {
      await updateProgress(jobId, 'Running AI analysis');
      try {
        const analysis = await runScanAnalysis({
          findings,
          bedrock: getBedrock(),
          modelId: resolvedModel,
          assetContext: assetCtx,
          orgContext: orgCtx,
          batchSize: settings.analysisBatchSize,
          maxTokens: settings.bedrockAnalysisMaxTokens,
          scanId,
          onProgress: (m) => updateProgress(jobId, m),
        });
        await r.putAnalysis(scanId, analysis, resolvedModel);
        result.analysis_ready = true;
      } catch (e) {
        log.error({ error: String(e) }, 'zip_analysis_failed');
        result.analysis_error = String(e.message || e);
      }
    }
    return result;
  });

  res.json({
    scan_id: scanId,
    job_id: jobId,
    filename: req.file.originalname || 'upload.zip',
    message: 'Zip queued for extraction and scan',
  });
}));

// -----------------------------------------------------------------------------
// Pen-test report upload
// -----------------------------------------------------------------------------
app.post('/sources/pentest/upload', upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw httpError(400, 'file is required');
  if (req.file.size > settings.maxUploadBytes) {
    throw httpError(413, `File too large (max ${Math.floor(settings.maxUploadBytes / 1024 / 1024)} MB)`);
  }

  const modelId = req.body.model_id || 'anthropic.claude-sonnet-4-5';
  const assetCtx = parseJsonField(req.body.asset_context, {});
  const orgCtx = parseJsonField(req.body.org_context, {});
  const runAnalysis = (req.body.run_analysis || 'true').toString().toLowerCase() !== 'false';

  const scanId = randomUUID();
  const jobId = await createJob('pentest_extract', {
    scan_id: scanId,
    filename: req.file.originalname,
    model_id: modelId,
    run_analysis: runAnalysis,
  });
  const content = req.file.buffer;
  const filename = req.file.originalname || 'report';

  schedule(jobId, async () => {
    const r = await getRepository();
    await updateProgress(jobId, 'Extracting text from report');
    let text;
    try {
      text = await extractText(filename, content);
    } catch (e) {
      throw new Error(`Could not read report: ${e.message || e}`);
    }
    if (!text || text.length < 100) throw new Error('Report text is too short — extraction may have failed');

    await updateProgress(jobId, 'Asking Claude to extract findings');
    let extracted;
    try {
      extracted = await extractFindingsFromText(text, getBedrock(), modelId);
    } catch (e) {
      throw new Error(`Extraction failed: ${e.message || e}`);
    }

    let findingDicts = toNormalized(extracted, scanId);
    if (findingDicts.length > settings.maxFindingsPerScan) {
      findingDicts = findingDicts.slice(0, settings.maxFindingsPerScan);
    }

    await r.putScan(scanId, {
      source_type: 'pentest',
      filename,
      findings_count: findingDicts.length,
      status: 'ingested',
    });
    await r.putFindings(scanId, findingDicts);

    const result = { scan_id: scanId, findings_count: findingDicts.length };
    if (runAnalysis && findingDicts.length) {
      await updateProgress(jobId, 'Running AI risk analysis');
      try {
        const analysis = await runScanAnalysis({
          findings: findingDicts,
          bedrock: getBedrock(),
          modelId,
          assetContext: assetCtx,
          orgContext: orgCtx,
          batchSize: settings.analysisBatchSize,
          maxTokens: settings.bedrockAnalysisMaxTokens,
          scanId,
          onProgress: (m) => updateProgress(jobId, m),
        });
        await r.putAnalysis(scanId, analysis, modelId);
        result.analysis_ready = true;
      } catch (e) {
        log.error({ error: String(e) }, 'pentest_analysis_failed');
        result.analysis_error = String(e.message || e);
      }
    }
    return result;
  });

  res.json({ scan_id: scanId, job_id: jobId, filename, message: 'Report queued for extraction' });
}));

// -----------------------------------------------------------------------------
// Jobs
// -----------------------------------------------------------------------------
app.get('/jobs', asyncRoute(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const repo = await getRepository();
  res.json({ jobs: await repo.listJobs(limit) });
}));

app.get('/jobs/:id', asyncRoute(async (req, res) => {
  const repo = await getRepository();
  const job = await repo.getJob(req.params.id);
  if (!job) throw httpError(404, 'Job not found');
  res.json(job);
}));

// -----------------------------------------------------------------------------
// Scans
// -----------------------------------------------------------------------------
app.get('/scans', asyncRoute(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const repo = await getRepository();
  res.json({ scans: await repo.listScans(limit) });
}));

app.get('/scans/:id', asyncRoute(async (req, res) => {
  const repo = await getRepository();
  const scan = await repo.getScan(req.params.id);
  if (!scan) throw httpError(404, 'Scan not found');
  const [findings, analysis] = await Promise.all([
    repo.listFindings(req.params.id),
    repo.getAnalysis(req.params.id),
  ]);
  // Ensure analysis.analysis is parsed (handle raw_analysis string from earlier runs)
  if (analysis && analysis.analysis && analysis.analysis.raw_analysis && typeof analysis.analysis.raw_analysis === 'string') {
    const parsed = parseJsonLenient(analysis.analysis.raw_analysis);
    if (parsed && parsed.executive_summary) {
      analysis.analysis = parsed;
    }
  }
  res.json({ scan, findings, analysis });
}));

app.get('/scans/:id/findings', asyncRoute(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 500;
  const repo = await getRepository();
  res.json({ findings: await repo.listFindings(req.params.id, limit) });
}));

app.get('/scans/:id/analysis', asyncRoute(async (req, res) => {
  const repo = await getRepository();
  const a = await repo.getAnalysis(req.params.id);
  if (!a) throw httpError(404, 'No analysis for this scan yet');
  // Ensure analysis is parsed (handle raw_analysis string from earlier runs)
  if (a.analysis && a.analysis.raw_analysis && typeof a.analysis.raw_analysis === 'string') {
    const parsed = parseJsonLenient(a.analysis.raw_analysis);
    if (parsed && parsed.executive_summary) {
      a.analysis = parsed;
    }
  }
  res.json(a);
}));

// -----------------------------------------------------------------------------
// Error handlers (must come last)
// -----------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ detail: 'Not found', path: req.path });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) {
    log.error({ error: err.message, stack: err.stack }, 'unhandled_exception');
  }
  res.status(status).json({
    detail: err.message || 'Internal server error',
    request_id: res.getHeader('X-Request-Id'),
  });
});

// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------
async function start() {
  // Eagerly initialize the repository so any config problem surfaces at boot
  // rather than on the first request.
  try {
    await getRepository();
  } catch (err) {
    log.error({ error: err.message }, 'repository_init_failed');
    process.exit(1);
  }
  // Initialize Bedrock client (constructor logs region)
  getBedrock();

  app.listen(settings.port, settings.host, () => {
    log.info({
      host: settings.host,
      port: settings.port,
      environment: settings.environment,
      region: settings.awsRegion,
      storage: settings.storageBackend,
    }, 'uem_started');
    log.info(`Health:  http://${settings.host}:${settings.port}/health`);
    log.info(`Models:  http://${settings.host}:${settings.port}/models`);
  });
}

start();

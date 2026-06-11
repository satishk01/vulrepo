#!/usr/bin/env node
// -----------------------------------------------------------------------------
// analyze-cli.js  —  Offline analysis pipeline for UEM
//
// Processes a folder (or list) of scanner outputs and pen-test reports EXACTLY
// the way POST /upload/multi does, runs the AI risk analysis in batches (so it
// never truncates on large finding sets), and writes the result into the same
// local storage the backend/dashboard read from. The dashboard then renders the
// pre-computed scan with zero API timeouts and zero feature loss.
//
// Usage:
//   node src/cli/analyze-cli.js --input ./reports [options]
//
// Options:
//   --input <dir|file>     Folder of files OR a single file. Repeatable.        (required)
//   --storage-dir <dir>    Local storage root (same as LOCAL_STORAGE_DIR).      (default: ./uem-data)
//   --model <id>           anthropic.claude-sonnet-4-5 | anthropic.claude-opus-4-5
//   --batch-size <n>       Findings per AI call (default 8). Lower if you see truncation.
//   --no-analysis          Ingest + normalize only; skip the AI analysis.
//   --asset-context <json> JSON string or @path/to/file.json
//   --org-context <json>   JSON string or @path/to/file.json
//   --scan-id <id>         Use a fixed scan id (default: generated UUID).
//   --max-findings <n>     Cap total findings (default from MAX_FINDINGS_PER_SCAN).
//   -h, --help
//
// On success it prints the scan id and the dashboard URL to open.
// -----------------------------------------------------------------------------

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Storage backend MUST be local for the CLI. Set defaults BEFORE importing
// modules that read config at import time.
process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND || 'local';
process.env.ENVIRONMENT = process.env.ENVIRONMENT || 'dev';

function parseArgs(argv) {
  const args = { input: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--input': case '-i': args.input.push(next()); break;
      case '--storage-dir': args.storageDir = next(); break;
      case '--model': case '-m': args.model = next(); break;
      case '--batch-size': args.batchSize = parseInt(next(), 10); break;
      case '--no-analysis': args.noAnalysis = true; break;
      case '--asset-context': args.assetContext = next(); break;
      case '--org-context': args.orgContext = next(); break;
      case '--scan-id': args.scanId = next(); break;
      case '--max-findings': args.maxFindings = parseInt(next(), 10); break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (a.startsWith('-')) { console.error(`Unknown option: ${a}`); process.exit(2); }
        else args.input.push(a); // bare path
    }
  }
  return args;
}

function printHelp() {
  console.log(`
UEM offline analysis CLI

  node src/cli/analyze-cli.js --input <dir|file> [options]

Required:
  --input, -i <path>      Folder of files or a single file. Can be repeated.

Options:
  --storage-dir <dir>     Local storage root (must match the backend's
                          LOCAL_STORAGE_DIR). Default: ./uem-data
  --model, -m <id>        anthropic.claude-sonnet-4-5 (default) | anthropic.claude-opus-4-5
  --batch-size <n>        Findings per AI call. Default 8. Lower it if a batch
                          ever fails to parse.
  --no-analysis           Ingest & normalize only; skip AI analysis.
  --asset-context <json>  Inline JSON or @file.json
  --org-context <json>    Inline JSON or @file.json
  --scan-id <id>          Fixed scan id (default: random UUID).
  --max-findings <n>      Cap total findings.
  --help, -h              Show this help.

Example:
  node src/cli/analyze-cli.js -i ./reports --storage-dir ./uem-data -m anthropic.claude-sonnet-4-5
`);
}

async function loadJsonArg(val) {
  if (!val) return {};
  if (val.startsWith('@')) {
    const txt = await fs.readFile(val.slice(1), 'utf-8');
    return JSON.parse(txt);
  }
  return JSON.parse(val);
}

// Recursively collect files from inputs (dirs are walked; files added directly).
async function collectFiles(inputs) {
  const out = [];
  const SKIP = new Set(['.DS_Store']);
  async function walk(p) {
    const st = await fs.stat(p);
    if (st.isDirectory()) {
      const entries = await fs.readdir(p, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.') && e.isFile()) continue;
        await walk(path.join(p, e.name));
      }
    } else if (st.isFile() && !SKIP.has(path.basename(p))) {
      out.push(p);
    }
  }
  for (const inp of inputs) {
    if (!fssync.existsSync(inp)) { console.error(`Input not found: ${inp}`); process.exit(2); }
    await walk(inp);
  }
  return out;
}

const PENTEST_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.html', '.htm', '.doc', '.docx']);
const STRUCTURED_EXTENSIONS = new Set(['.json', '.sarif', '.csv', '.xml']);

function ext(name) { return '.' + name.toLowerCase().split('.').pop(); }

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.input.length === 0) { printHelp(); process.exit(args.help ? 0 : 2); }

  // Resolve storage dir and export it so config.js picks it up on import.
  const storageDir = path.resolve(args.storageDir || process.env.LOCAL_STORAGE_DIR || './uem-data');
  process.env.LOCAL_STORAGE_DIR = storageDir;
  fssync.mkdirSync(storageDir, { recursive: true });

  // Import AFTER env is set (config.js reads env at import time).
  const { settings } = await import('../config.js');
  const { getBedrock } = await import('../bedrockClient.js');
  const { getRepository } = await import('../persistence/index.js');
  const { normalizeFindings } = await import('../normalizer.js');
  const { extractText, extractFindingsFromText, toNormalized } = await import('../pentestParser.js');
  const { analyzeInBatches } = await import('../batchAnalyzer.js');

  const modelId = args.model || settings.bedrockDefaultModel;
  const batchSize = Number.isFinite(args.batchSize) && args.batchSize > 0 ? args.batchSize : 8;
  const runAnalysis = !args.noAnalysis;
  const maxFindings = Number.isFinite(args.maxFindings) ? args.maxFindings : settings.maxFindingsPerScan;
  const scanId = args.scanId || randomUUID();

  let assetContext = {};
  let orgContext = {};
  try {
    assetContext = await loadJsonArg(args.assetContext);
    orgContext = await loadJsonArg(args.orgContext);
  } catch (e) {
    console.error(`Failed to parse context JSON: ${e.message}`); process.exit(2);
  }

  const files = await collectFiles(args.input);
  if (files.length === 0) { console.error('No files found to process.'); process.exit(2); }

  const log = (m) => console.log(`\x1b[36m[uem-cli]\x1b[0m ${m}`);
  log(`Storage : ${storageDir}`);
  log(`Model   : ${modelId}`);
  log(`Scan id : ${scanId}`);
  log(`Files   : ${files.length}`);
  log(`Batch   : ${batchSize} findings/call`);
  console.log('');

  const bedrock = getBedrock();
  const allFindings = [];
  const fileResults = [];
  let successCount = 0;

  // ---- Ingest each file (mirrors POST /upload/multi exactly) -----------------
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const filename = path.basename(filePath);
    const e = ext(filename);
    process.stdout.write(`  [${i + 1}/${files.length}] ${filename} ... `);

    try {
      const buffer = await fs.readFile(filePath);

      if (PENTEST_EXTENSIONS.has(e)) {
        let text;
        try { text = await extractText(filename, buffer); }
        catch (err) { console.log(`error (extract): ${err.message}`); fileResults.push({ filename, status: 'error', reason: `Text extraction failed: ${err.message}` }); continue; }

        if (!text || text.length < 50) { console.log('skipped (text too short)'); fileResults.push({ filename, status: 'skipped', reason: 'Extracted text too short (< 50 chars)' }); continue; }

        let extracted;
        try { extracted = await extractFindingsFromText(text, bedrock, modelId); }
        catch (err) { console.log(`error (extract findings): ${err.message}`); fileResults.push({ filename, status: 'error', reason: `Finding extraction failed: ${err.message}` }); continue; }

        const findings = toNormalized(extracted || [], scanId);
        if (findings.length === 0) { console.log('ok (0 findings)'); fileResults.push({ filename, status: 'ok', findings_count: 0, type: 'pentest-report' }); continue; }

        allFindings.push(...findings);
        successCount++;
        console.log(`ok (${findings.length} findings, pentest)`);
        fileResults.push({ filename, status: 'ok', findings_count: findings.length, type: 'pentest-report' });

      } else if (STRUCTURED_EXTENSIONS.has(e)) {
        const rawText = buffer.toString('utf-8');
        let rawData;
        if (e === '.csv') rawData = { _raw_csv: rawText, _format: 'csv' };
        else {
          try { rawData = JSON.parse(rawText); }
          catch { rawData = { _raw_csv: rawText, _format: 'csv' }; }
        }
        let findings;
        try { findings = normalizeFindings(rawData, 'auto', scanId); }
        catch (err) { console.log(`error (normalize): ${err.message}`); fileResults.push({ filename, status: 'error', reason: `Normalization failed: ${err.message}` }); continue; }

        if (!Array.isArray(findings) || findings.length === 0) { console.log('ok (0 findings)'); fileResults.push({ filename, status: 'ok', findings_count: 0, type: 'structured' }); continue; }
        allFindings.push(...findings);
        successCount++;
        console.log(`ok (${findings.length} findings, structured)`);
        fileResults.push({ filename, status: 'ok', findings_count: findings.length, type: 'structured' });

      } else if (e === '.xlsx' || e === '.xls') {
        console.log('skipped (Excel — export as CSV)');
        fileResults.push({ filename, status: 'skipped', reason: 'Excel not supported — export as CSV' });

      } else {
        const text = buffer.toString('utf-8');
        if (text && text.length > 50) {
          let extracted;
          try { extracted = await extractFindingsFromText(text, bedrock, modelId); }
          catch (err) { console.log(`error: ${err.message}`); fileResults.push({ filename, status: 'error', reason: `Finding extraction failed: ${err.message}` }); continue; }
          const findings = toNormalized(extracted || [], scanId);
          if (findings.length > 0) {
            allFindings.push(...findings);
            successCount++;
            console.log(`ok (${findings.length} findings, auto)`);
            fileResults.push({ filename, status: 'ok', findings_count: findings.length, type: 'pentest-report' });
          } else {
            console.log('ok (0 findings)');
            fileResults.push({ filename, status: 'ok', findings_count: 0, type: 'pentest-report' });
          }
        } else {
          console.log('skipped (unrecognized/empty)');
          fileResults.push({ filename, status: 'skipped', reason: 'Unrecognized format or empty content' });
        }
      }
    } catch (err) {
      console.log(`error: ${err.message}`);
      fileResults.push({ filename, status: 'error', reason: `Unexpected error: ${err.message}` });
    }
  }

  console.log('');
  if (successCount === 0) {
    console.error('\x1b[31mNo files could be processed successfully.\x1b[0m');
    for (const f of fileResults) if (f.status !== 'ok') console.error(`  - ${f.filename}: ${f.reason}`);
    process.exit(1);
  }

  let findings = allFindings;
  if (findings.length > maxFindings) {
    log(`Capping findings ${findings.length} -> ${maxFindings}`);
    findings = findings.slice(0, maxFindings);
  }
  log(`Total findings extracted: ${findings.length}`);

  // ---- Persist scan + findings (same layout the dashboard reads) -------------
  const repo = await getRepository();
  await repo.putScan(scanId, {
    source_type: 'cli-multi-upload',
    filename: fileResults.map(f => f.filename).join(', '),
    scan_type: 'multi',
    findings_count: findings.length,
    files_processed: fileResults.length,
    files_success_count: successCount,
    status: 'ingested',
  });
  await repo.putFindings(scanId, findings);
  log('Findings saved.');

  // ---- Batched AI analysis ---------------------------------------------------
  if (runAnalysis && findings.length > 0) {
    console.log('');
    log('Running batched AI risk analysis...');
    try {
      const analysis = await analyzeInBatches({
        findings,
        bedrock,
        modelId,
        assetContext,
        orgContext,
        batchSize,
        maxTokens: settings.bedrockAnalysisMaxTokens,
        scanId,
        onProgress: (m) => log(`  ${m}`),
      });
      await repo.putAnalysis(scanId, analysis, modelId);
      const s = analysis.executive_summary;
      console.log('');
      log(`Analysis complete: ${analysis.scored_findings.length} scored findings`);
      log(`  critical ${s.critical_count} | high ${s.high_count} | medium ${s.medium_count} | low ${s.low_count}`);
      log(`  attack paths ${analysis.attack_paths.length} | compliance gaps ${analysis.compliance_gaps.length}`);
    } catch (err) {
      console.error(`\x1b[31mAnalysis failed:\x1b[0m ${err.message}`);
      console.error('Findings were still saved. You can re-run with a smaller --batch-size.');
      process.exit(1);
    }
  } else {
    log('Analysis skipped (--no-analysis).');
  }

  // ---- Done ------------------------------------------------------------------
  console.log('');
  console.log('\x1b[32m✓ Scan ready.\x1b[0m');
  console.log('');
  console.log(`  Scan ID       : ${scanId}`);
  console.log(`  Storage dir   : ${storageDir}`);
  console.log(`  Dashboard URL : http://localhost:3000/dashboard/${scanId}`);
  console.log(`  Scan detail   : http://localhost:3000/scans/${scanId}`);
  console.log('');
  console.log('Start the backend (STORAGE_BACKEND=local, same storage dir) and the');
  console.log('frontend, then open the Dashboard URL above.');
}

main().catch((err) => {
  console.error('\x1b[31mFatal:\x1b[0m', err.stack || err.message || err);
  process.exit(1);
});

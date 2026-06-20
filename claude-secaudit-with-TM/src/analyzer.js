import path from 'node:path';
import pLimit from 'p-limit';
import pc from 'picocolors';
import { readFileChunks } from './walker.js';
import { extractJson } from './bedrock.js';
import {
  SYSTEM_PROMPT, buildFileUserPrompt, SUMMARY_INSTRUCTION,
  ARCH_SYSTEM_PROMPT, buildArchUserPrompt,
} from './prompts.js';
import { SEVERITIES } from './config.js';

const LANG_BY_EXT = {
  '.js': 'JavaScript', '.jsx': 'JavaScript/React', '.ts': 'TypeScript', '.tsx': 'TypeScript/React',
  '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.py': 'Python', '.rb': 'Ruby', '.php': 'PHP',
  '.java': 'Java', '.kt': 'Kotlin', '.go': 'Go', '.rs': 'Rust', '.cs': 'C#', '.cpp': 'C++',
  '.c': 'C', '.swift': 'Swift', '.scala': 'Scala', '.sql': 'SQL', '.sh': 'Shell', '.ps1': 'PowerShell',
  '.tf': 'Terraform', '.yml': 'YAML', '.yaml': 'YAML', '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte',
};

function normalizeFinding(raw, { file, modelAlias, source }) {
  const sev = String(raw.severity || 'info').toLowerCase();
  const severity = SEVERITIES.includes(sev) ? sev : 'info';
  const start = Number.isFinite(+raw.startLine) ? +raw.startLine : null;
  const end = Number.isFinite(+raw.endLine) ? +raw.endLine : start;
  return {
    id: null, // assigned after dedupe
    title: String(raw.title || 'Untitled finding').slice(0, 240),
    severity,
    confidence: ['high', 'medium', 'low'].includes(String(raw.confidence || '').toLowerCase())
      ? String(raw.confidence).toLowerCase() : 'medium',
    category: String(raw.category || 'other').toLowerCase(),
    cwe: raw.cwe || null,
    owasp: raw.owasp || null,
    file: file?.relPath || (Array.isArray(raw.involvedFiles) ? raw.involvedFiles.join(', ') : null),
    involvedFiles: Array.isArray(raw.involvedFiles) ? raw.involvedFiles : (file ? [file.relPath] : []),
    startLine: start,
    endLine: end,
    description: String(raw.description || '').trim(),
    impact: String(raw.impact || '').trim(),
    attackScenario: String(raw.attackScenario || '').trim(),
    evidence: typeof raw.evidence === 'string' ? raw.evidence.trim() : '',
    recommendation: String(raw.recommendation || '').trim(),
    scannerBlindSpot: raw.scannerBlindSpot || null,
    source,                 // 'file' | 'architecture'
    foundBy: [modelAlias],  // models that reported it
  };
}

/** Dedup key: same file + overlapping lines + same category + similar title. */
function dedupeKey(f) {
  const titleSig = f.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
  const lineBucket = f.startLine != null ? Math.floor(f.startLine / 8) : 'x';
  return `${f.file || ''}::${f.category}::${lineBucket}::${titleSig}`;
}

function mergeFindings(findings) {
  const map = new Map();
  for (const f of findings) {
    const key = dedupeKey(f);
    const existing = map.get(key);
    if (!existing) { map.set(key, f); continue; }
    // Keep the higher-severity / higher-confidence variant, union the models.
    const sevRank = (s) => SEVERITIES.indexOf(s);
    const better = sevRank(f.severity) < sevRank(existing.severity) ? f : existing;
    const other = better === f ? existing : f;
    better.foundBy = Array.from(new Set([...better.foundBy, ...other.foundBy]));
    if (!better.description && other.description) better.description = other.description;
    if (!better.recommendation && other.recommendation) better.recommendation = other.recommendation;
    map.set(key, better);
  }
  return Array.from(map.values());
}

/**
 * Run the full analysis.
 * @returns { findings, summaries, stats }
 */
export async function analyze({
  files, models, client, config, log,
}) {
  const limit = pLimit(config.concurrency);
  const allFindings = [];
  const summaries = []; // { file, summary, model }
  let unitsTotal = 0;
  let unitsDone = 0;
  let parseErrors = 0;

  // Pre-compute total work units (chunks x models) for accurate progress.
  log(pc.dim('  Reading and chunking files…'));
  const fileChunks = new Map();
  let multiChunk = 0;
  for (const file of files) {
    if (file.skipped) continue;
    const chunks = await readFileChunks(file, config);
    if (!chunks.length) continue;
    fileChunks.set(file, chunks);
    if (chunks.length > 1) multiChunk++;
    unitsTotal += chunks.length * models.length;
  }

  log(pc.dim(`  Prepared ${fileChunks.size} files`
    + (multiChunk ? ` (${multiChunk} split into multiple chunks)` : '')));
  log(pc.dim(`  Analysis units (chunks × models): ${unitsTotal}`));
  log(pc.dim(`  Concurrency: ${config.concurrency} parallel request(s)\n`));

  const verbose = !!config.verbose;
  const quiet = !!config.quiet;
  const analysisStart = Date.now();
  let findingsCount = 0;
  let inFlight = 0;
  let lastStarted = '';

  const fmtElapsed = () => {
    const s = Math.floor((Date.now() - analysisStart) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  // Sticky single-line status used in non-verbose mode. \r returns to line start.
  const drawStatus = () => {
    if (verbose || quiet) return;
    const pct = unitsTotal ? Math.round((unitsDone / unitsTotal) * 100) : 100;
    const cur = lastStarted ? `· ${lastStarted}` : '';
    const line = `  [${fmtElapsed()}] ${unitsDone}/${unitsTotal} (${pct}%) · ${findingsCount} findings · ${inFlight} active ${cur}`;
    // pad to clear any leftover characters from a previous longer line
    process.stdout.write('\r' + line.slice(0, 110).padEnd(110, ' '));
  };

  // Heartbeat: redraw once per second so the elapsed clock always ticks,
  // even when every request is mid-flight and nothing has completed yet.
  let heartbeat = null;
  if (!verbose && !quiet) {
    heartbeat = setInterval(drawStatus, 1000);
    if (heartbeat.unref) heartbeat.unref();
  }

  const tasks = [];
  for (const [file, chunks] of fileChunks) {
    const lang = LANG_BY_EXT[path.extname(file.relPath).toLowerCase()] || '';
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const isFirstChunk = ci === 0;
      const chunkLabel = chunks.length > 1 ? ` chunk ${ci + 1}/${chunks.length}` : '';
      for (const model of models) {
        tasks.push(limit(async () => {
          const unitStart = Date.now();
          inFlight++;
          lastStarted = `${file.relPath} [${model.alias}]`;
          if (verbose) log(pc.dim(`  → ${file.relPath} [${model.alias}]${chunkLabel} …`));
          else drawStatus();

          const userText =
            buildFileUserPrompt({ relPath: file.relPath, category: file.category, chunk, language: lang })
            + (isFirstChunk ? `\n\n${SUMMARY_INSTRUCTION}` : '');
          let unitFindings = 0;
          try {
            const { text } = await client.converse({
              modelId: model.id,
              system: SYSTEM_PROMPT,
              userText,
              maxTokens: config.maxTokensPerResponse,
            });
            const parsed = extractJson(text);
            if (!parsed) { parseErrors++; }
            else {
              const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
              for (const raw of findings) {
                allFindings.push(normalizeFinding(raw, { file, modelAlias: model.alias, source: 'file' }));
              }
              unitFindings = findings.length;
              findingsCount += unitFindings;
              if (isFirstChunk && parsed.summary && typeof parsed.summary === 'object') {
                summaries.push({ file: file.relPath, category: file.category, summary: parsed.summary, model: model.alias });
              }
            }
            if (verbose) {
              const secs = ((Date.now() - unitStart) / 1000).toFixed(1);
              const fmsg = unitFindings ? pc.yellow(`${unitFindings} finding${unitFindings === 1 ? '' : 's'}`) : pc.dim('clean');
              log(`  ${pc.green('✓')} ${file.relPath} [${model.alias}]${chunkLabel} ${pc.dim(secs + 's')} · ${fmsg}`);
            }
          } catch (err) {
            // In verbose mode this stands alone; in sticky mode we print on a
            // fresh line so it isn't clobbered by the status line.
            const msg = `  ${pc.red('✗')} ${file.relPath} [${model.alias}]${chunkLabel}: ${err.name || err.message}`;
            if (verbose) log(msg);
            else if (!quiet) { process.stdout.write('\r' + ' '.repeat(110) + '\r'); log(msg); }
          } finally {
            inFlight--;
            unitsDone++;
            drawStatus();
          }
        }));
      }
    }
  }

  await Promise.all(tasks);
  if (heartbeat) clearInterval(heartbeat);
  if (!verbose && !quiet) process.stdout.write('\r' + ' '.repeat(110) + '\r');
  log(`  ${pc.green('✓')} File analysis complete: ${unitsDone}/${unitsTotal} units · ${findingsCount} raw findings · ${fmtElapsed()} elapsed`);

  // ---- Architecture pass (cross-file) ----
  let archFindings = [];
  if (summaries.length > 1) {
    // Use the deepest available model for the architecture pass if present.
    const archModel = models.find((m) => m.alias.includes('opus'))
      || models.find((m) => m.alias.includes('fable'))
      || models[0];
    log(pc.dim(`\n  Cross-file architecture pass using ${archModel.alias} (correlating ${summaries.length} file summaries)…`));

    // De-dup summaries to one-per-file (prefer first model's).
    const perFile = new Map();
    for (const s of summaries) if (!perFile.has(s.file)) perFile.set(s.file, s);

    const summaryBlocks = Array.from(perFile.values()).map((s) => {
      const sm = s.summary;
      return [
        `### ${s.file} (${s.category})`,
        `purpose: ${sm.purpose || '-'}`,
        sm.routes?.length ? `routes: ${sm.routes.join('; ')}` : null,
        sm.authChecks?.length ? `auth: ${sm.authChecks.join('; ')}` : null,
        sm.sinks?.length ? `sinks: ${sm.sinks.join('; ')}` : null,
        sm.sensitiveData?.length ? `sensitive: ${sm.sensitiveData.join('; ')}` : null,
        sm.trustBoundaries?.length ? `trust-boundaries: ${sm.trustBoundaries.join('; ')}` : null,
      ].filter(Boolean).join('\n');
    });

    // Batch within char budget.
    const batches = [];
    let cur = [];
    let curLen = 0;
    for (const block of summaryBlocks) {
      if (curLen + block.length > config.crossFileBatchChars && cur.length) {
        batches.push(cur); cur = []; curLen = 0;
      }
      cur.push(block); curLen += block.length + 2;
    }
    if (cur.length) batches.push(cur);

    let bi = 0;
    for (const batch of batches) {
      bi++;
      log(pc.dim(`    architecture batch ${bi}/${batches.length} (${batch.length} files)…`));
      try {
        const { text } = await client.converse({
          modelId: archModel.id,
          system: ARCH_SYSTEM_PROMPT,
          userText: buildArchUserPrompt(batch.join('\n\n')),
          maxTokens: config.maxTokensPerResponse,
        });
        const parsed = extractJson(text);
        if (parsed && Array.isArray(parsed.findings)) {
          for (const raw of parsed.findings) {
            archFindings.push(normalizeFinding(raw, { file: null, modelAlias: archModel.alias, source: 'architecture' }));
          }
        }
      } catch (err) {
        log(pc.yellow(`  ! architecture pass: ${err.name || err.message}`));
      }
    }
  }

  const merged = mergeFindings([...allFindings, ...archFindings]);

  // Sort: severity, then confidence, then file.
  const confRank = { high: 0, medium: 1, low: 2 };
  merged.sort((a, b) =>
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
    || confRank[a.confidence] - confRank[b.confidence]
    || (a.file || '').localeCompare(b.file || ''));

  merged.forEach((f, i) => { f.id = `SA-${String(i + 1).padStart(4, '0')}`; });

  return {
    findings: merged,
    summaries,
    stats: {
      rawFindings: allFindings.length + archFindings.length,
      mergedFindings: merged.length,
      architectureFindings: archFindings.length,
      parseErrors,
      filesAnalyzed: fileChunks.size,
      units: unitsTotal,
    },
  };
}

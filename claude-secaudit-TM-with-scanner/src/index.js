import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { discoverFiles } from './walker.js';
import { MultiProviderClient } from './providers/factory.js';
import { analyze } from './analyzer.js';
import { renderReport } from './report.js';
import { runScanners } from './scanners/orchestrator.js';
import { resolveScanners } from './scanners/registry.js';
import { finalizeFindings } from './findings.js';
import {
  DEFAULTS, loadUserConfig, resolveModelId,
} from './config.js';

const VERSION = '3.0.0';

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

export async function run(targetDir, opts) {
  const startedAt = Date.now();
  const log = (msg) => { if (!opts.quiet) console.log(msg); };

  const cwd = process.cwd();
  const userConfig = await loadUserConfig(cwd);
  if (userConfig) log(pc.dim(`Loaded config: ${userConfig.file}`));

  const root = path.resolve(targetDir);
  log(pc.bold(pc.cyan('\n  claude-secaudit')) + pc.dim(` v${VERSION}`));
  log(pc.dim('  Security review · AI models + open-source scanners\n'));
  log(`  Target:  ${pc.white(root)}`);

  // Mode: 'llm' | 'scanners' | 'both'
  const mode = (opts.mode || 'llm').toLowerCase();
  if (!['llm', 'scanners', 'both'].includes(mode)) {
    console.error(pc.red(`\n  Invalid --mode "${mode}". Use: llm, scanners, or both.`));
    return { ok: false };
  }
  const useLlm = mode === 'llm' || mode === 'both';
  const useScanners = mode === 'scanners' || mode === 'both';
  log(`  Mode:    ${pc.white(mode)} ${pc.dim(useLlm && useScanners ? '(AI + scanners)' : useLlm ? '(AI only)' : '(scanners only)')}`);

  // Resolve models only if the LLM path is active.
  let models = [];
  let providersUsed = [];
  if (useLlm) {
    const modelNames = (opts.models || DEFAULTS.models);
    models = modelNames.map((n) => resolveModelId(n.trim(), userConfig));
    log(`  Models:  ${models.map((m) => `${pc.cyan(m.alias)}${pc.dim(` [${m.provider}]`)}`).join(', ')}`);
    providersUsed = Array.from(new Set(models.map((m) => m.provider)));
    log(`  Providers: ${providersUsed.map((p) => pc.white(p)).join(', ')}`);
    if (providersUsed.includes('bedrock')) log(`  Region:  ${pc.white(opts.region)} ${pc.dim('(Bedrock)')}`);
  }

  // Resolve scanners only if the scanner path is active.
  let scanners = [];
  if (useScanners) {
    scanners = resolveScanners(opts.scanners);
    log(`  Scanners: ${scanners.map((s) => pc.cyan(s.id)).join(', ')}`);
  }

  const config = {
    ...DEFAULTS,
    region: opts.region,
    concurrency: opts.concurrency,
    verbose: !!opts.verbose,
    quiet: !!opts.quiet,
    maxChunkChars: DEFAULTS.maxChunkChars,
    chunkOverlapLines: DEFAULTS.chunkOverlapLines,
    maxTokensPerResponse: DEFAULTS.maxTokensPerResponse,
    maxFileBytes: DEFAULTS.maxFileBytes,
    crossFileBatchChars: DEFAULTS.crossFileBatchChars,
    ...(userConfig?.analysis || {}),
  };

  // Discover
  log(pc.dim('\n  Discovering source files...'));
  const files = await discoverFiles(root, {
    include: opts.include || [],
    exclude: opts.exclude || [],
    maxFileBytes: config.maxFileBytes,
  });
  const analyzable = files.filter((f) => !f.skipped);
  const skipped = files.filter((f) => f.skipped);
  log(`  Found ${pc.bold(analyzable.length)} analyzable files`
    + (skipped.length ? pc.dim(` (${skipped.length} skipped: too large)`) : ''));

  if (!analyzable.length) {
    log(pc.yellow('\n  No analyzable source files found. Check the path and --include/--exclude options.'));
    return { ok: false };
  }

  if (opts.maxFiles && analyzable.length > opts.maxFiles) {
    log(pc.yellow(`  Limiting to first ${opts.maxFiles} files (--max-files).`));
    analyzable.length = opts.maxFiles;
  }

  if (opts.dryRun) {
    log(pc.bold('\n  Dry run — files that would be analyzed:'));
    analyzable.forEach((f) => log(`    ${pc.dim(f.category.padEnd(9))} ${f.relPath}`));
    log(pc.dim(`\n  ${analyzable.length} files. Re-run without --dry-run to analyze.`));
    return { ok: true, dryRun: true };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Run the selected engines: LLM analysis and/or non-LLM scanners.
  // ──────────────────────────────────────────────────────────────────────
  let client = null;
  let llmResult = null;
  let scannerResult = null;

  if (useLlm) {
    client = new MultiProviderClient({
      region: config.region,
      profile: opts.profile,
      maxRetries: DEFAULTS.maxRetries,
      requestTimeoutMs: DEFAULTS.requestTimeoutMs,
    });
    try {
      client.preflight(models);
    } catch (err) {
      console.error(pc.red('\n  ' + err.message));
      console.error(pc.yellow('\n  → See the guide "Credentials (BYOK)" for the env vars each provider needs.'));
      return { ok: false };
    }
  }

  // Run scanners first (usually fast) so their output is visible before the
  // potentially long AI pass.
  if (useScanners) {
    log(pc.bold(pc.white('\n  ▶ Non-LLM scanners')));
    scannerResult = await runScanners(scanners, root, {
      concurrency: Math.max(2, Math.min(4, config.concurrency)),
      log,
      verbose: config.verbose,
    });
  }

  if (useLlm) {
    log(pc.bold(pc.white('\n  ▶ AI security review')));
    log(pc.dim('  Analyzing (this calls your selected AI provider(s) and may take several minutes)...'));
    try {
      llmResult = await analyze({ files: analyzable, models, client, config, log });
    } catch (err) {
      console.error(pc.red(`\n  AI analysis failed: ${err.message}`));
      if (/security token|credential|UnrecognizedClient|AccessDenied|API_KEY|api[- ]key|401|403/i.test(err.message || '')) {
        console.error(pc.yellow('  → This looks like a credentials / permissions problem. Check the env vars for the relevant provider.'));
      }
      // If scanners already produced results, continue to a report rather than aborting.
      if (!scannerResult || !scannerResult.findings.length) throw err;
      console.error(pc.yellow('  → Continuing with scanner findings only.'));
    }
  }

  const duration = Date.now() - startedAt;

  // Merge findings from both streams and finalize (dedupe + sort + IDs).
  const combined = [
    ...(llmResult?.findings || []),
    ...(scannerResult?.findings || []),
  ];
  const findings = finalizeFindings(combined);

  // Combined stats.
  const stats = {
    rawFindings: combined.length,
    mergedFindings: findings.length,
    architectureFindings: llmResult?.stats?.architectureFindings || 0,
    parseErrors: llmResult?.stats?.parseErrors || 0,
    filesAnalyzed: llmResult?.stats?.filesAnalyzed || analyzable.length,
    scannerFindings: scannerResult?.stats?.totalFindings || 0,
    scannersRun: scannerResult?.stats?.scannersRun || 0,
    scannersMissing: scannerResult?.stats?.scannersMissing || 0,
    corroborated: findings.filter((f) => f.source === 'corroborated').length,
  };

  // Build report metadata.
  const usage = client ? client.usage : { inputTokens: 0, outputTokens: 0, requests: 0 };
  const meta = {
    target: root,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    mode,
    models,
    region: config.region,
    providers: providersUsed,
    usageByProvider: client ? client.usageByProvider() : {},
    scanners: scannerResult ? scannerResult.perScanner.map((s) => ({ id: s.id, name: s.name, kind: s.kind, findings: s.findings.length, error: s.error || null })) : [],
    scannersMissing: scannerResult ? scannerResult.missing : [],
    duration: fmtDuration(duration),
    usage,
    version: VERSION,
  };

  const outDir = path.resolve(opts.out || DEFAULTS.outputDir);
  await mkdir(outDir, { recursive: true });

  const html = renderReport({ findings, stats, meta });
  const htmlPath = path.join(outDir, 'report.html');
  await writeFile(htmlPath, html, 'utf8');

  const jsonPath = path.join(outDir, 'findings.json');
  await writeFile(jsonPath, JSON.stringify({
    meta: { ...meta, models: models.map((m) => ({ alias: m.alias, provider: m.provider, id: m.id })) },
    stats,
    findings,
  }, null, 2), 'utf8');

  // Console summary.
  const counts = findings.reduce((a, f) => (a[f.severity] = (a[f.severity] || 0) + 1, a), {});
  log(pc.bold('\n  ─── Summary ───'));
  log(`  ${pc.red('Critical')} ${counts.critical || 0}   ${pc.yellow('High')} ${counts.high || 0}   `
    + `Medium ${counts.medium || 0}   Low ${counts.low || 0}   Info ${counts.info || 0}`);
  log(`  Total findings: ${pc.bold(findings.length)} `
    + pc.dim(`(${stats.scannerFindings} from scanners, ${stats.architectureFindings} cross-file, ${stats.corroborated} AI+scanner corroborated)`));
  if (useLlm && client) {
    log(`  Tokens: ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out · `
      + `${usage.requests} requests · ${fmtDuration(duration)}`);
  } else {
    log(`  Elapsed: ${fmtDuration(duration)}`);
  }
  log(pc.bold('\n  Report written:'));
  log(`    ${pc.green(htmlPath)}`);
  log(`    ${pc.dim(jsonPath)}\n`);

  return { ok: true, htmlPath, jsonPath, findings };
}

export { VERSION };

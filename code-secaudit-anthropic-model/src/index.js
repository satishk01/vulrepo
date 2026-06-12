import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { discoverFiles } from './walker.js';
import { BedrockClient } from './bedrock.js';
import { analyze } from './analyzer.js';
import { renderReport } from './report.js';
import {
  DEFAULTS, loadUserConfig, resolveModelId,
} from './config.js';

const VERSION = '1.0.0';

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
  log(pc.dim('  Deep AI security review · finds what SAST/DAST miss\n'));
  log(`  Target:  ${pc.white(root)}`);

  // Resolve models
  const modelNames = (opts.models || DEFAULTS.models);
  const models = modelNames.map((n) => resolveModelId(n.trim(), userConfig));
  log(`  Models:  ${models.map((m) => pc.cyan(m.alias)).join(', ')}`);
  log(`  Region:  ${pc.white(opts.region)}`);

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

  // Bedrock client
  const client = new BedrockClient({
    region: config.region,
    profile: opts.profile,
    maxRetries: DEFAULTS.maxRetries,
    requestTimeoutMs: DEFAULTS.requestTimeoutMs,
  });

  log(pc.dim('\n  Analyzing (this calls AWS Bedrock and may take several minutes)...'));
  let result;
  try {
    result = await analyze({ files: analyzable, models, client, config, log });
  } catch (err) {
    console.error(pc.red(`\n  Analysis failed: ${err.message}`));
    if (/security token|credential|UnrecognizedClient|AccessDenied/i.test(err.message || '')) {
      console.error(pc.yellow('  → This looks like an AWS credentials / permissions problem. See the README "AWS setup" section.'));
    }
    throw err;
  }

  const duration = Date.now() - startedAt;

  // Build report
  const meta = {
    target: root,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    models,
    region: config.region,
    duration: fmtDuration(duration),
    usage: client.usage,
    version: VERSION,
  };

  const outDir = path.resolve(opts.out || DEFAULTS.outputDir);
  await mkdir(outDir, { recursive: true });

  const html = renderReport({ findings: result.findings, stats: result.stats, meta });
  const htmlPath = path.join(outDir, 'report.html');
  await writeFile(htmlPath, html, 'utf8');

  // Machine-readable JSON alongside.
  const jsonPath = path.join(outDir, 'findings.json');
  await writeFile(jsonPath, JSON.stringify({
    meta: { ...meta, models: models.map((m) => ({ alias: m.alias, id: m.id })) },
    stats: result.stats,
    findings: result.findings,
  }, null, 2), 'utf8');

  // Summary to console
  const counts = result.findings.reduce((a, f) => (a[f.severity] = (a[f.severity] || 0) + 1, a), {});
  log(pc.bold('\n  ─── Summary ───'));
  log(`  ${pc.red('Critical')} ${counts.critical || 0}   ${pc.yellow('High')} ${counts.high || 0}   `
    + `Medium ${counts.medium || 0}   Low ${counts.low || 0}   Info ${counts.info || 0}`);
  log(`  Total findings: ${pc.bold(result.findings.length)} `
    + pc.dim(`(${result.stats.architectureFindings} cross-file, ${result.stats.parseErrors} parse errors)`));
  log(`  Tokens: ${client.usage.inputTokens.toLocaleString()} in / ${client.usage.outputTokens.toLocaleString()} out · `
    + `${client.usage.requests} requests · ${fmtDuration(duration)}`);
  log(pc.bold('\n  Report written:'));
  log(`    ${pc.green(htmlPath)}`);
  log(`    ${pc.dim(jsonPath)}\n`);

  return { ok: true, htmlPath, jsonPath, findings: result.findings };
}

export { VERSION };

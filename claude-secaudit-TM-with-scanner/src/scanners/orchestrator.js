import pLimit from 'p-limit';
import pc from 'picocolors';
import { isAvailable, runScanner } from './runners.js';
import { SCANNER_KINDS } from './registry.js';

/**
 * Run a set of non-LLM scanners against `root`.
 *
 * @returns {
 *   findings: [...common-shape findings with source:'scanner'],
 *   perScanner: [{ id, name, kind, available, findings, error, durationMs }],
 *   available: [...ids], missing: [...ids],
 *   stats: { scannersRun, scannersMissing, totalFindings }
 * }
 */
export async function runScanners(scanners, root, { concurrency = 3, log = () => {}, verbose = false } = {}) {
  // 1. availability probe (fast, parallel)
  log(pc.dim('  Checking which scanners are installed…'));
  const avail = await Promise.all(scanners.map(async (s) => ({ s, ok: await isAvailable(s) })));
  const present = avail.filter((a) => a.ok).map((a) => a.s);
  const missing = avail.filter((a) => !a.ok).map((a) => a.s);

  if (present.length) {
    log(`  Scanners available: ${present.map((s) => pc.green(s.id)).join(', ')}`);
  }
  if (missing.length) {
    log(pc.yellow(`  Scanners NOT installed (skipped): ${missing.map((s) => s.id).join(', ')}`));
    log(pc.dim('    Install hints:'));
    for (const s of missing) log(pc.dim(`      • ${s.id}: ${s.install}`));
  }

  if (!present.length) {
    log(pc.yellow('\n  No non-LLM scanners are installed. See the guide “Installing the scanners”.'));
    return {
      findings: [], perScanner: [], available: [], missing: missing.map((s) => s.id),
      stats: { scannersRun: 0, scannersMissing: missing.length, totalFindings: 0 },
    };
  }

  // 2. run available scanners in parallel
  log(pc.dim(`\n  Running ${present.length} scanner(s) (this runs the actual tools on your code)…`));
  const limit = pLimit(concurrency);
  const results = await Promise.all(present.map((s) => limit(async () => {
    if (verbose) log(pc.dim(`    → ${s.id} starting…`));
    const r = await runScanner(s, root, { log, verbose });
    const n = r.findings.length;
    const secs = (r.durationMs / 1000).toFixed(1);
    if (r.error) {
      log(`  ${pc.yellow('!')} ${s.name} (${s.id}) ${pc.dim(secs + 's')}: ${pc.yellow(r.error)}`);
    } else {
      const fmsg = n ? pc.yellow(`${n} finding${n === 1 ? '' : 's'}`) : pc.dim('clean');
      log(`  ${pc.green('✓')} ${s.name} (${SCANNER_KINDS[s.kind] || s.kind}) ${pc.dim(secs + 's')} · ${fmsg}`);
    }
    return { id: s.id, name: s.name, kind: s.kind, available: true, findings: r.findings, error: r.error, durationMs: r.durationMs };
  })));

  const allFindings = results.flatMap((r) => r.findings);

  return {
    findings: allFindings,
    perScanner: results,
    available: present.map((s) => s.id),
    missing: missing.map((s) => s.id),
    stats: {
      scannersRun: present.length,
      scannersMissing: missing.length,
      totalFindings: allFindings.length,
    },
  };
}

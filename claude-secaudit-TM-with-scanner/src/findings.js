import { SEVERITIES } from './config.js';

/** Dedup key: same file + overlapping lines + same category + similar title. */
export function dedupeKey(f) {
  const titleSig = f.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
  const lineBucket = f.startLine != null ? Math.floor(f.startLine / 8) : 'x';
  return `${f.file || ''}::${f.category}::${lineBucket}::${titleSig}`;
}

/**
 * Merge findings from any sources (LLM models and/or non-LLM scanners).
 * Overlapping findings are unioned: foundBy accumulates every model/tool that
 * reported it, and the higher-severity variant wins. When a finding is reported
 * by BOTH an AI model and a scanner, that cross-validation is preserved in
 * foundBy (e.g. ['opus-4.8', 'semgrep']).
 */
export function mergeFindings(findings) {
  const map = new Map();
  for (const f of findings) {
    const key = dedupeKey(f);
    const existing = map.get(key);
    if (!existing) { map.set(key, { ...f, foundBy: [...(f.foundBy || [])] }); continue; }
    const sevRank = (s) => SEVERITIES.indexOf(s);
    const better = sevRank(f.severity) < sevRank(existing.severity) ? f : existing;
    const other = better === f ? existing : f;
    better.foundBy = Array.from(new Set([...(better.foundBy || []), ...(other.foundBy || [])]));
    if (!better.description && other.description) better.description = other.description;
    if (!better.recommendation && other.recommendation) better.recommendation = other.recommendation;
    if (!better.impact && other.impact) better.impact = other.impact;
    if (!better.attackScenario && other.attackScenario) better.attackScenario = other.attackScenario;
    // preserve the richer source label: if one is LLM and one scanner, mark 'both'
    const sources = new Set([better.source, other.source]);
    if (sources.has('scanner') && (sources.has('file') || sources.has('architecture'))) {
      better.source = 'corroborated';
    }
    map.set(key, better);
  }
  return Array.from(map.values());
}

/** Sort by severity, then confidence, then file; assign stable IDs. */
export function finalizeFindings(findings) {
  const confRank = { high: 0, medium: 1, low: 2 };
  const merged = mergeFindings(findings);
  merged.sort((a, b) =>
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
    || (confRank[a.confidence] ?? 1) - (confRank[b.confidence] ?? 1)
    || (a.file || '').localeCompare(b.file || ''));
  merged.forEach((f, i) => { f.id = `SA-${String(i + 1).padStart(4, '0')}`; });
  return merged;
}

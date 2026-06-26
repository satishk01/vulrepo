import { spawn } from 'node:child_process';
import path from 'node:path';
import { SEVERITIES } from '../config.js';

/**
 * Run a process and capture stdout/stderr. Never rejects on non-zero exit —
 * many scanners use exit code 1 to mean "findings present", which is normal.
 * Resolves { code, stdout, stderr, error }.
 */
function execTool(bin, args, { cwd, timeoutMs = 600_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    try {
      child = spawn(bin, args, { cwd, windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: '', error: err });
      return;
    }
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve({ code: -1, stdout, stderr, error: new Error('timeout') }); }
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > maxBuffer) stdout = stdout.slice(-maxBuffer);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer);
    });
    child.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr, error: err }); }
    });
    child.on('close', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout, stderr, error: null }); }
    });
  });
}

/** Is a scanner installed and runnable? Resolves true/false. */
export async function isAvailable(scanner) {
  const res = await execTool(scanner.bin, scanner.detect, { timeoutMs: 15_000 });
  // available if the binary ran at all (no ENOENT). version probes may exit 0 or non-0.
  return !(res.error && res.error.code === 'ENOENT');
}

/** Map an arbitrary scanner severity string to our 5-level scale. */
function mapSeverity(s) {
  const v = String(s || '').toLowerCase();
  if (['critical', 'crit'].includes(v)) return 'critical';
  if (['high', 'error', 'blocker'].includes(v)) return 'high';
  if (['medium', 'moderate', 'warning', 'warn', 'major'].includes(v)) return 'medium';
  if (['low', 'minor', 'note'].includes(v)) return 'low';
  if (['info', 'informational', 'unknown', 'none', 'negligible'].includes(v)) return 'info';
  return SEVERITIES.includes(v) ? v : 'medium';
}

/** Build a finding in the SAME shape as the LLM analyzer's normalizeFinding(). */
function mkFinding({
  title, severity, category, cwe = null, owasp = null, file = null,
  startLine = null, endLine = null, description = '', recommendation = '',
  evidence = '', toolId,
}) {
  const sev = mapSeverity(severity);
  return {
    id: null,
    title: String(title || 'Untitled finding').slice(0, 240),
    severity: sev,
    confidence: 'high',                 // deterministic tools: report as high-confidence
    category: String(category || 'other').toLowerCase(),
    cwe: cwe || null,
    owasp: owasp || null,
    file: file || null,
    involvedFiles: file ? [file] : [],
    startLine: Number.isFinite(+startLine) ? +startLine : null,
    endLine: Number.isFinite(+endLine) ? +endLine : (Number.isFinite(+startLine) ? +startLine : null),
    description: String(description || '').trim(),
    impact: '',
    attackScenario: '',
    evidence: String(evidence || '').trim(),
    recommendation: String(recommendation || '').trim(),
    scannerBlindSpot: null,
    source: 'scanner',                  // distinguishes from 'file' / 'architecture'
    foundBy: [toolId],                  // e.g. ['semgrep']
  };
}

function rel(root, p) {
  if (!p) return null;
  try { return path.relative(root, path.resolve(root, p)) || p; } catch { return p; }
}

function safeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  // some tools print a banner line before JSON; try from first { or [
  const i = Math.min(...['{', '['].map((c) => { const k = text.indexOf(c); return k === -1 ? Infinity : k; }));
  if (Number.isFinite(i)) { try { return JSON.parse(text.slice(i)); } catch { /* ignore */ } }
  return null;
}

const CWE_RE = /CWE[-\s]?(\d{1,4})/i;
function extractCwe(...strings) {
  for (const s of strings) {
    const m = CWE_RE.exec(String(s || ''));
    if (m) return `CWE-${m[1]}`;
  }
  return null;
}

// ─────────────────────────── per-tool parsers ───────────────────────────

function parseSemgrep(out, root) {
  const data = safeJson(out);
  const findings = [];
  // Surface a clear error if semgrep couldn't load rules (e.g. offline 403),
  // so an empty result isn't mistaken for "clean".
  if (data && Array.isArray(data.errors) && data.errors.length && (!data.results || !data.results.length)) {
    const fatal = data.errors.find((e) => /config|download|HTTP \d|invalid configuration/i.test(e.message || ''));
    if (fatal) {
      const err = new Error(`semgrep could not load rules: ${(fatal.message || '').split('\n')[0].slice(0, 140)}. Set SECAUDIT_SEMGREP_CONFIG to a local rules path/pack, or log in with 'semgrep login'.`);
      err.isScannerConfig = true;
      throw err;
    }
  }
  for (const r of data?.results || []) {
    const meta = r.extra?.metadata || {};
    const owasp = Array.isArray(meta.owasp) ? meta.owasp.join(', ') : (meta.owasp || null);
    const cweRaw = Array.isArray(meta.cwe) ? meta.cwe.join(', ') : meta.cwe;
    findings.push(mkFinding({
      title: r.extra?.message?.split('\n')[0]?.slice(0, 200) || r.check_id,
      severity: r.extra?.severity || meta.severity || 'medium',
      category: (meta.category || meta.subcategory || 'sast'),
      cwe: extractCwe(cweRaw, r.check_id),
      owasp,
      file: rel(root, r.path),
      startLine: r.start?.line,
      endLine: r.end?.line,
      description: r.extra?.message || r.check_id,
      recommendation: meta.references ? `See: ${[].concat(meta.references).slice(0, 2).join(' ')}` : '',
      evidence: (r.extra?.lines || '').slice(0, 300),
      toolId: 'semgrep',
    }));
  }
  return findings;
}

function parseBandit(out, root) {
  const data = safeJson(out);
  const findings = [];
  for (const r of data?.results || []) {
    findings.push(mkFinding({
      title: r.test_name ? `${r.test_name}: ${r.issue_text?.slice(0, 160)}` : r.issue_text,
      severity: r.issue_severity,
      category: 'sast',
      cwe: r.issue_cwe?.id ? `CWE-${r.issue_cwe.id}` : extractCwe(r.issue_text),
      file: rel(root, r.filename),
      startLine: r.line_number,
      endLine: Array.isArray(r.line_range) ? r.line_range[r.line_range.length - 1] : r.line_number,
      description: r.issue_text,
      recommendation: r.more_info ? `More info: ${r.more_info}` : '',
      evidence: (r.code || '').slice(0, 300),
      toolId: 'bandit',
    }));
  }
  return findings;
}

function parseGosec(out, root) {
  const data = safeJson(out);
  const findings = [];
  for (const r of data?.Issues || []) {
    findings.push(mkFinding({
      title: r.details ? `${r.rule_id}: ${r.details.slice(0, 160)}` : r.rule_id,
      severity: r.severity,
      category: 'sast',
      cwe: r.cwe?.id ? `CWE-${r.cwe.id}` : null,
      file: rel(root, r.file),
      startLine: parseInt(r.line, 10) || null,
      description: r.details,
      evidence: (r.code || '').slice(0, 300),
      toolId: 'gosec',
    }));
  }
  return findings;
}

function parseGitleaks(out, root) {
  const data = safeJson(out);
  const arr = Array.isArray(data) ? data : [];
  const findings = [];
  for (const r of arr) {
    findings.push(mkFinding({
      title: `Hardcoded secret: ${r.RuleID || r.Description || 'credential'}`.slice(0, 200),
      severity: 'high',
      category: 'secrets',
      cwe: 'CWE-798',
      owasp: 'A07:2021-Identification and Authentication Failures',
      file: rel(root, r.File),
      startLine: r.StartLine,
      endLine: r.EndLine,
      description: r.Description || `A secret matching rule "${r.RuleID}" was detected.`,
      recommendation: 'Remove the secret from source, rotate the credential, and load it from a secret manager or environment variable.',
      evidence: (r.Match || r.Secret || '').slice(0, 80),
      toolId: 'gitleaks',
    }));
  }
  return findings;
}

function parseTrivy(out, root) {
  const data = safeJson(out);
  const findings = [];
  for (const res of data?.Results || []) {
    const target = res.Target || '';
    // dependency vulnerabilities
    for (const v of res.Vulnerabilities || []) {
      findings.push(mkFinding({
        title: `${v.VulnerabilityID}: ${v.PkgName}@${v.InstalledVersion}`,
        severity: v.Severity,
        category: 'supply-chain',
        cwe: Array.isArray(v.CweIDs) && v.CweIDs.length ? v.CweIDs[0] : null,
        file: rel(root, target),
        description: (v.Title || v.Description || '').slice(0, 600),
        recommendation: v.FixedVersion ? `Upgrade ${v.PkgName} to ${v.FixedVersion} or later.` : 'No fixed version published yet; monitor advisory.',
        evidence: `${v.PkgName} ${v.InstalledVersion} (${v.VulnerabilityID})`,
        toolId: 'trivy',
      }));
    }
    // IaC / config misconfigurations
    for (const m of res.Misconfigurations || []) {
      findings.push(mkFinding({
        title: `${m.ID}: ${m.Title}`.slice(0, 200),
        severity: m.Severity,
        category: 'misconfiguration',
        file: rel(root, target),
        startLine: m.CauseMetadata?.StartLine,
        endLine: m.CauseMetadata?.EndLine,
        description: m.Description || m.Message || '',
        recommendation: m.Resolution || '',
        toolId: 'trivy',
      }));
    }
    // secrets (trivy also finds these)
    for (const s of res.Secrets || []) {
      findings.push(mkFinding({
        title: `Hardcoded secret: ${s.RuleID || s.Title}`.slice(0, 200),
        severity: s.Severity || 'high',
        category: 'secrets',
        cwe: 'CWE-798',
        file: rel(root, target),
        startLine: s.StartLine,
        endLine: s.EndLine,
        description: s.Title || 'A secret was detected.',
        recommendation: 'Remove and rotate the credential; load it from a secret manager instead.',
        toolId: 'trivy',
      }));
    }
  }
  return findings;
}

function parseOsv(out, root) {
  const data = safeJson(out);
  const findings = [];
  for (const res of data?.results || []) {
    const src = res.source?.path || '';
    for (const pkg of res.packages || []) {
      const name = pkg.package?.name;
      const version = pkg.package?.version;
      for (const v of pkg.vulnerabilities || []) {
        const sev = (v.database_specific?.severity)
          || (Array.isArray(v.severity) && v.severity.length ? 'high' : 'medium');
        findings.push(mkFinding({
          title: `${v.id}: ${name}@${version}`,
          severity: sev,
          category: 'supply-chain',
          file: rel(root, src),
          description: (v.summary || v.details || '').slice(0, 600),
          recommendation: 'Update the affected dependency to a patched version listed in the advisory.',
          evidence: `${name} ${version} (${v.id})`,
          toolId: 'osv-scanner',
        }));
      }
    }
  }
  return findings;
}

function parseCheckov(out, root) {
  const data = safeJson(out);
  const findings = [];
  // checkov emits either a single object or an array of {check_type, results}
  const blocks = Array.isArray(data) ? data : [data];
  for (const block of blocks) {
    const failed = block?.results?.failed_checks || [];
    for (const c of failed) {
      findings.push(mkFinding({
        title: `${c.check_id}: ${c.check_name}`.slice(0, 200),
        severity: c.severity || 'medium',
        category: 'misconfiguration',
        file: rel(root, c.file_path),
        startLine: Array.isArray(c.file_line_range) ? c.file_line_range[0] : null,
        endLine: Array.isArray(c.file_line_range) ? c.file_line_range[1] : null,
        description: c.check_name + (c.guideline ? `` : ''),
        recommendation: c.guideline ? `Guideline: ${c.guideline}` : '',
        toolId: 'checkov',
      }));
    }
  }
  return findings;
}

const PARSERS = {
  semgrep: parseSemgrep,
  bandit: parseBandit,
  gosec: parseGosec,
  gitleaks: parseGitleaks,
  trivy: parseTrivy,
  'osv-scanner': parseOsv,
  checkov: parseCheckov,
};

// ─────────────────────────── command builders ───────────────────────────
// Each returns { bin, args } that produces JSON on stdout for `root`.

function buildArgs(id, root) {
  switch (id) {
    case 'semgrep':
      // Use registry rule packs. SECAUDIT_SEMGREP_CONFIG can override.
      // 'p/default' gives strong coverage without a login. If completely offline
      // and no cache exists, semgrep will error and we surface that.
      return { bin: 'semgrep', args: ['scan', '--config', process.env.SECAUDIT_SEMGREP_CONFIG || 'p/default', '--json', '--quiet', '--metrics', 'off', '--timeout', '0', root] };
    case 'bandit':
      return { bin: 'bandit', args: ['-r', root, '-f', 'json', '-q'] };
    case 'gosec':
      return { bin: 'gosec', args: ['-fmt=json', '-quiet', './...'], cwd: root };
    case 'gitleaks':
      // detect on the filesystem (no-git so it works on non-repo folders too)
      return { bin: 'gitleaks', args: ['detect', '--source', root, '--no-git', '--report-format', 'json', '--report-path', '/dev/stdout', '--redact', '--exit-code', '0'] };
    case 'trivy':
      return { bin: 'trivy', args: ['fs', '--scanners', 'vuln,misconfig,secret', '--format', 'json', '--quiet', root] };
    case 'osv-scanner':
      return { bin: 'osv-scanner', args: ['scan', '--recursive', '--format', 'json', root] };
    case 'checkov':
      return { bin: 'checkov', args: ['--directory', root, '--output', 'json', '--compact', '--quiet'] };
    default:
      return null;
  }
}

/**
 * Run a single scanner against `root`. Returns:
 *   { id, ok, available, findings, error, durationMs }
 */
export async function runScanner(scanner, root, { log, verbose } = {}) {
  const start = Date.now();
  const id = scanner.id;
  const built = buildArgs(id, root);
  if (!built) {
    return { id, ok: false, available: false, findings: [], error: `No runner defined for "${id}"`, durationMs: 0 };
  }
  // Windows: /dev/stdout isn't valid for gitleaks; fall back to a temp file path handled below.
  const res = await execTool(built.bin, built.args, { cwd: built.cwd || process.cwd(), timeoutMs: 900_000 });

  if (res.error && res.error.code === 'ENOENT') {
    return { id, ok: false, available: false, findings: [], error: 'not installed', durationMs: Date.now() - start };
  }
  if (res.error && res.error.message === 'timeout') {
    return { id, ok: false, available: true, findings: [], error: 'timed out', durationMs: Date.now() - start };
  }

  let findings = [];
  let parseErr = null;
  try {
    findings = (PARSERS[id] || (() => []))(res.stdout || '', root);
  } catch (err) {
    parseErr = err.message;
  }

  // If we got no JSON at all and a non-trivial stderr, surface it.
  const noJson = !res.stdout || (!safeJsonProbe(res.stdout));
  const error = parseErr
    || (noJson && findings.length === 0 && res.code !== 0
      ? (res.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || `exit ${res.code}`
      : null);

  return {
    id, ok: !error, available: true, findings, error,
    durationMs: Date.now() - start,
    raw: { code: res.code },
  };
}

function safeJsonProbe(text) {
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[');
}

// Normalizes findings from multiple scanner output formats.
// Port of backend/app/normalizer.py.

import Papa from 'papaparse';
import { randomUUID } from 'node:crypto';

const SEVERITY_MAP = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  moderate: 'medium',
  low: 'low',
  info: 'info',
  informational: 'info',
  warning: 'medium',
  error: 'high',
  note: 'info',
  '1': 'info',
  '2': 'low',
  '3': 'medium',
  '4': 'high',
  '5': 'critical',
};

function normalizeSeverity(raw) {
  if (!raw) return 'medium';
  return SEVERITY_MAP[String(raw).toLowerCase().trim()] || 'medium';
}

function makeFinding(o) {
  // Validate required fields
  if (!o.id || typeof o.id !== 'string') {
    throw new Error('Finding must have a valid id');
  }
  
  const title = (o.title || '').trim();
  if (!title) {
    throw new Error(`Finding ${o.id} has empty title - cannot create finding with empty title`);
  }

  // Build with same shape as NormalizedFinding pydantic model, applying defaults.
  return {
    id: o.id,
    title: title,
    description: (o.description || '').trim(),
    severity: o.severity || 'medium',
    cvss_score: o.cvss_score ?? null,
    cve_ids: Array.isArray(o.cve_ids) ? o.cve_ids : [],
    cwe_ids: Array.isArray(o.cwe_ids) ? o.cwe_ids : [],
    file_path: o.file_path ?? null,
    line_number: o.line_number ?? null,
    tool: o.tool || 'unknown',
    scan_type: o.scan_type || 'unknown',
    component: o.component ?? null,
    url: o.url ?? null,
    remediation_hint: o.remediation_hint ?? null,
    raw: o.raw ?? null,
  };
}

export function normalizeFindings(rawData, scanType, scanId) {
  // CSV path
  if (rawData && typeof rawData === 'object' && rawData._format === 'csv') {
    return parseCsv(rawData._raw_csv, scanId);
  }

  // SARIF detection
  if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
    const schema = (rawData.$schema || '').toLowerCase();
    if (schema.includes('sarif')) return parseSarif(rawData, scanId);
    if (Array.isArray(rawData.runs)) return parseSarif(rawData, scanId);

    // Snyk
    if ('vulnerabilities' in rawData && 'projectName' in rawData) return parseSnyk(rawData, scanId);

    // ZAP
    if ('site' in rawData) return parseZap(rawData, scanId);

    // Trivy
    if ('Results' in rawData && 'ArtifactName' in rawData) return parseTrivy(rawData, scanId);

    // AWS Security Hub
    if ('Findings' in rawData) {
      const findingsList = rawData.Findings;
      if (findingsList?.length && typeof findingsList[0] === 'object' && 'AwsAccountId' in findingsList[0]) {
        return parseSecurityHub(rawData, scanId);
      }
    }
  }

  if (Array.isArray(rawData)) return parseGenericArray(rawData, scanId);
  if (rawData && typeof rawData === 'object') return parseGenericArray([rawData], scanId);

  return [];
}

// ----- SARIF 2.1 -----
function parseSarif(data, scanId) {
  const out = [];
  for (const run of data.runs || []) {
    const toolName = run.tool?.driver?.name || 'unknown';
    const rules = {};
    for (const r of run.tool?.driver?.rules || []) {
      if (r.id) rules[r.id] = r;
    }
    for (const result of run.results || []) {
      const ruleId = result.ruleId || '';
      const rule = rules[ruleId] || {};
      const message = result.message?.text || rule.shortDescription?.text || '';
      const level = result.level || 'warning';
      let severity = normalizeSeverity(level);

      let cvss = null;
      const props = rule.properties || {};
      if ('security-severity' in props) {
        const n = parseFloat(props['security-severity']);
        if (Number.isFinite(n)) {
          cvss = n;
          if (n >= 9.0) severity = 'critical';
          else if (n >= 7.0) severity = 'high';
          else if (n >= 4.0) severity = 'medium';
          else severity = 'low';
        }
      }

      const locations = result.locations || [];
      let filePath = null;
      let lineNumber = null;
      if (locations[0]) {
        const loc = locations[0].physicalLocation || {};
        filePath = loc.artifactLocation?.uri ?? null;
        lineNumber = loc.region?.startLine ?? null;
      }

      const cweIds = [];
      for (const tag of props.tags || []) {
        if (typeof tag === 'string' && tag.toUpperCase().startsWith('CWE-')) cweIds.push(tag.toUpperCase());
      }

      out.push(makeFinding({
        id: `${scanId}-${ruleId}-${out.length}`,
        title: rule.name || ruleId,
        description: message,
        severity,
        cvss_score: cvss,
        cwe_ids: cweIds,
        file_path: filePath,
        line_number: lineNumber,
        tool: toolName,
        scan_type: 'sast',
        remediation_hint: rule.help?.text ?? null,
        raw: result,
      }));
    }
  }
  return out;
}

// ----- Snyk -----
function parseSnyk(data, scanId) {
  const out = [];
  for (const vuln of data.vulnerabilities || []) {
    const ids = vuln.identifiers || {};
    const cveIds = ids.CVE || [];
    const cweIds = (ids.CWE || []).map((c) => `CWE-${c}`);
    out.push(makeFinding({
      id: `${scanId}-${vuln.id || randomUUID().slice(0, 8)}`,
      title: vuln.title || 'Unknown',
      description: vuln.description || '',
      severity: normalizeSeverity(vuln.severity || 'medium'),
      cvss_score: vuln.cvssScore ?? null,
      cve_ids: cveIds,
      cwe_ids: cweIds,
      component: vuln.packageName ?? null,
      tool: 'snyk',
      scan_type: 'sca',
      remediation_hint: vuln.fixedIn?.[0] ?? null,
      raw: vuln,
    }));
  }
  return out;
}

// ----- OWASP ZAP -----
function parseZap(data, scanId) {
  const out = [];
  const riskMap = { '3': 'high', '2': 'medium', '1': 'low', '0': 'info' };
  for (const site of data.site || []) {
    for (const alert of site.alerts || []) {
      const riskCode = String(alert.riskcode ?? '1');
      const sev = riskMap[riskCode] || 'medium';
      const instances = alert.instances?.length ? alert.instances : [{}];
      for (const inst of instances) {
        out.push(makeFinding({
          id: `${scanId}-zap-${alert.pluginid || randomUUID().slice(0, 6)}-${out.length}`,
          title: alert.name || 'ZAP Alert',
          description: alert.desc || '',
          severity: sev,
          url: inst.uri ?? null,
          tool: 'owasp-zap',
          scan_type: 'dast',
          remediation_hint: alert.solution ?? null,
          raw: alert,
        }));
      }
    }
  }
  return out;
}

// ----- Trivy -----
function parseTrivy(data, scanId) {
  const out = [];
  for (const result of data.Results || []) {
    const target = result.Target || '';
    for (const vuln of result.Vulnerabilities || []) {
      const vid = vuln.VulnerabilityID || '';
      out.push(makeFinding({
        id: `${scanId}-trivy-${vid || randomUUID().slice(0, 8)}`,
        title: `${vid || 'Unknown'} in ${vuln.PkgName || target}`,
        description: vuln.Description || '',
        severity: normalizeSeverity(vuln.Severity || 'medium'),
        cvss_score: vuln.CVSS?.nvd?.V3Score ?? null,
        cve_ids: vid.startsWith('CVE-') ? [vid] : [],
        component: vuln.PkgName ?? null,
        tool: 'trivy',
        scan_type: 'sca',
        remediation_hint: `Fix version: ${vuln.FixedVersion || 'none'}`,
        raw: vuln,
      }));
    }
  }
  return out;
}

// ----- AWS Security Hub ASFF -----
function parseSecurityHub(data, scanId) {
  const out = [];
  const sevMap = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', INFORMATIONAL: 'info' };
  for (const f of data.Findings || []) {
    const sevLabel = f.Severity?.Label || 'MEDIUM';
    const norm = f.Severity?.Normalized;
    out.push(makeFinding({
      id: `${scanId}-sh-${String(f.Id || randomUUID().slice(0, 8)).slice(-12)}`,
      title: f.Title || 'Security Hub Finding',
      description: f.Description || '',
      severity: sevMap[sevLabel] || 'medium',
      cvss_score: typeof norm === 'number' ? norm / 10 : null,
      tool: f.ProductName || 'security-hub',
      scan_type: 'cloud',
      remediation_hint: f.Remediation?.Recommendation?.Text ?? null,
      raw: f,
    }));
  }
  return out;
}

// ----- Generic JSON array -----
function parseGenericArray(data, scanId) {
  const out = [];
  const sevKeys = ['severity', 'risk', 'level', 'priority', 'criticality'];
  const titleKeys = ['title', 'name', 'rule', 'check', 'finding', 'vulnerability', 'issue'];
  const descKeys = ['description', 'message', 'details', 'body', 'info', 'text'];

  const getField = (d, keys) => {
    for (const k of keys) {
      if (k in d) return String(d[k]);
      for (const dk of Object.keys(d)) {
        if (dk.toLowerCase() === k) return String(d[dk]);
      }
    }
    return '';
  };

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('No items to parse in generic array');
  }

  data.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    
    try {
      const title = getField(item, titleKeys) || `Finding ${i + 1}`;
      const desc = getField(item, descKeys) || '';
      const sev = normalizeSeverity(getField(item, sevKeys) || 'medium');
      out.push(makeFinding({
        id: `${scanId}-gen-${i}`,
        title,
        description: desc,
        severity: sev,
        tool: 'generic',
        scan_type: 'unknown',
        raw: item,
      }));
    } catch (itemErr) {
      throw new Error(`Item ${i}: ${itemErr.message}`);
    }
  });

  if (out.length === 0) {
    throw new Error('No valid findings extracted from generic array');
  }

  return out;
}

// ----- CSV -----
function parseCsv(rawCsv, scanId) {
  if (!rawCsv || typeof rawCsv !== 'string' || rawCsv.trim().length === 0) {
    throw new Error('CSV file is empty');
  }

  const out = [];
  let parsed;
  try {
    parsed = Papa.parse(rawCsv, { header: true, skipEmptyLines: true });
  } catch (parseErr) {
    throw new Error(`CSV parsing failed: ${parseErr.message}`);
  }

  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`CSV parsing errors: ${parsed.errors.map((e) => e.message).join('; ')}`);
  }

  const rows = parsed.data || [];
  if (rows.length === 0) {
    throw new Error('CSV file contains no data rows');
  }

  rows.forEach((rawRow, i) => {
    // Lowercase the keys
    const row = {};
    for (const [k, v] of Object.entries(rawRow)) {
      row[String(k).toLowerCase().trim()] = v;
    }
    
    try {
      const title = row.title || row.name || row.vulnerability || `Finding ${i + 1}`;
      const desc = row.description || row.details || row.message || '';
      const sev = normalizeSeverity(row.severity || row.risk || 'medium');
      const cveRaw = row.cve || '';
      const cveIds = cveRaw.split(',').map((s) => s.trim()).filter(Boolean);
      let cvss = null;
      const cvssRaw = row.cvss || row.cvss_score || row.score;
      if (cvssRaw) {
        const n = parseFloat(cvssRaw);
        if (Number.isFinite(n)) cvss = n;
      }
      out.push(makeFinding({
        id: `${scanId}-csv-${i}`,
        title,
        description: desc,
        severity: sev,
        cvss_score: cvss,
        cve_ids: cveIds,
        file_path: row.file || row.path || row.location || null,
        component: row.component || row.package || row.library || null,
        tool: row.tool || row.scanner || 'csv-import',
        scan_type: row.type || row.scan_type || 'unknown',
        remediation_hint: row.remediation || row.fix || row.recommendation || null,
        raw: row,
      }));
    } catch (rowErr) {
      throw new Error(`Row ${i + 1}: ${rowErr.message}`);
    }
  });

  return out;
}

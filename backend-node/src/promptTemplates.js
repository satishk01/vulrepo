// Prompt templates used by /analyze and /remediate.

export function buildAnalysisPrompt(request) {
  const findingsJson = JSON.stringify(request.findings || [], null, 2);
  const assetContext = JSON.stringify(request.asset_context || {}, null, 2);
  const orgContext = JSON.stringify(request.org_context || {}, null, 2);
  const count = (request.findings || []).length;

  return `You are a security architect. Analyze these ${count} findings and return ONLY a JSON object.

Context: ${assetContext}
Org: ${orgContext}

Findings:
${findingsJson}

Return this JSON structure:
{
  "executive_summary": {
    "critical_count": 0, "high_count": 0, "medium_count": 0, "low_count": 0,
    "top_risk": "one sentence",
    "recommended_immediate_actions": ["action1", "action2"]
  },
  "scored_findings": [
    {
      "id": "original id", "title": "short title", "risk_score": 8.5,
      "risk_label": "critical|high|medium|low",
      "exploitability": "likely|possible|unlikely",
      "internet_exposed": true,
      "attack_path": "how attacker exploits this",
      "business_impact": "what breaks",
      "owner_team": "team or unknown",
      "remediation_summary": "one-line fix",
      "priority_rank": 1,
      "remediation": {
        "root_cause": "why this exists",
        "fix_steps": ["step 1", "step 2", "step 3"],
        "code_example": "fix code or empty string",
        "verification": "how to verify",
        "estimated_effort": "low|medium|high",
        "references": ["url"]
      }
    }
  ],
  "attack_paths": [
    { "name": "scenario", "severity": "high", "steps": ["step1","step2"], "affected_findings": ["id1"] }
  ],
  "compliance_gaps": [
    { "framework": "OWASP/PCI-DSS/SOC2", "control": "name", "finding_ids": ["id"], "gap_description": "desc" }
  ],
  "diagrams": {
    "attack_flow": "graph TD; A[Attacker]-->|exploit|B[Component]; B-->C[Impact]",
    "architecture_threats": "graph TD; subgraph App; A[Frontend]-->B[API]; end; B-->C[(DB)]"
  },
  "risk_matrix": [
    { "finding_id": "id", "title": "short", "exploitability": "likely", "impact": "high" }
  ]
}

Rules:
- Include remediation.fix_steps with 2-4 specific actionable steps per finding
- Include code_example only for code-fixable vulns, empty string otherwise
- diagrams: valid Mermaid syntax, max 10 nodes each, no markdown fences
- risk_matrix: one entry per scored finding
- Be concise. Return ONLY valid JSON.`;
}

export function buildRemediationPrompt(finding) {
  return `You are an expert application security engineer.

Provide detailed, actionable remediation guidance for this specific vulnerability:

${JSON.stringify(finding, null, 2)}

Return a JSON object with:
{
  "summary": "One-sentence plain-english description",
  "root_cause": "Technical root cause explanation",
  "fix_steps": ["step1", "step2", ...],
  "code_example": "Code snippet showing the fix (if applicable)",
  "verification": "How to verify the fix worked",
  "references": ["CVE link", "CWE link", "docs"],
  "estimated_effort": "low|medium|high",
  "jira_ticket": {
    "title": "...",
    "description": "...",
    "acceptance_criteria": "..."
  }
}

Return ONLY valid JSON. No markdown, no preamble.`;
}

export function buildUnifiedAnalysisPrompt(request) {
  const scansJson = JSON.stringify(request.scans || [], null, 2);
  const assetContext = JSON.stringify(request.asset_context || {}, null, 2);
  const orgContext = JSON.stringify(request.org_context || {}, null, 2);
  const scanCount = (request.scans || []).length;
  const totalFindings = (request.scans || []).reduce((sum, s) => sum + (s.findings || []).length, 0);

  return `You are a security architect. Correlate findings across ${scanCount} scans (${totalFindings} findings total). Return ONLY JSON.

Context: ${assetContext}
Org: ${orgContext}

Scans:
${scansJson}

Return this JSON:
{
  "executive_summary": {
    "total_scans_analyzed": ${scanCount}, "total_findings": ${totalFindings},
    "critical_count": 0, "high_count": 0, "medium_count": 0, "low_count": 0,
    "top_risk": "one sentence",
    "systemic_issues": ["org-wide weakness found across scans"],
    "recommended_immediate_actions": ["action1", "action2"]
  },
  "cross_scan_correlations": [
    {
      "pattern_name": "pattern name", "severity": "high",
      "description": "how findings relate across scans",
      "affected_scans": ["scan_id"], "affected_finding_ids": ["id"],
      "root_cause": "shared root cause",
      "remediation": { "strategy": "fix strategy", "fix_steps": ["step1","step2"], "code_example": "", "estimated_effort": "medium" }
    }
  ],
  "scored_findings": [
    {
      "id": "original id", "scan_id": "from which scan", "title": "short title",
      "risk_score": 8.5, "risk_label": "high", "exploitability": "likely",
      "internet_exposed": true, "attack_path": "how exploited", "business_impact": "what breaks",
      "owner_team": "unknown", "remediation_summary": "one-line fix", "priority_rank": 1,
      "related_findings": ["related ids from other scans"],
      "remediation": {
        "root_cause": "why exists", "fix_steps": ["step1","step2","step3"],
        "code_example": "", "verification": "how to verify", "estimated_effort": "medium", "references": ["url"]
      }
    }
  ],
  "attack_paths": [
    { "name": "scenario", "severity": "high", "steps": ["step1","step2"], "affected_findings": ["id"], "spans_multiple_scans": false }
  ],
  "compliance_gaps": [
    { "framework": "OWASP", "control": "name", "finding_ids": ["id"], "gap_description": "desc", "affected_scans": ["scan_id"] }
  ],
  "diagrams": {
    "attack_flow": "graph TD; A[Attacker]-->|exploit|B[App]; B-->C[Impact]",
    "architecture_threats": "graph TD; subgraph System; A-->B; end"
  },
  "risk_matrix": [
    { "finding_id": "id", "title": "short", "exploitability": "likely", "impact": "high" }
  ]
}

Rules:
- Correlate findings BETWEEN scans — find shared root causes and systemic issues
- Priority rank is global (1 = most urgent across all scans)
- fix_steps: 2-4 specific actionable steps per finding
- diagrams: valid Mermaid, max 10 nodes, no markdown fences
- risk_matrix: one entry per scored finding
- Be concise. Return ONLY valid JSON.`;
}

export function parseJsonLenient(text) {
  if (!text) return null;
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  let clean = text.trim();
  // Remove leading ```json or ``` 
  clean = clean.replace(/^```(?:json)?\s*/i, '');
  // Remove trailing ```
  clean = clean.replace(/\s*```\s*$/, '');
  clean = clean.trim();

  // Try direct parse
  try {
    return JSON.parse(clean);
  } catch {
    // Find the outermost {...} block
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through */ }
    }
    // Try to find outermost [...] block (array)
    const arrMatch = clean.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

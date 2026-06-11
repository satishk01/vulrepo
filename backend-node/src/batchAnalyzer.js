// -----------------------------------------------------------------------------
// batchAnalyzer.js
//
// The single-shot /analyze call asks Claude to return a full JSON object whose
// `scored_findings` array carries a complete remediation block per finding.
// With ~6-8 findings that output fits inside BEDROCK_ANALYSIS_MAX_TOKENS. With
// 20+ findings the JSON is truncated mid-stream, parsing fails, and the
// dashboard receives no `executive_summary` — i.e. "the dashboard doesn't work".
//
// This module fixes that by:
//   1. Splitting findings into batches small enough that each AI response is
//      complete, valid JSON (no truncation).
//   2. Running the EXISTING buildAnalysisPrompt on each batch — so every feature
//      (risk scores, remediation steps, code examples, references, attack paths,
//      compliance gaps, risk matrix) is produced exactly as before.
//   3. Merging the per-batch results into ONE analysis object whose shape is
//      byte-for-byte what DashboardPage.jsx already consumes.
//   4. Running one final, lightweight "synthesis" pass over a COMPACT view of
//      all findings to produce the org-wide narrative + Mermaid diagrams that
//      need to see everything at once.
//
// Net effect: same features, no truncation, scales to thousands of findings.
// -----------------------------------------------------------------------------

import { buildAnalysisPrompt, parseJsonLenient } from './promptTemplates.js';
import { getLogger } from './logger.js';

const log = getLogger('batch-analyzer');

const SEV_FROM_SCORE = (s) => {
  if (s >= 9) return 'critical';
  if (s >= 7) return 'high';
  if (s >= 4) return 'medium';
  return 'low';
};

function parseAnalysis(resultText) {
  let parsed = parseJsonLenient(resultText);
  if (!parsed && resultText) {
    const md = resultText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (md && md[1]) parsed = parseJsonLenient(md[1].trim());
  }
  return parsed;
}

// Split an array into chunks of size n.
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Compact synthesis prompt — small payload, sees ALL findings, produces the
// pieces that must reason globally: executive narrative + diagrams. Counts and
// the risk matrix are computed deterministically afterwards, so we don't ask
// the model for them here.
function buildSynthesisPrompt(compactFindings, assetCtx, orgCtx) {
  return `You are a security architect. Below are ${compactFindings.length} already-scored security findings across one or more assets. Produce a concise org-wide synthesis. Return ONLY a JSON object.

Context: ${JSON.stringify(assetCtx || {}, null, 2)}
Org: ${JSON.stringify(orgCtx || {}, null, 2)}

Findings (compact):
${JSON.stringify(compactFindings, null, 2)}

Return this JSON:
{
  "top_risk": "one sentence describing the single most important risk overall",
  "systemic_issues": ["org-wide weakness seen across multiple findings"],
  "recommended_immediate_actions": ["action 1", "action 2", "action 3"],
  "attack_paths": [
    { "name": "scenario name", "severity": "critical|high|medium|low", "steps": ["step1","step2"], "affected_findings": ["finding id"] }
  ],
  "compliance_gaps": [
    { "framework": "OWASP|PCI-DSS|SOC2|NIST", "control": "control name", "finding_ids": ["id"], "gap_description": "what is missing" }
  ],
  "diagrams": {
    "attack_flow": "graph TD; A[Attacker]-->|exploit|B[Component]; B-->C[Impact]",
    "architecture_threats": "graph TD; subgraph System; A[Frontend]-->B[API]; end; B-->C[(DB)]"
  }
}

Rules:
- attack_paths: 2-5 realistic chained scenarios that reference real finding ids above.
- diagrams: valid Mermaid syntax, max 10 nodes each, no markdown fences.
- Be concise. Return ONLY valid JSON.`;
}

function compact(f) {
  return {
    id: f.id,
    title: f.title,
    risk_label: f.risk_label,
    risk_score: f.risk_score,
    internet_exposed: f.internet_exposed,
    attack_path: f.attack_path,
    business_impact: f.business_impact,
    owner_team: f.owner_team,
  };
}

function dedupeBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * Analyze findings in batches and merge into a single complete analysis object.
 *
 * @param {object}   opts
 * @param {Array}    opts.findings      normalized findings
 * @param {object}   opts.bedrock       bedrock client (getBedrock())
 * @param {string}   opts.modelId
 * @param {object}   opts.assetContext
 * @param {object}   opts.orgContext
 * @param {number}   opts.batchSize     findings per AI call (default 8)
 * @param {number}   opts.maxTokens     per-call output cap
 * @param {string}   opts.scanId
 * @param {function} opts.onProgress    (msg) => void
 * @returns {Promise<object>} analysis object in DashboardPage shape
 */
export async function analyzeInBatches({
  findings,
  bedrock,
  modelId,
  assetContext = {},
  orgContext = {},
  batchSize = 8,
  maxTokens = 16384,
  scanId,
  onProgress = () => {},
}) {
  const batches = chunk(findings, batchSize);
  log.info({ total: findings.length, batches: batches.length, batchSize }, 'batch_analysis_start');

  const scoredAll = [];
  const complianceAll = [];
  const attackPathsAll = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    onProgress(`Analyzing batch ${i + 1}/${batches.length} (${batch.length} findings)`);

    const prompt = buildAnalysisPrompt({
      scan_id: scanId,
      findings: batch,
      asset_context: assetContext,
      org_context: orgContext,
      model_id: modelId,
    });

    let resultText;
    try {
      resultText = await bedrock.invoke({ modelId, prompt, maxTokens });
    } catch (err) {
      log.error({ batch: i + 1, error: String(err) }, 'batch_invoke_failed');
      throw new Error(`Batch ${i + 1}/${batches.length} failed: ${err.message || err}`);
    }

    const parsed = parseAnalysis(resultText);
    if (!parsed) {
      // Even one batch should be small enough to parse. If not, surface clearly.
      log.error({ batch: i + 1, preview: String(resultText).slice(0, 300) }, 'batch_parse_failed');
      throw new Error(`Batch ${i + 1}/${batches.length} returned unparseable JSON. Try a smaller --batch-size.`);
    }

    const scored = Array.isArray(parsed.scored_findings) ? parsed.scored_findings : [];
    scoredAll.push(...scored);
    if (Array.isArray(parsed.compliance_gaps)) complianceAll.push(...parsed.compliance_gaps);
    if (Array.isArray(parsed.attack_paths)) attackPathsAll.push(...parsed.attack_paths);

    log.info({ batch: i + 1, scored: scored.length }, 'batch_done');
  }

  // ---- Deterministic merge of per-finding data --------------------------------
  // Recompute severity counts from the merged scored findings (never trust a
  // per-batch count, which only saw its own slice).
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of scoredAll) {
    let label = String(f.risk_label || '').toLowerCase();
    if (!['critical', 'high', 'medium', 'low'].includes(label)) {
      label = SEV_FROM_SCORE(Number(f.risk_score) || 0);
      f.risk_label = label;
    }
    counts[label] = (counts[label] || 0) + 1;
  }

  // Global priority ranking by risk score (1 = most urgent across ALL findings).
  scoredAll.sort((a, b) => (Number(b.risk_score) || 0) - (Number(a.risk_score) || 0));
  scoredAll.forEach((f, idx) => { f.priority_rank = idx + 1; });

  // Risk matrix: one entry per scored finding (deterministic, never truncates).
  const riskMatrix = scoredAll.map((f) => ({
    finding_id: f.id,
    title: f.title,
    exploitability: f.exploitability || 'possible',
    impact: f.risk_label === 'critical' || f.risk_label === 'high' ? 'high'
          : f.risk_label === 'medium' ? 'medium' : 'low',
  }));

  // ---- Global synthesis pass (narrative + diagrams) ---------------------------
  onProgress('Synthesizing org-wide summary & diagrams');
  let synthesis = {};
  try {
    const compactFindings = scoredAll.map(compact);
    const synthPrompt = buildSynthesisPrompt(compactFindings, assetContext, orgContext);
    const synthText = await bedrock.invoke({ modelId, prompt: synthPrompt, maxTokens: 6000 });
    synthesis = parseAnalysis(synthText) || {};
  } catch (err) {
    log.warn({ error: String(err) }, 'synthesis_failed_using_fallback');
    synthesis = {};
  }

  // Merge attack paths (batch-level + synthesis-level), dedupe by name.
  const attackPaths = dedupeBy(
    [...(synthesis.attack_paths || []), ...attackPathsAll],
    (p) => (p.name || '').toLowerCase().trim()
  );

  // Merge compliance gaps (batch-level + synthesis-level), dedupe by framework+control.
  const complianceGaps = dedupeBy(
    [...complianceAll, ...(synthesis.compliance_gaps || [])],
    (c) => `${(c.framework || '').toLowerCase()}::${(c.control || '').toLowerCase()}`
  );

  // Fallback top risk if synthesis didn't produce one.
  const topRisk = synthesis.top_risk
    || (scoredAll[0]
        ? `${scoredAll[0].title} (risk ${scoredAll[0].risk_score}) is the highest-priority exposure.`
        : 'No critical risks identified.');

  const analysis = {
    executive_summary: {
      critical_count: counts.critical,
      high_count: counts.high,
      medium_count: counts.medium,
      low_count: counts.low,
      total_findings: scoredAll.length,
      top_risk: topRisk,
      systemic_issues: synthesis.systemic_issues || [],
      recommended_immediate_actions: synthesis.recommended_immediate_actions || [],
    },
    scored_findings: scoredAll,
    attack_paths: attackPaths,
    compliance_gaps: complianceGaps,
    diagrams: synthesis.diagrams || {},
    risk_matrix: riskMatrix,
    deduplication: {
      original_count: findings.length,
      unique_count: scoredAll.length,
    },
    _meta: {
      batched: true,
      batch_size: batchSize,
      batch_count: batches.length,
      generated_by: 'uem-cli',
    },
  };

  log.info({
    scored: scoredAll.length,
    counts,
    attack_paths: attackPaths.length,
    compliance_gaps: complianceGaps.length,
  }, 'batch_analysis_complete');

  return analysis;
}

/**
 * Single entry point for per-scan analysis used by BOTH the HTTP server and the
 * CLI. It keeps the original, proven single-call behaviour for small finding
 * sets (so the 2-file / 6-8 finding case is byte-for-byte unchanged) and only
 * switches to the batched/merged path once the set is large enough to risk
 * output-token truncation.
 *
 * @param {object}   opts
 * @param {Array}    opts.findings
 * @param {object}   opts.bedrock        getBedrock()
 * @param {string}   opts.modelId
 * @param {object}   opts.assetContext
 * @param {object}   opts.orgContext
 * @param {number}   opts.batchSize      threshold + per-batch size (default 8)
 * @param {number}   opts.maxTokens
 * @param {string}   opts.scanId
 * @param {function} opts.onProgress
 * @returns {Promise<object>} analysis object in DashboardPage shape
 */
export async function runScanAnalysis({
  findings,
  bedrock,
  modelId,
  assetContext = {},
  orgContext = {},
  batchSize = 8,
  maxTokens = 16384,
  scanId,
  onProgress = () => {},
}) {
  // Small set → original single-shot path (unchanged, fits in one response).
  if (findings.length <= batchSize) {
    onProgress(`Running AI risk analysis on ${findings.length} findings`);
    const prompt = buildAnalysisPrompt({
      scan_id: scanId,
      findings,
      asset_context: assetContext,
      org_context: orgContext,
      model_id: modelId,
    });
    const resultText = await bedrock.invoke({ modelId, prompt, maxTokens });
    let analysis = parseAnalysis(resultText);
    if (!analysis) {
      analysis = { raw_analysis: resultText };
      log.warn({ scanId }, 'single_call_analysis_parse_failed_storing_raw');
    }
    return analysis;
  }

  // Large set → batched + merged (no truncation, same feature set).
  log.info({ scanId, count: findings.length, batchSize }, 'using_batched_analysis');
  return analyzeInBatches({
    findings, bedrock, modelId, assetContext, orgContext,
    batchSize, maxTokens, scanId, onProgress,
  });
}

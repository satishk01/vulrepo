import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Brain, Loader2, AlertCircle, ChevronRight, ChevronDown, ChevronUp, ExternalLink, Copy, CheckCircle, Layers, Clock } from 'lucide-react'
import { analyzeFindingsApi, analyzeUnifiedApi, getRemediation, listScans, getJob } from '../utils/api.js'
import MermaidDiagram from '../components/MermaidDiagram.jsx'
import RiskHeatmap from '../components/RiskHeatmap.jsx'

export default function AnalyzePage({ scanData, analysisData, setAnalysisData, assetContext, orgContext, selectedModel }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [remediations, setRemediations] = useState({})
  const [loadingRemediation, setLoadingRemediation] = useState({})
  const [mode, setMode] = useState('single') // 'single' or 'unified'
  const [availableScans, setAvailableScans] = useState([])
  const [selectedScanIds, setSelectedScanIds] = useState([])
  const [loadingScans, setLoadingScans] = useState(false)
  const [progress, setProgress] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const [jobId, setJobId] = useState(null)
  const pollRef = useRef(null)
  const timerRef = useRef(null)
  const startTimeRef = useRef(null)
  const navigate = useNavigate()

  // Elapsed time counter
  useEffect(() => {
    if (loading) {
      startTimeRef.current = Date.now()
      setElapsed(0)
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
      }, 1000)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [loading])

  // Job polling
  useEffect(() => {
    if (!jobId) return
    let cancelled = false

    const poll = async () => {
      try {
        const { data } = await getJob(jobId)
        if (cancelled) return

        setProgress(data.progress || 'Processing...')

        if (data.status === 'succeeded') {
          setAnalysisData(data.result)
          setLoading(false)
          setJobId(null)
          setProgress(null)
        } else if (data.status === 'failed') {
          setError(data.error || 'Analysis failed')
          setLoading(false)
          setJobId(null)
          setProgress(null)
        } else {
          pollRef.current = setTimeout(poll, 2000)
        }
      } catch (e) {
        if (!cancelled) {
          pollRef.current = setTimeout(poll, 3000)
        }
      }
    }

    poll()
    return () => {
      cancelled = true
      if (pollRef.current) clearTimeout(pollRef.current)
    }
  }, [jobId, setAnalysisData])

  useEffect(() => {
    if (mode === 'unified') {
      setLoadingScans(true)
      listScans()
        .then(r => setAvailableScans(r.data.scans || []))
        .finally(() => setLoadingScans(false))
    }
  }, [mode])

  const toggleScanSelection = (scanId) => {
    setSelectedScanIds(prev =>
      prev.includes(scanId) ? prev.filter(id => id !== scanId) : [...prev, scanId]
    )
  }

  const selectAllScans = () => {
    if (selectedScanIds.length === availableScans.length) {
      setSelectedScanIds([])
    } else {
      setSelectedScanIds(availableScans.map(s => s.scan_id))
    }
  }

  const formatElapsed = (s) => {
    const mins = Math.floor(s / 60)
    const secs = s % 60
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
  }

  const runAnalysis = async () => {
    if (mode === 'single' && !scanData) return
    if (mode === 'unified' && selectedScanIds.length === 0) return
    setLoading(true)
    setError(null)
    setProgress('Submitting analysis request...')
    try {
      let data
      if (mode === 'unified') {
        const payload = {
          scan_ids: selectedScanIds,
          asset_context: assetContext,
          org_context: orgContext,
          model_id: selectedModel,
        }
        const resp = await analyzeUnifiedApi(payload)
        data = resp.data
      } else {
        const payload = {
          scan_id: scanData.scan_id,
          findings: scanData.findings,
          asset_context: assetContext,
          org_context: orgContext,
          model_id: selectedModel,
        }
        const resp = await analyzeFindingsApi(payload)
        data = resp.data
      }
      // Response now contains a job_id — start polling
      if (data.job_id) {
        setJobId(data.job_id)
        setProgress(data.message || 'Analysis queued...')
      } else {
        // Direct response (legacy)
        setAnalysisData(data)
        setLoading(false)
      }
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
      setLoading(false)
    }
  }

  const fetchRemediation = async (finding) => {
    const id = finding.id
    // If we already have inline remediation from the analysis, use it
    if (finding.remediation && finding.remediation.fix_steps) {
      setRemediations(prev => ({ ...prev, [id]: finding.remediation }))
      return
    }
    if (remediations[id]) return
    setLoadingRemediation(prev => ({ ...prev, [id]: true }))
    try {
      const originalFinding = scanData?.findings?.find(f => f.id === id) || finding
      const { data } = await getRemediation(id, originalFinding, selectedModel)
      setRemediations(prev => ({ ...prev, [id]: data }))
    } catch (e) {
      setRemediations(prev => ({ ...prev, [id]: { error: e.message } }))
    } finally {
      setLoadingRemediation(prev => ({ ...prev, [id]: false }))
    }
  }

  const analysis = (() => {
    let obj = analysisData?.analysis || {}
    // Handle case where analysis was stored as raw_analysis string (parseJsonLenient failed)
    if (obj.raw_analysis && typeof obj.raw_analysis === 'string' && !obj.executive_summary) {
      try {
        let rawStr = obj.raw_analysis
        rawStr = rawStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
        const parsed = JSON.parse(rawStr)
        if (parsed && typeof parsed === 'object') {
          obj = parsed
        }
      } catch (e) {
        console.warn('Could not parse raw_analysis in AnalyzePage:', e)
      }
    }
    return obj
  })()
  const scored = analysis.scored_findings || []
  const summary = analysis.executive_summary || {}
  const attackPaths = analysis.attack_paths || []
  const compliance = analysis.compliance_gaps || []
  const correlations = analysis.cross_scan_correlations || []
  const diagrams = analysis.diagrams || {}
  const riskMatrix = analysis.risk_matrix || []

  return (
    <div className="max-w-5xl mx-auto px-6 py-10 space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white mb-1">AI-powered risk analysis</h1>
          <p className="text-muted text-sm">
            {mode === 'single'
              ? scanData
                ? `${scanData.findings.length} findings ready · Model: ${selectedModel.split('.').pop()}`
                : 'No scan data — go back to Ingest first'
              : `${selectedScanIds.length} scans selected · Model: ${selectedModel.split('.').pop()}`
            }
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-surface border border-border rounded-lg overflow-hidden">
            <button
              onClick={() => setMode('single')}
              className={`px-3 py-1.5 text-sm transition ${mode === 'single' ? 'bg-accent-2/20 text-accent-2' : 'text-muted hover:text-white'}`}
            >
              Single scan
            </button>
            <button
              onClick={() => setMode('unified')}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 transition ${mode === 'unified' ? 'bg-accent-2/20 text-accent-2' : 'text-muted hover:text-white'}`}
            >
              <Layers size={12} /> Unified
            </button>
          </div>
          <button
            onClick={runAnalysis}
            disabled={(mode === 'single' && !scanData) || (mode === 'unified' && selectedScanIds.length === 0) || loading}
            className="flex items-center gap-2 bg-accent text-white font-medium px-5 py-2.5 rounded-lg hover:bg-accent/80 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Brain size={16} />}
            {loading ? 'Analyzing…' : analysisData ? 'Re-analyze' : 'Run analysis'}
          </button>
        </div>
      </div>

      {/* Unified mode: scan picker */}
      {mode === 'unified' && (
        <div className="bg-panel border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-white font-medium">Select scans to correlate</h2>
            <button onClick={selectAllScans} className="text-xs text-accent-2 hover:text-white transition">
              {selectedScanIds.length === availableScans.length ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          {loadingScans ? (
            <div className="flex items-center gap-2 text-muted text-sm">
              <Loader2 size={14} className="animate-spin" /> Loading scans…
            </div>
          ) : availableScans.length === 0 ? (
            <p className="text-muted text-sm">No scans available. Upload or run a scan first.</p>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {availableScans.map(s => (
                <label key={s.scan_id} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition ${
                  selectedScanIds.includes(s.scan_id)
                    ? 'border-accent-2/50 bg-accent-2/5'
                    : 'border-border hover:border-border/80 hover:bg-white/2'
                }`}>
                  <input
                    type="checkbox"
                    checked={selectedScanIds.includes(s.scan_id)}
                    onChange={() => toggleScanSelection(s.scan_id)}
                    className="rounded border-border text-accent-2 focus:ring-accent-2"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white truncate">
                      {s.filename || s.repo_url || s.scan_id}
                    </div>
                    <div className="text-xs text-muted">
                      {s.source_type} · {s.findings_count ?? 0} findings · {s.created_at?.slice(0, 10)}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Scanning animation */}
      {loading && (
        <div className="bg-panel border border-border rounded-xl p-8 flex flex-col items-center gap-4">
          <div className="relative w-16 h-16">
            <div className="absolute inset-0 rounded-full border-2 border-accent-2/20" />
            <div className="absolute inset-0 rounded-full border-t-2 border-accent-2 animate-spin" />
            <Brain className="absolute inset-0 m-auto text-accent-2" size={24} />
          </div>
          <div className="text-center">
            <p className="text-white font-medium">
              {mode === 'unified' ? 'Claude is correlating findings across scans…' : 'Claude is analyzing your findings…'}
            </p>
            <p className="text-accent-2 text-sm mt-2 font-medium">{progress || 'Starting...'}</p>
            <div className="flex items-center justify-center gap-2 mt-3 text-muted text-xs">
              <Clock size={12} />
              <span>Elapsed: {formatElapsed(elapsed)}</span>
              {elapsed > 30 && <span className="text-muted">· AI analysis typically takes 30–90 seconds</span>}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 bg-danger/10 border border-danger/30 rounded-lg p-4">
          <AlertCircle className="text-danger shrink-0 mt-0.5" size={16} />
          <p className="text-danger text-sm">{error}</p>
        </div>
      )}

      {/* Executive summary */}
      {summary.critical_count !== undefined && (
        <div className="bg-panel border border-border rounded-xl p-5">
          <h2 className="text-white font-medium mb-4">Executive summary</h2>
          {summary.total_scans_analyzed && (
            <p className="text-muted text-sm mb-3">
              Analyzed {summary.total_scans_analyzed} scans · {summary.total_findings} total findings
            </p>
          )}
          <div className="grid grid-cols-4 gap-3 mb-4">
            {[
              { label: 'Critical', count: summary.critical_count, cls: 'text-critical border-critical/30 bg-critical/5' },
              { label: 'High', count: summary.high_count, cls: 'text-danger border-danger/30 bg-danger/5' },
              { label: 'Medium', count: summary.medium_count, cls: 'text-warning border-warning/30 bg-warning/5' },
              { label: 'Low', count: summary.low_count, cls: 'text-success border-success/30 bg-success/5' },
            ].map(({ label, count, cls }) => (
              <div key={label} className={`border rounded-lg p-3 text-center ${cls}`}>
                <div className="text-2xl font-bold mono">{count ?? 0}</div>
                <div className="text-xs mt-0.5 opacity-80">{label}</div>
              </div>
            ))}
          </div>
          {summary.top_risk && (
            <div className="bg-critical/10 border border-critical/20 rounded-lg px-4 py-2.5 mb-3">
              <p className="text-xs text-critical uppercase font-medium mb-0.5">Top risk</p>
              <p className="text-white text-sm">{summary.top_risk}</p>
            </div>
          )}
          {summary.systemic_issues?.length > 0 && (
            <div className="mb-3">
              <p className="text-muted text-xs mb-2 uppercase tracking-wide">Systemic issues (across scans)</p>
              <ul className="space-y-1">
                {summary.systemic_issues.map((issue, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-warning">
                    <span className="mt-0.5">⚠</span>{issue}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {summary.recommended_immediate_actions?.length > 0 && (
            <div>
              <p className="text-muted text-xs mb-2 uppercase tracking-wide">Immediate actions</p>
              <ul className="space-y-1">
                {summary.recommended_immediate_actions.map((a, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-white">
                    <span className="text-accent-2 mt-0.5">▸</span>{a}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Cross-scan correlations (unified mode only) */}
      {correlations.length > 0 && (
        <div className="bg-panel border border-border rounded-xl p-5">
          <h2 className="text-white font-medium mb-4 flex items-center gap-2">
            <Layers size={16} className="text-accent-2" /> Cross-scan correlations
          </h2>
          <div className="space-y-4">
            {correlations.map((corr, i) => (
              <div key={i} className="border border-border rounded-lg p-4">
                <div className="flex items-center gap-3 mb-2">
                  <SevBadge sev={corr.severity} />
                  <span className="text-white font-medium">{corr.pattern_name}</span>
                </div>
                <p className="text-muted text-sm mb-3">{corr.description}</p>
                {corr.root_cause && (
                  <div className="bg-surface rounded-lg p-3 mb-3">
                    <p className="text-xs text-muted uppercase mb-1">Root cause</p>
                    <p className="text-sm text-white">{corr.root_cause}</p>
                  </div>
                )}
                {corr.remediation && (
                  <div className="bg-surface rounded-lg p-3">
                    <p className="text-xs text-muted uppercase mb-1">Unified fix strategy</p>
                    <p className="text-sm text-white mb-2">{corr.remediation.strategy}</p>
                    {corr.remediation.fix_steps?.length > 0 && (
                      <ol className="space-y-1">
                        {corr.remediation.fix_steps.map((step, j) => (
                          <li key={j} className="flex gap-2 text-sm text-white">
                            <span className="text-accent-2 mono shrink-0">{j + 1}.</span>{step}
                          </li>
                        ))}
                      </ol>
                    )}
                    {corr.remediation.code_example && (
                      <pre className="mt-2 bg-panel rounded p-3 text-xs text-success overflow-x-auto">{corr.remediation.code_example}</pre>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scored findings */}
      {scored.length > 0 && (
        <div className="bg-panel border border-border rounded-xl overflow-hidden">
          <div className="p-4 border-b border-border">
            <h2 className="text-white font-medium">Prioritized findings ({scored.length})</h2>
          </div>
          <div className="divide-y divide-border/50">
            {scored
              .sort((a, b) => (a.priority_rank || 99) - (b.priority_rank || 99))
              .map((f) => (
                <FindingRow
                  key={f.id}
                  finding={f}
                  expanded={expandedId === f.id}
                  onToggle={() => {
                    if (expandedId !== f.id) {
                      setExpandedId(f.id)
                      fetchRemediation(f)
                    } else {
                      setExpandedId(null)
                    }
                  }}
                  remediation={remediations[f.id] || f.remediation}
                  loadingRemediation={loadingRemediation[f.id]}
                />
              ))}
          </div>
        </div>
      )}

      {/* Risk heatmap & diagrams */}
      {(riskMatrix.length > 0 || diagrams.attack_flow || diagrams.architecture_threats) && (
        <div className="space-y-4">
          {riskMatrix.length > 0 && <RiskHeatmap riskMatrix={riskMatrix} />}
          {diagrams.architecture_threats && (
            <MermaidDiagram chart={diagrams.architecture_threats} title="Architecture threat map" />
          )}
          {diagrams.attack_flow && (
            <MermaidDiagram chart={diagrams.attack_flow} title="Attack flow diagram" />
          )}
        </div>
      )}

      {/* Attack paths */}
      {attackPaths.length > 0 && (
        <div className="bg-panel border border-border rounded-xl p-5">
          <h2 className="text-white font-medium mb-4">Attack paths</h2>
          <div className="space-y-3">
            {attackPaths.map((ap, i) => (
              <div key={i} className="border border-border rounded-lg p-4">
                <div className="flex items-center gap-3 mb-2">
                  <SevBadge sev={ap.severity} />
                  <span className="text-white font-medium">{ap.name}</span>
                  {ap.spans_multiple_scans && (
                    <span className="text-xs bg-accent-2/10 text-accent-2 px-2 py-0.5 rounded">cross-scan</span>
                  )}
                </div>
                <ol className="space-y-1">
                  {ap.steps?.map((step, j) => (
                    <li key={j} className="flex gap-2 text-sm text-muted">
                      <span className="text-accent-2 mono shrink-0">{j + 1}.</span>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Compliance */}
      {compliance.length > 0 && (
        <div className="bg-panel border border-border rounded-xl p-5">
          <h2 className="text-white font-medium mb-4">Compliance gaps</h2>
          <div className="space-y-2">
            {compliance.map((c, i) => (
              <div key={i} className="flex items-start gap-3 border border-border rounded-lg p-3">
                <span className="bg-warning/10 text-warning text-xs px-2 py-0.5 rounded shrink-0">{c.framework}</span>
                <div>
                  <p className="text-white text-sm font-medium">{c.control}</p>
                  <p className="text-muted text-xs mt-0.5">{c.gap_description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {analysisData && (
        <div className="flex justify-end">
          <button onClick={() => navigate('/dashboard')} className="flex items-center gap-2 bg-accent-2 text-surface font-medium px-6 py-2.5 rounded-lg hover:bg-accent-2/80 transition">
            View dashboard <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  )
}

function FindingRow({ finding, expanded, onToggle, remediation, loadingRemediation }) {
  const [copied, setCopied] = useState(false)

  const copyTicket = () => {
    const ticket = remediation?.jira_ticket
    if (!ticket) return
    const text = `Title: ${ticket.title}\n\n${ticket.description}\n\nAcceptance criteria:\n${ticket.acceptance_criteria}`
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="hover:bg-white/2 transition">
      <button className="w-full flex items-center gap-3 p-4 text-left" onClick={onToggle}>
        <span className="text-muted mono text-xs w-6 shrink-0">#{finding.priority_rank}</span>
        <SevBadge sev={finding.risk_label} />
        <span className="text-white font-medium flex-1 truncate">{finding.title}</span>
        <div className="flex items-center gap-3 shrink-0">
          <RiskScore score={finding.risk_score} />
          <span className="text-muted text-xs hidden md:block">{finding.owner_team}</span>
          {expanded ? <ChevronUp size={14} className="text-muted" /> : <ChevronDown size={14} className="text-muted" />}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-border/50 pt-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <InfoCard title="Attack path">
              <p className="text-sm text-white">{finding.attack_path}</p>
            </InfoCard>
            <InfoCard title="Business impact">
              <p className="text-sm text-white">{finding.business_impact}</p>
            </InfoCard>
          </div>

          {finding.related_findings?.length > 0 && (
            <InfoCard title="Related findings (other scans)">
              <div className="flex flex-wrap gap-1">
                {finding.related_findings.map((rf, i) => (
                  <span key={i} className="text-xs bg-accent-2/10 text-accent-2 px-2 py-0.5 rounded">{rf}</span>
                ))}
              </div>
            </InfoCard>
          )}

          <InfoCard title="Remediation">
            <p className="text-sm text-white mb-3">{finding.remediation_summary}</p>
            {loadingRemediation && (
              <div className="flex items-center gap-2 text-muted text-sm">
                <Loader2 size={14} className="animate-spin" />Fetching deep-dive guidance…
              </div>
            )}
            {remediation && !remediation.error && (
              <div className="space-y-3">
                {remediation.root_cause && (
                  <div>
                    <p className="text-xs text-muted uppercase mb-1">Root cause</p>
                    <p className="text-sm text-white">{remediation.root_cause}</p>
                  </div>
                )}
                {remediation.fix_steps?.length > 0 && (
                  <div>
                    <p className="text-xs text-muted uppercase mb-1">Fix steps</p>
                    <ol className="space-y-1">
                      {remediation.fix_steps.map((s, i) => (
                        <li key={i} className="flex gap-2 text-sm text-white">
                          <span className="text-accent-2 mono shrink-0">{i + 1}.</span>{s}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {remediation.code_example && (
                  <div>
                    <p className="text-xs text-muted uppercase mb-1">Code example</p>
                    <pre className="bg-surface rounded p-3 text-xs text-success overflow-x-auto">{remediation.code_example}</pre>
                  </div>
                )}
                {remediation.verification && (
                  <div>
                    <p className="text-xs text-muted uppercase mb-1">Verification</p>
                    <p className="text-sm text-muted">{remediation.verification}</p>
                  </div>
                )}
                {remediation.estimated_effort && (
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-muted uppercase">Effort:</p>
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      remediation.estimated_effort === 'low' ? 'bg-success/10 text-success' :
                      remediation.estimated_effort === 'medium' ? 'bg-warning/10 text-warning' :
                      'bg-danger/10 text-danger'
                    }`}>{remediation.estimated_effort}</span>
                  </div>
                )}
                {remediation.references?.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {remediation.references.map((r, i) => (
                      <a key={i} href={r} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-accent-2 hover:underline">
                        <ExternalLink size={10} />{r.replace('https://', '').split('/')[0]}
                      </a>
                    ))}
                  </div>
                )}
                {remediation.jira_ticket && (
                  <div className="bg-surface border border-border rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs text-muted uppercase">Jira ticket draft</p>
                      <button onClick={copyTicket} className="flex items-center gap-1 text-xs text-accent-2 hover:text-white transition">
                        {copied ? <CheckCircle size={12} /> : <Copy size={12} />}
                        {copied ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <p className="text-white text-sm font-medium">{remediation.jira_ticket.title}</p>
                    <p className="text-muted text-xs mt-1">{remediation.jira_ticket.description}</p>
                  </div>
                )}
              </div>
            )}
            {remediation?.error && (
              <p className="text-danger text-sm">Failed to load remediation: {remediation.error}</p>
            )}
          </InfoCard>
        </div>
      )}
    </div>
  )
}

function InfoCard({ title, children }) {
  return (
    <div className="bg-surface rounded-lg p-3">
      <p className="text-xs text-muted uppercase mb-2">{title}</p>
      {children}
    </div>
  )
}

function RiskScore({ score }) {
  if (!score) return null
  const color = score >= 8 ? 'text-critical' : score >= 6 ? 'text-danger' : score >= 4 ? 'text-warning' : 'text-success'
  return <span className={`mono text-sm font-bold ${color}`}>{Number(score).toFixed(1)}</span>
}

function SevBadge({ sev }) {
  const cls = {
    critical: 'bg-critical/15 text-critical border-critical/30',
    high: 'bg-danger/15 text-danger border-danger/30',
    medium: 'bg-warning/15 text-warning border-warning/30',
    low: 'bg-success/15 text-success border-success/30',
    info: 'bg-muted/15 text-muted border-muted/30',
  }[sev?.toLowerCase()] || 'bg-muted/15 text-muted border-muted/30'
  return <span className={`px-2 py-0.5 rounded text-xs font-medium border ${cls} uppercase shrink-0`}>{sev}</span>
}

import React, { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { Shield, TrendingUp, Clock, Users, Loader2 } from 'lucide-react'
import MermaidDiagram from '../components/MermaidDiagram.jsx'
import RiskHeatmap from '../components/RiskHeatmap.jsx'
import { getScan } from '../utils/api.js'

const SEV_COLORS = {
  critical: '#ff6e6e',
  high: '#f85149',
  medium: '#d29922',
  low: '#3fb950',
  info: '#8b949e',
}

export default function DashboardPage({ analysisData: propsAnalysisData, scanData: propsScanData }) {
  const { scanId } = useParams()
  const [loadedAnalysis, setLoadedAnalysis] = useState(null)
  const [loading, setLoading] = useState(false)

  // If scanId in URL, load from backend; otherwise use props (in-memory/localStorage)
  useEffect(() => {
    if (scanId) {
      setLoading(true)
      getScan(scanId)
        .then(r => {
          // Backend returns { scan, findings, analysis }
          // analysis can be: { scan_id, model_used, analyzed_at, analysis: {...} }
          // OR analysis.analysis can be: { raw_analysis: "json string" }
          if (r.data.analysis) {
            let analysisObj = r.data.analysis.analysis || r.data.analysis

            // Handle case where analysis was stored as raw_analysis string
            if (analysisObj.raw_analysis && typeof analysisObj.raw_analysis === 'string' && !analysisObj.executive_summary) {
              try {
                let rawStr = analysisObj.raw_analysis
                // Strip markdown fences if present
                rawStr = rawStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
                const parsed = JSON.parse(rawStr)
                if (parsed && typeof parsed === 'object') {
                  analysisObj = parsed
                }
              } catch (e) {
                console.warn('Could not parse raw_analysis string:', e)
              }
            }

            setLoadedAnalysis({
              ...analysisObj,
              analysis: analysisObj.executive_summary ? analysisObj : (analysisObj.analysis || analysisObj),
              findings_analyzed: (r.data.findings || []).length,
              model_used: r.data.analysis?.model_used || 'unknown',
              analyzed_at: r.data.analysis?.analyzed_at || new Date().toISOString(),
            })
          }
        })
        .catch(err => {
          console.error('Failed to load scan analysis', err)
        })
        .finally(() => setLoading(false))
    }
  }, [scanId])

  const analysisData = scanId ? loadedAnalysis : propsAnalysisData

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-24 text-center">
        <Loader2 className="mx-auto text-accent-2 animate-spin mb-4" size={32} />
        <p className="text-muted text-sm">Loading dashboard…</p>
      </div>
    )
  }

  if (!analysisData) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-24 text-center">
        <Shield className="mx-auto text-muted mb-4" size={48} />
        <h2 className="text-white font-semibold text-lg mb-2">No analysis yet</h2>
        <p className="text-muted text-sm">Run an analysis first to see your risk dashboard. Or select a scan that has been analyzed from the Scans page.</p>
      </div>
    )
  }

  // Handle multiple data shapes:
  // Shape 1 (from backend): { analysis: { executive_summary, scored_findings, ... }, model_used, findings_analyzed, ... }
  // Shape 2 (from props/local): { executive_summary, scored_findings, ... }
  // Shape 3 (raw_analysis): { analysis: { raw_analysis: "json string" }, ... }
  let analysis = {}
  if (analysisData) {
    if (analysisData.analysis && typeof analysisData.analysis === 'object') {
      let obj = analysisData.analysis
      // Handle raw_analysis string (parseJsonLenient failed on backend)
      if (obj.raw_analysis && typeof obj.raw_analysis === 'string' && !obj.executive_summary) {
        try {
          let rawStr = obj.raw_analysis
          rawStr = rawStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
          const parsed = JSON.parse(rawStr)
          if (parsed && typeof parsed === 'object') {
            obj = parsed
          }
        } catch (e) {
          console.warn('Could not parse raw_analysis in DashboardPage:', e)
        }
      }
      analysis = obj
    } else if (analysisData.executive_summary) {
      // Flat structure from props
      analysis = analysisData
    } else if (analysisData.raw_analysis && typeof analysisData.raw_analysis === 'string') {
      // Top-level raw_analysis
      try {
        let rawStr = analysisData.raw_analysis
        rawStr = rawStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
        const parsed = JSON.parse(rawStr)
        if (parsed && typeof parsed === 'object') {
          analysis = parsed
        }
      } catch (e) {
        console.warn('Could not parse top-level raw_analysis:', e)
      }
    }
  }
  const summary = analysis.executive_summary || {}
  const scored = analysis.scored_findings || []
  const dedup = analysis.deduplication || {}
  const compliance = analysis.compliance_gaps || []
  const attackPaths = analysis.attack_paths || []
  const diagrams = analysis.diagrams || {}
  const riskMatrix = analysis.risk_matrix || []

  // Pie data
  const pieData = [
    { name: 'Critical', value: summary.critical_count || 0, color: SEV_COLORS.critical },
    { name: 'High', value: summary.high_count || 0, color: SEV_COLORS.high },
    { name: 'Medium', value: summary.medium_count || 0, color: SEV_COLORS.medium },
    { name: 'Low', value: summary.low_count || 0, color: SEV_COLORS.low },
  ].filter(d => d.value > 0)

  // Top 10 findings bar
  const barData = scored
    .sort((a, b) => (b.risk_score || 0) - (a.risk_score || 0))
    .slice(0, 8)
    .map(f => ({
      name: f.title?.length > 22 ? f.title.slice(0, 22) + '…' : f.title,
      score: Number((f.risk_score || 0).toFixed(1)),
      fill: SEV_COLORS[f.risk_label?.toLowerCase()] || SEV_COLORS.medium,
    }))

  // Owner breakdown
  const ownerMap = {}
  scored.forEach(f => {
    const owner = f.owner_team || 'Unknown'
    ownerMap[owner] = (ownerMap[owner] || 0) + 1
  })
  const ownerData = Object.entries(ownerMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name, count }))

  // Compliance framework counts
  const frameworkMap = {}
  compliance.forEach(c => {
    frameworkMap[c.framework] = (frameworkMap[c.framework] || 0) + 1
  })

  const totalFindings = (summary.critical_count || 0) + (summary.high_count || 0) + (summary.medium_count || 0) + (summary.low_count || 0)

  return (
    <div className="max-w-6xl mx-auto px-6 py-10 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white mb-1">Risk dashboard</h1>
          <p className="text-muted text-sm">
            {analysisData.findings_analyzed} findings analyzed · {analysisData.model_used?.split('.').pop()} · {new Date(analysisData.analyzed_at).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2 bg-success/10 border border-success/30 text-success text-sm px-3 py-1.5 rounded-lg">
          <Shield size={14} />
          Analysis complete
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard icon={Shield} label="Total findings" value={totalFindings} sub="across all scanners" color="text-accent-2" />
        <KpiCard icon={TrendingUp} label="Unique after dedup" value={dedup.unique_count || totalFindings} sub={`${(dedup.original_count || 0) - (dedup.unique_count || 0)} duplicates removed`} color="text-success" />
        <KpiCard icon={Clock} label="Attack paths" value={attackPaths.length} sub="chained scenarios" color="text-warning" />
        <KpiCard icon={Users} label="Teams affected" value={Object.keys(ownerMap).length} sub="require action" color="text-accent" />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Severity distribution pie */}
        <div className="bg-panel border border-border rounded-xl p-5">
          <h3 className="text-white font-medium mb-4">Severity distribution</h3>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={3} dataKey="value">
                  {pieData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }}
                  labelStyle={{ color: '#e6edf3' }}
                  itemStyle={{ color: '#8b949e' }}
                />
                <Legend formatter={(v) => <span style={{ color: '#8b949e', fontSize: 12 }}>{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-muted text-sm text-center py-8">No findings to chart</p>
          )}
        </div>

        {/* Top risk scores bar */}
        <div className="bg-panel border border-border rounded-xl p-5">
          <h3 className="text-white font-medium mb-4">Top risk scores</h3>
          {barData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={barData} layout="vertical" margin={{ left: 0, right: 20 }}>
                <XAxis type="number" domain={[0, 10]} tick={{ fill: '#8b949e', fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={130} tick={{ fill: '#8b949e', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }}
                  labelStyle={{ color: '#e6edf3' }}
                  cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                />
                <Bar dataKey="score" radius={[0, 4, 4, 0]}>
                  {barData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-muted text-sm text-center py-8">No scored findings</p>
          )}
        </div>
      </div>

      {/* Owner breakdown + compliance */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Risk Heatmap */}
        {riskMatrix.length > 0 && (
          <div className="col-span-full">
            <RiskHeatmap riskMatrix={riskMatrix} />
          </div>
        )}

        {/* Architecture threat diagram */}
        {diagrams.architecture_threats && (
          <div className="col-span-full">
            <MermaidDiagram chart={diagrams.architecture_threats} title="Architecture threat map" />
          </div>
        )}

        {/* Attack flow diagram */}
        {diagrams.attack_flow && (
          <div className="col-span-full">
            <MermaidDiagram chart={diagrams.attack_flow} title="Attack flow diagram" />
          </div>
        )}
      </div>

      {/* Owner breakdown + compliance */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Owner breakdown */}
        <div className="bg-panel border border-border rounded-xl p-5">
          <h3 className="text-white font-medium mb-4">Findings by owner</h3>
          <div className="space-y-2">
            {ownerData.length > 0 ? ownerData.map(({ name, count }) => {
              const pct = Math.round((count / totalFindings) * 100)
              return (
                <div key={name}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-white">{name}</span>
                    <span className="text-muted">{count} finding{count !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="h-1.5 bg-surface rounded-full overflow-hidden">
                    <div className="h-full bg-accent-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            }) : <p className="text-muted text-sm">No owner data</p>}
          </div>
        </div>

        {/* Compliance gaps */}
        <div className="bg-panel border border-border rounded-xl p-5">
          <h3 className="text-white font-medium mb-4">Compliance gaps</h3>
          {compliance.length > 0 ? (
            <div className="space-y-2">
              {Object.entries(frameworkMap).map(([framework, count]) => (
                <div key={framework} className="flex items-center justify-between bg-surface rounded-lg px-3 py-2">
                  <span className="text-white text-sm">{framework}</span>
                  <span className="text-warning text-xs mono">{count} gap{count !== 1 ? 's' : ''}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted text-sm">No compliance gaps identified</p>
          )}
        </div>
      </div>

      {/* Attack path detail */}
      {attackPaths.length > 0 && (
        <div className="bg-panel border border-border rounded-xl p-5">
          <h3 className="text-white font-medium mb-4">Attack path scenarios</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {attackPaths.map((ap, i) => (
              <div key={i} className="border border-border rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <SevDot sev={ap.severity} />
                  <span className="text-white text-sm font-medium">{ap.name}</span>
                </div>
                <ol className="space-y-1">
                  {(ap.steps || []).map((s, j) => (
                    <li key={j} className="text-xs text-muted flex gap-2">
                      <span className="text-accent-2 mono shrink-0">{j + 1}.</span>{s}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top risk callout */}
      {summary.top_risk && (
        <div className="bg-critical/5 border border-critical/20 rounded-xl p-5">
          <p className="text-xs text-critical uppercase font-medium mb-1">CISO briefing — top risk</p>
          <p className="text-white">{summary.top_risk}</p>
          {summary.recommended_immediate_actions?.length > 0 && (
            <div className="mt-3">
              <p className="text-muted text-xs mb-1">Recommended immediate actions:</p>
              <ul className="space-y-0.5">
                {summary.recommended_immediate_actions.map((a, i) => (
                  <li key={i} className="text-sm text-white flex gap-2">
                    <span className="text-critical">▸</span>{a}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Remediation Plan — detailed fix steps for every finding */}
      {scored.length > 0 && scored.some(f => f.remediation) && (
        <div className="bg-panel border border-border rounded-xl p-5">
          <h3 className="text-white font-medium mb-4">Remediation plan — how to fix each issue</h3>
          <div className="space-y-4">
            {scored
              .sort((a, b) => (a.priority_rank || 99) - (b.priority_rank || 99))
              .filter(f => f.remediation)
              .map((f, i) => (
                <div key={f.id || i} className="border border-border rounded-lg p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-xs mono text-muted bg-surface px-2 py-0.5 rounded">#{f.priority_rank}</span>
                    <SevDot sev={f.risk_label} />
                    <span className="text-white font-medium">{f.title}</span>
                    {f.remediation.estimated_effort && (
                      <span className={`ml-auto text-xs px-2 py-0.5 rounded ${
                        f.remediation.estimated_effort === 'low' ? 'bg-green-500/10 text-green-400' :
                        f.remediation.estimated_effort === 'medium' ? 'bg-yellow-500/10 text-yellow-400' :
                        'bg-red-500/10 text-red-400'
                      }`}>
                        {f.remediation.estimated_effort} effort
                      </span>
                    )}
                  </div>

                  {f.remediation.root_cause && (
                    <div className="mb-3">
                      <p className="text-xs text-muted uppercase mb-1">Root cause</p>
                      <p className="text-sm text-white">{f.remediation.root_cause}</p>
                    </div>
                  )}

                  {f.remediation.fix_steps?.length > 0 && (
                    <div className="mb-3">
                      <p className="text-xs text-muted uppercase mb-1">Fix steps</p>
                      <ol className="space-y-1">
                        {f.remediation.fix_steps.map((step, j) => (
                          <li key={j} className="flex gap-2 text-sm text-white">
                            <span className="text-accent-2 mono shrink-0">{j + 1}.</span>{step}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {f.remediation.code_example && f.remediation.code_example.trim() && (
                    <div className="mb-3">
                      <p className="text-xs text-muted uppercase mb-1">Code example</p>
                      <pre className="bg-surface rounded p-3 text-xs text-green-400 overflow-x-auto whitespace-pre-wrap">{f.remediation.code_example}</pre>
                    </div>
                  )}

                  {f.remediation.verification && (
                    <div className="mb-2">
                      <p className="text-xs text-muted uppercase mb-1">How to verify</p>
                      <p className="text-sm text-muted">{f.remediation.verification}</p>
                    </div>
                  )}

                  {f.remediation.references?.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {f.remediation.references.map((ref, j) => (
                        <a key={j} href={ref} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-accent-2 hover:underline truncate max-w-[200px]">
                          {ref.replace('https://', '').split('/')[0]}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

function KpiCard({ icon: Icon, label, value, sub, color }) {
  return (
    <div className="bg-panel border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} className={color} />
        <span className="text-muted text-xs uppercase tracking-wide">{label}</span>
      </div>
      <div className={`text-3xl font-bold mono ${color}`}>{value}</div>
      <div className="text-muted text-xs mt-1">{sub}</div>
    </div>
  )
}

function SevDot({ sev }) {
  const color = { critical: 'bg-critical', high: 'bg-danger', medium: 'bg-warning', low: 'bg-success' }[sev?.toLowerCase()] || 'bg-muted'
  return <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />
}

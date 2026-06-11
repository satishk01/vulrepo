import React, { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ChevronLeft, Loader2 } from 'lucide-react'
import { getScan } from '../utils/api.js'

const sevColor = {
  critical: 'bg-red-500/20 text-red-300 border-red-500/30',
  high:     'bg-orange-500/20 text-orange-300 border-orange-500/30',
  medium:   'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  low:      'bg-blue-500/20 text-blue-300 border-blue-500/30',
  info:     'bg-slate-500/20 text-slate-300 border-slate-500/30',
}

export default function ScanDetailPage() {
  const { scanId } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    getScan(scanId)
      .then(r => setData(r.data))
      .catch(e => setError(e.response?.data?.detail || e.message))
  }, [scanId])

  if (error) return <div className="p-6 text-red-400">{error}</div>
  if (!data) return <div className="p-6 text-muted flex items-center gap-2"><Loader2 className="animate-spin" size={16}/> Loading scan…</div>

  const { scan, findings = [], analysis } = data
  const sumByLabel = {}
  findings.forEach(f => { sumByLabel[f.severity] = (sumByLabel[f.severity] || 0) + 1 })

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <Link to="/scans" className="inline-flex items-center gap-1 text-sm text-muted hover:text-white">
        <ChevronLeft size={14}/> Back to scans
      </Link>

      <div className="bg-panel border border-border rounded-lg p-6">
        <h1 className="text-lg font-semibold text-white">
          {scan.source_type === 'github' ? scan.repo_url : scan.filename || scan.scan_id}
        </h1>
        <div className="text-sm text-muted mt-1">
          {scan.source_type} · {findings.length} findings · {scan.created_at?.slice(0, 19).replace('T', ' ')} UTC
        </div>
        <div className="flex gap-2 mt-4 flex-wrap">
          {Object.entries(sumByLabel).map(([sev, n]) => (
            <span key={sev} className={`text-xs px-2 py-0.5 rounded border ${sevColor[sev] || sevColor.info}`}>
              {sev}: {n}
            </span>
          ))}
        </div>
      </div>

      {analysis?.analysis?.executive_summary && (
        <div className="bg-panel border border-border rounded-lg p-6">
          <h2 className="text-md font-semibold text-white mb-2">Executive summary</h2>
          <p className="text-sm text-white mb-2">{analysis.analysis.executive_summary.top_risk}</p>
          {analysis.analysis.executive_summary.recommended_immediate_actions?.length > 0 && (
            <ul className="text-sm text-muted list-disc list-inside space-y-1">
              {analysis.analysis.executive_summary.recommended_immediate_actions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Remediation Plan from analysis */}
      {analysis?.analysis?.scored_findings?.some(f => f.remediation) && (
        <div className="bg-panel border border-border rounded-lg p-6">
          <h2 className="text-md font-semibold text-white mb-4">Remediation plan</h2>
          <div className="space-y-4">
            {analysis.analysis.scored_findings
              .filter(f => f.remediation)
              .sort((a, b) => (a.priority_rank || 99) - (b.priority_rank || 99))
              .map((f, i) => (
                <div key={f.id || i} className="border border-border rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className={`text-xs px-2 py-0.5 rounded border ${sevColor[f.risk_label] || sevColor.medium}`}>
                      {f.risk_label}
                    </span>
                    <span className="text-white text-sm font-medium">{f.title}</span>
                    {f.remediation.estimated_effort && (
                      <span className="ml-auto text-xs text-muted">{f.remediation.estimated_effort} effort</span>
                    )}
                  </div>
                  {f.remediation.root_cause && (
                    <p className="text-sm text-muted mb-2">{f.remediation.root_cause}</p>
                  )}
                  {f.remediation.fix_steps?.length > 0 && (
                    <ol className="space-y-1 mb-2">
                      {f.remediation.fix_steps.map((step, j) => (
                        <li key={j} className="flex gap-2 text-sm text-white">
                          <span className="text-blue-400 mono shrink-0">{j + 1}.</span>{step}
                        </li>
                      ))}
                    </ol>
                  )}
                  {f.remediation.code_example && f.remediation.code_example.trim() && (
                    <pre className="bg-surface rounded p-3 text-xs text-green-400 overflow-x-auto mb-2 whitespace-pre-wrap">{f.remediation.code_example}</pre>
                  )}
                  {f.remediation.verification && (
                    <p className="text-xs text-muted">Verify: {f.remediation.verification}</p>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="bg-panel border border-border rounded-lg p-6">
        <h2 className="text-md font-semibold text-white mb-4">Findings</h2>
        <ul className="divide-y divide-border">
          {findings.map(f => (
            <li key={f.finding_id || f.id} className="py-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-2 py-0.5 rounded border ${sevColor[f.severity] || sevColor.info}`}>
                  {f.severity}
                </span>
                <span className="text-white text-sm font-medium">{f.title}</span>
                {f.cvss_score && (
                  <span className="text-xs text-muted">CVSS {f.cvss_score}</span>
                )}
              </div>
              {f.file_path && (
                <div className="text-xs text-muted mt-1">
                  {f.file_path}{f.line_number ? `:${f.line_number}` : ''}
                </div>
              )}
              {f.description && (
                <div className="text-sm text-muted mt-1 line-clamp-2">{f.description}</div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

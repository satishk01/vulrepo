import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Github, FileText, Upload, Loader2, BarChart2 } from 'lucide-react'
import { listScans } from '../utils/api.js'

const kindIcon = {
  github: <Github size={14} className="text-accent-2" />,
  pentest: <FileText size={14} className="text-accent-2" />,
  upload: <Upload size={14} className="text-accent-2" />,
  'multi-upload': <Upload size={14} className="text-purple-400" />,
}

export default function ScansListPage() {
  const [scans, setScans] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listScans()
      .then(r => setScans(r.data.scans || []))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-6 text-muted flex items-center gap-2"><Loader2 className="animate-spin" size={16}/> Loading…</div>

  return (
    <div className="max-w-5xl mx-auto p-6">
      <h1 className="text-xl font-semibold text-white mb-4">Scans</h1>
      {scans.length === 0 ? (
        <p className="text-muted text-sm">No scans yet.</p>
      ) : (
        <ul className="divide-y divide-border bg-panel border border-border rounded-lg">
          {scans.map(s => (
            <li key={s.scan_id} className="p-4">
              <div className="flex items-center justify-between gap-4">
                <Link to={`/scans/${s.scan_id}`} className="flex items-center gap-3 min-w-0 flex-1">
                  {kindIcon[s.source_type] || kindIcon.upload}
                  <div className="min-w-0">
                    <div className="text-white text-sm truncate">
                      {s.repo_url || s.filename || s.scan_id}
                    </div>
                    <div className="text-xs text-muted">
                      {s.source_type} · {s.findings_count ?? 0} findings
                    </div>
                  </div>
                </Link>
                <div className="flex items-center gap-3 shrink-0">
                  <Link
                    to={`/dashboard/${s.scan_id}`}
                    className="flex items-center gap-1 text-xs text-accent-2 hover:text-white transition px-2 py-1 rounded hover:bg-white/5"
                  >
                    <BarChart2 size={12} /> Dashboard
                  </Link>
                  <span className="text-xs text-muted whitespace-nowrap">
                    {s.created_at?.slice(0, 19).replace('T', ' ')}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

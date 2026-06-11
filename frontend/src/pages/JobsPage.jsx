import React, { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { CheckCircle2, XCircle, Loader2, Clock } from 'lucide-react'
import { getJob, listJobs } from '../utils/api.js'

const POLL_MS = 3000

const StatusIcon = ({ status }) => {
  switch (status) {
    case 'succeeded': return <CheckCircle2 size={16} className="text-success" />
    case 'failed':    return <XCircle size={16} className="text-red-400" />
    case 'running':   return <Loader2 size={16} className="animate-spin text-accent-2" />
    default:          return <Clock size={16} className="text-muted" />
  }
}

export function JobsListPage() {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const r = await listJobs()
        if (alive) setJobs(r.data.jobs || [])
      } finally { if (alive) setLoading(false) }
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (loading) return <div className="p-6 text-muted">Loading jobs…</div>

  return (
    <div className="max-w-5xl mx-auto p-6">
      <h1 className="text-xl font-semibold text-white mb-4">Jobs</h1>
      {jobs.length === 0 ? (
        <p className="text-muted text-sm">No jobs yet. Trigger a scan from the Sources page.</p>
      ) : (
        <ul className="divide-y divide-border bg-panel border border-border rounded-lg">
          {jobs.map(j => (
            <li key={j.job_id} className="p-4 flex items-center justify-between">
              <Link to={`/jobs/${j.job_id}`} className="flex items-center gap-3 min-w-0 flex-1">
                <StatusIcon status={j.status} />
                <div className="min-w-0">
                  <div className="text-white text-sm truncate">{j.kind} · {j.job_id.slice(0, 8)}</div>
                  <div className="text-xs text-muted">{j.progress || j.status}</div>
                </div>
              </Link>
              <span className="text-xs text-muted">{j.created_at?.slice(0, 19).replace('T', ' ')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function JobDetailPage() {
  const { jobId } = useParams()
  const navigate = useNavigate()
  const [job, setJob] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    let intervalId
    const tick = async () => {
      try {
        const r = await getJob(jobId)
        if (!alive) return
        setJob(r.data)
        if (r.data.status === 'succeeded' || r.data.status === 'failed') {
          clearInterval(intervalId)
        }
      } catch (e) {
        if (alive) setError(e.response?.data?.detail || e.message)
      }
    }
    tick()
    intervalId = setInterval(tick, POLL_MS)
    return () => { alive = false; clearInterval(intervalId) }
  }, [jobId])

  if (error) return <div className="p-6 text-red-400">{error}</div>
  if (!job) return <div className="p-6 text-muted">Loading…</div>

  const scanId = job.result?.scan_id || job.params?.scan_id

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <div className="bg-panel border border-border rounded-lg p-6">
        <div className="flex items-center gap-2 mb-2">
          <StatusIcon status={job.status} />
          <h1 className="text-lg font-semibold text-white capitalize">
            {job.kind.replace('_', ' ')} · {job.status}
          </h1>
        </div>
        <div className="text-sm text-muted">{job.progress}</div>
        {job.created_at && (
          <div className="text-xs text-muted mt-2">
            Started {job.created_at?.slice(0, 19).replace('T', ' ')} UTC
          </div>
        )}
      </div>

      {job.status === 'failed' && job.error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded p-4">
          <div className="font-semibold mb-1">Error</div>
          <code className="text-xs">{job.error}</code>
        </div>
      )}

      {job.status === 'succeeded' && job.result && (
        <div className="bg-panel border border-border rounded-lg p-6 space-y-3">
          <div className="text-sm text-white">
            <span className="text-muted">Findings:</span> {job.result.findings_count}
          </div>
          {job.result.analysis_ready && (
            <div className="text-sm text-success">AI analysis complete</div>
          )}
          {scanId && (
            <button
              onClick={() => navigate(`/scans/${scanId}`)}
              className="bg-accent-2 text-black text-sm rounded px-4 py-2"
            >
              View scan results
            </button>
          )}
        </div>
      )}
    </div>
  )
}

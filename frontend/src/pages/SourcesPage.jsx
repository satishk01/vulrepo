import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Github, FileText, Archive, Cloud, Trash2, Play, Plus, Loader2 } from 'lucide-react'
import {
  createGithubSource, createS3Source, listSources, deleteSource,
  triggerSourceScan, uploadPentestReport, uploadZipSource,
} from '../utils/api.js'

export default function SourcesPage({ selectedModel, assetContext, orgContext }) {
  const navigate = useNavigate()
  const [sources, setSources] = useState([])
  const [loading, setLoading] = useState(true)
  const [showGh, setShowGh] = useState(false)
  const [showS3, setShowS3] = useState(false)
  const [ghForm, setGhForm] = useState({ name: '', repo_url: '', branch: '', description: '' })
  const [s3Form, setS3Form] = useState({ name: '', s3_uri: '', description: '' })
  const [zipFile, setZipFile] = useState(null)
  const [pentestFile, setPentestFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const refresh = async () => {
    try {
      const res = await listSources()
      setSources(res.data.sources || [])
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  const handle = async (fn) => {
    setBusy(true); setError(null)
    try { await fn() }
    catch (e) { setError(e.response?.data?.detail || e.message) }
    finally { setBusy(false) }
  }

  const onAddGithub = (e) => {
    e.preventDefault()
    handle(async () => {
      await createGithubSource({
        ...ghForm, branch: ghForm.branch || null,
        asset_context: assetContext, org_context: orgContext,
      })
      setShowGh(false)
      setGhForm({ name: '', repo_url: '', branch: '', description: '' })
      refresh()
    })
  }

  const onAddS3 = (e) => {
    e.preventDefault()
    handle(async () => {
      await createS3Source({
        ...s3Form,
        asset_context: assetContext, org_context: orgContext,
      })
      setShowS3(false)
      setS3Form({ name: '', s3_uri: '', description: '' })
      refresh()
    })
  }

  const onScan = (sourceId) => handle(async () => {
    const res = await triggerSourceScan(sourceId, {
      model_id: selectedModel,
      asset_context: assetContext, org_context: orgContext,
      run_analysis: true,
    })
    navigate(`/jobs/${res.data.job_id}`)
  })

  const onDelete = async (sourceId) => {
    if (!confirm('Delete this source?')) return
    await deleteSource(sourceId); refresh()
  }

  const onZipUpload = (e) => {
    e.preventDefault()
    if (!zipFile) return
    handle(async () => {
      const res = await uploadZipSource(zipFile, {
        modelId: selectedModel,
        assetContext, orgContext, runAnalysis: true,
      })
      navigate(`/jobs/${res.data.job_id}`)
    })
  }

  const onPentestUpload = (e) => {
    e.preventDefault()
    if (!pentestFile) return
    handle(async () => {
      const res = await uploadPentestReport(pentestFile, {
        modelId: selectedModel,
        assetContext, orgContext, runAnalysis: true,
      })
      navigate(`/jobs/${res.data.job_id}`)
    })
  }

  const ghSources = sources.filter(s => s.kind === 'github')
  const s3Sources = sources.filter(s => s.kind === 's3')

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">

      {/* GitHub */}
      <section className="bg-panel border border-border rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Github size={20} className="text-accent-2" />
            <h2 className="text-lg font-semibold text-white">GitHub repositories</h2>
          </div>
          <button onClick={() => setShowGh(!showGh)}
            className="text-sm flex items-center gap-1 px-3 py-1.5 bg-accent-2/10 text-accent-2 rounded hover:bg-accent-2/20">
            <Plus size={14}/> Add repo
          </button>
        </div>
        {showGh && (
          <form onSubmit={onAddGithub} className="space-y-3 bg-surface border border-border rounded p-4 mb-4">
            <input className="w-full bg-panel border border-border rounded px-3 py-2 text-sm text-white"
              placeholder="Name" value={ghForm.name}
              onChange={e => setGhForm({ ...ghForm, name: e.target.value })} required/>
            <input className="w-full bg-panel border border-border rounded px-3 py-2 text-sm text-white"
              placeholder="https://github.com/owner/repo" value={ghForm.repo_url}
              onChange={e => setGhForm({ ...ghForm, repo_url: e.target.value })} required/>
            <input className="w-full bg-panel border border-border rounded px-3 py-2 text-sm text-white"
              placeholder="Branch (optional)" value={ghForm.branch}
              onChange={e => setGhForm({ ...ghForm, branch: e.target.value })}/>
            <div className="text-xs text-muted">Private repos: populate the GitHub PAT in Secrets Manager
              (<code className="bg-panel px-1">uem-stack-github-token</code>) before scanning.</div>
            <button disabled={busy} className="bg-accent-2 text-black text-sm rounded px-4 py-2 disabled:opacity-50">
              {busy ? 'Saving…' : 'Save source'}
            </button>
          </form>
        )}
        {loading ? <Spinner/> : ghSources.length === 0
          ? <p className="text-muted text-sm">No GitHub sources yet.</p>
          : <SourceList items={ghSources} onScan={onScan} onDelete={onDelete} busy={busy}
              renderSubtitle={s => `${s.repo_url}${s.branch ? ` · ${s.branch}` : ''}`}/>}
      </section>

      {/* S3 source */}
      <section className="bg-panel border border-border rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Cloud size={20} className="text-accent-2" />
            <h2 className="text-lg font-semibold text-white">S3 sources</h2>
          </div>
          <button onClick={() => setShowS3(!showS3)}
            className="text-sm flex items-center gap-1 px-3 py-1.5 bg-accent-2/10 text-accent-2 rounded hover:bg-accent-2/20">
            <Plus size={14}/> Add S3 source
          </button>
        </div>
        <p className="text-xs text-muted mb-3">
          Point at a single <code className="bg-surface px-1">.zip</code> in S3, or at a prefix
          containing source files (e.g. <code className="bg-surface px-1">s3://my-bucket/projects/billing/</code>).
        </p>
        {showS3 && (
          <form onSubmit={onAddS3} className="space-y-3 bg-surface border border-border rounded p-4 mb-4">
            <input className="w-full bg-panel border border-border rounded px-3 py-2 text-sm text-white"
              placeholder="Name" value={s3Form.name}
              onChange={e => setS3Form({ ...s3Form, name: e.target.value })} required/>
            <input className="w-full bg-panel border border-border rounded px-3 py-2 text-sm text-white"
              placeholder="s3://bucket/path/to/source.zip   or   s3://bucket/prefix/" value={s3Form.s3_uri}
              onChange={e => setS3Form({ ...s3Form, s3_uri: e.target.value })} required/>
            <input className="w-full bg-panel border border-border rounded px-3 py-2 text-sm text-white"
              placeholder="Description (optional)" value={s3Form.description}
              onChange={e => setS3Form({ ...s3Form, description: e.target.value })}/>
            <div className="text-xs text-muted">The backend's ECS task role needs s3:GetObject + s3:ListBucket on the
              target bucket. The default IAM policy allows all buckets — tighten for production.</div>
            <button disabled={busy} className="bg-accent-2 text-black text-sm rounded px-4 py-2 disabled:opacity-50">
              {busy ? 'Saving…' : 'Save source'}
            </button>
          </form>
        )}
        {loading ? <Spinner/> : s3Sources.length === 0
          ? <p className="text-muted text-sm">No S3 sources yet.</p>
          : <SourceList items={s3Sources} onScan={onScan} onDelete={onDelete} busy={busy}
              renderSubtitle={s => s.s3_uri}/>}
      </section>

      {/* Direct zip upload */}
      <section className="bg-panel border border-border rounded-lg p-6">
        <div className="flex items-center gap-2 mb-4">
          <Archive size={20} className="text-accent-2" />
          <h2 className="text-lg font-semibold text-white">Upload source as .zip</h2>
        </div>
        <p className="text-sm text-muted mb-4">
          For when you can't share a GitHub URL or an S3 bucket. We extract in-memory, run Semgrep,
          and discard the source after the scan.
        </p>
        <form onSubmit={onZipUpload} className="space-y-3">
          <input type="file" accept=".zip"
            onChange={e => setZipFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-muted file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-accent-2/10 file:text-accent-2 hover:file:bg-accent-2/20"/>
          <button disabled={busy || !zipFile}
            className="bg-accent-2 text-black text-sm rounded px-4 py-2 disabled:opacity-50">
            {busy ? 'Uploading…' : 'Upload & scan'}
          </button>
        </form>
      </section>

      {/* Pen-test */}
      <section className="bg-panel border border-border rounded-lg p-6">
        <div className="flex items-center gap-2 mb-4">
          <FileText size={20} className="text-accent-2" />
          <h2 className="text-lg font-semibold text-white">Pen-test report</h2>
        </div>
        <p className="text-sm text-muted mb-4">
          PDF, Markdown, or HTML. Claude extracts findings into the same schema as scanner output.
        </p>
        <form onSubmit={onPentestUpload} className="space-y-3">
          <input type="file" accept=".pdf,.md,.txt,.html,.htm"
            onChange={e => setPentestFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-muted file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-accent-2/10 file:text-accent-2 hover:file:bg-accent-2/20"/>
          <button disabled={busy || !pentestFile}
            className="bg-accent-2 text-black text-sm rounded px-4 py-2 disabled:opacity-50">
            {busy ? 'Uploading…' : 'Upload & extract'}
          </button>
        </form>
      </section>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded p-3">
          {error}
        </div>
      )}
    </div>
  )
}

function Spinner() {
  return <div className="flex items-center gap-2 text-muted"><Loader2 className="animate-spin" size={16}/> Loading…</div>
}

function SourceList({ items, onScan, onDelete, busy, renderSubtitle }) {
  return (
    <ul className="divide-y divide-border">
      {items.map(s => (
        <li key={s.source_id} className="py-3 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-white font-medium">{s.name}</div>
            <div className="text-xs text-muted truncate">{renderSubtitle(s)}</div>
            {s.description && <div className="text-xs text-muted mt-1">{s.description}</div>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => onScan(s.source_id)} disabled={busy}
              className="flex items-center gap-1 text-xs px-3 py-1.5 bg-accent-2 text-black rounded hover:opacity-90 disabled:opacity-50">
              <Play size={12}/> Scan
            </button>
            <button onClick={() => onDelete(s.source_id)} className="p-1.5 text-muted hover:text-red-400">
              <Trash2 size={14}/>
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
}

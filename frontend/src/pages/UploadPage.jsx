import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, FileJson, CheckCircle, AlertCircle, Loader2, ChevronRight, X, FileText, File, RotateCcw } from 'lucide-react'
import { uploadMultipleFiles, getJob, getScan } from '../utils/api.js'

const SAMPLE_SARIF = JSON.stringify({
  "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
  "version": "2.1.0",
  "runs": [{
    "tool": { "driver": { "name": "Semgrep", "rules": [
      { "id": "sql-injection", "name": "SQL Injection", "shortDescription": { "text": "User input in SQL query" },
        "properties": { "security-severity": "8.5", "tags": ["CWE-89"] } },
      { "id": "xss-reflected", "name": "Reflected XSS", "shortDescription": { "text": "Unsanitized input reflected to DOM" },
        "properties": { "security-severity": "6.1", "tags": ["CWE-79"] } },
      { "id": "hardcoded-secret", "name": "Hardcoded Secret", "shortDescription": { "text": "API key in source code" },
        "properties": { "security-severity": "7.5", "tags": ["CWE-798"] } }
    ]}},
    "results": [
      { "ruleId": "sql-injection", "level": "error", "message": { "text": "User-controlled data flows into SQL query without sanitization" },
        "locations": [{ "physicalLocation": { "artifactLocation": { "uri": "src/db/userRepo.js" }, "region": { "startLine": 42 } } }] },
      { "ruleId": "xss-reflected", "level": "warning", "message": { "text": "User input rendered in response without escaping" },
        "locations": [{ "physicalLocation": { "artifactLocation": { "uri": "src/api/search.js" }, "region": { "startLine": 88 } } }] },
      { "ruleId": "hardcoded-secret", "level": "error", "message": { "text": "AWS_SECRET_KEY found in source" },
        "locations": [{ "physicalLocation": { "artifactLocation": { "uri": "src/config/aws.js" }, "region": { "startLine": 5 } } }] }
    ]
  }]
}, null, 2)

export default function UploadPage({ scanData, setScanData, selectedModel, assetContext, orgContext }) {
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [selectedFiles, setSelectedFiles] = useState([])
  const [fileResults, setFileResults] = useState(null)
  const [progress, setProgress] = useState(null)
  const [jobId, setJobId] = useState(null)
  const pollRef = useRef(null)
  const navigate = useNavigate()

  // Poll job status
  useEffect(() => {
    if (!jobId) return
    let cancelled = false

    const poll = async () => {
      try {
        const { data } = await getJob(jobId)
        if (cancelled) return

        setProgress(data.progress || 'Processing...')

        if (data.status === 'succeeded') {
          // Job done — fetch the scan data
          const scanId = data.params?.scan_id || data.result?.scan_id
          if (scanId) {
            const { data: scanResult } = await getScan(scanId)
            // Backend returns { scan, findings, analysis }
            const findingsArray = scanResult.findings || []
            setScanData({
              scan_id: scanId,
              findings: findingsArray,
              findings_count: findingsArray.length,
              files_processed: data.result?.files_processed,
              file_results: data.result?.file_results,
              message: `Processed ${data.result?.files_processed || 0} files — ${data.result?.findings_count || 0} findings extracted`,
            })
            setFileResults(data.result?.file_results || [])
          }
          setUploading(false)
          setJobId(null)
          setProgress(null)
          setSelectedFiles([])
        } else if (data.status === 'failed') {
          const errorMsg = data.error || 'Processing failed'
          console.error('Job failed:', errorMsg)
          setError(errorMsg)
          setUploading(false)
          setJobId(null)
          setProgress(null)
        } else {
          // Still running — poll again
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
  }, [jobId, setScanData])

  const addFiles = useCallback((newFiles) => {
    const fileList = Array.from(newFiles)
    setSelectedFiles(prev => {
      const existing = new Set(prev.map(f => f.name + f.size))
      const toAdd = fileList.filter(f => !existing.has(f.name + f.size))
      return [...prev, ...toAdd]
    })
    setError(null)
  }, [])

  const removeFile = (index) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index))
  }

  const startNewUpload = useCallback(() => {
    setScanData(null)
    setSelectedFiles([])
    setFileResults(null)
    setError(null)
    setProgress(null)
  }, [setScanData])

  const handleUpload = useCallback(async () => {
    if (selectedFiles.length === 0) return
    setError(null)
    setUploading(true)
    setFileResults(null)
    setScanData(null)
    setProgress('Uploading files...')
    try {
      const { data } = await uploadMultipleFiles(selectedFiles, {
        modelId: selectedModel,
        assetContext: assetContext || {},
        orgContext: orgContext || {},
      })
      // Response now contains a job_id — start polling
      if (data.job_id) {
        setJobId(data.job_id)
        setProgress(`${data.files_queued} files queued for processing...`)
      } else {
        // Fallback if direct response (shouldn't happen with new backend)
        setScanData(data)
        setFileResults(data.file_results || [])
        setUploading(false)
        setSelectedFiles([])
      }
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
      setUploading(false)
      setProgress(null)
    }
  }, [selectedFiles, selectedModel, setScanData])

  const onDrop = useCallback((e) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files)
    }
  }, [addFiles])

  const loadSample = () => {
    const blob = new Blob([SAMPLE_SARIF], { type: 'application/json' })
    const file = new File([blob], 'sample-semgrep.sarif.json')
    addFiles([file])
  }

  const getFileIcon = (filename) => {
    const ext = (filename || '').split('.').pop().toLowerCase()
    if (['json', 'sarif'].includes(ext)) return <FileJson size={14} className="text-accent-2" />
    if (['md', 'txt', 'pdf', 'html'].includes(ext)) return <FileText size={14} className="text-purple-400" />
    return <File size={14} className="text-muted" />
  }

  const getFileTypeLabel = (filename) => {
    const ext = (filename || '').split('.').pop().toLowerCase()
    if (['json', 'sarif', 'csv', 'xml'].includes(ext)) return 'Scan report'
    if (['md', 'txt', 'pdf', 'html', 'htm'].includes(ext)) return 'Pentest report'
    return 'Auto-detect'
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-semibold text-white">Ingest scan results</h1>
        {scanData && (
          <button
            onClick={startNewUpload}
            className="flex items-center gap-1.5 text-sm text-accent-2 hover:text-white transition-colors"
          >
            <RotateCcw size={14} />
            New upload
          </button>
        )}
      </div>
      <p className="text-muted text-sm mb-8">
        Upload one or more files. Supported: SARIF · Snyk JSON · OWASP ZAP · Trivy · AWS Security Hub · CSV · Pen-test reports (MD, TXT, PDF, HTML)
      </p>

      {/* Drop zone — always visible unless actively uploading */}
      {!uploading && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`relative border-2 border-dashed rounded-xl p-12 flex flex-col items-center gap-4 transition-all cursor-pointer
            ${dragging ? 'border-accent-2 bg-accent-2/5' : 'border-border hover:border-accent-2/50 hover:bg-white/2'}`}
          onClick={() => document.getElementById('file-input').click()}
        >
          <input
            id="file-input"
            type="file"
            accept=".json,.sarif,.csv,.xml,.md,.txt,.pdf,.html,.htm"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files.length > 0) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <Upload className={dragging ? 'text-accent-2' : 'text-muted'} size={40} />
          <div className="text-center">
            <p className="text-white font-medium">Drop your scan files here</p>
            <p className="text-muted text-sm mt-1">or click to browse · Multiple files supported · JSON, SARIF, CSV, MD, TXT, PDF</p>
          </div>
        </div>
      )}

      {/* Processing progress */}
      {uploading && progress && (
        <div className="mt-4 bg-panel border border-border rounded-lg p-4">
          <div className="flex items-center gap-3">
            <Loader2 size={16} className="animate-spin text-accent-2 shrink-0" />
            <div className="flex-1">
              <p className="text-white text-sm font-medium">Processing in progress</p>
              <p className="text-accent-2 text-sm mt-0.5">{progress}</p>
            </div>
          </div>
          <div className="mt-3 h-1.5 bg-surface rounded-full overflow-hidden">
            <div className="h-full bg-accent-2 rounded-full animate-pulse" style={{ width: '60%' }} />
          </div>
        </div>
      )}

      {/* Selected files list — show whenever files are selected and not currently uploading */}
      {selectedFiles.length > 0 && !uploading && (
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-white text-sm font-medium">{selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''} selected</p>
            <button
              onClick={() => setSelectedFiles([])}
              className="text-xs text-muted hover:text-white transition"
            >
              Clear all
            </button>
          </div>
          <div className="bg-panel border border-border rounded-lg divide-y divide-border/50 max-h-48 overflow-y-auto">
            {selectedFiles.map((file, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2">
                {getFileIcon(file.name)}
                <span className="text-sm text-white flex-1 truncate">{file.name}</span>
                <span className="text-xs text-muted">{getFileTypeLabel(file.name)}</span>
                <span className="text-xs text-muted">{(file.size / 1024).toFixed(0)} KB</span>
                <button onClick={() => removeFile(i)} className="text-muted hover:text-danger transition">
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={handleUpload}
            disabled={uploading}
            className="w-full flex items-center justify-center gap-2 bg-accent text-white font-medium px-5 py-3 rounded-lg hover:bg-accent/80 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Upload size={16} />
            Upload &amp; process {selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''}
          </button>
        </div>
      )}

      {/* Sample data */}
      {!uploading && selectedFiles.length === 0 && (
        <div className="mt-4 flex items-center gap-3">
          <span className="text-muted text-sm">No file handy?</span>
          <button
            onClick={loadSample}
            className="flex items-center gap-1.5 text-sm text-accent-2 hover:text-white transition-colors"
          >
            <FileJson size={14} />
            Load sample Semgrep SARIF
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-6 flex items-start gap-3 bg-danger/10 border border-danger/30 rounded-lg p-4">
          <AlertCircle className="text-danger shrink-0 mt-0.5" size={16} />
          <div className="flex-1">
            <p className="text-danger text-sm font-medium mb-1">Error processing files</p>
            <p className="text-danger text-xs opacity-80 whitespace-pre-wrap break-words">{error}</p>
          </div>
        </div>
      )}

      {/* Per-file results */}
      {fileResults && fileResults.length > 0 && (
        <div className="mt-4 bg-panel border border-border rounded-lg p-4">
          <p className="text-white text-sm font-medium mb-2">File processing results</p>
          <div className="space-y-1">
            {fileResults.map((fr, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                {fr.status === 'ok' ? (
                  <CheckCircle size={14} className="text-success shrink-0" />
                ) : fr.status === 'skipped' ? (
                  <AlertCircle size={14} className="text-warning shrink-0" />
                ) : (
                  <AlertCircle size={14} className="text-danger shrink-0" />
                )}
                <span className="text-white truncate">{fr.filename}</span>
                <span className="text-muted text-xs ml-auto">
                  {fr.status === 'ok' ? `${fr.findings_count} findings` : fr.reason || fr.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Combined results — only show when we have scan data and no new files selected */}
      {scanData && selectedFiles.length === 0 && (
        <div className="mt-6 bg-panel border border-border rounded-xl overflow-hidden">
          <div className="flex items-center gap-3 p-4 border-b border-border">
            <CheckCircle className="text-success" size={18} />
            <div>
              <p className="text-white font-medium">
                {scanData.files_processed ? `${scanData.files_processed} files processed` : scanData.filename}
              </p>
              <p className="text-muted text-xs">{scanData.message}</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => navigate(`/dashboard/${scanData.scan_id}`)}
                className="flex items-center gap-1.5 bg-accent-2 text-surface text-sm font-medium px-4 py-2 rounded-lg hover:bg-accent-2/80 transition"
              >
                View Dashboard <ChevronRight size={14} />
              </button>
              <button
                onClick={() => navigate('/context')}
                className="flex items-center gap-1.5 border border-border text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-white/5 transition"
              >
                Set context <ChevronRight size={14} />
              </button>
            </div>
          </div>

          {/* Finding preview table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted text-xs uppercase tracking-wide">
                  <th className="text-left p-3 pl-4">Title</th>
                  <th className="text-left p-3">Severity</th>
                  <th className="text-left p-3">Tool</th>
                  <th className="text-left p-3 hidden md:table-cell">Location</th>
                </tr>
              </thead>
              <tbody>
                {(scanData.findings || []).slice(0, 15).map((f) => (
                  <tr key={f.id} className="border-b border-border/50 hover:bg-white/2">
                    <td className="p-3 pl-4 text-white font-medium truncate max-w-xs">{f.title}</td>
                    <td className="p-3">
                      <SevBadge sev={f.severity} />
                    </td>
                    <td className="p-3 text-muted mono text-xs">{f.tool}</td>
                    <td className="p-3 text-muted mono text-xs hidden md:table-cell truncate max-w-xs">
                      {f.file_path ? `${f.file_path}${f.line_number ? ':' + f.line_number : ''}` : f.url || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(scanData.findings || []).length > 15 && (
              <p className="text-muted text-xs p-3 pl-4">
                + {scanData.findings.length - 15} more findings
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SevBadge({ sev }) {
  const cls = {
    critical: 'bg-critical/15 text-critical border-critical/30',
    high: 'bg-danger/15 text-danger border-danger/30',
    medium: 'bg-warning/15 text-warning border-warning/30',
    low: 'bg-success/15 text-success border-success/30',
    info: 'bg-muted/15 text-muted border-muted/30',
  }[sev] || 'bg-muted/15 text-muted border-muted/30'
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium border ${cls} uppercase`}>
      {sev}
    </span>
  )
}

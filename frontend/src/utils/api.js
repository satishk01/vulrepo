import axios from 'axios'

// Resolution order:
//   1) window.__UEM_CONFIG__.apiUrl  — runtime config.js on S3 (updated by deploy.sh)
//   2) VITE_API_URL                  — build-time env var (used in docker-compose)
//   3) '/api'                        — local dev via Vite proxy
const runtimeApiUrl =
  (typeof window !== 'undefined' && window.__UEM_CONFIG__ && window.__UEM_CONFIG__.apiUrl) || ''
const BASE = runtimeApiUrl || import.meta.env.VITE_API_URL || '/api'

const api = axios.create({ baseURL: BASE, timeout: 180000 })

// Longer timeout for AI-heavy operations
const aiApi = axios.create({ baseURL: BASE, timeout: 600000 })

// v1 endpoints
export const uploadScan = (file, scanType = 'auto') => {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('scan_type', scanType)
  return api.post('/upload/scan', fd)
}

export const uploadMultipleFiles = (files, opts = {}) => {
  const fd = new FormData()
  for (const file of files) {
    fd.append('files', file)
  }
  if (opts.modelId) fd.append('model_id', opts.modelId)
  if (opts.assetContext) fd.append('asset_context', JSON.stringify(opts.assetContext))
  if (opts.orgContext) fd.append('org_context', JSON.stringify(opts.orgContext))
  if (opts.runAnalysis !== undefined) fd.append('run_analysis', opts.runAnalysis ? 'true' : 'false')
  return api.post('/upload/multi', fd)
}

export const analyzeFindingsApi = (payload) => aiApi.post('/analyze', payload)

export const analyzeUnifiedApi = (payload) => aiApi.post('/analyze/unified', payload)

export const getRemediation = (findingId, finding, modelId) =>
  api.post(`/remediate/${findingId}?model_id=${modelId}`, finding)

export const listModels = () => api.get('/models')

// --- v2: sources ---
export const createGithubSource = (payload) => api.post('/sources/github', payload)
export const createS3Source = (payload) => api.post('/sources/s3', payload)
export const listSources = () => api.get('/sources')
export const getSource = (id) => api.get(`/sources/${id}`)
export const deleteSource = (id) => api.delete(`/sources/${id}`)
export const triggerSourceScan = (sourceId, payload) =>
  api.post(`/sources/${sourceId}/scan`, payload)
// kept for backwards-compatibility with older UI references
export const triggerGithubScan = triggerSourceScan

// --- v2: pen-test ---
export const uploadPentestReport = (file, opts = {}) => {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('model_id', opts.modelId || 'anthropic.claude-sonnet-4-5')
  fd.append('asset_context', JSON.stringify(opts.assetContext || {}))
  fd.append('org_context', JSON.stringify(opts.orgContext || {}))
  fd.append('run_analysis', opts.runAnalysis !== false ? 'true' : 'false')
  return api.post('/sources/pentest/upload', fd)
}

// --- v2: zip upload ---
export const uploadZipSource = (file, opts = {}) => {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('model_id', opts.modelId || 'anthropic.claude-sonnet-4-5')
  fd.append('asset_context', JSON.stringify(opts.assetContext || {}))
  fd.append('org_context', JSON.stringify(opts.orgContext || {}))
  fd.append('run_analysis', opts.runAnalysis !== false ? 'true' : 'false')
  return api.post('/sources/zip/upload', fd)
}

// --- v2: jobs ---
export const listJobs = () => api.get('/jobs')
export const getJob = (id) => api.get(`/jobs/${id}`)

// --- v2: scans ---
export const listScans = () => api.get('/scans')
export const getScan = (id) => api.get(`/scans/${id}`)

export default api

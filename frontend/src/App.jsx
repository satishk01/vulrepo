import React, { useState, useEffect, useCallback } from 'react'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import { Shield, Upload, BarChart2, FileText, Settings, Github, Briefcase, List } from 'lucide-react'
import UploadPage from './pages/UploadPage.jsx'
import AnalyzePage from './pages/AnalyzePage.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import ContextPage from './pages/ContextPage.jsx'
import SourcesPage from './pages/SourcesPage.jsx'
import { JobsListPage, JobDetailPage } from './pages/JobsPage.jsx'
import ScansListPage from './pages/ScansListPage.jsx'
import ScanDetailPage from './pages/ScanDetailPage.jsx'

// Persist state to localStorage so data survives page refresh/close
function usePersistedState(key, defaultValue) {
  const [state, setState] = useState(() => {
    try {
      const saved = localStorage.getItem(key)
      return saved ? JSON.parse(saved) : defaultValue
    } catch {
      return defaultValue
    }
  })
  
  const setAndPersist = useCallback((value) => {
    setState(value)
    try {
      if (value === null || value === undefined) {
        localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, JSON.stringify(value))
      }
    } catch { /* quota exceeded — ignore */ }
  }, [key])

  return [state, setAndPersist]
}

export default function App() {
  const [scanData, setScanData] = usePersistedState('uem_scanData', null)
  const [analysisData, setAnalysisData] = usePersistedState('uem_analysisData', null)
  const [assetContext, setAssetContext] = usePersistedState('uem_assetContext', {
    service_name: '', environment: 'production', internet_facing: true,
    handles_pii: false, handles_payments: false, tech_stack: [], criticality: 'high',
  })
  const [orgContext, setOrgContext] = usePersistedState('uem_orgContext', {
    team_ownership: {}, sla_hours: { critical: 24, high: 168, medium: 720, low: 2160 },
    jira_project_key: '', github_repo: '',
  })
  const [selectedModel, setSelectedModel] = useState('anthropic.claude-sonnet-4-5')

  const nav = [
    { to: '/sources', icon: Github,    label: 'Sources' },
    { to: '/upload',  icon: Upload,    label: 'Upload scan' },
    { to: '/context', icon: Settings,  label: 'Context' },
    { to: '/scans',   icon: List,      label: 'Scans' },
    { to: '/jobs',    icon: Briefcase, label: 'Jobs' },
    { to: '/dashboard', icon: BarChart2, label: 'Dashboard' },
  ]

  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col">
        <header className="border-b border-border px-6 py-3 flex items-center gap-4 bg-panel sticky top-0 z-50">
          <div className="flex items-center gap-2 mr-8">
            <div className="relative">
              <Shield className="text-accent-2" size={22} />
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-success rounded-full" />
            </div>
            <span className="font-semibold tracking-tight text-white">UEM</span>
            <span className="text-muted text-sm hidden sm:block">Unified Exposure Management</span>
          </div>

          <nav className="flex gap-1 flex-1 flex-wrap">
            {nav.map(({ to, icon: Icon, label }) => (
              <NavLink key={to} to={to}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors
                   ${isActive ? 'bg-accent-2/10 text-accent-2' : 'text-muted hover:text-white hover:bg-white/5'}`
                }>
                <Icon size={14} />
                {label}
              </NavLink>
            ))}
          </nav>

          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="bg-surface border border-border text-sm text-muted rounded px-2 py-1 focus:outline-none focus:border-accent-2"
          >
            <option value="anthropic.claude-sonnet-4-5">Sonnet 4.5 — Fast</option>
            <option value="anthropic.claude-opus-4-5">Opus 4.5 — Deep</option>
          </select>
        </header>

        <main className="flex-1">
          <Routes>
            <Route path="/" element={
              <SourcesPage selectedModel={selectedModel}
                assetContext={assetContext} orgContext={orgContext} />
            } />
            <Route path="/sources" element={
              <SourcesPage selectedModel={selectedModel}
                assetContext={assetContext} orgContext={orgContext} />
            } />
            <Route path="/upload" element={
              <UploadPage scanData={scanData} setScanData={setScanData} selectedModel={selectedModel}
                assetContext={assetContext} orgContext={orgContext} />
            } />
            <Route path="/context" element={
              <ContextPage assetContext={assetContext} setAssetContext={setAssetContext}
                orgContext={orgContext} setOrgContext={setOrgContext} />
            } />
            <Route path="/analyze" element={
              <AnalyzePage scanData={scanData} analysisData={analysisData}
                setAnalysisData={setAnalysisData} assetContext={assetContext}
                orgContext={orgContext} selectedModel={selectedModel} />
            } />
            <Route path="/dashboard" element={
              <DashboardPage analysisData={analysisData} scanData={scanData} />
            } />
            <Route path="/dashboard/:scanId" element={
              <DashboardPage analysisData={analysisData} scanData={scanData} />
            } />
            <Route path="/jobs" element={<JobsListPage />} />
            <Route path="/jobs/:jobId" element={<JobDetailPage />} />
            <Route path="/scans" element={<ScansListPage />} />
            <Route path="/scans/:scanId" element={<ScanDetailPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

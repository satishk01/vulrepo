import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Plus, Trash2 } from 'lucide-react'

export default function ContextPage({ assetContext, setAssetContext, orgContext, setOrgContext }) {
  const navigate = useNavigate()
  const [newStack, setNewStack] = useState('')
  const [newTeamSvc, setNewTeamSvc] = useState('')
  const [newTeamName, setNewTeamName] = useState('')

  const updateAsset = (k, v) => setAssetContext(prev => ({ ...prev, [k]: v }))
  const updateOrg = (k, v) => setOrgContext(prev => ({ ...prev, [k]: v }))

  const addStack = () => {
    if (newStack.trim()) {
      updateAsset('tech_stack', [...(assetContext.tech_stack || []), newStack.trim()])
      setNewStack('')
    }
  }

  const addTeam = () => {
    if (newTeamSvc.trim() && newTeamName.trim()) {
      updateOrg('team_ownership', { ...orgContext.team_ownership, [newTeamSvc.trim()]: newTeamName.trim() })
      setNewTeamSvc('')
      setNewTeamName('')
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-12 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white mb-1">Asset & organization context</h1>
        <p className="text-muted text-sm">
          This context lets Claude score risk accurately — an internet-facing PII service has a very different risk profile than an internal dev tool.
        </p>
      </div>

      {/* Asset context */}
      <Section title="Asset context">
        <Field label="Service / application name">
          <input
            type="text"
            value={assetContext.service_name}
            onChange={e => updateAsset('service_name', e.target.value)}
            placeholder="e.g. payments-api"
            className={inputCls}
          />
        </Field>

        <Field label="Environment">
          <select value={assetContext.environment} onChange={e => updateAsset('environment', e.target.value)} className={inputCls}>
            <option value="production">Production</option>
            <option value="staging">Staging</option>
            <option value="development">Development</option>
          </select>
        </Field>

        <Field label="Business criticality">
          <select value={assetContext.criticality} onChange={e => updateAsset('criticality', e.target.value)} className={inputCls}>
            <option value="critical">Critical (revenue / safety)</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Toggle label="Internet-facing" value={assetContext.internet_facing} onChange={v => updateAsset('internet_facing', v)} />
          <Toggle label="Handles PII" value={assetContext.handles_pii} onChange={v => updateAsset('handles_pii', v)} />
          <Toggle label="Handles payments" value={assetContext.handles_payments} onChange={v => updateAsset('handles_payments', v)} />
        </div>

        <Field label="Tech stack">
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={newStack}
              onChange={e => setNewStack(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addStack()}
              placeholder="e.g. Node.js, PostgreSQL, React"
              className={`${inputCls} flex-1`}
            />
            <button onClick={addStack} className={btnSm}>Add</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {(assetContext.tech_stack || []).map((t, i) => (
              <span key={i} className="flex items-center gap-1 bg-accent-2/10 text-accent-2 text-xs px-2 py-1 rounded">
                {t}
                <button onClick={() => updateAsset('tech_stack', assetContext.tech_stack.filter((_, j) => j !== i))}>
                  <Trash2 size={10} />
                </button>
              </span>
            ))}
          </div>
        </Field>
      </Section>

      {/* Org context */}
      <Section title="Organization context">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Jira project key">
            <input type="text" value={orgContext.jira_project_key} onChange={e => updateOrg('jira_project_key', e.target.value)}
              placeholder="e.g. SEC" className={inputCls} />
          </Field>
          <Field label="GitHub repo">
            <input type="text" value={orgContext.github_repo} onChange={e => updateOrg('github_repo', e.target.value)}
              placeholder="org/repo" className={inputCls} />
          </Field>
        </div>

        <Field label="SLA hours by severity">
          <div className="grid grid-cols-4 gap-2">
            {['critical', 'high', 'medium', 'low'].map(sev => (
              <div key={sev}>
                <label className="text-xs text-muted capitalize mb-1 block">{sev}</label>
                <input type="number" value={orgContext.sla_hours?.[sev] || ''} onChange={e => updateOrg('sla_hours', { ...orgContext.sla_hours, [sev]: parseInt(e.target.value) || 0 })}
                  className={`${inputCls} text-center`} />
              </div>
            ))}
          </div>
        </Field>

        <Field label="Team ownership (service → team)">
          <div className="flex gap-2 mb-2">
            <input type="text" value={newTeamSvc} onChange={e => setNewTeamSvc(e.target.value)} placeholder="Service name" className={`${inputCls} flex-1`} />
            <input type="text" value={newTeamName} onChange={e => setNewTeamName(e.target.value)} placeholder="Team name" className={`${inputCls} flex-1`} />
            <button onClick={addTeam} className={btnSm}><Plus size={14} /></button>
          </div>
          <div className="space-y-1">
            {Object.entries(orgContext.team_ownership || {}).map(([svc, team]) => (
              <div key={svc} className="flex items-center justify-between bg-surface rounded px-3 py-1.5 text-sm">
                <span className="text-white mono text-xs">{svc}</span>
                <span className="text-accent-2 text-xs">→ {team}</span>
                <button onClick={() => { const o = { ...orgContext.team_ownership }; delete o[svc]; updateOrg('team_ownership', o) }}>
                  <Trash2 size={12} className="text-muted hover:text-danger" />
                </button>
              </div>
            ))}
          </div>
        </Field>
      </Section>

      <div className="flex justify-end">
        <button onClick={() => navigate('/analyze')} className="flex items-center gap-2 bg-accent-2 text-surface font-medium px-6 py-2.5 rounded-lg hover:bg-accent-2/80 transition">
          Next: Analyze <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="bg-panel border border-border rounded-xl p-6 space-y-5">
      <h2 className="text-white font-medium text-sm uppercase tracking-widest text-muted">{title}</h2>
      {children}
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-sm text-muted mb-1.5 block">{label}</label>
      {children}
    </div>
  )
}

function Toggle({ label, value, onChange }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`flex items-center gap-3 p-3 rounded-lg border transition-all text-sm ${value ? 'border-accent-2/50 bg-accent-2/10 text-accent-2' : 'border-border text-muted hover:border-accent-2/30'}`}
    >
      <div className={`w-8 h-4 rounded-full transition-colors relative ${value ? 'bg-accent-2' : 'bg-border'}`}>
        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${value ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </div>
      {label}
    </button>
  )
}

const inputCls = 'w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent-2 placeholder:text-muted/50'
const btnSm = 'bg-accent-2/10 border border-accent-2/30 text-accent-2 text-sm px-3 py-2 rounded-lg hover:bg-accent-2/20 transition shrink-0'

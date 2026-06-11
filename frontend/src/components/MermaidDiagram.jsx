import React, { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    primaryColor: '#58a6ff',
    primaryTextColor: '#e6edf3',
    primaryBorderColor: '#30363d',
    lineColor: '#8b949e',
    secondaryColor: '#161b22',
    tertiaryColor: '#0d1117',
    background: '#0d1117',
    mainBkg: '#161b22',
    nodeBorder: '#30363d',
    clusterBkg: '#161b22',
    clusterBorder: '#30363d',
    titleColor: '#e6edf3',
    edgeLabelBackground: '#161b22',
  },
  flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
  securityLevel: 'loose',
})

let diagramId = 0

export default function MermaidDiagram({ chart, title }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!chart) return

    const id = `mermaid-${diagramId++}`

    const render = async () => {
      try {
        setError(false)
        let clean = chart.trim()
        if (clean.startsWith('```')) {
          clean = clean.replace(/^```(?:mermaid)?\n?/, '').replace(/\n?```$/, '')
        }
        // Fix common Claude issues: semicolons as line separators
        if (clean.includes(';') && !clean.includes('\n')) {
          clean = clean.replace(/;\s*/g, '\n')
        }
        const { svg: rendered } = await mermaid.render(id, clean)
        setSvg(rendered)
      } catch {
        setError(true)
      }
    }

    render()
  }, [chart])

  if (!chart) return null

  // Fallback: render as styled text-based diagram when Mermaid fails
  if (error) {
    return (
      <div className="bg-panel border border-border rounded-xl p-5">
        {title && <h3 className="text-white font-medium mb-4">{title}</h3>}
        <div className="bg-surface rounded-lg p-4 overflow-x-auto">
          <DiagramTextFallback chart={chart} />
        </div>
      </div>
    )
  }

  return (
    <div className="bg-panel border border-border rounded-xl p-5">
      {title && <h3 className="text-white font-medium mb-4">{title}</h3>}
      <div
        className="overflow-x-auto bg-surface rounded-lg p-4"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}

// Text-based fallback that parses Mermaid syntax into a visual representation
function DiagramTextFallback({ chart }) {
  const lines = chart.trim().split(/[;\n]/).map(l => l.trim()).filter(Boolean)
  
  // Extract nodes and edges from the mermaid syntax
  const nodes = []
  const edges = []

  for (const line of lines) {
    // Match edges like A-->B, A-->|label|B, A[text]-->B[text]
    const edgeMatch = line.match(/^(\w+)(?:\[([^\]]*)\])?\s*-+>(?:\|([^|]*)\|)?\s*(\w+)(?:\[([^\]]*)\])?/)
    if (edgeMatch) {
      const [, fromId, fromLabel, edgeLabel, toId, toLabel] = edgeMatch
      if (fromLabel && !nodes.find(n => n.id === fromId)) nodes.push({ id: fromId, label: fromLabel })
      if (toLabel && !nodes.find(n => n.id === toId)) nodes.push({ id: toId, label: toLabel })
      if (!nodes.find(n => n.id === fromId)) nodes.push({ id: fromId, label: fromId })
      if (!nodes.find(n => n.id === toId)) nodes.push({ id: toId, label: toId })
      edges.push({ from: fromId, to: toId, label: edgeLabel || '' })
    }
  }

  if (edges.length === 0) {
    // Can't parse — just show formatted text
    return (
      <pre className="text-xs text-muted whitespace-pre-wrap font-mono">{chart}</pre>
    )
  }

  return (
    <div className="space-y-2">
      {edges.map((edge, i) => {
        const fromNode = nodes.find(n => n.id === edge.from)
        const toNode = nodes.find(n => n.id === edge.to)
        return (
          <div key={i} className="flex items-center gap-2 text-sm">
            <span className="bg-accent-2/10 border border-accent-2/30 text-accent-2 px-3 py-1 rounded-lg text-xs font-medium">
              {fromNode?.label || edge.from}
            </span>
            <div className="flex items-center gap-1 text-muted">
              <span className="text-xs">→</span>
              {edge.label && <span className="text-xs italic text-warning">{edge.label}</span>}
              <span className="text-xs">→</span>
            </div>
            <span className="bg-accent-2/10 border border-accent-2/30 text-accent-2 px-3 py-1 rounded-lg text-xs font-medium">
              {toNode?.label || edge.to}
            </span>
          </div>
        )
      })}
    </div>
  )
}

import React, { useState } from 'react'

const EXPLOITABILITY_LEVELS = ['likely', 'possible', 'unlikely']
const IMPACT_LEVELS = ['critical', 'high', 'medium', 'low']

const CELL_COLORS = {
  'likely-critical': 'bg-red-600/80 border-red-500',
  'likely-high': 'bg-red-500/60 border-red-400',
  'likely-medium': 'bg-orange-500/60 border-orange-400',
  'likely-low': 'bg-yellow-500/40 border-yellow-400',
  'possible-critical': 'bg-red-500/60 border-red-400',
  'possible-high': 'bg-orange-500/60 border-orange-400',
  'possible-medium': 'bg-yellow-500/40 border-yellow-400',
  'possible-low': 'bg-green-500/30 border-green-400',
  'unlikely-critical': 'bg-orange-500/50 border-orange-400',
  'unlikely-high': 'bg-yellow-500/40 border-yellow-400',
  'unlikely-medium': 'bg-green-500/30 border-green-400',
  'unlikely-low': 'bg-green-500/20 border-green-400',
}

export default function RiskHeatmap({ riskMatrix }) {
  const [hoveredCell, setHoveredCell] = useState(null)

  if (!riskMatrix || riskMatrix.length === 0) return null

  // Group findings by exploitability x impact
  const grid = {}
  for (const item of riskMatrix) {
    const key = `${item.exploitability}-${item.impact}`
    if (!grid[key]) grid[key] = []
    grid[key].push(item)
  }

  return (
    <div className="bg-panel border border-border rounded-xl p-5">
      <h3 className="text-white font-medium mb-4">Risk heatmap — Exploitability vs Impact</h3>
      <div className="overflow-x-auto">
        <div className="min-w-[500px]">
          {/* Header row */}
          <div className="grid grid-cols-5 gap-1 mb-1">
            <div className="p-2" />
            {IMPACT_LEVELS.map(impact => (
              <div key={impact} className="text-center text-xs text-muted uppercase p-2">
                {impact}
              </div>
            ))}
          </div>

          {/* Data rows */}
          {EXPLOITABILITY_LEVELS.map(exploit => (
            <div key={exploit} className="grid grid-cols-5 gap-1 mb-1">
              <div className="flex items-center text-xs text-muted uppercase p-2 justify-end pr-3">
                {exploit}
              </div>
              {IMPACT_LEVELS.map(impact => {
                const key = `${exploit}-${impact}`
                const items = grid[key] || []
                const cellColor = CELL_COLORS[key] || 'bg-surface border-border'
                const isHovered = hoveredCell === key

                return (
                  <div
                    key={key}
                    className={`relative border rounded-lg p-2 min-h-[60px] flex flex-col items-center justify-center cursor-pointer transition-all ${cellColor} ${isHovered ? 'scale-105 ring-2 ring-accent-2' : ''}`}
                    onMouseEnter={() => setHoveredCell(key)}
                    onMouseLeave={() => setHoveredCell(null)}
                  >
                    {items.length > 0 ? (
                      <>
                        <span className="text-lg font-bold text-white">{items.length}</span>
                        <span className="text-[10px] text-white/70">
                          {items.length === 1 ? 'finding' : 'findings'}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-white/30">—</span>
                    )}

                    {/* Tooltip on hover */}
                    {isHovered && items.length > 0 && (
                      <div className="absolute z-50 bottom-full mb-2 left-1/2 -translate-x-1/2 bg-surface border border-border rounded-lg p-3 shadow-xl min-w-[200px] max-w-[280px]">
                        <p className="text-xs text-muted mb-1 uppercase">
                          {exploit} exploitability · {impact} impact
                        </p>
                        <ul className="space-y-1">
                          {items.slice(0, 5).map((item, i) => (
                            <li key={i} className="text-xs text-white truncate">
                              • {item.title || item.finding_id}
                            </li>
                          ))}
                          {items.length > 5 && (
                            <li className="text-xs text-muted">+{items.length - 5} more</li>
                          )}
                        </ul>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}

          {/* Axis labels */}
          <div className="flex justify-between mt-3 px-12">
            <span className="text-[10px] text-muted">← Lower impact</span>
            <span className="text-[10px] text-muted">Higher impact →</span>
          </div>
          <div className="text-center mt-1">
            <span className="text-[10px] text-muted">↑ Higher exploitability</span>
          </div>
        </div>
      </div>
    </div>
  )
}

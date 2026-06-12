import { SEVERITY_META, SEVERITIES } from './config.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function badge(severity) {
  const m = SEVERITY_META[severity] || SEVERITY_META.info;
  return `<span class="sev sev-${severity}">${esc(m.label)}</span>`;
}

function confBadge(c) {
  return `<span class="conf conf-${esc(c)}">${esc(c)} confidence</span>`;
}

function findingCard(f) {
  const lines = f.startLine
    ? (f.endLine && f.endLine !== f.startLine ? `L${f.startLine}–${f.endLine}` : `L${f.startLine}`)
    : '';
  const loc = f.source === 'architecture'
    ? `<span class="loc-arch">cross-file: ${esc((f.involvedFiles || []).join(', ') || '—')}</span>`
    : `<span class="loc-file">${esc(f.file || '—')}</span>${lines ? `<span class="loc-line">${esc(lines)}</span>` : ''}`;

  const tags = [
    f.cwe ? `<span class="tag">${esc(f.cwe)}</span>` : '',
    f.owasp ? `<span class="tag tag-owasp">${esc(f.owasp)}</span>` : '',
    `<span class="tag tag-cat">${esc(f.category)}</span>`,
    f.foundBy?.length ? `<span class="tag tag-model">${esc(f.foundBy.join(' + '))}</span>` : '',
  ].join('');

  const evidence = f.evidence
    ? `<div class="block"><div class="block-h">Evidence</div><pre class="code">${esc(f.evidence)}</pre></div>` : '';
  const blind = f.scannerBlindSpot
    ? `<div class="block blindspot"><div class="block-h">Why scanners miss this</div><p>${esc(f.scannerBlindSpot)}</p></div>` : '';

  return `
  <article class="finding" data-sev="${f.severity}" data-cat="${esc(f.category)}" data-conf="${f.confidence}" id="${esc(f.id)}">
    <header class="finding-h">
      <div class="finding-id">${esc(f.id)}</div>
      <div class="finding-title-wrap">
        <h3>${esc(f.title)}</h3>
        <div class="finding-meta">${badge(f.severity)} ${confBadge(f.confidence)} ${loc}</div>
      </div>
    </header>
    <div class="tags">${tags}</div>
    ${f.description ? `<div class="block"><div class="block-h">Description</div><p>${esc(f.description)}</p></div>` : ''}
    ${f.impact ? `<div class="block"><div class="block-h">Impact</div><p>${esc(f.impact)}</p></div>` : ''}
    ${f.attackScenario ? `<div class="block"><div class="block-h">Attack scenario</div><p>${esc(f.attackScenario)}</p></div>` : ''}
    ${evidence}
    ${f.recommendation ? `<div class="block remediation"><div class="block-h">Remediation</div><p>${esc(f.recommendation)}</p></div>` : ''}
    ${blind}
  </article>`;
}

export function renderReport({ findings, stats, meta }) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  const catCounts = {};
  for (const f of findings) catCounts[f.category] = (catCounts[f.category] || 0) + 1;
  const topCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);

  const total = findings.length;
  const riskScore = counts.critical * 10 + counts.high * 5 + counts.medium * 2 + counts.low * 1;
  const grade = riskScore === 0 ? 'A' : riskScore <= 5 ? 'B' : riskScore <= 20 ? 'C' : riskScore <= 50 ? 'D' : 'F';

  const sevBar = SEVERITIES.map((s) => {
    const n = counts[s];
    if (!n) return '';
    const pct = total ? (n / total) * 100 : 0;
    return `<span class="bar-seg bar-${s}" style="width:${pct}%" title="${SEVERITY_META[s].label}: ${n}"></span>`;
  }).join('');

  const statCards = SEVERITIES.map((s) =>
    `<div class="stat stat-${s}"><div class="stat-n">${counts[s]}</div><div class="stat-l">${SEVERITY_META[s].label}</div></div>`
  ).join('');

  const findingsHtml = total
    ? findings.map(findingCard).join('\n')
    : `<div class="empty">No security findings were reported. This does not guarantee the absence of vulnerabilities — it reflects the analysis performed by the configured models on the supplied code.</div>`;

  const catChips = topCats.map(([c, n]) =>
    `<button class="chip" data-filter-cat="${esc(c)}">${esc(c)} <b>${n}</b></button>`).join('');

  const modelList = meta.models.map((m) => `${esc(m.alias)} <span class="muted">(${esc(m.id)})</span>`).join(', ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Security Audit Report — ${esc(meta.target)}</title>
<style>
  :root{
    --bg:#0b0e14; --panel:#11161f; --panel-2:#161c28; --line:#222b3a;
    --ink:#e6edf3; --muted:#8b97a8; --accent:#5ad1c4; --accent-dim:#2a7a72;
    --crit:#ff5c6c; --high:#ff8a3d; --med:#e6c34a; --low:#5aa9e6; --info:#7e8a9c;
    --mono:'SFMono-Regular',ui-monospace,'JetBrains Mono','Cascadia Code',Menlo,Consolas,monospace;
    --sans:'Inter',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.55;font-size:15px}
  a{color:var(--accent)}
  .muted{color:var(--muted)}
  .wrap{max-width:1080px;margin:0 auto;padding:0 24px}

  header.top{border-bottom:1px solid var(--line);background:linear-gradient(180deg,#0d1119,#0b0e14)}
  .top-inner{padding:34px 0 26px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap}
  .brand{font-family:var(--mono);font-size:13px;letter-spacing:.18em;color:var(--accent);text-transform:uppercase}
  h1{margin:6px 0 4px;font-size:27px;font-weight:650;letter-spacing:-.01em}
  .sub{color:var(--muted);font-family:var(--mono);font-size:13px}
  .grade{display:flex;flex-direction:column;align-items:center;font-family:var(--mono)}
  .grade-letter{font-size:54px;font-weight:700;line-height:1;color:var(--accent)}
  .grade-letter.g-C{color:var(--med)} .grade-letter.g-D{color:var(--high)} .grade-letter.g-F{color:var(--crit)}
  .grade-l{font-size:11px;letter-spacing:.15em;color:var(--muted);text-transform:uppercase;margin-top:6px}

  section{padding:30px 0}
  .stats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;text-align:center}
  .stat-n{font-family:var(--mono);font-size:30px;font-weight:700}
  .stat-l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-top:4px}
  .stat-critical .stat-n{color:var(--crit)} .stat-high .stat-n{color:var(--high)}
  .stat-medium .stat-n{color:var(--med)} .stat-low .stat-n{color:var(--low)} .stat-info .stat-n{color:var(--info)}

  .bar{display:flex;height:10px;border-radius:6px;overflow:hidden;margin:22px 0 8px;background:var(--panel-2);border:1px solid var(--line)}
  .bar-seg{display:block;height:100%}
  .bar-critical{background:var(--crit)} .bar-high{background:var(--high)}
  .bar-medium{background:var(--med)} .bar-low{background:var(--low)} .bar-info{background:var(--info)}

  .meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .meta-cell{background:var(--panel);padding:14px 16px}
  .meta-cell .k{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
  .meta-cell .v{font-family:var(--mono);font-size:13px;margin-top:4px;word-break:break-word}

  .toolbar{position:sticky;top:0;z-index:5;background:rgba(11,14,20,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:12px 0;margin-bottom:20px}
  .toolbar-inner{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .filter-btn,.chip{font-family:var(--mono);font-size:12px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:20px;padding:6px 13px;cursor:pointer;transition:.15s}
  .filter-btn:hover,.chip:hover{border-color:var(--accent)}
  .filter-btn.active{background:var(--accent-dim);border-color:var(--accent);color:#fff}
  .chip b{color:var(--accent)}
  .toolbar .sp{flex:1}
  #search{font-family:var(--mono);font-size:13px;background:var(--panel-2);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:7px 11px;min-width:200px}

  .finding{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--info);border-radius:12px;padding:20px 22px;margin-bottom:16px}
  .finding[data-sev=critical]{border-left-color:var(--crit)}
  .finding[data-sev=high]{border-left-color:var(--high)}
  .finding[data-sev=medium]{border-left-color:var(--med)}
  .finding[data-sev=low]{border-left-color:var(--low)}
  .finding-h{display:flex;gap:14px;align-items:flex-start}
  .finding-id{font-family:var(--mono);font-size:12px;color:var(--muted);background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:3px 8px;margin-top:3px;white-space:nowrap}
  .finding-title-wrap h3{margin:0;font-size:18px;font-weight:600}
  .finding-meta{margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-family:var(--mono);font-size:12px}
  .sev{font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 9px;border-radius:5px;font-size:11px}
  .sev-critical{background:rgba(255,92,108,.16);color:var(--crit)}
  .sev-high{background:rgba(255,138,61,.16);color:var(--high)}
  .sev-medium{background:rgba(230,195,74,.16);color:var(--med)}
  .sev-low{background:rgba(90,169,230,.16);color:var(--low)}
  .sev-info{background:rgba(126,138,156,.16);color:var(--info)}
  .conf{color:var(--muted)}
  .loc-file,.loc-arch{color:var(--accent)} .loc-line{color:var(--muted);margin-left:6px}
  .tags{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0 4px}
  .tag{font-family:var(--mono);font-size:11px;color:var(--muted);background:var(--panel-2);border:1px solid var(--line);border-radius:5px;padding:2px 8px}
  .tag-owasp{color:var(--high)} .tag-cat{color:var(--accent)} .tag-model{color:var(--low)}
  .block{margin-top:14px}
  .block-h{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:5px;font-family:var(--mono)}
  .block p{margin:0;color:#cfd8e3}
  pre.code{font-family:var(--mono);font-size:12.5px;background:#0a0d13;border:1px solid var(--line);border-radius:8px;padding:13px 15px;overflow:auto;color:#d6e0ec;white-space:pre-wrap;word-break:break-word}
  .remediation{background:rgba(90,209,196,.06);border:1px solid var(--accent-dim);border-radius:8px;padding:12px 14px}
  .remediation .block-h{color:var(--accent)}
  .blindspot{background:rgba(255,138,61,.05);border:1px solid rgba(255,138,61,.25);border-radius:8px;padding:12px 14px}
  .blindspot .block-h{color:var(--high)}
  .empty{background:var(--panel);border:1px dashed var(--line);border-radius:12px;padding:40px;text-align:center;color:var(--muted)}

  footer{border-top:1px solid var(--line);padding:24px 0 50px;color:var(--muted);font-size:13px}
  .disclaimer{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;font-size:13px;color:var(--muted);margin-top:16px}
  .hidden{display:none !important}
  h2.sh{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-family:var(--mono);margin:0 0 16px;font-weight:600}
  @media(max-width:680px){.stats{grid-template-columns:repeat(2,1fr)}.top-inner{flex-direction:column;align-items:flex-start}}
</style>
</head>
<body>
<header class="top">
  <div class="wrap top-inner">
    <div>
      <div class="brand">// claude-secaudit · deep code review</div>
      <h1>Security Audit Report</h1>
      <div class="sub">${esc(meta.target)} · ${esc(meta.generatedAt)}</div>
    </div>
    <div class="grade">
      <div class="grade-letter g-${grade}">${grade}</div>
      <div class="grade-l">risk grade</div>
    </div>
  </div>
</header>

<div class="wrap">
  <section>
    <div class="stats">${statCards}</div>
    <div class="bar">${sevBar || '<span class="bar-seg bar-info" style="width:100%"></span>'}</div>
    <div class="muted" style="font-family:var(--mono);font-size:12px">${total} findings · risk score ${riskScore} · ${stats.architectureFindings} cross-file</div>
  </section>

  <section>
    <h2 class="sh">Scope &amp; configuration</h2>
    <div class="meta-grid">
      <div class="meta-cell"><div class="k">Target</div><div class="v">${esc(meta.target)}</div></div>
      <div class="meta-cell"><div class="k">Files analyzed</div><div class="v">${stats.filesAnalyzed}</div></div>
      <div class="meta-cell"><div class="k">Analysis units</div><div class="v">${stats.units}</div></div>
      <div class="meta-cell"><div class="k">Models</div><div class="v">${modelList}</div></div>
      <div class="meta-cell"><div class="k">Region</div><div class="v">${esc(meta.region)}</div></div>
      <div class="meta-cell"><div class="k">Duration</div><div class="v">${esc(meta.duration)}</div></div>
      <div class="meta-cell"><div class="k">Tokens (in / out)</div><div class="v">${meta.usage.inputTokens.toLocaleString()} / ${meta.usage.outputTokens.toLocaleString()}</div></div>
      <div class="meta-cell"><div class="k">Tool version</div><div class="v">${esc(meta.version)}</div></div>
    </div>
  </section>

  <section>
    <h2 class="sh">Findings</h2>
    <div class="toolbar">
      <div class="toolbar-inner">
        <button class="filter-btn active" data-filter-sev="all">All</button>
        <button class="filter-btn" data-filter-sev="critical">Critical</button>
        <button class="filter-btn" data-filter-sev="high">High</button>
        <button class="filter-btn" data-filter-sev="medium">Medium</button>
        <button class="filter-btn" data-filter-sev="low">Low</button>
        <button class="filter-btn" data-filter-sev="info">Info</button>
        <div class="sp"></div>
        <input id="search" type="search" placeholder="filter text…" autocomplete="off">
      </div>
      ${catChips ? `<div class="toolbar-inner" style="margin-top:8px">${catChips}<button class="chip" data-filter-cat="all"><b>clear</b></button></div>` : ''}
    </div>
    <div id="findings">
      ${findingsHtml}
    </div>
  </section>

  <footer>
    <div>Generated by <b>claude-secaudit</b> v${esc(meta.version)} using Anthropic Claude models on AWS Bedrock.</div>
    <div class="disclaimer">
      This report is an AI-assisted manual-style code review intended to complement, not replace, SAST, DAST, dependency scanning, and human penetration testing. AI analysis can produce both false positives and false negatives — every finding should be validated by a qualified security engineer before remediation or risk acceptance. The absence of a finding is not evidence of security.
    </div>
  </footer>
</div>

<script>
(function(){
  var sevFilter='all', catFilter='all', q='';
  var cards=[].slice.call(document.querySelectorAll('.finding'));
  function apply(){
    q=(document.getElementById('search').value||'').toLowerCase();
    cards.forEach(function(c){
      var okSev=sevFilter==='all'||c.dataset.sev===sevFilter;
      var okCat=catFilter==='all'||c.dataset.cat===catFilter;
      var okQ=!q||c.textContent.toLowerCase().indexOf(q)>-1;
      c.classList.toggle('hidden',!(okSev&&okCat&&okQ));
    });
  }
  document.querySelectorAll('[data-filter-sev]').forEach(function(b){
    b.addEventListener('click',function(){
      document.querySelectorAll('[data-filter-sev]').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active'); sevFilter=b.dataset.filterSev; apply();
    });
  });
  document.querySelectorAll('[data-filter-cat]').forEach(function(b){
    b.addEventListener('click',function(){ catFilter=b.dataset.filterCat; apply(); });
  });
  document.getElementById('search').addEventListener('input',apply);
})();
</script>
</body>
</html>`;
}

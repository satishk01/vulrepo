# UEM CLI Analysis — Run big scans offline, view them in the dashboard

## Why this exists

The web upload flow (`POST /upload/multi`) runs the AI risk analysis in **one
Bedrock call** whose output is capped by `BEDROCK_ANALYSIS_MAX_TOKENS` (16384).

- With **2 files / 6–8 findings**, the full JSON (each finding carries a complete
  remediation block) fits → the dashboard works.
- With **more files / 20+ findings**, the JSON response is **truncated
  mid-object** → it can't be parsed → the analysis is stored as a raw string →
  the dashboard finds no `executive_summary` and renders blank.

That looks like "an API issue," but it's really **output-token truncation**.

> **The web UI is now fixed too.** The same batching is wired into the backend
> analysis endpoints (`/upload/multi`, `/analyze`, GitHub/zip/pen-test scans), so
> uploading 22 findings in the UI now works exactly like the CLI — no truncation,
> same dashboard. See **"Two ways to run"** below.

## Two ways to run

You now have **both** options, sharing the same batching code
(`src/batchAnalyzer.js → runScanAnalysis`):

1. **Web UI** — upload files on the Upload page as usual. Behind the scenes the
   backend uses the original single call for small sets and automatically
   switches to batched analysis above `ANALYSIS_BATCH_SIZE` (default 8). Nothing
   to configure; large scans just work now.
2. **CLI** — for very large/batch jobs, or to pre-compute scans without keeping a
   browser tab open. Steps below.

Both write the identical analysis shape to the same storage, so the dashboard is
the same either way. `ANALYSIS_BATCH_SIZE` (in `.env`) tunes both paths.

The **CLI fixes it** by analysing findings in **small batches that never
truncate**, then **merging** the batches into a single, complete analysis object
with the **exact same shape and the exact same features** as the small-scan case
(risk scores, per-finding remediation steps, code examples, references, attack
paths, compliance gaps, risk matrix, Mermaid diagrams, executive summary).

It writes results into the **same local storage the dashboard already reads**, so
the front end renders a pre-computed scan with **no API timeouts and zero loss of
features.**

```
  files ─▶ CLI ─▶ normalize (same modules as the web app)
                 └▶ AI analysis in batches of 8  ──▶ merge ──▶ analysis.json
                                                                    │
   local backend (STORAGE_BACKEND=local) ◀── reads scans/<id>/ ◀────┘
                    │
   front end /dashboard/<scanId>  ◀── GET /scans/<id>
```

---

## One-time setup

You need **Node.js 18+**. From the `backend-node/` folder:

```bash
cd backend-node
npm install
cp .env.local.example .env        # Windows:  copy .env.local.example .env
```

Open `.env` and set:

- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN` if temporary)
- `AWS_REGION` (default `us-east-1`)
- `LOCAL_STORAGE_DIR` — where scans are written/read. Default `./uem-data`.
  **The CLI and the backend must use the same value.**

> The CLI uses the **same Bedrock model access** the web app already uses. If the
> web app could analyse 2 files, the CLI is ready to go.

---

## Step 1 — Put your files in one folder

Drop every scanner output / pen-test report into a folder, e.g. `./reports`:

```
reports/
├── snyk-prod.json
├── semgrep-api.sarif
├── trivy-image.json
├── dependency-check.csv
└── pentest-q2.pdf
```

Supported per-file types (auto-detected, identical to the web upload):

- **Structured:** `.json` `.sarif` `.csv` `.xml`
- **Pen-test / docs:** `.md` `.txt` `.pdf` `.html` `.htm` `.doc` `.docx`
- `.xlsx`/`.xls` are skipped — export them as CSV first.

## Step 2 — Run the CLI

**macOS / Linux**
```bash
cd backend-node
./run-cli.sh ./reports
```

**Windows**
```bat
cd backend-node
run-cli.bat .\reports
```

**Or directly (any OS):**
```bash
node src/cli/analyze-cli.js --input ./reports --storage-dir ./uem-data
```

You'll see per-file progress, then batched analysis, then:

```
✓ Scan ready.

  Scan ID       : 7f3c…-…-…
  Storage dir   : /…/uem-data
  Dashboard URL : http://localhost:3000/dashboard/7f3c…
  Scan detail   : http://localhost:3000/scans/7f3c…
```

Copy that **Scan ID** / Dashboard URL.

## Step 3 — Start the backend in local mode

In a new terminal, from `backend-node/`:

**macOS / Linux**
```bash
./run-backend-local.sh
```

**Windows**
```bat
run-backend-local.bat
```

This serves `http://localhost:8000` and reads scans from your `LOCAL_STORAGE_DIR`.

## Step 4 — Start the front end

In another terminal, from `frontend/`:

```bash
cd frontend
npm install        # first time only
npm run dev
```

It runs on `http://localhost:3000` and proxies `/api` → the backend on `:8000`.

## Step 5 — Open the dashboard

- Go to the **Dashboard URL** the CLI printed, **or**
- Open `http://localhost:3000/scans`, click your scan, then **Dashboard**.

You get the full dashboard — severity distribution, top risk scores, findings by
owner, compliance gaps, attack-path scenarios, architecture/attack-flow diagrams,
the CISO top-risk briefing, and the full per-finding remediation plan.

---

## Options

| Option | Default | Description |
|---|---|---|
| `--input`, `-i` | — | Folder or file. **Repeatable.** Required. |
| `--storage-dir` | `./uem-data` | Storage root. Must match the backend's `LOCAL_STORAGE_DIR`. |
| `--model`, `-m` | `anthropic.claude-sonnet-4-5` | Or `anthropic.claude-opus-4-5`. |
| `--batch-size` | `8` | Findings per AI call. Lower it if a batch ever fails to parse. |
| `--no-analysis` | off | Ingest + normalize only; skip AI. Useful for a quick dry run (no AWS needed). |
| `--asset-context` | `{}` | Inline JSON or `@path/to/file.json`. |
| `--org-context` | `{}` | Inline JSON or `@path/to/file.json`. |
| `--scan-id` | random UUID | Pin a fixed scan id. |
| `--max-findings` | `2000` | Cap total findings. |

### Examples

Deep analysis with Opus and smaller batches:
```bash
node src/cli/analyze-cli.js -i ./reports -m anthropic.claude-opus-4-5 --batch-size 6
```

With business context so risk scoring is sharper:
```bash
node src/cli/analyze-cli.js -i ./reports \
  --asset-context '{"service_name":"payments-api","internet_facing":true,"handles_payments":true,"criticality":"high"}' \
  --org-context @org.json
```

Dry run (no AWS, just see how many findings parse out of each file):
```bash
node src/cli/analyze-cli.js -i ./reports --no-analysis
```

Multiple input folders into one scan:
```bash
node src/cli/analyze-cli.js -i ./sast -i ./dast -i ./pentests
```

---

## How "no feature loss" is guaranteed

The CLI **imports the very same backend modules** the web app uses:

- `normalizer.js` — structured scanner parsing
- `pentestParser.js` — `extractText` + `extractFindingsFromText` + `toNormalized`
- `promptTemplates.js` — `buildAnalysisPrompt` (the identical analysis prompt)
- `bedrockClient.js` — the same model invocation
- `persistence/localRepository.js` — the identical on-disk layout

The only thing that changes is **batching + a deterministic merge**:

- Severity counts are **recomputed** from all findings (not a single batch's view).
- `priority_rank` is **re-ranked globally** by risk score (1 = most urgent overall).
- `risk_matrix` gets **one entry per finding** (built deterministically, never truncated).
- `attack_paths` and `compliance_gaps` from every batch are merged and de-duplicated.
- One small **synthesis pass** over a compact view of all findings produces the
  org-wide `top_risk`, recommended actions, and the two Mermaid diagrams — the
  parts that must reason across the whole set.

The resulting `analysis.json` has the same keys the dashboard already reads, so
nothing in the front end changes.

---

## Troubleshooting

**"No analysis yet" on the dashboard**
The backend isn't pointed at the folder the CLI wrote to. Confirm the backend's
`LOCAL_STORAGE_DIR` equals the CLI's `--storage-dir`, and that `STORAGE_BACKEND=local`
(the `run-backend-local` scripts force this).

**A batch failed to parse**
Re-run with a smaller `--batch-size` (e.g. `5`). Already-saved findings are kept.

**Bedrock auth / region errors**
Check the AWS keys and `AWS_REGION` in `.env`. Use the same account that has the
two Claude models enabled in Bedrock.

**PDF/DOCX produced 0 findings**
Scanned/image PDFs have no extractable text. Use a text-based export or paste the
findings into a `.md`/`.txt` file.

**Want to serve to a different front-end port**
The front end runs on `:3000` by default (see `frontend/vite.config.js`). Adjust
the printed URL accordingly if you change it.

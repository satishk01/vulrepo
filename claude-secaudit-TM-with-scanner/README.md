# claude-secaudit v3 — AI + non-LLM scanners, BYOK + BYOT

**Deep AI-powered security code review for any codebase — run locally, point it at a folder, get a production-quality HTML report. Now works across many AI providers, with your own keys.**

`claude-secaudit` performs a manual-style, adversarial security review of your source code. It is deliberately tuned to surface the **logic-level and architectural vulnerabilities that SAST and DAST scanners systematically miss** — broken access control, IDOR, business-logic flaws, auth/session bugs, multi-hop injection, crypto misuse, secrets, SSRF, and cross-file design weaknesses.

Version 2 keeps the original **AWS Bedrock** path intact and adds a provider abstraction so you can run the same review on:

| Provider | Example aliases | Credential (BYOK) |
|---|---|---|
| **AWS Bedrock** (retained) | `bedrock-sonnet-4.5`, `bedrock-opus-4.7`, `bedrock-opus-4.8` | AWS credential chain / profile |
| **Anthropic API** (direct) | `opus-4.8`, `opus-4.7`, `anthropic-4.5` | `ANTHROPIC_API_KEY` |
| **Google Gemini** (direct) | `gemini-3.5`, `gemini-3.5-flash` | `GOOGLE_API_KEY` |
| **Google Vertex AI** (GCP) | `vertex-gemini-3.5` | `GOOGLE_VERTEX_ACCESS_TOKEN` + project |
| **OpenRouter** | `glm-5.2-or`, `anthropic-4.5-or`, `gemini-3.5-or`, `opus-4.8-or` | `OPENROUTER_API_KEY` |
| **Azure OpenAI** | `azure-gpt4`, `azure-gpt5.5` | `AZURE_OPENAI_API_KEY` + endpoint |
| **Ollama** (local) | `ollama-qwen`, `ollama-llama` | none (local server) |

You can **switch providers/models per run** with `-m`, and **mix providers in a single run** for cross-provider consensus (overlapping findings are merged and labelled with the models that reported them).

> **BYOK = Bring Your Own Key.** No credentials are stored in the tool or the config file. Every provider reads its secret from an **environment variable** you set. Your code never leaves your machine except as prompt content sent to the provider(s) **you** choose.

---

## Requirements

- **Node.js 18+** (uses the built-in `fetch`; no extra HTTP dependency). Node 20+ recommended.
- Credentials for whichever provider(s) you intend to use (see **Credentials (BYOK)** below).
- For Bedrock: an AWS account with Bedrock model access enabled.
- For Ollama: a running local Ollama server with the model pulled.

---

## Install

```bash
# from the unzipped project folder
npm install
```

That installs the one runtime dependency set (AWS SDK for the Bedrock path, plus the CLI/glob helpers). All non-Bedrock providers use Node's built-in `fetch`, so there is nothing else to install.

Optional — make `secaudit` available as a global command:

```bash
npm link        # then you can run `secaudit ...` anywhere
```

Otherwise run it as `node bin/secaudit.js ...` (Windows: `node bin\secaudit.js ...`).

---

## Quick start

```bash
# 1. See every built-in model alias and which provider it uses
node bin/secaudit.js --list-models

# 2. Dry run — lists what WOULD be scanned, spends $0, makes no API calls
node bin/secaudit.js ./my-app --dry-run

# 3. Pick a provider/model and scan
ANTHROPIC_API_KEY=sk-ant-...  node bin/secaudit.js ./my-app -m opus-4.8
```

The report is written to `secaudit-report/report.html` (or your `-o` folder). Open it in any browser. A machine-readable `findings.json` is written alongside it.

---

## Credentials (BYOK)

Set the environment variable(s) for the provider(s) you select with `-m`. Only the providers you actually use are required — the tool checks this up front and prints a clear error if a key is missing.

### AWS Bedrock — `bedrock-*` aliases
Uses the standard AWS credential chain (env vars, shared config/SSO, or an IAM role).
```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1
# or a named profile:
node bin/secaudit.js ./app -m bedrock-opus-4.8 -p my-profile -r us-east-1
```
Enable model access in the Bedrock console first. Verify exact model IDs in your account:
```bash
aws bedrock list-foundation-models --by-provider anthropic --query "modelSummaries[].modelId"
aws bedrock list-inference-profiles --query "inferenceProfileSummaries[].inferenceProfileId"
```

### Anthropic API (direct) — `opus-4.8`, `opus-4.7`, `anthropic-4.5`
```bash
export ANTHROPIC_API_KEY=sk-ant-...
# optional, for a gateway/proxy (e.g. LiteLLM passthrough):
export ANTHROPIC_BASE_URL=https://api.anthropic.com
```

### Google Gemini (direct) — `gemini-3.5`, `gemini-3.5-flash`
```bash
export GOOGLE_API_KEY=...        # or GEMINI_API_KEY
```

### Google Vertex AI (GCP) — `vertex-gemini-3.5`
```bash
export GOOGLE_VERTEX_ACCESS_TOKEN="$(gcloud auth print-access-token)"
export GOOGLE_CLOUD_PROJECT=my-gcp-project
export GOOGLE_CLOUD_LOCATION=us-central1     # optional, defaults to us-central1
```
(The access token is short-lived; re-export it before long sessions.)

### OpenRouter — `glm-5.2-or`, `anthropic-4.5-or`, `gemini-3.5-or`, `opus-4.8-or`
```bash
export OPENROUTER_API_KEY=sk-or-...
```
OpenRouter is a unified gateway — one key reaches GLM 5.2, Claude, Gemini, and many others.

### Azure OpenAI — `azure-gpt4`, `azure-gpt5.5`
```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_ENDPOINT=https://my-resource.openai.azure.com
export AZURE_OPENAI_API_VERSION=2024-10-21    # optional
```
> **Important:** for Azure, the alias's `modelId` is your **deployment name**, not a public model name. The built-in `azure-gpt4` / `azure-gpt5.5` assume deployments literally named `gpt-4` / `gpt-5.5`. If yours differ, override them in `secaudit.config.json`.

### Ollama (local) — `ollama-qwen`, `ollama-llama`
```bash
export OLLAMA_HOST=http://localhost:11434     # optional, this is the default
ollama pull qwen2.5-coder:32b                 # make sure the model exists
```
No API key. Everything stays on your machine.

---

## Switching providers & models

The `-m` flag takes a comma-separated list of aliases (or `provider:modelId` strings). Each entry is routed to its own provider, so a single run can span several providers.

```bash
# Bedrock (original behaviour, unchanged)
node bin/secaudit.js ./app -m bedrock-sonnet-4.5

# Anthropic API — Opus 4.8
node bin/secaudit.js ./app -m opus-4.8

# Google Gemini 3.5 direct
node bin/secaudit.js ./app -m gemini-3.5

# OpenRouter: GLM 5.2 + Claude 4.5 + Gemini 3.5 in ONE run
node bin/secaudit.js ./app -m glm-5.2-or,anthropic-4.5-or,gemini-3.5-or

# Azure OpenAI GPT-4 and GPT-5.5
node bin/secaudit.js ./app -m azure-gpt4,azure-gpt5.5

# Local Ollama — no cloud, no key
node bin/secaudit.js ./app -m ollama-qwen

# Mix providers for cross-provider consensus
node bin/secaudit.js ./app -m bedrock-opus-4.8,gemini-3.5,glm-5.2-or

# Any model by raw id:  provider:modelId
node bin/secaudit.js ./app -m "openrouter:z-ai/glm-5.2"
node bin/secaudit.js ./app -m "anthropic:claude-opus-4-8"
```

When multiple models are supplied, the **deepest available** model (an Opus or Fable alias, else the first) runs the cross-file architecture pass.

Run `node bin/secaudit.js --list-models` any time to print the full registry.

---

## Non-LLM scanners (the `--mode` switch)

In addition to the AI review, v3 can run established **open-source, non-LLM security scanners** and merge their results into the same report. This gives you the deterministic, well-understood coverage that production deployment gates expect, alongside the AI's logic-level findings.

Choose what runs with `--mode`:

| Mode | What runs | API key needed? |
|---|---|---|
| `llm` (default) | AI models only | Yes (one provider) |
| `scanners` | Non-LLM scanners only | **No** |
| `both` | AI + scanners, merged | Yes (one provider) |

```bash
# Scanners only — no API key, great as a production deployment check
secaudit ./my-app --mode scanners

# Only specific scanners
secaudit ./my-app --mode scanners -s semgrep,gitleaks,trivy

# Everything, merged into one report (most comprehensive)
secaudit ./my-app --mode both -m opus-4.8

# See all supported scanners + install hints
secaudit --list-scanners
```

### Supported scanners (BYOT — bring your own tools)

The tool **calls scanners you install on your system**; it does not bundle them (each has its own license and platform binaries). Install only the ones you want — missing tools are detected and skipped, with an install hint printed.

| Scanner | Category | Covers | Install |
|---|---|---|---|
| **Semgrep** | SAST | 30+ languages | `pip install semgrep` |
| **Bandit** | SAST | Python | `pip install bandit` |
| **gosec** | SAST | Go | `go install github.com/securego/gosec/v2/cmd/gosec@latest` |
| **Gitleaks** | Secrets | Hardcoded credentials | `brew install gitleaks` |
| **Trivy** | SCA + IaC + secrets | Dependency CVEs, misconfig | `brew install trivy` |
| **OSV-Scanner** | SCA | Dependency CVEs from lockfiles | `go install github.com/google/osv-scanner/cmd/osv-scanner@latest` |
| **Checkov** | IaC | Terraform/K8s/CloudFormation/Helm/Dockerfile | `pip install checkov` |

A quick way to get a strong stack: `pip install semgrep bandit checkov` plus `brew install gitleaks trivy` (or your OS's package manager / release binaries).

### How results combine

All findings — from every AI model and every scanner — flow into one deduplicated, severity-sorted report. Each finding is tagged with its source:

- **AI** — found only by an AI model
- **scanner** — found only by a non-LLM scanner (tagged with which one, e.g. `semgrep`, `trivy`)
- **AI + scanner** (`corroborated`) — the same issue was independently reported by both. These are your highest-confidence findings.

The `foundBy` field lists every model and tool that reported each finding.

### Semgrep rules note

Semgrep needs a ruleset. By default the tool runs `--config p/default`, which Semgrep fetches from its registry (and caches). In a fully offline/air-gapped environment, point it at local rules instead:

```bash
export SECAUDIT_SEMGREP_CONFIG=/path/to/rules.yml   # or a local rules dir
# or log in once to enable the hosted registry:  semgrep login
```

If Semgrep can't load rules, the tool reports that clearly rather than showing a misleading "clean" result.

---

## Overriding / adding models (`secaudit.config.json`)

Drop a `secaudit.config.json` in your working directory to add aliases or correct model IDs **without editing code**. See `secaudit.config.example.json`. Each value is `{ "provider": "...", "modelId": "..." }` (or a `"provider:modelId"` string).

```json
{
  "models": {
    "opus-4.8":   { "provider": "anthropic", "modelId": "claude-opus-4-8" },
    "azure-gpt4": { "provider": "azure", "modelId": "my-actual-gpt4-deployment" },
    "house-glm":  { "provider": "openrouter", "modelId": "z-ai/glm-5.2" }
  },
  "analysis": { "concurrency": 4, "maxTokensPerResponse": 8192 }
}
```

User-config aliases take precedence over the built-ins, so this is also how you pin exact version strings for your account/region.

---

## Usage

```
secaudit <directory> [options]
```

| Option | Description | Default |
|---|---|---|
| `<directory>` | Folder to scan (required, except with `--list-models`/`--list-scanners`) | — |
| `--mode <mode>` | Which engines run: `llm` \| `scanners` \| `both` | `llm` |
| `-m, --models <list>` | Comma-separated aliases or `provider:modelId`. See `--list-models`. | `bedrock-sonnet-4.5` |
| `-s, --scanners <list>` | Comma-separated scanners (default: all). See `--list-scanners`. | all |
| `--list-models` | Print all built-in aliases + providers, then exit | — |
| `--list-scanners` | Print all supported scanners + install hints, then exit | — |
| `-r, --region <region>` | AWS region (**Bedrock only**) | `us-east-1` (or `$AWS_REGION`) |
| `-p, --profile <name>` | AWS named profile (**Bedrock only**) | default credential chain |
| `-o, --out <dir>` | Output directory | `secaudit-report` |
| `-c, --concurrency <n>` | Parallel model requests | `4` |
| `--include <globs>` | Comma-separated include globs | all source files |
| `--exclude <globs>` | Extra ignore globs (added to defaults + `.gitignore`) | — |
| `--max-files <n>` | Cap files analyzed (good for trials) | — |
| `--dry-run` | List files that would be scanned, then exit. **No API calls.** | — |
| `-V, --verbose` | Log every file/model request as it starts/finishes | — |
| `-q, --quiet` | Suppress progress output | — |
| `-v, --version` | Print version | — |

### More examples
```bash
# Limit a first trial to 25 files to gauge cost/time
node bin/secaudit.js ./app --max-files 25 -m gemini-3.5

# Only scan the backend, skip generated code
node bin/secaudit.js ./repo --include "server/**,api/**" --exclude "**/generated/**" -m opus-4.8

# Sonnet per-file + Opus architecture pass, on Bedrock
node bin/secaudit.js ./repo -m bedrock-sonnet-4.5,bedrock-opus-4.8
```

---

## What it does

- **Point at a folder.** Recursively discovers source files (40+ languages/config types), respects `.gitignore`, skips vendored/binary/build output.
- **Deep per-file review** with one or more models, biased toward what scanners miss.
- **Cross-file architecture pass** correlating per-file summaries to find systemic issues.
- **Multi-model / multi-provider consensus.** Overlapping findings merged and labelled with which models reported them.
- **Self-contained HTML report** with interactive filtering by severity/category, CWE/OWASP tags, attack scenarios, remediation, and a "why scanners miss this" callout per finding. Plus machine-readable `findings.json`.
- **Runs locally.** Only prompt content (your code) goes to the provider you select.

---

## How it works (architecture)

```
bin/secaudit.js            CLI (flags, --list-models)
src/index.js               orchestration, report writing
src/walker.js              file discovery + chunking
src/analyzer.js            per-file + cross-file passes, dedupe, scoring
src/prompts.js             security-review prompt engineering
src/report.js              HTML report
src/config.js              defaults + user-config loader
src/providers/
  registry.js              alias -> { provider, modelId } resolution
  factory.js               MultiProviderClient: routes converse() per provider,
                           lazy provider init, credential preflight, usage rollup
  base.js                  shared retry/backoff, fetch helper, JSON extraction
  bedrock.js               AWS Bedrock (Converse API)
  anthropic.js             Anthropic Messages API
  google.js                Gemini direct + Vertex AI (generateContent)
  openai-compat.js         OpenRouter, Azure OpenAI, Ollama (chat/completions)
```

Every provider exposes the **same** `converse({ provider, modelId, system, userText, maxTokens, temperature })` contract, so the analysis engine is provider-agnostic. Adding a new provider is a single small file plus a registry entry.

---

## Troubleshooting

- **"Missing credentials/config for selected providers"** — set the env var(s) listed in the error for each provider you selected.
- **Bedrock `AccessDenied` / `UnrecognizedClient`** — credentials/region/profile issue, or model access not enabled in the Bedrock console.
- **"model not found" / 404** — the model ID isn't valid for that provider/account. For Azure, confirm the **deployment name**. For Bedrock, list models. Override in `secaudit.config.json`.
- **Azure 401** — check `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_VERSION`.
- **Vertex 401** — your access token expired; re-run `gcloud auth print-access-token`.
- **Ollama connection refused** — start the server (`ollama serve`) and confirm `OLLAMA_HOST`.
- Set `SECAUDIT_DEBUG=1` to print full stack traces.

---

## License

MIT. See `LICENSE`.

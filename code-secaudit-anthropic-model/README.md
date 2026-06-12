# claude-secaudit

**Deep AI-powered security code review for any codebase — run locally, point it at a folder, get a production-quality HTML report.**

`claude-secaudit` performs a manual-style, adversarial security review of your source code using Anthropic's Claude models on **AWS Bedrock** (Sonnet 4.5, Opus, Fable 5, or any Bedrock model you enable). It is deliberately tuned to surface the **logic-level and architectural vulnerabilities that SAST and DAST scanners systematically miss** — broken access control, IDOR, business-logic flaws, auth/session bugs, multi-hop injection, crypto misuse, secrets, SSRF, and cross-file design weaknesses.

It is **security-focused only** — it does not produce business analysis, code-quality nags, or style commentary.

---

## What it does

- 📁 **Point at a folder.** It recursively discovers source files (40+ languages/config types), respects `.gitignore`, and skips vendored/binary/build output.
- 🧠 **Deep per-file review** with one or more Claude models, biased toward what scanners miss.
- 🏛️ **Cross-file architecture pass** that correlates per-file summaries to find systemic issues (inconsistent authorization across endpoints, trust-boundary violations, missing defense-in-depth).
- 🔀 **Multi-model consensus.** Run several models; overlapping findings are merged and labelled with which models reported them.
- 📄 **Self-contained HTML report** (`report.html`) — interactive filtering by severity/category, CWE/OWASP tags, attack scenarios, remediation, and a "why scanners miss this" callout per finding. Plus a machine-readable `findings.json`.
- 🔒 **Runs locally.** Your code never leaves your machine except as prompt content sent to **your own** AWS Bedrock account.

---

## Requirements

1. **Node.js 18 or newer** (LTS recommended). Check with `node --version`.
   Download: <https://nodejs.org/>
2. **An AWS account with Amazon Bedrock access**, and the Claude models you want to use **enabled** in your region.
3. **AWS credentials** available locally (access key, SSO, or a named profile).

---

## Quick start (Windows)

> The steps below assume Windows 10/11 with PowerShell. Everything works the same in `cmd.exe`; just adjust path quoting.

### 1. Install Node.js
Download and install the LTS build from <https://nodejs.org/>. Open a **new** PowerShell window afterwards and confirm:
```powershell
node --version
npm --version
```

### 2. Unzip and install
Unzip `claude-secaudit.zip` to a folder, e.g. `C:\tools\claude-secaudit`, then:
```powershell
cd C:\tools\claude-secaudit
npm install
```
This pulls the dependencies (AWS SDK, etc.). It only needs to be done once.

### 3. Configure AWS credentials
Pick **one** of the following.

**Option A — environment variables (quickest for a one-off):**
```powershell
$env:AWS_ACCESS_KEY_ID     = "AKIA..."
$env:AWS_SECRET_ACCESS_KEY = "..."
$env:AWS_REGION            = "us-east-1"
# if using temporary/STS creds, also:
# $env:AWS_SESSION_TOKEN   = "..."
```
These last only for the current PowerShell window.

**Option B — a named profile (recommended for repeated use):**
Install the AWS CLI (<https://aws.amazon.com/cli/>), then:
```powershell
aws configure --profile security-audit
```
and pass `--profile security-audit` to the tool (see below).

### 4. Enable Bedrock model access
In the **AWS Console → Amazon Bedrock → Model access**, request/enable access to the Anthropic Claude models you intend to use. This is a one-time per-account, per-region step. Without it, calls fail with `AccessDeniedException`.

### 5. Verify which model IDs exist in your account
Model IDs vary by region and over time. List what you actually have:
```powershell
aws bedrock list-foundation-models --by-provider anthropic --region us-east-1 --query "modelSummaries[].modelId" --profile security-audit
aws bedrock list-inference-profiles --region us-east-1 --query "inferenceProfileSummaries[].inferenceProfileId" --profile security-audit
```
If the IDs differ from the defaults shipped in `src/config.js`, override them — see **Configuring model IDs** below. (No code editing required.)

### 6. Run it
```powershell
# Dry run first — lists what would be scanned, spends $0
node bin\secaudit.js "C:\path\to\customer-code" --dry-run

# Real scan with the default model (Sonnet 4.5)
node bin\secaudit.js "C:\path\to\customer-code"

# Deep multi-model scan into a custom output folder, using a profile
node bin\secaudit.js "C:\path\to\customer-code" -m sonnet-4.5,opus-4.6,fable-5 -o C:\audits\acme -p security-audit
```

The report is written to `secaudit-report\report.html` (or your `-o` folder). Open it in any browser.

> **Tip:** to type just `secaudit ...` instead of `node bin\secaudit.js ...`, run `npm link` once in the project folder to install it globally on your machine.

---

## Usage

```
secaudit <directory> [options]
```

| Option | Description | Default |
|---|---|---|
| `<directory>` | Folder to scan (required) | — |
| `-m, --models <list>` | Comma-separated models/aliases. Aliases: `sonnet-4.5`, `opus-4.6`, `fable-5`. You may also pass a raw Bedrock model ID. | `sonnet-4.5` |
| `-r, --region <region>` | AWS region for Bedrock | `us-east-1` (or `$AWS_REGION`) |
| `-p, --profile <name>` | AWS named profile | default credential chain |
| `-o, --out <dir>` | Output directory | `secaudit-report` |
| `-c, --concurrency <n>` | Parallel model requests | `4` |
| `--include <globs>` | Comma-separated include globs | all source files |
| `--exclude <globs>` | Extra ignore globs (added to defaults + `.gitignore`) | — |
| `--max-files <n>` | Cap files analyzed (good for trials) | — |
| `--dry-run` | List files that would be scanned, then exit. **No API calls.** | — |
| `-V, --verbose` | Log every file/model request as it starts and finishes (with timing + finding count). | — |
| `-q, --quiet` | Suppress progress output | — |
| `-v, --version` | Print version | — |

### Examples
```powershell
# Limit a first trial to 25 files to gauge cost/time
node bin\secaudit.js .\app --max-files 25

# Only scan the backend, skip generated code
node bin\secaudit.js .\repo --include "server/**,api/**" --exclude "**/generated/**"

# Highest-depth review with Opus as the architecture reasoner
node bin\secaudit.js .\repo -m sonnet-4.5,opus-4.6
```
When multiple models are supplied, the **deepest available** (Opus, else Fable, else the first) runs the cross-file architecture pass.

### Tracking progress

A scan can take several minutes on a large codebase. The tool shows live progress so it never looks frozen:

- **Default:** a single self-updating status line with a ticking clock, completed/total units, running finding count, how many requests are in flight, and the file currently being processed:
  ```
  [01:14] 38/240 (16%) · 12 findings · 4 active · src/auth/session.js [opus-4.6]
  ```
  The clock advances every second even while requests are mid-flight.

- **`-V` / `--verbose`:** one line per request as it starts and finishes, with timing and finding count — useful when you want a full audit trail of exactly what was sent:
  ```
  → src/auth/session.js [opus-4.6] …
  ✓ src/auth/session.js [opus-4.6] 4.3s · 2 findings
  ```

After the per-file phase it prints a completion line, then the cross-file architecture pass logs its model and batch progress.

---

## Configuring model IDs (no code changes)

Bedrock model IDs differ by account/region and change as AWS ships new versions. To override the built-in aliases, create a `secaudit.config.json` in the directory you run the tool from:

```json
{
  "modelAliases": {
    "sonnet-4.5": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "opus-4.6":   "us.anthropic.claude-opus-4-6-vX:0",
    "fable-5":    "us.anthropic.claude-fable-5-vX:0"
  },
  "analysis": {
    "concurrency": 6,
    "maxChunkChars": 60000,
    "maxTokensPerResponse": 8192
  }
}
```

You can also bypass aliases entirely by passing a full ID to `--models`, e.g.
`--models us.anthropic.claude-sonnet-4-5-20250929-v1:0`.

> Some Bedrock models are only callable through a **cross-region inference profile** (IDs prefixed `us.`, `eu.`, `global.`) rather than the bare foundation-model ID. If a direct ID returns a validation error telling you to use an inference profile, switch to the corresponding profile ID.

---

## What the report contains

- **Risk grade (A–F)** and severity breakdown (Critical / High / Medium / Low / Info).
- **Scope & configuration** — files analyzed, models used, region, duration, token usage.
- **Findings**, each with: severity, confidence, CWE & OWASP tags, file + line numbers (or cross-file scope), description, impact, a concrete attack scenario, evidence snippet, remediation, and — where relevant — why typical scanners miss it.
- **Interactive filtering** by severity, category, and free-text search.
- **`findings.json`** — the same findings in machine-readable form for ticketing/SIEM ingestion.

---

## How it works (and its limits)

1. **Discovery** — walks the tree, honours `.gitignore` + a large default ignore list, classifies each file (source / template / database / script / infra / config / test), and orders highest-signal files first.
2. **Chunking** — large files are split into overlapping, line-numbered chunks so findings cite exact line numbers.
3. **Per-file review** — each chunk goes to each model with a prompt engineered for scanner-blind-spot classes. The first chunk of each file also returns a compact security summary.
4. **Architecture pass** — those summaries are correlated by the deepest model to find cross-cutting issues.
5. **Merge & rank** — overlapping findings are de-duplicated (keeping the higher severity, unioning the reporting models) and sorted by severity then confidence.

**Limitations — read these.** This is an AI-assisted review and is **not** a replacement for SAST, DAST, SCA/dependency scanning, or human penetration testing. It can produce **false positives and false negatives**. Every finding must be validated by a qualified security engineer before remediation or risk acceptance. The absence of a finding is **not** evidence of security. The tool sends source code as prompt content to your AWS Bedrock account; ensure that is acceptable for the codebase under review (data residency, customer contracts, etc.).

---

## Cost & performance

You pay AWS Bedrock per-token rates for the models you select. Cost scales with codebase size × number of models. To control spend:
- Start with `--dry-run` to see the file count, then `--max-files` for a representative sample.
- Use a single fast model (`sonnet-4.5`) for broad sweeps; add `opus-4.6` only for deep passes.
- The report prints total input/output tokens so you can estimate cost against current Bedrock pricing.

---

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `Could not load credentials from any providers` | No AWS creds in the environment. Set env vars or use `--profile`. |
| `AccessDeniedException` / `You don't have access to the model` | Enable the model in **Bedrock → Model access** for that region. |
| `ValidationException ... inference profile` | Use the cross-region inference-profile ID (`us.` / `eu.` / `global.` prefix) in `secaudit.config.json`. |
| `ResourceNotFoundException` / invalid model ID | The alias ID doesn't exist in your account/region. List real IDs (step 5) and override in config. |
| `ThrottlingException` (occasional) | Handled automatically with backoff. If frequent, lower `--concurrency`. |
| Report is empty / few findings | Confirm files were found (`--dry-run`); raise `--max-files`; try adding a deeper model. |
| Run with `SECAUDIT_DEBUG=1` | Prints full stack traces for diagnosis. |

---

## License

MIT. See `LICENSE`.

This tool is provided as-is to assist security review. You are responsible for validating its output and for complying with any contractual or legal obligations regarding the code you analyze.


---- For simple how to run

node bin\secaudit.js "C:\path\to\customer-code" --dry-run        # free, lists files
node bin\secaudit.js "C:\path\to\customer-code" -m sonnet-4.5,opus-4.6,fable-5 --dry-run


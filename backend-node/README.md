# UEM Backend — Node.js port

A drop-in Node.js replacement for the FastAPI backend in `../backend`. Same API surface (same 18 routes, same JSON shapes), same five ingest paths, same `STORAGE_BACKEND=local|s3` switch — just JavaScript instead of Python. The frontend talks to either one without changing a line.

## Quickstart on Windows (no Docker)

Prerequisites:
- Node.js 18+ — https://nodejs.org/
- Git for Windows (optional — only for GitHub repo scans)
- AWS access key with `bedrock:InvokeModel` permission, and Bedrock model access enabled for Claude Sonnet 4.5 in the AWS console (Bedrock → Model access)

```bat
cd backend-node
setup-windows.bat
copy .env.example .env
notepad .env                 :: paste your AWS keys, save
run-backend.bat
```

Then in another window:
```bat
cd ..\frontend
setup-windows.bat            :: only if you haven't already
run-frontend.bat
```

Open http://localhost:3000.

## Module map (Python → Node)

| Python (`backend/app/`) | Node (`backend-node/src/`) | Library swap |
| --- | --- | --- |
| `main.py` | `server.js` | FastAPI → Express |
| `config.py` | `config.js` | pydantic-settings → dotenv |
| `logging_setup.py` | `logger.js` | structlog → pino |
| `bedrock_client.py` | `bedrockClient.js` | boto3 → `@aws-sdk/client-bedrock-runtime` |
| `persistence.py` | `persistence/s3Repository.js` | boto3 → `@aws-sdk/client-s3` |
| `local_persistence.py` | `persistence/localRepository.js` | `pathlib` → `node:fs` |
| `secrets.py` | `secrets.js` | boto3 → `@aws-sdk/client-secrets-manager` |
| `jobs.py` | `jobs.js` | asyncio.create_task → setImmediate |
| `normalizer.py` | `normalizer.js` | python `csv` → `papaparse` |
| `pentest_parser.py` | `pentestParser.js` | pypdf → `pdf-parse` |
| `github_source.py` | `githubSource.js` | subprocess → `child_process.spawn` |
| `archive_source.py` | `archiveSource.js` | `zipfile` → `adm-zip` |
| `models.py` | (no equivalent file) | pydantic → plain JS objects (validation is light) |

## Which backend should you run?

Both expose identical APIs. Pick based on:

- **Stick with the Python one** if you don't have a strong reason to switch — it's the original, more battle-tested implementation.
- **Use the Node one** if your team's standard runtime is Node, you don't want a Python toolchain on your laptop, or you want to ship the backend on Lambda / a Node-only host.

You can switch between them just by stopping one and starting the other — the frontend won't notice as long as both bind to the same port (8000).

## Endpoint parity

Every route from the Python backend is implemented here with the same path, method, request body, and response shape:

```
GET    /health
GET    /models
POST   /upload/scan
POST   /analyze
POST   /remediate/:findingId
POST   /sources/github
POST   /sources/s3
GET    /sources
GET    /sources/:id
DELETE /sources/:id
POST   /sources/:id/scan
POST   /sources/zip/upload
POST   /sources/pentest/upload
GET    /jobs
GET    /jobs/:id
GET    /scans
GET    /scans/:id
GET    /scans/:id/findings
GET    /scans/:id/analysis
```

## What changes in deployment

The original `Dockerfile`, `docker-compose.yml`, and CloudFormation template all target the Python backend. If you want to deploy the Node version to AWS instead, you'd write a Node Dockerfile (`FROM node:20-alpine`, `npm ci`, `CMD node src/server.js`) and point the ECS task definition at it. Everything else (S3 bucket, ALB, Bedrock IAM) stays the same.

## Semgrep caveat

Same as the Python version. Semgrep doesn't natively run on Windows. Without it, three of the five ingest paths work fine (`/upload/scan`, `/sources/pentest/upload`, `/analyze`, `/remediate`); GitHub / Zip / S3 source scans need Semgrep, which means running this backend inside WSL2 if you're on Windows. See `docs/WINDOWS_LOCAL.md` for the WSL setup.

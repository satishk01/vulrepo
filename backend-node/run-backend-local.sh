#!/usr/bin/env bash
# ============================================================================
# run-backend-local.sh — serve the dashboard's data from local CLI output
# Forces STORAGE_BACKEND=local and uses LOCAL_STORAGE_DIR from .env (or ./uem-data).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then npm install --no-audit --no-fund; fi
if [ -f .env ]; then set -a; . ./.env; set +a; fi

export STORAGE_BACKEND=local
export LOCAL_STORAGE_DIR="${LOCAL_STORAGE_DIR:-./uem-data}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8000}"

echo "Serving local scans from: $LOCAL_STORAGE_DIR"
echo "Backend: http://$HOST:$PORT  (health: /health)"
node src/server.js

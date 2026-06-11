#!/usr/bin/env bash
# ============================================================================
# run-cli.sh — analyse a folder of scanner/pentest files offline (macOS/Linux)
#
# Usage:
#   ./run-cli.sh <input-folder-or-file> [extra args...]
#
# Examples:
#   ./run-cli.sh ./reports
#   ./run-cli.sh ./reports --model anthropic.claude-opus-4-5 --batch-size 6
#
# It loads .env (for AWS keys + LOCAL_STORAGE_DIR) automatically.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run)..."
  npm install --no-audit --no-fund
fi

# Load .env if present so AWS creds + LOCAL_STORAGE_DIR are available.
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

if [ "$#" -lt 1 ]; then
  echo "Usage: ./run-cli.sh <input-folder-or-file> [extra args...]"
  exit 2
fi

INPUT="$1"; shift || true
STORAGE_DIR="${LOCAL_STORAGE_DIR:-./uem-data}"

node src/cli/analyze-cli.js --input "$INPUT" --storage-dir "$STORAGE_DIR" "$@"

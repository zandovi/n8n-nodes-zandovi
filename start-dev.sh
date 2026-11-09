#!/usr/bin/env bash
# Starts n8n in dev mode with the Zandovi node loaded: http://localhost:5678. Stop it with Ctrl+C.
#
# `n8n-node dev` links this folder into n8n's custom nodes, rebuilds on every change
# (tsc --watch) and runs `npx n8n@latest` with N8N_DEV_RELOAD=true. Current n8n needs
# Node >=24, so the script puts mise's Node 24 LTS first in PATH before anything starts,
# whatever `node` the shell would otherwise pick.
#
# Usage: ./start-dev.sh [n8n-node dev flags], e.g.
#   ./start-dev.sh                                              # data kept in ~/.n8n-node-cli
#   ./start-dev.sh --custom-user-folder ~/.n8n-node-cli-fresh   # a clean n8n
set -euo pipefail

NODE_VERSION="24.15.0"

cd "$(dirname "$0")"

node_bin=""
if command -v mise >/dev/null 2>&1; then
	node_bin="$(mise where "node@${NODE_VERSION}" 2>/dev/null)/bin" || node_bin=""
fi
if [[ ! -x "${node_bin}/node" ]]; then
	node_bin="${HOME}/.local/share/mise/installs/node/${NODE_VERSION}/bin"
fi
if [[ ! -x "${node_bin}/node" ]]; then
	echo "Node ${NODE_VERSION} is not installed; run: mise install node@${NODE_VERSION}" >&2
	exit 1
fi
export PATH="${node_bin}:${PATH}"

echo "Using $(command -v node) ($(node -v)), npm $(npm -v)"

# This folder is a standalone npm package (package-lock.json, `npm ci` in CI), not a pnpm
# workspace member. A node_modules laid out by pnpm (node_modules/.pnpm) is reinstalled.
if [[ ! -d node_modules || -d node_modules/.pnpm ]]; then
	npm ci
fi

exec npm run dev -- "$@"

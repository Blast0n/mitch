#!/bin/sh
set -e

cd /app

# Bind-mounted source path: install deps if node_modules is empty
if [ ! -d node_modules ] || [ -z "$(ls -A node_modules 2>/dev/null)" ]; then
  echo "==> node_modules missing, running npm ci"
  npm ci
fi

# Build frontend if dist is missing
if [ ! -f dist/index.html ]; then
  echo "==> dist/index.html missing, running npm run build"
  npm run build
fi

exec "$@"

#!/bin/sh
set -e

# Sync dependencies when package.json changes on the host.
# --frozen-lockfile is tried first (fast, no lockfile changes);
# falls back to a full install if the lockfile is out of date.
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

exec "$@"

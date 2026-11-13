# The hosted gateway and live page (see fly.toml next to this file). Build it from the repository's
# root, which is the build context:
#   docker build -f deploy/fly/Dockerfile -t quorum-hosted .
# Node runs the workspace's TypeScript sources directly (type stripping): there is no build step.
FROM node:22.22.2-slim

# pnpm at the version that "packageManager" in the root package.json names, through Corepack, which
# fetches it at the first pnpm call below.
RUN corepack enable pnpm

WORKDIR /app

# The workspace's sources. .dockerignore keeps out .git, target, every node_modules, every .env
# file, data, local agent and editor state, logs, build and test output, and any file named like a
# key or a phrase.
COPY . .

# Production dependencies only. Workspace packages stay links into the source tree, so Node strips
# their types where they are: it refuses to under node_modules/, which rules out pnpm deploy. No Rust
# toolchain and no wasm: the pools contract is deployed when the deployment is bootstrapped.
# COREPACK_ENABLE_DOWNLOAD_PROMPT is set for this install alone: nothing calls pnpm at run time, and
# the image sets no environment variable of its own.
RUN COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --prod --frozen-lockfile

# Runs as root, inside the machine's own VM, so that /run/quorum and the volume are writable without
# changing their owner. The start script derives the keys, then replaces itself with the gateway.
CMD ["/bin/sh", "/app/deploy/fly/start.sh"]

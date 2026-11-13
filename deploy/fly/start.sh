#!/bin/sh
# Starts the hosted gateway at each boot (the command of deploy/fly/Dockerfile). It derives every key
# file and the gateway's two secrets from the seed phrase into /run/quorum, on the machine's
# ephemeral disk, never on the volume, then replaces itself with the gateway, started without the
# phrase in its environment. QUORUM_CREDENTIALS_DIR and every other setting come from fly.toml's
# [env]; the phrase and the RPC endpoints are Fly secrets.
set -eu
umask 077

# The secrets every boot needs. Each missing one is named, its value never printed, before stopping.
missing=0
if [ -z "${QUORUM_RPC_URL:-}" ]; then
  echo "start.sh: QUORUM_RPC_URL is unset or empty: set the gateway's RPC endpoint as a Fly secret" >&2
  missing=1
fi
if [ -z "${QUORUM_SEED_PHRASE:-}" ] && [ -z "${QUORUM_SEED_PHRASE_FILE:-}" ]; then
  echo "start.sh: QUORUM_SEED_PHRASE and QUORUM_SEED_PHRASE_FILE are unset or empty: set the seed phrase as a Fly secret" >&2
  missing=1
fi
if [ "$missing" -ne 0 ]; then
  exit 1
fi

RUN_DIR=/run/quorum

# Start clean. Fly.io resets the root disk at each boot; a local container keeps it across restarts.
rm -rf "$RUN_DIR"
mkdir -m 0700 "$RUN_DIR"

# Writes the key files under QUORUM_CREDENTIALS_DIR and the gateway's env file, once the derived keys
# have been checked against the chain. If it fails, exit with its code.
node /app/apps/swarm/src/main.ts keys from-seed --gateway-env "$RUN_DIR/gateway.env" || exit $?

# The gateway becomes the process the host supervises. Node reads its relayer keys and credential key
# from the env file; the phrase is removed from its environment, and so from every demo run's.
# QUORUM_RELAYER_KEYS and QUORUM_CREDENTIAL_JWK are removed too: --env-file never overrides a variable
# that is already set, so a Fly secret of either name would otherwise replace the derived keys.
exec env -u QUORUM_SEED_PHRASE -u QUORUM_SEED_PHRASE_FILE -u QUORUM_RELAYER_KEYS -u QUORUM_CREDENTIAL_JWK \
  node --env-file="$RUN_DIR/gateway.env" /app/apps/gateway/src/main.ts

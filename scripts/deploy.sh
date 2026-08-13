#!/usr/bin/env bash
#
# Deploy RouteLock to one target.
#
#   ./scripts/deploy.sh xlayer_testnet          # simulate, write nothing
#   ./scripts/deploy.sh xlayer_testnet --broadcast
#
# Exists because the raw forge invocation is long enough to wrap in a terminal,
# and a wrapped command silently becomes a different command.
#
# Keys: the deployer is read from the Foundry keystore and will prompt for its
# password. It is never passed on the command line, so it cannot land in shell
# history or in a process listing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/packages/contracts"

CHAIN="${1:-}"
MODE="${2:-}"
ACCOUNT="${DEPLOYER_ACCOUNT:-routelock-deployer}"

usage() {
  echo "usage: $0 <chain> [--broadcast]" >&2
  echo "  chain: xlayer_testnet | xlayer_mainnet | botchain_testnet | botchain_mainnet" >&2
  exit 2
}

[ -n "$CHAIN" ] || usage

case "$CHAIN" in
  xlayer_testnet)   RPC_VAR=XLAYER_TESTNET_RPC;   CHAIN_ID=1952; NET=test ;;
  xlayer_mainnet)   RPC_VAR=XLAYER_MAINNET_RPC;   CHAIN_ID=196;  NET=live ;;
  botchain_testnet) RPC_VAR=BOTCHAIN_TESTNET_RPC; CHAIN_ID=968;  NET=test ;;
  botchain_mainnet) RPC_VAR=BOTCHAIN_MAINNET_RPC; CHAIN_ID=677;  NET=live ;;
  *) echo "unknown chain: $CHAIN" >&2; usage ;;
esac

# Load .env as *defaults*, without echoing it.
#
# A variable already present in the environment wins. Sourcing .env outright
# would silently override a value the caller set on the command line — which
# matters most for the RPC, where the override is how you point at a local fork
# or a replacement endpoint, and a silent revert to the .env value would deploy
# somewhere other than where you asked.
if [ -f "$ROOT/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    case "$key" in
      [A-Za-z_]*) ;;
      *) continue ;;
    esac
    [ "$key" = "$line" ] && continue   # no '=' on the line
    if [ -z "${!key:-}" ]; then
      export "$key=$val"
    fi
  done < "$ROOT/.env"
else
  echo "FATAL: $ROOT/.env not found. Copy .env.example and fill it in." >&2
  exit 1
fi

RPC="${!RPC_VAR:-}"
[ -n "$RPC" ] || { echo "FATAL: $RPC_VAR is not set in .env" >&2; exit 1; }

for v in ROUTELOCK_ADMIN ROUTELOCK_ORACLE ROUTELOCK_COMPLIANCE; do
  [ -n "${!v:-}" ] || { echo "FATAL: $v is not set in .env" >&2; exit 1; }
done

# Fail before spending gas rather than after. The deploy script asserts this
# too, but it is friendlier to catch it here than in a stack trace.
if [ "$ROUTELOCK_ORACLE" = "$ROUTELOCK_COMPLIANCE" ]; then
  echo "FATAL: ROUTELOCK_ORACLE and ROUTELOCK_COMPLIANCE are the same address." >&2
  echo "The oracle role releases escrow. Sharing it with compliance would give" >&2
  echo "the compliance service authority over funds. Use a separate key." >&2
  exit 1
fi

# Confirm the RPC really is the chain we think it is, before anything is signed.
ACTUAL=$(cast chain-id --rpc-url "$RPC")
if [ "$ACTUAL" != "$CHAIN_ID" ]; then
  echo "FATAL: $RPC_VAR points at chain $ACTUAL, but $CHAIN is chain $CHAIN_ID." >&2
  exit 1
fi

echo "chain:      $CHAIN (id $ACTUAL, $NET)"
echo "rpc:        $RPC"
echo "admin:      $ROUTELOCK_ADMIN"
echo "oracle:     $ROUTELOCK_ORACLE"
echo "compliance: $ROUTELOCK_COMPLIANCE"
echo "deployer:   keystore account '$ACCOUNT'"
echo

if [ "$MODE" != "--broadcast" ]; then
  echo "SIMULATING — nothing will be signed and no address file written."
  echo "Add --broadcast to deploy for real."
  echo
  exec forge script script/Deploy.s.sol:Deploy \
    --rpc-url "$RPC" \
    --sender "$ROUTELOCK_ADMIN"
fi

# A mainnet deploy is not something to trigger by pressing up-arrow.
if [ "$NET" = "live" ]; then
  echo "*** $CHAIN is a MAINNET deployment and will spend real funds. ***"
  printf 'Type the chain name to confirm: '
  read -r reply
  [ "$reply" = "$CHAIN" ] || { echo "aborted." >&2; exit 1; }
fi

echo "Broadcasting. The keystore password prompt is next."
exec forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC" \
  --broadcast \
  --account "$ACCOUNT" \
  --sender "$ROUTELOCK_ADMIN"

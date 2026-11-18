#!/usr/bin/env bash
# Avvio di una sessione Claude Code in cloud.
#
# Solo se CLAUDE_CODE_REMOTE=true:
#   1. avvia Postgres 16 (già installato nell'immagine) se è fermo;
#   2. crea, se mancano, l'utente mmg e il database mmg_dev;
#   3. scrive DATABASE_URL e TZ=Europe/Rome in $CLAUDE_ENV_FILE, senza duplicati;
#   4. installa le dipendenze pnpm solo se è cambiato un file che le decide.
#
# È idempotente: lanciato due volte di seguito, la seconda volta non fa nulla
# oltre ai controlli. Le credenziali sono quelle locali di sviluppo, non segreti.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

DB_USER=mmg
DB_PASSWORD=mmg
DB_NAME=mmg_dev
DB_PORT=5432
DATABASE_URL="postgres://${DB_USER}:${DB_PASSWORD}@localhost:${DB_PORT}/${DB_NAME}"

log() { printf '[avvio-sessione] %s\n' "$*" >&2; }

as_postgres() {
  if [ "$(id -u)" = "0" ]; then
    runuser -u postgres -- "$@"
  else
    sudo -u postgres "$@"
  fi
}

# 1. Postgres 16
if command -v pg_lsclusters >/dev/null 2>&1; then
  stato="$(pg_lsclusters -h | awk '$1 == "16" && $2 == "main" { print $4 }')"
  if [ -z "$stato" ]; then
    log "cluster Postgres 16 'main' non trovato: salto la parte database"
  else
    if [ "$stato" != "online" ]; then
      log "avvio Postgres 16"
      pg_ctlcluster 16 main start
    fi
    pg_isready -q -h localhost -p "$DB_PORT" -t 15

    # 2. Utente e database (CREATEDB serve ai test, che creano database temporanei)
    if [ "$(as_postgres psql -qtAX -c "SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}'")" != "1" ]; then
      log "creo l'utente ${DB_USER}"
      as_postgres psql -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ${DB_USER} LOGIN CREATEDB PASSWORD '${DB_PASSWORD}'"
    fi
    if [ "$(as_postgres psql -qtAX -c "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'")" != "1" ]; then
      log "creo il database ${DB_NAME}"
      as_postgres createdb -O "$DB_USER" -E UTF8 "$DB_NAME"
    fi
  fi
else
  log "Postgres non installato: salto la parte database"
fi

# 3. Variabili della sessione
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  touch "$CLAUDE_ENV_FILE"
  for riga in "export DATABASE_URL=${DATABASE_URL}" "export TZ=Europe/Rome"; do
    grep -qxF "$riga" "$CLAUDE_ENV_FILE" || printf '%s\n' "$riga" >>"$CLAUDE_ENV_FILE"
  done
fi

# 4. Dipendenze pnpm, solo se cambiate
if [ -f package.json ]; then
  impronte=node_modules/.avvio-sessione.sha256
  if ! sha256sum --check --status "$impronte" 2>/dev/null; then
    rm -f "$impronte"
    log "installo le dipendenze"
    pnpm install --prefer-offline
    # Questo script e ogni file che decide che cosa si installa
    find . -name node_modules -prune -o \
      \( -name package.json -o -name pnpm-lock.yaml -o -name pnpm-workspace.yaml -o -name .npmrc \) -print |
      LC_ALL=C sort | xargs sha256sum scripts/avvio-sessione.sh >"$impronte" || rm -f "$impronte"
  fi
fi

exit 0

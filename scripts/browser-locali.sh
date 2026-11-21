#!/usr/bin/env bash
# WebKit e Firefox di Playwright per le prove in locale, come nella CI (D241).
#
# Il contenitore in cloud ha già Chromium in /opt/pw-browsers: quella cartella non si tocca, e
# Playwright non si reinstalla. Gli altri due motori si scaricano in una cartella a parte, con la
# stessa versione di Playwright del progetto, e le librerie di sistema arrivano da apt. Serve che
# la rete dell'ambiente in cloud permetta playwright.download.prss.microsoft.com.
#
# Uso:
#   scripts/browser-locali.sh [webkit] [firefox]   scarica ciò che manca (per difetto: webkit)
#   scripts/browser-locali.sh --env                stampa la riga da dare alla shell
#
# Poi, per esempio:
#   eval "$(scripts/browser-locali.sh --env)"
#   E2E_BROWSER=webkit pnpm exec vitest run apps/api/test/e2e/interfaccia.test.ts
#   DEMO_BROWSER=webkit pnpm --filter @mmg/demo test:browser
set -euo pipefail

dir="${BROWSER_LOCALI_DIR:-$HOME/.cache/mmg-browser-locali}"
if [ "${1:-}" = "--env" ]; then
  echo "export PLAYWRIGHT_BROWSERS_PATH=$dir"
  exit 0
fi
browsers=("$@")
[ "${#browsers[@]}" -eq 0 ] && browsers=(webkit)
for b in "${browsers[@]}"; do
  case "$b" in
    webkit | firefox) ;;
    *)
      echo "Motore sconosciuto: $b (webkit o firefox; Chromium c'è già)" >&2
      exit 64
      ;;
  esac
done

cd "$(dirname "$0")/.."
mkdir -p "$dir"
for b in "${browsers[@]}"; do
  # Prima le librerie di sistema: senza, Playwright scarica il motore e poi si ferma.
  if [ "$(id -u)" -eq 0 ]; then
    pnpm --filter @mmg/api exec playwright install-deps "$b"
  else
    echo "Le librerie di sistema per $b vogliono l'amministratore: playwright install-deps $b" >&2
  fi
  PLAYWRIGHT_BROWSERS_PATH="$dir" pnpm --filter @mmg/api exec playwright install "$b"
  (cd apps/api && PLAYWRIGHT_BROWSERS_PATH="$dir" node -e "
    require('playwright')['$b'].launch()
      .then(async (x) => { console.log('$b', x.version(), 'pronto'); await x.close(); })")
done
echo "Per le prove: eval \"\$(scripts/browser-locali.sh --env)\""

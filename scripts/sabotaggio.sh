#!/usr/bin/env bash
# Prova di un controllo con un sabotaggio: rompe apposta, verifica che la prova diventi rossa,
# ripristina e verifica che torni verde.
#
# Uso:
#   scripts/sabotaggio.sh -f FILE [-f FILE ...] -s 'COMANDO DI SABOTAGGIO' -t 'COMANDO DI PROVA'
#
# I file indicati con -f vengono salvati prima e ripristinati dopo (se non esistevano, vengono
# cancellati). Il ripristino avviene anche se qualcosa va storto. Esce con 0 solo se la prova è
# rossa durante il sabotaggio e verde dopo il ripristino.
set -uo pipefail

files=()
sabotage=''
check=''
while getopts 'f:s:t:' opt; do
  case "$opt" in
    f) files+=("$OPTARG") ;;
    s) sabotage="$OPTARG" ;;
    t) check="$OPTARG" ;;
    *) exit 64 ;;
  esac
done
if [ -z "$sabotage" ] || [ -z "$check" ] || [ "${#files[@]}" -eq 0 ]; then
  echo "uso: $0 -f FILE -s 'SABOTAGGIO' -t 'PROVA'" >&2
  exit 64
fi

backup="$(mktemp -d)"
restore() {
  for i in "${!files[@]}"; do
    f="${files[$i]}"
    if [ -e "$backup/$i" ]; then
      cp -p "$backup/$i" "$f"
    else
      rm -rf "$f"
    fi
  done
  rm -rf "$backup"
}
trap restore EXIT

for i in "${!files[@]}"; do
  [ -e "${files[$i]}" ] && cp -p "${files[$i]}" "$backup/$i"
done

bash -c "$sabotage"
if bash -c "$check" >/tmp/sabotaggio.$$.log 2>&1; then
  echo "SABOTAGGIO NON RILEVATO: la prova è rimasta verde" >&2
  tail -20 /tmp/sabotaggio.$$.log >&2
  exit 1
fi
echo "rosso durante il sabotaggio: ok"
restore
trap - EXIT
if ! bash -c "$check" >/tmp/sabotaggio.$$.log 2>&1; then
  echo "DOPO IL RIPRISTINO LA PROVA È ROSSA" >&2
  tail -20 /tmp/sabotaggio.$$.log >&2
  exit 1
fi
rm -f /tmp/sabotaggio.$$.log
echo "verde dopo il ripristino: ok"

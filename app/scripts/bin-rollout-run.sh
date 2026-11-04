#!/bin/sh
# rollout-bootstrap: 1
# Startet ein Spiel (Konzept 5.2), vom Launcher und von Steam gleich aufgerufen: rollout-run <mywhoosh|zwift> [Argumente].
# Reines POSIX-sh wie bin/rollout. state/run.pid nennt diesen Prozess, solange das Spiel läuft: Das Aufräumen
# eines Updates löscht dann keine Version unter dem laufenden Spiel weg. Die Nummer oben nur bei echtem Bedarf erhöhen.
if [ "${1:-}" = --bootstrap-selftest ]; then
  n=$(sed -n 's/^# rollout-bootstrap: //p' "$0")
  echo "rollout-bootstrap $n run"
  exit 0
fi

# Steam setzt LD_PRELOAD und LD_LIBRARY_PATH, die das System-Python des Upstreams stören.
unset LD_PRELOAD LD_LIBRARY_PATH
home=$(cd "$(dirname "$0")/.." && pwd)
state=$home/state
app=${1:-}
[ $# -gt 0 ] && shift

# Upstream je App: MyWhoosh liegt im Launcher-Release, Zwift entpackt unter upstream/zwift/<sha>/.
case $app in
  mywhoosh) up=$home/current/vendor/mywhoosh.sh; set -- run "$@" ;;
  zwift) up=$(ls -td "$home"/upstream/zwift/*/zwift.sh 2>/dev/null | head -n 1) ;;
  *) echo "Aufruf: rollout-run mywhoosh|zwift" >&2; exit 2 ;;
esac
[ -n "${ROLLOUT_RUN_UPSTREAM:-}" ] && up=$ROLLOUT_RUN_UPSTREAM
[ -n "$up" ] && [ -x "$up" ] || { echo "Rollout: Upstream für $app ist nicht installiert" >&2; exit 127; }

mkdir -p "$state"
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
if ! ( set -C; echo $$ > "$state/run.pid" ) 2>/dev/null; then
  old=$(sed -n '1p' "$state/run.pid" 2>/dev/null)
  if alive "$old"; then
    echo "Rollout: Es läuft schon eine App (Prozess $old). Trainer und Bluetooth lassen sich nicht teilen." >&2
    exit 1
  fi
  echo $$ > "$state/run.pid.tmp" && mv -f "$state/run.pid.tmp" "$state/run.pid"
fi
trap '[ "$(sed -n "1p" "$state/run.pid" 2>/dev/null)" = "$$" ] && rm -f "$state/run.pid"' EXIT

# INT und HUP gehen als TERM weiter, damit das Spiel sich beenden kann.
sig=0
pid=
forward() { sig=1; [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null; }
trap forward TERM INT HUP

# Bildschirm wachhalten, wo systemd-inhibit da ist und es darf (in einer SSH-Sitzung verweigert polkit es): vorher ausprobieren,
# damit ein Fehler der Sperre nie das Spiel verhindert.
inhibit() { systemd-inhibit --what=idle:sleep --who=Rollout --why="$app läuft" "$@"; }
if [ -z "${ROLLOUT_RUN_NO_INHIBIT:-}" ] && command -v systemd-inhibit >/dev/null 2>&1 && inhibit true >/dev/null 2>&1; then
  inhibit "$up" "$@" &
else
  "$up" "$@" &
fi
pid=$!
while :; do
  wait "$pid"; code=$?
  kill -0 "$pid" 2>/dev/null || break
done
[ "$sig" = 1 ] && [ "$code" = 0 ] && code=143
exit "$code"

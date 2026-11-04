#!/bin/sh
# rollout-bootstrap: 1
# Starter und Wächter von Rollout (Konzept 6.6). Reines POSIX-sh, damit er unter bash und dash läuft.
# Bleibt klein: Er kann sich nicht selbst reparieren. Die Nummer oben nur bei echtem Bedarf erhöhen,
# erst dann erneuert ein Update diese Datei (nach `sh -n` und `--bootstrap-selftest`).
if [ "${1:-}" = --bootstrap-selftest ]; then
  n=$(sed -n 's/^# rollout-bootstrap: //p' "$0")
  if command -v flock >/dev/null 2>&1; then f=ja; else f=nein; fi
  echo "rollout-bootstrap $n flock=$f"
  exit 0
fi

# Steam setzt LD_PRELOAD und LD_LIBRARY_PATH, die Electron stören (Gate G4).
unset LD_PRELOAD LD_LIBRARY_PATH
home=$(cd "$(dirname "$0")/.." && pwd)
state=$home/state
timeout=${ROLLOUT_BOOT_TIMEOUT:-60}
grace=${ROLLOUT_BOOT_GRACE:-5}
ROLLOUT_HOME=$home
export ROLLOUT_HOME
mkdir -p "$state"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$state/boot.log"; }
if [ -f "$state/boot.log" ] && [ "$(wc -l < "$state/boot.log")" -gt 400 ]; then
  tail -n 200 "$state/boot.log" > "$state/boot.log.tmp" && mv -f "$state/boot.log.tmp" "$state/boot.log"
fi

first() { v=; [ -r "$1" ] && { IFS= read -r v < "$1" || :; }; printf '%s' "$v"; }
valid_version() { case $1 in ''|.*|*[!0-9a-zA-Z.+-]*) return 1 ;; esac; }
in_bad() { [ -f "$state/bad" ] && grep -qxF -- "$1" "$state/bad"; }
link_version() { t=$(readlink "$home/$1" 2>/dev/null) || return 1; printf '%s' "${t##*/}"; }
set_link() { rm -f "$home/.$1.new"; ln -s "versions/$2" "$home/.$1.new" && mv -T "$home/.$1.new" "$home/$1"; }
electron_of() {
  rt=$(first "$home/versions/$1/runtime")
  valid_version "$rt" && [ -x "$home/electron/$rt/electron" ] && printf '%s' "$home/electron/$rt/electron"
}
write_trial() { printf '%s\n%s\n' "$1" "$2" > "$state/trial.tmp" && mv -f "$state/trial.tmp" "$state/trial"; }
trial_fails() { f=$(sed -n '2p' "$state/trial" 2>/dev/null); printf '%s' "${f:-0}"; }

# Ohne flock oder bei belegter Sperre: starten, aber nichts tauschen und nichts bewachen.
supervised=1
if command -v flock >/dev/null 2>&1; then
  exec 9>"$state/lock"
  flock -n 9 || supervised=0
else
  supervised=0
fi
if [ "$supervised" = 0 ]; then
  unset ROLLOUT_SUPERVISED
  cur=$(link_version current)
  exe=$(electron_of "$cur") || { log "Start ohne Wächter: kein Electron für '$cur'"; echo "Rollout: kein startbares Electron gefunden" >&2; exit 1; }
  exec "$exe" "$home/current" "$@" 9>&-
fi
ROLLOUT_SUPERVISED=1
export ROLLOUT_SUPERVISED

# Eine Version aus state/pending einspielen. Jeder Schritt ist wiederholbar, ein Abbruch dazwischen schadet nicht.
swap() {
  new=$1
  old=$(link_version current)
  if [ "$(first "$state/trial")" != "$new" ]; then
    rm -f "$state/healthy"
    write_trial "$new" 0
  fi
  if [ "$old" != "$new" ]; then
    [ -n "$old" ] && set_link previous "$old"
    set_link current "$new"
  fi
  rm -f "$state/pending"
  log "Version $new eingespielt (vorher ${old:-keine})"
}

take_pending() {
  [ -f "$state/pending" ] || return 0
  p=$(first "$state/pending")
  if valid_version "$p" && ! in_bad "$p" && [ -f "$home/versions/$p/package.json" ] && electron_of "$p" >/dev/null; then
    swap "$p"
  else
    log "pending '$p' ungültig, verworfen"
    rm -f "$state/pending"
  fi
}

# Nach zwei Fehlschlägen auf previous zurück. Fehlt es oder ist es selbst gesperrt, bleibt current.
give_up() {
  prev=$(link_version previous)
  if [ -n "$prev" ] && [ "$prev" != "$1" ] && ! in_bad "$prev" && electron_of "$prev" >/dev/null; then
    printf '%s\n' "$1" >> "$state/bad"
    printf '%s\n' "$1" > "$state/notice"
    set_link current "$prev"
    rm -f "$home/previous"
    log "Version $1 zweimal fehlgeschlagen, zurück auf $prev"
  else
    log "Version $1 zweimal fehlgeschlagen, kein Rückweg"
  fi
  rm -f "$state/trial" "$state/healthy"
}

wait_child() {
  while :; do
    wait "$pid"; code=$?
    kill -0 "$pid" 2>/dev/null || break
  done
}

# INT und HUP gehen als TERM weiter: Ein Hintergrundprozess der Shell erbt sonst „INT ignorieren“.
sig=0
pid=
forward() { sig=1; [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null; }
trap forward TERM INT HUP

while :; do
  take_pending
  [ "$sig" = 1 ] && exit 143
  cur=$(link_version current)
  exe=$(electron_of "$cur") || { log "kein Electron für '$cur'"; echo "Rollout: kein startbares Electron gefunden" >&2; exit 1; }
  [ "$(first "$state/trial")" = "$cur" ] && trial=1 || { trial=0; rm -f "$state/trial"; }

  "$exe" "$home/current" "$@" 9>&- &
  pid=$!
  watcher=
  if [ "$trial" = 1 ]; then
    # Die Probe läuft im Nebenprozess, weil `wait` im Hauptprozess nicht auf zwei Dinge zugleich warten kann.
    (
      t=0
      while [ "$t" -lt "$timeout" ]; do
        sleep 1
        if [ "$(first "$state/healthy")" = "$cur" ]; then
          rm -f "$state/trial" "$state/healthy"
          log "Version $cur bewährt"
          exit 0
        fi
        t=$((t + 1))
      done
      : > "$state/.hung"
      kill -TERM "$pid" 2>/dev/null
      sleep "$grace"
      kill -KILL "$pid" 2>/dev/null
    ) >/dev/null 2>&1 </dev/null 9>&- &
    watcher=$!
  fi
  wait_child
  pid=
  [ -n "$watcher" ] && kill "$watcher" 2>/dev/null
  hung=0
  [ -f "$state/.hung" ] && { hung=1; rm -f "$state/.hung"; }
  [ "$sig" = 1 ] && exit "$code"

  if [ "$(first "$state/trial")" = "$cur" ]; then
    if [ "$hung" = 0 ] && [ "$code" = 0 ]; then log "Probe von $cur offen, Nutzer hat beendet"; exit 0; fi
    [ "$hung" = 0 ] && [ "$code" = 75 ] && continue
    fails=$(( $(trial_fails) + 1 ))
    [ "$hung" = 1 ] && why=", Hänger" || why=
    log "Version $cur fehlgeschlagen ($fails, Code $code$why)"
    if [ "$fails" -ge 2 ]; then give_up "$cur"; else write_trial "$cur" "$fails"; fi
    continue
  fi
  # Neustart ohne Probe nur, wenn etwas einzuspielen ist, sonst endet der Wächter mit 75.
  [ "$code" = 75 ] && [ -f "$state/pending" ] && continue
  exit "$code"
done

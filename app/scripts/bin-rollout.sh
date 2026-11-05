#!/bin/sh
# rollout-bootstrap: 1
# Starter and watcher of Rollout (concept 6.6). Plain POSIX sh so it runs under bash and dash.
# Stays small: it cannot repair itself. Raise the number above only when really needed;
# only then does an update renew this file (after `sh -n` and `--bootstrap-selftest`).
if [ "${1:-}" = --bootstrap-selftest ]; then
  n=$(sed -n 's/^# rollout-bootstrap: //p' "$0")
  if command -v flock >/dev/null 2>&1; then f=ja; else f=nein; fi
  echo "rollout-bootstrap $n flock=$f"
  exit 0
fi

# Steam sets LD_PRELOAD and LD_LIBRARY_PATH, which disturb Electron (gate G4).
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

# Without flock or when the lock is held: start, but swap nothing and watch nothing.
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
  exe=$(electron_of "$cur") || { log "Start without watcher: no Electron for '$cur'"; echo "Rollout: no startable Electron found" >&2; exit 1; }
  exec "$exe" "$home/current" "$@" 9>&-
fi
ROLLOUT_SUPERVISED=1
export ROLLOUT_SUPERVISED

# Apply a version from state/pending. Every step is repeatable, an abort in between does no harm.
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
  log "Version $new applied (before: ${old:-none})"
}

take_pending() {
  [ -f "$state/pending" ] || return 0
  p=$(first "$state/pending")
  if valid_version "$p" && ! in_bad "$p" && [ -f "$home/versions/$p/package.json" ] && electron_of "$p" >/dev/null; then
    swap "$p"
  else
    log "pending '$p' invalid, discarded"
    rm -f "$state/pending"
  fi
}

# After two failures go back to previous. If it is missing or itself blocked, current stays.
give_up() {
  prev=$(link_version previous)
  if [ -n "$prev" ] && [ "$prev" != "$1" ] && ! in_bad "$prev" && electron_of "$prev" >/dev/null; then
    printf '%s\n' "$1" >> "$state/bad"
    printf '%s\n' "$1" > "$state/notice"
    set_link current "$prev"
    rm -f "$home/previous"
    log "Version $1 failed twice, rolling back to $prev"
  else
    log "Version $1 failed twice, no way back"
  fi
  rm -f "$state/trial" "$state/healthy"
}

wait_child() {
  while :; do
    wait "$pid"; code=$?
    kill -0 "$pid" 2>/dev/null || break
  done
}

# INT and HUP are passed on as TERM: a background process of the shell would otherwise inherit "ignore INT".
sig=0
pid=
forward() { sig=1; [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null; }
trap forward TERM INT HUP

while :; do
  take_pending
  [ "$sig" = 1 ] && exit 143
  cur=$(link_version current)
  exe=$(electron_of "$cur") || { log "no Electron for '$cur'"; echo "Rollout: no startable Electron found" >&2; exit 1; }
  [ "$(first "$state/trial")" = "$cur" ] && trial=1 || { trial=0; rm -f "$state/trial"; }

  "$exe" "$home/current" "$@" 9>&- &
  pid=$!
  watcher=
  if [ "$trial" = 1 ]; then
    # The trial runs in a side process because `wait` in the main process cannot wait for two things at once.
    (
      t=0
      while [ "$t" -lt "$timeout" ]; do
        sleep 1
        if [ "$(first "$state/healthy")" = "$cur" ]; then
          rm -f "$state/trial" "$state/healthy"
          log "Version $cur proven"
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
    if [ "$hung" = 0 ] && [ "$code" = 0 ]; then log "Trial of $cur open, user quit"; exit 0; fi
    [ "$hung" = 0 ] && [ "$code" = 75 ] && continue
    fails=$(( $(trial_fails) + 1 ))
    [ "$hung" = 1 ] && why=", hang" || why=
    log "Version $cur failed ($fails, code $code$why)"
    if [ "$fails" -ge 2 ]; then give_up "$cur"; else write_trial "$cur" "$fails"; fi
    continue
  fi
  # Restart without a trial only if something has to be applied, otherwise the watcher ends with 75.
  [ "$code" = 75 ] && [ -f "$state/pending" ] && continue
  exit "$code"
done

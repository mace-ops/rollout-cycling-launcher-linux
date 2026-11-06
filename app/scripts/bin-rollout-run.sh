#!/bin/sh
# rollout-bootstrap: 9
# Starts a game (concept 5.2), called the same way by the launcher and by Steam: rollout-run <mywhoosh|zwift> [arguments].
# Further calls: rollout-run --container-check (names the usable container runtime, otherwise message and exit 10),
# rollout-run --zwift-pull (pulls the configured Zwift image and remembers the consent, only after confirmation by the user) and
# rollout-run --zwift-status (stdout: runtime=<podman|docker>, ref=<Image:Tag>, image=<present|missing>, consent=<yes|no>; pulls and starts nothing) and
# rollout-run --zwift-remove (removes the configured image with "rmi" and forgets the consent; only after asking the user, success without an image too) and
# rollout-run --mywhoosh <install [--hd]|update|uninstall> (sets up, updates or removes MyWhoosh through vendor/mywhoosh.sh; the screen stays awake; if a game is running, exit 1).
# Exit codes of Rollout itself: 1 already running, 2 usage, 10 no usable container runtime, 11 Zwift image not configured,
# 12 Zwift image missing (no consent or pull failed), 13 image could not be removed, 127 upstream missing. Otherwise the game's exit code
# (for --mywhoosh the script's).
# Plain POSIX sh like bin/rollout. state/run.pid names this process while the game runs: the cleanup
# of an update then does not delete a version from under the running game. Raise the number above only when really needed.
if [ "${1:-}" = --bootstrap-selftest ]; then
  n=$(sed -n 's/^# rollout-bootstrap: //p' "$0")
  echo "rollout-bootstrap $n run"
  exit 0
fi

# Steam sets LD_PRELOAD and LD_LIBRARY_PATH, which disturb the upstream's system Python.
unset LD_PRELOAD LD_LIBRARY_PATH
home=$(cd "$(dirname "$0")/.." && pwd)
state=$home/state
app=${1:-}
[ $# -gt 0 ] && shift

# --- Container runtime for Zwift (netbrain/zwift, concept 5.1, E7/E8) -------------------------------------------------------------
# Detects Podman before Docker and checks whether the runtime is really usable (service running, permissions sufficient). Sets rt to the
# program name or prints an understandable message and returns 1. This layer never installs packages (setup: E8, later).
msg() { echo "Rollout: $*" >&2; }

# A call with a time limit so a hanging Docker service never blocks the start.
limited() { if command -v timeout >/dev/null 2>&1; then timeout 20 "$@"; else "$@"; fi; }

# rt_probe <program>: 0 usable; otherwise 1 and rt_why gives the reason in one sentence.
rt_probe() {
  rt_why=
  if ! command -v "$1" >/dev/null 2>&1; then rt_why="$1 is not installed."; return 1; fi
  if rt_out=$(limited "$1" info 2>&1 </dev/null); then return 0; fi
  case $rt_out in
    *[Pp]ermission\ denied*) rt_why="$1 is installed, but you have no permission (with Docker the group \"docker\" is often missing; Podman needs none)." ;;
    *[Cc]annot\ connect*|*[Ii]s\ the\ docker\ daemon\ running*|*[Nn]o\ such\ file*|*[Cc]onnection\ refused*) rt_why="$1 is installed, but the service is not running." ;;
    *subuid*|*subgid*|*newuidmap*|*newgidmap*) rt_why="$1 is installed, but no user IDs for containers are set up for your user (subuid/subgid)." ;;
    *) rt_why="$1 is installed, but reports an error: $(printf '%s\n' "$rt_out" | sed -n '1p' | cut -c1-160)" ;;
  esac
  return 1
}

# rt_detect: Podman before Docker; ROLLOUT_CONTAINER_TOOL=podman|docker fixes the choice.
rt_detect() {
  rt=
  case ${ROLLOUT_CONTAINER_TOOL:-} in
    '') rt_list="podman docker" ;;
    podman|docker) rt_list=$ROLLOUT_CONTAINER_TOOL ;;
    *) msg "ROLLOUT_CONTAINER_TOOL must be podman or docker, not \"$ROLLOUT_CONTAINER_TOOL\"."; return 1 ;;
  esac
  rt_notes=
  for rt_try in $rt_list; do
    if rt_probe "$rt_try"; then rt=$rt_try; return 0; fi
    rt_notes="$rt_notes
  - $rt_why"
  done
  msg "Zwift runs in a container, but there is no usable container runtime.$rt_notes"
  echo "  Podman (recommended) or Docker is required. On Bazzite the setup assistant will do this later; until then set it up in Desktop Mode." >&2
  return 1
}

# zwift_config: reads image, tag and digest. A tag is mandatory and never "latest" (no silent drifting of the image).
# Sources: environment (ROLLOUT_ZWIFT_IMAGE, _TAG, _DIGEST), otherwise zwift_tag and zwift_digest in config.toml.
conf=${ROLLOUT_CONFIG_HOME:-$HOME/.config/rollout}/config.toml
conf_get() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$conf" 2>/dev/null | sed -n '1p'; }
zwift_config() {
  zw_image=${ROLLOUT_ZWIFT_IMAGE:-docker.io/netbrain/zwift}
  zw_tag=${ROLLOUT_ZWIFT_TAG:-$(conf_get zwift_tag)}
  zw_digest=${ROLLOUT_ZWIFT_DIGEST:-$(conf_get zwift_digest)}
  case $zw_image in ''|[!a-z0-9]*|*..*|*[!a-z0-9./_:-]*) msg "ROLLOUT_ZWIFT_IMAGE is invalid: \"$zw_image\"."; return 1 ;; esac
  case $zw_tag in
    '') msg "No Zwift image configured. Enter the netbrain/zwift version in $conf, for example: zwift_tag = \"1.2.3\" (not \"latest\")."; return 1 ;;
    latest|-*|.*|*[!A-Za-z0-9_.-]*) msg "The Zwift tag \"$zw_tag\" is not allowed. A fixed version is required, never \"latest\"."; return 1 ;;
  esac
  if [ -n "$zw_digest" ]; then
    zw_hex=${zw_digest#sha256:}
    case $zw_digest in sha256:*) ;; *) zw_hex=x ;; esac
    case $zw_hex in *[!0-9a-f]*) zw_hex=x ;; esac
    [ ${#zw_hex} = 64 ] || { msg "zwift_digest must have the form sha256:<64 hex characters>."; return 1; }
  fi
  zw_ref=$zw_image:$zw_tag
  zw_want=$zw_ref${zw_digest:+@$zw_digest}
}

# zwift_have: 0 if the image exists locally (with a fixed digest: exactly that one).
zwift_have() {
  "$rt" image inspect "$zw_ref" >/dev/null 2>&1 </dev/null || return 1
  [ -z "$zw_digest" ] && return 0
  case $("$rt" image inspect --format '{{json .RepoDigests}}' "$zw_ref" 2>/dev/null </dev/null) in *"$zw_digest"*) return 0 ;; esac
  return 1
}

# zwift_pull: pulls the image and remembers the consent for exactly this reference. Call only after confirmation by the user.
zwift_pull() {
  msg "Pulling $zw_want (several GB, this takes a while) …"
  if [ -n "$zw_digest" ]; then
    "$rt" pull "$zw_image@$zw_digest" </dev/null && "$rt" tag "$zw_image@$zw_digest" "$zw_ref" </dev/null
  else
    "$rt" pull "$zw_ref" </dev/null
  fi || { msg "The Zwift image could not be pulled (network, disk space or registry login)."; return 1; }
  mkdir -p "$state" && printf '%s\n' "$zw_want" > "$state/zwift-image-ok"
}

# zwift_remove: removes the configured image (only the image:tag reference; a fixed digest belongs to the same image) and forgets the consent.
# An image that is not there counts as removed. The container runtime and netbrain's settings stay.
zwift_remove() {
  if "$rt" image inspect "$zw_ref" >/dev/null 2>&1 </dev/null; then
    "$rt" rmi "$zw_ref" </dev/null || { msg "The Zwift image $zw_ref could not be removed (is a container still using it?)."; return 1; }
  fi
  rm -f "$state/zwift-image-ok"
}

# zwift_prepare: runtime, image and environment for netbrain's zwift.sh. Pulling happens only with consent for exactly this reference.
zwift_prepare() {
  rt_detect || return 10
  zwift_config || return 11
  if ! zwift_have; then
    if [ "$(sed -n '1p' "$state/zwift-image-ok" 2>/dev/null)" != "$zw_want" ]; then
      msg "The Zwift image $zw_want has not been pulled yet. It is several GB in size and is pulled only after your confirmation: confirm in the launcher or run $0 --zwift-pull by hand."
      return 12
    fi
    zwift_pull || return 12
  fi
  # DONT_UPDATE: the image is fixed, zwift.sh pulls and checks nothing itself. ZWIFT_FG: container in the foreground so Steam sees the end.
  export CONTAINER_TOOL=$rt IMAGE=$zw_image VERSION=$zw_tag DONT_UPDATE=1 ZWIFT_FG=1
  # Host network: the Zwift Companion app finds the game by broadcast on the Wi-Fi and cannot get into the bridge network (confirmed on the Ally: with host
  # Zwift connects to the phone, with bridge it does not). Anyone who wants something else sets NETWORKING themselves.
  export NETWORKING=${NETWORKING:-host}
  # Zwift's data directory: Zwift 1.124.0 writes settings and logs to Documents/Zwift (its log: "Using user data path: C:\users\user\DOCU~OWL",
  # netbrain's script: "Zwift is using Documents/Zwift instead of AppData/Local/Zwift"), but run_zwift.sh only syncs ZWIFT_DATA_DIR (in the image:
  # AppData/Local/Zwift) with the volume zwift-<rider>. Everything was lost after every run (confirmed on the Ally: the volume held only .logrecord).
  # Rollout therefore points ZWIFT_DATA_DIR at Documents/Zwift (a real directory filled by rsync, not a link: netbrain issue 366 does not apply).
  # ROLLOUT_ZWIFT_DATA=appdata keeps netbrain's default (for an image whose Zwift uses AppData again). A user CONTAINER_EXTRA_ARGS string is kept;
  # one set only in netbrain's own config replaces ours (known limitation). netbrain warns about the string form; that is expected.
  if [ "${ROLLOUT_ZWIFT_DATA:-documents}" != appdata ]; then
    CONTAINER_EXTRA_ARGS="-e ZWIFT_DATA_DIR=/home/user/.wine/drive_c/users/user/Documents/Zwift${CONTAINER_EXTRA_ARGS:+ $CONTAINER_EXTRA_ARGS}"
    export CONTAINER_EXTRA_ARGS
  fi
  # zwift.sh aborts with "USER: unbound variable" if USER is missing (noticed on the Ally during a trial run with an empty environment).
  [ -n "${USER:-}" ] || { USER=$(id -un 2>/dev/null) || USER=; export USER; }
  # Container name as in zwift.sh (--name zwift-${ZWIFT_RIDER:-$USER}); on quit the starter stops it by that name (see forward).
  # If the user sets ZWIFT_RIDER only in netbrain's own config, the starter does not know the name and stops nothing (known limitation).
  zw_name=zwift-${ZWIFT_RIDER:-$USER}
}

# mw_hd: only the HD edition is installed. Steam calls without arguments, and mywhoosh.sh does not detect the edition on its own from the vendor directory.
mw_hd() { [ -z "${MYWHOOSH_ROOT:-}" ] && [ ! -f "$HOME/Games/mywhoosh-linux/edition" ] && [ -f "$HOME/Games/mywhoosh-hd-linux/edition" ]; }
mw_setup=

# Upstream per app: MyWhoosh is part of the launcher release, Zwift is netbrain/zwift's start script under zwift/<sha>/ (ROLLOUT_ZWIFT_SCRIPT replaces it).
case $app in
  --container-check) rt_detect || exit 10; echo "$rt"; exit 0 ;;
  --zwift-status)
    rt_detect || exit 10; zwift_config || exit 11
    echo "runtime=$rt"; echo "ref=$zw_want"
    if zwift_have; then echo "image=present"; else echo "image=missing"; fi
    if [ "$(sed -n '1p' "$state/zwift-image-ok" 2>/dev/null)" = "$zw_want" ]; then echo "consent=yes"; else echo "consent=no"; fi
    exit 0 ;;
  --zwift-pull) rt_detect || exit 10; zwift_config || exit 11; zwift_pull || exit 12; exit 0 ;;
  --zwift-remove) rt_detect || exit 10; zwift_config || exit 11; zwift_remove || exit 13; exit 0 ;;
  --mywhoosh)
    mw_act=${1:-}
    case $mw_act in
      install) ;;
      update|uninstall) mw_hd && set -- "$@" --hd ;;
      *) echo "Usage: rollout-run --mywhoosh install [--hd]|update|uninstall" >&2; exit 2 ;;
    esac
    up=$home/current/vendor/mywhoosh.sh; mw_setup=1 ;;
  mywhoosh) up=$home/current/vendor/mywhoosh.sh; if mw_hd; then set -- run --hd "$@"; else set -- run "$@"; fi ;;
  zwift) up=${ROLLOUT_ZWIFT_SCRIPT:-$(ls -td "$home"/zwift/*/zwift.sh 2>/dev/null | head -n 1)} ;;
  *) echo "Usage: rollout-run mywhoosh|zwift" >&2; exit 2 ;;
esac
[ -n "${ROLLOUT_RUN_UPSTREAM:-}" ] && up=$ROLLOUT_RUN_UPSTREAM
[ -n "$up" ] && [ -x "$up" ] || { echo "Rollout: upstream for $app is not installed" >&2; exit 127; }
if [ "$app" = zwift ]; then zwift_prepare || exit $?; fi
# MyWhoosh does not get the virtual gamepad of Steam Input: Rollout forwards it as keyboard and mouse (gamepad-bridge.ts), and the
# game's UI shows no focus when navigating by gamepad (A even quit it). 045e:028e is the ID under which Steam reports its gamepad
# (Wine reads it via SDL). Only with xdotool (otherwise the game would have no input at all), never with ROLLOUT_MYWHOOSH_PAD=off, and a user-set value wins.
if [ "$app" = mywhoosh ] && [ "${ROLLOUT_MYWHOOSH_PAD:-}" != off ] && [ -z "${SDL_GAMECONTROLLER_IGNORE_DEVICES:-}" ] && command -v xdotool >/dev/null 2>&1; then
  export SDL_GAMECONTROLLER_IGNORE_DEVICES=0x045e/0x028e
fi

mkdir -p "$state"
fifo=
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
reaper=
if [ -n "$mw_setup" ]; then
  # Setup is not a game and does not take run.pid, but must never work under a running game (uninstall ends its Wine server).
  old=$(sed -n '1p' "$state/run.pid" 2>/dev/null)
  if alive "$old"; then
    echo "Rollout: an app is already running (process $old)." >&2
    exit 1
  fi
  trap '[ -n "$reaper" ] && kill "$reaper" 2>/dev/null' EXIT
else
  if ! ( set -C; echo $$ > "$state/run.pid" ) 2>/dev/null; then
    old=$(sed -n '1p' "$state/run.pid" 2>/dev/null)
    if alive "$old"; then
      echo "Rollout: an app is already running (process $old). Trainer and Bluetooth cannot be shared." >&2
      exit 1
    fi
    echo $$ > "$state/run.pid.tmp" && mv -f "$state/run.pid.tmp" "$state/run.pid"
  fi
  trap '[ "$(sed -n "1p" "$state/run.pid" 2>/dev/null)" = "$$" ] && rm -f "$state/run.pid"; [ -n "$reaper" ] && kill "$reaper" 2>/dev/null; [ -n "$fifo" ] && rm -f "$fifo"' EXIT
fi

# INT and HUP are passed on as TERM so the game can quit. For Zwift that is not enough: the container is not part of
# zwift.sh's process tree, and its PID 1 ignores TERM. The starter therefore stops it itself (via "podman stop", KILL after 10 s)
# and waits at most 20 s for that; a container of that name that is not yet or no longer running is not an error.
# MyWhoosh (game and setup) runs in its own session (setsid, if available): Wine, umu and the Bluetooth helper are not part of
# the script's process tree and would be left behind as orphans after a TERM to the script alone. On quit the whole group gets
# TERM, and whatever still lives after 12 s gets KILL.
grp=
if { [ "$app" = mywhoosh ] || [ -n "$mw_setup" ]; } && command -v setsid >/dev/null 2>&1; then grp=1; fi
# zw_quit: quit Zwift in an orderly way. Netbrain's script copies Zwift's settings including the login (AppData) into the volume between runs only when
# ZwiftApp.exe has exited. A "podman stop" alone made the container end hard after 10 s, and the login was lost.
# First politely (taskkill), after ROLLOUT_ZWIFT_QUIT_WAIT s (8) hard (taskkill /f; the script then still copies and exits, it checks every 5 s),
# then wait up to ROLLOUT_ZWIFT_KILL_WAIT s (15); whatever remains, the caller stops with "stop".
zw_gone() { [ -z "$(limited "$rt" ps -q --filter "name=^${zw_name}\$" 2>/dev/null </dev/null)" ]; }
zw_wait_gone() { zw_n=$1; while [ "$zw_n" -gt 0 ]; do zw_gone && return 0; sleep 1; zw_n=$((zw_n - 1)); done; zw_gone; }
zw_quit() {
  limited "$rt" exec --user user "$zw_name" wine taskkill /im ZwiftApp.exe >/dev/null 2>&1 </dev/null
  zw_wait_gone "${ROLLOUT_ZWIFT_QUIT_WAIT:-8}" && return 0
  limited "$rt" exec --user user "$zw_name" wine taskkill /f /im ZwiftApp.exe >/dev/null 2>&1 </dev/null
  zw_wait_gone "${ROLLOUT_ZWIFT_KILL_WAIT:-15}"
}
# zw_sync_loop: copy Zwift's data into the volume while it runs. netbrain's script does that only once ZwiftApp.exe has exited; "Exit game" in
# Steam sends TERM to every process below Rollout, also to "podman run", which passes it on to the container: it ends at once and the copy never
# happens (seen on the Ally: container kill and died in the same second, volume unchanged). Every ROLLOUT_ZWIFT_SYNC_EVERY s (30, 0 = off) the same
# rsync as netbrain's (-au, ZWIFT_DATA_DIR to ZWIFT_VOLUME, both from the container's environment) runs inside the container as its user.
# At most that many seconds of changes are lost on a hard end. Output to /dev/null: the loop must not hold the launcher's pipe open.
zw_sync_loop() {
  while sleep "$zw_every"; do
    kill -0 "$pid" 2>/dev/null || break
    zw_gone && continue
    limited "$rt" exec --user user "$zw_name" sh -c 'd=${ZWIFT_DATA_DIR:-} v=${ZWIFT_VOLUME:-}; [ -n "$d" ] && [ -n "$v" ] && [ "$d" != "$v" ] && [ -d "$d" ] || exit 0; rsync -qau "$d/" "$v/"' </dev/null
  done
}
syncer=
sig=0
pid=
forward() {
  sig=1
  [ -n "$syncer" ] && kill "$syncer" 2>/dev/null
  if [ -n "$pid" ]; then
    if [ -n "$grp" ]; then kill -s TERM -- "-$pid" 2>/dev/null; else kill -TERM "$pid" 2>/dev/null; fi
  fi
  if [ -n "$grp" ] && [ -z "$reaper" ]; then
    ( sleep "${ROLLOUT_RUN_KILL_AFTER:-12}"; kill -s KILL -- "-$pid" ) >/dev/null 2>&1 </dev/null &
    reaper=$!
  fi
  if [ -n "${zw_name:-}" ]; then
    zw_quit
    limited "$rt" stop -t 10 "$zw_name" >/dev/null 2>&1 </dev/null
  fi
  return 0
}
trap forward TERM INT HUP

# Output log for Zwift: the container runs with --rm, so whatever zwift.sh and the container print (stdout and stderr together) is otherwise
# lost after a crash. A copy goes to state/zwift-run.log; the two runs before stay as zwift-run.log.1 and .2. ROLLOUT_ZWIFT_LOG=off switches it off.
# The copy runs through a FIFO and tee. tee ignores INT, TERM and HUP (a Ctrl+C in the terminal must not end it, the game would then die of
# SIGPIPE on its next line) and XFSZ: ulimit -f caps the file (20 to 40 MB, the unit differs between shells), beyond that only the file stops growing.
log=
tee_pid=
if [ "$app" = zwift ] && [ "${ROLLOUT_ZWIFT_LOG:-}" != off ]; then
  log=$state/zwift-run.log
  fifo=$state/zwift-run.fifo
  [ -f "$log.1" ] && mv -f "$log.1" "$log.2"
  [ -f "$log" ] && mv -f "$log" "$log.1"
  rm -f "$fifo"
  if mkfifo "$fifo" 2>/dev/null && { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) rollout-run zwift $* (runtime $rt, image $zw_want)" > "$log"; } 2>/dev/null; then
    ( trap '' INT TERM HUP XFSZ; ulimit -f 40000 2>/dev/null; exec tee -a "$log" 2>/dev/null ) < "$fifo" &
    tee_pid=$!
  else
    rm -f "$fifo"; fifo=; log=
  fi
fi

# Keep the screen awake where systemd-inhibit exists and is allowed (in an SSH session polkit refuses it): try it first,
# so a failure of the inhibitor never prevents the game.
why="$app is running"
[ -n "$mw_setup" ] && why="MyWhoosh is being set up"
inhibit() { systemd-inhibit --what=idle:sleep --who=Rollout --why="$why" "$@"; }
if [ -z "${ROLLOUT_RUN_NO_INHIBIT:-}" ] && command -v systemd-inhibit >/dev/null 2>&1 && inhibit true >/dev/null 2>&1; then
  set -- systemd-inhibit --what=idle:sleep --who=Rollout --why="$why" "$up" "$@"
else
  set -- "$up" "$@"
fi
if [ -n "$fifo" ]; then "$@" > "$fifo" 2>&1 & elif [ -n "$grp" ]; then setsid "$@" & else "$@" & fi
pid=$!
if [ "$app" = zwift ]; then
  zw_every=${ROLLOUT_ZWIFT_SYNC_EVERY:-30}
  case $zw_every in ''|*[!0-9]*|0) ;; *) zw_sync_loop >/dev/null 2>&1 </dev/null & syncer=$! ;; esac
fi
while :; do
  wait "$pid"; code=$?
  if ! kill -0 "$pid" 2>/dev/null; then
    # A signal interrupted the wait and the game ended while forward was running (podman stop takes a while): fetch the real exit code.
    # If it was already collected (127), the first value counts.
    if [ "$sig" = 1 ] && [ "$code" -gt 128 ]; then wait "$pid" 2>/dev/null; again=$?; [ "$again" = 127 ] || code=$again; fi
    break
  fi
done
[ "$sig" = 1 ] && [ "$code" = 0 ] && code=143
[ -n "$syncer" ] && kill "$syncer" 2>/dev/null
if [ -n "$tee_pid" ]; then
  # tee ends once the game's last writer closes the FIFO. A leftover process that still holds it open must not keep the starter alive: KILL after 5 s.
  ( sleep 5; kill -s KILL "$tee_pid" ) >/dev/null 2>&1 </dev/null &
  dog=$!
  wait "$tee_pid" 2>/dev/null
  kill "$dog" 2>/dev/null
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) rollout-run: exit code $code" >> "$log" 2>/dev/null
fi
exit "$code"

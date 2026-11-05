#!/bin/sh
# rollout-bootstrap: 2
# Startet ein Spiel (Konzept 5.2), vom Launcher und von Steam gleich aufgerufen: rollout-run <mywhoosh|zwift> [Argumente].
# Weitere Aufrufe: rollout-run --container-check (nennt die nutzbare Container-Laufzeit, sonst Meldung und Exit 10) und
# rollout-run --zwift-pull (zieht das eingestellte Zwift-Image und merkt sich die Zustimmung, nur nach Bestätigung durch den Nutzer).
# Exit-Codes von Rollout selbst: 1 läuft schon, 2 Aufruf, 10 keine nutzbare Container-Laufzeit, 11 Zwift-Image nicht eingestellt,
# 12 Zwift-Image fehlt (keine Zustimmung oder Ziehen gescheitert), 127 Upstream fehlt. Sonst der Exit-Code des Spiels.
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

# --- Container-Laufzeit für Zwift (netbrain/zwift, Konzept 5.1, E7/E8) -------------------------------------------------------------
# Erkennt Podman vor Docker und prüft, ob die Laufzeit wirklich nutzbar ist (Dienst läuft, Rechte reichen). Setzt rt auf den
# Programmnamen oder gibt eine verständliche Meldung aus und liefert 1. Pakete installiert diese Schicht nie (Einrichtung: E8, später).
msg() { echo "Rollout: $*" >&2; }

# Ein Aufruf mit Zeitgrenze, damit ein hängender Docker-Dienst den Start nie festhält.
limited() { if command -v timeout >/dev/null 2>&1; then timeout 20 "$@"; else "$@"; fi; }

# rt_probe <Programm>: 0 nutzbar; sonst 1 und rt_why nennt den Grund in einem Satz.
rt_probe() {
  rt_why=
  if ! command -v "$1" >/dev/null 2>&1; then rt_why="$1 ist nicht installiert."; return 1; fi
  if rt_out=$(limited "$1" info 2>&1 </dev/null); then return 0; fi
  case $rt_out in
    *[Pp]ermission\ denied*) rt_why="$1 ist da, aber du hast keine Berechtigung (bei Docker fehlt oft die Gruppe „docker“; Podman braucht keine)." ;;
    *[Cc]annot\ connect*|*[Ii]s\ the\ docker\ daemon\ running*|*[Nn]o\ such\ file*|*[Cc]onnection\ refused*) rt_why="$1 ist da, aber der Dienst läuft nicht." ;;
    *subuid*|*subgid*|*newuidmap*|*newgidmap*) rt_why="$1 ist da, aber für deinen Benutzer sind keine Benutzer-IDs für Container eingerichtet (subuid/subgid)." ;;
    *) rt_why="$1 ist da, meldet aber einen Fehler: $(printf '%s\n' "$rt_out" | sed -n '1p' | cut -c1-160)" ;;
  esac
  return 1
}

# rt_detect: Podman vor Docker; ROLLOUT_CONTAINER_TOOL=podman|docker legt die Wahl fest.
rt_detect() {
  rt=
  case ${ROLLOUT_CONTAINER_TOOL:-} in
    '') rt_list="podman docker" ;;
    podman|docker) rt_list=$ROLLOUT_CONTAINER_TOOL ;;
    *) msg "ROLLOUT_CONTAINER_TOOL muss podman oder docker sein, nicht „$ROLLOUT_CONTAINER_TOOL“."; return 1 ;;
  esac
  rt_notes=
  for rt_try in $rt_list; do
    if rt_probe "$rt_try"; then rt=$rt_try; return 0; fi
    rt_notes="$rt_notes
  - $rt_why"
  done
  msg "Zwift läuft in einem Container, aber es gibt keine nutzbare Container-Laufzeit.$rt_notes"
  echo "  Gebraucht wird Podman (empfohlen) oder Docker. Auf Bazzite richtet der Einrichtungs-Assistent das später ein; bis dahin im Desktop-Modus einrichten." >&2
  return 1
}

# zwift_config: liest Image, Tag und Digest. Ein Tag ist Pflicht und nie „latest“ (kein stilles Mitwandern des Images).
# Quellen: Umgebung (ROLLOUT_ZWIFT_IMAGE, _TAG, _DIGEST), sonst zwift_tag und zwift_digest in config.toml.
conf=${ROLLOUT_CONFIG_HOME:-$HOME/.config/rollout}/config.toml
conf_get() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$conf" 2>/dev/null | sed -n '1p'; }
zwift_config() {
  zw_image=${ROLLOUT_ZWIFT_IMAGE:-docker.io/netbrain/zwift}
  zw_tag=${ROLLOUT_ZWIFT_TAG:-$(conf_get zwift_tag)}
  zw_digest=${ROLLOUT_ZWIFT_DIGEST:-$(conf_get zwift_digest)}
  case $zw_image in ''|[!a-z0-9]*|*..*|*[!a-z0-9./_:-]*) msg "ROLLOUT_ZWIFT_IMAGE ist ungültig: „$zw_image“."; return 1 ;; esac
  case $zw_tag in
    '') msg "Kein Zwift-Image eingestellt. Trage in $conf die Version von netbrain/zwift ein, zum Beispiel: zwift_tag = \"1.2.3\" (nicht „latest“)."; return 1 ;;
    latest|-*|.*|*[!A-Za-z0-9_.-]*) msg "Der Zwift-Tag „$zw_tag“ ist nicht zulässig. Erlaubt ist eine feste Version, nie „latest“."; return 1 ;;
  esac
  if [ -n "$zw_digest" ]; then
    zw_hex=${zw_digest#sha256:}
    case $zw_digest in sha256:*) ;; *) zw_hex=x ;; esac
    case $zw_hex in *[!0-9a-f]*) zw_hex=x ;; esac
    [ ${#zw_hex} = 64 ] || { msg "zwift_digest muss die Form sha256:<64 Hex-Zeichen> haben."; return 1; }
  fi
  zw_ref=$zw_image:$zw_tag
  zw_want=$zw_ref${zw_digest:+@$zw_digest}
}

# zwift_have: 0, wenn das Image lokal liegt (bei festem Digest: genau dieses).
zwift_have() {
  "$rt" image inspect "$zw_ref" >/dev/null 2>&1 </dev/null || return 1
  [ -z "$zw_digest" ] && return 0
  case $("$rt" image inspect --format '{{json .RepoDigests}}' "$zw_ref" 2>/dev/null </dev/null) in *"$zw_digest"*) return 0 ;; esac
  return 1
}

# zwift_pull: zieht das Image und merkt sich die Zustimmung für genau diese Angabe. Nur nach Bestätigung durch den Nutzer aufrufen.
zwift_pull() {
  msg "Lade $zw_want (mehrere GB, das dauert) …"
  if [ -n "$zw_digest" ]; then
    "$rt" pull "$zw_image@$zw_digest" </dev/null && "$rt" tag "$zw_image@$zw_digest" "$zw_ref" </dev/null
  else
    "$rt" pull "$zw_ref" </dev/null
  fi || { msg "Das Zwift-Image konnte nicht geladen werden (Netz, Speicherplatz oder Anmeldung bei der Registry)."; return 1; }
  mkdir -p "$state" && printf '%s\n' "$zw_want" > "$state/zwift-image-ok"
}

# zwift_prepare: Laufzeit, Image und Umgebung für netbrains zwift.sh. Gezogen wird nur mit Zustimmung für genau diese Angabe.
zwift_prepare() {
  rt_detect || return 10
  zwift_config || return 11
  if ! zwift_have; then
    if [ "$(sed -n '1p' "$state/zwift-image-ok" 2>/dev/null)" != "$zw_want" ]; then
      msg "Das Zwift-Image $zw_want ist noch nicht geladen. Es ist mehrere GB groß und wird nur nach deiner Bestätigung geladen: im Launcher bestätigen oder von Hand $0 --zwift-pull."
      return 12
    fi
    zwift_pull || return 12
  fi
  # DONT_UPDATE: Das Image ist festgelegt, zwift.sh zieht und prüft nichts selbst. ZWIFT_FG: Container im Vordergrund, damit Steam das Ende sieht.
  export CONTAINER_TOOL=$rt IMAGE=$zw_image VERSION=$zw_tag DONT_UPDATE=1 ZWIFT_FG=1
}

# Upstream je App: MyWhoosh liegt im Launcher-Release, Zwift ist das Startskript von netbrain/zwift unter zwift/<sha>/ (ROLLOUT_ZWIFT_SCRIPT ersetzt es).
case $app in
  --container-check) rt_detect || exit 10; echo "$rt"; exit 0 ;;
  --zwift-pull) rt_detect || exit 10; zwift_config || exit 11; zwift_pull || exit 12; exit 0 ;;
  mywhoosh) up=$home/current/vendor/mywhoosh.sh; set -- run "$@" ;;
  zwift) up=${ROLLOUT_ZWIFT_SCRIPT:-$(ls -td "$home"/zwift/*/zwift.sh 2>/dev/null | head -n 1)} ;;
  *) echo "Aufruf: rollout-run mywhoosh|zwift" >&2; exit 2 ;;
esac
[ -n "${ROLLOUT_RUN_UPSTREAM:-}" ] && up=$ROLLOUT_RUN_UPSTREAM
[ -n "$up" ] && [ -x "$up" ] || { echo "Rollout: Upstream für $app ist nicht installiert" >&2; exit 127; }
if [ "$app" = zwift ]; then zwift_prepare || exit $?; fi

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

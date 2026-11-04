#!/bin/sh
# Legt Rollout an den festen Pfad ~/.local/share/rollout (oder $ROLLOUT_HOME), Aufbau nach Konzept 4.3:
# bin/rollout (Wächter), bin/rollout-run (Spielstart), versions/<version>/, current, electron/<version>/, state/.
# Der Pfad bin/rollout ändert sich nie, deshalb bleiben Steam-Eintrag, Artwork und Spielzeit bei Updates erhalten.
# Ein alter Aufbau (app/dist, app/electron) zieht beim nächsten Lauf um und behält sein Electron.
# Aufruf nach `npm run build`: scripts/install.sh [Electron-Ordner]. Rollout dabei beenden.
# Ohne Angabe bleibt ein vorhandenes Electron, sonst wird node_modules/electron/dist genommen.
# REPLACE_ELECTRON=1 nimmt immer den angegebenen Ordner.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
home="${ROLLOUT_HOME:-$HOME/.local/share/rollout}"
given="${1:-${ELECTRON_DIR:-}}"

[ -d "$here/dist" ] || { echo "dist/ fehlt, erst 'npm run build' ausführen." >&2; exit 1; }

version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/package.json" | head -n 1)
case $version in ''|.*|*[!0-9a-zA-Z.+-]*) echo "Ungültige Version in package.json: '$version'" >&2; exit 1 ;; esac

electron_version() {
  if [ -r "$1/version" ]; then head -n 1 "$1/version"
  else ELECTRON_RUN_AS_NODE=1 "$1/electron" -p process.versions.electron; fi
}

mkdir -p "$home/bin" "$home/versions" "$home/electron" "$home/state"

# Welches Electron: angegebenes, sonst vorhandenes, sonst das aus node_modules.
source_dir=
if [ -n "$given" ] || [ "${REPLACE_ELECTRON:-0}" = 1 ]; then
  source_dir="${given:-$here/node_modules/electron/dist}"
elif [ -x "$home/app/electron/electron" ]; then
  source_dir="$home/app/electron"
elif [ -L "$home/current" ] && [ -r "$home/current/runtime" ] && [ -x "$home/electron/$(head -n 1 "$home/current/runtime")/electron" ]; then
  runtime=$(head -n 1 "$home/current/runtime")
else
  source_dir="$here/node_modules/electron/dist"
fi
if [ -n "$source_dir" ]; then
  [ -x "$source_dir/electron" ] || { echo "Electron nicht gefunden: $source_dir" >&2; echo "Ordner mit der Datei 'electron' als Argument angeben." >&2; exit 1; }
  runtime=$(electron_version "$source_dir")
  case $runtime in ''|.*|*[!0-9a-zA-Z.+-]*) echo "Electron-Version nicht lesbar: '$runtime'" >&2; exit 1 ;; esac
  if [ ! -x "$home/electron/$runtime/electron" ] || [ "${REPLACE_ELECTRON:-0}" = 1 ]; then
    rm -rf "$home/electron/.new"
    if [ "$source_dir" = "$home/app/electron" ]; then mv "$source_dir" "$home/electron/.new"
    else cp -a "$source_dir" "$home/electron/.new"; fi
    rm -rf "$home/electron/$runtime"
    mv "$home/electron/.new" "$home/electron/$runtime"
  fi
fi

# Neue Version bereitlegen, dann current per rename umlegen.
new="$home/versions/.new-$$"
rm -rf "$new"
mkdir -p "$new/bootstrap"
cp -r "$here/dist" "$new/dist"
cp "$here/package.json" "$new/package.json"
cp "$here/scripts/bin-rollout.sh" "$new/bootstrap/rollout"
cp "$here/scripts/bin-rollout-run.sh" "$new/bootstrap/rollout-run"
chmod +x "$new/bootstrap/rollout" "$new/bootstrap/rollout-run"
printf '%s\n' "$runtime" > "$new/runtime"
if [ -e "$home/versions/$version" ]; then
  mv "$home/versions/$version" "$home/versions/.old-$$"
fi
mv "$new" "$home/versions/$version"
rm -f "$home/.current.new"
ln -s "versions/$version" "$home/.current.new"
mv -T "$home/.current.new" "$home/current"
rm -rf "$home/versions/.old-$$"

# Alter Aufbau: nur noch Reste.
rm -rf "$home/app"

cp "$here/dist/renderer/assets/brand/logo.png" "$home/icon.png"
cp "$here/scripts/bin-rollout.sh" "$home/bin/.rollout.new"
chmod +x "$home/bin/.rollout.new"
mv -f "$home/bin/.rollout.new" "$home/bin/rollout"
cp "$here/scripts/bin-rollout-run.sh" "$home/bin/.rollout-run.new"
chmod +x "$home/bin/.rollout-run.new"
mv -f "$home/bin/.rollout-run.new" "$home/bin/rollout-run"

echo "Rollout $version liegt in $home (Electron $runtime)"
echo "Steam-Ziel: $home/bin/rollout (Spiele: $home/bin/rollout-run)"

#!/bin/sh
# Installs Rollout at the fixed path ~/.local/share/rollout (or $ROLLOUT_HOME), layout per concept 4.3:
# bin/rollout (watcher), bin/rollout-run (game start), versions/<version>/ (dist, vendor, bootstrap), current, electron/<version>/, state/.
# The path bin/rollout never changes, so the Steam entry, artwork and play time are preserved across updates.
# An old layout (app/dist, app/electron) is migrated on the next run and keeps its Electron.
# Usage after `npm run build`: scripts/install.sh [Electron directory]. Quit Rollout first.
# Without an argument an existing Electron stays, otherwise node_modules/electron/dist is used.
# REPLACE_ELECTRON=1 always takes the given directory.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
home="${ROLLOUT_HOME:-$HOME/.local/share/rollout}"
given="${1:-${ELECTRON_DIR:-}}"

[ -d "$here/dist" ] || { echo "dist/ is missing, run 'npm run build' first." >&2; exit 1; }

version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/package.json" | head -n 1)
case $version in ''|.*|*[!0-9a-zA-Z.+-]*) echo "Invalid version in package.json: '$version'" >&2; exit 1 ;; esac

electron_version() {
  if [ -r "$1/version" ]; then head -n 1 "$1/version"
  else ELECTRON_RUN_AS_NODE=1 "$1/electron" -p process.versions.electron; fi
}

mkdir -p "$home/bin" "$home/versions" "$home/electron" "$home/state"

# Which Electron: the given one, otherwise the existing one, otherwise the one from node_modules.
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
  [ -x "$source_dir/electron" ] || { echo "Electron not found: $source_dir" >&2; echo "Pass the directory containing the file 'electron' as an argument." >&2; exit 1; }
  runtime=$(electron_version "$source_dir")
  case $runtime in ''|.*|*[!0-9a-zA-Z.+-]*) echo "Electron version not readable: '$runtime'" >&2; exit 1 ;; esac
  if [ ! -x "$home/electron/$runtime/electron" ] || [ "${REPLACE_ELECTRON:-0}" = 1 ]; then
    rm -rf "$home/electron/.new"
    if [ "$source_dir" = "$home/app/electron" ]; then mv "$source_dir" "$home/electron/.new"
    else cp -a "$source_dir" "$home/electron/.new"; fi
    rm -rf "$home/electron/$runtime"
    mv "$home/electron/.new" "$home/electron/$runtime"
  fi
fi

# Stage the new version, then switch current by rename.
new="$home/versions/.new-$$"
rm -rf "$new"
mkdir -p "$new/bootstrap"
cp -r "$here/dist" "$new/dist"
cp -r "$here/vendor" "$new/vendor"
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

# Old layout: only leftovers.
rm -rf "$home/app"

cp "$here/dist/renderer/assets/brand/logo.png" "$home/icon.png"
cp "$here/scripts/bin-rollout.sh" "$home/bin/.rollout.new"
chmod +x "$home/bin/.rollout.new"
mv -f "$home/bin/.rollout.new" "$home/bin/rollout"
cp "$here/scripts/bin-rollout-run.sh" "$home/bin/.rollout-run.new"
chmod +x "$home/bin/.rollout-run.new"
mv -f "$home/bin/.rollout-run.new" "$home/bin/rollout-run"

echo "Rollout $version is in $home (Electron $runtime)"
echo "Steam-Ziel: $home/bin/rollout (Spiele: $home/bin/rollout-run)"

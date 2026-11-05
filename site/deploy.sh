#!/usr/bin/env bash
# Website veröffentlichen: bauen, prüfen, site/dist in einen Worktree des Branches gh-pages kopieren, committen, pushen.
# GitHub Pages: „Deploy from branch“, Branch gh-pages, Ordner / (kein Actions-Workflow, kein Kontingent nötig).
#
#   site/deploy.sh              baut, prüft, committet lokal und fragt vor dem Push nach
#   site/deploy.sh --no-push    wie oben, aber ohne Push (Ergebnis liegt im lokalen Branch gh-pages)
#   site/deploy.sh --yes        pusht ohne Rückfrage
#   site/deploy.sh --no-asset-check   überspringt die Prüfung, ob Rollout.desktop als Release-Datei existiert
#
# Voraussetzung: Rollout.desktop ist als Asset des neuesten (nicht als Vorabversion markierten) Releases hochgeladen,
# sonst sind die Download-Knöpfe tot. Die Pages-Aktivierung (Einstellungen oder `gh api`) ist ein eigener, vorher abgesprochener Schritt.
set -euo pipefail

PUSH=ask; ASSET_CHECK=1
for arg in "$@"; do
  case "$arg" in
    --no-push) PUSH=no ;;
    --yes) PUSH=yes ;;
    --no-asset-check) ASSET_CHECK=0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done

SITE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$SITE_DIR" rev-parse --show-toplevel)
REMOTE=${REMOTE:-origin}
BRANCH=gh-pages
ASSET_URL="https://github.com/mace-ops/rollout-cycling-launcher-linux/releases/latest/download/Rollout.desktop"

cd "$SITE_DIR"
[ -d node_modules ] || npm ci
echo "→ Bauen und prüfen"
npm test

if [ "$ASSET_CHECK" = 1 ]; then
  echo "→ Prüfe Download-Datei"
  if ! curl -fsIL -o /dev/null "$ASSET_URL"; then
    echo "✗ $ASSET_URL ist nicht erreichbar. Rollout.desktop muss als Release-Asset des neuesten Releases existieren (ein Release, das als Vorabversion markiert ist, zählt für /releases/latest/ nicht)." >&2
    echo "  Mit --no-asset-check überspringen, wenn du das bewusst willst." >&2
    exit 1
  fi
fi

WT=$(mktemp -d)
cleanup() { git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$WT"; }
trap cleanup EXIT

git -C "$REPO" fetch "$REMOTE" "$BRANCH" >/dev/null 2>&1 || true
if git -C "$REPO" show-ref --verify --quiet "refs/remotes/$REMOTE/$BRANCH"; then
  git -C "$REPO" worktree add -f -B "$BRANCH" "$WT" "$REMOTE/$BRANCH" >/dev/null
else
  git -C "$REPO" worktree add -f --detach "$WT" HEAD >/dev/null
  git -C "$WT" checkout --orphan "$BRANCH" >/dev/null 2>&1
  git -C "$WT" rm -rf . >/dev/null 2>&1 || true
fi

# Inhalt ersetzen (alles außer .git)
find "$WT" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a "$SITE_DIR/dist/." "$WT/"
touch "$WT/.nojekyll"

git -C "$WT" add -A
if git -C "$WT" diff --cached --quiet; then
  echo "Keine Änderung gegenüber $REMOTE/$BRANCH, nichts zu veröffentlichen."
  exit 0
fi
git -C "$WT" diff --cached --stat | tail -5
SRC=$(git -C "$REPO" rev-parse --short HEAD)
git -C "$WT" commit -q -m "Website aus ${SRC} ($(date +%Y-%m-%d))"
echo "✓ Commit im Branch $BRANCH angelegt"

if [ "$PUSH" = ask ]; then
  read -r -p "Jetzt nach $REMOTE/$BRANCH pushen? [j/N] " answer
  case "$answer" in j|J|y|Y) PUSH=yes ;; *) PUSH=no ;; esac
fi
if [ "$PUSH" = yes ]; then
  git -C "$WT" push "$REMOTE" "$BRANCH"
  echo "✓ Gepusht. Adresse: https://mace-ops.github.io/rollout-cycling-launcher-linux/"
else
  echo "Nicht gepusht. Lokaler Branch $BRANCH enthält die Veröffentlichung."
fi

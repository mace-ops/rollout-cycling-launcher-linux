#!/usr/bin/env bash
# Publish the website: build, check, copy site/dist into a worktree of the gh-pages branch, commit, push.
# GitHub Pages: "Deploy from branch", branch gh-pages, folder / (no Actions workflow, no quota needed).
#
#   site/deploy.sh              builds, checks, commits locally and asks before pushing
#   site/deploy.sh --no-push    as above, but without a push (the result stays in the local gh-pages branch)
#   site/deploy.sh --yes        pushes without asking
#   site/deploy.sh --no-asset-check   skips the check that Rollout.desktop exists as a release file
#
# Prerequisite: Rollout.desktop is uploaded as an asset of the latest release (not marked as a prerelease),
# otherwise the download buttons are dead. Enabling Pages (settings or `gh api`) is a separate step to be agreed beforehand.
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
echo "→ Build and check"
npm test

if [ "$ASSET_CHECK" = 1 ]; then
  echo "→ Checking download file"
  if ! curl -fsIL -o /dev/null "$ASSET_URL"; then
    echo "✗ $ASSET_URL is not reachable. Rollout.desktop must exist as a release asset of the latest release (a release marked as a prerelease does not count for /releases/latest/)." >&2
    echo "  Skip with --no-asset-check if you do this deliberately." >&2
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

# Replace content (everything except .git)
find "$WT" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a "$SITE_DIR/dist/." "$WT/"
touch "$WT/.nojekyll"

git -C "$WT" add -A
if git -C "$WT" diff --cached --quiet; then
  echo "No change compared with $REMOTE/$BRANCH, nothing to publish."
  exit 0
fi
git -C "$WT" diff --cached --stat | tail -5
SRC=$(git -C "$REPO" rev-parse --short HEAD)
git -C "$WT" commit -q -m "Website from ${SRC} ($(date +%Y-%m-%d))"
echo "✓ Commit created on branch $BRANCH"

if [ "$PUSH" = ask ]; then
  read -r -p "Push to $REMOTE/$BRANCH now? [y/N] " answer
  case "$answer" in y|Y|j|J) PUSH=yes ;; *) PUSH=no ;; esac
fi
if [ "$PUSH" = yes ]; then
  git -C "$WT" push "$REMOTE" "$BRANCH"
  echo "✓ Pushed. Address: https://mace-ops.github.io/rollout-cycling-launcher-linux/"
else
  echo "Not pushed. The local branch $BRANCH contains the publication."
fi

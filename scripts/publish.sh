#!/usr/bin/env bash
# Pushes main and, when package.json carries a version that has no GitHub
# release yet, runs the release (npm run release). Use it instead of a plain
# `git push`: a push without a version bump just pushes (and deploys the web
# app as before).
#
#   scripts/publish.sh            push, then release if the version is new
#   scripts/publish.sh --dry-run  print what would happen and the notes; no
#                                 push, no build, no release
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="jprabadi-ship-it/ConductorD-keymap-editor"
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
  echo "エラー: main ブランチで実行してください。" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "エラー: コミットしていない変更があります。リリースする内容をコミットしてから実行してください。" >&2
  exit 1
fi

# A name that never appears in the published history must not arrive with a
# push: it is how a real name once came back after being scrubbed from it.
git fetch -q origin main
UNKNOWN=$(comm -13 <(git log --format='%an%n%cn' origin/main | sort -u) \
                   <(git log --format='%an%n%cn' origin/main..HEAD | sort -u))
if [ -n "$UNKNOWN" ]; then
  echo "エラー: まだ push していないコミットに、公開済みの履歴にない作者名があります。" >&2
  printf '  %s\n' "$UNKNOWN" >&2
  echo "作者名を直してから実行してください（git rebase --exec 'git commit --amend --no-edit --reset-author' など）。" >&2
  exit 1
fi

ALREADY_RELEASED=false
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 && ALREADY_RELEASED=true

if [ "${1:-}" = "--dry-run" ]; then
  echo "バージョン: ${VERSION}（タグ ${TAG}）"
  if [ "$ALREADY_RELEASED" = true ]; then
    echo "→ 公開済みのため、push だけ行います。"
  else
    echo "→ push のあと、npm run release で dmg を作って Release を公開します。ノートは次のとおりです。"
    echo "-----"
    node scripts/release-notes.mjs "$VERSION"
    echo "-----"
  fi
  exit 0
fi

git push origin main

if [ "$ALREADY_RELEASED" = true ]; then
  echo "${TAG} は公開済みなので、リリースはしません（push のみ）。"
  exit 0
fi

# release.sh compares HEAD with origin/main, so it has to run after the push.
npm run release

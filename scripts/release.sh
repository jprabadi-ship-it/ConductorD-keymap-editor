#!/usr/bin/env bash
# One-command release: build the Electron DMG for the current package.json
# version and publish it as a GitHub release, with the safety checks that
# would have caught the 2026-07-12 incident where a version bump got pushed
# (deploying the web app) with no matching DMG ever built/released, leaving
# the download button pointing at a 404.
#
# Usage: npm run release
#
# Expects: version already bumped in package.json AND a matching changelog
# entry already added to src/components/Header/Header.tsx, both committed
# and pushed to origin/main, before running this.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="jprabadi-ship-it/ConductorD-keymap-editor"
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

echo "==> Releasing ${REPO} ${TAG}"

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

echo "==> Checking local HEAD matches origin/main (so the DMG matches what's live on Pages)"
git fetch origin main --quiet
LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse origin/main)
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  echo "ERROR: local HEAD (${LOCAL_SHA}) does not match origin/main (${REMOTE_SHA})." >&2
  echo "Push your commit first so the web deploy and this DMG are built from the same commit." >&2
  exit 1
fi

echo "==> Checking release ${TAG} doesn't already exist"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "ERROR: release ${TAG} already exists: https://github.com/${REPO}/releases/tag/${TAG}" >&2
  echo "Bump the version (and add a changelog entry) if you meant to ship something new." >&2
  exit 1
fi

echo "==> Checking Header.tsx has a changelog entry for ${VERSION}"
if ! grep -q "v: '${VERSION}\.0'" src/components/Header/Header.tsx; then
  echo "ERROR: no changelog entry for '${VERSION}.0' found in src/components/Header/Header.tsx." >&2
  echo "Add one describing this release (see feedback_editor_version_bump memory) before releasing." >&2
  exit 1
fi

echo "==> Checking notarization credentials"
# mac.notarize=true (package.json) makes electron-builder submit the app to
# Apple's notary service; it reads the keychain profile named by
# APPLE_KEYCHAIN_PROFILE. Create the profile once with:
#   xcrun notarytool store-credentials "conductorD-notary" \
#     --apple-id <Apple ID> --team-id 3HCG7Y94FX --password <app-specific password>
export APPLE_KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-conductorD-notary}"
if ! security find-generic-password -s "com.apple.gke.notary.tool" >/dev/null 2>&1; then
  echo "ERROR: no notarytool credentials in the keychain." >&2
  echo "Run: xcrun notarytool store-credentials \"conductorD-notary\" --apple-id <Apple ID> --team-id 3HCG7Y94FX --password <app-specific password>" >&2
  exit 1
fi

echo "==> Building Electron app (signing + notarization -- the notary upload can take a few minutes)"
npm run electron:build

DMG_SRC="dist/ConductorD Studio-${VERSION}-arm64.dmg"
if [ ! -f "$DMG_SRC" ]; then
  echo "ERROR: expected DMG not found at '${DMG_SRC}' -- did electron-builder's output name change?" >&2
  exit 1
fi

STAMP=$(TZ=Asia/Tokyo date +%Y%m%d-%H%M)
VERSIONED_DMG="dist/ConductorD-Studio-${VERSION}-mac-arm64.dmg"
DATED_DMG="dist/ConductorD-Studio-${VERSION}-${STAMP}-mac-arm64.dmg"
LATEST_DMG="dist/ConductorD-Studio-mac-arm64.dmg"
cp "$DMG_SRC" "$VERSIONED_DMG"
cp "$DMG_SRC" "$DATED_DMG"
cp "$DMG_SRC" "$LATEST_DMG"

echo "==> Creating GitHub release ${TAG}"
gh release create "$TAG" "$VERSIONED_DMG" "$DATED_DMG" "$LATEST_DMG" \
  --repo "$REPO" \
  --title "$TAG" \
  --notes "Built ${STAMP} JST. See in-app Version History (Header > Changelog) for details."

echo "==> Verifying the versioned download URL resolves"
DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/ConductorD-Studio-${VERSION}-mac-arm64.dmg"
sleep 3
HTTP_STATUS=$(curl -sI -o /dev/null -w "%{http_code}" "$DOWNLOAD_URL")
if [ "$HTTP_STATUS" != "302" ]; then
  echo "WARNING: expected a 302 redirect from ${DOWNLOAD_URL}, got ${HTTP_STATUS}. Check the release assets." >&2
else
  echo "OK: ${DOWNLOAD_URL} resolves (302)"
fi

echo "==> Done: https://github.com/${REPO}/releases/tag/${TAG}"

#!/usr/bin/env bash
# Builds the PUBLIC firmware zip out of the private firmware repo's
# "firmware-latest" release, and optionally attaches it to a release here.
#
# The firmware source repo stays private; this repo is public, and the web
# build's "FW download" button points at this repo's latest release -- so a
# visitor who is not signed in to GitHub can still get the firmware. That
# only works while EVERY release here carries the zip, which is why
# release.sh calls this and refuses to publish without it.
#
# What goes in is an allow-list, on purpose: the five flashable .uf2 files
# and a short README. The private zip also holds a debug ELF (function names
# and source paths), the R_debug build, the internal changelog and the
# dependency SHA table -- none of that is copied.
#
#   scripts/firmware-asset.sh                 build the zips, print their paths
#   scripts/firmware-asset.sh --upload [TAG]  ...and attach them to TAG
#                                             (default: the latest release),
#                                             replacing older firmware assets
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="jprabadi-ship-it/ConductorD-keymap-editor"
FW_REPO="jprabadi-ship-it/conductor"
OUT="release/firmware-public"
SRC="${OUT}/src"   # the downloaded archive and its extraction, nothing else
PUB="${OUT}/pub"   # exactly what gets zipped

log() { echo "$@" >&2; }

mkdir -p "$SRC" "$PUB"
find "$OUT" -type f -delete

SRC_ZIP=$(gh release view firmware-latest --repo "$FW_REPO" --json assets \
  -q '[.assets[].name | select(test("^ConductorD-firmware-latest-[0-9]{8}-[0-9]{4}\\.zip$"))] | sort | last // empty')
if [ -z "$SRC_ZIP" ]; then
  log "ERROR: no dated firmware zip on ${FW_REPO}'s firmware-latest release (is gh signed in with access to it?)."
  exit 1
fi
STAMP=${SRC_ZIP#ConductorD-firmware-latest-}
STAMP=${STAMP%.zip}

log "==> Fetching ${SRC_ZIP} from the private firmware release"
gh release download firmware-latest --repo "$FW_REPO" --pattern "$SRC_ZIP" --dir "$SRC"
unzip -q "${SRC}/${SRC_ZIP}" -d "${SRC}/x"

# One file per unit, matched by prefix so a firmware version bump needs no
# edit here; anything else in the archive is left behind.
for prefix in R_ConductorD_ L_ConductorD_ dongle_ConductorD_ R_dongle_mode_ConductorD_ reset_ConductorD_; do
  match=$(find "${SRC}/x" -maxdepth 1 -type f -name "${prefix}*.uf2" | head -1)
  if [ -z "$match" ]; then
    log "ERROR: ${prefix}*.uf2 is missing from ${SRC_ZIP}."
    exit 1
  fi
  cp "$match" "$PUB/"
done

BUILT="${STAMP:0:4}-${STAMP:4:2}-${STAMP:6:2} ${STAMP:9:2}:${STAMP:11:2} JST"
cat > "${PUB}/README.txt" <<README
ConductorD ファームウェア
ビルド: ${BUILT}

入っているファイル
  R_ConductorD_*.uf2              右手側。単体(ドングルなし)で使うとき
  L_ConductorD_*.uf2              左手側
  dongle_ConductorD_*.uf2         ドングル
  R_dongle_mode_ConductorD_*.uf2  右手側。ドングルと組み合わせて使うとき
  reset_ConductorD_*.uf2          設定の初期化用(ペアリングをやり直すとき)

書き込み方
  1. 書き込みたい本体のリセットボタンを素早く2回押す
  2. パソコンに現れたドライブへ、対応する .uf2 をコピーする
  3. 自動で再起動する(設定とペアリングは消えません)

設定の変更は ConductorD Studio から行えます。
  https://studio.gigowat.com/

このファームウェアは ZMK Firmware (MIT License) と Zephyr RTOS
(Apache License 2.0) をもとにしています。
  https://github.com/zmkfirmware/zmk
  https://github.com/zephyrproject-rtos/zephyr
README

FIXED="${OUT}/ConductorD-firmware-latest.zip"
DATED="${OUT}/ConductorD-firmware-latest-${STAMP}.zip"
(cd "$PUB" && zip -q -X "../ConductorD-firmware-latest.zip" ./*)
cp "$FIXED" "$DATED"
log "==> Public firmware zip: $(unzip -l "$FIXED" | tail -1 | awk '{print $2 " files, " $1 " bytes"}')"

if [ "${1:-}" = "--upload" ]; then
  TAG="${2:-$(gh release view --repo "$REPO" --json tagName -q .tagName)}"
  # Drop firmware zips from an earlier build so only the current pair is
  # listed (the dated name changes with every firmware build).
  for old in $(gh release view "$TAG" --repo "$REPO" --json assets \
      -q '.assets[].name | select(test("^ConductorD-firmware-latest(-[0-9]{8}-[0-9]{4})?\\.zip$"))'); do
    gh release delete-asset "$TAG" "$old" --repo "$REPO" -y >&2
  done
  gh release upload "$TAG" "$FIXED" "$DATED" --repo "$REPO" >&2
  log "==> Attached to ${TAG}"
fi

printf '%s\n%s\n' "$FIXED" "$DATED"

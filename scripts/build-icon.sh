#!/bin/bash
# Regenerates build/icon.png and build/icon.icns from build/icon.svg on macOS.
# Needs qlmanage and iconutil (both ship with macOS) and ImageMagick (`magick`).
set -euo pipefail
cd "$(dirname "$0")/.."
work="$(mktemp -d)"
trap 'rm -rf "${work:?}"' EXIT
qlmanage -t -s 1024 -o "$work" build/icon.svg >/dev/null 2>&1
magick "$work/icon.svg.png" \
  \( -size 1024x1024 xc:none -fill white -draw "roundrectangle 0,0 1023,1023 228,228" \) \
  -compose DstIn -composite -define png:color-type=6 build/icon.png
set_dir="$work/AgentTeam.iconset"
mkdir "$set_dir"
for s in 16 32 128 256 512; do
  magick build/icon.png -resize "${s}x${s}" "$set_dir/icon_${s}x${s}.png"
  magick build/icon.png -resize "$((s * 2))x$((s * 2))" "$set_dir/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$set_dir" -o build/icon.icns
echo "wrote build/icon.png and build/icon.icns"

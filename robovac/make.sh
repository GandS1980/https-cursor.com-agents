#!/usr/bin/env bash
# Full pipeline: path-trace every frame (resumable), synthesize the soundtrack, mux.
#   ./make.sh            # SwiftShader (CPU) - works anywhere Chromium runs
#   GPU=1 ./make.sh      # use the machine's real GPU through ANGLE
set -euo pipefail
cd "$(dirname "$0")"
RES=${RES:-768x432}
SPP=${SPP:-2}
OUT=${OUT:-out}
mkdir -p "$OUT"
node src/render.js --out "$OUT" --res "$RES" --spp "$SPP" --maxn 12 --denoise 3 ${GPU:+--gpu}
node src/audio.js "$OUT/audio.wav"
cat "$OUT"/frames/*.rgb | ffmpeg -y -loglevel error -stats \
  -f rawvideo -pix_fmt rgb24 -s "$RES" -r 30 -i - -i "$OUT/audio.wav" \
  -vf "scale=1280:720:flags=lanczos" -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart -shortest "$OUT/robovac.mp4"
echo "wrote $OUT/robovac.mp4"

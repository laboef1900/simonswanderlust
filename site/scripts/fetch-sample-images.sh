#!/usr/bin/env bash
# Downloads sample hero images from the live site. Images are gitignored
# (no binaries in git, per repo policy); run this after a fresh clone.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)/src/assets/trips"
mkdir -p "$dir"
curl -fsSL "https://simonswanderlust.com/wp-content/uploads/2023/12/Header-%CE%A1%CF%8C%CE%B4%CE%BF%CF%82-22.07.2021-153252-1-scaled-1-jpg.webp" -o "$dir/rhodos.webp"
curl -fsSL "https://simonswanderlust.com/wp-content/uploads/2024/10/Bucharest-2.10.2024-144335-768x512.webp" -o "$dir/bucharest.webp"
echo "ok: $(ls "$dir" | tr '\n' ' ')"

#!/bin/bash
# Downloads the pet sprites into pet/packs for local use only.
# The sprites are third-party fan/game assets and are NOT included in this repository.
# Pokémon: PokeAPI sprites (Gen V animated). Digimon: kaisadilla/digimon-sprite-collection.
set -euo pipefail
cd "$(dirname "$0")/../pet"

POKE=https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated
mkdir -p packs/pokemon/pool
for pair in pikachu:25 eevee:133 bulbasaur:1 charmander:4 squirtle:7 psyduck:54 jigglypuff:39 meowth:52 gengar:94 mewtwo:150 lapras:131 snorlax:143; do
  name=${pair%%:*}; id=${pair##*:}
  curl -sfL -o "packs/pokemon/pool/$name.gif" "$POKE/$id.gif"
done

DIGI=https://raw.githubusercontent.com/kaisadilla/digimon-sprite-collection/main/public/img/sprites/digimon
mkdir -p packs/digimon/pool
for f in vpet/agumon vpet/angemon vpet/airdramon vpet/betamon vpet/togemon toei/angemon toei/togemon toei/airdramon digivice_tall/agumon; do
  curl -sfL -o "packs/digimon/pool/$(echo "$f" | tr / _).gif" "$DIGI/$f.gif"
done

# Make opaque GIF backgrounds transparent (flood fill from the corners). Needs Pillow; otherwise keep the GIFs as-is.
if python3 -c 'import PIL' 2>/dev/null; then
  python3 - packs/digimon/pool <<'PY'
import glob, os, sys
from collections import deque
from PIL import Image
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*.gif"))):
    im = Image.open(f).convert("RGBA"); w, h = im.size
    px = im.load(); bg = px[0, 0]
    if bg[3] != 0:
        seen, q = set(), deque([(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)])
        near = lambda c: all(abs(c[i] - bg[i]) <= 24 for i in range(3))
        while q:
            x, y = q.popleft()
            if (x, y) in seen or not (0 <= x < w and 0 <= y < h): continue
            seen.add((x, y))
            if not near(px[x, y]): continue
            px[x, y] = (0, 0, 0, 0); q.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])
    im.save(f[:-4] + ".png"); os.remove(f)
PY
else
  echo "Pillow not found: Digimon sprites kept as GIF (backgrounds not removed)."
fi
echo "Sprites saved under pet/packs (local only)."

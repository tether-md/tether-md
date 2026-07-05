# Anchors animation — regenerate

Fully headless render of `docs/assets/anchors.gif` (replaces the old VHS `anchors.tape`): `scene.html` is a deterministic editor mockup driven by `window.seek(tMs)`, captured with the shared `../hero/capture.mjs` at 15 fps via system Chrome.

```sh
mkdir -p /tmp/anchors && cd /tmp/anchors && npm init -y && npm i playwright-core && cp <repo>/docs/assets/tapes/hero/capture.mjs . \
  && node capture.mjs <repo>/docs/assets/tapes/anchors/scene.html frames 13000 1000 560 \
  && ffmpeg -y -framerate 15 -i frames/frame_%04d.png -vf "scale=1000:-1:flags=lanczos,palettegen=max_colors=160" palette.png \
  && ffmpeg -y -framerate 15 -i frames/frame_%04d.png -i palette.png -lavfi "scale=1000:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4" <repo>/docs/assets/anchors.gif
```

Note: run `capture.mjs` from the scratch dir (ESM resolves `playwright-core` relative to the script), and adjust the Chrome path at the top of `capture.mjs` if not on macOS.

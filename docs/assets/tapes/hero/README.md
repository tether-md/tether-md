# Hero animation — regenerate

Fully headless render of `docs/assets/hero.gif` (no recording): `scene.html` is a deterministic mockup driven by `window.seek(tMs)`; `capture.mjs` screenshots it at 15 fps via system Chrome.

```sh
mkdir -p /tmp/hero && cd /tmp/hero && npm init -y && npm i playwright-core && cp <repo>/docs/assets/tapes/hero/capture.mjs . \
  && node capture.mjs <repo>/docs/assets/tapes/hero/scene.html frames 18000 1000 640 \
  && ffmpeg -y -framerate 15 -i frames/frame_%04d.png -vf "scale=1000:-1:flags=lanczos,palettegen=max_colors=160" palette.png \
  && ffmpeg -y -framerate 15 -i frames/frame_%04d.png -i palette.png -lavfi "scale=1000:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4" <repo>/docs/assets/hero.gif
```

Note: run `capture.mjs` from the scratch dir (ESM resolves `playwright-core` relative to the script), and adjust the Chrome path at the top of `capture.mjs` if not on macOS.

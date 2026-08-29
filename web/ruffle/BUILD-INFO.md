# RTMP-capable Ruffle build

This is the only Ruffle distribution shipped with Shararam Ruffle.

- source: <https://github.com/sadfun/ruffle>
- branch: `shararam/layer-inline` (on top of `shararam/rtmp-netconnection`)
- revision: `bb27d1c08`
- adds: backdrop-independent `BlendMode.LAYER` groups render inline instead
  of through screen-sized offscreen surfaces (pixel-identical, measured
  9.2 -> 28.7 fps in a crowded location at Retina). Safety valve: web config
  option `layerBlendInlining` (default `true`), wired to the
  `SHARARAM_LAYER_INLINE` env variable of the server.
- built with the standard `npm run build` pipeline (includes wasm-opt).

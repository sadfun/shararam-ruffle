# RTMP-capable Ruffle build

This is the only Ruffle distribution shipped with Shararam Ruffle.

- source: <https://github.com/sadfun/ruffle>
- branch: `shararam/perf` (on top of `shararam/layer-inline` → `shararam/rtmp-netconnection`)
- revision: `971dd6c0d`
- adds, on top of upstream Ruffle:
  - backdrop-independent `BlendMode.LAYER` groups render inline instead of
    through screen-sized offscreen surfaces (pixel-identical, 9.2 → 28.7 fps
    in a crowded location at Retina). Safety valve: web config option
    `layerBlendInlining` (default `true`), wired to `SHARARAM_LAYER_INLINE`
    of the server;
  - other blend groups render into offscreen targets sized to the group's
    bounds instead of the whole frame (house with the samovar table:
    7.6 → 17 fps);
  - `BlendMode.MULTIPLY` on an opaque frame composites with a GPU blend state
    instead of a backdrop snapshot + shader pass (same room: 17 → 32–41 fps,
    GPU wait 144 → 28–31 ms);
  - AVM1 `loadMovie` of an already loaded URL reuses the parsed movie and its
    character library (Shararam loads one rig SWF per avatar part per avatar;
    repeats were 79% of preload time — now ~0 ms each).
- built with the standard `npm run build` pipeline (includes wasm-opt).

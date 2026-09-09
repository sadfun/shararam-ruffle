# Profiler-instrumented Ruffle build

Served at `/ruffle/` **only** by profiling builds of the client
(`--features profiler`); regular builds embed `web/ruffle/` instead and
never include this directory.

- source: <https://github.com/sadfun/ruffle>
- branch: `shararam/render-opt` (on top of `shararam/rtmp-netconnection`)
- revision: `4a67bd03e` (frees the library of a loaded movie once no root
  clip plays it — upstream keeps every `loadMovie`'s characters, renderer
  meshes, bitmaps, fonts and SWF bytes for the life of the player, which is
  why the post-GC heap only ever grew; on top of `24e5f275d`: parsed-movie
  cache — AVM1 loadMovie of an already preloaded URL shares the movie and
  its library; multiply composited with a blend state on the opaque frame;
  blend groups rendered into bounds-sized offscreen targets; plus the AVM1
  stack sampler with position labels for anonymous functions, allocation
  counters, screen command grid, Array.sort span — see
  `docs/SHARARAM-PROFILER.md`)
- build: `cd web && npm run build:shararam-profiler`
  (release profile + wasm-opt, identical to a regular build except for the
  `shararam_profiler` cargo feature)
- what the feature adds: a low-overhead event recorder
  (`core/src/profiler.rs` in the fork) exposed to the page as
  `window.__ruffleProfiler`; see `docs/SHARARAM-PROFILER.md` in the fork.

To refresh after changing the fork:

```sh
cd ../ruffle-shararam-profiler/web
npm run build:shararam-profiler
cp packages/selfhosted/dist/ruffle.js \
   packages/selfhosted/dist/core.ruffle.*.js \
   packages/selfhosted/dist/*.wasm \
   ../../shararam-ruffle/web-profiler/ruffle/
```
(remove the previously committed `core.ruffle.*.js` / `*.wasm` pair when
the hash changes)

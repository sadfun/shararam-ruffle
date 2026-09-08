# Profiler-instrumented Ruffle build

Served at `/ruffle/` **only** by profiling builds of the client
(`--features profiler`); regular builds embed `web/ruffle/` instead and
never include this directory.

- source: <https://github.com/sadfun/ruffle>
- branch: `shararam/render-opt` (on top of `shararam/rtmp-netconnection`)
- revision: `8b9d74a7f` (blend groups rendered into bounds-sized
  offscreen targets — 8.8→37.6 fps on a multiply-heavy room; plus the AVM1
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

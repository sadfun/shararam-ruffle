# RTMP-capable Ruffle build

This is the only Ruffle distribution shipped with Shararam Live.

- source: <https://github.com/sadfun/ruffle>
- branch: `shararam/rtmp-netconnection`
- revision: `fee366f346` (authorship rewrite of build revision `179dda526`;
  identical tree)
- AMF dependency revision: `f0abe69` (rust-flash-lso pinned locally at build
  time; commit `11d599c028` switches to upstream rev `61b7172`)
- baseline: `29de3055511aa8cd1239df850f853be1c1daa612`
- target: self-hosted web release with `web-wasm-extensions`
- RTMP/AMF/RPC: implemented generically inside Ruffle core
- browser transport: existing raw-socket backend over one binary WebSocket
- active assets: `ruffle.js`, `core.ruffle.3cbd9e620af7bb38249e.js`,
  `ec9a59ace008ae15942d.wasm`

The bundle contains no Shararam command names, patched SWFs or application-
protocol gateway. The shipped hashes correspond to `fee366f346` plus the
pinned AMF checkout; rebuild from the branch head `b298ed3d1` to produce
functionally identical assets with the public upstream AMF dependency.

"use strict";

// Spread `/official/fs/` loads over the extra loopback listeners the client
// opened (see src-tauri/src/main.rs): a browser allows six connections per
// origin, so a few slow upstream downloads would otherwise queue every other
// asset — disk-cache hits included — behind them. Ruffle calls window.fetch,
// so rewriting here reaches every SWF load without touching the game.
(() => {
  const ports = (document.querySelector('meta[name="shararam-asset-ports"]')?.content || "")
    .split(",").map(Number).filter(port => Number.isInteger(port) && port > 0);
  if (!ports.length || !["127.0.0.1", "localhost"].includes(location.hostname)) return;
  const prefix = `${location.origin}/official/fs/`;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), location.href).href;
    const method = (init?.method || request?.method || "GET").toUpperCase();
    const ranged = Boolean(request?.headers?.has("range") || (init?.headers && new Headers(init.headers).has("range")));
    if (method !== "GET" || ranged || !url.startsWith(prefix)) return nativeFetch(input, init);
    let hash = 0;
    for (const char of url.slice(prefix.length)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const shard = `http://${location.hostname}:${ports[hash % ports.length]}${url.slice(location.origin.length)}`;
    return nativeFetch(shard, { ...(init || {}), method: "GET", mode: "cors", credentials: "include" });
  };
})();

window.RufflePlayer = window.RufflePlayer || {};
window.RufflePlayer.config = {
  autoplay: "on",
  unmuteOverlay: "hidden",
  backgroundColor: "#72ccec",
  allowScriptAccess: true,
  allowNetworking: "all",
  playerVersion: [23, 0, 0, 162],
  publicPath: "/ruffle/",
  polyfills: false,
  scale: "showAll",
  forceScale: true,
  // Clip to the stage: without this the movie paints outside its own bounds.
  letterbox: "on",
  urlRewriteRules: [[/^https:\/\/www\.shararam\.ru\//i, `${location.origin}/official/`]],
  logLevel: new URLSearchParams(location.search).get("debug") === "1" ? "debug" : "warn"
};

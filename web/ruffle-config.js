"use strict";

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

"use strict";

(() => {
  const query = new URLSearchParams(location.search);
  // Loopback builds pass the capability in the opened URL; the public server
  // injects it into this page instead (never in the URL). Ignore the literal
  // placeholder if an unprocessed page is ever served.
  const injected = document.querySelector('meta[name="shararam-cap"]')?.content;
  const injectedCap = injected && injected !== "__SHARARAM_CAP__" ? injected : null;
  const capability = query.get("cap") || injectedCap || sessionStorage.getItem("shararam-live-capability");
  const debugMode = query.get("debug") === "1";
  if (capability) sessionStorage.setItem("shararam-live-capability", capability);
  history.replaceState(null, "", `${location.pathname}${debugMode ? "?debug=1" : ""}`);
  window.__shararamCapability = capability;

  const login = document.getElementById("login");
  const form = document.getElementById("login-form");
  const error = document.getElementById("login-error");
  const gameShell = document.getElementById("game-shell");
  const loading = document.getElementById("loading");
  const fatal = document.getElementById("fatal");
  const fatalText = document.getElementById("fatal-text");
  const debugState = document.getElementById("debug-state");

  // On a shared server the password travels through that server; the desktop
  // build talks to shararam.ru directly. Point hosted visitors at it.
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(location.hostname);
  if (!loopback) document.getElementById("hosted-note").hidden = false;

  let serverDiagnostics = {};
  let player = null;
  const ruffleState = { mounted: false, sharedObjectImported: false };
  window.__shararamRuffle = { state: ruffleState, getPlayer: () => player };

  // The stage of the official base.swf. Ruffle fills any leftover room inside
  // its own canvas with black bars, so the player element is measured against
  // the real container box and never left larger than the stage it shows.
  const STAGE_WIDTH = 815;
  const STAGE_HEIGHT = 495;
  function fitPlayerToStage() {
    if (!player) return;
    const box = document.getElementById("game").getBoundingClientRect();
    if (!box.width || !box.height) return;
    const scale = Math.min(box.width / STAGE_WIDTH, box.height / STAGE_HEIGHT);
    player.style.width = `${Math.floor(STAGE_WIDTH * scale)}px`;
    player.style.height = `${Math.floor(STAGE_HEIGHT * scale)}px`;
  }
  window.addEventListener("resize", fitPlayerToStage);
  new ResizeObserver(fitPlayerToStage).observe(document.getElementById("game"));

  // Ruffle falls back to a software renderer when the browser has hardware
  // acceleration switched off, which costs exactly the performance this client
  // exists for. Stay silent unless the renderer is known to be software.
  function softwareRenderer() {
    try {
      const probe = document.createElement("canvas");
      const gl = probe.getContext("webgl2") || probe.getContext("webgl");
      if (!gl) return true;
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      if (!info) return false;
      const renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || "");
      return /swiftshader|llvmpipe|softpipe|basic render|software/i.test(renderer);
    } catch (_) {
      return false;
    }
  }
  if (softwareRenderer()) document.getElementById("accel-note").hidden = false;

  document.getElementById("exit").addEventListener("click", async () => {
    window.ReconnectDisable();
    try {
      await api("/api/logout", { method: "POST" });
    } catch (_) {}
    location.reload();
  });

  async function mountOriginalClient({ swfUrl, originalSwfUrl, parameters }) {
    const source = window.RufflePlayer?.newest();
    if (!source) throw new Error("Ruffle не загрузился");
    player = source.createPlayer();
    player.id = "base";
    fitPlayerToStage();
    const overlayGuard = document.createElement("style");
    overlayGuard.textContent = "#unmute-overlay { display: none !important; }";
    player.shadowRoot?.appendChild(overlayGuard);
    document.getElementById("game").appendChild(player);
    await player.load({
      url: swfUrl,
      parameters,
      // Preserve the origin identity that the official RTMP application sees
      // even though this binary serves the bytes through a local reverse proxy.
      spoofUrl: originalSwfUrl,
      pageUrl: "https://www.shararam.ru/game",
      playerVersion: [23, 0, 0, 162],
      // The original SWF discovers its current RTMP host in ServerAction.
      // Ruffle appends that host/port to this one fallback WebSocket URL.
      socketProxy: [{
        proxyUrl: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/socket-proxy?cap=${encodeURIComponent(capability)}`,
      }],
      allowScriptAccess: true,
      allowNetworking: "all",
      autoplay: "on",
      unmuteOverlay: "hidden",
    });
    ruffleState.mounted = true;
  }

  if (debugMode) {
    debugState.hidden = false;
    window.setInterval(async () => {
      try { serverDiagnostics = (await api("/api/status")).diagnostics || {}; } catch (_) {}
      const state = window.__shararamRuffle?.state || {};
      debugState.textContent = JSON.stringify({
        mounted: state.mounted,
        sharedObjectImported: state.sharedObjectImported,
        socketProxy: "one dynamic binary WebSocket",
        server: serverDiagnostics
      });
    }, 500);
  }

  const api = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { "X-Shararam-Live-Capability": capability, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  };
  async function importNativeSharedObject() {
    const response = await fetch("/api/shared-object", {
      headers: { "X-Shararam-Live-Capability": capability }
    });
    if (response.status === 204) return;
    if (!response.ok) throw new Error(`SharedObject import: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const key = response.headers.get("X-Shararam-Shared-Object-Key");
    if (!key) throw new Error("SharedObject import: missing storage key");
    localStorage.setItem(key, btoa(binary));
    ruffleState.sharedObjectImported = true;
  }
  async function startGame() {
    login.hidden = true; gameShell.hidden = false;
    try {
      const bootstrap = await api("/api/bootstrap");
      await importNativeSharedObject();
      const localOfficial = `${location.origin}/official/`;
      await mountOriginalClient({
        swfUrl: "/game/base.swf",
        originalSwfUrl: bootstrap.swfUrl,
        parameters: {
          ...bootstrap.parameters,
          // The original AVM1 client concatenates paths without inserting '/'.
          game_server: localOfficial,
          url_path_server: localOfficial,
          portal_url: localOfficial,
          // PerformServerSelection in base.swf: any truthy value opens the
          // game's own server-selection dialog instead of AutoServerSelector.
          manual_server_selection: "1",
        }
      });
      loading.hidden = true;
    } catch (cause) {
      gameShell.hidden = true; fatal.hidden = false; fatalText.textContent = cause.message;
    }
  }
  form.addEventListener("submit", async event => {
    event.preventDefault(); error.textContent = "";
    const button = form.querySelector("button"); button.disabled = true;
    try {
      await api("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        login: document.getElementById("login-name").value,
        password: document.getElementById("login-password").value
      }) });
      document.getElementById("login-password").value = "";
      await startGame();
    } catch (cause) { error.textContent = cause.message; button.disabled = false; }
  });
  if (!capability) { login.hidden = true; fatal.hidden = false; fatalText.textContent = "Запустите приложение Shararam Ruffle."; }
  else api("/api/status").then(result => { if (result.authenticated) startGame(); }).catch(() => {});

  window.OnLoad = () => { loading.hidden = true; };
  window.OnGameEnter = () => {};
  window.flashSetServerName = () => {};
  window.OnUserEnterLocation = () => {};
  window.ReconnectDisable = () => player?.ReconnectDisable?.();
  window.addEventListener("beforeunload", () => window.ReconnectDisable());
  window.SaveAvatar = payload => fetch("/official/s/UserAvatarSaver", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body: payload
  });
  window.OpenAuth = () => location.reload();
  window.ExitGame = () => location.reload();
  window.OpenCabinet = () => window.open("https://www.shararam.ru/cabinet", "_blank");
  window.OpenGetMoneyPage = () => window.open("https://www.shararam.ru/moneybox", "_blank");
  window.GetShararamCard = () => window.open("https://www.shararam.ru/cards", "_blank");
  window.GetApp = () => window.open("https://www.shararam.ru/getapp", "_blank");
  window.OpenUserAgreement = () => window.open("https://www.shararam.ru/eula", "_blank");
})();

(async () => {
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/ruffle/ruffle.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  const bytes = await new Promise((res, rej) => { const ws = new WebSocket('ws://127.0.0.1:8792'); ws.binaryType = 'arraybuffer'; ws.onmessage = e => { res(new Uint8Array(e.data)); ws.close(); }; ws.onerror = rej; });
  const player = window.RufflePlayer.newest().createPlayer();
  Object.assign(player.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: 99999, background: '#fff' });
  document.body.appendChild(player);
  window.__shararamRuffle = { getPlayer: () => player };
  await player.load({ data: bytes, scale: 'noScale', backgroundExecutionMode: 'mainThread', autoplay: 'on', unmuteOverlay: 'hidden', allowScriptAccess: true });
  return { loaded: true, bytes: bytes.length, dpr: devicePixelRatio, w: innerWidth, h: innerHeight };
})()

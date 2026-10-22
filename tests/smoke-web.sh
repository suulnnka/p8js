#!/bin/bash
# one-shot playwright smoke against the vite preview (carts + audio graph)
#
# Prereq: npm run build && npm run preview  (serves dist/ on 127.0.0.1:4173).
# The test cart is NOT tracked in the repo (copyright hygiene): it is
# converted on the fly from the fake-08 checkout into dist/ below.
set -e
CLI='npx --yes --package @playwright/cli playwright-cli'

echo "== prepare test cart into dist/ (not tracked) =="
if [ ! -f dist/psetall.p8c ]; then
  npx tsx tools/convert.ts ../fake-08/test/carts/psetall.p8 -o dist/psetall.p8c
fi

echo "== reload page =="
# playwright-cli needs an open browser session; goto first (fast path),
# fall back to open (may attach a new browser and needs a settle delay).
$CLI goto http://127.0.0.1:4173/ || { $CLI open http://127.0.0.1:4173/ || true; sleep 3; }
sleep 2

echo "== ready =="
$CLI eval "() => window.__p8js.ready()"

echo "== load cart + tick =="
$CLI eval "() => fetch('/psetall.p8c').then(r => r.arrayBuffer()).then(a => { const b = new Uint8Array(a); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); const r = window.__p8js.loadP8cBytes(btoa(s), 'psetall'); const ok = window.__p8js.tick(6); return { loaded: r.loaded, msg: r.msg, ok, err: window.__p8js.lastError() }; })"

echo "== canvas non-black sample =="
$CLI eval "() => { const c = document.querySelector('#screen'); const d = c.getContext('2d').getImageData(0, 0, 128, 128).data; let n = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] > 8 || d[i+1] > 8 || d[i+2] > 8) n++; } const o = document.querySelector('#overlay'); return { nonBlack: n, overlayShown: o.classList.contains('show') }; }"

echo "== audio unlock gesture =="
$CLI eval "() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' })); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyZ' })); return 'gesture-sent'; }"
sleep 2
$CLI eval "() => window.__p8js.audioState()"

echo "== tick after audio init =="
$CLI eval "() => { const ok = window.__p8js.tick(4); return { ok, err: window.__p8js.lastError(), audio: window.__p8js.audioState() }; }"

echo "== screenshot =="
$CLI screenshot 2>&1 | tail -3

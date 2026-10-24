// Web shell — canvas presenter, keyboard sampling, .p8c loading, main loop.
// PLAN §4.5 / Phase 4a.

import { Emulator, type CartImage } from "../core/host.ts";
import { loadP8c, type P8cFile } from "../core/p8c.ts";
import { PALETTE_RGBA } from "../core/palette.ts";
import type { HostInputState } from "../core/input.ts";
import biosUrl from "../../assets/bios.bc?url";

// ---------------------------------------------------------------------------
// DOM

const canvas = document.querySelector<HTMLCanvasElement>("#screen")!;
const ctx2d = canvas.getContext("2d", { alpha: false })!;
const overlay = document.querySelector<HTMLDivElement>("#overlay")!;
const stage = document.querySelector<HTMLDivElement>("#stage")!;
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const resetBtn = document.querySelector<HTMLButtonElement>("#reset")!;
const fsBtn = document.querySelector<HTMLButtonElement>("#fs")!;
const statsEl = document.querySelector<HTMLSpanElement>("#stats")!;
const consoleEl = document.querySelector<HTMLDivElement>("#console")!;

const img = ctx2d.createImageData(128, 128);

// ---------------------------------------------------------------------------
// console panel (print/printh), keep the tail

const CONSOLE_MAX = 300;
const consoleLines: string[] = [];
function consolePush(s: string): void {
  for (const line of s.split("\n")) {
    if (line === "" && consoleLines.length === 0) continue;
    consoleLines.push(line);
  }
  while (consoleLines.length > CONSOLE_MAX) consoleLines.shift();
  consoleEl.textContent = consoleLines.join("\n");
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// keyboard → fake-08 host input (hostVmShared.h / WindowsHost key map:
// arrows = bits 0-3, X = bit4 (🅾), Z/C = bit5 (❎), Esc = bit6 pause)

const KEY_BITS: Record<string, number> = {
  ArrowLeft: 0,
  ArrowRight: 1,
  ArrowUp: 2,
  ArrowDown: 3,
  KeyX: 4,
  KeyZ: 5,
  KeyC: 5,
  Escape: 6,
};

let heldMask = 0;
let edgeMask = 0;

function onKeyDown(e: KeyboardEvent): void {
  const bit = KEY_BITS[e.code];
  if (bit === undefined) return;
  e.preventDefault();
  const b = 1 << bit;
  if ((heldMask & b) === 0) edgeMask |= b;
  heldMask |= b;
}

function onKeyUp(e: KeyboardEvent): void {
  const bit = KEY_BITS[e.code];
  if (bit === undefined) return;
  e.preventDefault();
  heldMask &= ~(1 << bit);
}

window.addEventListener("keydown", onKeyDown);
window.addEventListener("keyup", onKeyUp);

// ---------------------------------------------------------------------------
// pointer → devkit mouse (stat(32)/stat(33)/stat(34), motion stat(38)/stat(39),
// wheel stat(35)/stat(36)); Input.update only forwards mouse/keyboard while
// devkitMode (poke(0x5f2d,…)) has the 0x1 bit set, same as fake-08.
// stat(34) buttons: bit0 left, bit1 right, bit2 middle. Motion deltas are
// accumulated between logic steps and consumed per _update_buttons sample
// (official 0.2.4 semantics; POOM's menu drives off stat(38)/stat(39)).

let mouseX = 0;
let mouseY = 0;
let mouseBtns = 0;
let mouseDX = 0;
let mouseDY = 0;
let mouseWheelH = 0;
let mouseWheel = 0;
let mouseClicked = false;
let lastPointerX: number | null = null;
let lastPointerY: number | null = null;

function pointerBit(e: PointerEvent): number {
  return e.button === 2 ? 2 : e.button === 1 ? 4 : 1;
}

function trackPointer(e: PointerEvent): void {
  if (lastPointerX !== null && lastPointerY !== null) {
    // host desktop pixels, exactly what stat(38/39) promise
    mouseDX += e.clientX - lastPointerX;
    mouseDY += e.clientY - lastPointerY;
  }
  lastPointerX = e.clientX;
  lastPointerY = e.clientY;
  const r = canvas.getBoundingClientRect();
  mouseX = Math.max(0, Math.min(127, Math.floor(((e.clientX - r.left) / r.width) * 128)));
  mouseY = Math.max(0, Math.min(127, Math.floor(((e.clientY - r.top) / r.height) * 128)));
}

canvas.addEventListener("pointermove", trackPointer);
canvas.addEventListener("pointerdown", (e) => {
  trackPointer(e);
  mouseBtns |= pointerBit(e);
  mouseClicked = true;
});
window.addEventListener("pointerup", (e) => {
  trackPointer(e);
  mouseBtns &= ~pointerBit(e);
});
// wheel: stat(35) horizontal px, stat(36) net roll (1 up / -1 down). Not
// preventDefault'ed — the page still scrolls, the cart still sees the wheel.
canvas.addEventListener("wheel", (e) => {
  mouseWheelH += e.deltaX;
  mouseWheel += e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
});
// dragging on the canvas shouldn't open the browser context menu or scroll
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
// the cursor leaving the canvas ends the motion segment — keep the window
// between-events diff valid (otherwise the next entry jumps across the gap)
canvas.addEventListener("pointerleave", () => {
  lastPointerX = null;
  lastPointerY = null;
});
// losing focus must not stick keys or buttons
window.addEventListener("blur", () => {
  heldMask = 0;
  mouseBtns = 0;
});

function sampleInput(): HostInputState {
  const state: HostInputState = {
    kDown: edgeMask,
    kHeld: heldMask,
    mouseX,
    mouseY,
    mouseBtns,
    mouseDX,
    mouseDY,
    mouseWheelH,
    mouseWheel,
    mouseClicked,
    kbDown: false,
    kbKey: "",
  };
  edgeMask = 0;
  mouseDX = 0;
  mouseDY = 0;
  mouseWheelH = 0;
  mouseWheel = 0;
  mouseClicked = false;
  return state;
}

// ---------------------------------------------------------------------------
// emulator

let biosBytes: Uint8Array | null = null;
let emu: Emulator | null = null;
let currentCart: CartImage | null = null;

function showError(msg: string | null): void {
  if (msg) {
    overlay.textContent = msg;
    overlay.classList.add("show");
  } else {
    overlay.classList.remove("show");
  }
}

function present(): void {
  if (!emu) return;
  const fb = emu.framebuffer();
  const pal = emu.mem.data.subarray(0x5f10, 0x5f10 + 16);
  const d = img.data;
  for (let i = 0; i < 128 * 128; i++) {
    const x = i & 127;
    const y = i >> 7;
    const byte = fb[(y << 6) | (x >> 1)];
    const c = (x & 1) ? byte >> 4 : byte & 0x0f;
    const mapped = pal[c] & 0x8f;
    const o = i << 2;
    const p = mapped << 2;
    d[o] = PALETTE_RGBA[p];
    d[o + 1] = PALETTE_RGBA[p + 1];
    d[o + 2] = PALETTE_RGBA[p + 2];
    d[o + 3] = 255;
  }
  ctx2d.putImageData(img, 0, 0);
}

function bootEmu(): void {
  if (!biosBytes) return;
  emu = new Emulator({
    biosBytes,
    onPrint: consolePush,
    onPrinth: consolePush,
  });
}

function loadCartBytes(cart: CartImage | P8cFile, name: string): void {
  if (!emu) bootEmu();
  if (!emu) {
    showError(`${name}\nBIOS 仍在加载，请稍后重试`);
    return;
  }
  currentCart = "subs" in cart ? { bytecode: cart.bytecode, rom: cart.rom } : cart;
  frozen = false;
  consoleLines.length = 0;
  consoleEl.textContent = "";
  // pass the full P8cFile through: P8C2 sub-carts must reach the emulator
  // or in-cart load("xxx.p8") can't find them (POOM level launch).
  const ok = emu.loadCart(cart);
  showError(ok ? null : `${name}\n${emu.lastError ?? "load failed"}`);
}

async function loadP8cFile(file: File): Promise<void> {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const parsed = await loadP8c(buf);
    loadCartBytes(parsed, file.name);
    if (emu && emu.lastError === null) consolePush(`// loaded ${file.name}`);
  } catch (e) {
    showError(`${file.name}\n${(e as Error).message}`);
  }
}

// drag & drop + file picker
for (const evt of ["dragenter", "dragover"] as const) {
  stage.addEventListener(evt, (e) => {
    e.preventDefault();
    stage.classList.add("drop");
  });
}
for (const evt of ["dragleave", "drop"] as const) {
  stage.addEventListener(evt, (e) => {
    e.preventDefault();
    stage.classList.remove("drop");
  });
}
stage.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) void loadP8cFile(f);
});
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) void loadP8cFile(f);
});

resetBtn.addEventListener("click", () => {
  if (currentCart) loadCartBytes(currentCart, "reset");
});

fsBtn.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void stage.requestFullscreen();
});

// ---------------------------------------------------------------------------
// audio: fake-08-style frame-driven fill → AudioWorklet ring buffer.
// Unlocked on the first user gesture (browser autoplay policy).

const AUDIO_RATE = 22050;
let actx: AudioContext | null = null;
let audioNode: AudioWorkletNode | null = null;
let audioAcc = 0;
let pcmScratch = new Int16Array(1024);

async function initAudio(): Promise<void> {
  if (actx || !emu) return;
  try {
    const ctx = new AudioContext({ sampleRate: AUDIO_RATE });
    await ctx.audioWorklet.addModule("worklet.js");
    const node = new AudioWorkletNode(ctx, "p8-processor", {
      outputChannelCount: [1],
    });
    node.connect(ctx.destination);
    await ctx.resume();
    actx = ctx;
    audioNode = node;
    consolePush("[audio] ready 22050Hz");
  } catch (e) {
    consolePush(`[audio] init failed: ${(e as Error).message}`);
  }
}

window.addEventListener("keydown", () => void initAudio(), { once: true });
window.addEventListener("pointerdown", () => void initAudio(), { once: true });

/** Render one presenter frame worth of PCM and hand it to the worklet.
 *  Proportional to real elapsed time — generating a fixed amount per rAF call
 *  ties music pitch to the display refresh rate (50Hz panel → 17% slow with
 *  constant underruns, 144Hz → 2.4x fast). */
function pumpAudio(dtMs: number): void {
  if (!emu || !audioNode) return;
  audioAcc += (AUDIO_RATE * Math.min(dtMs, 100)) / 1000;
  const n = Math.floor(audioAcc);
  if (n <= 0) return;
  audioAcc -= n;
  if (pcmScratch.length < n) pcmScratch = new Int16Array(n * 2);
  emu.audio.fillMono(pcmScratch, 0, n);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = pcmScratch[i] / 32768;
  audioNode.port.postMessage(f);
}

// ---------------------------------------------------------------------------
// main loop: everything hangs off requestAnimationFrame with a real-time
// accumulator.
//
// The logic clock used to be a chained setTimeout at a nominal 60Hz with rAF
// only presenting — but timer chains are the first thing browsers throttle
// (occluded webviews, background tabs, energy savers), which collapses the
// game to a few fps (reproduced at fps 5; KNOWN-GAPS §7). rAF is the one clock
// that keeps firing while the page is actually shown, and with the ACTUAL
// frame delta fed into the accumulator the step rate averages 60/s on any
// display (50Hz/60Hz/144Hz) — unlike the pre-§6.1 code that assumed one step
// per rAF. When rAF stops (tab hidden) the game pauses, which is what a
// console would do; the 250ms dt clamp and step cap keep a return-from-
// background catch-up bounded.

const STEP_MS = 1000 / 60;
let acc = 0;
let lastRaf = 0;
let fpsSteps = 0;
let fpsClock = 0;
let fpsShown = 0;
/** set when the cart errors — logic freezes, last frame keeps presenting */
let frozen = false;

function stepOnce(): void {
  // no cart loaded yet — ticking a fresh bios state would report a dead
  // __z8_loop and freeze the shell before the user picks a file.
  if (!emu || !currentCart || frozen) return;
  const input = sampleInput();
  const ok = emu.tick(input);
  if (!ok) {
    showError(emu.lastError ?? "runtime error");
    frozen = true;
  }
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (lastRaf === 0) {
    lastRaf = now;
    fpsClock = now;
  }
  const dt = Math.min(now - lastRaf, 250);
  lastRaf = now;
  acc += dt;
  let steps = 0;
  while (acc >= STEP_MS && steps < 8) {
    acc -= STEP_MS;
    stepOnce();
    fpsSteps++;
    steps++;
  }
  // backlog beyond the catch-up cap is dropped, not accumulated forever
  if (acc > STEP_MS * 8) acc = 0;

  present();
  pumpAudio(dt);

  if (now - fpsClock >= 500) {
    fpsShown = Math.round((fpsSteps * 1000) / (now - fpsClock));
    fpsSteps = 0;
    fpsClock = now;
    const name = currentCart ? "cart" : "idle";
    statsEl.textContent = `fps ${fpsShown} · ${name}`;
  }
}

async function main(): Promise<void> {
  const res = await fetch(biosUrl);
  biosBytes = new Uint8Array(await res.arrayBuffer());
  bootEmu();
  requestAnimationFrame(frame);
}

// Debug/testing hook: lets automation load a cart by raw bytes without file
// dialogs (window.__p8js.loadP8cBytes(base64)).
declare global {
  interface Window {
    __p8js?: {
      loadP8cBytes: (
        b64: string, name?: string,
      ) => Promise<{ loaded: boolean; msg: string }>;
      tick: (n: number) => boolean;
      lastError: () => string | null;
      /** true once bios.bc finished loading and the Emulator exists */
      ready: () => boolean;
      /** audio graph status for automation */
      audioState: () => { hasCtx: boolean; state: string; hasNode: boolean };
      /** debug probes: multi-cart load state (mirror stat(6)/stat(100)) */
      cartParam: () => string | null;
      breadcrumb: () => string | null;
    };
  }
}

window.__p8js = {
  async loadP8cBytes(b64, name = "cart.p8c") {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    if (!emu) bootEmu();
    if (!emu) {
      const msg = "BIOS still loading";
      showError(`${name}\n${msg}`);
      return { loaded: false, msg };
    }
    try {
      const parsed = await loadP8c(buf);
      loadCartBytes(parsed, name);
      return { loaded: currentCart !== null, msg: emu.lastError ?? "" };
    } catch (e) {
      const msg = (e as Error).message;
      showError(`${name}\n${msg}`);
      return { loaded: false, msg };
    }
  },
  tick(n) {
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      stepOnce();
      ok = !frozen;
    }
    present();
    return ok && !frozen;
  },
  lastError() {
    return emu?.lastError ?? null;
  },
  ready() {
    return emu !== null;
  },
  audioState() {
    return {
      hasCtx: actx !== null,
      state: actx?.state ?? "none",
      hasNode: audioNode !== null,
    };
  },
  // debug probes: multi-cart load state (stat(6)/stat(100) mirror these)
  cartParam() {
    return emu?.cartParam ?? null;
  },
  breadcrumb() {
    return emu?.breadcrumb ?? null;
  },
};

void main();

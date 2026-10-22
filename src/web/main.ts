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
// pointer → devkit mouse (stat(32)/stat(33)/stat(34)); Input.update only
// forwards mouse/keyboard while devkitMode (poke(0x5f2d,1)) is set, same as
// fake-08. stat(34) buttons: bit0 left, bit1 right, bit2 middle.

let mouseX = 0;
let mouseY = 0;
let mouseBtns = 0;

function pointerBit(e: PointerEvent): number {
  return e.button === 2 ? 2 : e.button === 1 ? 4 : 1;
}

function trackPointer(e: PointerEvent): void {
  const r = canvas.getBoundingClientRect();
  mouseX = Math.max(0, Math.min(127, Math.floor(((e.clientX - r.left) / r.width) * 128)));
  mouseY = Math.max(0, Math.min(127, Math.floor(((e.clientY - r.top) / r.height) * 128)));
}

canvas.addEventListener("pointermove", trackPointer);
canvas.addEventListener("pointerdown", (e) => {
  trackPointer(e);
  mouseBtns |= pointerBit(e);
});
window.addEventListener("pointerup", (e) => {
  mouseBtns &= ~pointerBit(e);
});
// dragging on the canvas shouldn't open the browser context menu or scroll
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
// losing focus must not stick keys
window.addEventListener("blur", () => {
  heldMask = 0;
});

function sampleInput(): HostInputState {
  const state: HostInputState = {
    kDown: edgeMask,
    kHeld: heldMask,
    mouseX,
    mouseY,
    mouseBtns,
    kbDown: false,
    kbKey: "",
  };
  edgeMask = 0;
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

/** Render one host frame worth of PCM and hand it to the worklet. */
function pumpAudio(): void {
  if (!emu || !audioNode) return;
  audioAcc += AUDIO_RATE / 60;
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
// main loop: 60Hz logic steps on a wall-clock timer, present per rAF.
//
// Stepping used to hang off requestAnimationFrame with a fixed 1/60s
// accumulator, which tied cart speed to the display refresh rate — on a
// ~50Hz panel a 30fps cart ran 17% slow with uneven 1/2-step cadence
// (KNOWN-GAPS §6.1). The step clock is now rAF-independent; rAF only
// presents the latest framebuffer and pumps audio.

const STEP_MS = 1000 / 60;
let acc = 0;
let lastStep = performance.now();
let fpsSteps = 0;
let fpsClock = performance.now();
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

function stepLoop(): void {
  const now = performance.now();
  acc += now - lastStep;
  lastStep = now;
  // catch up at most 4 steps (throttled-timer spikes, e.g. hidden tab)
  let n = 0;
  while (acc >= STEP_MS && n < 4) {
    acc -= STEP_MS;
    stepOnce();
    fpsSteps++;
    n++;
  }
  if (acc > STEP_MS * 4) acc = 0;
  // chained timer aimed at the next step boundary; setTimeout clamping
  // (~4ms) is absorbed by the accumulator
  setTimeout(stepLoop, Math.max(0, STEP_MS - (performance.now() - now)));
}

function frame(now: number): void {
  present();
  pumpAudio();

  if (now - fpsClock >= 500) {
    fpsShown = Math.round((fpsSteps * 1000) / (now - fpsClock));
    fpsSteps = 0;
    fpsClock = now;
    const name = currentCart ? "cart" : "idle";
    statsEl.textContent = `fps ${fpsShown} · ${name}`;
  }
  requestAnimationFrame(frame);
}

async function main(): Promise<void> {
  const res = await fetch(biosUrl);
  biosBytes = new Uint8Array(await res.arrayBuffer());
  bootEmu();
  setTimeout(stepLoop, STEP_MS);
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

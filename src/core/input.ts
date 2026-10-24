// PICO-8 input: button state machine with btnp repeat, mouse and keyboard
// buffers. Port of fake-08 Input.cpp + Vm::update_buttons (vm.cpp:1193-1225).

import { PicoMemory, HW } from "./memory.ts";

const BIT = (i: number): number => 1 << i;

/** Raw per-host-frame sample supplied by the platform layer (scanInput). */
export interface HostInputState {
  /** edge state: buttons that went down this frame */
  kDown: number;
  /** level state: buttons currently held (bits 0-6) */
  kHeld: number;
  mouseX: number;
  mouseY: number;
  mouseBtns: number;
  /** mouse movement since the previous _update_buttons sample, host pixels
   *  (stat(38)/stat(39) — official 0.2.4 devkit protocol) */
  mouseDX: number;
  mouseDY: number;
  /** horizontal wheel pixels accumulated since the last sample (stat(35)) */
  mouseWheelH: number;
  /** vertical wheel, net notches: 1 up / -1 down (stat(36)) */
  mouseWheel: number;
  /** a button-down happened since the last sample (stat(37) → 4) */
  mouseClicked: boolean;
  kbDown: boolean;
  kbKey: string;
}

export const EMPTY_HOST_INPUT: HostInputState = {
  kDown: 0,
  kHeld: 0,
  mouseX: 0,
  mouseY: 0,
  mouseBtns: 0,
  mouseDX: 0,
  mouseDY: 0,
  mouseWheelH: 0,
  mouseWheel: 0,
  mouseClicked: false,
  kbDown: false,
  kbKey: "",
};

/** drawState.devkitMode (0x5f2d) flag bits — official 0.2.4 protocol. */
export const DEVKIT = {
  ENABLE: 0x1, // keyboard + mouse stats (32-34, 30/31) readable
  BTN_EMU: 0x2, // mouse buttons drive btn(4)/btn(5)/btn(6)
  POINTER_TRACK: 0x4, // stat(38/39) relative movement readable
} as const;

export class Input {
  currentKDown = 0;
  currentKHeld = 0;
  private readonly framesHeld = new Uint16Array(8);
  mouseX = 0;
  mouseY = 0;
  mouseBtns = 0;
  /** stat(38)/stat(39): movement since the previous sample (host pixels). */
  mouseDX = 0;
  mouseDY = 0;
  /** stat(35): horizontal wheel pixels since the previous sample. */
  mouseWheelH = 0;
  /** stat(36): net vertical wheel this sample: 1 up / -1 down / 0. */
  mouseWheel = 0;
  /** stat(37): 4 when a click happened since the previous sample, else 0. */
  mouseAccel = 0;
  /** previous BTN_EMU level mask, for btnp edges on mouse-driven bits */
  private prevMouseBtns = 0;
  kbDown = false;
  kbKey = "";
  /** Set by the host after closing the pause menu (vm.cpp:1200-1209). */
  clearInputOnResume = false;

  constructor(private readonly mem: PicoMemory) {}

  /** Input::SetState (Input.cpp:16-58). */
  setState(kdown: number, kheld: number): void {
    this.currentKDown = kdown;
    this.currentKHeld = kheld;
    // pause (bit 6) fires for one frame even when held
    if ((kheld & BIT(6)) !== 0 && (kdown & BIT(6)) === 0) {
      this.currentKHeld &= ~BIT(6);
    }
    // memory only stores buttons 0-5 (Input.cpp:24 — raw kheld, not the
    // pause-cleared copy)
    this.mem.data[HW.BUTTONS] = kheld & 0x3f;

    const delayReg = this.mem.data[HW.BTNP_DELAY];
    const repeatDelay = delayReg === 0 ? 15 : delayReg;
    if (repeatDelay === 255) return;

    const intReg = this.mem.data[HW.BTNP_INTERVAL];
    // bug-for-bug: fake-08's non-zero fallback reads the DELAY register
    // (Input.cpp:36)
    const repeatInterval = intReg === 0 ? 4 : delayReg;

    for (let i = 0; i < 7; i++) {
      const down = (BIT(i) & kheld) !== 0;
      this.framesHeld[i] = down ? this.framesHeld[i] + 1 : 0;
      const fh = this.framesHeld[i];
      const repeat =
        fh === repeatDelay ||
        (fh / repeatDelay >= 1 && fh % repeatInterval === 0);
      if (repeat) this.currentKDown |= BIT(i);
    }
  }

  setMouse(x: number, y: number, btns: number): void {
    this.mouseX = x;
    this.mouseY = y;
    this.mouseBtns = btns;
  }

  setKeyboard(down: boolean, key: string): void {
    this.kbDown = down;
    this.kbKey = key;
  }

  btnMask(): number {
    return this.currentKHeld;
  }

  btnpMask(): number {
    return this.currentKDown;
  }

  /** btn(i[, player]) — only player 0 exists (Input.cpp:89-92). */
  btn(i?: number, player?: number): number | boolean {
    if (i === undefined) return this.currentKHeld;
    if (player !== undefined && player !== 0) return false;
    return (BIT(i) & this.currentKHeld) !== 0;
  }

  btnp(i?: number, player?: number): number | boolean {
    if (i === undefined) return this.currentKDown;
    if (player !== undefined && player !== 0) return false;
    return (BIT(i) & this.currentKDown) !== 0;
  }

  /** stat(31): reading the key consumes the buffer (Input.cpp:116-122). */
  consumeKey(): string {
    this.kbDown = false;
    return this.kbKey;
  }

  /**
   * Vm::update_buttons (vm.cpp:1193-1225): sample host input, apply pause
   * clear-on-resume and the devkitMode gate for mouse/keyboard. The gate
   * follows the official 0.2.4 flag bits (fake-08 only checks != 0; POOM
   * pokes 7 = ENABLE|BTN_EMU|POINTER_TRACK and needs the finer split):
   *   0x1 enable mouse/keyboard stats, 0x2 mouse buttons → btn(4..6),
   *   0x4 stat(38/39) relative movement.
   * Returns true when the pause button (bit 6) fired this frame — the host
   * decides what the pause menu does (fake-08 calls togglePauseMenu here).
   */
  update(host: HostInputState): boolean {
    if (this.clearInputOnResume) {
      if ((host.kHeld & 0x30) === 0) this.clearInputOnResume = false;
      this.setState(0, 0);
      this.setMouse(0, 0, 0);
      this.clearMouseMotion();
      this.setKeyboard(false, "");
      return false;
    }
    this.setState(host.kDown, host.kHeld);
    const flags = this.mem.data[0x5f2d];
    if ((flags & DEVKIT.ENABLE) !== 0) {
      this.setMouse(host.mouseX, host.mouseY, host.mouseBtns);
      // stat(38/39) additionally require the 0x4 pointer-tracking bit
      const track = (flags & DEVKIT.POINTER_TRACK) !== 0;
      this.mouseDX = track ? host.mouseDX : 0;
      this.mouseDY = track ? host.mouseDY : 0;
      this.mouseWheelH = host.mouseWheelH;
      this.mouseWheel = host.mouseWheel;
      this.mouseAccel = host.mouseClicked ? 4 : 0;
      this.setKeyboard(host.kbDown, host.kbKey);
      if ((flags & DEVKIT.BTN_EMU) !== 0) {
        // left→btn(4) ❎, right→btn(5) 🅾, middle→btn(6) pause. Level bits
        // OR into btn(); new bits this sample OR into btnp() edges.
        const mb =
          ((host.mouseBtns & 1) ? BIT(4) : 0) |
          ((host.mouseBtns & 2) ? BIT(5) : 0) |
          ((host.mouseBtns & 4) ? BIT(6) : 0);
        this.currentKDown |= mb & ~this.prevMouseBtns;
        this.currentKHeld |= mb;
        this.prevMouseBtns = mb;
      } else {
        this.prevMouseBtns = 0;
      }
    } else {
      this.setMouse(0, 0, 0);
      this.clearMouseMotion();
      this.setKeyboard(false, "");
      this.prevMouseBtns = 0;
    }
    return (BIT(6) & this.currentKDown) !== 0;
  }

  private clearMouseMotion(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.mouseWheelH = 0;
    this.mouseWheel = 0;
    this.mouseAccel = 0;
  }

  /** Reset repeat counters (cart reload / run). */
  reset(): void {
    this.currentKDown = 0;
    this.currentKHeld = 0;
    this.framesHeld.fill(0);
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseBtns = 0;
    this.clearMouseMotion();
    this.prevMouseBtns = 0;
    this.kbDown = false;
    this.kbKey = "";
    this.clearInputOnResume = false;
  }
}

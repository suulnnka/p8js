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
  kbDown: boolean;
  kbKey: string;
}

export const EMPTY_HOST_INPUT: HostInputState = {
  kDown: 0,
  kHeld: 0,
  mouseX: 0,
  mouseY: 0,
  mouseBtns: 0,
  kbDown: false,
  kbKey: "",
};

export class Input {
  currentKDown = 0;
  currentKHeld = 0;
  private readonly framesHeld = new Uint16Array(8);
  mouseX = 0;
  mouseY = 0;
  mouseBtns = 0;
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
   * clear-on-resume and the devkitMode gate for mouse/keyboard.
   * Returns true when the pause button (bit 6) fired this frame — the host
   * decides what the pause menu does (fake-08 calls togglePauseMenu here).
   */
  update(host: HostInputState): boolean {
    if (this.clearInputOnResume) {
      if ((host.kHeld & 0x30) === 0) this.clearInputOnResume = false;
      this.setState(0, 0);
      this.setMouse(0, 0, 0);
      this.setKeyboard(false, "");
      return false;
    }
    this.setState(host.kDown, host.kHeld);
    if (this.mem.data[0x5f2d] !== 0) {
      // devkitMode (drawState.devkitMode @ 0x5f2d)
      this.setMouse(host.mouseX, host.mouseY, host.mouseBtns);
      this.setKeyboard(host.kbDown, host.kbKey);
    } else {
      this.setMouse(0, 0, 0);
      this.setKeyboard(false, "");
    }
    return (BIT(6) & this.currentKDown) !== 0;
  }

  /** Reset repeat counters (cart reload / run). */
  reset(): void {
    this.currentKDown = 0;
    this.currentKHeld = 0;
    this.framesHeld.fill(0);
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseBtns = 0;
    this.kbDown = false;
    this.kbKey = "";
    this.clearInputOnResume = false;
  }
}

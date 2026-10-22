// PICO-8 audio — port of fake-08 Audio.cpp / synth.cpp / filter.cpp.
// 22050 Hz, 183 samples per note/speed unit (Audio.cpp:400,600).
// Rendering happens on demand via fillMono()/fillStereo() — exactly like
// fake-08, which pulls a buffer per host frame (vm.cpp:885-889); there is no
// separate per-frame update (state advances inside the sample loop).
//
// Split of state (PicoRam.h:128-177): songs/sfx/hw registers live in RAM;
// playback state (offsets, synth phase, reverb/damp) lives on this object.

import type { PicoMemory } from "./memory.ts";
import { HW } from "./memory.ts";

export const SAMPLE_RATE = 22050;
export const SAMPLES_PER_NOTE = 183; // one note per speed unit (Audio.cpp:400)

// effect ids (Audio.h:77-87)
export const FX = {
  NONE: 0, SLIDE: 1, VIBRATO: 2, DROP: 3,
  FADE_IN: 4, FADE_OUT: 5, ARP_FAST: 6, ARP_SLOW: 7,
} as const;

// ---------------------------------------------------------------------------
// data accessors (PicoRam.h:27-126)

const SFX_BASE = 0x3200;
const SFX_SIZE = 68;
const MUSIC_BASE = 0x3100;

export function sfxSpeed(mem: PicoMemory, n: number): number {
  return mem.data[SFX_BASE + n * SFX_SIZE + 65];
}
export function sfxLoopStart(mem: PicoMemory, n: number): number {
  return mem.data[SFX_BASE + n * SFX_SIZE + 66];
}
export function sfxLoopEnd(mem: PicoMemory, n: number): number {
  return mem.data[SFX_BASE + n * SFX_SIZE + 67];
}
export function sfxFilters(mem: PicoMemory, n: number): number {
  return mem.data[SFX_BASE + n * SFX_SIZE + 64];
}

/** note fields at notes[idx] (2 bytes) — PicoRam.h:58-105 / Audio.h:62. */
export function noteKey(mem: PicoMemory, n: number, idx: number): number {
  return mem.data[SFX_BASE + n * SFX_SIZE + idx * 2] & 0x3f;
}
export function noteWaveform(mem: PicoMemory, n: number, idx: number): number {
  const b0 = mem.data[SFX_BASE + n * SFX_SIZE + idx * 2];
  const b1 = mem.data[SFX_BASE + n * SFX_SIZE + idx * 2 + 1];
  return ((b1 & 1) << 2) | ((b0 & 0xc0) >> 6);
}
export function noteVolume(mem: PicoMemory, n: number, idx: number): number {
  return (mem.data[SFX_BASE + n * SFX_SIZE + idx * 2 + 1] >> 1) & 7;
}
export function noteEffect(mem: PicoMemory, n: number, idx: number): number {
  return (mem.data[SFX_BASE + n * SFX_SIZE + idx * 2 + 1] >> 4) & 7;
}
export function noteCustom(mem: PicoMemory, n: number, idx: number): number {
  return (mem.data[SFX_BASE + n * SFX_SIZE + idx * 2 + 1] >> 7) & 1;
}

/** song channel sfx number (0x7F mask); flags bit7 on data[i]. */
export function songChannel(mem: PicoMemory, n: number, ch: number): number {
  return mem.data[MUSIC_BASE + n * 4 + ch] & 0x7f;
}
export function songStart(mem: PicoMemory, n: number): boolean {
  return (mem.data[MUSIC_BASE + n * 4] & 0x80) !== 0;
}
export function songLoop(mem: PicoMemory, n: number): boolean {
  return (mem.data[MUSIC_BASE + n * 4 + 1] & 0x80) !== 0;
}
export function songStop(mem: PicoMemory, n: number): boolean {
  return (mem.data[MUSIC_BASE + n * 4 + 2] & 0x80) !== 0;
}

// ---------------------------------------------------------------------------
// filter (filter.cpp — RBJ cookbook, fs=22050)

type FilterType = "lpf" | "hpf" | "lowshelf" | "highshelf";

export class Filter {
  private c1 = 0; private c2 = 0; private c3 = 0; private c4 = 0; private c5 = 0;
  private li = 0; private lli = 0; private lo = 0; private llo = 0;

  init(t: FilterType, freq: number, q: number, gain: number): void {
    const w0 = (2 * Math.PI * freq) / SAMPLE_RATE;
    const cosw0 = Math.cos(w0);
    const a = Math.pow(10, gain / 40);
    const alpha = t === "lowshelf" || t === "highshelf"
      ? (Math.sin(w0) / 2) * Math.sqrt((a + 1 / a) * (1 / q - 1) + 2)
      : Math.sin(w0) / (2 * q);
    let a0: number, a1: number, a2: number, b0: number, b1: number, b2: number;
    if (t === "lpf") {
      a0 = 1 + alpha; a1 = -2 * cosw0; a2 = 1 - alpha;
      b0 = (1 - cosw0) / 2; b1 = 1 - cosw0; b2 = b0;
    } else if (t === "hpf") {
      a0 = 1 + alpha; a1 = -2 * cosw0; a2 = 1 - alpha;
      b0 = (1 + cosw0) / 2; b1 = -(1 + cosw0); b2 = b0;
    } else if (t === "lowshelf") {
      const sqra = 2 * Math.sqrt(a) * alpha;
      a0 = (a + 1) + (a - 1) * cosw0 + sqra;
      a1 = -2 * ((a - 1) + (a + 1) * cosw0);
      a2 = (a + 1) + (a - 1) * cosw0 - sqra;
      b0 = a * ((a + 1) - (a - 1) * cosw0 + sqra);
      b1 = 2 * a * ((a - 1) - (a + 1) * cosw0);
      b2 = a * ((a + 1) + (a - 1) * cosw0 - sqra); // note: filter.cpp uses minus here
      b2 = a * ((a + 1) - (a - 1) * cosw0 - sqra);
    } else {
      const sqra = 2 * Math.sqrt(a) * alpha;
      a0 = (a + 1) - (a - 1) * cosw0 + sqra;
      a1 = 2 * ((a - 1) - (a + 1) * cosw0);
      a2 = (a + 1) - (a - 1) * cosw0 - sqra;
      b0 = a * ((a + 1) + (a - 1) * cosw0 + sqra);
      b1 = -2 * a * ((a - 1) + (a + 1) * cosw0);
      b2 = a * ((a + 1) + (a - 1) * cosw0 - sqra);
    }
    this.c1 = b0 / a0; this.c2 = b1 / a0; this.c3 = b2 / a0;
    this.c4 = a1 / a0; this.c5 = a2 / a0;
  }

  run(input: number): number {
    const out =
      this.c1 * input + this.c2 * this.li + this.c3 * this.lli -
      this.c4 * this.lo - this.c5 * this.llo;
    this.lli = this.li; this.li = input;
    this.llo = this.lo; this.lo = out;
    return out;
  }
}

// ---------------------------------------------------------------------------
// playback state (PicoRam.h:141-172)

interface SfxState {
  sfx: number;
  offset: number;
  time: number;
  prevKey: number;
  prevVol: number;
}

interface Synth {
  key: number;
  freq: number;
  instrument: number;
  custom: boolean;
  filters: number;
  volume: number;
  isMusic: boolean;
  phi: number;
  lastAdvance: number;
  lastSample: number;
}

function emptySfxState(): SfxState {
  return { sfx: -1, offset: 0, time: 0, prevKey: 24, prevVol: 0 };
}

function emptySynth(): Synth {
  return {
    key: 0, freq: 0, instrument: 0, custom: false, filters: 0, volume: 0,
    isMusic: false, phi: 0, lastAdvance: 0, lastSample: 0,
  };
}

interface SfxChannel {
  main: SfxState;
  custom: SfxState;
  sfxMusic: number; // music sfx id to restore after this channel's sfx ends
  length: number;
  canLoop: boolean;
  isMusic: boolean;
  lastSynth: Synth;
  fadeSynth: Synth;
  fade: number;
  lastInstrument: number;
  lastKey: number;
  reverbIndex: number;
  reverb2: Float32Array;
  reverb4: Float32Array;
  damp1: Filter;
  damp2: Filter;
}

interface MusicChannel {
  count: number;
  pattern: number;
  mask: number;
  volumeMusic: number;
  volumeSfx: number;
  fadeVolume: number;
  fadeStep: number;
  offset: number;
  length: number;
}

function makeChannel(): SfxChannel {
  const damp1 = new Filter();
  damp1.init("highshelf", 2400, 1, -6); // Audio.cpp:62
  const damp2 = new Filter();
  damp2.init("highshelf", 1000, 1, -12); // Audio.cpp:63
  return {
    main: emptySfxState(),
    custom: emptySfxState(),
    sfxMusic: -1,
    length: 0,
    canLoop: true,
    isMusic: false,
    lastSynth: emptySynth(),
    fadeSynth: emptySynth(),
    fade: 0,
    lastInstrument: 0xff,
    lastKey: 0xff,
    reverbIndex: 0,
    reverb2: new Float32Array(366),
    reverb4: new Float32Array(732),
    damp1,
    damp2,
  };
}

const keyToFreq = (key: number): number =>
  440 * Math.pow(2, (key - 33) / 12); // Audio.cpp:352-356

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export class Audio {
  readonly music: MusicChannel = {
    count: -1, pattern: -1, mask: 0,
    volumeMusic: 0.5, volumeSfx: 0.5,
    fadeVolume: 0, fadeStep: 0, offset: -1, length: 0,
  };
  readonly channels: SfxChannel[] = [0, 1, 2, 3].map(makeChannel);
  paused = false;

  constructor(private readonly mem: PicoMemory) {
    this.reset();
  }

  /** resetAudioState (Audio.cpp:29-65). */
  reset(): void {
    this.music.count = -1;
    this.music.pattern = -1;
    this.music.mask = 0;
    this.music.volumeMusic = 0.5;
    this.music.volumeSfx = 0.5;
    this.music.fadeVolume = 0;
    this.music.fadeStep = 0;
    this.music.offset = -1;
    this.music.length = 0;
    for (const ch of this.channels) {
      ch.main = emptySfxState();
      ch.custom = emptySfxState();
      ch.sfxMusic = -1;
      ch.length = 0;
      ch.canLoop = true;
      ch.isMusic = false;
      ch.lastInstrument = 0xff;
      ch.lastKey = 0xff;
      ch.reverbIndex = 0;
      ch.reverb2.fill(0);
      ch.reverb4.fill(0);
      ch.fade = 0;
      ch.lastSynth = emptySynth();
      ch.fadeSynth = emptySynth();
      ch.damp1.init("highshelf", 2400, 1, -6);
      ch.damp2.init("highshelf", 1000, 1, -12);
    }
  }

  // -----------------------------------------------------------------------
  // stat getters (Audio.cpp:358-378)

  currentSfxId(ch: number): number {
    return this.channels[ch].main.sfx;
  }

  currentNote(ch: number): number {
    const c = this.channels[ch];
    return c.main.sfx < 0 ? -1 : Math.trunc(c.main.offset);
  }

  currentMusic(): number {
    return this.music.pattern;
  }

  musicPatternCount(): number {
    return this.music.count;
  }

  musicTickCount(): number {
    return this.music.offset | 0; // (int16) cast
  }

  // -----------------------------------------------------------------------
  // api_sfx (Audio.cpp:71-207). channel > 3 rejected (C accepts 4 = OOB).

  apiSfx(sfx: number, channel: number, offset: number, length: number): number {
    if (sfx < -2 || sfx > 63 || channel < -2 || channel > 3 || offset > 31) {
      return 0;
    }
    // channel -2: stop the given sound on any channel
    if (channel === -2) {
      for (const c of this.channels) {
        if (c.main.sfx === sfx) c.main.sfx = -1;
      }
      return 0;
    }
    if (sfx === -1) {
      // stop non-music sfx only
      if (channel !== -1) {
        if (!this.channels[channel].isMusic) this.channels[channel].main.sfx = -1;
      } else {
        for (const c of this.channels) {
          if (!c.isMusic) c.main.sfx = -1;
        }
      }
      return 0;
    }
    if (sfx === -2) {
      // stop looping (does NOT stop playback)
      if (channel !== -1) {
        if (!this.channels[channel].isMusic) this.channels[channel].canLoop = false;
      } else {
        for (const c of this.channels) {
          if (!c.isMusic) c.canLoop = false;
        }
      }
      return 0;
    }

    // autoselect: free/idle-or-same channel, then a music channel, then the
    // fastest-playing channel (ties go to the later channel), skipping the
    // music mask each time.
    const mask = this.music.mask;
    if (channel === -1) {
      for (let i = 0; i < 4; i++) {
        if ((1 << i) & mask) continue;
        if (this.channels[i].main.sfx === -1 || this.channels[i].main.sfx === sfx) {
          channel = i;
          break;
        }
      }
    }
    if (channel === -1) {
      for (let i = 0; i < 4; i++) {
        if ((1 << i) & mask) continue;
        if (this.channels[i].isMusic) {
          channel = i;
          break;
        }
      }
    }
    if (channel === -1) {
      let fastest = 255;
      for (let i = 0; i < 4; i++) {
        if ((1 << i) & mask) continue;
        const idx = this.channels[i].main.sfx;
        if (idx < 0 || idx >= 64) continue;
        const sp = sfxSpeed(this.mem, idx);
        if (sp <= fastest) {
          channel = i;
          fastest = sp;
        }
      }
    }
    if (channel === -1) return 0;

    // stop every channel playing this sfx (incl. the chosen one)
    for (const c of this.channels) {
      if (c.main.sfx === sfx) c.main.sfx = -1;
    }
    // preserve a music sfx on this channel for later resumption
    const target = this.channels[channel];
    if (target.main.sfx !== -1 && target.isMusic) {
      target.sfxMusic = target.main.sfx;
    }
    this.launchSfx(sfx, channel, Math.max(0, offset), Math.max(0, length), false);
    return channel;
  }

  /** api_music (Audio.cpp:209-238). */
  apiMusic(pattern: number, fadeLen: number, mask: number): void {
    if (pattern < -1 || pattern > 63) return;
    if (pattern === -1) {
      this.music.fadeStep = fadeLen <= 0
        ? -Number.MAX_VALUE
        : -this.music.fadeVolume * (1000 / fadeLen);
      return;
    }
    this.music.count = 0;
    this.music.mask = mask & 0xf;
    this.music.fadeVolume = 1;
    this.music.fadeStep = 0;
    if (fadeLen > 0) {
      this.music.fadeVolume = 0;
      this.music.fadeStep = 1000 / fadeLen;
    }
    this.setMusicPattern(pattern);
  }

  /** set_music_pattern (Audio.cpp:240-332). */
  setMusicPattern(pattern: number): void {
    // stop previously playing music sounds
    for (const c of this.channels) {
      if (c.isMusic) {
        c.main.sfx = -1;
        c.sfxMusic = -1;
      }
    }
    if (pattern < 0 || pattern > 63) {
      this.music.pattern = -1;
      this.music.count = -1;
      this.music.offset = -1;
      this.music.mask = 0;
      this.music.length = 0;
      return;
    }
    const chans = [0, 1, 2, 3].map((i) => songChannel(this.mem, pattern, i));
    let durationLooping = -1;
    let durationNoLoop = -1;
    for (let i = 0; i < 4; i++) {
      const n = chans[i];
      if (n & 0x40) continue;
      const idx = n & 0x3f;
      const loopEnd = sfxLoopEnd(this.mem, idx);
      const loopStart = sfxLoopStart(this.mem, idx);
      const hasLoop = loopEnd > 0 && loopEnd > loopStart;
      if (hasLoop) {
        durationLooping = Math.max(durationLooping, 32 * sfxSpeed(this.mem, idx));
      } else {
        let endTime = 32;
        if (loopEnd === 0 && loopStart > 0) endTime = Math.min(endTime, loopStart);
        durationNoLoop = endTime * sfxSpeed(this.mem, idx);
        break;
      }
    }
    let duration = durationNoLoop > 0 ? durationNoLoop : durationLooping;
    if (duration <= 0) duration = 32;

    this.music.pattern = pattern;
    this.music.offset = 0;
    this.music.length = duration;

    for (let i = 0; i < 4; i++) {
      const n = chans[i];
      if (n & 0x40) continue;
      if (this.channels[i].main.sfx === -1) {
        this.launchSfx(n, i, 0, 0, true);
      } else {
        this.channels[i].sfxMusic = n;
      }
    }
  }

  /** launch_sfx (Audio.cpp:334-350). */
  private launchSfx(
    sfx: number, chan: number, offset: number, length: number, isMusic: boolean,
  ): void {
    const c = this.channels[chan];
    c.main.sfx = sfx;
    c.main.offset = Math.max(0, offset);
    c.main.time = 0;
    c.length = Math.max(0, length);
    c.canLoop = true;
    c.isMusic = isMusic;
    c.lastInstrument = 0xff;
    c.lastKey = 0xff;
    c.main.prevKey = 24;
    c.main.prevVol = 0;
  }

  // -----------------------------------------------------------------------
  // update_sfx_state (Audio.cpp:380-535) — advances one sfx state machine by
  // one output sample and fills the scratch synth parameters.

  private updateSfxState(
    cur: SfxState,
    ns: Synth,
    freqFactor: number,
    length: number,
    isMusic: boolean,
    canLoop: boolean,
    halfRate: boolean,
    invFps: number,
  ): void {
    if (cur.sfx === -1) return;
    const index = cur.sfx;
    const speed = Math.max(1, sfxSpeed(this.mem, index));
    const offset = cur.offset;
    const time = cur.time;

    const offsetPerSecond = SAMPLE_RATE / (SAMPLES_PER_NOTE * speed);
    const offsetPerFrame = offsetPerSecond * invFps;
    let nextOffset = offset + offsetPerFrame;
    let nextTime = time + offsetPerFrame;

    const loopStart = sfxLoopStart(this.mem, index);
    const loopEnd = sfxLoopEnd(this.mem, index);
    const loopRange = loopEnd - loopStart;
    if (loopRange > 0 && nextOffset >= loopEnd && canLoop) {
      nextOffset = ((nextOffset - loopStart) % loopRange) + loopStart;
    }

    let hasEnd = false;
    let endTime = 32;
    if (length > 0) {
      hasEnd = true;
      endTime = length;
    }
    if (!isMusic && loopEnd === 0 && loopStart > 0) {
      hasEnd = true;
      endTime = Math.min(endTime, loopStart);
    }
    if (loopRange <= 0) {
      hasEnd = true;
      if (!isMusic) {
        let lastNote = 0;
        for (let n = 0; n < 32; n++) {
          if (noteVolume(this.mem, index, n) > 0) lastNote = Math.min(32, n + 1);
        }
        endTime = Math.min(endTime, lastNote);
      }
    }

    if (offset < 32) {
      const noteId = Math.floor(offset);
      const nextNoteId = Math.floor(nextOffset);
      const key = noteKey(this.mem, index, noteId);
      let volume = noteVolume(this.mem, index, noteId) / 7;
      let freq = keyToFreq(key) * freqFactor;

      if (volume > 0) {
        const fx = noteEffect(this.mem, index, noteId);
        switch (fx) {
          case FX.NONE:
            break;
          case FX.SLIDE: {
            const t = offset - Math.floor(offset);
            freq = lerp(keyToFreq(cur.prevKey), freq, t);
            if (cur.prevVol > 0) volume = lerp(cur.prevVol, volume, t);
            break;
          }
          case FX.VIBRATO: {
            // triangle modulation at 7.5 Hz, ± half a semitone
            const t = Math.abs(((7.5 * offset) / offsetPerSecond) % 1 - 0.5) - 0.25;
            freq = lerp(freq, freq * 1.059463094359, t);
            break;
          }
          case FX.DROP:
            freq *= 1 - (offset - Math.floor(offset));
            break;
          case FX.FADE_IN:
            volume *= offset - Math.floor(offset);
            break;
          case FX.FADE_OUT:
            volume *= 1 - (offset - Math.floor(offset));
            break;
          case FX.ARP_FAST:
          case FX.ARP_SLOW: {
            const m = (speed <= 8 ? 32 : 16) / (fx === FX.ARP_FAST ? 4 : 8);
            const n = Math.trunc((m * 7.5 * offset) / offsetPerSecond);
            const arpNote = (noteId & ~3) | (n & 3);
            freq = keyToFreq(noteKey(this.mem, index, arpNote));
            break;
          }
        }

        if (halfRate) freq *= 0.5;
        ns.key = key;
        ns.freq = freq;
        ns.instrument = noteWaveform(this.mem, index, noteId);
        ns.custom = noteCustom(this.mem, index, noteId) !== 0;
        ns.filters = sfxFilters(this.mem, index);
        ns.volume = volume;
        ns.isMusic = isMusic;
        ns.phi = ns.phi + freq * invFps;
      }

      if (nextNoteId !== noteId) {
        cur.prevKey = noteKey(this.mem, index, noteId);
        cur.prevVol = noteVolume(this.mem, index, noteId) / 7;
      }
    }

    cur.offset = nextOffset;
    cur.time = nextTime;
    if (hasEnd && nextTime >= endTime) cur.sfx = -1;
  }

  // -----------------------------------------------------------------------
  // waveform (synth.cpp:27-119)

  private waveform(p: Synth): number {
    const advance = p.phi;
    const t = advance - Math.floor(advance);
    const noiz = (p.filters & 0x2) !== 0;
    const buzz = (p.filters & 0x4) !== 0;
    let ret = 0;
    switch (p.instrument) {
      case 0: { // TRIANGLE
        ret = 1.0 - Math.abs(4.0 * t - 2.0);
        if (buzz) {
          const a = 0.875;
          const bret = t < a ? (2 * t) / a - 1 : (2 * (1 - t)) / (1 - a) - 1;
          ret = ret * 0.75 + bret * 0.25;
        }
        return ret * 0.5;
      }
      case 1: { // TILTED_SAW
        const a = buzz ? 0.975 : 0.875;
        ret = t < a ? (2 * t) / a - 1 : (2 * (1 - t)) / (1 - a) - 1;
        return ret * 0.5;
      }
      case 2: { // SAW
        ret = t < 0.5 ? t : t - 1;
        if (buzz) {
          ret = ret * 0.83 - (Math.abs(((advance % 2) + 2) % 2 - 1) < 0.5 ? 0.085 : 0);
        }
        return 0.653 * ret;
      }
      case 3: // SQUARE
        return t < (buzz ? 0.4 : 0.5) ? 0.25 : -0.25;
      case 4: // PULSE
        return t < (buzz ? 0.255 : 0.316) ? 0.25 : -0.25;
      case 5: { // ORGAN
        ret = t < 0.5 ? 3 - Math.abs(24 * t - 6) : 1 - Math.abs(16 * t - 12);
        if (buzz) {
          ret = t < 0.5 ? ret * 2 + 3 : ret;
          ret = t < 0.5 && ret > -1.875 ? ret * 0.2 - 1 : ret + 0.5;
        }
        return ret / 9;
      }
      case 6: { // NOISE
        const tscale = 8.858923;
        const scale = (advance - p.lastAdvance) * tscale;
        const newSample =
          (p.lastSample + scale * (Math.random() * 2 - 1)) / (1 + scale);
        const factor = 1 - p.key / 63;
        ret = newSample * 1.5 * (1 + factor * factor);
        if (noiz) ret *= 2 * (t < 0.5 ? t : t - 1);
        p.lastAdvance = advance;
        p.lastSample = newSample;
        return ret;
      }
      case 7: { // PHASER
        ret = 2 - Math.abs(8 * t - 4);
        const adv2 = advance * (109 / 110);
        ret += 1 - Math.abs(4 * (((adv2 % 1) + 1) % 1) - 2);
        if (buzz) {
          ret += 0.25 - Math.abs(1 * ((((advance * 2 + 0.5) % 1) + 1) % 1) - 0.5);
          ret += 0.125 - Math.abs(0.5 * ((((advance * 4) % 1) + 1) % 1) - 0.25);
        }
        return ret / 6;
      }
      default:
        return 0;
    }
  }

  /** get_synth_sample (Audio.cpp:537-576): waveform + detune + master vol. */
  private synthSample(p: Synth): number {
    let wave = this.waveform(p);
    const detune = Math.trunc(p.filters / 8) % 3;
    if (detune !== 0 && p.instrument !== 6) {
      let factor = 1;
      if (p.instrument === 0) factor = detune === 1 ? 3 / 4 : 3 / 2;
      else if (p.instrument === 5) factor = detune === 1 ? 200 / 199 : 800 / 199;
      else if (p.instrument === 7) factor = detune === 1 ? 49 / 50 : 400 / 199;
      else factor = detune === 1 ? 200 / 199 : 400 / 199;
      const second: Synth = { ...p, phi: p.phi * factor };
      if (detune === 2 && p.instrument === 5) second.instrument = 0;
      wave += this.waveform(second) * 0.5;
    }
    let volume = p.volume;
    if (p.isMusic) {
      volume *= this.music.fadeVolume * this.music.volumeMusic;
    } else {
      volume *= this.music.volumeSfx;
    }
    return clamp(wave * volume, -1, 1);
  }

  // -----------------------------------------------------------------------
  // FillAudioBuffer mono path (Audio.cpp:799-1004 ≡ 578-796 stereo logic).
  // Advances ALL playback state — there is no separate frame update.

  fillMono(out: Int16Array, offset = 0, size?: number): void {
    const n = size ?? out.length - offset;
    const d = this.mem.data;
    const hwHalf = d[HW.HALF_RATE];
    const hwRev = d[HW.REVERB];
    const hwDist = d[HW.DISTORT];
    const hwLp = d[HW.LOWPASS];
    const isPauseSound = d[0x5f2f] === 1; // drawState.soundPauseState

    if (this.paused) {
      out.fill(0, offset, offset + n);
      return;
    }

    for (let i = 0; i < n; i++) {
      let channelMix = 0;
      for (let chan = 0; chan < 4; chan++) {
        const c = this.channels[chan];
        const invFps = ((hwHalf & (1 << chan)) ? 0.5 : 1) / SAMPLE_RATE;

        // advance music on channel 0
        if (chan === 0 && this.music.pattern !== -1 && !isPauseSound) {
          const tickPerSec = SAMPLE_RATE / SAMPLES_PER_NOTE;
          this.music.offset += tickPerSec * invFps;
          this.music.fadeVolume += this.music.fadeStep * invFps;
          this.music.fadeVolume = clamp(this.music.fadeVolume, 0, 1);
          if (this.music.fadeStep < 0 && this.music.fadeVolume <= 0) {
            this.setMusicPattern(-1);
          } else if (this.music.offset >= this.music.length) {
            let nextPattern = this.music.pattern + 1;
            let nextCount = this.music.count + 1;
            if (songStop(this.mem, this.music.pattern)) {
              nextPattern = -1;
              nextCount = -1;
            } else if (songLoop(this.mem, this.music.pattern)) {
              while (--nextPattern > 0 && !songStart(this.mem, nextPattern)) {
                /* scan back to the start flag */
              }
            }
            this.music.count = nextCount;
            this.setMusicPattern(nextPattern);
          }
        }

        // resume a stored music sfx when this channel goes idle
        if (c.main.sfx === -1 && c.sfxMusic !== -1 && !isPauseSound) {
          const index = c.sfxMusic;
          const speed = Math.max(1, sfxSpeed(this.mem, index));
          let wantPlay = true;
          let newOffset = this.music.offset / speed;
          const loopStart = sfxLoopStart(this.mem, index);
          const loopEnd = sfxLoopEnd(this.mem, index);
          const loopRange = loopEnd - loopStart;
          if (loopRange > 0 && c.canLoop) {
            if (newOffset > loopStart) {
              newOffset = ((newOffset - loopStart) % loopRange) + loopStart;
            }
          } else if (newOffset > 32) {
            wantPlay = false;
          }
          if (wantPlay) this.launchSfx(index, chan, newOffset, 0, true);
          c.sfxMusic = -1;
        }

        // per-sample synth scratch: inherits phase history
        const ns = c.lastSynth;
        const scratch: Synth = {
          ...ns,
          phi: ns.phi,
          lastAdvance: ns.lastAdvance,
          lastSample: ns.lastSample,
        };
        let value = 0;

        if (!isPauseSound) {
          const baseOffset = c.main.offset;
          const halfRate = (hwHalf & (1 << (chan + 4))) !== 0;
          this.updateSfxState(
            c.main, scratch, 1, c.length, c.isMusic, c.canLoop, halfRate, invFps,
          );

          let restartCustom =
            scratch.instrument !== c.lastInstrument ||
            scratch.key !== c.lastKey;
          c.lastInstrument = scratch.instrument;
          c.lastKey = scratch.key;

          if (scratch.volume > 0) {
            if (scratch.custom) {
              if (c.main.offset < baseOffset) restartCustom = true;
              if (
                c.custom.sfx === -1 &&
                Math.floor(baseOffset) !== Math.floor(c.main.offset)
              ) {
                restartCustom = true;
              }
              if (restartCustom) {
                c.custom.sfx = scratch.instrument;
                c.custom.offset = 0;
                c.custom.time = 0;
              }
              scratch.phi = ns.phi;
              const freqBase = keyToFreq(24);
              const freqFactor = scratch.freq / freqBase;
              const mainVolume = scratch.volume;
              this.updateSfxState(c.custom, scratch, freqFactor, 0, false, true, halfRate, invFps);
              scratch.volume *= mainVolume;
            }
            value = this.synthSample(scratch);
          }
        }

        // crossfade on harsh state changes (Audio.cpp:714-754)
        const freqThreshold = Math.min(scratch.freq, ns.freq) * 0.01;
        if (
          Math.abs(scratch.volume - ns.volume) > 0.1 ||
          Math.abs(scratch.freq - ns.freq) > freqThreshold ||
          scratch.instrument !== ns.instrument
        ) {
          if (c.fade <= 0) c.fadeSynth = { ...ns };
          c.fade = 1;
          scratch.phi = scratch.phi - Math.floor(scratch.phi);
        }
        // commit
        ns.key = scratch.key;
        ns.freq = scratch.freq;
        ns.instrument = scratch.instrument;
        ns.custom = scratch.custom;
        ns.filters = scratch.filters;
        ns.volume = scratch.volume;
        ns.isMusic = scratch.isMusic;
        ns.phi = scratch.phi;
        ns.lastAdvance = scratch.lastAdvance;
        ns.lastSample = scratch.lastSample;

        const reverb = Math.trunc(ns.filters / 24) % 3;
        const dampen = Math.trunc(ns.filters / 72) % 3;
        let rev1 = reverb === 1 ? 1 : 0;
        let rev2 = reverb === 2 ? 1 : 0;
        let damp1v = dampen === 1 ? 1 : 0;
        let damp2v = dampen === 2 ? 1 : 0;

        if (c.fade > 0) {
          const fs = c.fadeSynth;
          fs.phi += fs.freq * invFps;
          const valueFade = this.synthSample(fs);
          value = lerp(value, valueFade, c.fade);
          const fadeReverb = Math.trunc(fs.filters / 24) % 3;
          const fadeDampen = Math.trunc(fs.filters / 72) % 3;
          rev1 = lerp(rev1, fadeReverb === 1 ? 1 : 0, c.fade);
          rev2 = lerp(rev2, fadeReverb === 2 ? 1 : 0, c.fade);
          damp1v = lerp(damp1v, fadeDampen === 1 ? 1 : 0, c.fade);
          damp2v = lerp(damp2v, fadeDampen === 2 ? 1 : 0, c.fade);
          c.fade -= 130 * invFps;
        }

        // hardware-forced fx
        if (hwRev & (1 << (chan + 4))) rev1 = 1;
        if (hwRev & (1 << chan)) rev2 = 1;
        if (hwLp & (1 << (chan + 4))) damp1v = 1;
        if (hwLp & (1 << chan)) damp2v = 1;

        const ri = c.reverbIndex;
        if (rev1 > 0) value += rev1 * c.reverb2[ri % 366] * 0.5;
        if (rev2 > 0) value += rev2 * c.reverb4[ri % 732] * 0.5;
        c.reverb2[ri % 366] = value;
        c.reverb4[ri % 732] = value;
        c.reverbIndex = (ri + 1) | 0;

        const d1 = c.damp1.run(value);
        if (damp1v > 0) value = lerp(value, d1, damp1v);
        const d2 = c.damp2.run(value);
        if (damp2v > 0) value = lerp(value, d2, damp2v);

        let chanSample = Math.trunc(32767.99 * clamp(value, -0.99, 0.99));
        // hardware distort — C integer division on int16 (Audio.cpp:777-787)
        if (hwDist & (1 << chan)) {
          chanSample = (Math.trunc(chanSample / 0x1000) * 0x1249) << 16 >> 16;
        } else if (hwDist & (1 << (chan + 4))) {
          chanSample =
            ((Math.trunc((chanSample - (chanSample < 0 ? 0x1000 : 0)) / 0x1000) *
              0x1249) << 16) >> 16;
        }
        channelMix += chanSample;
      }
      const sample = Math.trunc(clamp(channelMix, -32767.9, 32767.9));
      out[offset + i] = sample << 16 >> 16;
    }
  }
}

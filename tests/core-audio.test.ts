// audio.ts — port of fake-08 test/audiotests.cpp (T1 vibrato + T2 state
// machine; the bass-loop subcase needs songtest.p8 and is deferred).
import { describe, expect, it } from "vitest";
import { PicoMemory } from "../src/core/memory.ts";
import { Audio, SAMPLE_RATE, FX } from "../src/core/audio.ts";

function mk(): { mem: PicoMemory; audio: Audio } {
  const mem = new PicoMemory();
  mem.reset();
  return { mem, audio: new Audio(mem) };
}

/** note setters exactly as PicoRam.h:74-105 */
function writeNote(
  mem: PicoMemory, sfx: number, n: number,
  key: number, wave: number, vol: number, effect: number,
): void {
  const b = 0x3200 + sfx * 68 + n * 2;
  mem.data[b] = ((wave << 6) & 0xc0) | (key & 0x3f);
  mem.data[b + 1] =
    ((wave >> 2) & 1) | ((vol << 1) & 0x0e) | ((effect << 4) & 0x70);
}

describe("audiotests T1 — vibrato produces smooth triangle modulation", () => {
  it("zero-crossing intervals, max jump, and RMS match doctest thresholds", () => {
    const { mem, audio } = mk();
    for (let n = 0; n < 32; n++) {
      writeNote(mem, 0, n, 24, 3, 7, FX.VIBRATO);
    }
    mem.data[0x3200 + 65] = 16; // speed

    expect(audio.apiSfx(0, 0, 0, 31)).toBe(0); // channel 0

    const num = SAMPLE_RATE;
    const samples = new Int16Array(num);
    audio.fillMono(samples, 0, num);

    // positive-going zero crossings (audiotests.cpp:89-96)
    const intervals: number[] = [];
    let last = -1;
    for (let i = 1; i < num; i++) {
      if (samples[i - 1] <= 0 && samples[i] > 0) {
        if (last >= 0) intervals.push(i - last);
        last = i;
      }
    }
    expect(intervals.length).toBeGreaterThan(100);

    let maxJump = 0;
    for (let i = 1; i < intervals.length; i++) {
      const jump = Math.abs(intervals[i] - intervals[i - 1]);
      if (jump > maxJump) maxJump = jump;
    }
    expect(maxJump).toBeLessThanOrEqual(5);

    let rms = 0;
    for (let i = 0; i < num; i++) rms += samples[i] * samples[i];
    rms = Math.sqrt(rms / num);
    expect(rms).toBeGreaterThan(100);
  });
});

describe("audiotests T2 — audio class behaves as expected", () => {
  it("constructor sets sfx channels to -1", () => {
    const { audio } = mk();
    for (const c of audio.channels) expect(c.main.sfx).toBe(-1);
  });

  it("api_sfx() with valid values sets the sfx to be played", () => {
    const { audio } = mk();
    expect(audio.apiSfx(3, 0, 0, 31)).toBe(0);
    expect(audio.channels[0].main.sfx).toBe(3);
  });

  it("api_sfx() with -1 channel finds first available", () => {
    const { audio } = mk();
    audio.apiSfx(1, 0, 0, 31);
    audio.apiSfx(2, 1, 0, 31);
    expect(audio.apiSfx(5, -1, 0, 31)).toBe(2);
    expect(audio.channels[2].main.sfx).toBe(5);
  });

  it("api_sfx() with -2 channel stops the sfx on any channel", () => {
    const { audio } = mk();
    audio.apiSfx(1, 0, 0, 31);
    audio.apiSfx(10, 1, 0, 31);
    audio.apiSfx(20, 2, 0, 31);
    audio.apiSfx(1, 3, 0, 31);
    audio.apiSfx(1, -2, 0, 31);
    expect(audio.channels[0].main.sfx).toBe(-1);
    expect(audio.channels[1].main.sfx).toBe(10);
    expect(audio.channels[2].main.sfx).toBe(20);
    expect(audio.channels[3].main.sfx).toBe(-1);
  });

  it("api_sfx() -2 sfx id stops looping only", () => {
    const { audio } = mk();
    audio.channels[3].canLoop = true;
    audio.apiSfx(-2, 3, 0, 31);
    expect(audio.channels[3].canLoop).toBe(false);
  });

  it("api_music sets music pattern", () => {
    const { audio } = mk();
    audio.apiMusic(14, 0, 0);
    expect(audio.music.pattern).toBe(14);
  });

  it("api_music sets sfx channels from song data", () => {
    const { mem, audio } = mk();
    mem.data[0x3100 + 3 * 4] = 9;
    mem.data[0x3100 + 3 * 4 + 1] = 10;
    mem.data[0x3100 + 3 * 4 + 2] = 11;
    mem.data[0x3100 + 3 * 4 + 3] = 12;
    audio.apiMusic(3, 0, 0);
    expect(audio.channels[0].main.sfx).toBe(9);
    expect(audio.channels[1].main.sfx).toBe(10);
    expect(audio.channels[2].main.sfx).toBe(11);
    expect(audio.channels[3].main.sfx).toBe(12);
    expect(audio.music.pattern).toBe(3);
    expect(audio.music.length).toBe(32); // default when speed=0 sfx → 0 duration
  });
});

describe("audio fill pipeline", () => {
  it("produces non-silent output for a plain sfx and silence when paused", () => {
    const { mem, audio } = mk();
    writeNote(mem, 0, 0, 24, 3, 7, FX.NONE);
    mem.data[0x3200 + 65] = 16;
    audio.apiSfx(0, 0, 0, -1);
    const out = new Int16Array(2048);
    audio.fillMono(out);
    const energy = out.reduce((s, v) => s + Math.abs(v), 0);
    expect(energy).toBeGreaterThan(0);

    audio.paused = true;
    out.fill(7);
    audio.fillMono(out);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("stat-style getters track playback", () => {
    const { mem, audio } = mk();
    expect(audio.currentSfxId(0)).toBe(-1);
    expect(audio.currentNote(0)).toBe(-1);
    for (let n = 0; n < 32; n++) writeNote(mem, 3, n, 24, 3, 7, FX.NONE);
    mem.data[0x3200 + 3 * 68 + 65] = 16;
    audio.apiSfx(3, 0, 0, 31);
    expect(audio.currentSfxId(0)).toBe(3);
    // advance past one note boundary (183*16 = 2928 samples/note)
    audio.fillMono(new Int16Array(4000));
    expect(audio.currentSfxId(0)).toBe(3);
    expect(audio.currentNote(0)).toBeGreaterThan(0);
    expect(audio.currentMusic()).toBe(-1);
  });
});

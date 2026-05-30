// Unit tests for the pure DSP / music-theory functions. These run in Node with
// no DOM, validating the analysis math independently of the browser UI.

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectPitch, frequencyToNote, noteToFrequency } from "../js/pitch.js";
import { estimateTempo, analyzeTiming, smoothBpm, beatGrid } from "../js/rhythm.js";

const SR = 44100;

function sine(freq, samples, sr = SR, amp = 0.9) {
  const buf = new Float32Array(samples);
  for (let i = 0; i < samples; i++) buf[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return buf;
}

test("frequencyToNote identifies A4 = 440Hz exactly", () => {
  const n = frequencyToNote(440, 440);
  assert.equal(n.name, "A");
  assert.equal(n.octave, 4);
  assert.equal(n.midi, 69);
  assert.equal(n.cents, 0);
});

test("frequencyToNote identifies middle C (C4 ~261.63Hz)", () => {
  const n = frequencyToNote(261.63, 440);
  assert.equal(n.name, "C");
  assert.equal(n.octave, 4);
  assert.equal(n.midi, 60);
});

test("frequencyToNote reports a sharp deviation in cents", () => {
  // 15 cents sharp of A4.
  const f = 440 * Math.pow(2, 15 / 1200);
  const n = frequencyToNote(f, 440);
  assert.equal(n.midi, 69);
  assert.ok(Math.abs(n.cents - 15) <= 1, `expected ~15 cents, got ${n.cents}`);
});

test("noteToFrequency round-trips with frequencyToNote", () => {
  for (const midi of [60, 69, 45, 81]) {
    const f = noteToFrequency(midi, 440);
    assert.equal(frequencyToNote(f, 440).midi, midi);
  }
});

test("detectPitch recovers a 440Hz sine within 1Hz", () => {
  const buf = sine(440, 2048);
  const f = detectPitch(buf, SR);
  assert.ok(Math.abs(f - 440) < 1, `got ${f}`);
});

test("detectPitch recovers a 220Hz sine within 1Hz", () => {
  const buf = sine(220, 2048);
  const f = detectPitch(buf, SR);
  assert.ok(Math.abs(f - 220) < 1, `got ${f}`);
});

test("detectPitch returns -1 for silence", () => {
  const buf = new Float32Array(2048); // all zeros
  assert.equal(detectPitch(buf, SR), -1);
});

test("estimateTempo recovers 120 BPM from a synthetic onset envelope", () => {
  // Build a 100Hz flux envelope with a spike every 0.5s (= 120 BPM).
  const fps = 100;
  const seconds = 8;
  const period = 0.5;
  const flux = [];
  for (let i = 0; i < seconds * fps; i++) {
    const t = i / fps;
    const phase = (t % period) / period;
    flux.push({ t, value: phase < 0.03 ? 100 : 1 });
  }
  const res = estimateTempo(flux);
  assert.ok(res, "expected a tempo estimate");
  // A pure 0.5s click train is octave-ambiguous (60/120/240 all fit); accept
  // any octave equivalent of 120.
  const octaveOk = [60, 120, 240].some((b) => Math.abs(res.bpm - b) <= 3);
  assert.ok(octaveOk, `got ${res.bpm} BPM`);
});

test("estimateTempo honours a narrowed BPM range", () => {
  const fps = 100;
  const seconds = 8;
  const period = 0.5;
  const flux = [];
  for (let i = 0; i < seconds * fps; i++) {
    const t = i / fps;
    flux.push({ t, value: (t % period) / period < 0.03 ? 100 : 1 });
  }
  // Force the 120 octave by excluding 60.
  const res = estimateTempo(flux, { minBpm: 90, maxBpm: 200 });
  assert.ok(Math.abs(res.bpm - 120) <= 3, `got ${res.bpm} BPM`);
});

test("smoothBpm seeds from the first reading", () => {
  assert.equal(smoothBpm(0, 120), 120);
  assert.equal(smoothBpm(120, 0), 120); // missing raw keeps previous
});

test("smoothBpm adds inertia (small step toward raw)", () => {
  const next = smoothBpm(120, 130, 0.1);
  assert.ok(next > 120 && next < 122, `got ${next}`);
});

test("smoothBpm folds octave errors toward the previous tempo", () => {
  // A doubled estimate should be folded back near 120, not jump to 240.
  const next = smoothBpm(120, 240, 0.5);
  assert.ok(Math.abs(next - 120) < 1, `got ${next}`);
  // A halved estimate likewise.
  const next2 = smoothBpm(120, 60, 0.5);
  assert.ok(Math.abs(next2 - 120) < 1, `got ${next2}`);
});

test("beatGrid recovers the phase of on-beat onsets", () => {
  const period = 0.5; // 120 BPM
  const phase = 0.2;  // beats fall at 0.2, 0.7, 1.2, ...
  const onsets = [0.2, 0.7, 1.2, 1.7, 2.2];
  const grid = beatGrid(onsets, period);
  assert.equal(grid.period, period);
  // Phase is modulo the period; should be close to 0.2.
  const diff = Math.min(Math.abs(grid.phase - phase), period - Math.abs(grid.phase - phase));
  assert.ok(diff < 0.03, `expected phase ~0.2, got ${grid.phase}`);
});

test("beatGrid is safe with no onsets or no tempo", () => {
  assert.deepEqual(beatGrid([], 0.5), { period: 0.5, phase: 0 });
  assert.deepEqual(beatGrid([1, 2], 0), { period: 0, phase: 0 });
});

test("analyzeTiming flags a late onset", () => {
  const beatPeriod = 0.5; // 120 BPM
  // On-grid onsets at every quarter beat, plus one pushed 60ms late.
  const onsets = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75 + 0.06];
  const timing = analyzeTiming(onsets, beatPeriod, { subdivisions: 2 });
  assert.equal(timing.length, onsets.length);
  const late = timing[timing.length - 1];
  assert.ok(late.errorMs > 30, `expected late onset, got ${late.errorMs}ms`);
});

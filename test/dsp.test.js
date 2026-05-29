// Unit tests for the pure DSP / music-theory functions. These run in Node with
// no DOM, validating the analysis math independently of the browser UI.

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectPitch, frequencyToNote, noteToFrequency } from "../js/pitch.js";
import { estimateTempo, analyzeTiming } from "../js/rhythm.js";

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
  // Allow octave-folded equivalents (120 is the target).
  assert.ok(Math.abs(res.bpm - 120) <= 3, `got ${res.bpm} BPM`);
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

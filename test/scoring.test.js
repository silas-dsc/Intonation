// Tests for the strictness/tolerance math and staff-position mapping.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pitchTolerance,
  rhythmTolerance,
  classify,
  strictnessLabel,
  worseClass,
} from "../js/tolerance.js";
import { midiToStaff, STAFF_REF } from "../js/staff.js";

test("stricter pitch tolerance is tighter than lenient", () => {
  const strict = pitchTolerance(100);
  const lenient = pitchTolerance(0);
  assert.ok(strict.good < lenient.good);
  assert.ok(strict.warn < lenient.warn);
  assert.equal(strict.good, 5);
  assert.equal(lenient.good, 25);
});

test("rhythm tolerance scales with strictness", () => {
  assert.equal(rhythmTolerance(100).good, 20);
  assert.equal(rhythmTolerance(0).good, 60);
  // Midpoint is between the extremes.
  const mid = rhythmTolerance(50).good;
  assert.ok(mid > 20 && mid < 60);
});

test("classify buckets values into good/warn/bad", () => {
  const tol = { good: 5, warn: 15 };
  assert.equal(classify(3, tol), "good");
  assert.equal(classify(10, tol), "warn");
  assert.equal(classify(40, tol), "bad");
  assert.equal(classify(5, tol), "good"); // boundary inclusive
});

test("worseClass returns the more severe class", () => {
  assert.equal(worseClass("good", "warn"), "warn");
  assert.equal(worseClass("bad", "good"), "bad");
  assert.equal(worseClass("warn", "warn"), "warn");
});

test("strictnessLabel covers the slider range", () => {
  assert.equal(strictnessLabel(0), "lenient");
  assert.equal(strictnessLabel(50), "medium");
  assert.equal(strictnessLabel(70), "strict");
  assert.equal(strictnessLabel(100), "very strict");
});

test("midiToStaff places middle C on the central ledger step", () => {
  const c4 = midiToStaff(60);
  assert.equal(c4.step, STAFF_REF.middleC);
  assert.equal(c4.sharp, false);
});

test("midiToStaff spells sharps on the natural's line", () => {
  const cs4 = midiToStaff(61); // C#4
  assert.equal(cs4.step, midiToStaff(60).step);
  assert.equal(cs4.sharp, true);
});

test("midiToStaff steps increase by 1 per diatonic step", () => {
  // C4 -> D4 -> E4 are consecutive diatonic steps.
  assert.equal(midiToStaff(62).step - midiToStaff(60).step, 1); // D4 - C4
  assert.equal(midiToStaff(64).step - midiToStaff(62).step, 1); // E4 - D4
  // E4 is the bottom line of the treble staff.
  assert.equal(midiToStaff(64).step, STAFF_REF.trebleBottom);
});

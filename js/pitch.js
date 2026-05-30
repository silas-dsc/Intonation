// pitch.js — fundamental-frequency detection and equal-temperament note utilities.

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/**
 * Convert a frequency to the nearest equal-temperament note, given a reference
 * A4. Returns the note name, octave, MIDI number and the signed deviation in
 * cents from the perfectly-tuned pitch (positive = sharp, negative = flat).
 */
export function frequencyToNote(freq, a4 = 440) {
  // MIDI note number (can be fractional). A4 = MIDI 69.
  const midiFloat = 69 + 12 * Math.log2(freq / a4);
  const midi = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midi) * 100);
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return { name, octave, midi, cents, freq };
}

/** Ideal frequency of a MIDI note for the given reference. */
export function noteToFrequency(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Autocorrelation-based pitch detector with parabolic peak interpolation.
 * Operates on a float time-domain buffer in [-1, 1].
 *
 * Returns the detected fundamental frequency in Hz, or -1 if the signal is too
 * quiet / unpitched to give a reliable estimate.
 */
export function detectPitch(buf, sampleRate) {
  const SIZE = buf.length;

  // Reject signals that are too quiet to be a real note.
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1;

  // Trim leading/trailing low-amplitude samples to reduce edge artifacts.
  const thres = 0.2;
  let r1 = 0;
  let r2 = SIZE - 1;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  }
  const trimmed = buf.subarray(r1, r2);
  const n = trimmed.length;
  if (n < 64) return -1;

  // Autocorrelation.
  const c = new Float32Array(n);
  for (let lag = 0; lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += trimmed[i] * trimmed[i + lag];
    c[lag] = sum;
  }

  // Find the first dip after the zero-lag peak, then the highest peak after it.
  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;

  let maxval = -Infinity;
  let maxpos = -1;
  for (let i = d; i < n; i++) {
    if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  }
  if (maxpos <= 0) return -1;

  // Parabolic interpolation around the peak for sub-sample accuracy.
  let T0 = maxpos;
  if (maxpos > 0 && maxpos < n - 1) {
    const x1 = c[maxpos - 1];
    const x2 = c[maxpos];
    const x3 = c[maxpos + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a !== 0) T0 = maxpos - b / (2 * a);
  }

  const freq = sampleRate / T0;
  if (freq < 50 || freq > 2000) return -1; // outside reasonable musical range
  return freq;
}

/**
 * Smooths a stream of pitch estimates and reports a stable note once enough
 * consecutive in-tune-window frames agree. Used to segment continuous pitch
 * tracking into discrete sung/played notes.
 */
export class NoteTracker {
  constructor({ a4 = 440, minFrames = 3 } = {}) {
    this.a4 = a4;
    this.minFrames = minFrames;
    this.currentMidi = null;
    this.frameCount = 0;
    this.centsSum = 0;
    this.startTime = 0;
  }

  setReference(a4) { this.a4 = a4; }

  /**
   * Feed one pitch estimate. Returns a completed note object when a stable note
   * ends, otherwise null. `freq <= 0` means silence/unpitched.
   */
  update(freq, time) {
    if (freq <= 0) {
      return this._flush(time);
    }
    const note = frequencyToNote(freq, this.a4);
    if (note.midi === this.currentMidi) {
      this.frameCount++;
      this.centsSum += note.cents;
      return null;
    }
    // Pitch changed — finalize the previous note and start a new one.
    const finished = this._flush(time);
    this.currentMidi = note.midi;
    this.frameCount = 1;
    this.centsSum = note.cents;
    this.startTime = time;
    return finished;
  }

  _flush(time) {
    if (this.currentMidi === null || this.frameCount < this.minFrames) {
      this.currentMidi = null;
      this.frameCount = 0;
      this.centsSum = 0;
      return null;
    }
    const meanCents = Math.round(this.centsSum / this.frameCount);
    const note = frequencyToNote(noteToFrequency(this.currentMidi, this.a4), this.a4);
    const result = {
      name: note.name,
      octave: note.octave,
      midi: this.currentMidi,
      cents: meanCents,
      idealFreq: noteToFrequency(this.currentMidi, this.a4),
      startTime: this.startTime,
      endTime: time,
    };
    this.currentMidi = null;
    this.frameCount = 0;
    this.centsSum = 0;
    return result;
  }
}

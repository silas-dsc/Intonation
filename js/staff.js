// staff.js — map MIDI notes to diatonic staff positions for grand-staff drawing.

// For each pitch class, the diatonic letter index (C=0 … B=6) it is written on,
// and whether it carries a sharp. (Sharps are spelled, e.g. C# on the C line.)
const LETTER_OF_PC = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const HAS_SHARP = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];

/**
 * Returns the diatonic "staff step" for a MIDI note (each step = one line or
 * space; higher = higher pitch) plus whether a sharp accidental is needed.
 * Middle C (MIDI 60) is step 28, which sits on the ledger line between the
 * treble and bass staves.
 */
export function midiToStaff(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const step = octave * 7 + LETTER_OF_PC[pc];
  return { step, sharp: HAS_SHARP[pc] === 1 };
}

// Diatonic staff steps of notable reference lines (for renderer convenience).
export const STAFF_REF = {
  middleC: 28, // C4 — ledger line between the staves
  trebleBottom: 30, // E4
  trebleTop: 38, // F5
  bassTop: 26, // A3
  bassBottom: 18, // G2
};

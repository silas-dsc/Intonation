// app.js — UI controller: wires controls to the Analyzer and renders live
// readouts, the rhythm timeline, worst-offender lists and the note history.

import { Analyzer } from "./analyzer.js";
import { frequencyToNote } from "./pitch.js";
import {
  pitchTolerance,
  rhythmTolerance,
  classify,
  strictnessLabel,
  worseClass,
} from "./tolerance.js";
import { midiToStaff, STAFF_REF } from "./staff.js";

const $ = (id) => document.getElementById(id);

const els = {
  micBtn: $("micBtn"),
  fileInput: $("fileInput"),
  resetBtn: $("resetBtn"),
  refPitch: $("refPitch"),
  status: $("status"),
  noteName: $("noteName"),
  noteOctave: $("noteOctave"),
  centsNeedle: $("centsNeedle"),
  centsValue: $("centsValue"),
  freqValue: $("freqValue"),
  bpmValue: $("bpmValue"),
  beatPulse: $("beatPulse"),
  confidence: $("confidence"),
  score: $("score"),
  pitchStrict: $("pitchStrict"),
  rhythmStrict: $("rhythmStrict"),
  pitchStrictOut: $("pitchStrictOut"),
  rhythmStrictOut: $("rhythmStrictOut"),
  outOfTune: $("outOfTune"),
  outOfTime: $("outOfTime"),
  historyBody: document.querySelector("#historyTable tbody"),
};

let a4 = 440;
const notes = [];        // completed notes with tuning info
let lastTiming = [];     // per-onset timing analysis
let lastTempo = null;
let latestTime = 0;      // most recent frame time (seconds)

// Accuracy thresholds, driven by the strictness sliders.
let pitchTol = pitchTolerance(50);
let rhythmTol = rhythmTolerance(50);

const analyzer = new Analyzer({
  a4,
  onFrame: handleFrame,
  onNote: handleNote,
  onOnset: handleOnset,
});

// ---------- Controls ----------

els.micBtn.addEventListener("click", async () => {
  if (analyzer.running && analyzer.stream) {
    analyzer.stop();
    setRecordingUI(false);
    setStatus("Stopped.");
    return;
  }
  try {
    setStatus("Requesting microphone…");
    await analyzer.startMic();
    setRecordingUI(true);
    setStatus("Listening… play or sing a steady note.");
    els.resetBtn.disabled = false;
  } catch (err) {
    setStatus("Microphone access failed: " + err.message);
  }
});

els.fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    resetState();
    setStatus(`Analyzing “${file.name}”…`);
    await analyzer.startFile(file);
    setRecordingUI(false);
    els.micBtn.disabled = false;
    els.resetBtn.disabled = false;
    setStatus(`Playing & analyzing “${file.name}”.`);
  } catch (err) {
    setStatus("Could not decode that file: " + err.message);
  }
  e.target.value = ""; // allow re-selecting the same file
});

els.resetBtn.addEventListener("click", () => {
  analyzer.reset();
  resetState();
  setRecordingUI(false);
  setStatus("Reset. Start again whenever you’re ready.");
});

els.refPitch.addEventListener("change", () => {
  const v = parseFloat(els.refPitch.value);
  if (v >= 400 && v <= 480) {
    a4 = v;
    analyzer.setReference(a4);
  } else {
    els.refPitch.value = a4;
  }
});

els.pitchStrict.addEventListener("input", updateStrictness);
els.rhythmStrict.addEventListener("input", updateStrictness);

function updateStrictness() {
  const p = +els.pitchStrict.value;
  const r = +els.rhythmStrict.value;
  pitchTol = pitchTolerance(p);
  rhythmTol = rhythmTolerance(r);
  els.pitchStrictOut.textContent = strictnessLabel(p);
  els.rhythmStrictOut.textContent = strictnessLabel(r);
  // Re-evaluate everything that depends on the thresholds.
  renderHistory();
  renderOutOfTune();
  renderOutOfTime();
  renderScore(notes, lastTiming, latestTime, lastTempo);
}

// ---------- Event handlers ----------

function handleFrame(data) {
  latestTime = data.time;

  // Live pitch readout.
  if (data.freq > 0) {
    const n = frequencyToNote(data.freq, a4);
    els.noteName.textContent = n.name;
    els.noteOctave.textContent = n.octave;
    els.centsValue.textContent = `${n.cents > 0 ? "+" : ""}${n.cents} cents`;
    els.freqValue.textContent = `${data.freq.toFixed(1)} Hz`;
    updateCentsNeedle(n.cents);
  }

  // Live tempo readout.
  if (data.tempo) {
    lastTempo = data.tempo;
    els.bpmValue.textContent = data.tempo.bpm;
    els.confidence.textContent = `confidence: ${(data.tempo.confidence * 100).toFixed(0)}%`;
  }

  // Refresh timing analysis periodically and redraw the score.
  const res = analyzer.analyzeTimingNow();
  if (res.timing.length) lastTiming = res.timing;
  renderScore(notes, lastTiming, data.time, data.tempo);
  renderOutOfTime();
}

function handleNote(note) {
  notes.push(note);
  renderHistory();
  renderOutOfTune();
}

function handleOnset() {
  els.beatPulse.classList.add("beat");
  setTimeout(() => els.beatPulse.classList.remove("beat"), 90);
}

// ---------- Rendering ----------

const CLASS_COLOR = { good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)" };
const HEX_COLOR = { good: "#3ddc97", warn: "#ffcc4d", bad: "#ff6b6b" };

function updateCentsNeedle(cents) {
  const clamped = Math.max(-50, Math.min(50, cents));
  const pct = ((clamped + 50) / 100) * 100;
  els.centsNeedle.style.left = `${pct}%`;
  const color = CLASS_COLOR[classify(Math.abs(cents), pitchTol)];
  els.centsNeedle.style.background = color;
  els.centsValue.style.color = color;
}

function renderHistory() {
  if (!notes.length) return;
  const rows = notes
    .slice(-60)
    .reverse()
    .map((n, i) => {
      const idx = notes.length - i;
      const timing = timingForNote(n);
      const centsCls = classify(Math.abs(n.cents), pitchTol);
      const tCell = timing
        ? `<span class="metric ${classify(Math.abs(timing.errorMs), rhythmTol)}">${
            timing.errorMs > 0 ? "+" : ""
          }${timing.errorMs.toFixed(0)} ms</span>`
        : "—";
      return `<tr>
        <td>${idx}</td>
        <td>${n.name}${n.octave}</td>
        <td>${n.idealFreq.toFixed(1)} Hz</td>
        <td><span class="metric ${centsCls}">${n.cents > 0 ? "+" : ""}${n.cents}¢</span></td>
        <td>${tCell}</td>
      </tr>`;
    })
    .join("");
  els.historyBody.innerHTML = rows;
}

function renderOutOfTune() {
  if (!notes.length) {
    els.outOfTune.innerHTML = '<li class="empty">No notes analyzed yet.</li>';
    return;
  }
  const worst = [...notes]
    .sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents))
    .slice(0, 3);
  els.outOfTune.innerHTML = worst
    .map((n) => {
      const cls = classify(Math.abs(n.cents), pitchTol);
      const dir = n.cents > 0 ? "sharp" : "flat";
      return `<li>
        <span class="label">${n.name}${n.octave}</span>
        <span class="metric ${cls}">${Math.abs(n.cents)}¢ ${dir}</span>
      </li>`;
    })
    .join("");
}

function renderOutOfTime() {
  if (!lastTiming.length) {
    els.outOfTime.innerHTML = '<li class="empty">No onsets analyzed yet.</li>';
    return;
  }
  const worst = [...lastTiming]
    .sort((a, b) => Math.abs(b.errorMs) - Math.abs(a.errorMs))
    .slice(0, 3);
  els.outOfTime.innerHTML = worst
    .map((t) => {
      const cls = classify(Math.abs(t.errorMs), rhythmTol);
      const dir = t.errorMs > 0 ? "late" : "early";
      return `<li>
        <span class="label">onset @ ${t.time.toFixed(2)}s</span>
        <span class="metric ${cls}">${Math.abs(t.errorMs).toFixed(0)} ms ${dir}</span>
      </li>`;
    })
    .join("");
}

/** Find the timing analysis entry whose onset best lines up with a note. */
function timingForNote(n) {
  let best = null;
  let bestDist = 0.12; // 120ms search window around the note's start
  for (const t of lastTiming) {
    const d = Math.abs(t.time - n.startTime);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

// --- Grand-staff score rendering ---

const SCORE = {
  height: 300,
  leftMargin: 56,   // reserved for clefs
  u: 7,             // pixels per diatonic step (half a line gap)
  windowSec: 8,
};

function renderScore(noteList, timing, now, tempo) {
  const canvas = els.score;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = SCORE.height;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const u = SCORE.u;
  const midY = cssH / 2;
  // Convert a diatonic staff step to a y coordinate (higher step = higher up).
  const yOf = (step) => midY - (step - STAFF_REF.middleC) * u;

  const plotLeft = SCORE.leftMargin;
  const plotW = cssW - plotLeft - 12;
  const start = Math.max(0, now - SCORE.windowSec);
  const xOf = (t) => plotLeft + ((t - start) / SCORE.windowSec) * plotW;

  drawStaffLines(ctx, yOf, plotLeft, cssW);
  drawClefs(ctx, yOf);

  // Beat grid as light barlines.
  if (tempo && tempo.beatPeriod > 0) {
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    const first = Math.ceil(start / tempo.beatPeriod) * tempo.beatPeriod;
    for (let t = first; t <= now; t += tempo.beatPeriod) {
      const x = xOf(t);
      ctx.beginPath();
      ctx.moveTo(x, yOf(STAFF_REF.trebleTop) - 8);
      ctx.lineTo(x, yOf(STAFF_REF.bassBottom) + 8);
      ctx.stroke();
    }
  }

  // Notes.
  for (const n of noteList) {
    const timingEntry = timing.length ? timingForNote(n) : null;
    const errorMs = timingEntry ? timingEntry.errorMs : 0;
    // Perfect rhythm position = the grid slot this note was nearest to.
    const perfectTime = n.startTime - errorMs / 1000;
    if (perfectTime < start) continue;

    const { step, sharp } = midiToStaff(n.midi);
    const perfectX = xOf(perfectTime);
    const perfectY = yOf(step);

    // Offsets: right = late, left = early; up = sharp, down = flat. Magnified
    // and clamped so small errors are still visible without overlapping.
    const dx = clamp(errorMs * 0.25, -34, 34);
    const dy = clamp(-n.cents * 0.28, -3 * u, 3 * u);

    const pitchClass = classify(Math.abs(n.cents), pitchTol);
    const timingClass = timingEntry ? classify(Math.abs(errorMs), rhythmTol) : "good";
    const overall = worseClass(pitchClass, timingClass);

    drawLedgerLines(ctx, step, perfectX, yOf, plotLeft);
    // Perfect target: hollow grey note.
    drawNotehead(ctx, perfectX, perfectY, u, { fill: false, color: "rgba(200,210,225,0.45)", sharp });
    // Actual performance: filled, colour-coded, offset from target.
    if (dx !== 0 || dy !== 0 || overall !== "good") {
      ctx.strokeStyle = HEX_COLOR[overall];
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(perfectX, perfectY);
      ctx.lineTo(perfectX + dx, perfectY + dy);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    drawNotehead(ctx, perfectX + dx, perfectY + dy, u, { fill: true, color: HEX_COLOR[overall], sharp: false });
  }

  // "Now" cursor.
  ctx.strokeStyle = "rgba(124,92,255,0.7)";
  ctx.lineWidth = 2;
  const nx = xOf(now);
  ctx.beginPath();
  ctx.moveTo(nx, yOf(STAFF_REF.trebleTop) - 8);
  ctx.lineTo(nx, yOf(STAFF_REF.bassBottom) + 8);
  ctx.stroke();
}

function drawStaffLines(ctx, yOf, plotLeft, cssW) {
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 1;
  // Treble: E4,G4,B4,D5,F5 (steps 30,32,34,36,38); Bass: G2..A3 (18,20,22,24,26).
  const lines = [30, 32, 34, 36, 38, 18, 20, 22, 24, 26];
  for (const step of lines) {
    const y = Math.round(yOf(step)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(plotLeft - 8, y);
    ctx.lineTo(cssW - 8, y);
    ctx.stroke();
  }
}

function drawClefs(ctx, yOf) {
  ctx.fillStyle = "rgba(230,236,243,0.85)";
  ctx.textBaseline = "alphabetic";
  // Treble clef glyph anchored around the G4 line (step 32).
  ctx.font = "52px serif";
  ctx.fillText("\u{1D11E}", 10, yOf(32) + 28);
  // Bass clef glyph anchored around the F3 line (step 24).
  ctx.font = "44px serif";
  ctx.fillText("\u{1D122}", 12, yOf(24) + 8);
}

function drawLedgerLines(ctx, step, x, yOf, plotLeft) {
  if (x < plotLeft) return;
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 1;
  const drawAt = (s) => {
    const y = Math.round(yOf(s)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x - 9, y);
    ctx.lineTo(x + 9, y);
    ctx.stroke();
  };
  // Above the treble staff (steps > 38, even = lines).
  for (let s = 40; s <= step; s += 2) drawAt(s);
  // Below the bass staff (steps < 18).
  for (let s = 16; s >= step; s -= 2) drawAt(s);
  // The middle-C ledger line (step 28) between the staves.
  if (step === 28 || (step < 30 && step > 26)) drawAt(28);
}

function drawNotehead(ctx, x, y, u, { fill, color, sharp }) {
  const rx = u * 1.15;
  const ry = u * 0.85;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.3);
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.restore();
  if (sharp) {
    ctx.fillStyle = color;
    ctx.font = `${Math.round(u * 2.4)}px serif`;
    ctx.textBaseline = "middle";
    ctx.fillText("♯", x - u * 3.4, y);
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---------- State helpers ----------

function resetState() {
  notes.length = 0;
  lastTiming = [];
  lastTempo = null;
  els.noteName.textContent = "—";
  els.noteOctave.textContent = "";
  els.centsValue.textContent = "— cents";
  els.centsValue.style.color = "";
  els.freqValue.textContent = "— Hz";
  els.bpmValue.textContent = "—";
  els.confidence.textContent = "confidence: —";
  els.centsNeedle.style.left = "50%";
  els.historyBody.innerHTML = '<tr class="empty"><td colspan="5">Nothing yet.</td></tr>';
  latestTime = 0;
  renderOutOfTune();
  renderOutOfTime();
  const ctx = els.score.getContext("2d");
  ctx.clearRect(0, 0, els.score.width, els.score.height);
}

function setRecordingUI(recording) {
  els.micBtn.classList.toggle("recording", recording);
  els.micBtn.lastChild.textContent = recording ? " Stop microphone" : " Start microphone";
}

function setStatus(msg) {
  els.status.textContent = msg;
}

// Redraw the score on resize so it stays crisp.
window.addEventListener("resize", () => {
  if (analyzer.running) return; // live loop already redraws
  renderScore(notes, lastTiming, latestTime, lastTempo);
});

// Initialise strictness labels.
updateStrictness();

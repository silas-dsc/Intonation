// app.js — UI controller: wires controls to the Analyzer and renders live
// readouts, the piano-roll view, worst-offender lists and the note history.

import { Analyzer } from "./analyzer.js";
import { frequencyToNote } from "./pitch.js";
import {
  pitchTolerance,
  rhythmTolerance,
  classify,
  strictnessLabel,
  worseClass,
} from "./tolerance.js";

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
  pianoRoll: $("pianoRoll"),
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
  renderPianoRoll(notes, lastTiming, latestTime, lastTempo);
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
  renderPianoRoll(notes, lastTiming, data.time, data.tempo);
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

// --- Piano-roll rendering ---

const ROLL = {
  height: 320,
  keyboardW: 40,    // left gutter showing the piano keyboard
  windowSec: 8,
  defaultLow: 48,   // C3 — used before any notes are detected
  defaultHigh: 72,  // C5
  minSpan: 18,      // keep at least ~1.5 octaves visible
  pad: 2,           // semitones of headroom above/below the played range
};

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

function isBlackKey(midi) {
  return BLACK_KEYS.has(((midi % 12) + 12) % 12);
}

/** Pick the visible MIDI range from the notes on screen (with padding). */
function pitchRange(noteList) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of noteList) {
    if (n.midi < lo) lo = n.midi;
    if (n.midi > hi) hi = n.midi;
  }
  if (!isFinite(lo)) {
    lo = ROLL.defaultLow;
    hi = ROLL.defaultHigh;
  }
  lo -= ROLL.pad;
  hi += ROLL.pad;
  const span = hi - lo;
  if (span < ROLL.minSpan) {
    const extra = Math.ceil((ROLL.minSpan - span) / 2);
    lo -= extra;
    hi += extra;
  }
  return { lo, hi };
}

function renderPianoRoll(noteList, timing, now, tempo) {
  const canvas = els.pianoRoll;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = ROLL.height;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const plotLeft = ROLL.keyboardW;
  const plotW = cssW - plotLeft - 8;
  const start = Math.max(0, now - ROLL.windowSec);
  const xOf = (t) => plotLeft + ((t - start) / ROLL.windowSec) * plotW;
  const pxPerSec = plotW / ROLL.windowSec;

  const { lo, hi } = pitchRange(noteList);
  const rows = hi - lo + 1;
  const rowH = cssH / rows;
  // Top edge of a MIDI note's lane (higher pitch = higher on screen).
  const laneTop = (midi) => (hi - midi) * rowH;
  const laneMid = (midi) => laneTop(midi) + rowH / 2;

  drawLanes(ctx, lo, hi, rowH, laneTop, plotLeft, cssW);
  drawKeyboard(ctx, lo, hi, rowH, laneTop);

  // Beat grid as light vertical barlines.
  if (tempo && tempo.beatPeriod > 0) {
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    const first = Math.ceil(start / tempo.beatPeriod) * tempo.beatPeriod;
    for (let t = first; t <= now; t += tempo.beatPeriod) {
      const x = xOf(t);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssH);
      ctx.stroke();
    }
  }

  // Clip note drawing to the plot area so bars don't spill over the keyboard.
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, 0, cssW - plotLeft, cssH);
  ctx.clip();

  const barH = Math.max(4, rowH * 0.5);
  for (const n of noteList) {
    if (n.midi < lo || n.midi > hi) continue;
    const timingEntry = timing.length ? timingForNote(n) : null;
    const errorMs = timingEntry ? timingEntry.errorMs : 0;

    const perfectTime = n.startTime - errorMs / 1000; // nearest beat slot
    const dur = Math.max(0.08, n.endTime - n.startTime);
    const w = Math.max(6, dur * pxPerSec);
    if (xOf(n.startTime) + w < plotLeft || perfectTime > now) continue;

    const pitchClass = classify(Math.abs(n.cents), pitchTol);
    const timingClass = timingEntry ? classify(Math.abs(errorMs), rhythmTol) : "good";
    const overall = worseClass(pitchClass, timingClass);

    // Perfect target: hollow bar at the exact lane and quantized beat time.
    const targetX = xOf(perfectTime);
    const targetY = laneMid(n.midi) - barH / 2;
    ctx.strokeStyle = "rgba(200,210,225,0.45)";
    ctx.lineWidth = 1.4;
    roundRect(ctx, targetX, targetY, w, barH, 3);
    ctx.stroke();

    // Actual performance: coloured bar. Horizontal = real onset (early/late);
    // vertical = cents offset within the lane (sharp up, flat down, 1 semitone
    // = one full lane).
    const dy = clamp((-n.cents / 100) * rowH, -rowH, rowH);
    const actualX = xOf(n.startTime);
    const actualY = laneMid(n.midi) + dy - barH / 2;
    ctx.fillStyle = HEX_COLOR[overall];
    roundRect(ctx, actualX, actualY, w, barH, 3);
    ctx.fill();

    // Connector showing the error vector when off target.
    if (overall !== "good") {
      ctx.strokeStyle = HEX_COLOR[overall];
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(targetX, laneMid(n.midi));
      ctx.lineTo(actualX, laneMid(n.midi) + dy);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();

  // "Now" cursor.
  ctx.strokeStyle = "rgba(124,92,255,0.7)";
  ctx.lineWidth = 2;
  const nx = xOf(now);
  ctx.beginPath();
  ctx.moveTo(nx, 0);
  ctx.lineTo(nx, cssH);
  ctx.stroke();
}

function drawLanes(ctx, lo, hi, rowH, laneTop, plotLeft, cssW) {
  for (let midi = lo; midi <= hi; midi++) {
    const y = laneTop(midi);
    // Slightly darken black-key lanes for a familiar piano-roll look.
    ctx.fillStyle = isBlackKey(midi) ? "rgba(0,0,0,0.22)" : "rgba(255,255,255,0.015)";
    ctx.fillRect(plotLeft, y, cssW - plotLeft - 8, rowH);
    // A faint line at each octave boundary (below C).
    if (midi % 12 === 0) {
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      const ly = Math.round(y + rowH) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plotLeft, ly);
      ctx.lineTo(cssW - 8, ly);
      ctx.stroke();
    }
  }
}

function drawKeyboard(ctx, lo, hi, rowH, laneTop) {
  for (let midi = lo; midi <= hi; midi++) {
    const y = laneTop(midi);
    const black = isBlackKey(midi);
    ctx.fillStyle = black ? "#202632" : "#cdd5e0";
    ctx.fillRect(0, y, ROLL.keyboardW - 2, rowH);
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(0, y + 0.5, ROLL.keyboardW - 2, rowH);
    // Label each C with its octave.
    if (midi % 12 === 0 && rowH >= 8) {
      ctx.fillStyle = "#0f1115";
      ctx.font = `${Math.min(10, rowH - 2)}px sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillText(`C${midi / 12 - 1}`, 3, y + rowH / 2);
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
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
  const ctx = els.pianoRoll.getContext("2d");
  ctx.clearRect(0, 0, els.pianoRoll.width, els.pianoRoll.height);
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
  renderPianoRoll(notes, lastTiming, latestTime, lastTempo);
});

// Initialise strictness labels.
updateStrictness();

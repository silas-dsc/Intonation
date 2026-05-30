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
  tapBtn: $("tapBtn"),
  clearTempoBtn: $("clearTempoBtn"),
  bpmMin: $("bpmMin"),
  bpmMax: $("bpmMax"),
  rollScroll: $("rollScroll"),
  rollScrollHint: $("rollScrollHint"),
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

// Playback/scroll state. When `isLive` the roll follows "now"; when paused
// (mic stopped / file ended) the user scrolls and `viewStart` drives the window.
let isLive = false;
let viewStart = 0;
let tapTimes = [];       // recent tap-tempo timestamps (seconds)

// Accuracy thresholds, driven by the strictness sliders.
let pitchTol = pitchTolerance(50);
let rhythmTol = rhythmTolerance(50);

const analyzer = new Analyzer({
  a4,
  onFrame: handleFrame,
  onNote: handleNote,
  onOnset: handleOnset,
  onStop: handleStop,
});

// ---------- Controls ----------

els.micBtn.addEventListener("click", async () => {
  if (analyzer.running && analyzer.stream) {
    analyzer.stop(); // fires handleStop, which updates the UI
    return;
  }
  try {
    setStatus("Requesting microphone…");
    await analyzer.startMic();
    setLive(true);
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
    setLive(true);
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
  redrawRoll();
}

// --- Tempo controls: tap tempo + detection bounds ---

els.tapBtn.addEventListener("click", registerTap);
els.clearTempoBtn.addEventListener("click", clearManualTempo);

// Press Enter anywhere (except while typing in a field) to tap the tempo.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  // Let focused form fields / buttons handle Enter themselves (a focused
  // button's Enter already triggers its click, e.g. the Tap button).
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
  e.preventDefault();
  registerTap();
});

function registerTap() {
  const now = performance.now() / 1000;
  // Restart the tap sequence if the gap was too long to be the same tempo.
  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2) tapTimes = [];
  tapTimes.push(now);
  if (tapTimes.length > 6) tapTimes.shift();

  if (tapTimes.length >= 2) {
    let sum = 0;
    for (let i = 1; i < tapTimes.length; i++) sum += tapTimes[i] - tapTimes[i - 1];
    const avg = sum / (tapTimes.length - 1);
    let bpm = 60 / avg;
    const lo = +els.bpmMin.value;
    const hi = +els.bpmMax.value;
    while (bpm < lo) bpm *= 2;
    while (bpm > hi) bpm /= 2;
    bpm = Math.round(bpm);
    analyzer.setManualBpm(bpm);
    lastTempo = { bpm, beatPeriod: 60 / bpm, confidence: 1, source: "tapped" };
    els.bpmValue.textContent = bpm;
    els.confidence.textContent = "tapped";
    els.clearTempoBtn.hidden = false;
    if (!isLive) refreshPaused();
  } else {
    setStatus("Tap again to set the tempo…");
  }
}

function clearManualTempo() {
  analyzer.setManualBpm(null);
  tapTimes = [];
  els.clearTempoBtn.hidden = true;
  els.confidence.textContent = "confidence: —";
  if (!isLive) refreshPaused();
}

els.bpmMin.addEventListener("change", updateTempoBounds);
els.bpmMax.addEventListener("change", updateTempoBounds);

function updateTempoBounds() {
  let lo = Math.round(+els.bpmMin.value);
  let hi = Math.round(+els.bpmMax.value);
  lo = Math.max(20, Math.min(290, lo));
  hi = Math.max(lo + 10, Math.min(300, hi));
  els.bpmMin.value = lo;
  els.bpmMax.value = hi;
  analyzer.setTempoBounds(lo, hi);
  if (!isLive) refreshPaused();
}

// --- Piano-roll scrolling (enabled when paused) ---

els.rollScroll.addEventListener("input", () => {
  if (isLive) return;
  viewStart = +els.rollScroll.value;
  redrawRoll();
  syncHistoryToView();
});

// Mouse-wheel and drag panning over the canvas when paused.
els.pianoRoll.addEventListener("wheel", (e) => {
  if (isLive) return;
  e.preventDefault();
  const delta = (e.deltaX || e.deltaY) / 200;
  setViewStart(viewStart + delta * (ROLL.windowSec / 4));
}, { passive: false });

let dragging = false;
let dragX = 0;
els.pianoRoll.addEventListener("pointerdown", (e) => {
  if (isLive) return;
  dragging = true;
  dragX = e.clientX;
  els.pianoRoll.setPointerCapture(e.pointerId);
});
els.pianoRoll.addEventListener("pointermove", (e) => {
  if (!dragging || isLive) return;
  const dx = e.clientX - dragX;
  dragX = e.clientX;
  const secPerPx = ROLL.windowSec / (els.pianoRoll.clientWidth - ROLL.keyboardW);
  setViewStart(viewStart - dx * secPerPx); // drag right => go back in time
});
els.pianoRoll.addEventListener("pointerup", () => { dragging = false; });

function setViewStart(v) {
  viewStart = Math.max(0, Math.min(maxViewStart(), v));
  els.rollScroll.value = viewStart;
  redrawRoll();
  syncHistoryToView();
}

function maxViewStart() {
  return Math.max(0, latestTime - ROLL.windowSec);
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
    els.confidence.textContent =
      data.tempo.source === "tapped"
        ? "tapped"
        : `confidence: ${(data.tempo.confidence * 100).toFixed(0)}%`;
  }

  // Refresh timing analysis periodically and redraw the roll.
  const res = analyzer.analyzeTimingNow();
  if (res.timing.length) lastTiming = res.timing;
  redrawRoll();
  renderOutOfTime();
}

function handleStop() {
  setLive(false);
  setRecordingUI(false);
  if (notes.length) {
    setStatus(
      latestTime > ROLL.windowSec
        ? "Stopped. Scroll or drag the roll to review earlier notes."
        : "Stopped."
    );
  }
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

// --- View / scroll helpers ---

/** Switch between live-follow and paused-scroll modes. */
function setLive(live) {
  isLive = live;
  if (live) {
    els.rollScroll.disabled = true;
    els.rollScrollHint.textContent = "Stop the mic to scroll back through the performance.";
    clearHistoryHighlight();
  } else {
    // Park the view on the most recent window and enable scrolling.
    viewStart = maxViewStart();
    els.rollScroll.max = maxViewStart();
    els.rollScroll.value = viewStart;
    els.rollScroll.disabled = latestTime <= ROLL.windowSec;
    els.rollScrollHint.textContent =
      latestTime > ROLL.windowSec ? "Scroll or drag to review earlier notes." : "Performance fits one screen.";
    redrawRoll();
    syncHistoryToView();
  }
}

/** Window start currently shown: follows "now" when live, else the scroll pos. */
function currentWinStart() {
  return isLive ? Math.max(0, latestTime - ROLL.windowSec) : viewStart;
}

function redrawRoll() {
  renderPianoRoll(notes, lastTiming, currentWinStart(), lastTempo);
}

/** Recompute analysis and redraw while paused (after a tempo/strictness change). */
function refreshPaused() {
  const res = analyzer.analyzeTimingNow();
  if (res.timing.length) lastTiming = res.timing;
  renderHistory();
  renderOutOfTune();
  renderOutOfTime();
  redrawRoll();
  syncHistoryToView();
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
  if (!notes.length) {
    els.historyBody.innerHTML = '<tr class="empty"><td colspan="5">Nothing yet.</td></tr>';
    return;
  }
  // Render the full history, newest first.
  const rows = [];
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    const timing = timingForNote(n);
    const centsCls = classify(Math.abs(n.cents), pitchTol);
    const tCell = timing
      ? `<span class="metric ${classify(Math.abs(timing.errorMs), rhythmTol)}">${
          timing.errorMs > 0 ? "+" : ""
        }${timing.errorMs.toFixed(0)} ms</span>`
      : "—";
    rows.push(`<tr data-idx="${i}" data-start="${n.startTime.toFixed(3)}">
        <td>${i + 1}</td>
        <td>${n.name}${n.octave}</td>
        <td>${n.idealFreq.toFixed(1)} Hz</td>
        <td><span class="metric ${centsCls}">${n.cents > 0 ? "+" : ""}${n.cents}¢</span></td>
        <td>${tCell}</td>
      </tr>`);
  }
  els.historyBody.innerHTML = rows.join("");
  if (!isLive) syncHistoryToView();
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
      return `<li class="clickable" data-idx="${notes.indexOf(n)}" title="Jump to this note in the history">
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
      const idx = nearestNoteIndex(t.time);
      const click = idx >= 0 ? `class="clickable" data-idx="${idx}" title="Jump to this note in the history"` : "";
      return `<li ${click}>
        <span class="label">onset @ ${t.time.toFixed(2)}s</span>
        <span class="metric ${cls}">${Math.abs(t.errorMs).toFixed(0)} ms ${dir}</span>
      </li>`;
    })
    .join("");
}

els.outOfTune.addEventListener("click", offenderClick);
els.outOfTime.addEventListener("click", offenderClick);

function offenderClick(e) {
  const li = e.target.closest("li[data-idx]");
  if (!li) return;
  const idx = +li.dataset.idx;
  if (idx >= 0) jumpToNote(idx);
}

/** Index of the completed note whose start is closest to a given time. */
function nearestNoteIndex(time) {
  let best = -1;
  let bestDist = 0.35; // only link if a note is reasonably close
  for (let i = 0; i < notes.length; i++) {
    const d = Math.abs(notes[i].startTime - time);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

// --- History sync / navigation ---

function syncHistoryToView() {
  if (isLive) { clearHistoryHighlight(); return; }
  const start = currentWinStart();
  const end = start + ROLL.windowSec;
  const rows = els.historyBody.querySelectorAll("tr[data-start]");
  let firstInView = null;
  rows.forEach((row) => {
    const t = parseFloat(row.dataset.start);
    const inView = t >= start && t <= end;
    row.classList.toggle("in-view", inView);
    if (inView && !firstInView) firstInView = row;
  });
  if (firstInView) firstInView.scrollIntoView({ block: "nearest" });
}

function clearHistoryHighlight() {
  els.historyBody.querySelectorAll("tr.in-view").forEach((r) => r.classList.remove("in-view"));
}

function scrollToHistory(idx) {
  const row = els.historyBody.querySelector(`tr[data-idx="${idx}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1200);
}

/** Jump to a note: highlight it in the history and (when paused) centre the roll. */
function jumpToNote(idx) {
  const n = notes[idx];
  if (!n) return;
  if (!isLive) setViewStart(n.startTime - ROLL.windowSec / 2);
  scrollToHistory(idx);
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

function renderPianoRoll(noteList, timing, winStart, tempo) {
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
  const start = Math.max(0, winStart);
  const end = start + ROLL.windowSec;
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
    for (let t = first; t <= end; t += tempo.beatPeriod) {
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
    if (n.startTime + dur < start || perfectTime > end) continue;

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

  // Playhead cursor at the latest analyzed time, when it's within view.
  if (latestTime >= start && latestTime <= end) {
    ctx.strokeStyle = "rgba(124,92,255,0.7)";
    ctx.lineWidth = 2;
    const nx = xOf(latestTime);
    ctx.beginPath();
    ctx.moveTo(nx, 0);
    ctx.lineTo(nx, cssH);
    ctx.stroke();
  }
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
  viewStart = 0;
  isLive = false;
  els.rollScroll.max = 0;
  els.rollScroll.value = 0;
  els.rollScroll.disabled = true;
  els.rollScrollHint.textContent = "Stop the mic to scroll back through the performance.";
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

// Redraw the roll on resize so it stays crisp.
window.addEventListener("resize", () => {
  if (analyzer.running) return; // live loop already redraws
  redrawRoll();
});

// Initialise strictness labels, tempo bounds, and an empty roll.
updateStrictness();
updateTempoBounds();

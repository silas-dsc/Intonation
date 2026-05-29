// app.js — UI controller: wires controls to the Analyzer and renders live
// readouts, the rhythm timeline, worst-offender lists and the note history.

import { Analyzer } from "./analyzer.js";
import { frequencyToNote } from "./pitch.js";

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
  timeline: $("timeline"),
  outOfTune: $("outOfTune"),
  outOfTime: $("outOfTime"),
  historyBody: document.querySelector("#historyTable tbody"),
};

let a4 = 440;
const notes = [];        // completed notes with tuning info
let lastTiming = [];     // per-onset timing analysis
let lastTempo = null;

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

// ---------- Event handlers ----------

function handleFrame(data) {
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

  // Refresh timing analysis periodically and redraw the timeline.
  const res = analyzer.analyzeTimingNow();
  if (res.timing.length) lastTiming = res.timing;
  drawTimeline(data.onsets, lastTiming, data.time, data.tempo);
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

function updateCentsNeedle(cents) {
  const clamped = Math.max(-50, Math.min(50, cents));
  const pct = ((clamped + 50) / 100) * 100;
  els.centsNeedle.style.left = `${pct}%`;
  const abs = Math.abs(cents);
  const color = abs <= 5 ? "var(--good)" : abs <= 20 ? "var(--warn)" : "var(--bad)";
  els.centsNeedle.style.background = color;
  els.centsValue.style.color = color;
}

function classFor(absValue, goodMax, warnMax) {
  if (absValue <= goodMax) return "good";
  if (absValue <= warnMax) return "warn";
  return "bad";
}

function renderHistory() {
  if (!notes.length) return;
  const rows = notes
    .slice(-60)
    .reverse()
    .map((n, i) => {
      const idx = notes.length - i;
      const timing = lastTiming.find(
        (t) => t.time >= n.startTime - 0.05 && t.time <= n.endTime + 0.05
      );
      const centsCls = classFor(Math.abs(n.cents), 5, 20);
      const tCell = timing
        ? `<span class="metric ${classFor(Math.abs(timing.errorMs), 30, 80)}">${
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
      const cls = classFor(Math.abs(n.cents), 5, 20);
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
      const cls = classFor(Math.abs(t.errorMs), 30, 80);
      const dir = t.errorMs > 0 ? "late" : "early";
      return `<li>
        <span class="label">onset @ ${t.time.toFixed(2)}s</span>
        <span class="metric ${cls}">${Math.abs(t.errorMs).toFixed(0)} ms ${dir}</span>
      </li>`;
    })
    .join("");
}

function drawTimeline(onsets, timing, now, tempo) {
  const canvas = els.timeline;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = 120;
  if (canvas.width !== cssW * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const windowSec = 8;
  const start = Math.max(0, now - windowSec);
  const xOf = (t) => ((t - start) / windowSec) * cssW;

  // Beat grid.
  if (tempo && tempo.beatPeriod > 0) {
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
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

  // Center baseline.
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath();
  ctx.moveTo(0, cssH / 2);
  ctx.lineTo(cssW, cssH / 2);
  ctx.stroke();

  // Onset marks, colored by timing error.
  const timingMap = new Map(timing.map((t) => [t.time, t.errorMs]));
  for (const t of onsets) {
    if (t < start) continue;
    const x = xOf(t);
    const err = timingMap.get(t);
    let color = "#4cc2ff";
    let yOffset = 0;
    if (err !== undefined) {
      const abs = Math.abs(err);
      color = abs <= 30 ? "#3ddc97" : abs <= 80 ? "#ffcc4d" : "#ff6b6b";
      // Nudge marker up (early) or down (late) proportionally.
      yOffset = Math.max(-40, Math.min(40, -err / 4));
    }
    ctx.fillStyle = color;
    ctx.fillRect(x - 2, 10 + (cssH / 2 - 10) + yOffset - 30, 4, 60);
    ctx.beginPath();
    ctx.arc(x, cssH / 2 + yOffset, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // "Now" cursor.
  ctx.strokeStyle = "rgba(124,92,255,0.7)";
  ctx.lineWidth = 2;
  const nx = xOf(now);
  ctx.beginPath();
  ctx.moveTo(nx, 0);
  ctx.lineTo(nx, cssH);
  ctx.stroke();
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
  renderOutOfTune();
  renderOutOfTime();
  const ctx = els.timeline.getContext("2d");
  ctx.clearRect(0, 0, els.timeline.width, els.timeline.height);
}

function setRecordingUI(recording) {
  els.micBtn.classList.toggle("recording", recording);
  els.micBtn.lastChild.textContent = recording ? " Stop microphone" : " Start microphone";
}

function setStatus(msg) {
  els.status.textContent = msg;
}

// Redraw the timeline on resize so it stays crisp.
window.addEventListener("resize", () => {
  if (analyzer.running) return; // live loop already redraws
  drawTimeline(analyzer.onsetDetector.getOnsets(), lastTiming, 0, lastTempo);
});

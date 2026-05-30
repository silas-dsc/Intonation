# Intonation

A mobile-friendly web app that analyzes audio **in real time** to measure
**pitch**, **tempo (BPM)** and **rhythm**, and shows how far each note strays
from perfect pitch and perfect time.

Everything runs locally in the browser using the Web Audio API — no audio ever
leaves your device, and there are no runtime dependencies.

## Features

- 🎤 **Live microphone analysis** — start listening with one tap.
- 📁 **Audio file upload** — drop in any file your browser can decode (`.wav`,
  `.mp3`, `.m4a`, `.ogg`, …) and it plays back while being analyzed.
- 🎵 **Live pitch readout** — current note, octave, frequency, and a tuning
  meter showing the deviation in **cents** (color-coded: green ≤5¢, yellow ≤20¢,
  red beyond).
- 🥁 **Live tempo** — estimated BPM with a confidence indicator and a beat
  pulse. The estimate is **smoothed for inertia** so it locks on and stays
  steady instead of jumping between octaves. You can **tap the tempo** (button or
  the **Enter** key) to set it manually, and constrain auto-detection with
  **min/max BPM** bounds (which also disambiguate half/double-tempo).
- 🎹 **Colourful piano roll** — a scrolling pitch-vs-time view with a piano
  keyboard gutter. Every note is drawn twice: a **hollow target** bar at its
  perfect pitch lane and beat position, and a **coloured overlay** bar showing
  what you actually played, offset **left/right** for early/late and **up/down**
  within the lane for sharp/flat (one semitone = one lane). Colour encodes
  accuracy: green = accurate, yellow = close, red = way off.
- 🎚️ **Strictness controls** — independent pitch and rhythm sliders set how much
  leeway counts as "accurate". They drive the score colours, the worst-offender
  lists, the history table and the tuning meter.
- ⏪ **Scrollback & playback** — when the mic is stopped (or a file finishes),
  the take is captured for **playback synced to the piano roll**: press play and
  the roll scrolls with the audio while the note-history table highlights and
  follows the visible window. Scrub anywhere with the transport slider, or
  scroll/drag the roll directly.
- 🥁 **Click track** — toggle a metronome locked to the detected/tapped beat grid
  (accented downbeats) during playback.
- 🐢 **Variable speed** — play back from **0.3× to 2×** in 0.1 steps; the click
  track and roll stay in sync.
- 🏆 **Worst offenders** — the top 3 most *out of tune* notes and top 3 most
  *out of time* onsets. **Click any one to jump** to that note in the history
  (and centre it in the roll when paused).
- 📜 **Note history** — a table of **every** detected note (full session) with
  its tuning (cents) and timing (ms) error.
- 🎵 **Adjustable reference** — set the A4 tuning reference (default 440 Hz).

## Running it

A secure context is required for microphone access. `localhost` qualifies, so a
plain local server is enough — no HTTPS setup needed.

```bash
npm start        # serves at http://localhost:5173
```

Then open <http://localhost:5173> and click **Start microphone** (grant the
permission prompt) or **Upload audio file**.

> On a phone, serve it over HTTPS or `localhost` (e.g. via a tunnel) — browsers
> block `getUserMedia` on insecure origins.

## Tests

The DSP and music-theory math is pure and unit-tested in Node (no browser):

```bash
npm test
```

This validates note identification, cents deviation, autocorrelation pitch
detection, tempo estimation and timing-error analysis.

## How it works

| Concern | Technique | File |
| --- | --- | --- |
| Pitch | Time-domain **autocorrelation** with parabolic peak interpolation, then nearest equal-temperament note + cents deviation | `js/pitch.js` |
| Note segmentation | Stable-frame **note tracker** that groups consecutive in-pitch frames into discrete notes | `js/pitch.js` |
| Onsets | **Spectral flux** (sum of positive bin-to-bin magnitude increases) with adaptive peak-picking and a refractory period | `js/rhythm.js` |
| Tempo (BPM) | **Autocorrelation of the onset-strength envelope** over a configurable BPM range, then **exponential smoothing with octave-folding** (`smoothBpm`) for inertia; overridable by tap tempo | `js/rhythm.js` |
| Timing | Fits a beat grid (best phase offset, eighth-note resolution) and reports each onset's error in ms | `js/rhythm.js` |
| Strictness → colours | Maps each slider (0–100) to cents/ms thresholds for the green/yellow/red buckets | `js/tolerance.js` |
| Recording | Mic captured via `MediaRecorder` then decoded to an `AudioBuffer`; uploaded files are decoded directly | `js/analyzer.js` |
| Playback | `AudioBufferSourceNode` with `playbackRate` for variable speed, a continuous media-time `position()` for roll sync, and a look-ahead metronome scheduler on the beat grid | `js/playback.js` |
| Audio graph & loop | `AnalyserNode` polled per animation frame; mic input is not routed to the speakers (no feedback), file input is | `js/analyzer.js` |
| UI & rendering | Live readouts, piano-roll view, transport, offender lists, history table | `js/app.js` |

## Notes & limitations

- Pitch detection is monophonic — it tracks a single dominant pitch, not chords.
- Tempo and timing estimates improve after a few seconds of steady playing and
  need a reasonably percussive/articulated signal to find onsets.
- Onset timing resolution is bounded by the animation-frame rate (~16 ms).

## License

MIT

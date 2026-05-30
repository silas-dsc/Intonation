// rhythm.js — onset detection, tempo (BPM) estimation and timing analysis.

/**
 * Detects note onsets from a running stream of magnitude spectra using spectral
 * flux (the sum of positive frame-to-frame magnitude increases), with adaptive
 * peak-picking. Each accepted onset is timestamped against the audio clock.
 */
export class OnsetDetector {
  constructor({ historySeconds = 30 } = {}) {
    this.prevSpectrum = null;
    this.flux = [];        // { t, value } samples of the onset-strength envelope
    this.onsets = [];      // timestamps (seconds) of detected onsets
    this.historySeconds = historySeconds;
    this.lastOnsetTime = -Infinity;
    this.minInterval = 0.07; // refractory period: ignore onsets <70ms apart
  }

  reset() {
    this.prevSpectrum = null;
    this.flux = [];
    this.onsets = [];
    this.lastOnsetTime = -Infinity;
  }

  /**
   * Feed one magnitude spectrum frame (Uint8Array or Float32Array) at time `t`.
   * Returns true if a new onset was detected on this frame.
   */
  process(spectrum, t) {
    let fluxVal = 0;
    if (this.prevSpectrum) {
      for (let i = 0; i < spectrum.length; i++) {
        const diff = spectrum[i] - this.prevSpectrum[i];
        if (diff > 0) fluxVal += diff;
      }
    }
    // Store a copy because the AnalyserNode reuses its buffer.
    this.prevSpectrum = spectrum.slice();
    this.flux.push({ t, value: fluxVal });

    // Drop history outside the window.
    const cutoff = t - this.historySeconds;
    while (this.flux.length && this.flux[0].t < cutoff) this.flux.shift();
    while (this.onsets.length && this.onsets[0] < cutoff) this.onsets.shift();

    return this._peakPick(t);
  }

  _peakPick(t) {
    const w = this.flux.length;
    if (w < 5) return false;

    // Adaptive threshold: local mean over a short window plus a margin.
    const win = Math.min(43, w); // ~0.7s at 60fps
    let sum = 0;
    for (let i = w - win; i < w; i++) sum += this.flux[i].value;
    const mean = sum / win;

    // Evaluate the frame just behind the newest one so it can be a local max.
    const idx = w - 2;
    if (idx < 1) return false;
    const cur = this.flux[idx];
    const prev = this.flux[idx - 1].value;
    const next = this.flux[idx + 1].value;
    const threshold = mean * 1.5 + 1e-6;

    if (
      cur.value > threshold &&
      cur.value >= prev &&
      cur.value > next &&
      cur.t - this.lastOnsetTime >= this.minInterval
    ) {
      this.lastOnsetTime = cur.t;
      this.onsets.push(cur.t);
      return true;
    }
    return false;
  }

  getOnsets() { return this.onsets; }
}

/**
 * Estimates tempo by autocorrelating the onset-strength envelope and searching
 * for the lag (within a musical range) that maximizes periodic energy.
 *
 * Returns { bpm, confidence, beatPeriod } or null if not enough data.
 */
export function estimateTempo(flux, { minBpm = 50, maxBpm = 210 } = {}) {
  if (flux.length < 60) return null;

  // Resample the (roughly uniform) flux envelope onto a fixed grid.
  const t0 = flux[0].t;
  const t1 = flux[flux.length - 1].t;
  const duration = t1 - t0;
  if (duration < 2) return null;

  const fps = 100; // analysis resolution for tempo (Hz)
  const N = Math.floor(duration * fps);
  if (N < 100) return null;
  const env = new Float32Array(N);
  let fi = 0;
  for (let i = 0; i < N; i++) {
    const t = t0 + i / fps;
    while (fi < flux.length - 1 && flux[fi + 1].t < t) fi++;
    env[i] = flux[fi].value;
  }

  // Mean-remove so silent stretches don't bias the autocorrelation.
  let mean = 0;
  for (let i = 0; i < N; i++) mean += env[i];
  mean /= N;
  for (let i = 0; i < N; i++) env[i] = Math.max(0, env[i] - mean);

  const minLag = Math.floor((60 / maxBpm) * fps);
  const maxLag = Math.ceil((60 / minBpm) * fps);

  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < N; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < N; i++) sum += env[i] * env[i + lag];
    // Normalize by overlap length so longer lags aren't penalized.
    const score = sum / (N - lag);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (bestLag <= 0) return null;

  // Energy at zero lag for a confidence ratio.
  let zero = 0;
  for (let i = 0; i < N; i++) zero += env[i] * env[i];
  zero /= N;
  const confidence = zero > 0 ? Math.min(1, bestScore / zero) : 0;

  let bpm = 60 / (bestLag / fps);
  // Keep within the requested bounds (fold octave errors back into range).
  while (bpm < minBpm) bpm *= 2;
  while (bpm > maxBpm) bpm /= 2;

  return { bpm: Math.round(bpm), confidence, beatPeriod: 60 / bpm };
}

/**
 * Smooths a BPM estimate toward a previous value for inertia, folding octave
 * errors (half/double) toward the previous reading so the displayed tempo stays
 * stable instead of flickering between octaves or jittering frame to frame.
 *
 * `alpha` is the blend factor (0 = frozen, 1 = no smoothing); lower = more
 * inertia.
 */
export function smoothBpm(prevBpm, rawBpm, alpha = 0.06) {
  if (!prevBpm) return rawBpm;
  if (!rawBpm) return prevBpm;
  let r = rawBpm;
  // Fold the raw estimate toward the previous tempo's octave.
  while (r < prevBpm / 1.4) r *= 2;
  while (r > prevBpm * 1.4) r /= 2;
  return prevBpm + alpha * (r - prevBpm);
}

/**
 * Given onset times and an estimated beat period, fit a beat grid (by choosing
 * the phase offset that best aligns the onsets) and compute each onset's timing
 * error in milliseconds relative to the nearest grid subdivision.
 *
 * Subdivisions allow eighth-note resolution so off-beat notes aren't all flagged.
 */
export function analyzeTiming(onsets, beatPeriod, { subdivisions = 2 } = {}) {
  if (!onsets.length || !beatPeriod || beatPeriod <= 0) return [];

  const grid = beatPeriod / subdivisions;

  // Search phase offsets across one grid cell for the best alignment.
  let bestPhase = 0;
  let bestError = Infinity;
  const steps = 50;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * grid;
    let err = 0;
    for (const t of onsets) {
      const rel = t - phase;
      const nearest = Math.round(rel / grid) * grid + phase;
      err += Math.abs(t - nearest);
    }
    if (err < bestError) { bestError = err; bestPhase = phase; }
  }

  return onsets.map((t) => {
    const rel = t - bestPhase;
    const nearest = Math.round(rel / grid) * grid + bestPhase;
    const errorMs = (t - nearest) * 1000; // + = late, - = early
    return { time: t, errorMs, grid };
  });
}

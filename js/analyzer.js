// analyzer.js — wires up the Web Audio graph and runs the per-frame analysis
// loop, emitting live pitch / tempo / onset events to the UI layer.

import { detectPitch, NoteTracker } from "./pitch.js";
import { OnsetDetector, estimateTempo, analyzeTiming, smoothBpm } from "./rhythm.js";

const FFT_SIZE = 2048;

export class Analyzer {
  constructor({ a4 = 440, onFrame, onNote, onOnset, onStop } = {}) {
    this.a4 = a4;
    this.onFrame = onFrame;   // (frameData) => void  — every animation frame
    this.onNote = onNote;     // (note) => void       — when a note completes
    this.onOnset = onOnset;   // (time) => void       — when an onset is detected
    this.onStop = onStop;     // () => void           — when analysis stops

    // Tempo state: smoothed auto-detected BPM, optional manual (tapped) BPM,
    // and the detection bounds.
    this.minBpm = 50;
    this.maxBpm = 210;
    this.manualBpm = null;
    this.smoothedBpm = 0;
    this.tempoConfidence = 0;

    this.audioCtx = null;
    this.analyser = null;
    this.source = null;
    this.stream = null;
    this.running = false;
    this.rafId = null;

    this.timeBuf = new Float32Array(FFT_SIZE);
    this.freqBuf = null;

    this.noteTracker = new NoteTracker({ a4 });
    this.onsetDetector = new OnsetDetector();
    this.startClock = 0;
  }

  setReference(a4) {
    this.a4 = a4;
    this.noteTracker.setReference(a4);
  }

  /** Constrain auto tempo detection to a BPM range. */
  setTempoBounds(minBpm, maxBpm) {
    this.minBpm = minBpm;
    this.maxBpm = maxBpm;
  }

  /** Override the tempo with a tapped BPM, or pass null to resume auto-detect. */
  setManualBpm(bpm) {
    this.manualBpm = bpm && bpm > 0 ? bpm : null;
  }

  /** The tempo currently in effect (manual override wins over smoothed auto). */
  _effectiveTempo() {
    const bpm = this.manualBpm || (this.smoothedBpm ? Math.round(this.smoothedBpm) : 0);
    if (!bpm) return null;
    return {
      bpm: Math.round(bpm),
      beatPeriod: 60 / bpm,
      confidence: this.manualBpm ? 1 : this.tempoConfidence,
      source: this.manualBpm ? "tapped" : "auto",
    };
  }

  _ensureContext() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0; // we do our own smoothing
      this.freqBuf = new Uint8Array(this.analyser.frequencyBinCount);
    }
  }

  /** Start analyzing the live microphone input. */
  async startMic() {
    this._ensureContext();
    await this.audioCtx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this._disconnectSource();
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);
    // Live input is NOT routed to the speakers to avoid feedback.
    this._begin();
  }

  /** Decode and analyze an uploaded audio file, playing it back as it goes. */
  async startFile(file) {
    this._ensureContext();
    await this.audioCtx.resume();
    const arrayBuf = await file.arrayBuffer();
    const audioBuf = await this.audioCtx.decodeAudioData(arrayBuf);

    this._disconnectSource();
    const src = this.audioCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(this.analyser);
    this.analyser.connect(this.audioCtx.destination); // play file aloud
    this.source = src;
    src.onended = () => {
      if (this.source === src) this.stop();
    };
    this._begin();
    src.start();
  }

  _begin() {
    this.noteTracker = new NoteTracker({ a4: this.a4 });
    this.onsetDetector.reset();
    this.smoothedBpm = 0;
    this.tempoConfidence = 0;
    this.startClock = this.audioCtx.currentTime;
    this.running = true;
    this._loop();
  }

  _loop() {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(() => this._loop());

    const now = this.audioCtx.currentTime - this.startClock;

    // --- Pitch ---
    this.analyser.getFloatTimeDomainData(this.timeBuf);
    const freq = detectPitch(this.timeBuf, this.audioCtx.sampleRate);

    // --- Onsets (spectral flux) ---
    this.analyser.getByteFrequencyData(this.freqBuf);
    const isOnset = this.onsetDetector.process(this.freqBuf, now);
    if (isOnset && this.onOnset) this.onOnset(now);

    // --- Note segmentation ---
    const finishedNote = this.noteTracker.update(freq, now);
    if (finishedNote && this.onNote) this.onNote(finishedNote);

    // --- Tempo (smoothed for inertia) ---
    const raw = estimateTempo(this.onsetDetector.flux, {
      minBpm: this.minBpm,
      maxBpm: this.maxBpm,
    });
    if (raw) {
      this.smoothedBpm = smoothBpm(this.smoothedBpm, raw.bpm);
      this.tempoConfidence = raw.confidence;
    }
    const tempo = this._effectiveTempo();

    if (this.onFrame) {
      this.onFrame({
        time: now,
        freq,
        tempo,
        onsets: this.onsetDetector.getOnsets(),
        isOnset,
      });
    }
  }

  /**
   * Run timing analysis over all detected onsets for the current tempo.
   * Returns the per-onset timing array (see rhythm.analyzeTiming).
   */
  analyzeTimingNow() {
    const tempo = this._effectiveTempo();
    if (!tempo) return { timing: [], tempo: null };
    const timing = analyzeTiming(this.onsetDetector.getOnsets(), tempo.beatPeriod);
    return { timing, tempo };
  }

  _disconnectSource() {
    if (this.source) {
      try { this.source.disconnect(); } catch (_) {}
      this.source = null;
    }
    try { this.analyser.disconnect(); } catch (_) {}
  }

  stop() {
    const wasRunning = this.running;
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this._disconnectSource();
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (wasRunning && this.onStop) this.onStop();
  }

  reset() {
    this.stop();
    this.noteTracker = new NoteTracker({ a4: this.a4 });
    this.onsetDetector.reset();
  }
}

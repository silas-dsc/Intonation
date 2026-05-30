// playback.js — plays back a recorded/loaded AudioBuffer with variable speed and
// an optional metronome click locked to the beat grid. Exposes a media-time
// position so the UI can scroll the piano roll in sync.

export class Playback {
  constructor(audioCtx) {
    this.ctx = audioCtx;
    this.buffer = null;
    this.source = null;
    this.gain = null;

    this.running = false;
    this.rate = 1;
    this.clickOn = false;

    this.period = 0;   // beat period (s); 0 = no click
    this.phase = 0;    // beat grid phase (s)

    this.startClock = 0;   // ctx time when the current segment started
    this.startOffset = 0;  // media time at that moment
    this.nextBeat = 0;     // media time of the next scheduled click
    this.schedId = null;

    this.onEnded = null;   // () => void, fired when playback finishes/stops
  }

  setBuffer(buffer) {
    this.buffer = buffer;
    this.startOffset = 0;
  }

  setBeat(period, phase) {
    this.period = period || 0;
    this.phase = phase || 0;
    if (this.running) this._resetClickPointer();
  }

  setClick(on) {
    this.clickOn = on;
    if (this.running && on) this._resetClickPointer();
  }

  setRate(rate) {
    if (this.running) {
      // Rebase so position() stays continuous across the rate change.
      this.startOffset = this.position();
      this.startClock = this.ctx.currentTime;
      this.rate = rate;
      if (this.source) this.source.playbackRate.value = rate;
      this._resetClickPointer();
    } else {
      this.rate = rate;
    }
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  /** Current media-time position in seconds. */
  position() {
    if (!this.running) return this.startOffset;
    const p = this.startOffset + (this.ctx.currentTime - this.startClock) * this.rate;
    return Math.min(p, this.duration);
  }

  play(from = 0) {
    if (!this.buffer) return;
    this._teardown();
    this.startOffset = Math.max(0, Math.min(from, this.duration));

    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.playbackRate.value = this.rate;
    this.gain = this.ctx.createGain();
    this.source.connect(this.gain).connect(this.ctx.destination);

    this.startClock = this.ctx.currentTime;
    this.source.onended = () => {
      // Only treat as finished if we actually reached the end (not a manual stop).
      if (this.running && this.position() >= this.duration - 0.06) this._finish();
    };
    this.source.start(0, this.startOffset);
    this.running = true;
    this._resetClickPointer();
    this._scheduleLoop();
  }

  /** Pause and remember the position. */
  pause() {
    if (!this.running) return;
    const pos = this.position();
    this._teardown();
    this.running = false;
    this.startOffset = pos;
  }

  /** Seek to a media time, preserving play/pause state. */
  seek(t) {
    const wasRunning = this.running;
    this._teardown();
    this.running = false;
    this.startOffset = Math.max(0, Math.min(t, this.duration));
    if (wasRunning) this.play(this.startOffset);
  }

  stop() {
    const wasRunning = this.running;
    this._teardown();
    this.running = false;
    this.startOffset = 0;
    if (wasRunning && this.onEnded) this.onEnded();
  }

  _finish() {
    this._teardown();
    this.running = false;
    this.startOffset = 0;
    if (this.onEnded) this.onEnded();
  }

  _teardown() {
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch (_) {}
      try { this.source.disconnect(); } catch (_) {}
      this.source = null;
    }
    if (this.schedId) { clearInterval(this.schedId); this.schedId = null; }
  }

  _resetClickPointer() {
    if (!this.period) { this.nextBeat = Infinity; return; }
    const pos = this.position();
    const k = Math.ceil((pos - this.phase) / this.period);
    this.nextBeat = this.phase + k * this.period;
  }

  // Look-ahead scheduler: queue click sounds slightly before they're due.
  _scheduleLoop() {
    const lookahead = 0.2;
    this.schedId = setInterval(() => {
      if (!this.running || !this.clickOn || this.period <= 0) return;
      while (this.nextBeat < this.duration) {
        const realtime = this.startClock + (this.nextBeat - this.startOffset) / this.rate;
        if (realtime > this.ctx.currentTime + lookahead) break;
        if (realtime >= this.ctx.currentTime - 0.05) {
          const beatIndex = Math.round((this.nextBeat - this.phase) / this.period);
          this._click(realtime, beatIndex);
        }
        this.nextBeat += this.period;
      }
    }, 40);
  }

  _click(time, beatIndex) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const accent = ((beatIndex % 4) + 4) % 4 === 0; // accent every 4th beat
    osc.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
  }
}

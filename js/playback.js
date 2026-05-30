// playback.js — plays a recorded/loaded take through an <audio> element so that
// changing speed preserves pitch (HTMLMediaElement.preservesPitch). A Web-Audio
// scheduler adds an optional metronome click and an optional synthesized piano
// voice for the detected MIDI notes, both locked to the audio's media clock.

export class Playback {
  constructor(audioCtx) {
    this.ctx = audioCtx;
    this.audio = new Audio();
    this.audio.preservesPitch = true;
    this.audio.mozPreservesPitch = true;
    this.audio.webkitPreservesPitch = true;
    this.audio.addEventListener("ended", () => {
      this.running = false;
      this._stopScheduler();
      if (this.onEnded) this.onEnded();
    });

    this.duration = 0;
    this.rate = 1;
    this.running = false;

    this.clickOn = false;
    this.synthOn = false;
    this.period = 0;
    this.phase = 0;
    this.notes = [];

    this.schedId = null;
    this.nextBeat = Infinity;
    this.noteCursor = 0;

    this.onEnded = null;
  }

  setSource(url, duration) {
    this.audio.src = url;
    this.duration = duration || 0;
  }

  setRate(rate) {
    this.rate = rate;
    this.audio.playbackRate = rate;
    this.audio.preservesPitch = true;
    this.audio.mozPreservesPitch = true;
    this.audio.webkitPreservesPitch = true;
    if (this.running) this._initSchedule();
  }

  setClick(on) { this.clickOn = on; if (this.running) this._initSchedule(); }
  setSynth(on) { this.synthOn = on; if (this.running) this._initSchedule(); }
  setBeat(period, phase) { this.period = period || 0; this.phase = phase || 0; if (this.running) this._initSchedule(); }
  setNotes(notes) { this.notes = notes.slice().sort((a, b) => a.startTime - b.startTime); }

  position() { return this.audio.currentTime || 0; }

  play(from = 0) {
    if (!this.audio.src) return;
    if (from >= this.duration - 0.05) from = 0;
    try { this.audio.currentTime = from; } catch (_) {}
    this.setRate(this.rate);
    const p = this.audio.play();
    if (p && p.catch) p.catch(() => {});
    this.running = true;
    this._initSchedule();
    this._startScheduler();
  }

  pause() {
    this.audio.pause();
    this.running = false;
    this._stopScheduler();
  }

  seek(t) {
    try { this.audio.currentTime = Math.max(0, Math.min(t, this.duration)); } catch (_) {}
    if (this.running) this._initSchedule();
  }

  stop() {
    const was = this.running;
    this.audio.pause();
    try { this.audio.currentTime = 0; } catch (_) {}
    this.running = false;
    this._stopScheduler();
    if (was && this.onEnded) this.onEnded();
  }

  // Reset the click/note pointers to the current media position.
  _initSchedule() {
    const pos = this.position();
    if (this.period > 0) {
      const k = Math.ceil((pos - this.phase) / this.period);
      this.nextBeat = this.phase + k * this.period;
    } else {
      this.nextBeat = Infinity;
    }
    this.noteCursor = 0;
    while (this.noteCursor < this.notes.length && this.notes[this.noteCursor].startTime < pos) {
      this.noteCursor++;
    }
  }

  _startScheduler() {
    this._stopScheduler();
    this.schedId = setInterval(() => this._tick(), 40);
  }
  _stopScheduler() {
    if (this.schedId) { clearInterval(this.schedId); this.schedId = null; }
  }

  _tick() {
    if (!this.running) return;
    const lookahead = 0.25;
    const pos = this.position();
    // Realtime (AudioContext clock) corresponding to media time 0.
    const base = this.ctx.currentTime - pos / this.rate;
    const horizon = pos + lookahead * this.rate;
    const minRealtime = this.ctx.currentTime - 0.02;

    if (this.clickOn && this.period > 0) {
      while (this.nextBeat < this.duration && this.nextBeat <= horizon) {
        const realtime = base + this.nextBeat / this.rate;
        if (realtime > minRealtime) {
          this._click(realtime, Math.round((this.nextBeat - this.phase) / this.period));
        }
        this.nextBeat += this.period;
      }
    }

    if (this.synthOn) {
      while (this.noteCursor < this.notes.length && this.notes[this.noteCursor].startTime <= horizon) {
        const n = this.notes[this.noteCursor];
        const realtime = base + n.startTime / this.rate;
        const dur = Math.max(0.08, n.endTime - n.startTime) / this.rate;
        if (realtime > minRealtime) this._note(realtime, n.midi, dur);
        this.noteCursor++;
      }
    }
  }

  _click(time, beatIndex) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const accent = ((beatIndex % 4) + 4) % 4 === 0;
    osc.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  // A simple plucked/piano-ish voice: triangle fundamental + a softer octave,
  // with a fast attack and exponential decay.
  _note(time, midi, dur) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const out = this.ctx.createGain();
    out.connect(this.ctx.destination);
    const peak = 0.16;
    const end = time + Math.min(dur + 0.35, 3.5);
    out.gain.setValueAtTime(0.0001, time);
    out.gain.exponentialRampToValueAtTime(peak, time + 0.006);
    out.gain.exponentialRampToValueAtTime(0.0001, end);

    const o1 = this.ctx.createOscillator();
    o1.type = "triangle";
    o1.frequency.value = freq;
    o1.connect(out);

    const o2 = this.ctx.createOscillator();
    o2.type = "sine";
    o2.frequency.value = freq * 2;
    const g2 = this.ctx.createGain();
    g2.gain.value = 0.3;
    o2.connect(g2).connect(out);

    o1.start(time); o2.start(time);
    o1.stop(end + 0.05); o2.stop(end + 0.05);
  }
}

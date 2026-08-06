import { Events } from './eventbus.js';

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.enabled = true;
    this.musicOn = true;
    this.engineNodes = null;
    this.skidNodes = null;
    this.ambNodes = null;
    this.rainNodes = null;
    this._musicTimer = null;
    this._birdTimer = null;
    this.hornUntil = 0;
    this._ready = false;
  }

  /* Вызывать по первому жесту пользователя */
  unlock() {
    if (this._ready) { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85;
      this.master.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.9;
      this.sfxGain.connect(this.master);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.22;
      this.musicGain.connect(this.master);
      this._buildEngine();
      this._buildSkid();
      this._buildAmbient();
      this._ready = true;
      this.startMusic();
      Events.on('crash', (d) => this.crash(d ? d.impact || 20 : 20));
      Events.on('money', (d) => this.cash(d ? d.amount || 100 : 100));
      Events.on('pickup', () => this.pickup());
      Events.on('order:accepted', () => this.pickup());
      Events.on('order:completed', (r) => this.cash(r ? r.tips > 40 : true));
      Events.on('fail', () => this.fail());
      Events.on('order:failed', () => this.fail());
      Events.on('hitPed', (d) => {
        if (d && d.byPlayer === false) return;
        this.pedHit();
      });
      Events.on('ped:kick', () => this.thud());
      Events.on('horn', () => this.horn());
      Events.on('passenger:speak', () => this.speak());
      Events.on('game:state_changed', ({ state }) => {
        if (state === 'pause' || state === 'menu' || state === 'shiftend') {
          this.updateEngine(0, 0, false);
          this.updateSkid(0);
        }
      });
    } catch (e) { console.warn('audio error', e); }
  }

  _noiseBuffer(sec = 2) {
    const len = Math.floor(this.ctx.sampleRate * sec);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* --- Двигатель: 2 осциллятора + фильтр, тон по оборотам --- */
  _buildEngine() {
    const c = this.ctx;
    const o1 = c.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 60;
    const o2 = c.createOscillator(); o2.type = 'square'; o2.frequency.value = 30;
    const g2 = c.createGain(); g2.gain.value = 0.35;
    const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 500; flt.Q.value = 3;
    const g = c.createGain(); g.gain.value = 0;
    o1.connect(flt); o2.connect(g2); g2.connect(flt); flt.connect(g); g.connect(this.sfxGain);
    o1.start(); o2.start();
    this.engineNodes = { o1, o2, flt, g };
  }

  /* Скрип шин — шум через полосовой фильтр */
  _buildSkid() {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this._noiseBuffer(2); src.loop = true;
    const flt = c.createBiquadFilter(); flt.type = 'bandpass'; flt.frequency.value = 900; flt.Q.value = 1.2;
    const g = c.createGain(); g.gain.value = 0;
    src.connect(flt); flt.connect(g); g.connect(this.sfxGain);
    src.start();
    this.skidNodes = { flt, g };
  }

  /* Городской эмбиент: ветер + птицы */
  _buildAmbient() {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this._noiseBuffer(3); src.loop = true;
    const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 400;
    const g = c.createGain(); g.gain.value = 0.05;
    src.connect(flt); flt.connect(g); g.connect(this.master);
    src.start();
    this.ambNodes = { flt, g };
    this._birdTimer = setInterval(() => { if (this.enabled && Math.random() < 0.6) this.bird(); }, 7000);
  }

  /* Дождь */
  setRain(on) {
    const c = this.ctx;
    if (on && !this.rainNodes) {
      const src = c.createBufferSource(); src.buffer = this._noiseBuffer(2); src.loop = true;
      const flt = c.createBiquadFilter(); flt.type = 'highpass'; flt.frequency.value = 1200;
      const g = c.createGain(); g.gain.value = 0.05;
      src.connect(flt); flt.connect(g); g.connect(this.master);
      src.start();
      this.rainNodes = { flt, g };
    }
    if (this.rainNodes) this.rainNodes.g.gain.value = on ? 0.05 : 0;
  }

  updateEngine(rpm, throttle, running) {
    if (!this.engineNodes) return;
    const { o1, o2, flt, g } = this.engineNodes;
    if (this.enabled && running) {
      const f = 55 + rpm * 130;
      o1.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05);
      o2.frequency.setTargetAtTime(f * 0.5, this.ctx.currentTime, 0.05);
      flt.frequency.setTargetAtTime(350 + rpm * 700 + throttle * 200, this.ctx.currentTime, 0.08);
      g.gain.setTargetAtTime(0.05 + throttle * 0.1 + rpm * 0.04, this.ctx.currentTime, 0.1);
    } else {
      g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    }
  }

  updateSkid(intensity) {
    if (!this.skidNodes) return;
    const { flt, g } = this.skidNodes;
    if (this.enabled && intensity > 0.02) {
      flt.frequency.setTargetAtTime(600 + intensity * 800, this.ctx.currentTime, 0.05);
      g.gain.setTargetAtTime(0.06 * intensity, this.ctx.currentTime, 0.05);
    } else {
      g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    }
  }

  _tone(freq, dur, type = 'sine', gain = 0.2, when = 0, slideTo = null) {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime + when;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.sfxGain);
    o.start(t); o.stop(t + dur + 0.05);
  }

  _noiseBurst(dur, gain, filterFreq, when = 0) {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime + when;
    const src = c.createBufferSource(); src.buffer = this._noiseBuffer(1);
    const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = filterFreq;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt); flt.connect(g); g.connect(this.sfxGain);
    src.start(t); src.stop(t + dur + 0.05);
  }

  horn() { if (!this.enabled) return; this._tone(430, 0.28, 'square', 0.08); this._tone(365, 0.28, 'square', 0.08, 0, 420); }
  crash(impact) {
    if (!this.enabled) return;
    const k = clamp(impact / 30, 0, 1);
    this._noiseBurst(0.25 + k * 0.3, 0.3 + k * 0.3, 300 + k * 600);
    this._tone(90, 0.3, 'sine', 0.25 + k * 0.2, 0, 45);
  }
  cash(amount) {
    if (!this.enabled) return;
    const n = clamp(1 + Math.floor(Math.abs(amount) / 150), 2, 6);
    for (let i = 0; i < n; i++) this._tone(880 + i * 220, 0.12, 'triangle', 0.12, i * 0.09);
  }
  pickup() { if (!this.enabled) return; this._tone(660, 0.1, 'triangle', 0.15); this._tone(880, 0.14, 'triangle', 0.15, 0.1); }
  speak() { if (!this.enabled) return; this._tone(580, 0.08, 'sine', 0.1); this._tone(740, 0.12, 'sine', 0.08, 0.06); }
  fail() { if (!this.enabled) return; this._tone(320, 0.2, 'sawtooth', 0.1); this._tone(220, 0.3, 'sawtooth', 0.1, 0.18); }
  pedHit() { if (!this.enabled) return; this._noiseBurst(0.4, 0.35, 500); this._tone(140, 0.4, 'sine', 0.2, 0, 70); }
  thud() { if (!this.enabled) return; this._noiseBurst(0.22, 0.45, 350); this._tone(100, 0.2, 'sine', 0.3, 0, 45); }
  stall() { if (!this.enabled) return; this._tone(120, 0.6, 'sawtooth', 0.12, 0, 40); }
  click() { if (!this.enabled) return; this._tone(520, 0.06, 'triangle', 0.08); }
  refuel() { if (!this.enabled) return; this._tone(300, 0.5, 'sawtooth', 0.08, 0, 900); }
  bird() {
    const f = rand(1800, 3200);
    this._tone(f, 0.09, 'sine', 0.03); this._tone(f * 0.85, 0.08, 'sine', 0.025, 0.1);
  }
  raceGo() { if (!this.enabled) return; this._tone(523, 0.15, 'square', 0.12); this._tone(659, 0.15, 'square', 0.12, 0.2); this._tone(784, 0.3, 'square', 0.12, 0.4); }

  /**
   * Пространственное воспроизведение речевых звуков / выкриков.
   * Дистанционное затухание: чем дальше источник, тем тише воспроизводится звук.
   */
  spatialSpeak(sourceX, sourceZ, playerX, playerZ, type = 'shout', playerHeading = 0) {
    if (!this.enabled || !this.ctx || !this.sfxGain) return;

    let vol = 1.0;
    let panVal = 0;

    if (sourceX !== null && sourceX !== undefined && sourceZ !== null && sourceZ !== undefined && playerX !== undefined && playerZ !== undefined) {
      const dx = sourceX - playerX;
      const dz = sourceZ - playerZ;
      const dist = Math.hypot(dx, dz);
      const maxDist = 55; // Максимальная слышимость голосов — 55 м
      if (dist > maxDist) return;

      // Квадратичное затухание по расстоянию (1.0 вблизи, 0.0 на 55м)
      const att = Math.pow(1 - dist / maxDist, 1.6);
      vol = Math.min(1.0, Math.max(0.01, att * 0.85));

      // Стерео-панорамирование относительно направления камеры игрока
      const angleToSource = Math.atan2(dx, dz);
      const relAngle = angleToSource - (playerHeading || 0);
      panVal = Math.min(0.85, Math.max(-0.85, Math.sin(relAngle)));
    }

    const c = this.ctx;
    const t = c.currentTime;

    let destNode = this.sfxGain;
    if (c.createStereoPanner) {
      const panner = c.createStereoPanner();
      panner.pan.setValueAtTime(panVal, t);
      panner.connect(this.sfxGain);
      destNode = panner;
    }

    if (type === 'angry' || type === 'driver' || type === 'grump' || type === 'crash') {
      // Грубое ворчание / злобный выкрик (низкий saw-осциллятор с модуляцией и дисторшном)
      const o1 = c.createOscillator(); o1.type = 'sawtooth';
      const o2 = c.createOscillator(); o2.type = 'square';
      o1.frequency.setValueAtTime(110, t);
      o1.frequency.linearRampToValueAtTime(160, t + 0.1);
      o1.frequency.linearRampToValueAtTime(95, t + 0.28);

      o2.frequency.setValueAtTime(85, t);
      o2.frequency.linearRampToValueAtTime(130, t + 0.1);
      o2.frequency.linearRampToValueAtTime(75, t + 0.28);

      const flt = c.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.setValueAtTime(450, t);
      flt.frequency.linearRampToValueAtTime(800, t + 0.1);
      flt.frequency.linearRampToValueAtTime(350, t + 0.28);

      const g = c.createGain(); g.gain.setValueAtTime(vol * 0.26, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);

      o1.connect(flt); o2.connect(flt); flt.connect(g); g.connect(destNode);
      o1.start(t); o2.start(t); o1.stop(t + 0.33); o2.stop(t + 0.33);
    } else if (type === 'scream' || type === 'hit') {
      // Испуганный вскрик пешехода (высокий тон)
      const o = c.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(480, t);
      o.frequency.exponentialRampToValueAtTime(820, t + 0.12);
      o.frequency.exponentialRampToValueAtTime(350, t + 0.28);
      const g = c.createGain(); g.gain.setValueAtTime(vol * 0.22, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g); g.connect(destNode);
      o.start(t); o.stop(t + 0.31);
    } else if (type === 'greeting' || type === 'passenger_happy') {
      // Приветливый мажорный аккорд пассажира
      const freqs = [440, 554, 659];
      freqs.forEach((f, idx) => {
        const o = c.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(f, t + idx * 0.06);
        const g = c.createGain(); g.gain.setValueAtTime(vol * 0.12, t + idx * 0.06);
        g.gain.exponentialRampToValueAtTime(0.0001, t + idx * 0.06 + 0.12);
        o.connect(g); g.connect(destNode);
        o.start(t + idx * 0.06); o.stop(t + idx * 0.06 + 0.13);
      });
    } else if (type === 'shock' || type === 'drift') {
      // Вскрик от дрифта / виража
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(620, t);
      o.frequency.exponentialRampToValueAtTime(320, t + 0.2);
      o.frequency.exponentialRampToValueAtTime(540, t + 0.38);
      const g = c.createGain(); g.gain.setValueAtTime(vol * 0.15, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g); g.connect(destNode);
      o.start(t); o.stop(t + 0.41);
    } else {
      // Стандартный речевой сигнал
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(340, t);
      o.frequency.exponentialRampToValueAtTime(540, t + 0.09);
      o.frequency.exponentialRampToValueAtTime(420, t + 0.18);
      const g = c.createGain(); g.gain.setValueAtTime(vol * 0.14, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g); g.connect(destNode);
      o.start(t); o.stop(t + 0.21);
    }
  }

  /* --- Музыка: простой секвенсор (Am F C G, лоу-фай) --- */
  startMusic() {
    if (this._musicTimer || !this._ready) return;
    const chords = [
      [220.0, 261.6, 329.6], [174.6, 220.0, 261.6],
      [196.0, 246.9, 293.7], [196.0, 261.6, 392.0],
    ];
    let bar = 0;
    const step = () => {
      if (!this.musicOn || !this.enabled) { this._musicTimer = setTimeout(step, 500); return; }
      const chord = chords[bar % 4];
      const t0 = this.ctx.currentTime;
      // мягкие подушки
      for (const f of chord) {
        this._tone(f, 3.8, 'triangle', 0.035, 0);
        this._tone(f * 2, 3.2, 'sine', 0.02, 0.1);
      }
      // бас
      this._tone(chord[0] / 2, 3.6, 'sine', 0.05, 0.02);
      // «хэт» на восьмых
      for (let i = 0; i < 8; i++) if (i % 2 === 0) this._noiseBurst(0.03, 0.012, 6000, i * 0.5);
      bar++;
      this._musicTimer = setTimeout(step, 4000);
    };
    step();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.85 : 0, this.ctx.currentTime, 0.1);
  }
  setMusic(on) { this.musicOn = on; }
  /* --- Алиасы, используемые Game --- */
  setEngine(rpm, throttle, running) { this.updateEngine(rpm, throttle, running); }
  setSkid(intensity) { this.updateSkid(intensity); }
  setMaster(on) { this.setEnabled(on); }
  chime() { this.pickup(); }
  error() { this.fail(); }
}

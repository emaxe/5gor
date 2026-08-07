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
    this._staticTimer = null;

    this.hornUntil = 0;
    this._ready = false;

    // ----- Радиостанции -----
    this.stations = [
      { id: 'off', name: 'Радио ВЫКЛ', genre: 'Тишина', icon: '🔇' },
      { id: 'pyatigorsk', name: 'Пятигорск FM', genre: 'Лоу-фай Чилл', icon: '📻' },
      { id: 'synth', name: 'Машук Synth 80s', genre: 'Ретровейв / Синт', icon: '🌆' },
      { id: 'kavkaz', name: 'Кавказ Beat', genre: 'Динамичный Этно-бит', icon: '⛰️' },
      { id: 'chanson', name: 'Кавказ Шансон', genre: 'Душевный Блатняк', icon: '🪕' },
      { id: 'chilled', name: 'Ночной Курорт', genre: 'Эмбиент Дезерт', icon: '🌙' },
    ];
    this.currentStationIndex = 1; // По умолчанию Пятигорск FM
    this.isTuning = false;
    this._stepCounter = 0;
  }

  /* Вызывать по первому жесту пользователя */
  unlock() {
    if (this._ready) {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
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
      this.musicGain.gain.value = 0.28;
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
      Events.on('horn', (d = {}) => {
        if (d.sourceX !== undefined && this._gamePlayer) {
          d.playerX = this._gamePlayer.x;
          d.playerZ = this._gamePlayer.z;
          d.playerHeading = this._gamePlayer.heading;
        }
        this.horn(d);
      });
      Events.on('passenger:speak', () => this.speak());
      Events.on('game:state_changed', ({ state }) => {
        if (state === 'pause' || state === 'menu' || state === 'shiftend') {
          this.updateEngine(0, 0, false);
          this.updateSkid(0);
        }
      });
    } catch (e) {
      console.warn('audio error', e);
    }
  }

  _noiseBuffer(sec = 2) {
    const len = Math.floor(this.ctx.sampleRate * sec);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* --- Двигатель: 3 осциллятора с саб-басом, фильтрацией и рыком --- */
  _buildEngine() {
    const c = this.ctx;
    const o1 = c.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 55;
    const o2 = c.createOscillator(); o2.type = 'square'; o2.frequency.value = 27.5;
    const o3 = c.createOscillator(); o3.type = 'triangle'; o3.frequency.value = 110;
    
    const g2 = c.createGain(); g2.gain.value = 0.4;
    const g3 = c.createGain(); g3.gain.value = 0.2;
    
    const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 450; flt.Q.value = 2.5;
    const g = c.createGain(); g.gain.value = 0;

    o1.connect(flt);
    o2.connect(g2); g2.connect(flt);
    o3.connect(g3); g3.connect(flt);

    flt.connect(g);
    g.connect(this.sfxGain);

    o1.start(); o2.start(); o3.start();
    this.engineNodes = { o1, o2, o3, flt, g };
  }

  /* Скрип шин — полосовой фильтр с модулированным шумом */
  _buildSkid() {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this._noiseBuffer(2); src.loop = true;
    const flt = c.createBiquadFilter(); flt.type = 'bandpass'; flt.frequency.value = 950; flt.Q.value = 2.0;
    const g = c.createGain(); g.gain.value = 0;
    src.connect(flt); flt.connect(g); g.connect(this.sfxGain);
    src.start();
    this.skidNodes = { flt, g };
  }

  /* Городской эмбиент: шелест ветра + птицы */
  _buildAmbient() {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this._noiseBuffer(3); src.loop = true;
    const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 350;
    const g = c.createGain(); g.gain.value = 0.04;
    src.connect(flt); flt.connect(g); g.connect(this.master);
    src.start();
    this.ambNodes = { flt, g };
    this._birdTimer = setInterval(() => { if (this.enabled && Math.random() < 0.6) this.bird(); }, 6500);
  }

  /* Дождь */
  setRain(on) {
    const c = this.ctx;
    if (on && !this.rainNodes) {
      const src = c.createBufferSource(); src.buffer = this._noiseBuffer(2); src.loop = true;
      const flt = c.createBiquadFilter(); flt.type = 'highpass'; flt.frequency.value = 1100;
      const g = c.createGain(); g.gain.value = 0.05;
      src.connect(flt); flt.connect(g); g.connect(this.master);
      src.start();
      this.rainNodes = { flt, g };
    }
    if (this.rainNodes) this.rainNodes.g.gain.value = on ? 0.06 : 0;
  }

  updateEngine(rpm, throttle, running) {
    if (!this.engineNodes) return;
    const { o1, o2, o3, flt, g } = this.engineNodes;
    if (this.enabled && running) {
      const baseFreq = 48 + rpm * 140;
      o1.frequency.setTargetAtTime(baseFreq, this.ctx.currentTime, 0.04);
      o2.frequency.setTargetAtTime(baseFreq * 0.5, this.ctx.currentTime, 0.04);
      o3.frequency.setTargetAtTime(baseFreq * 1.5, this.ctx.currentTime, 0.04);

      flt.frequency.setTargetAtTime(300 + rpm * 900 + throttle * 350, this.ctx.currentTime, 0.06);
      g.gain.setTargetAtTime(0.06 + throttle * 0.12 + rpm * 0.05, this.ctx.currentTime, 0.08);
    } else {
      g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    }
  }

  updateSkid(intensity) {
    if (!this.skidNodes) return;
    const { flt, g } = this.skidNodes;
    if (this.enabled && intensity > 0.02) {
      flt.frequency.setTargetAtTime(700 + intensity * 950, this.ctx.currentTime, 0.04);
      g.gain.setTargetAtTime(0.08 * intensity, this.ctx.currentTime, 0.04);
    } else {
      g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    }
  }

  _tone(freq, dur, type = 'sine', gain = 0.2, when = 0, slideTo = null, dest = null) {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime + when;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    
    const targetNode = dest || this.sfxGain;
    o.connect(g); g.connect(targetNode);
    o.start(t); o.stop(t + dur + 0.05);
  }

  _musicNote(freq, dur, type = 'sine', gain = 0.1, when = 0, slideTo = null) {
    if (!this.ctx) return;
    this._tone(freq, dur, type, gain, when, slideTo, this.musicGain);
  }

  _noiseBurst(dur, gain, filterFreq, when = 0, dest = null) {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime + when;
    const src = c.createBufferSource(); src.buffer = this._noiseBuffer(1);
    const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = filterFreq;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const targetNode = dest || this.sfxGain;
    src.connect(flt); flt.connect(g); g.connect(targetNode);
    src.start(t); src.stop(t + dur + 0.05);
  }

  // --- Сочные и реалистичные автомобильные гудки с 3D-позиционированием ---
  horn(opts = {}) {
    if (!this.enabled || !this.ctx) return;

    let vol = 1.0;
    let panVal = 0;

    // Расчет 3D затухания по расстоянию до игрока
    if (opts.sourceX !== undefined && opts.sourceZ !== undefined && opts.playerX !== undefined && opts.playerZ !== undefined) {
      const dx = opts.sourceX - opts.playerX;
      const dz = opts.sourceZ - opts.playerZ;
      const dist = Math.hypot(dx, dz);
      const maxDist = 180; // Гудок слышен на расстоянии до 180 метров по всему району
      if (dist > maxDist) return; // Слишком далеко — тишина

      // Плавное физическое затухание громкости
      const att = Math.pow(1 - dist / maxDist, 1.2);
      vol = Math.min(1.0, Math.max(0.08, att * 0.95));

      // Панорамирование
      const angleToSource = Math.atan2(dx, dz);
      const relAngle = angleToSource - (opts.playerHeading || 0);
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

    // Различные тембры клаксонов
    const type = opts.type || (Math.random() < 0.35 ? 'sedan' : Math.random() < 0.7 ? 'classic' : Math.random() < 0.88 ? 'suv' : 'truck');
    const dur = opts.dur || (type === 'player' ? 0.65 : type === 'truck' ? 0.6 : 0.45);

    if (type === 'player') {
      // Басовитый, глубокий и продолжительный клаксон игрока (Низкий дуэт + суб-бас)
      const f1 = 293.66, f2 = 369.99; // D4 + F#4
      this._tone(f1, dur, 'sawtooth', vol * 0.16, 0, null, destNode);
      this._tone(f2, dur, 'sawtooth', vol * 0.14, 0, null, destNode);
      this._tone(f1 * 0.5, dur, 'sine', vol * 0.22, 0, null, destNode); // Глубокий бас (D3)
      this._tone(f1 * 0.25, dur, 'sine', vol * 0.15, 0, null, destNode); // Суб-бас (D2)
    } else if (type === 'truck') {
      // Пневматический низкий гудок грузовика (Фа-Фа)
      const f1 = 185, f2 = 233;
      this._tone(f1, dur, 'sawtooth', vol * 0.18, 0, null, destNode);
      this._tone(f2, dur, 'sawtooth', vol * 0.15, 0, null, destNode);
      this._tone(f1 * 0.5, dur, 'sine', vol * 0.22, 0, null, destNode);
    } else if (type === 'suv') {
      // Громкий басовитый клаксон внедорожника
      const f1 = 330, f2 = 415;
      this._tone(f1, dur, 'sawtooth', vol * 0.14, 0, null, destNode);
      this._tone(f2, dur, 'square', vol * 0.12, 0, null, destNode);
      this._tone(f1 * 0.5, dur, 'sine', vol * 0.15, 0, null, destNode);
    } else if (type === 'classic') {
      // Звук классического гудка советского седана (Жигули/Пятерка)
      const f1 = 370, f2 = 293.66;
      this._tone(f1, dur, 'sawtooth', vol * 0.14, 0, null, destNode);
      this._tone(f2, dur, 'sawtooth', vol * 0.14, 0, null, destNode);
      this._tone(f2 * 0.5, dur, 'sine', vol * 0.12, 0, null, destNode);
    } else {
      // Стандартный европейский двухтональный легковой гудок
      const f1 = 415, f2 = 330;
      this._tone(f1, dur, 'sawtooth', vol * 0.13, 0, null, destNode);
      this._tone(f2, dur, 'square', vol * 0.11, 0, null, destNode);
      this._tone(f2 * 0.5, dur, 'sine', vol * 0.10, 0, null, destNode);
    }
  }

  crash(impact) {
    if (!this.enabled) return;
    const k = Math.min(1, Math.max(0, impact / 30));
    // Глубокий металлический удар + метаморфный шумок
    this._noiseBurst(0.3 + k * 0.3, 0.4 + k * 0.4, 350 + k * 800);
    this._tone(70, 0.4, 'sine', 0.35 + k * 0.25, 0, 35);
    this._tone(160, 0.25, 'sawtooth', 0.15 + k * 0.15, 0, 50);
  }

  cash(amount) {
    if (!this.enabled) return;
    // Бренчание монет / кассовый аппарат
    const n = Math.min(6, Math.max(2, 1 + Math.floor(Math.abs(amount) / 120)));
    for (let i = 0; i < n; i++) {
      this._tone(1046.5 + i * 180, 0.1, 'triangle', 0.14, i * 0.09, 1318.5);
    }
  }

  pickup() {
    if (!this.enabled) return;
    // Приятный двутональный джингл принятия заказа
    this._tone(523.25, 0.09, 'sine', 0.16);
    this._tone(659.25, 0.12, 'triangle', 0.18, 0.08);
    this._tone(783.99, 0.16, 'sine', 0.15, 0.16);
  }

  speak() {
    if (!this.enabled) return;
    this._tone(480, 0.07, 'sine', 0.1);
    this._tone(640, 0.1, 'sine', 0.09, 0.05);
  }

  fail() {
    if (!this.enabled) return;
    // Низкий разочаровывающий звук провала
    this._tone(293.66, 0.22, 'sawtooth', 0.12, 0, 220);
    this._tone(220.00, 0.35, 'sawtooth', 0.12, 0.18, 140);
  }

  pedHit() {
    if (!this.enabled) return;
    this._noiseBurst(0.35, 0.4, 450);
    this._tone(130, 0.35, 'sine', 0.25, 0, 60);
  }

  thud() {
    if (!this.enabled) return;
    this._noiseBurst(0.2, 0.4, 300);
    this._tone(90, 0.2, 'sine', 0.3, 0, 40);
  }

  stall() {
    if (!this.enabled) return;
    this._tone(110, 0.5, 'sawtooth', 0.14, 0, 35);
  }

  click() {
    if (!this.enabled) return;
    this._tone(587.33, 0.05, 'triangle', 0.09);
  }

  refuel() {
    if (!this.enabled) return;
    this._tone(261.63, 0.6, 'sawtooth', 0.09, 0, 880);
  }

  bird() {
    const f = 1900 + Math.random() * 1200;
    this._tone(f, 0.08, 'sine', 0.03);
    this._tone(f * 0.88, 0.07, 'sine', 0.025, 0.09);
  }

  raceGo() {
    if (!this.enabled) return;
    this._tone(523.25, 0.14, 'square', 0.12);
    this._tone(659.25, 0.14, 'square', 0.12, 0.18);
    this._tone(783.99, 0.28, 'square', 0.14, 0.36);
  }

  spatialSpeak(sourceX, sourceZ, playerX, playerZ, type = 'shout', playerHeading = 0) {
    if (!this.enabled || !this.ctx || !this.sfxGain) return;

    let vol = 1.0;
    let panVal = 0;

    if (sourceX !== null && sourceX !== undefined && sourceZ !== null && sourceZ !== undefined && playerX !== undefined && playerZ !== undefined) {
      const dx = sourceX - playerX;
      const dz = sourceZ - playerZ;
      const dist = Math.hypot(dx, dz);
      const maxDist = 55;
      if (dist > maxDist) return;

      const att = Math.pow(1 - dist / maxDist, 1.6);
      vol = Math.min(1.0, Math.max(0.01, att * 0.85));

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
      const o1 = c.createOscillator(); o1.type = 'sawtooth';
      const o2 = c.createOscillator(); o2.type = 'square';
      o1.frequency.setValueAtTime(110, t);
      o1.frequency.linearRampToValueAtTime(160, t + 0.1);
      o1.frequency.linearRampToValueAtTime(95, t + 0.28);

      o2.frequency.setValueAtTime(85, t);
      o2.frequency.linearRampToValueAtTime(130, t + 0.1);
      o2.frequency.linearRampToValueAtTime(75, t + 0.28);

      const flt = c.createBiquadFilter(); flt.type = 'lowpass';
      flt.frequency.setValueAtTime(450, t);
      flt.frequency.linearRampToValueAtTime(800, t + 0.1);
      flt.frequency.linearRampToValueAtTime(350, t + 0.28);

      const g = c.createGain(); g.gain.setValueAtTime(vol * 0.26, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);

      o1.connect(flt); o2.connect(flt); flt.connect(g); g.connect(destNode);
      o1.start(t); o2.start(t); o1.stop(t + 0.33); o2.stop(t + 0.33);
    } else if (type === 'scream' || type === 'hit') {
      const o = c.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(480, t);
      o.frequency.exponentialRampToValueAtTime(820, t + 0.12);
      o.frequency.exponentialRampToValueAtTime(350, t + 0.28);
      const g = c.createGain(); g.gain.setValueAtTime(vol * 0.22, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g); g.connect(destNode);
      o.start(t); o.stop(t + 0.31);
    } else if (type === 'greeting' || type === 'passenger_happy') {
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
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(620, t);
      o.frequency.exponentialRampToValueAtTime(320, t + 0.2);
      o.frequency.exponentialRampToValueAtTime(540, t + 0.38);
      const g = c.createGain(); g.gain.setValueAtTime(vol * 0.15, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g); g.connect(destNode);
      o.start(t); o.stop(t + 0.41);
    } else {
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

  // ----- Управление радиостанциями -----
  nextStation() {
    this.currentStationIndex = (this.currentStationIndex + 1) % this.stations.length;
    this._playRadioStatic();
    const st = this.getCurrentStation();
    Events.emit('radio:changed', st);
    return st;
  }

  getCurrentStation() {
    return this.stations[this.currentStationIndex];
  }

  /* Звук смены частот аналогового радио (радиовещательный шумок + свист гетеродина) */
  _playRadioStatic() {
    if (!this.enabled || !this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime;

    // 1. Белый шум перестройки частоты (FM Static)
    const src = c.createBufferSource(); src.buffer = this._noiseBuffer(0.35);
    const flt = c.createBiquadFilter(); flt.type = 'bandpass';
    flt.frequency.setValueAtTime(1500, t);
    flt.frequency.exponentialRampToValueAtTime(5500, t + 0.18);
    flt.frequency.exponentialRampToValueAtTime(2000, t + 0.32);
    flt.Q.value = 3.5;

    const g = c.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);

    src.connect(flt); flt.connect(g); g.connect(this.musicGain);
    src.start(t); src.stop(t + 0.35);

    // 2. Свист поиска гетеродина (Heterodyne Tuning Whistle)
    const osc = c.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(800, t);
    osc.frequency.exponentialRampToValueAtTime(3200, t + 0.15);
    osc.frequency.exponentialRampToValueAtTime(1200, t + 0.3);

    const oscG = c.createGain();
    oscG.gain.setValueAtTime(0.05, t);
    oscG.gain.exponentialRampToValueAtTime(0.001, t + 0.3);

    osc.connect(oscG); oscG.connect(this.musicGain);
    osc.start(t); osc.stop(t + 0.31);
  }

  /* --- Музыкальный полифонический трекер-секвенсор с сайдчейном и дилэем --- */
  startMusic() {
    if (this._musicTimer || !this._ready) return;

    let sixteenthStep = 0;
    const BPM = 118; // Динамичный темп 118 BPM
    const stepDuration = (60 / BPM) / 4; // ~127 мс на 1/16 шаг

    // Дополнительные звуковые шины и эффекты для музыки
    const c = this.ctx;
    const musicBus = c.createGain(); musicBus.gain.value = 0.8;
    const sidechainBus = c.createGain(); sidechainBus.gain.value = 1.0;
    
    // Эффект задержки (Stereo Delay)
    const delayNode = c.createDelay(); delayNode.delayTime.value = stepDuration * 3; // 3/16 эхо
    const delayFeedback = c.createGain(); delayFeedback.gain.value = 0.32;
    const delayFilter = c.createBiquadFilter(); delayFilter.type = 'lowpass'; delayFilter.frequency.value = 2200;
    
    delayNode.connect(delayFilter);
    delayFilter.connect(delayFeedback);
    delayFeedback.connect(delayNode);
    delayFilter.connect(this.musicGain);

    sidechainBus.connect(musicBus);
    musicBus.connect(this.musicGain);

    // Ударные инструменты
    const playKick = (t) => {
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(35, t + 0.09);
      const g = c.createGain(); g.gain.setValueAtTime(0.42, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      o.connect(g); g.connect(this.musicGain);
      o.start(t); o.stop(t + 0.15);

      // Эффект Sidechain ducking: приседание громкости аккордов и баса при ударе бочки
      sidechainBus.gain.cancelScheduledValues(t);
      sidechainBus.gain.setValueAtTime(0.35, t);
      sidechainBus.gain.exponentialRampToValueAtTime(1.0, t + 0.22);
    };

    const playSnare = (t) => {
      const o = c.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(210, t);
      o.frequency.exponentialRampToValueAtTime(85, t + 0.08);
      const g = c.createGain(); g.gain.setValueAtTime(0.24, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      o.connect(g); g.connect(this.musicGain);
      o.start(t); o.stop(t + 0.11);

      this._noiseBurst(0.14, 0.09, 3800, t - c.currentTime, this.musicGain);
    };

    const playClap = (t) => {
      this._noiseBurst(0.08, 0.06, 2200, t - c.currentTime, this.musicGain);
      this._noiseBurst(0.09, 0.08, 1800, t - c.currentTime + 0.015, this.musicGain);
    };

    const playHat = (t, open = false) => {
      const dur = open ? 0.14 : 0.035;
      const gain = open ? 0.045 : 0.025;
      this._noiseBurst(dur, gain, 8000, t - c.currentTime, musicBus);
    };

    const playBassNote = (t, freq, dur = 0.25, type = 'sawtooth') => {
      const o = c.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(freq, t);
      const flt = c.createBiquadFilter(); flt.type = 'lowpass';
      flt.frequency.setValueAtTime(550, t);
      flt.frequency.exponentialRampToValueAtTime(140, t + dur);
      const g = c.createGain(); g.gain.setValueAtTime(0.16, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(flt); flt.connect(g); g.connect(sidechainBus);
      o.start(t); o.stop(t + dur + 0.02);
    };

    const playLeadNote = (t, freq, dur = 0.2, type = 'triangle', sendDelay = false) => {
      const o = c.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(freq, t);
      const g = c.createGain(); g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.08, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g);
      g.connect(sidechainBus);
      if (sendDelay) g.connect(delayNode);
      o.start(t); o.stop(t + dur + 0.02);
    };

    const playPadChord = (t, freqs, dur = 1.0) => {
      freqs.forEach((f) => {
        const o = c.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(f, t);
        const g = c.createGain(); g.gain.setValueAtTime(0.001, t);
        g.gain.linearRampToValueAtTime(0.03, t + 0.12);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g); g.connect(sidechainBus);
        o.start(t); o.stop(t + dur + 0.05);
      });
    };

    // Музыкальные шкалы и 32-шаговые паттерны
    const CHORDS_LOFI = [
      [220.00, 261.63, 329.63, 392.00], // Am7
      [174.61, 220.00, 261.63, 329.63], // Fmaj7
      [130.81, 164.81, 196.00, 246.94], // Cmaj7
      [196.00, 246.94, 293.66, 349.23], // G7
    ];
    const BASS_LOFI = [110.00, 87.31, 65.41, 98.00];
    const MELODY_LOFI = [
      329.63, 392.00, 440.00, 523.25, 440.00, 392.00, 329.63, 293.66,
      329.63, 392.00, 440.00, 587.33, 523.25, 440.00, 392.00, 329.63
    ];

    const CHORDS_SYNTH = [
      [146.83, 174.61, 220.00, 261.63], // Dm7
      [116.54, 146.83, 174.61, 220.00], // Bbmaj7
      [174.61, 220.00, 261.63, 329.63], // Fmaj7
      [130.81, 164.81, 196.00, 246.94], // Cmaj7
    ];
    const BASS_SYNTH = [73.42, 58.27, 87.31, 65.41];
    const MELODY_SYNTH = [
      587.33, 523.25, 440.00, 349.23, 440.00, 523.25, 659.25, 587.33,
      783.99, 659.25, 587.33, 523.25, 440.00, 523.25, 587.33, 440.00
    ];

    const CHORDS_KAVKAZ = [
      [146.83, 155.56, 185.00, 220.00], // D фригийский
      [130.81, 146.83, 164.81, 196.00],
      [116.54, 130.81, 146.83, 174.61],
      [146.83, 185.00, 220.00, 293.66],
    ];
    const BASS_KAVKAZ = [73.42, 65.41, 58.27, 73.42];
    const MELODY_KAVKAZ = [
      293.66, 311.13, 369.99, 392.00, 440.00, 369.99, 311.13, 293.66,
      369.99, 392.00, 440.00, 554.37, 587.33, 554.37, 440.00, 369.99
    ];

    // Гармония и соло Кавказ Шансон (Am - Dm - E7 - Am)
    const CHORDS_CHANSON = [
      [220.00, 261.63, 329.63], // Am
      [146.83, 174.61, 220.00], // Dm
      [164.81, 207.65, 246.94, 293.66], // E7
      [220.00, 261.63, 329.63], // Am
    ];
    const BASS_CHANSON = [110.00, 73.42, 82.41, 110.00];
    const MELODY_CHANSON = [
      440.00, 523.25, 659.25, 587.33, 523.25, 440.00, 415.30, 440.00,
      523.25, 659.25, 783.99, 659.25, 587.33, 523.25, 440.00, 415.30
    ];

    const CHORDS_CHILL = [
      [130.81, 164.81, 196.00, 246.94], // Cmaj7
      [110.00, 130.81, 164.81, 196.00], // Am7
      [87.31, 110.00, 130.81, 164.81],  // Fmaj7
      [98.00, 123.47, 146.83, 174.61],  // G7
    ];
    const BASS_CHILL = [65.41, 55.00, 43.65, 49.00];

    const scheduler = () => {
      if (!this.musicOn || !this.enabled) {
        this._musicTimer = setTimeout(scheduler, 400);
        return;
      }

      const st = this.getCurrentStation();
      if (st.id === 'off') {
        this._musicTimer = setTimeout(scheduler, 500);
        return;
      }

      const now = this.ctx.currentTime;
      const step = sixteenthStep % 16;
      const step32 = sixteenthStep % 32;
      const chordIdx = Math.floor(step / 4) % 4;

      if (st.id === 'pyatigorsk') {
        // --- РИТМ ЛОУ-ФАЙ ---
        if (step === 0 || step === 10) playKick(now);
        if (step === 4 || step === 12) playSnare(now);
        if (step === 14) playClap(now);
        if (step % 2 === 0) playHat(now, step === 6 || step === 14);

        // --- БАС С САЙДЧЕЙНОМ ---
        if (step % 4 === 0 || step === 6 || step === 14) {
          playBassNote(now, BASS_LOFI[chordIdx], 0.26, 'sawtooth');
        }

        // --- АККОРДЫ ---
        if (step % 4 === 0) {
          playPadChord(now, CHORDS_LOFI[chordIdx], stepDuration * 3.8);
        }

        // --- СОЛО С ЭХО-ДИЛЭЕМ ---
        if (step === 2 || step === 7 || step === 11 || step === 15) {
          const note = MELODY_LOFI[step32 % MELODY_LOFI.length];
          playLeadNote(now, note, 0.22, 'triangle', true);
        }
      } else if (st.id === 'synth') {
        // --- ПЛОТНЫЙ РЕТРО-РИТМ ---
        if (step % 4 === 0) playKick(now);
        if (step === 4 || step === 12) playSnare(now);
        if (step % 4 === 2) playHat(now, true);
        if (step % 2 === 0) playHat(now, false);

        // --- СИНТ-БАС (Running 16th Bassline) ---
        playBassNote(now, BASS_SYNTH[chordIdx], 0.12, 'square');

        // --- СИНТ-ПЭД ---
        if (step === 0 || step === 8) {
          playPadChord(now, CHORDS_SYNTH[chordIdx], stepDuration * 7.5);
        }

        // --- РЕТРО-АРПЕДЖИО С ЭХО ---
        const arpeggioNotes = CHORDS_SYNTH[chordIdx];
        const arpNote = arpeggioNotes[step % arpeggioNotes.length] * 2;
        playLeadNote(now, arpNote, 0.14, 'sawtooth', true);
      } else if (st.id === 'kavkaz') {
        // --- ДИНАМИЧНЫЙ ЭТНО-РИТМ ---
        if (step === 0 || step === 3 || step === 6 || step === 8 || step === 11 || step === 14) {
          playKick(now);
        }
        if (step === 4 || step === 12) playSnare(now);
        if (step === 7 || step === 15) playClap(now);
        if (step % 2 === 1) playHat(now, step === 15);

        // --- БАС ---
        if (step === 0 || step === 6 || step === 8 || step === 14) {
          playBassNote(now, BASS_KAVKAZ[chordIdx], 0.2, 'sawtooth');
        }

        // --- СОЛО ---
        if (step % 2 === 0) {
          const note = MELODY_KAVKAZ[step32 % MELODY_KAVKAZ.length];
          playLeadNote(now, note, 0.18, 'sawtooth', true);
        }
      } else if (st.id === 'chanson') {
        // --- РИТМ ШАНСОНА / УМЦА-УМЦА ---
        if (step === 0 || step === 8) playKick(now);
        if (step === 4 || step === 12) playClap(now);
        if (step % 2 === 0) playHat(now, false);

        // --- ШАНСОН БАС ---
        if (step === 0 || step === 8) {
          playBassNote(now, BASS_CHANSON[chordIdx], 0.35, 'sawtooth');
        }

        // --- ПИЗЗИКАТО ГИТАРА / АККОРДЕОН ---
        if (step % 4 === 2) {
          playPadChord(now, CHORDS_CHANSON[chordIdx], 0.18);
        }

        // --- ДУШЕВНОЕ СОЛО С ЭХО ---
        if (step % 2 === 0) {
          const note = MELODY_CHANSON[step32 % MELODY_CHANSON.length];
          playLeadNote(now, note, 0.22, 'sawtooth', true);
        }
      } else if (st.id === 'chilled') {
        // --- ГЛУБОКИЙ ЧИЛЛ-АУТ ---
        if (step === 0) playKick(now);
        if (step === 8) playSnare(now);
        if (step % 4 === 2) playHat(now, true);

        // --- СУПЕР-САБ БАС ---
        if (step === 0 || step === 8) {
          playBassNote(now, BASS_CHILL[chordIdx], 0.65, 'sine');
        }

        // --- МЯГКИЙ АККОРД ---
        if (step === 0) {
          playPadChord(now, CHORDS_CHILL[chordIdx], stepDuration * 15);
        }
      }

      sixteenthStep++;
      this._musicTimer = setTimeout(scheduler, stepDuration * 1000);
    };

    scheduler();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.85 : 0, this.ctx.currentTime, 0.1);
  }

  setMusic(on) {
    this.musicOn = on;
  }

  /* --- Алиасы, используемые Game --- */
  setEngine(rpm, throttle, running) { this.updateEngine(rpm, throttle, running); }
  setSkid(intensity) { this.updateSkid(intensity); }
  setMaster(on) { this.setEnabled(on); }
  chime() { this.pickup(); }
  error() { this.fail(); }
}


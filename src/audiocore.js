/* Ядро звуковой системы: AudioContext, шины/микшер, лимитер, реверб,
   кеш шумовых буферов, пул панеров, voice-limiting. Не зависит от THREE
   и DOM — тестируется в node на заглушке AudioContext. */

export const AU_DEFAULT_VOL = { master: 0.8, music: 0.32, sfx: 0.85, engine: 0.55, ambient: 0.45, ui: 0.7, voice: 0.85 };
export const AU_BUDGET = { total: 28, horn: 3, crash: 2, ped: 3, voice: 3, click: 4, siren: 2 };
export const AU_COOLDOWN = { horn: 140, crash: 80, pedHit: 120, thud: 90, click: 40, step: 60 };
export const AU_NOISE_LENGTHS = [0.25, 1, 2, 3];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buses = null;
    this.ready = false;
    this.enabled = true;
    this._volumes = { ...AU_DEFAULT_VOL };
    this._noiseCache = null;
    this._panners = null;
    this._pannerIdx = { sfx: 0, voice: 0 };
    this._voiceTotal = 0;
    this._voiceByTag = {};
    this._lastPlay = {};
  }

  init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC();

    // master chain: шины -> masterGain -> лимитер -> safety-clip -> destination
    const safetyClip = c.createWaveShaper();
    safetyClip.curve = this._makeClipCurve();
    safetyClip.oversample = '2x';
    safetyClip.connect(c.destination);

    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.002; limiter.release.value = 0.18;
    limiter.connect(safetyClip);

    const masterGain = c.createGain();
    masterGain.gain.value = this._volumes.master;
    masterGain.connect(limiter);

    const mkBus = (key) => {
      const g = c.createGain();
      g.gain.value = this._volumes[key] !== undefined ? this._volumes[key] : 1;
      g.connect(masterGain);
      return g;
    };
    const music = mkBus('music');
    const sfx = mkBus('sfx');
    const engine = mkBus('engine');
    const ambient = mkBus('ambient');
    const voice = mkBus('voice');
    const ui = mkBus('ui'); // сухая шина, без реверб-сенда и даккинга

    // Реверб — одна процедурная IR («улица между домами»), без ассетов
    const reverbSend = c.createGain(); reverbSend.gain.value = 1;
    const reverbDamp = c.createBiquadFilter(); reverbDamp.type = 'lowpass'; reverbDamp.frequency.value = 4500;
    const convolver = c.createConvolver();
    convolver.buffer = this._makeImpulse(1.4, 2.2);
    const reverbReturn = c.createGain(); reverbReturn.gain.value = 1;
    reverbSend.connect(reverbDamp); reverbDamp.connect(convolver); convolver.connect(reverbReturn); reverbReturn.connect(masterGain);

    const sfxSend = c.createGain(); sfxSend.gain.value = 0.16; sfx.connect(sfxSend); sfxSend.connect(reverbSend);
    const voiceSend = c.createGain(); voiceSend.gain.value = 0.22; voice.connect(voiceSend); voiceSend.connect(reverbSend);
    const engineSend = c.createGain(); engineSend.gain.value = 0.06; engine.connect(engineSend); engineSend.connect(reverbSend);

    this.buses = { master: masterGain, music, sfx, engine, ambient, voice, ui, reverbSend, reverbReturn, sfxSend, voiceSend, engineSend };

    // Пулы панеров — создаются один раз, раздаются round-robin, ноль аллокаций
    // и ноль утечек на каждый horn()/spatialSpeak() (раньше StereoPanner
    // никогда не отключался от шины)
    this._panners = {
      sfx: Array.from({ length: 8 }, () => this._makePanner(sfx)),
      voice: Array.from({ length: 6 }, () => this._makePanner(voice)),
    };

    this.ready = true;
  }

  dispose() {
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ready = false;
  }

  _makePanner(bus) {
    if (!this.ctx.createStereoPanner) return bus; // фоллбек: шина как «панер» без панорамы
    const p = this.ctx.createStereoPanner();
    p.connect(bus);
    return p;
  }

  /* Взять панер из пула шины (round-robin) и выставить панораму на момент t.
     Если StereoPanner недоступен в браузере — вернёт саму шину без панорамы. */
  takePanner(kind, panVal, t) {
    const pool = this._panners && this._panners[kind];
    if (!pool || !pool.length) return this.buses[kind === 'voice' ? 'voice' : 'sfx'];
    this._pannerIdx[kind] = (this._pannerIdx[kind] + 1) % pool.length;
    const p = pool[this._pannerIdx[kind]];
    if (p.pan) p.pan.setValueAtTime(panVal, t);
    return p;
  }

  _makeClipCurve() {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 1.4) / Math.tanh(1.4);
    }
    return curve;
  }

  /* Процедурная импульсная характеристика для конволвера — без единого ассета */
  _makeImpulse(sec, decay) {
    const len = Math.floor(this.ctx.sampleRate * sec);
    const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  /* Кешированный шумовой буфер: раньше новый буфер (44100 вызовов Math.random())
     генерировался на КАЖДЫЙ noiseBurst — на плотных ритмических станциях это
     были сотни тысяч вызовов в секунду впустую. Буфер иммутабелен при
     воспроизведении, поэтому безопасно шарится между любым числом источников. */
  _noise(sec) {
    let pick = AU_NOISE_LENGTHS[AU_NOISE_LENGTHS.length - 1];
    for (const L of AU_NOISE_LENGTHS) { if (sec <= L) { pick = L; break; } }
    if (!this._noiseCache) this._noiseCache = new Map();
    let buf = this._noiseCache.get(pick);
    if (!buf) { buf = this._noiseBuffer(pick); this._noiseCache.set(pick, buf); }
    return buf;
  }

  _noiseBuffer(sec) {
    const len = Math.floor(this.ctx.sampleRate * sec);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* Простой одноголосый тон с ADSR-подобной огибающей (атака 15мс, экспоненциальный спад) */
  tone(freq, dur, type = 'sine', gain = 0.2, when = 0, slideTo = null, dest = null) {
    const c = this.ctx;
    if (!c) return null;
    const t = c.currentTime + when;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const targetNode = dest || this.buses.sfx;
    o.connect(g); g.connect(targetNode);
    o.start(t); o.stop(t + dur + 0.05);
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch (e) { /* уже отключён */ } };
    return o;
  }

  /* Отфильтрованный всплеск шума (удары, хэты, дождь-капли) — с случайным
     сдвигом внутри буфера и лёгкой вариацией playbackRate для разнообразия */
  noiseBurst(dur, gain, filterFreq, when = 0, dest = null) {
    const c = this.ctx;
    if (!c) return null;
    const t = c.currentTime + when;
    const buf = this._noise(dur);
    const src = c.createBufferSource(); src.buffer = buf;
    src.playbackRate.value = 0.92 + Math.random() * 0.16;
    const maxOffset = Math.max(0, buf.duration - dur - 0.02);
    const offset = maxOffset > 0 ? Math.random() * maxOffset : 0;
    const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = filterFreq;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const targetNode = dest || this.buses.sfx;
    src.connect(flt); flt.connect(g); g.connect(targetNode);
    src.start(t, offset);
    src.stop(t + dur + 0.05);
    src.onended = () => { try { src.disconnect(); flt.disconnect(); g.disconnect(); } catch (e) { /* уже отключён */ } };
    return src;
  }

  /* --- Voice-limiting: общий бюджет + бюджет по budgetTag + кулдаун по cooldownTag ---
     Разделены, т.к. несколько разных звуков (pedHit/thud) делят один бюджет 'ped',
     но должны иметь собственный независимый кулдаун. */
  alloc(budgetTag, cooldownTag = budgetTag) {
    if (this._voiceTotal >= AU_BUDGET.total) return false;
    const budget = AU_BUDGET[budgetTag];
    if (budget !== undefined && (this._voiceByTag[budgetTag] || 0) >= budget) return false;
    const cd = AU_COOLDOWN[cooldownTag];
    if (cd) {
      const last = this._lastPlay[cooldownTag] || 0;
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - last < cd) return false;
      this._lastPlay[cooldownTag] = now;
    }
    this._voiceTotal++;
    this._voiceByTag[budgetTag] = (this._voiceByTag[budgetTag] || 0) + 1;
    return true;
  }

  free(budgetTag) {
    this._voiceTotal = Math.max(0, this._voiceTotal - 1);
    this._voiceByTag[budgetTag] = Math.max(0, (this._voiceByTag[budgetTag] || 0) - 1);
  }

  /* Освободить бюджет через durationMs после alloc() — проще и надёжнее,
     чем считать onended по каждому из нескольких узлов одного «звука» */
  releaseAfter(budgetTag, durationMs) {
    setTimeout(() => this.free(budgetTag), Math.max(0, durationMs));
  }

  setVolume(key, val) {
    this._volumes[key] = Math.max(0, Math.min(1, val));
    const bus = key === 'master' ? this.buses?.master : this.buses?.[key];
    if (bus && this.ctx) bus.gain.setTargetAtTime(this._volumes[key], this.ctx.currentTime, 0.05);
  }

  getVolumes() {
    return { ...this._volumes };
  }

  setMasterEnabled(on) {
    this.enabled = on;
    if (this.buses && this.ctx) {
      this.buses.master.gain.setTargetAtTime(on ? this._volumes.master : 0, this.ctx.currentTime, 0.1);
    }
  }

  /* Диагностика voice-limiting для ?debug-оверлея */
  getVoiceStatus() {
    return { used: this._voiceTotal, total: AU_BUDGET.total, ctxState: this.ctx ? this.ctx.state : 'none' };
  }
}

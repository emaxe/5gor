import { Events } from './eventbus.js';

/* Радиодвижок на Tone.js: Tone.Transport вместо рекурсивного setTimeout
   (без дрейфа при просадке FPS), настоящие инструменты (MembraneSynth,
   NoiseSynth, MetalSynth, MonoSynth, PolySynth) вместо трёх осцилляторов
   вручную, индивидуальный BPM и текстура на станцию, кроссфейд-перестройка,
   даккинг на речь/краш, приглушение по дистанции камеры.

   Tone.js подключается вторым CDN-скриптом рядом с three.js (build.py).
   Если CDN недоступен (window.Tone отсутствует/window.__toneFailed) —
   радио молча остаётся без звука, вся остальная игра не страдает: статик
   при переключении станции реализован на чистом Web Audio через
   AudioEngine.noiseBurst/tone и не зависит от Tone вовсе. */
export class RadioEngine {
  constructor(engine) {
    this.engine = engine;
    this.musicOn = true;
    this._running = false;
    this._toneAvailable = false;
    this._setup = false;
    this._hour = 9;
    this._night = false;

    this.stations = [
      { id: 'off', name: 'Радио ВЫКЛ', genre: 'Тишина', icon: '🔇' },
      { id: 'pyatigorsk', name: 'Пятигорск FM', genre: 'Лоу-фай Чилл', icon: '📻', bpm: 84 },
      { id: 'synth', name: 'Машук Synth 80s', genre: 'Ретровейв / Синт', icon: '🌆', bpm: 116 },
      { id: 'kavkaz', name: 'Кавказ Beat', genre: 'Динамичный Этно-бит', icon: '⛰️', bpm: 128 },
      { id: 'chanson', name: 'Кавказ Шансон', genre: 'Душевный Блатняк', icon: '🪕', bpm: 104 },
      { id: 'chilled', name: 'Ночной Курорт', genre: 'Эмбиент Дезерт', icon: '🌙', bpm: 72 },
    ];
    this.currentStationIndex = 1; // По умолчанию Пятигорск FM
  }

  nextStation() {
    this._crossfadeTo((this.currentStationIndex + 1) % this.stations.length);
    const st = this.getCurrentStation();
    Events.emit('radio:changed', st);
    return st;
  }

  getCurrentStation() {
    return this.stations[this.currentStationIndex];
  }

  getStationId() {
    return this.getCurrentStation().id;
  }

  /* Восстановление станции по id из сохранения (а не по индексу — вставка
     новой станции в середину списка иначе перепутала бы старые сейвы).
     До первого unlock() (ctx ещё нет) просто переставляет индекс без
     кроссфейда/статика — эффекты внутри _crossfadeTo сами ничего не делают
     без готового AudioContext. */
  setStationId(id) {
    const idx = this.stations.findIndex((s) => s.id === id);
    if (idx < 0 || idx === this.currentStationIndex) return;
    this._crossfadeTo(idx);
    Events.emit('radio:changed', this.getCurrentStation());
  }

  /* Звук смены частот аналогового радио — чистый Web Audio, работает даже
     без Tone.js */
  _playStatic() {
    const e = this.engine;
    if (!e.enabled || !e.ctx) return;
    const c = e.ctx;
    const t = c.currentTime;

    const src = c.createBufferSource(); src.buffer = e._noise(0.35);
    const flt = c.createBiquadFilter(); flt.type = 'bandpass';
    flt.frequency.setValueAtTime(1500, t);
    flt.frequency.exponentialRampToValueAtTime(5500, t + 0.18);
    flt.frequency.exponentialRampToValueAtTime(2000, t + 0.32);
    flt.Q.value = 3.5;

    const g = c.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);

    src.connect(flt); flt.connect(g); g.connect(e.buses.music);
    src.start(t); src.stop(t + 0.35);

    const osc = c.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(800, t);
    osc.frequency.exponentialRampToValueAtTime(3200, t + 0.15);
    osc.frequency.exponentialRampToValueAtTime(1200, t + 0.3);

    const oscG = c.createGain();
    oscG.gain.setValueAtTime(0.05, t);
    oscG.gain.exponentialRampToValueAtTime(0.001, t + 0.3);

    osc.connect(oscG); oscG.connect(e.buses.music);
    osc.start(t); osc.stop(t + 0.31);
  }

  /* Кроссфейд между станциями: короткий фейд-аут -> статик -> фейд-ин на новой
     станции с новым BPM/текстурой */
  _crossfadeTo(newIndex) {
    this.currentStationIndex = newIndex;
    this._playStatic();
    if (!this._toneAvailable) return;
    const now = Tone.now();
    this._fadeGain.gain.cancelScheduledValues(now);
    this._fadeGain.gain.setValueAtTime(this._fadeGain.gain.value, now);
    this._fadeGain.gain.linearRampToValueAtTime(0, now + 0.12);
    this._fadeGain.gain.setValueAtTime(0, now + 0.3);
    this._fadeGain.gain.linearRampToValueAtTime(1, now + 0.5);
    this._applyBpm();
    this._applyStationColor(this.getCurrentStation());
  }

  /* Приглушение и приглушение верхов радио, когда камера отдаляется от
     машины (радио «играет из салона») */
  setCamDist(dist) {
    if (!this._toneAvailable) return;
    // Вызывается каждый кадр из updateVehicle() — не перепланируем автоматизацию,
    // если дистанция камеры почти не изменилась (иначе 60 rampTo()/сек впустую)
    if (this._lastCamDist !== undefined && Math.abs(dist - this._lastCamDist) < 0.15) return;
    this._lastCamDist = dist;
    const t = Math.max(0, Math.min(1, (dist - 5) / (16 - 5)));
    const freq = 6500 - t * (6500 - 900);
    const gainMul = 1 - t * 0.45;
    this._radioLP.frequency.rampTo(freq, 0.15);
    this._camGain.gain.rampTo(gainMul, 0.15);
  }

  /* Даккинг радио на речь пассажира/крик/столкновение */
  duck(toGain, holdSec, releaseSec) {
    if (!this._toneAvailable) return;
    const now = Tone.now();
    this._duckGain.gain.cancelScheduledValues(now);
    this._duckGain.gain.setValueAtTime(this._duckGain.gain.value, now);
    this._duckGain.gain.linearRampToValueAtTime(toGain, now + 0.05);
    this._duckGain.gain.setValueAtTime(toGain, now + 0.05 + holdSec);
    this._duckGain.gain.linearRampToValueAtTime(1, now + 0.05 + holdSec + releaseSec);
  }

  /* Час суток — влияет на темп (ночью чуть медленнее и тише) */
  setHour(hour) {
    const wasNight = this._night;
    this._hour = hour;
    this._night = hour >= 22 || hour < 6;
    if (this._night !== wasNight) this._applyBpm();
  }

  _applyBpm() {
    const st = this.getCurrentStation();
    const bpm = (st.bpm || 118) * (this._night ? 0.94 : 1);
    this._stepDuration = (60 / bpm) / 4; // 1/16 шаг
  }

  /* Текстурный «цвет» станции: Chebyshev-дисторшн для лоу-фая, хорус для
     ретро-синта и шансона, лёгкий драйв для этно-бита, длинный реверб для
     чилл-аута */
  _applyStationColor(st) {
    if (!this._toneAvailable) return;
    const targets = { crush: 0, chorus: 0, dist: 0, reverb: 0.12 };
    if (st.id === 'pyatigorsk') { targets.crush = 0.35; targets.reverb = 0.16; }
    else if (st.id === 'synth') { targets.chorus = 0.55; }
    else if (st.id === 'kavkaz') { targets.dist = 0.18; }
    else if (st.id === 'chanson') { targets.chorus = 0.35; }
    else if (st.id === 'chilled') { targets.reverb = 0.4; }
    this._crush.wet.rampTo(targets.crush, 0.3);
    this._chorus.wet.rampTo(targets.chorus, 0.3);
    this._distDrone.wet.rampTo(targets.dist, 0.3);
    this._reverbSend.gain.rampTo(targets.reverb, 0.3);
  }

  start() {
    if (!this.engine.ready) return;
    if (!this._setup) this._setupGraph();
    if (!this._toneAvailable) return; // без Tone.js играть нечем — статик всё ещё работает
    if (this._running) return;
    this._running = true;
    this._scheduleStep();
  }

  stop() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  /* Собственный планировщик шагов поверх ctx.currentTime — НЕ Tone.Transport.
     Tone.Transport/Tone.Loop в этом окружении переходят в state:'started' и
     Transport.seconds исправно растёт, но сами события планировщика ни разу
     не срабатывают (проверено изолированным тестом); risk признан слишком
     высоким для музыкального слоя, поэтому таймингом занимается тот же
     рекурсивный setTimeout, что был в нативном движке Фазы 1 — а Tone.js
     используется только за инструменты/эффекты, которым точный источник
     времени вызова безразличен. */
  _scheduleStep() {
    if (!this._running) return;
    const st = this.getCurrentStation();
    if (this.musicOn && this.engine.enabled && st.id !== 'off') {
      const now = this.engine.ctx.currentTime + 0.03; // небольшой lookahead
      const step = this._step % 16;
      const step32 = this._step % 32;
      const chordIdx = Math.floor(step / 4) % 4;
      try {
        this._musicStep(now, step, step32, chordIdx, st);
      } catch (e) {
        console.warn('radio step error', e);
      }
    }
    this._step++;
    this._timer = setTimeout(() => this._scheduleStep(), this._stepDuration * 1000);
  }

  setMusicOn(on) {
    this.musicOn = on;
  }

  _setupGraph() {
    this._setup = true;
    if (typeof window.Tone === 'undefined' || window.__toneFailed) {
      this._toneAvailable = false;
      console.warn('Tone.js недоступен — радио будет без звука (статик при переключении по-прежнему работает)');
      return;
    }
    try {
      Tone.setContext(this.engine.ctx); // Tone оборачивает НАШ AudioContext, не создаёт свой
      // clockSource по умолчанию 'worker' в ряде окружений не тикает вовсе;
      // 'timeout' (обычный setInterval) надёжнее — используется как защитная
      // мера, хотя основной тайминг ведёт наш собственный _scheduleStep(),
      // см. комментарий там.
      Tone.getContext().clockSource = 'timeout';
      this._buildToneGraph();
      this._toneAvailable = true;
      this._applyBpm();
      this._applyStationColor(this.getCurrentStation());
    } catch (e) {
      console.warn('Tone.js init error — радио будет без звука', e);
      this._toneAvailable = false;
    }
  }

  _buildToneGraph() {
    const e = this.engine;

    // Шинная цепочка: инструменты -> fadeGain(кроссфейд) -> duckGain(даккинг)
    // -> camGain(дистанция камеры) -> текстурные инсерты -> LP(дистанция) -> нативная шина музыки
    //                                                      \-> reverbSend -> Reverb -> нативная шина музыки (параллельно)
    this._sidechain = new Tone.Gain(1);
    this._fadeGain = new Tone.Gain(1);
    this._duckGain = new Tone.Gain(1);
    this._camGain = new Tone.Gain(1);
    // Chebyshev, а не BitCrusher: BitCrusher реализован через AudioWorkletNode,
    // а его встроенный воркл-процессор регистрируется через Tone.setContext()
    // на ЧУЖОМ (нашем) AudioContext не так, как ожидает нативный конструктор
    // AudioWorkletNode — addAudioWorkletModule() резолвится успешно, но
    // следующий new AudioWorkletNode(...) кидает InvalidStateError (проверено
    // изолированным тестом: тот же код на context, который создаёт сам Tone,
    // не падает; падает только на context, переданном через setContext()).
    // Chebyshev — тот же класс эффектов, но на WaveShaperNode, без воркла —
    // даёт похожую жёсткую лоу-фай текстуру без этой несовместимости.
    this._crush = new Tone.Chebyshev(50); this._crush.wet.value = 0;
    this._chorus = new Tone.Chorus(3, 2.5, 0.4).start(); this._chorus.wet.value = 0;
    this._distDrone = new Tone.Distortion(0.25); this._distDrone.wet.value = 0;
    this._radioLP = new Tone.Filter(6500, 'lowpass');
    this._reverbSend = new Tone.Gain(0.12);
    this._reverb = new Tone.Reverb({ decay: 3.2, preDelay: 0.02, wet: 1 });
    this._reverb.generate().catch(() => {});

    this._sidechain.connect(this._fadeGain);
    this._fadeGain.connect(this._duckGain);
    this._duckGain.connect(this._camGain);
    this._camGain.chain(this._crush, this._chorus, this._distDrone, this._radioLP);
    this._radioLP.connect(e.buses.music);
    this._camGain.connect(this._reverbSend);
    this._reverbSend.connect(this._reverb);
    this._reverb.connect(e.buses.music);

    // Дилэй-сенд для соло (аналог старого echo-эффекта)
    this._leadDelay = new Tone.FeedbackDelay({ delayTime: '16n', feedback: 0.32, wet: 0.5 }).connect(this._sidechain);

    // Инструменты
    this._kick = new Tone.MembraneSynth({
      pitchDecay: 0.05, octaves: 6, envelope: { attack: 0.001, decay: 0.28, sustain: 0 },
    }).connect(this._sidechain);
    this._snare = new Tone.NoiseSynth({
      noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.11, sustain: 0 },
    }).connect(this._sidechain);
    this._clap = new Tone.NoiseSynth({
      noise: { type: 'pink' }, envelope: { attack: 0.001, decay: 0.08, sustain: 0 },
    }).connect(this._sidechain);
    this._hat = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.06, release: 0.01 },
      harmonicity: 5.1, modulationIndex: 20, resonance: 4000, octaves: 1.2,
    }).connect(this._sidechain);
    this._bass = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.1 },
      filterEnvelope: { attack: 0.001, decay: 0.2, sustain: 0, baseFrequency: 550, octaves: -2 },
    }).connect(this._sidechain);
    this._lead = new Tone.Synth({
      oscillator: { type: 'triangle' }, envelope: { attack: 0.02, decay: 0.15, sustain: 0, release: 0.05 },
    });
    this._lead.connect(this._sidechain);
    this._lead.connect(this._leadDelay);
    this._pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' }, envelope: { attack: 0.3, decay: 0.2, sustain: 0.6, release: 0.5 },
      volume: -6,
    }).connect(this._sidechain);

    // Музыкальные шкалы и 16/32-шаговые паттерны (частоты в Гц — те же, что
    // были в нативном секвенсоре; Tone-инструменты принимают Hz напрямую)
    const CHORDS_LOFI = [
      [220.00, 261.63, 329.63, 392.00], [174.61, 220.00, 261.63, 329.63],
      [130.81, 164.81, 196.00, 246.94], [196.00, 246.94, 293.66, 349.23],
    ];
    const BASS_LOFI = [110.00, 87.31, 65.41, 98.00];
    const MELODY_LOFI = [
      329.63, 392.00, 440.00, 523.25, 440.00, 392.00, 329.63, 293.66,
      329.63, 392.00, 440.00, 587.33, 523.25, 440.00, 392.00, 329.63,
    ];

    const CHORDS_SYNTH = [
      [146.83, 174.61, 220.00, 261.63], [116.54, 146.83, 174.61, 220.00],
      [174.61, 220.00, 261.63, 329.63], [130.81, 164.81, 196.00, 246.94],
    ];
    const BASS_SYNTH = [73.42, 58.27, 87.31, 65.41];

    const CHORDS_KAVKAZ = [
      [146.83, 155.56, 185.00, 220.00], [130.81, 146.83, 164.81, 196.00],
      [116.54, 130.81, 146.83, 174.61], [146.83, 185.00, 220.00, 293.66],
    ];
    const BASS_KAVKAZ = [73.42, 65.41, 58.27, 73.42];
    const MELODY_KAVKAZ = [
      293.66, 311.13, 369.99, 392.00, 440.00, 369.99, 311.13, 293.66,
      369.99, 392.00, 440.00, 554.37, 587.33, 554.37, 440.00, 369.99,
    ];

    const CHORDS_CHANSON = [
      [220.00, 261.63, 329.63], [146.83, 174.61, 220.00],
      [164.81, 207.65, 246.94, 293.66], [220.00, 261.63, 329.63],
    ];
    const BASS_CHANSON = [110.00, 73.42, 82.41, 110.00];
    const MELODY_CHANSON = [
      440.00, 523.25, 659.25, 587.33, 523.25, 440.00, 415.30, 440.00,
      523.25, 659.25, 783.99, 659.25, 587.33, 523.25, 440.00, 415.30,
    ];

    const CHORDS_CHILL = [
      [130.81, 164.81, 196.00, 246.94], [110.00, 130.81, 164.81, 196.00],
      [87.31, 110.00, 130.81, 164.81], [98.00, 123.47, 146.83, 174.61],
    ];
    const BASS_CHILL = [65.41, 55.00, 43.65, 49.00];

    const duckSidechain = (t) => {
      this._sidechain.gain.cancelScheduledValues(t);
      this._sidechain.gain.setValueAtTime(0.35, t);
      this._sidechain.gain.exponentialRampToValueAtTime(1.0, t + 0.22);
    };
    const playKick = (t) => { this._kick.triggerAttackRelease('C1', 0.14, t, 0.9); duckSidechain(t); };
    const playSnare = (t) => this._snare.triggerAttackRelease(0.12, t, 0.55);
    const playClap = (t) => { this._clap.triggerAttackRelease(0.08, t, 0.4); this._clap.triggerAttackRelease(0.08, t + 0.015, 0.4); };
    const playHat = (t, open = false) => this._hat.triggerAttackRelease(open ? 0.14 : 0.035, t, open ? 0.35 : 0.2);
    const playBassNote = (t, freq, dur = 0.25) => this._bass.triggerAttackRelease(freq, dur, t, 0.85);
    const playLeadNote = (t, freq, dur = 0.2) => this._lead.triggerAttackRelease(freq, dur, t, 0.55);
    const playPadChord = (t, freqs, dur = 1.0) => this._pad.triggerAttackRelease(freqs, dur, t, 0.4);

    this._musicStep = (now, step, step32, chordIdx, st) => {
      if (st.id === 'pyatigorsk') {
        if (step === 0 || step === 10) playKick(now);
        if (step === 4 || step === 12) playSnare(now);
        if (step === 14) playClap(now);
        if (step % 2 === 0) playHat(now, step === 6 || step === 14);
        if (step % 4 === 0 || step === 6 || step === 14) playBassNote(now, BASS_LOFI[chordIdx], 0.26);
        if (step % 4 === 0) playPadChord(now, CHORDS_LOFI[chordIdx], 0.9);
        if (step === 2 || step === 7 || step === 11 || step === 15) {
          playLeadNote(now, MELODY_LOFI[step32 % MELODY_LOFI.length], 0.22);
        }
      } else if (st.id === 'synth') {
        if (step % 4 === 0) playKick(now);
        if (step === 4 || step === 12) playSnare(now);
        if (step % 4 === 2) playHat(now, true);
        if (step % 2 === 0) playHat(now, false);
        playBassNote(now, BASS_SYNTH[chordIdx], 0.12);
        if (step === 0 || step === 8) playPadChord(now, CHORDS_SYNTH[chordIdx], 1.6);
        const arp = CHORDS_SYNTH[chordIdx];
        playLeadNote(now, arp[step % arp.length] * 2, 0.14);
      } else if (st.id === 'kavkaz') {
        if (step === 0 || step === 3 || step === 6 || step === 8 || step === 11 || step === 14) playKick(now);
        if (step === 4 || step === 12) playSnare(now);
        if (step === 7 || step === 15) playClap(now);
        if (step % 2 === 1) playHat(now, step === 15);
        if (step === 0 || step === 6 || step === 8 || step === 14) playBassNote(now, BASS_KAVKAZ[chordIdx], 0.2);
        if (step % 2 === 0) playLeadNote(now, MELODY_KAVKAZ[step32 % MELODY_KAVKAZ.length], 0.18);
      } else if (st.id === 'chanson') {
        if (step === 0 || step === 8) playKick(now);
        if (step === 4 || step === 12) playClap(now);
        if (step % 2 === 0) playHat(now, false);
        if (step === 0 || step === 8) playBassNote(now, BASS_CHANSON[chordIdx], 0.35);
        if (step % 4 === 2) playPadChord(now, CHORDS_CHANSON[chordIdx], 0.18);
        if (step % 2 === 0) playLeadNote(now, MELODY_CHANSON[step32 % MELODY_CHANSON.length], 0.22);
      } else if (st.id === 'chilled') {
        const skipKick = this._night; // после 23:00/ночью — без бочки, только пэд и бас
        if (step === 0 && !skipKick) playKick(now);
        if (step === 8) playSnare(now);
        if (step % 4 === 2) playHat(now, true);
        if (step === 0 || step === 8) playBassNote(now, BASS_CHILL[chordIdx], 0.65);
        if (step === 0) playPadChord(now, CHORDS_CHILL[chordIdx], 3.6);
      }
    };

    this._step = 0;
  }
}

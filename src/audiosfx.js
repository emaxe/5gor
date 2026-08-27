/* Библиотека одноразовых звуковых эффектов поверх AudioEngine. */

export class SfxLibrary {
  constructor(engine) {
    this.engine = engine;
  }

  get _c() { return this.engine.ctx; }
  get _enabled() { return this.engine.enabled; }

  // --- Сочные и реалистичные автомобильные гудки с 3D-позиционированием ---
  horn(opts = {}) {
    const e = this.engine;
    if (!e.enabled || !e.ctx) return;

    let vol = 1.0;
    let panVal = 0;

    if (opts.sourceX !== undefined && opts.sourceZ !== undefined && opts.playerX !== undefined && opts.playerZ !== undefined) {
      const dx = opts.sourceX - opts.playerX;
      const dz = opts.sourceZ - opts.playerZ;
      const dist = Math.hypot(dx, dz);
      const maxDist = 90; // Гудок слышен на расстоянии до 90 метров
      if (dist > maxDist) return;
      if (!e.alloc('horn')) return; // трафик может сигналить пачками — бюджет + кулдаун

      const att = Math.pow(1 - dist / maxDist, 1.2);
      vol = Math.min(1.0, Math.max(0.08, att * 0.95));

      const angleToSource = Math.atan2(dx, dz);
      const relAngle = angleToSource - (opts.playerHeading || 0);
      panVal = Math.min(0.85, Math.max(-0.85, Math.sin(relAngle)));
    } else if (!e.alloc('horn')) {
      return;
    }

    const c = e.ctx;
    const t = c.currentTime;
    const type = opts.type || (Math.random() < 0.35 ? 'sedan' : Math.random() < 0.7 ? 'classic' : Math.random() < 0.88 ? 'suv' : 'truck');
    const dur = opts.dur || (type === 'player' ? 0.65 : type === 'truck' ? 0.6 : 0.45);
    const destNode = e.takePanner('sfx', panVal, t);
    e.releaseAfter('horn', dur * 1000 + 60);

    if (type === 'player') {
      const f1 = 293.66, f2 = 369.99; // D4 + F#4
      e.tone(f1, dur, 'sawtooth', vol * 0.16, 0, null, destNode);
      e.tone(f2, dur, 'sawtooth', vol * 0.14, 0, null, destNode);
      e.tone(f1 * 0.5, dur, 'sine', vol * 0.22, 0, null, destNode);
      e.tone(f1 * 0.25, dur, 'sine', vol * 0.15, 0, null, destNode);
    } else if (type === 'truck') {
      const f1 = 185, f2 = 233;
      e.tone(f1, dur, 'sawtooth', vol * 0.18, 0, null, destNode);
      e.tone(f2, dur, 'sawtooth', vol * 0.15, 0, null, destNode);
      e.tone(f1 * 0.5, dur, 'sine', vol * 0.22, 0, null, destNode);
    } else if (type === 'suv') {
      const f1 = 330, f2 = 415;
      e.tone(f1, dur, 'sawtooth', vol * 0.14, 0, null, destNode);
      e.tone(f2, dur, 'square', vol * 0.12, 0, null, destNode);
      e.tone(f1 * 0.5, dur, 'sine', vol * 0.15, 0, null, destNode);
    } else if (type === 'classic') {
      const f1 = 370, f2 = 293.66;
      e.tone(f1, dur, 'sawtooth', vol * 0.14, 0, null, destNode);
      e.tone(f2, dur, 'sawtooth', vol * 0.14, 0, null, destNode);
      e.tone(f2 * 0.5, dur, 'sine', vol * 0.12, 0, null, destNode);
    } else {
      const f1 = 415, f2 = 330;
      e.tone(f1, dur, 'sawtooth', vol * 0.13, 0, null, destNode);
      e.tone(f2, dur, 'square', vol * 0.11, 0, null, destNode);
      e.tone(f2 * 0.5, dur, 'sine', vol * 0.10, 0, null, destNode);
    }
  }

  crash(impact) {
    const e = this.engine;
    if (!e.enabled || !e.alloc('crash')) return;
    e.releaseAfter('crash', 700);
    const k = Math.min(1, Math.max(0, impact / 30));
    e.noiseBurst(0.3 + k * 0.3, 0.4 + k * 0.4, 350 + k * 800);
    e.tone(70, 0.4, 'sine', 0.35 + k * 0.25, 0, 35);
    e.tone(160, 0.25, 'sawtooth', 0.15 + k * 0.15, 0, 50);
  }

  cash(amount) {
    const e = this.engine;
    if (!e.enabled) return;
    const n = Math.min(6, Math.max(2, 1 + Math.floor(Math.abs(amount || 0) / 120)));
    for (let i = 0; i < n; i++) {
      e.tone(1046.5 + i * 180, 0.1, 'triangle', 0.14, i * 0.09, 1318.5);
    }
  }

  pickup() {
    const e = this.engine;
    if (!e.enabled) return;
    e.tone(523.25, 0.09, 'sine', 0.16);
    e.tone(659.25, 0.12, 'triangle', 0.18, 0.08);
    e.tone(783.99, 0.16, 'sine', 0.15, 0.16);
  }

  speak() {
    const e = this.engine;
    if (!e.enabled) return;
    e.tone(480, 0.07, 'sine', 0.1);
    e.tone(640, 0.1, 'sine', 0.09, 0.05);
  }

  fail() {
    const e = this.engine;
    if (!e.enabled) return;
    e.tone(293.66, 0.22, 'sawtooth', 0.12, 0, 220);
    e.tone(220.00, 0.35, 'sawtooth', 0.12, 0.18, 140);
  }

  pedHit() {
    const e = this.engine;
    if (!e.enabled || !e.alloc('ped', 'pedHit')) return;
    e.releaseAfter('ped', 500);
    e.noiseBurst(0.35, 0.4, 450);
    e.tone(130, 0.35, 'sine', 0.25, 0, 60);
  }

  thud() {
    const e = this.engine;
    if (!e.enabled || !e.alloc('ped', 'thud')) return;
    e.releaseAfter('ped', 300);
    e.noiseBurst(0.2, 0.4, 300);
    e.tone(90, 0.2, 'sine', 0.3, 0, 40);
  }

  /* Двигатель глохнет: рык вниз + пара «чихов» */
  stall() {
    const e = this.engine;
    if (!e.enabled) return;
    e.tone(110, 0.5, 'sawtooth', 0.14, 0, 35);
    for (let i = 0; i < 3; i++) {
      e.noiseBurst(0.06, 0.12, 900, 0.05 + i * 0.13);
    }
  }

  click() {
    const e = this.engine;
    if (!e.enabled || !e.alloc('click')) return;
    e.releaseAfter('click', 100);
    e.tone(587.33, 0.05, 'triangle', 0.09, 0, null, e.buses.ui);
  }

  /* Заправка: гул насоса + щелчок пистолета в конце */
  refuel() {
    const e = this.engine;
    if (!e.enabled) return;
    e.noiseBurst(2.6, 0.05, 300);
    e.tone(261.63, 0.15, 'sawtooth', 0.07, 2.5, 880);
    e.tone(1400, 0.05, 'triangle', 0.08, 2.75);
  }

  bird() {
    const e = this.engine;
    if (!e.enabled) return;
    const f = 1900 + Math.random() * 1200;
    e.tone(f, 0.08, 'sine', 0.03, 0, null, e.buses.ambient);
    e.tone(f * 0.88, 0.07, 'sine', 0.025, 0.09, null, e.buses.ambient);
  }

  raceGo() {
    const e = this.engine;
    if (!e.enabled) return;
    e.tone(523.25, 0.14, 'square', 0.12);
    e.tone(659.25, 0.14, 'square', 0.12, 0.18);
    e.tone(783.99, 0.28, 'square', 0.14, 0.36);
  }

  /* Столкновение с краем карты — глухой удар о невидимую стену */
  edgeBump() {
    const e = this.engine;
    if (!e.enabled) return;
    e.noiseBurst(0.15, 0.25, 500);
    e.tone(70, 0.15, 'sine', 0.2);
  }

  /* Опасное сближение (near-miss) — короткий свист воздуха (Doppler whoosh) */
  nearMiss() {
    const e = this.engine;
    if (!e.enabled) return;
    e.noiseBurst(0.14, 0.2, 800);             // шумовой свист воздуха
    e.tone(550, 0.14, 'sine', 0.12, 0, 280);    // нисходящий питч 550→280 Гц
  }

  /* Побег от полиции — триумфальный восходящий arpeggio + лёгкий шум «улитки» */
  policeEscape(level = 1) {
    const e = this.engine;
    if (!e.enabled) return;
    const g = 0.14 + level * 0.03;
    const base = 440 + level * 60;               // 500 / 560 / 620 Гц
    // Восходящее arpeggio — «мы вырвались!»
    e.tone(base, 0.10, 'triangle', g, 0, base * 1.3);
    e.tone(base * 1.25, 0.10, 'triangle', g * 0.9, 0.06, base * 1.5);
    e.tone(base * 1.5, 0.14, 'sine', g * 0.85, 0.12, base * 1.7);
    if (level >= 3) {
      e.tone(base * 2, 0.16, 'sawtooth', g * 0.5, 0.18, base * 1.9);
    }
    // Короткий нисходящий «свист сливающейся сирены» — полиция осталась позади
    e.noiseBurst(0.12, g * 0.4, 1200, 0);
  }

  /* Достижение порога серии сближений — восходящий аккорд, громче и выше с уровнем */
  nearMissStreak(level = 1) {
    const e = this.engine;
    if (!e.enabled) return;
    const g = 0.14 + level * 0.03;
    const baseFreq = 520 + level * 160;           // 680 / 840 / 1000 Гц по уровню
    e.noiseBurst(0.16, g, 900 + level * 250);     // свист воздуха с более широким фильтром
    e.tone(baseFreq, 0.15, 'triangle', g, 0, baseFreq * 0.7);
    e.tone(baseFreq * 1.5, 0.12, 'sine', g * 0.85, 0.04, baseFreq * 1.1);
    if (level >= 3) {
      e.tone(baseFreq * 2, 0.18, 'sawtooth', g * 0.6, 0.08, baseFreq * 1.3);
    }
  }

  /* Milestone серии заказов — восходящий arpeggio (3 ноты, тем выше чем больше уровень) */
  comboMilestone(level = 1) {
    const e = this.engine;
    if (!e.enabled) return;
    const g = 0.12 + level * 0.03;
    const base = 440 + level * 80;               // 520 / 600 / 680 Гц
    e.tone(base, 0.10, 'triangle', g, 0, base * 1.2);
    e.tone(base * 1.25, 0.10, 'triangle', g * 0.9, 0.06, base * 1.4);
    e.tone(base * 1.5, 0.14, 'sine', g * 0.85, 0.12, base * 1.6);
    if (level >= 3) {
      e.tone(base * 2, 0.16, 'sawtooth', g * 0.5, 0.18, base * 1.8);
    }
  }

  /* Закрытие двери — щелчок + удар + короткий резонанс кузова (посадка) */
  doorClose() {
    const e = this.engine;
    if (!e.enabled) return;
    e.noiseBurst(0.02, 0.15, 3000);
    e.tone(130, 0.12, 'sine', 0.2, 0.01, 80);
    e.tone(220, 0.08, 'triangle', 0.08, 0.02);
  }

  /* Открытие двери — скрип + защёлка (высадка) */
  doorOpen() {
    const e = this.engine;
    if (!e.enabled) return;
    e.tone(190, 0.25, 'sawtooth', 0.06, 0, 110);
    e.noiseBurst(0.03, 0.08, 2000, 0.24);
  }

  /* Запуск двигателя — стартер + «схват» и стабилизация оборотов */
  engineStart() {
    const e = this.engine;
    if (!e.enabled) return;
    e.noiseBurst(0.5, 0.08, 500);
    e.tone(42, 0.5, 'square', 0.1, 0, 50);
    e.tone(48, 0.25, 'sawtooth', 0.12, 0.55, 46);
  }

  /* Ручник — трещотка из 4 щелчков */
  handbrake() {
    const e = this.engine;
    if (!e.enabled) return;
    for (let i = 0; i < 4; i++) e.noiseBurst(0.02, 0.08, 3500, i * 0.032);
  }

  spatialSpeak(sourceX, sourceZ, playerX, playerZ, type = 'shout', playerHeading = 0) {
    const e = this.engine;
    if (!e.enabled || !e.ctx) return;

    let vol = 1.0;
    let panVal = 0;

    if (sourceX !== null && sourceX !== undefined && sourceZ !== null && sourceZ !== undefined && playerX !== undefined && playerZ !== undefined) {
      const dx = sourceX - playerX;
      const dz = sourceZ - playerZ;
      const dist = Math.hypot(dx, dz);
      const maxDist = 55;
      if (dist > maxDist) return;
      if (!e.alloc('voice')) return;

      const att = Math.pow(1 - dist / maxDist, 1.6);
      vol = Math.min(1.0, Math.max(0.01, att * 0.85));

      const angleToSource = Math.atan2(dx, dz);
      const relAngle = angleToSource - (playerHeading || 0);
      panVal = Math.min(0.85, Math.max(-0.85, Math.sin(relAngle)));
    } else if (!e.alloc('voice')) {
      return;
    }

    const c = e.ctx;
    const t = c.currentTime;
    const destNode = e.takePanner('voice', panVal, t);
    e.releaseAfter('voice', 450);

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

  /* Стингер смены дня/ночи — короткий мотив из 3 нот */
  dayNightChime() {
    const e = this.engine;
    if (!e.enabled) return;
    e.tone(392.0, 0.3, 'sine', 0.05, 0, null, e.buses.ambient);
    e.tone(493.88, 0.3, 'sine', 0.05, 0.22, null, e.buses.ambient);
    e.tone(587.33, 0.5, 'sine', 0.06, 0.44, null, e.buses.ambient);
  }

  /* Гром в дождь — низкий шумовой раскат с суб-басом, идёт в реверб через sfx-шину */
  thunder() {
    const e = this.engine;
    if (!e.enabled || !e.alloc('crash')) return; // делим бюджет с crash — оба редкие и громкие
    e.releaseAfter('crash', 1000);
    e.noiseBurst(0.9, 0.22, 400);
    e.tone(38, 0.9, 'sine', 0.18, 0, 30);
  }

  /* Итог смены — тёплый спускающийся стингер на 4 ноты */
  shiftEnd() {
    const e = this.engine;
    if (!e.enabled) return;
    e.tone(659.25, 0.16, 'sine', 0.12, 0);
    e.tone(587.33, 0.16, 'sine', 0.12, 0.15);
    e.tone(523.25, 0.16, 'sine', 0.12, 0.3);
    e.tone(392.0, 0.35, 'sine', 0.14, 0.45);
  }

  /* Тикание на исходе таймера срочного заказа — тон растёт по мере убывания */
  orderTimerBeep(left) {
    const e = this.engine;
    if (!e.enabled) return;
    const freq = 660 + (10 - Math.max(0, Math.min(10, left))) * 33;
    e.tone(freq, 0.1, 'sine', 0.07, 0, null, e.buses.ui);
  }

  /* Сирена спецтранспорта — полицейская «крякалка» (короткие тон-импульсы)
     или двухтоновый вой для скорой. 3D-позиционирование (как horn). */
  siren(opts = {}) {
    const e = this.engine;
    if (!e.enabled || !e.ctx) return;
    if (!e.alloc('siren')) return;

    let vol = 1.0, panVal = 0;
    if (opts.sourceX !== undefined && opts.playerX !== undefined) {
      const dx = opts.sourceX - opts.playerX, dz = opts.sourceZ - opts.playerZ;
      const dist = Math.hypot(dx, dz);
      const maxDist = 120;
      if (dist > maxDist) { e.free('siren'); return; }
      vol = Math.min(1, Math.max(0.1, Math.pow(1 - dist / maxDist, 1.1)));
      const rel = Math.atan2(dx, dz) - (opts.playerHeading || 0);
      panVal = Math.min(0.85, Math.max(-0.85, Math.sin(rel)));
    }

    const c = e.ctx;
    const t = c.currentTime;
    const type = opts.type === 'ambulance' ? 'ambulance' : 'police';
    const destNode = e.takePanner('sfx', panVal, t);

    if (type === 'police') {
      // «Крякалка»: 4 коротких импульса (вик-вик-вик-вик), ~0.7 сек
      const blipDur = 0.12, gap = 0.05;
      const lo = 680, hi = 960;
      for (let i = 0; i < 4; i++) {
        const tt = t + i * (blipDur + gap);
        const o = c.createOscillator(); o.type = 'square';
        o.frequency.setValueAtTime(hi, tt);
        o.frequency.linearRampToValueAtTime(lo, tt + blipDur * 0.7);
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, tt);
        g.gain.linearRampToValueAtTime(vol * 0.11, tt + 0.01);
        g.gain.linearRampToValueAtTime(0.0001, tt + blipDur);
        o.connect(g); g.connect(destNode);
        o.start(tt); o.stop(tt + blipDur + 0.02);
      }
      e.releaseAfter('siren', 800);
    } else {
      // Скорая: двухтоновый вой (как было)
      const dur = 1.4;
      e.releaseAfter('siren', dur * 1000 + 100);
      const o = c.createOscillator(); o.type = 'sine';
      const lfoRate = 3.2, lo = 550, hi = 950;
      const steps = Math.round(dur * lfoRate * 2);
      for (let i = 0; i <= steps; i++) {
        const tt = t + (i / steps) * dur;
        o.frequency.linearRampToValueAtTime(i % 2 === 0 ? hi : lo, tt);
      }
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol * 0.09, t + 0.1);
      g.gain.setValueAtTime(vol * 0.09, t + dur - 0.15);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(destNode);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }

  /* Фанфар достижения — восходящий мажорный арпеджио (C-E-G-C) */
  achievementFanfare() {
    const e = this.engine;
    if (!e.enabled) return;
    const notes = [261.63, 329.63, 392.0, 523.25];
    for (let i = 0; i < notes.length; i++) {
      e.tone(notes[i], 0.18, 'sine', 0.13, i * 0.12);
      e.tone(notes[i] * 0.5, 0.18, 'triangle', 0.07, i * 0.12);
    }
    e.tone(523.25, 0.4, 'sine', 0.1, notes.length * 0.12);
  }

  /* Шаг ближайшего пешехода — короткий приглушённый шумовой тук */
  footstep(pan = 0, vol = 1) {
    const e = this.engine;
    if (!e.enabled || !e.alloc('voice', 'step')) return;
    e.releaseAfter('voice', 100);
    const t = e.ctx.currentTime;
    const destNode = e.takePanner('voice', pan, t);
    e.noiseBurst(0.05, 0.05 * vol, 220, 0, destNode);
  }
}

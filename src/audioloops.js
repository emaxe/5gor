/* Непрерывные звуковые слои: двигатель, скрип шин, качение шин, ветер,
   скрип тормозов, дребезг от урона, городской эмбиент (ветер-эмбиент +
   птицы), дождь. Каждый слой строится один раз в build() и дальше только
   модулируется через update*()/set*() — без пересоздания узлов. */

/* Тембр двигателя на машину (config.js CARS[].base.carType): базовая частота
   и микс осцилляторов _buildEngine() — дёшево, но даёт 7 разных «характеров»
   вместо одного звука на все машины. */
const LOOP_ENGINE_PROFILES = {
  taxi: { base: 46, mixSquare: 0.5, mixTri: 0.18 },       // «Пятёрочка» — тарахтит
  classic: { base: 45, mixSquare: 0.55, mixTri: 0.15 },   // «Классика» 2107 — ещё грубее
  comfort: { base: 50, mixSquare: 0.35, mixTri: 0.25 },   // сбалансированный
  minivan: { base: 44, mixSquare: 0.3, mixTri: 0.32 },    // низкий, ровный гул
  business: { base: 58, mixSquare: 0.22, mixTri: 0.35 },  // премиум — ровнее, выше
  sport: { base: 62, mixSquare: 0.15, mixTri: 0.12 },     // высокий, чистый
  offroad: { base: 50, mixSquare: 0.4, mixTri: 0.28 },    // тяговитый, грубый
};

export class LoopLayer {
  constructor(engine) {
    this.engine = engine;
    this.engineNodes = null;
    this.skidNodes = null;
    this.tyreNodes = null;
    this.windNodes = null;
    this.brakeNodes = null;
    this.damageNodes = null;
    this.ambNodes = null;
    this.rainNodes = null;
    this._birdTimer = null;
    this._paused = false;
    this._engineBase = 48;
    this._gravelNext = 0;
    this._nextClank = 0;
    this._nextBump = 0;
    this._fuelWarnNext = 0;
    this._lastGroundY = undefined;
    /* Колбэк озвучки птицы — прокидывается фасадом AudioManager, чтобы
       LoopLayer не знал о SfxLibrary напрямую */
    this.playBird = null;
  }

  build() {
    this._buildEngine();
    this._buildSkid();
    this._buildTyre();
    this._buildWind();
    this._buildBrake();
    this._buildDamage();
    this._buildAmbient();
  }

  /* --- Двигатель: 3 осциллятора с саб-басом, фильтрацией и рыком --- */
  _buildEngine() {
    const c = this.engine.ctx;
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
    g.connect(this.engine.buses.engine);

    o1.start(); o2.start(); o3.start();
    this.engineNodes = { o1, o2, o3, g2, g3, flt, g };
  }

  /* Профиль тембра под конкретную машину (вызывается при смене carType) */
  setEngineProfile(carType) {
    const p = LOOP_ENGINE_PROFILES[carType] || LOOP_ENGINE_PROFILES.taxi;
    this._engineBase = p.base;
    if (this.engineNodes) {
      const c = this.engine.ctx;
      this.engineNodes.g2.gain.setTargetAtTime(p.mixSquare, c.currentTime, 0.3);
      this.engineNodes.g3.gain.setTargetAtTime(p.mixTri, c.currentTime, 0.3);
    }
  }

  /* Скрип шин при заносе — полосовой фильтр с модулированным шумом */
  _buildSkid() {
    const c = this.engine.ctx;
    const src = c.createBufferSource(); src.buffer = this.engine._noise(2); src.loop = true;
    const flt = c.createBiquadFilter(); flt.type = 'bandpass'; flt.frequency.value = 950; flt.Q.value = 2.0;
    const g = c.createGain(); g.gain.value = 0;
    src.connect(flt); flt.connect(g); g.connect(this.engine.buses.sfx);
    src.start();
    this.skidNodes = { flt, g };
  }

  /* Качение шин по асфальту/бездорожью — постоянный слой, раньше между
     холостым двигателем и визгом покрышек была полная тишина */
  _buildTyre() {
    const c = this.engine.ctx;
    const src = c.createBufferSource(); src.buffer = this.engine._noise(2); src.loop = true;
    const flt = c.createBiquadFilter(); flt.type = 'bandpass'; flt.frequency.value = 400; flt.Q.value = 0.7;
    const flt2 = c.createBiquadFilter(); flt2.type = 'bandpass'; flt2.frequency.value = 1400; flt2.Q.value = 1.2;
    const g = c.createGain(); g.gain.value = 0;
    const g2 = c.createGain(); g2.gain.value = 0; // добавка для бездорожья
    src.connect(flt); flt.connect(g); g.connect(this.engine.buses.engine);
    src.connect(flt2); flt2.connect(g2); g2.connect(this.engine.buses.engine);
    src.start();
    this.tyreNodes = { flt, g, g2 };
  }

  updateTyre(speed, onRoad) {
    if (!this.tyreNodes) return;
    const c = this.engine.ctx;
    const spd = Math.abs(speed || 0);
    if (this.engine.enabled && spd > 0.5) {
      const roadGain = Math.min(0.09, spd * 0.006);
      this.tyreNodes.flt.frequency.setTargetAtTime(250 + spd * 30, c.currentTime, 0.1);
      this.tyreNodes.g.gain.setTargetAtTime(onRoad ? roadGain : roadGain * 0.4, c.currentTime, 0.1);
      this.tyreNodes.g2.gain.setTargetAtTime(onRoad ? 0 : roadGain * 0.8, c.currentTime, 0.1);
      if (!onRoad && spd > 2) {
        const now = c.currentTime;
        if (now >= this._gravelNext) {
          this._gravelNext = now + 0.08 + Math.random() * 0.12;
          this.engine.noiseBurst(0.04, 0.05, 2500, 0, this.engine.buses.engine);
        }
      }
    } else {
      this.tyreNodes.g.gain.setTargetAtTime(0, c.currentTime, 0.15);
      this.tyreNodes.g2.gain.setTargetAtTime(0, c.currentTime, 0.15);
    }
  }

  /* Ветер — растёт с квадратом скорости, даёт ощущение скорости лучше,
     чем один только рост тона двигателя */
  _buildWind() {
    const c = this.engine.ctx;
    const src = c.createBufferSource(); src.buffer = this.engine._noise(2); src.loop = true;
    const flt = c.createBiquadFilter(); flt.type = 'highpass'; flt.frequency.value = 380;
    const g = c.createGain(); g.gain.value = 0;
    src.connect(flt); flt.connect(g); g.connect(this.engine.buses.ambient);
    src.start();
    this.windNodes = { flt, g };
  }

  updateWind(speed, maxSpeed) {
    if (!this.windNodes) return;
    const c = this.engine.ctx;
    const spd = Math.abs(speed || 0);
    const t = Math.min(1, spd / Math.max(1, maxSpeed || 40));
    if (this.engine.enabled) {
      this.windNodes.flt.frequency.setTargetAtTime(380 + spd * 35, c.currentTime, 0.15);
      this.windNodes.g.gain.setTargetAtTime(t * t * 0.11, c.currentTime, 0.15);
    } else {
      this.windNodes.g.gain.setTargetAtTime(0, c.currentTime, 0.15);
    }
  }

  /* Скрип тормозов — резонансный полосовой шум + тон, атака 80мс чтобы не щёлкало */
  _buildBrake() {
    const c = this.engine.ctx;
    const src = c.createBufferSource(); src.buffer = this.engine._noise(1); src.loop = true;
    const flt = c.createBiquadFilter(); flt.type = 'bandpass'; flt.frequency.value = 2400; flt.Q.value = 9;
    const g = c.createGain(); g.gain.value = 0;
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = 1650;
    const og = c.createGain(); og.gain.value = 0;
    src.connect(flt); flt.connect(g); g.connect(this.engine.buses.engine);
    o.connect(og); og.connect(this.engine.buses.engine);
    o.start(); src.start();
    this.brakeNodes = { g, og };
  }

  updateBrake(brake, speed) {
    if (!this.brakeNodes) return;
    const c = this.engine.ctx;
    const spd = Math.abs(speed || 0);
    const active = this.engine.enabled && brake > 0.5 && spd > 4;
    const amt = active ? Math.min(1, spd / 12) * ((brake - 0.5) * 2) : 0;
    const tau = active ? 0.08 : 0.12;
    this.brakeNodes.g.gain.setTargetAtTime(active ? amt * 0.1 : 0, c.currentTime, tau);
    this.brakeNodes.og.gain.setTargetAtTime(active ? amt * 0.05 : 0, c.currentTime, tau);
  }

  /* Дребезг кузова при сильном повреждении — AM на квадратной волне через
     полосовой фильтр + редкий металлический лязг при damage > 80 */
  _buildDamage() {
    const c = this.engine.ctx;
    const o = c.createOscillator(); o.type = 'square'; o.frequency.value = 62;
    const lfo = c.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 8.5;
    const lfoGain = c.createGain(); lfoGain.gain.value = 0.5;
    const carrierGain = c.createGain(); carrierGain.gain.value = 0.5;
    lfo.connect(lfoGain); lfoGain.connect(carrierGain.gain);
    const flt = c.createBiquadFilter(); flt.type = 'bandpass'; flt.frequency.value = 900; flt.Q.value = 3;
    const g = c.createGain(); g.gain.value = 0;
    o.connect(carrierGain); carrierGain.connect(flt); flt.connect(g); g.connect(this.engine.buses.engine);
    o.start(); lfo.start();
    this.damageNodes = { g };
  }

  updateDamageRattle(damage, speed) {
    if (!this.damageNodes) return;
    const c = this.engine.ctx;
    const spd = Math.abs(speed || 0);
    if (this.engine.enabled && damage > 50 && spd > 1) {
      const amt = ((damage - 50) / 50) * Math.min(1, spd / 8);
      this.damageNodes.g.gain.setTargetAtTime(amt * 0.06, c.currentTime, 0.2);
      if (damage > 80) {
        const now = c.currentTime;
        if (now >= this._nextClank) {
          this._nextClank = now + 3 + Math.random() * 5;
          this.engine.noiseBurst(0.08, 0.12, 1800, 0, this.engine.buses.engine);
        }
      }
    } else {
      this.damageNodes.g.gain.setTargetAtTime(0, c.currentTime, 0.2);
    }
  }

  /* Предупреждающий бип на низком топливе — раз в 8с при <12%, раз в 3с при <5% */
  updateFuelWarning(fuelFrac) {
    if (fuelFrac === undefined || !this.engine.ctx || !this.engine.enabled) return;
    const now = this.engine.ctx.currentTime;
    const interval = fuelFrac < 0.05 ? 3 : fuelFrac < 0.12 ? 8 : 0;
    if (!interval) { this._fuelWarnNext = 0; return; }
    if (!this._fuelWarnNext || now >= this._fuelWarnNext) {
      this._fuelWarnNext = now + interval;
      this.engine.tone(880, 0.12, 'sine', 0.06, 0, null, this.engine.buses.ui);
    }
  }

  /* Кочки/подвеска — реагирует на резкий скачок groundY между кадрами */
  updateSuspension(groundY) {
    if (groundY === undefined || !this.engine.ctx) return;
    const c = this.engine.ctx;
    if (this._lastGroundY !== undefined) {
      const dy = Math.abs(groundY - this._lastGroundY);
      const now = c.currentTime;
      if (this.engine.enabled && dy > 0.12 && now >= this._nextBump) {
        this._nextBump = now + 0.2;
        this.engine.noiseBurst(0.1, 0.15, 400, 0, this.engine.buses.engine);
        this.engine.tone(95, 0.18, 'sine', 0.12, 0, 55, this.engine.buses.engine);
      }
    }
    this._lastGroundY = groundY;
  }

  /* Городской эмбиент: шелест ветра-эмбиента + птицы */
  _buildAmbient() {
    const c = this.engine.ctx;
    const src = c.createBufferSource(); src.buffer = this.engine._noise(3); src.loop = true;
    const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 350;
    const g = c.createGain(); g.gain.value = 0.04;
    src.connect(flt); flt.connect(g); g.connect(this.engine.buses.ambient);
    src.start();
    this.ambNodes = { flt, g };
    this._birdTimer = setInterval(() => {
      if (this.engine.enabled && !this._paused && Math.random() < 0.6 && this.playBird) this.playBird();
    }, 6500);
  }

  /* Дождь — создаётся лениво при первом включении погоды */
  setRain(on) {
    const c = this.engine.ctx;
    if (!c) return;
    if (on && !this.rainNodes) {
      const src = c.createBufferSource(); src.buffer = this.engine._noise(2); src.loop = true;
      const flt = c.createBiquadFilter(); flt.type = 'highpass'; flt.frequency.value = 1100;
      const g = c.createGain(); g.gain.value = 0;
      src.connect(flt); flt.connect(g); g.connect(this.engine.buses.ambient);
      src.start();
      this.rainNodes = { flt, g };
    }
    if (this.rainNodes) this.rainNodes.g.gain.setTargetAtTime(on ? 0.06 : 0, c.currentTime, 0.6);
  }

  updateEngine(rpm, throttle, running) {
    if (!this.engineNodes) return;
    const c = this.engine.ctx;
    const { o1, o2, o3, flt, g } = this.engineNodes;
    if (this.engine.enabled && running) {
      const baseFreq = this._engineBase + rpm * 140;
      o1.frequency.setTargetAtTime(baseFreq, c.currentTime, 0.04);
      o2.frequency.setTargetAtTime(baseFreq * 0.5, c.currentTime, 0.04);
      o3.frequency.setTargetAtTime(baseFreq * 1.5, c.currentTime, 0.04);

      flt.frequency.setTargetAtTime(300 + rpm * 900 + throttle * 350, c.currentTime, 0.06);
      g.gain.setTargetAtTime(0.06 + throttle * 0.12 + rpm * 0.05, c.currentTime, 0.08);
    } else {
      g.gain.setTargetAtTime(0, c.currentTime, 0.1);
    }
  }

  updateSkid(intensity) {
    if (!this.skidNodes) return;
    const c = this.engine.ctx;
    const { flt, g } = this.skidNodes;
    if (this.engine.enabled && intensity > 0.02) {
      flt.frequency.setTargetAtTime(700 + intensity * 950, c.currentTime, 0.04);
      g.gain.setTargetAtTime(0.08 * intensity, c.currentTime, 0.04);
    } else {
      g.gain.setTargetAtTime(0, c.currentTime, 0.05);
    }
  }

  setPaused(paused) {
    this._paused = paused;
    if (paused) {
      this.updateEngine(0, 0, false);
      this.updateSkid(0);
      this.updateTyre(0, true);
      this.updateWind(0, 1);
      this.updateBrake(0, 0);
      this.updateDamageRattle(0, 0);
    }
  }

  dispose() {
    if (this._birdTimer) { clearInterval(this._birdTimer); this._birdTimer = null; }
  }
}

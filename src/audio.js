import { Events } from './eventbus.js';
import { AudioEngine } from './audiocore.js';
import { SfxLibrary } from './audiosfx.js';
import { LoopLayer } from './audioloops.js';
import { RadioEngine } from './audiomusic.js';

/* Фасад звуковой системы: владеет ядром (шины/лимитер/реверб/пулинг),
   библиотекой одноразовых эффектов, непрерывными слоями и радио. Держит
   ВСЕ подписки на EventBus — единственный источник истины для звуковых
   триггеров, порождённых симуляцией мира (см. docs/plans на 2026-08-08). */
export class AudioManager {
  constructor() {
    this.engine = new AudioEngine();
    this.sfx = new SfxLibrary(this.engine);
    this.loops = new LoopLayer(this.engine);
    this.loops.playBird = () => this.sfx.bird();
    this.radio = new RadioEngine(this.engine);

    this._ready = false;
    this._unlockInstalled = false;
    this._hornActive = false;
    /* Позиция слушателя (игрока) для 3D-панорамирования — обновляется каждый
       кадр из updateVehicle(), а не читается напрямую из объекта PlayerCar
       (раньше был хак this.audio._gamePlayer = this.player в game.js) */
    this._listener = { x: 0, z: 0, heading: 0 };

    // Подписки регистрируются один раз здесь, а не при unlock(), чтобы
    // события между конструктором и первым жестом пользователя не терялись
    // молча. Каждый обработчик сам проверяет this._ready.
    this._bindEvents();
  }

  get enabled() { return this.engine.enabled; }
  get musicOn() { return this.radio.musicOn; }
  get ctx() { return this.engine.ctx; }
  get stations() { return this.radio.stations; }

  _bindEvents() {
    Events.on('crash', (d) => {
      if (!this._ready) return;
      this.sfx.crash(d ? d.impact || 20 : 20);
      this.radio.duck(0.25, 0.15, 0.5);
    });
    Events.on('order:accepted', (d) => {
      if (!this._ready) return;
      this.sfx.doorClose();
      this.sfx.pickup();
      if (d && d.order && d.order.type === 'race') this.sfx.raceGo();
    });
    Events.on('order:completed', (r) => {
      if (!this._ready) return;
      this.sfx.doorOpen();
      this.sfx.cash(r ? r.total : 100);
    });
    Events.on('order:failed', () => {
      if (!this._ready) return;
      this.sfx.fail();
    });
    Events.on('hitPed', (d) => {
      if (!this._ready) return;
      if (d && d.byPlayer === false) return;
      this.sfx.pedHit();
    });
    Events.on('trafficHitPed', () => {
      if (!this._ready) return;
      this.sfx.pedHit();
    });
    Events.on('nearmiss', () => {
      if (!this._ready) return;
      this.sfx.nearMiss();
    });
    Events.on('nearmiss:streak', (d) => {
      if (!this._ready) return;
      this.sfx.nearMissStreak(d && d.level ? d.level : 1);
    });
    Events.on('ped:kick', () => {
      if (!this._ready) return;
      this.sfx.thud();
    });
    Events.on('ped:punch', () => {
      if (!this._ready) return;
      this.sfx.thud();
    });
    Events.on('playerped:hit', (d) => {
      if (!this._ready) return;
      if (d && d.isKnockedOut) {
        this.sfx.pedHit();
      } else {
        this.sfx.thud();
      }
    });
    Events.on('horn', (d = {}) => {
      if (!this._ready) return;
      if (d.sourceX !== undefined) {
        d.playerX = this._listener.x;
        d.playerZ = this._listener.z;
        d.playerHeading = this._listener.heading;
      }
      this.sfx.horn(d);
    });
    Events.on('spatial:shout', (d) => {
      if (!this._ready || !d) return;
      const soundType = d.type || (d.avatar === '🚘' ? 'driver' : 'grump');
      this.sfx.spatialSpeak(d.x, d.z, this._listener.x, this._listener.z, soundType, this._listener.heading);
      this.radio.duck(0.45, 0.3, 0.9);
    });
    Events.on('passenger:speak', (d) => {
      if (!this._ready) return;
      const toneType = d && (d.event === 'crash' || d.event === 'offroad') ? 'grump' : d && d.event === 'fast' ? 'drift' : 'greeting';
      this.sfx.spatialSpeak(null, null, 0, 0, toneType);
      this.radio.duck(0.45, 0.3, 0.9);
    });
    Events.on('stall', () => {
      if (!this._ready) return;
      this.sfx.stall();
    });
    Events.on('noFuel', () => {
      if (!this._ready) return;
      this.sfx.fail();
    });
    Events.on('edge', () => {
      if (!this._ready) return;
      this.sfx.edgeBump();
    });
    Events.on('weather:changed', (d) => {
      if (!this._ready) return;
      this.loops.setRain(!!(d && d.weather === 'rain'));
    });
    Events.on('game:state_changed', ({ state }) => {
      if (!this._ready) return;
      this.setSceneState(state);
    });
    Events.on('shift:started', () => {
      if (!this._ready) return;
      this.sfx.engineStart();
    });
    Events.on('shift:ended', () => {
      if (!this._ready) return;
      this.sfx.shiftEnd();
    });
    Events.on('order:timer', (d) => {
      if (!this._ready) return;
      this.sfx.orderTimerBeep(d ? d.left : 0);
    });
  }

  /* Разблокировка AudioContext по первому жесту пользователя — сразу
     несколько типов событий (клик мышью — не единственный способ начать
     игру; старт с клавиатуры/тача без единого pointerdown раньше оставлял
     игру немой) */
  installUnlockHandlers() {
    if (this._unlockInstalled) return;
    this._unlockInstalled = true;
    const events = ['pointerdown', 'keydown', 'touchstart', 'click'];
    const handler = () => {
      events.forEach((ev) => window.removeEventListener(ev, handler, true));
      this.unlock();
    };
    events.forEach((ev) => window.addEventListener(ev, handler, { once: true, capture: true }));
  }

  /* Вызывать по первому жесту пользователя */
  unlock() {
    if (this._ready) {
      if (this.engine.ctx && this.engine.ctx.state === 'suspended') this.engine.ctx.resume();
      return;
    }
    try {
      this.engine.init();
      if (!this.engine.ready) return;
      // Возвращаем контекст из suspended/interrupted (входящий звонок на iOS
      // и т.п.), когда вкладка снова видима
      this.engine.ctx.onstatechange = () => {
        const st = this.engine.ctx.state;
        if ((st === 'suspended' || st === 'interrupted') && document.visibilityState === 'visible') {
          this.engine.ctx.resume().catch(() => {});
        }
      };
      this.loops.build();
      this._ready = true;
      this.radio.start();
    } catch (e) {
      console.warn('audio error', e);
    }
  }

  dispose() {
    this.radio.stop();
    this.loops.dispose();
    this.engine.dispose();
    this._ready = false;
  }

  /* Реакция на смену состояния игры: вне 'driving' глушим непрерывные слои
     (движок/скид) и ставим музыку с птицами на паузу */
  setSceneState(state) {
    const driving = state === 'driving';
    this.loops.setPaused(!driving);
    if (driving) this.radio.start();
    else this.radio.stop();
  }

  /* --- Делегирование к SfxLibrary --- */
  horn(opts) { this.sfx.horn(opts); }
  crash(impact) { this.sfx.crash(impact); }
  cash(amount) { this.sfx.cash(amount); }
  pickup() { this.sfx.pickup(); }
  speak() { this.sfx.speak(); }
  fail() { this.sfx.fail(); }
  pedHit() { this.sfx.pedHit(); }
  thud() { this.sfx.thud(); }
  stall() { this.sfx.stall(); }
  click() { this.sfx.click(); }
  refuel() { this.sfx.refuel(); }
  bird() { this.sfx.bird(); }
  raceGo() { this.sfx.raceGo(); }
  edgeBump() { this.sfx.edgeBump(); }
  spatialSpeak(sourceX, sourceZ, playerX, playerZ, type, playerHeading) {
    this.sfx.spatialSpeak(sourceX, sourceZ, playerX, playerZ, type, playerHeading);
  }

  /* --- Делегирование к LoopLayer --- */
  updateEngine(rpm, throttle, running) { this.loops.updateEngine(rpm, throttle, running); }
  updateSkid(intensity) { this.loops.updateSkid(intensity); }
  setRain(on) { this.loops.setRain(on); }

  /* Единый per-frame вызов из Game._drive(): обновляет непрерывные слои
     (движок/скид/шины/ветер/тормоза/дребезг от урона), позицию слушателя
     для 3D-панорамирования и триггерит гудок/ручник игрока по фронту
     нажатия. carType переключает тембр двигателя (без пересборки узлов). */
  updateVehicle(v) {
    this._listener.x = v.x; this._listener.z = v.z; this._listener.heading = v.heading;
    this._vehicle = v;
    if (v.carType && v.carType !== this._lastCarType) {
      this._lastCarType = v.carType;
      this.loops.setEngineProfile(v.carType);
    }
    this.loops.updateEngine(v.rpm, v.throttle, v.running);
    this.loops.updateSkid(v.slip);
    this.loops.updateTyre(v.speed, v.onRoad);
    this.loops.updateWind(v.speed, v.maxSpeed);
    this.loops.updateBrake(v.brake, v.speed);
    this.loops.updateDamageRattle(v.damage, v.speed);
    this.loops.updateFuelWarning(v.fuelFrac);
    this.loops.updateSuspension(v.groundY);
    if (v.horn) {
      if (!this._hornActive) { this.sfx.horn({ type: 'player', dur: 0.65 }); this._hornActive = true; }
    } else {
      this._hornActive = false;
    }
    if (v.handbrake) {
      if (!this._handbrakeActive) { this.sfx.handbrake(); this._handbrakeActive = true; }
    } else {
      this._handbrakeActive = false;
    }
    if (v.camDist !== undefined) this.radio.setCamDist(v.camDist);
    if (v.hour !== undefined) this.radio.setHour(v.hour);
    if (v.speed !== undefined && v.maxSpeed !== undefined) this.radio.setSpeed(v.speed, v.maxSpeed);
    if (v.raining !== undefined) this.radio.setRain(!!v.raining);
    this._updateWorldAudio(v);
  }

  /* Звуки мира, завязанные на per-frame состояние: смена дня/ночи, гром в
     дождь, сирены ближайшей спецмашины, шаги ближайшего пешехода. Все
     таймеры считаются в ctx-времени, поэтому без готового AudioContext
     (до unlock()) просто ничего не делают. */
  _updateWorldAudio(v) {
    if (v.hour !== undefined) {
      const night = v.hour >= 20 || v.hour < 6;
      if (this._lastNightChime === undefined) this._lastNightChime = night;
      else if (night !== this._lastNightChime) {
        this._lastNightChime = night;
        if (this._ready) this.sfx.dayNightChime();
      }
    }
    if (!this._ready || !this.engine.ctx) return;
    const now = this.engine.ctx.currentTime;

    if (v.raining) {
      if (!this._thunderNext) this._thunderNext = now + 15 + Math.random() * 30;
      if (now >= this._thunderNext) {
        this._thunderNext = now + 20 + Math.random() * 40;
        this.sfx.thunder();
      }
    } else {
      this._thunderNext = 0;
    }

    if (v.siren) {
      const sirenInterval = v.siren.type === 'police' ? 1.0 : 1.5;
      if (!this._sirenNext || now >= this._sirenNext) {
        this._sirenNext = now + sirenInterval;
        this.sfx.siren({
          sourceX: v.siren.x, sourceZ: v.siren.z,
          playerX: v.x, playerZ: v.z, playerHeading: v.heading, type: v.siren.type,
        });
      }
    }

    if (v.nearestPedDist !== undefined && v.nearestPedDist < 12) {
      if (!this._stepNext || now >= this._stepNext) {
        this._stepNext = now + 0.42;
        this.sfx.footstep(v.nearestPedPan || 0, 1 - v.nearestPedDist / 12);
      }
    }
  }

  /* --- Делегирование к RadioEngine --- */
  nextStation() { return this.radio.nextStation(); }
  getCurrentStation() { return this.radio.getCurrentStation(); }
  getStationId() { return this.radio.getStationId(); }
  setStationId(id) { this.radio.setStationId(id); }
  pauseRadio() { this.radio.stop(); }
  resumeRadio() { if (this.musicOn && this.engine.enabled) this.radio.start(); }
  setWalkRadio(on) { this.radio.setWalkMode(on); }

  /* --- Громкости и мьют --- */
  setEnabled(on) { this.engine.setMasterEnabled(on); }
  setMusic(on) { this.radio.setMusicOn(on); }
  setVolume(key, val) { this.engine.setVolume(key, val); }
  getVolumes() { return this.engine.getVolumes(); }

  /* --- Алиасы, используемые Game --- */
  setEngine(rpm, throttle, running) { this.updateEngine(rpm, throttle, running); }
  setSkid(intensity) { this.updateSkid(intensity); }
  setMaster(on) { this.setEnabled(on); }
  chime() { this.pickup(); }
  error() { this.fail(); }
}

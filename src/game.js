import * as THREE from 'three';
import { CFG, CFG_GFX_PRESETS, WEATHER_DEFS } from './config.js';
import { clamp, lerp, pickWeighted, showError } from './utils.js';
import { Events } from './eventbus.js';
import { World } from './citygen.js';
import { PlayerCar } from './player.js';
import { TRAFFIC_TYPES, TrafficManager, WORLD_INTERSECTIONS } from './traffic.js';
import { PedestrianManager } from './peds.js';
import { ChaseCamera } from './camera.js';
import { OrdersManager } from './orders.js';
import { UpgradeSystem } from './upgrades.js';
import { UIManager } from './ui.js';
import { AudioManager } from './audio.js';
import { InputManager } from './input.js';

// Таблица цвета неба по часу суток + переиспользуемые Color-объекты для
// _updateTime (каждый кадр) — вместо new THREE.Color(...) на каждый вызов (OPT-18)
const SKY_TABLE = [
  { h: 4, c: [13, 18, 30] }, { h: 6, c: [96, 118, 148] }, { h: 9, c: [135, 176, 216] },
  { h: 13, c: [156, 200, 232] }, { h: 17, c: [150, 160, 180] }, { h: 19, c: [206, 132, 84] },
  { h: 21, c: [62, 50, 78] }, { h: 24, c: [13, 18, 30] },
];
const SKY_TINT_RAIN = new THREE.Color(0x3a4856);
const SKY_TINT_FOG = new THREE.Color(0x8a95a2);
const _tmpSky = new THREE.Color();
const _tmpFogColor = new THREE.Color();

const RAIN_VERT = `
uniform float uTime;
uniform float uFallSpeed;   // м/с, ЕДИНИЦЫ КАК В СТАРОМ КОДЕ: 38.0, а не 38/uHeight
uniform float uWindX;
uniform float uWindZ;
uniform float uHeight;
uniform float uSize;        // мировой радиус капли (был 0.3 у PointsMaterial)
uniform float uScale;       // калибровочный коэффициент перспективного attenuation

// position.x = baseX, position.y = phase[0..1], position.z = baseZ (тот же смысл, что в seed-буфере)

void main() {
  float t = mod(uTime * uFallSpeed + position.y * uHeight, uHeight);
  float y = uHeight - t;                    // падение сверху вниз, y ∈ [0, uHeight)
  float fallProgress = t / uFallSpeed;      // время с момента последнего "сброса" этой капли, сек
  float x = position.x + fallProgress * uWindX;
  float z = position.z + fallProgress * uWindZ;

  vec4 mvPosition = modelViewMatrix * vec4(x, y, z, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = uSize * (uScale / -mvPosition.z);
}
`;

const RAIN_FRAG = `
uniform float uOpacity;
void main() {
  gl_FragColor = vec4(0.58, 0.72, 0.88, uOpacity);
  #include <tonemapping_fragment>
  #include <encodings_fragment>
}
`;

/**
 * Главный класс игры, управляющий игровым циклом, состояниями, рендерером и подсистемами.
 */
export class Game {
  constructor() {
    /** @type {string} текущее состояние игры ('boot'|'menu'|'driving'|'pause'|'garage'|'settings'|'map'|'shiftend') */
    this.stateName = 'boot';
    /** @type {number} количество денег у игрока */
    this.money = CFG.startMoney;
    /** @type {number} текущий рейтинг */
    this.rating = 0;
    /** @type {number} текущий день смены */
    this.day = 1;
    /** @type {Object|null} статистика за всё время */
    this.stats = null;
    /** @type {import('./config.js').ShiftStats|null} статистика текущей смены */
    this.shiftStats = null;
    this.shiftElapsed = 0;
    /** @type {number} текущий час суток (0..24) */
    this.hour = CFG.shiftStartHour;
    /** @type {string} погодные условия ('clear'|'rain'|'fog') */
    this.weather = 'clear';
    this.interact = null;
    this.shakeT = 0; this.shakeAmp = 0;
    this._saveTimer = 0;
    this._menuT = 0;
    this._garageT = 0;
    this.soundOn = true;
    this.musicOn = true;

    /** @type {boolean} debug-оверлей (FPS/CPU/draw calls), включается ?debug в URL */
    this._debugOverlay = new URLSearchParams(location.search).has('debug');

    this.canvas = document.getElementById('game-canvas');
    this.ui = new UIManager(this);
    this.input = new InputManager(this.canvas);
    this.audio = new AudioManager();

    // прогресс игрока (апгрейды, машины) — до построения машины
    this.upgrades = new UpgradeSystem();
    const save = this.upgrades.load();

    this._initRenderer();
    this._initScene();
    this._initWorld();
    this._initManagers();
    this._initEvents();
    // CFG.gfx к этому моменту уже отражает загруженный пресет (upgrades.load()
    // применяет save.gfx синхронно до _initRenderer()), но сам рендерер ещё
    // не приведён в соответствие — синхронизируем без тоста
    this.applyGfx({}, { silent: true });

    if (save) {
      this.money = save.money; this.rating = save.rating; this.day = save.day || 1;
      this.stats = save.stats || { orders: 0, earned: 0, tips: 0, crashes: 0, peds: 0, km: 0, failed: 0, missions: 0 };
      this.soundOn = save.sound !== undefined ? save.sound : true;
      this.musicOn = save.music !== undefined ? save.music : true;
      this.weather = save.weather || this.weather;
      // громкости/станция — опциональные поля; старые сохранения без них
      // должны грузиться без ошибок. Применяются до unlock() — методы
      // audio.setVolume()/setStationId() безопасны без готового AudioContext.
      if (save.audioVol) {
        for (const key in save.audioVol) this.audio.setVolume(key, save.audioVol[key]);
      }
      if (save.radio) this.audio.setStationId(save.radio);
      this.player.applyUpgrades(this.upgrades.stats());
      this.player.setTuning(this.upgrades.tuningForCar());
      this.ui.syncSettings(this.soundOn, this.musicOn);
      this.ui.$('btn-continue').classList.remove('hidden');
      this.ui.toast('Есть сохранение — можно продолжить', '#7ee787');
    } else {
      this.stats = { orders: 0, earned: 0, tips: 0, crashes: 0, peds: 0, km: 0, failed: 0, missions: 0 };
      this.ui.syncSettings(this.soundOn, this.musicOn);
    }

    // звук — только после жеста пользователя (pointerdown/keydown/touchstart/click,
    // старт с клавиатуры без единого клика раньше оставлял игру немой)
    this.audio.installUnlockHandlers();

    this.audio.setMaster(this.soundOn);
    this.audio.setMusic(this.musicOn);

    this.setState('menu');
    this._loop();
  }

  /* ---------- Инициализация Three.js ---------- */
  _initRenderer() {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) throw new Error('WebGL не поддерживается вашим браузером');
    // MSAA имеет смысл только при pixelRatio < 1.5 — выше суперсэмплинг уже
    // сглаживает края сам, а MSAA поверх него удваивает-учетверяет фрагментный
    // трафик почти без выигрыша в картинке (см. план по просадке FPS)
    const dpr = window.devicePixelRatio || 1;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: dpr < 1.5, powerPreference: 'high-performance' });
    this._applyResolution();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = CFG.gfx.shadows !== 'off';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this._applyResolution();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      if (this.rainUniforms) {
        this.rainUniforms.uScale.value = window.innerHeight * 0.5;
      }
    });
  }

  /* Эффективный pixelRatio буфера: ограничен пресетом графики и бюджетом пикселей
     под текущий размер окна (иначе fullscreen на retina просто топит филлрейт).
     Пересчитывается только по событиям (старт, resize, смена пресета) — НЕ
     покадрово: setPixelRatio() меняет canvas.width/height, а изменение размеров
     канваса немедленно очищает буфер отрисовки. Периодический вызов посреди
     игры (была такая попытка с авто-подстройкой под текущий FPS) на мгновение
     показывает пользователю только что очищенный кадр раньше, чем следующий
     renderer.render() успевает его перерисовать — читается как мерцание. */
  _effectivePixelRatio() {
    const dpr = Math.min(window.devicePixelRatio || 1, CFG.gfx.pixelRatio);
    const budget = CFG.gfx.pixelBudget || 3200000;
    const cap = Math.sqrt(budget / Math.max(1, window.innerWidth * window.innerHeight));
    return Math.max(0.7, Math.min(dpr, cap));
  }

  /* setPixelRatio() пересоздаёт внутренние буферы рендерера — не дёргать его,
     если разрешение фактически не изменилось */
  _applyResolution() {
    const r = this._effectivePixelRatio();
    if (this.renderer.getPixelRatio && Math.abs(r - this.renderer.getPixelRatio()) < 0.01) return;
    this.renderer.setPixelRatio(r);
    if (this.rainUniforms) this.rainUniforms.uSize.value = 0.3 * r;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x9cc8e8, 350, 1400);
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.5, CFG.gfx.drawDistance);
    this.camera.position.set(0, 40, 90);

    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6f8f5f, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 1.2);
    this.sun.position.set(60, 90, 40);
    this.sun.castShadow = CFG.gfx.shadows !== 'off';
    const initShadowRes = CFG.gfx.shadows === 'high' ? 1024 : 512;
    this.sun.shadow.mapSize.set(initShadowRes, initShadowRes);
    this.sun.shadow.camera.left = -CFG.SHADOW_HALF; this.sun.shadow.camera.right = CFG.SHADOW_HALF;
    this.sun.shadow.camera.top = CFG.SHADOW_HALF; this.sun.shadow.camera.bottom = -CFG.SHADOW_HALF;
    this.sun.shadow.camera.far = 400;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // звёзды
    const starGeo = new THREE.BufferGeometry();
    const starPos = [];
    for (let i = 0; i < 500; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI * 0.45;
      starPos.push(Math.cos(a) * Math.cos(e) * 800, 10 + Math.sin(e) * 800, Math.sin(a) * Math.cos(e) * 800);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0 }));
    this.scene.add(this.stars);

    // дождь (1200 частиц, анимация на GPU через ShaderMaterial)
    const RAIN_COUNT = 1200;
    const rainGeo = new THREE.BufferGeometry();
    const rainSeeds = new Float32Array(RAIN_COUNT * 3);
    for (let i = 0; i < RAIN_COUNT; i++) {
      rainSeeds[i * 3] = (Math.random() - 0.5) * 220;  // base X
      rainSeeds[i * 3 + 1] = Math.random();              // phase [0..1]
      rainSeeds[i * 3 + 2] = (Math.random() - 0.5) * 220;  // base Z
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainSeeds, 3));
    this.rainUniforms = {
      uTime:      { value: 0 },
      uFallSpeed: { value: 38.0 },  // м/с — как в исходном CPU-цикле, НЕ 38/55
      uWindX:     { value: -4.0 },
      uWindZ:     { value: -2.0 },
      uHeight:    { value: 55.0 },
      uSize:      { value: 0.3 * this.renderer.getPixelRatio() },   // как у PointsMaterial: size * pixelRatio
      uScale:     { value: window.innerHeight * 0.5 },              // как у PointsMaterial: height * 0.5, без учёта FOV
      uOpacity:   { value: 0.65 },
    };
    const rainMat = new THREE.ShaderMaterial({
      uniforms: this.rainUniforms,
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.rain = new THREE.Points(rainGeo, rainMat);
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  _initWorld() {
    this.world = new World(this.scene);
    const t0 = performance.now();
    this.world.build();
    if (this.renderer.shadowMap.enabled) this.renderer.shadowMap.needsUpdate = true;
    if (this._debugOverlay) console.log(`world.build(): ${(performance.now() - t0).toFixed(1)}ms`);
    WORLD_INTERSECTIONS = this.world.intersections;
  }

  _initManagers() {
    this.player = new PlayerCar(this.scene, this.upgrades.stats());
    this.player.setTuning(this.upgrades.tuningForCar());
    this.player.setPos(0, 20, 0);

    this.traffic = new TrafficManager(this.scene);
    this.traffic.spawn(CFG.trafficCount, this.player);
    this.traffic.lightsRef = this.world.lights;

    this.peds = new PedestrianManager(this.scene);
    this.peds.lightsRef = this.world.lights;
    this.peds.world = this.world;
    this.peds.spawn(CFG.pedCount, this.player);
    this.world.peds = this.peds;
    this.world.gameRef = this;

    this.orders = new PassengerManager(this.world);

    this.player.fuel = CFG.startFuel;
    this.chaseCam = new ChaseCamera(this.camera);
    this.chaseCam.reset(this.player);
  }

  setMoney(amount) {
    const oldMoney = this.money;
    this.money = amount;
    events.emit('money:changed', { money: this.money, oldMoney, delta: this.money - oldMoney });
  }

  addMoney(amount) {
    this.setMoney(this.money + amount);
  }

  setRating(val) {
    const oldRating = this.rating;
    this.rating = clamp(val, 0, 100);
    events.emit('rating:changed', { rating: this.rating, oldRating, delta: this.rating - oldRating });
  }

  addRating(amount) {
    this.setRating(this.rating + amount);
  }

  /* ---------- События ---------- */
  _initEvents() {
    events.on('crash', (d) => {
      this.shiftStats.crashes++;
      this.shakeT = 0.45; this.shakeAmp = Math.min(0.6, d.impact / 40);
      this.orders.onCrash(d.impact);
    });
    events.on('hitPed', (d) => {
      if (d && d.byPlayer === false) return;
      this.shiftStats.peds++;
      this.setRating(this.rating - CFG.ratingFail.hitPed);
      this.addMoney(-300);
      this.shakeT = 0.3; this.shakeAmp = 0.4;
      // Посылка не прерывается при сбитии пешехода — пассажира в машине нет
      if (this.orders.active && this.orders.active.type !== 'package') this.orders.fail(this.orders.active, 'ped');
      this.ui.toast('Вы сбили пешехода! -300 ₽, рейтинг -15', '#ff6b6b');
      // сам пешеход (отлёт/лежание) обрабатывается в peds._knockDown
    });
    events.on('ped:kick', () => {
      this.shakeT = 0.22; this.shakeAmp = 0.32;
    });
    events.on('stall', () => {
      this.ui.toast('Двигатель заглох!', '#ffb030');
    });
    events.on('noFuel', () => {
      this.ui.toast('Кончилось топливо! До заправки пешком…', '#ffb030');
    });
    events.on('edge', () => {
      this.ui.toast('Край карты — дальше не проехать!', '#ffb030');
    });
    events.on('order:accepted', () => {
      this.ui.toast('Пассажир сел. Поехали!', '#7ee787');
    });
    events.on('toast', (d) => this.ui.toast(d.text, d.color));

    events.on('spatial:shout', (d) => {
      if (d.text && this.player) {
        const dist = Math.hypot(d.x - this.player.x, d.z - this.player.z);
        if (dist < 38) {
          const defaultSpeaker = d.type === 'driver' ? 'Водитель рядом' : 'Пешеход рядом';
          const speaker = d.speaker || defaultSpeaker;
          this.ui.showDialogue(speaker, d.text, d.avatar || '🗣️', d.color || '#ffab70');
        }
      }
    });

    events.on('passenger:speak', (d) => {
      if (d.text) {
        this.ui.showDialogue(d.speaker, d.text, d.avatar, d.color);
      }
    });

    events.on('order:completed', (r) => {
      this.addMoney(r.total);
      this.shiftStats.earned += r.pay;
      this.shiftStats.tips += r.tips;
      this.shiftStats.orders++;
      const rp = CFG.ratingPerOrder[r.type] || 8;
      this.addRating(rp);
      if (r.missionId) {
        this.shiftStats.missions++;
        if (!this.orders.completed.includes(r.missionId)) this.orders.completed.push(r.missionId);
      }
      const bonus = r.tips > 0 ? ' + ' + fmtMoney(r.tips) + ' чаевых' : '';
      this.ui.toast('Заказ выполнен: +' + fmtMoney(r.pay) + bonus, '#7ee787');
      if (this.rating >= 100) this.ui.toast('Максимальный рейтинг! Пятигорск ваш! ⭐', '#ffd75e');
    });
    events.on('order:failed', (d) => {
      this.shiftStats.failed++;
      this.setRating(this.rating - CFG.ratingFail.failOrder);
    });
  }

  /* ---------- Состояния ---------- */
  /**
   * Сменить текущее состояние игры.
   * @param {string} name - Название нового состояния ('menu'|'driving'|'pause'|'garage'|'settings'|'map'|'shiftend')
   */
  setState(name) {
    const oldState = this.stateName;
    this.stateName = name;
    Events.emit('game:state_changed', { state: name, oldState });
    if (name === 'menu') {
      this.ui.showScreen('menu', true);
      this.ui.showHud(false);
    } else if (name === 'driving') {
      this.ui.showScreen(null);
      this.ui.showHud(true);
    } else if (name === 'pause') {
      this.ui.showScreen('pause', true);
    } else if (name === 'garage') {
      this.ui.showScreen('garage', true);
      this.ui.renderGarage(this.upgrades, this.money, this.player);
    } else if (name === 'settings') {
      this.ui.showScreen('settings', true);
    } else if (name === 'map') {
      this.ui.showScreen('map', true);
      this.ui.renderBigMap(this.player, this.orders, this.world);
    } else if (name === 'shiftend') {
      this.ui.showScreen('shiftend', true);
      this.ui.renderShiftEnd({ money: this.money, rating: this.rating, day: this.day }, this.shiftStats);
    }
  }

  newGame() {
    this.upgrades.clear();
    this.upgrades = new UpgradeSystem();
    const s = newGameState();
    this.money = s.money; this.rating = s.rating; this.day = 1;
    this.stats = { orders: 0, earned: 0, tips: 0, crashes: 0, peds: 0, km: 0, failed: 0, missions: 0 };
    this.ui.$('btn-continue').classList.add('hidden');
    this._startShift(1);
  }

  continueGame() {
    this._startShift(this.day);
  }

  _startShift(day) {
    this.day = day;
    this.shiftElapsed = 0;
    this.hour = CFG.shiftStartHour;
    this.shiftStats = { earned: 0, orders: 0, tips: 0, crashes: 0, peds: 0, km: 0, failed: 0, missions: 0 };
    this.weather = pickWeighted([
      { v: 'clear', w: 55 }, { v: 'rain', w: 25 }, { v: 'fog', w: 20 },
    ]);
    if (this.renderer.shadowMap.enabled) this.renderer.shadowMap.needsUpdate = true;
    Events.emit('weather:changed', { weather: this.weather });
    this._applyDensity();
    this.orders.reset();
    this.player.applyUpgrades(this.upgrades.stats());
    this.player.setTuning(this.upgrades.tuningForCar());
    this.player.setPos(0, 20, 0);
    this.player.repair();
    this.player.wash();
    this.chaseCam.reset(this.player);
    this.setState('driving');
    Events.emit('shift:started');
  }

  endShift() {
    this.setState('shiftend');
    this.save();
    Events.emit('shift:ended');
  }

  startNewShift() {
    this.day++;
    this._startShift(this.day);
  }

  toMenu() {
    this.setState('menu');
    this.save();
  }

  togglePause() {
    if (this.stateName === 'driving') { this.setState('pause'); this.save(); }
    else if (this.stateName === 'pause') { this.setState('driving'); }
  }

  openGarage(from) {
    this._garageFrom = from;
    this.setState('garage');
  }

  closeGarage() {
    this.setState(this._garageFrom === 'menu' ? 'menu' : this._garageFrom === 'pause' ? 'pause' : 'driving');
    this.save();
  }

  openSettings(from) {
    this._settingsFrom = from || this.stateName;
    this.setState('settings');
  }

  closeSettings() {
    this.setState(this._settingsFrom === 'menu' ? 'menu' : this._settingsFrom === 'pause' ? 'pause' : 'driving');
  }

  toggleMap() {
    if (this.stateName === 'map') this.setState('driving');
    else if (this.stateName === 'driving') this.setState('map');
  }

  setSound(on) { this.soundOn = on; this.audio.setMaster(on); }
  setMusic(on) { this.musicOn = on; this.audio.setMusic(on); }

  /* Слайдер громкости — протаскивание не должно писать в localStorage на
     каждый шаг, поэтому сохранение debounce'ится на 800мс */
  setVolume(key, val) {
    this.audio.setVolume(key, val);
    clearTimeout(this._volSaveTimer);
    this._volSaveTimer = setTimeout(() => this.save(), 800);
  }

  setRadioStation(id) {
    this.audio.setStationId(id);
    this.save();
  }

  /* Применить именованный пресет графики (low|medium|high) целиком */
  applyGfxPreset(name) {
    const preset = CFG_GFX_PRESETS[name];
    if (!preset) return;
    this.applyGfx({ ...preset, preset: name });
  }

  /* Точечно применить часть настроек графики (остальные поля CFG.gfx не трогаются).
     Тени полностью выключаются/включаются (не просто прячутся): shadowMap.enabled,
     castShadow, dispose текущей shadow map — а не косметическое сокрытие результата.
     opts.silent — без тоста; используется при старте игры (см. конструктор), чтобы
     привести состояние рендерера (тип теней/pixelRatio/camera.far) в соответствие
     с загруженным сохранением сразу, а не только после первого ручного открытия
     настроек. Без этого вызова _initRenderer()/_initScene() жёстко прописывают
     дефолт, который может не совпадать с CFG.gfx из сейва (например, у пресета
     «Высокое» — мягкие тени, а хардкод в _initRenderer — обычный PCF). */
  applyGfx(partial, opts = {}) {
    CFG.gfx = { ...CFG.gfx, ...partial };
    const g = CFG.gfx;
    const shadowsOn = g.shadows !== 'off';

    this.renderer.shadowMap.enabled = shadowsOn;
    // 'high' — мягкие тени (PCFSoftShadowMap дороже на каждый затенённый
    // фрагмент), 'low' — обычный PCF: экономия филлрейта важнее мягкости края
    this.renderer.shadowMap.type = g.shadows === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.sun.castShadow = shadowsOn;
    const shadowRes = g.shadows === 'high' ? 1024 : 512;
    this.sun.shadow.mapSize.set(shadowRes, shadowRes);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    if (shadowsOn) this.renderer.shadowMap.needsUpdate = true;
    this._setActorShadow(shadowsOn && g.shadowActors);

    this._applyResolution();
    if (this.rainUniforms) this.rainUniforms.uScale.value = window.innerHeight * 0.5;

    this.camera.far = g.drawDistance;
    this.camera.updateProjectionMatrix();

    // Старый алиас CFG.quality — держится ради обратной совместимости сохранений
    CFG.quality = (g.shadows === 'high' && g.pixelRatio >= 1.75) ? 'high' : 'low';

    if (opts.silent) return;
    const presetNames = { low: 'низкое', medium: 'среднее', high: 'высокое', custom: 'своё' };
    this.ui.toast('Графика: ' + (presetNames[g.preset] || 'своё'), '#7ee787');
  }

  /* castShadow на мешах пешеходов/машин — включается только под «Своё» + «Тени: высокие»,
     не бесплатно (лишние ~600 draw calls в shadow-проходе), поэтому не в дефолтных пресетах */
  _setActorShadow(on) {
    for (const car of this.traffic.cars) car.mesh.traverse((o) => { if (o.isMesh) o.castShadow = on; });
    for (const p of this.peds.cars) p.mesh.traverse((o) => { if (o.isMesh) o.castShadow = on; });
  }

  /* Плотность трафика/пешеходов — применяется с новой смены (см. _startShift), не мгновенно:
     дорастить пул через spawn(), затем скрыть избыток через mesh.visible вместо
     удаления/пересоздания сущностей (безопаснее относительно логики trafic/peds AI) */
  _applyDensity() {
    const g = CFG.gfx;
    const tCount = Math.max(1, Math.round(CFG.trafficCount * g.trafficDensity));
    const pCount = Math.max(1, Math.round(CFG.pedCount * g.pedDensity));
    this.traffic.spawn(Math.max(CFG.trafficCount, tCount), this.player);
    this.peds.spawn(Math.max(CFG.pedCount, pCount), this.player);
    this.traffic.cars.forEach((c, i) => { c.mesh.visible = i < tCount; });
    this.peds.cars.forEach((p, i) => {
      p.mesh.visible = i < pCount;
      if (p.speechSprite) p.speechSprite.visible = p.speechSprite.visible && i < pCount;
    });
  }

  /* ---------- Действия игрока ---------- */
  pressHorn() {
    if (this.stateName !== 'driving') return;
    // Звук гудка триггерится единожды за нажатие внутри audio.updateVehicle()
    // (по фронту hornTimer > 0) — раньше здесь был ещё один прямой вызов
    // audio.horn(), и на одно нажатие H звучало два наложенных гудка.
    this.player.hornTimer = 0.7;
  }

  toggleLights() {
    if (this.stateName !== 'driving') return;
    this.player.toggleLights();
  }

  toggleRadio() {
    // звук переключения — статик/свист внутри nextStation(); отдельный
    // click() не нужен: для мыши/тача его уже даёт делегированный слушатель
    // кнопок в ui.js, а дублировать его для клавиши R незачем
    this.audio.nextStation();
  }

  evacuate() {
    if (this.money < CFG.towCost) { this.ui.toast('Не хватает на эвакуатор', '#ff6b6b'); return; }
    this.money -= CFG.towCost;
    this.player.damage = Math.max(0, this.player.damage - CFG.towRepair);
    this.player.fuel = Math.min(this.player.stats.tank, this.player.fuel + CFG.towFuel);
    const n = this._nearestIntersection(this.player.x, this.player.z);
    this.player.setPos(n.x, n.z, 0);
    this.ui.toast('Эвакуатор доставил машину на перекрёсток', '#7ee787');
    this.audio.chime();
    this.setState('driving');
  }

  _nearestIntersection(x, z) {
    let best = this.world.intersections[0], bd = 1e9;
    for (const i of this.world.intersections) {
      const d = dist2D(x, z, i.x, i.z);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  refuel() {
    const cost = Math.round((this.player.stats.tank - this.player.fuel) * CFG.fuelPrice);
    if (this.money < cost) { this.ui.toast('Не хватает денег на бензин', '#ff6b6b'); return; }
    this.money -= cost;
    this.player.refuel();
    this.audio.chime();
    this.ui.toast('Заправлено за ' + fmtMoney(cost), '#7ee787');
  }

  completeOrder() {
    const res = this.orders.complete(this.player, this.hour, this.rating);
    if (res && res.partial) { this.audio.chime(); }
  }

  buyUpgrade(key) {
    const res = this.upgrades.buy(key, this.money);
    if (!res.ok) { this.ui.toast('Не хватает денег', '#ff6b6b'); return; }
    this.money -= res.cost;
    this.player.applyUpgrades(this.upgrades.stats());
    this.audio.cash(false);
    this.ui.renderGarage(this.upgrades, this.money, this.player);
  }

  applyTuning() {
    this.player.setTuning(this.upgrades.tuningForCar());
    this.audio.chime();
  }

  buyCar(key) {
    const c = CARS[key];
    if (!c) return;
    if (this.rating < c.unlockRating) { this.ui.toast('Нужен рейтинг ' + c.unlockRating + ' ⭐', '#ffd75e'); return; }
    if (this.money < c.price) { this.ui.toast('Не хватает денег', '#ff6b6b'); return; }
    this.money -= c.price;
    if (!this.upgrades.ownedCars.includes(key)) this.upgrades.ownedCars.push(key);
    this.upgrades.carId = key;
    this._applyCar();
    this.audio.cash(true);
    this.ui.toast('Поздравляем с покупкой ' + c.name + '! 🎉', '#7ee787');
  }

  selectCar(key) {
    const c = CARS[key];
    if (!c) return;
    this.upgrades.carId = key;
    this._applyCar();
    this.audio.chime();
    this.ui.toast('Выбран автомобиль: ' + c.name, '#58a6ff');
  }

  _applyCar() {
    this.player.applyUpgrades(this.upgrades.stats());
    this.player.setTuning(this.upgrades.tuningForCar());
    this.ui.renderGarage(this.upgrades, this.money, this.player);
  }

  garageRepair() {
    const cost = Math.round(this.player.damage * CFG.repairCostPerDmg);
    if (this.money < cost) { this.ui.toast('Не хватает денег на ремонт', '#ff6b6b'); return; }
    this.money -= cost;
    this.player.repair();
    this.audio.chime();
    this.ui.renderGarage(this.upgrades, this.money, this.player);
  }

  garageWash() {
    if (this.money < CFG.washCost) { this.ui.toast('Не хватает денег на мойку', '#ff6b6b'); return; }
    this.money -= CFG.washCost;
    this.player.wash();
    this.audio.chime();
    this.ui.renderGarage(this.upgrades, this.money, this.player);
  }

  garageRefuel() { this.refuel(); this.ui.renderGarage(this.upgrades, this.money, this.player); }

  /* ---------- Сохранение ---------- */
  save() {
    this.upgrades.save({
      money: this.money, rating: this.rating, stats: this.stats, day: this.day,
      sound: this.soundOn, music: this.musicOn, weather: this.weather,
      audioVol: this.audio.getVolumes(), radio: this.audio.getStationId(),
    });
  }

  /* ---------- Время и погода ---------- */
  _skyColor(hour) {
    let i = 0;
    while (i < SKY_TABLE.length - 2 && SKY_TABLE[i + 1].h <= hour) i++;
    const a = SKY_TABLE[i], b = SKY_TABLE[Math.min(i + 1, SKY_TABLE.length - 1)];
    const t = clamp((hour - a.h) / Math.max(0.001, b.h - a.h), 0, 1);
    return _tmpSky.setRGB(
      lerp(a.c[0], b.c[0], t) / 255,
      lerp(a.c[1], b.c[1], t) / 255,
      lerp(a.c[2], b.c[2], t) / 255
    );
  }

  _updateTime(dt) {
    this.shiftElapsed += dt;
    const minutes = CFG.shiftStartHour * 60 + (this.shiftElapsed / CFG.dayLengthSec) * 1440;
    this.hour = minutes / 60;
    let nf = 0;
    if (this.hour >= 22) nf = clamp((this.hour - 22) / 0.5 + 1, 0, 1);
    else if (this.hour >= 21.5) nf = (this.hour - 21.5) * 2;
    if (this.hour < 6) nf = Math.max(nf, clamp((6 - this.hour) / 1.5, 0, 1));
    nf = clamp(nf, 0, 1);
    const dayF = clamp(Math.sin(Math.PI * (this.hour - 6) / 12), 0, 1);

    // Плавная динамика погодных факторов
    this._rainFactor = lerp(this._rainFactor || 0, this.weather === 'rain' ? 1.0 : 0.0, dt * 1.5);
    this._fogFactor = lerp(this._fogFactor || 0, this.weather === 'fog' ? 1.0 : 0.0, dt * 1.5);

    // Цвет неба с учетом пасмурности и тумана
    const sky = this._skyColor(this.hour);
    if (this._rainFactor > 0.001) sky.lerp(SKY_TINT_RAIN, this._rainFactor * 0.72);
    if (this._fogFactor > 0.001) sky.lerp(SKY_TINT_FOG, this._fogFactor * 0.78);
    this.scene.background = sky;

    // Цвет и дистанция тумана
    const fogC = _tmpFogColor.copy(sky).multiplyScalar(1 - nf * 0.35);
    this.scene.fog.color.copy(fogC);
    const w = WEATHER_DEFS[this.weather];
    const targetNear = w.fogNear * (this.weather === 'fog' ? 1 : 1 - nf * 0.25);
    const targetFar = w.fogFar * (this.weather === 'fog' ? 1 : 1 - nf * 0.25);
    this.scene.fog.near = lerp(this.scene.fog.near, targetNear, dt * 2.5);
    this.scene.fog.far = lerp(this.scene.fog.far, targetFar, dt * 2.5);

    // Интенсивность освещения в зависимости от облачности/тумана
    const weatherDim = 1 - (this._rainFactor * 0.35 + this._fogFactor * 0.45);
    this.hemi.intensity = (0.35 + dayF * 0.6 - nf * 0.15) * weatherDim;
    this.sun.intensity = (0.25 + dayF * 1.05) * weatherDim;
    const sunY = Math.max(6, 90 * dayF + 12);
    this.sun.position.set(60, sunY, 40 - 60 * (1 - dayF));
    // Порог триггера полного пересчёта shadow map. shadowMap.autoUpdate=false —
    // тень между обновлениями заморожена на СТАРОМ угле солнца, а не следует
    // за ним непрерывно, поэтому каждое обновление — дискретный скачок тени.
    // При старом пороге 0.01 и dayLengthSec=720 накопление занимает ~1.6с
    // (см. derivative dayF/dt) — на честных 60 FPS этот скачок читается как
    // периодическое мерцание. Меньший порог даёт более частые, но более мелкие
    // (менее заметные) скачки вместо редких крупных; полный autoUpdate=true
    // на данной сцене дороже — много статичных зданий-теней пересчитывались
    // бы 60 раз/с ради изменения угла всего одного источника света.
    const sunMoved = Math.abs(dayF - (this._lastSunDayF ?? -1)) > 0.002;
    if (sunMoved) {
      this._lastSunDayF = dayF;
      if (this.renderer.shadowMap.enabled) this.renderer.shadowMap.needsUpdate = true;
    }

    // Звёзды
    this.stars.material.opacity = nf * (1 - this._rainFactor * 0.8 - this._fogFactor * 0.8);
    this.stars.visible = nf > 0.05 && this._rainFactor < 0.9 && this._fogFactor < 0.9;

    // Система частиц дождя с ветром (анимация на GPU через uTime) — CFG.gfx.rain=false
    // полностью выключает частицы (и апдейт uniform-ов) даже при weather==='rain'
    this.rain.visible = CFG.gfx.rain && this._rainFactor > 0.02;
    if (this.rain.visible) {
      this.rainUniforms.uTime.value += dt;
      this.rainUniforms.uOpacity.value = 0.65 * this._rainFactor;
      this.rain.position.set(this.chaseCam.position.x, 0, this.chaseCam.position.z);
    }

    // Сцепление плавно меняется в зависимости от намокания дороги
    this.player._weatherGrip = lerp(1.0, w.grip, this._rainFactor);
    return { nf, dayF, w };
  }

  /* ---------- Главный цикл ---------- */
  _loop() {
    requestAnimationFrame(() => this._loop());
    const dt = Math.min(this.clock ? this.clock.getDelta() : 0.016, 0.05);
    if (!this.clock) { this.clock = new THREE.Clock(); return; }
    const t0 = this._debugOverlay ? performance.now() : 0;
    try { this._update(dt); } catch (e) { showError(e); }

    const throttled = this._renderThrottle && this._renderThrottle > 0;
    if (throttled) {
      this._renderAccum = (this._renderAccum || 0) + dt;
      if (this._renderAccum < 1 / 15) {
        if (this._debugOverlay) this._updateDebugOverlay(dt, performance.now() - t0);
        return;
      }
      this._renderAccum = 0;
    }
    this.renderer.render(this.scene, this.camera);
    if (this._debugOverlay) this._updateDebugOverlay(dt, performance.now() - t0);
  }

  _updateDebugOverlay(dt, cpuMs) {
    this._dbgAccum = (this._dbgAccum || 0) + dt;
    this._dbgFrames = (this._dbgFrames || 0) + 1;
    if (this._dbgAccum < 0.5) return; // обновляем раз в полсекунды, а не каждый кадр
    const fps = Math.round(this._dbgFrames / this._dbgAccum);
    const info = this.renderer.info;
    if (!this._dbgEl) {
      this._dbgEl = document.createElement('div');
      this._dbgEl.style.cssText = 'position:fixed;top:4px;left:4px;z-index:9999;background:#000a;color:#7ee787;font:12px monospace;padding:6px 8px;pointer-events:none;white-space:pre;';
      document.body.appendChild(this._dbgEl);
    }
    const av = this.audio.engine.getVoiceStatus();
    const pr = this.renderer.getPixelRatio();
    const bufW = Math.round(window.innerWidth * pr), bufH = Math.round(window.innerHeight * pr);
    this._dbgEl.textContent =
      `FPS: ${fps}  CPU: ${cpuMs.toFixed(1)}ms\n` +
      `calls: ${info.render.calls}  tris: ${info.render.triangles}\n` +
      `tex: ${info.memory.textures}  geo: ${info.memory.geometries}\n` +
      `voices: ${av.used}/${av.total}  ctx: ${av.ctxState}\n` +
      `res: ${bufW}x${bufH} @${pr.toFixed(2)}`;
    this._dbgAccum = 0; this._dbgFrames = 0;
  }

  _update(dt) {
    this.input.update(dt);
    const st = this.stateName;
    if (st === 'menu') {
      this._renderThrottle = 0;
      this._menuT += dt;
      const a = this._menuT * 0.06;
      this.camera.position.set(Math.sin(a) * 120, 60, Math.cos(a) * 120);
      this.camera.lookAt(0, 8, 0);
      this._updateTime(dt);
      this.world.update(dt, 12, this.weather);
      return;
    }
    if (st === 'garage') {
      this._renderThrottle = 0;
      this._garageT += dt;
      const a = this._garageT * 0.4;
      const p = this.player;
      this.camera.position.set(p.x + Math.cos(a) * 9, p.groundY + 3.4, p.z + Math.sin(a) * 9);
      this.camera.lookAt(p.x, p.groundY + 0.6, p.z);
      this._updateTime(dt);
      this.world.update(dt, this.hour, this.weather);
      return;
    }
    if (st === 'driving') {
      this._renderThrottle = 0;
      this._drive(dt);
      return;
    }
    // пауза, карта, настройки, итоги — мир замер, троттлинг рендера
    this._renderThrottle = 1;
  }

  _drive(dt) {
    const time = this._updateTime(dt);
    const w = time.w;
    this.world.update(dt, this.hour, this.weather);

    // ввод
    const touch = this.ui.getTouchInput();
    const input = {
      throttle: Math.max(this.input.throttle, touch ? touch.gas : 0),
      brake: Math.max(this.input.brake, touch ? touch.brake : 0),
      handbrake: this.input.handbrake || (touch ? touch.hb : false),
      steer: this.input.steer + (touch ? touch.steer * 0.85 : 0),
    };
    input.steer = clamp(input.steer, -1, 1);
    this.player.setSteer(input.steer);
    this.player.update(dt, input, this.world, this.traffic);
    this.player.snapToTerrain(this.world);

    // трафик и пешеходы
    const density = w.traffic * (this.hour >= 22 || this.hour < 6 ? 0.55 : 1);
    this.traffic.update(dt, this.player, this.world, density, this.peds);
    this.peds.update(dt, this.player, this.traffic, this.world);

    // камера
    this.chaseCam.applyInput(this.input, dt);
    this.chaseCam.targetYaw = this.player.heading;
    this.chaseCam.update(dt, this.player);
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const k = this.shakeT * this.shakeAmp;
      this.chaseCam.position.x += (Math.random() - 0.5) * k;
      this.chaseCam.position.y += (Math.random() - 0.5) * k;
      this.chaseCam.position.z += (Math.random() - 0.5) * k;
    }

    // заказы
    this.orders.update(dt, this.player, this.hour, this.rating, this.upgrades.stats().capacity, this.world);

    // взаимодействие
    this._updateInteract();
    if (this.input.take('interact')) {
      this.input.flush('interact');
      if (this.interact) this.interact.cb();
    }
    if (this.input.take('horn')) this.pressHorn();
    if (this.input.take('lights')) this.toggleLights();
    if (this.input.take('radio')) this.toggleRadio();
    if (this.input.take('map')) this.toggleMap();
    if (this.input.take('pause')) this.togglePause();
    if (this.input.take('garage')) this.openGarage(this.stateName === 'menu' ? 'menu' : 'pause');
    this.input.flush();

    // километраж
    this.shiftStats.km += this.player.speed * dt / 1000;

    // звук — единый per-frame апдейт (движок, скид, гудок, позиция слушателя)
    const st = this.player.stats;
    const rpm = clamp(Math.abs(this.player.speed) / st.maxSpeed, 0, 1);

    // ближайшая машина со спецсигналами (P2: сирены) и ближайший пешеход (P2: шаги)
    let siren = null, sirenDist = 130;
    for (const c of this.traffic.cars) {
      if (!c.beacon || !c.mesh.visible) continue;
      const d = dist2D(c.x, c.z, this.player.x, this.player.z);
      if (d < sirenDist) { sirenDist = d; siren = { x: c.x, z: c.z, type: c.beacon }; }
    }
    let nearestPedDist, nearestPedPan, bestPd = 12;
    for (const p of this.peds.cars) {
      if (!p.alive || p.isAnimal || !p.mesh.visible) continue;
      const d = dist2D(p.x, p.z, this.player.x, this.player.z);
      if (d < bestPd) {
        bestPd = d; nearestPedDist = d;
        const dx = p.x - this.player.x, dz = p.z - this.player.z;
        nearestPedPan = clamp(Math.sin(Math.atan2(dx, dz) - this.player.heading), -0.85, 0.85);
      }
    }

    this.audio.updateVehicle({
      rpm, throttle: input.throttle, brake: input.brake,
      running: !this.player.engineDead,
      speed: this.player.speed, slip: this.player.slip, maxSpeed: st.maxSpeed,
      onRoad: this.player.onRoad, damage: this.player.damage,
      fuelFrac: this.player.fuel / st.tank, horn: this.player.hornTimer > 0,
      handbrake: input.handbrake, carType: st.carType, groundY: this.player.groundY,
      camDist: this.chaseCam.dist, raining: this.weather === 'rain', siren,
      nearestPedDist, nearestPedPan,
      x: this.player.x, z: this.player.z, heading: this.player.heading, hour: this.hour,
    });

    // HUD (троттлинг до ~15 Гц — DOM-запись не нуждается в 60 Гц)
    this._hudAccum = (this._hudAccum || 0) + dt;
    if (this._hudAccum >= 1 / 15) {
      this._hudAccum = 0;
      this.ui.updateHud(this.player, this, this.orders, this.hour, this.chaseCam, this.world);
    }

    // миникарта (троттлинг до ~20 Гц)
    this._minimapAccum = (this._minimapAccum || 0) + dt;
    if (this._minimapAccum >= 1 / 20) {
      this._minimapAccum = 0;
      this.ui.renderMinimap(this.player, this.orders, this.world);
    }

    // автосохранение
    this._saveTimer += dt;
    if (this._saveTimer > 30) { this._saveTimer = 0; this.save(); }
  }

  _updateInteract() {
    this.interact = null;
    const a = this.orders.active;
    if (a) {
      const drop = a.drops[a.dropIdx];
      if (dist2D(this.player.x, this.player.z, drop.x, drop.z) < 7) {
        const stops = a.drops.length > 1 ? ' (стоп ' + (a.dropIdx + 1) + '/' + a.drops.length + ')' : '';
        this.interact = { label: 'Высадить' + stops, cb: () => this.completeOrder() };
      }
    } else {
      // ближайший свободный заказ в радиусе (маркеры могут перекрываться —
      // берём именно тот, к которому подъехал игрок, а не первый в списке)
      let best = null, bd = 7;
      for (const o of this.orders.open) {
        const d = dist2D(this.player.x, this.player.z, o.pickup.x, o.pickup.z);
        if (d < bd) { bd = d; best = o; }
      }
      if (best) {
        const o = best;
        this.interact = { label: 'Взять заказ — ' + o.title, cb: () => { this.orders.accept(o, this.player); } };
      }
    }
    if (!this.interact) {
      for (const s of this.world.fuelStations) {
        if (dist2D(this.player.x, this.player.z, s.x, s.z) < CFG.refuelDist && this.player.fuel < this.player.stats.tank - 1) {
          this.interact = {
            label: 'Заправиться (' + fmtMoney(Math.round((this.player.stats.tank - this.player.fuel) * CFG.fuelPrice)) + ')',
            cb: () => this.refuel(),
          };
          break;
        }
      }
    }
    this.ui.setInteract(this.interact ? this.interact.label : null, this.interact ? this.interact.cb : null);
  }
}

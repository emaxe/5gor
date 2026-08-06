/* ============================================================
 * game.js — главный класс: цикл, состояния, время, экономика
 * ============================================================ */

class Game {
  constructor() {
    this.stateName = 'boot';
    this.money = CFG.startMoney;
    this.rating = 0;
    this.day = 1;
    this.stats = null;          // статистика за всё время
    this.shiftStats = null;     // статистика текущей смены
    this.shiftElapsed = 0;
    this.hour = CFG.shiftStartHour;
    this.weather = 'clear';
    this.interact = null;
    this.shakeT = 0; this.shakeAmp = 0;
    this._saveTimer = 0;
    this._menuT = 0;
    this._garageT = 0;
    this.soundOn = true;
    this.musicOn = true;

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

    if (save) {
      this.money = save.money; this.rating = save.rating; this.day = save.day || 1;
      this.stats = save.stats || { orders: 0, earned: 0, tips: 0, crashes: 0, peds: 0, km: 0, failed: 0, missions: 0 };
      this.soundOn = save.sound !== undefined ? save.sound : true;
      this.musicOn = save.music !== undefined ? save.music : true;
      this.weather = save.weather || this.weather;
      this.player.applyUpgrades(this.upgrades.stats());
      this.player.setTuning(this.upgrades.tuningForCar());
      this.ui.syncSettings(this.soundOn, this.musicOn, CFG.quality);
      this.ui.$('btn-continue').classList.remove('hidden');
      this.ui.toast('Есть сохранение — можно продолжить', '#7ee787');
    } else {
      this.stats = { orders: 0, earned: 0, tips: 0, crashes: 0, peds: 0, km: 0, failed: 0, missions: 0 };
    }

    // звук — только после жеста пользователя
    const unlock = () => { this.audio.unlock(); window.removeEventListener('pointerdown', unlock); };
    window.addEventListener('pointerdown', unlock);

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
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.quality === 'high' ? 1.75 : 1.25));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = CFG.quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x9cc8e8, 500, 1600);
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 3000);
    this.camera.position.set(0, 40, 90);

    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6f8f5f, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 1.2);
    this.sun.position.set(60, 90, 40);
    this.sun.castShadow = CFG.quality === 'high';
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.left = -90; this.sun.shadow.camera.right = 90;
    this.sun.shadow.camera.top = 90; this.sun.shadow.camera.bottom = -90;
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

    // дождь
    const rainGeo = new THREE.BufferGeometry();
    const rainPos = new Float32Array(350 * 3);
    for (let i = 0; i < 350; i++) {
      rainPos[i * 3] = (Math.random() - 0.5) * 200;
      rainPos[i * 3 + 1] = Math.random() * 50;
      rainPos[i * 3 + 2] = (Math.random() - 0.5) * 200;
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    this.rain = new THREE.Points(rainGeo, new THREE.PointsMaterial({ color: 0x9ab8d8, size: 0.22, transparent: true, opacity: 0.55 }));
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  _initWorld() {
    this.world = new World(this.scene);
    this.world.build();
    WORLD_INTERSECTIONS = this.world.intersections;
  }

  _initManagers() {
    this.traffic = new TrafficManager(this.scene);
    this.traffic.spawn(CFG.trafficCount, 0, 0);
    this.traffic.lightsRef = this.world.lights;

    this.peds = new PedestrianManager(this.scene);
    this.peds.spawn(CFG.pedCount, 0, 20);
    this.world.peds = this.peds;

    this.orders = new PassengerManager(this.world);

    this.player = new PlayerCar(this.scene, this.upgrades.stats());
    this.player.setTuning(this.upgrades.tuningForCar());
    this.player.setPos(0, 20, 0);
    this.player.fuel = CFG.startFuel;
    this.chaseCam = new ChaseCamera(this.camera);
    this.chaseCam.reset(this.player);
  }

  /* ---------- События ---------- */
  _initEvents() {
    Events.on('crash', (d) => {
      this.shiftStats.crashes++;
      this.audio.crash(Math.min(1, d.impact / 30));
      this.shakeT = 0.45; this.shakeAmp = Math.min(0.6, d.impact / 40);
      this.orders.onCrash(d.impact);
    });
    Events.on('hitPed', () => {
      this.shiftStats.peds++;
      this.rating = clamp(this.rating - CFG.ratingFail.hitPed, 0, 100);
      this.money = Math.max(0, this.money - 300);
      this.audio.crash(0.5);
      this.shakeT = 0.3; this.shakeAmp = 0.4;
      if (this.orders.active) this.orders.fail(this.orders.active, 'ped');
      this.ui.toast('Вы сбили пешехода! -300 ₽, рейтинг -15', '#ff6b6b');
      // сам пешеход (отлёт/лежание) обрабатывается в peds._knockDown
    });
    Events.on('stall', () => {
      this.audio.error();
      this.ui.toast('Двигатель заглох!', '#ffb030');
    });
    Events.on('noFuel', () => {
      this.ui.toast('Кончилось топливо! До заправки пешком…', '#ffb030');
      this.audio.error();
    });
    Events.on('edge', () => {
      this.ui.toast('Край карты — дальше не проехать!', '#ffb030');
    });
    Events.on('pickup', () => {
      this.audio.chime();
      this.ui.toast('Пассажир сел. Поехали!', '#7ee787');
    });
    Events.on('toast', (d) => this.ui.toast(d.text, d.color));
    Events.on('money', (d) => { /* деньги уже начислены */ });

    Events.on('orderDone', (r) => {
      this.money += r.total;
      this.shiftStats.earned += r.pay;
      this.shiftStats.tips += r.tips;
      this.shiftStats.orders++;
      const rp = CFG.ratingPerOrder[r.type] || 8;
      this.rating = clamp(this.rating + rp, 0, 100);
      if (r.missionId) {
        this.shiftStats.missions++;
        if (!this.orders.completed.includes(r.missionId)) this.orders.completed.push(r.missionId);
      }
      this.audio.cash(r.tips > 40);
      const bonus = r.tips > 0 ? ' + ' + fmtMoney(r.tips) + ' чаевых' : '';
      this.ui.toast('Заказ выполнен: +' + fmtMoney(r.pay) + bonus, '#7ee787');
      if (this.rating >= 100) this.ui.toast('Максимальный рейтинг! Пятигорск ваш! ⭐', '#ffd75e');
    });
    Events.on('fail', (d) => {
      this.shiftStats.failed++;
      this.rating = clamp(this.rating - CFG.ratingFail.failOrder, 0, 100);
      this.audio.error();
    });
  }

  /* ---------- Состояния ---------- */
  setState(name) {
    this.stateName = name;
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
    this.orders.reset();
    this.player.applyUpgrades(this.upgrades.stats());
    this.player.setTuning(this.upgrades.tuningForCar());
    this.player.setPos(0, 20, 0);
    this.player.repair();
    this.player.wash();
    this.chaseCam.reset(this.player);
    this.setState('driving');
  }

  endShift() {
    this.setState('shiftend');
    this.save();
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

  setQuality(q) {
    CFG.quality = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q === 'high' ? 1.75 : 1.25));
    this.renderer.shadowMap.enabled = q === 'high';
    this.sun.castShadow = q === 'high';
    this.ui.toast('Качество: ' + (q === 'high' ? 'высокое' : 'низкое'), '#7ee787');
  }

  /* ---------- Действия игрока ---------- */
  pressHorn() {
    if (this.stateName !== 'driving') return;
    this.player.hornTimer = 0.7;
    this.audio.horn();
  }

  toggleLights() {
    if (this.stateName !== 'driving') return;
    this.player.toggleLights();
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
    if (this.rating < c.unlockRating) { this.ui.toast('Нужен рейтинг ' + c.unlockRating, '#ffd75e'); return; }
    if (this.money < c.price) { this.ui.toast('Не хватает денег', '#ff6b6b'); return; }
    this.money -= c.price;
    this.upgrades.ownedCars.push(key);
    this.upgrades.carId = key;
    this._applyCar();
    this.audio.cash(true);
  }

  selectCar(key) {
    this.upgrades.carId = key;
    this._applyCar();
    this.audio.chime();
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
    });
  }

  /* ---------- Время и погода ---------- */
  _skyColor(hour) {
    const SKY = [
      { h: 4, c: [13, 18, 30] }, { h: 6, c: [96, 118, 148] }, { h: 9, c: [135, 176, 216] },
      { h: 13, c: [156, 200, 232] }, { h: 17, c: [150, 160, 180] }, { h: 19, c: [206, 132, 84] },
      { h: 21, c: [62, 50, 78] }, { h: 24, c: [13, 18, 30] },
    ];
    let i = 0;
    while (i < SKY.length - 2 && SKY[i + 1].h <= hour) i++;
    const a = SKY[i], b = SKY[Math.min(i + 1, SKY.length - 1)];
    const t = clamp((hour - a.h) / Math.max(0.001, b.h - a.h), 0, 1);
    return new THREE.Color(
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
    const sky = this._skyColor(this.hour);
    this.scene.background = sky;
    const fogC = sky.clone().multiplyScalar(1 - nf * 0.35);
    this.scene.fog.color.copy(fogC);
    const w = WEATHER_DEFS[this.weather];
    this.scene.fog.near = w.fogNear * (this.weather === 'fog' ? 1 : 1 - nf * 0.25);
    this.scene.fog.far = w.fogFar * (this.weather === 'fog' ? 1 : 1 - nf * 0.25);
    this.hemi.intensity = 0.35 + dayF * 0.6 - nf * 0.15;
    this.sun.intensity = 0.25 + dayF * 1.05;
    const sunY = Math.max(6, 90 * dayF + 12);
    this.sun.position.set(60, sunY, 40 - 60 * (1 - dayF));
    this.stars.material.opacity = nf * (this.weather === 'clear' ? 1 : 0.4);
    this.stars.visible = nf > 0.05;
    // дождь
    this.rain.visible = this.weather === 'rain';
    if (this.weather === 'rain') {
      const arr = this.rain.geometry.attributes.position.array;
      for (let i = 0; i < 350; i++) {
        arr[i * 3 + 1] -= 26 * dt;
        if (arr[i * 3 + 1] < 0) arr[i * 3 + 1] = 44;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
      this.rain.position.set(this.chaseCam.position.x, 0, this.chaseCam.position.z);
    }
    this.player._weatherGrip = w.grip;
    return { nf, dayF, w };
  }

  /* ---------- Главный цикл ---------- */
  _loop() {
    requestAnimationFrame(() => this._loop());
    const dt = Math.min(this.clock ? this.clock.getDelta() : 0.016, 0.05);
    if (!this.clock) { this.clock = new THREE.Clock(); return; }
    try { this._update(dt); } catch (e) { showError(e); }
    this.renderer.render(this.scene, this.camera);
  }

  _update(dt) {
    this.input.update(dt);
    const st = this.stateName;
    if (st === 'menu') {
      this._menuT += dt;
      const a = this._menuT * 0.06;
      this.camera.position.set(Math.sin(a) * 120, 60, Math.cos(a) * 120);
      this.camera.lookAt(0, 8, 0);
      this._updateTime(dt);
      this.world.update(dt, 12, this.weather);
      return;
    }
    if (st === 'garage') {
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
      this._drive(dt);
      return;
    }
    // пауза, карта, настройки, итоги — мир замер
    this.renderer.render(this.scene, this.camera);
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
    this.peds.update(dt, this.player, this.traffic);

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
    if (this.input.take('map')) this.toggleMap();
    if (this.input.take('pause')) this.togglePause();
    if (this.input.take('garage')) this.openGarage(this.stateName === 'menu' ? 'menu' : 'pause');
    this.input.flush();

    // километраж
    this.shiftStats.km += this.player.speed * dt / 1000;

    // звук
    const st = this.player.stats;
    const rpm = clamp(Math.abs(this.player.speed) / st.maxSpeed, 0, 1);
    this.audio.setEngine(rpm, input.throttle, this.player.engineDead);
    this.audio.setSkid(this.player.slip);
    if (this.player.hornTimer > 0) {
      if (!this._hornActive) { this.audio.horn(); this._hornActive = true; }
    } else {
      this._hornActive = false;
    }

    // HUD
    this.ui.updateHud(this.player, this, this.orders, this.hour, this.chaseCam, this.world);
    this.ui.renderMinimap(this.player, this.orders, this.world);

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

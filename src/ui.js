import { CFG, DISTRICTS, UPGRADES, CARS, TUNING } from './config.js';
import { fmtMoney, fmtTime, fmtClock, choice } from './utils.js';
import { Events } from './eventbus.js';

/**
 * Менеджер пользовательского интерфейса (экраны, HUD, карта, гараж, уведомления).
 */
export class UIManager {
  /**
   * @param {import('./game.js').Game} game - Главный экземпляр игры
   */
  constructor(game) {
    this.game = game;
    this.$ = (id) => document.getElementById(id);
    this._els = {};
    for (const id of [
      'money', 'rating', 'clock', 'day', 'speed-val', 'fuel-bar', 'dmg-bar', 'dirt-tip',
      'order-card', 'order-title', 'order-desc', 'order-timer', 'order-pay',
      'nav-arrow-wrap', 'nav-arrow', 'nav-dist',
    ]) this._els[id] = document.getElementById(id);
    this.screens = {
      menu: this.$('menu'), pause: this.$('pause'), garage: this.$('garage'),
      settings: this.$('settings'), map: this.$('map-screen'), shiftend: this.$('shiftend'),
    };
    this.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    this.interactCb = null;
    this._bindButtons();
    this._bindTouch();
    this._baseMap = null;
    this._garageTab = 'upgrades';
    this.toastCount = 0;
    this._dialogueTimer = null;

    Events.on('passenger:speak', (d) => this.showDialogue(d.speaker, d.text, d.avatar, d.color));
    Events.on('radio:changed', (st) => this.updateRadioDisplay(st));
  }

  /* ---------- Кнопки ---------- */
  _bindButtons() {
    const on = (id, cb) => { const el = this.$(id); if (el) el.addEventListener('click', cb); };
    // UI-звук на любой клик по кнопке — один делегированный слушатель вместо
    // правки каждой кнопки по отдельности; звучит на нажатие мышью/тачем,
    // не дублируется с клавиатурными шорткатами (у них нет 'click' на кнопке)
    document.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      this.game.audio.click();
    }, true);
    on('btn-newgame', () => this.game.newGame());
    on('btn-continue', () => this.game.continueGame());
    on('btn-menu-garage', () => this.game.openGarage('menu'));
    on('btn-menu-settings', () => this.game.openSettings('menu'));
    on('btn-resume', () => this.game.togglePause());
    on('btn-pause-garage', () => this.game.openGarage('pause'));
    on('btn-pause-settings', () => this.game.openSettings('pause'));
    on('btn-evac', () => this.game.evacuate());
    on('btn-endshift', () => this.game.endShift());
    on('btn-menu', () => this.game.toMenu());
    on('btn-garage-back', () => this.game.closeGarage());
    on('btn-settings-back', () => this.game.closeSettings());
    on('btn-map', () => this.game.toggleMap());
    on('btn-map-close', () => this.game.toggleMap());
    on('btn-pause', () => this.game.togglePause());
    on('btn-horn', () => this.game.pressHorn());
    on('btn-lights', () => this.game.toggleLights());
    on('btn-radio', () => this.game.toggleRadio());
    on('btn-repair', () => this.game.garageRepair());
    on('btn-wash', () => this.game.garageWash());
    on('btn-refuel', () => this.game.garageRefuel());
    on('btn-next-shift', () => this.game.startNewShift());
    on('btn-se-menu', () => this.game.toMenu());
    on('btn-interact', () => { if (this.interactCb) this.interactCb(); });
    on('btn-copy-err', () => { const t = this.$('err-text'); if (t) navigator.clipboard && navigator.clipboard.writeText(t.textContent); });
    on('btn-reload', () => location.reload());
    // вкладки гаража
    document.querySelectorAll('.garage-tabs button').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.garage-tabs button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        this._garageTab = b.dataset.tab;
        // renderGarage() без аргументов падает на upgrades.stats() — переключение
        // вкладки не передаёт своих данных, берём их из game (как и остальные вызовы)
        this.renderGarage(this.game.upgrades, this.game.money, this.game.player);
      });
    });
    // настройки
    on('chk-sound', () => this.game.setSound(this.$('chk-sound').checked));
    on('chk-music', () => this.game.setMusic(this.$('chk-music').checked));
    // громкости — 'input' срабатывает на каждое движение ползунка (не 'change',
    // которое ждёт отпускания), сохранение в game.setVolume уже с debounce
    const vol = (id, key) => {
      const el = this.$(id);
      if (!el) return;
      el.addEventListener('input', () => {
        const v = Number(el.value) / 100;
        this.game.setVolume(key, v);
        const label = document.querySelector('.vol-val[data-for="' + id + '"]');
        if (label) label.textContent = el.value + '%';
      });
    };
    vol('rng-vol-master', 'master');
    vol('rng-vol-music', 'music');
    vol('rng-vol-sfx', 'sfx');
    vol('rng-vol-engine', 'engine');
    vol('rng-vol-ambient', 'ambient');
    const stationSel = this.$('sel-radio-station');
    if (stationSel) {
      stationSel.addEventListener('change', () => this.game.setRadioStation(stationSel.value));
    }
    // графика: пресет применяет все поля разом и синхронизирует остальные контролы
    on('sel-gfx-preset', () => {
      const v = this.$('sel-gfx-preset').value;
      if (v === 'custom') return; // «Своё» — не пресет, а следствие ручной правки поля
      this.game.applyGfxPreset(v);
      this.syncGfxUI();
    });
    // остальные контролы — точечная правка одного поля, переключает пресет на «Своё»
    const gfxField = (id, key, parse) => on(id, () => {
      const el = this.$(id);
      const val = parse ? parse(el.value) : (el.type === 'checkbox' ? el.checked : el.value);
      this.game.applyGfx({ [key]: val, preset: 'custom' });
      this.$('sel-gfx-preset').value = 'custom';
      if (key === 'shadows') this.$('chk-shadow-actors').disabled = val !== 'high';
    });
    gfxField('sel-shadows', 'shadows');
    gfxField('chk-shadow-actors', 'shadowActors');
    gfxField('sel-pixelratio', 'pixelRatio', parseFloat);
    gfxField('sel-drawdist', 'drawDistance', Number);
    gfxField('sel-traffic-density', 'trafficDensity', parseFloat);
    gfxField('sel-ped-density', 'pedDensity', parseFloat);
    gfxField('chk-rain', 'rain');
    // клавиатура: Esc/M/G обрабатывает Game через очереди InputManager
  }

  /* ---------- Сенсорное управление: виртуальный джойстик ---------- */
  _bindTouch() {
    this.touch = { gas: 0, brake: 0, hb: false, steer: 0, joyId: null };
    if (!this.isTouch) return;
    this.$('touch-controls').classList.remove('hidden');

    // ручник — отдельная кнопка справа
    const hbBtn = this.$('btn-hb');
    if (hbBtn) {
      const hold = (key) => {
        hbBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.touch[key] = true; hbBtn._pressed = true; hbBtn.setPointerCapture(e.pointerId); });
        hbBtn.addEventListener('pointerup', () => { this.touch[key] = false; hbBtn._pressed = false; });
        hbBtn.addEventListener('pointercancel', () => { this.touch[key] = false; hbBtn._pressed = false; });
        hbBtn.addEventListener('contextmenu', (e) => e.preventDefault());
      };
      hold('hb');
    }

    // джойстик слева: по X — руль, по Y — газ (вверх) / тормоз-задний ход (вниз)
    const zone = this.$('joy-zone');
    const knob = this.$('joy-knob');
    const R = 58; // радиус хода ручки в px
    const reset = () => {
      this.touch.joyId = null;
      this.touch.gas = 0; this.touch.brake = 0; this.touch.steer = 0;
      if (knob) knob.style.transform = 'translate(-50%,-50%) translate(0px,0px)';
    };
    const move = (e) => {
      const rect = zone.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx = dx / len * R; dy = dy / len * R; }
      this.touch.steer = Math.abs(dx) < 6 ? 0 : clamp(dx / R, -1, 1);
      this.touch.gas = dy < -8 ? clamp(-dy / R, 0, 1) : 0;
      this.touch.brake = dy > 8 ? clamp(dy / R, 0, 1) : 0;
      if (knob) knob.style.transform = 'translate(-50%,-50%) translate(' + dx + 'px,' + dy + 'px)';
    };
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.touch.joyId !== null) return; // один палец на джойстике
      this.touch.joyId = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      move(e);
    });
    zone.addEventListener('pointermove', (e) => { if (this.touch.joyId === e.pointerId) move(e); });
    const end = (e) => { if (this.touch.joyId === e.pointerId) reset(); };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    zone.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  getTouchInput() {
    if (!this.isTouch) return null;
    return {
      gas: this.touch.gas,
      brake: this.touch.brake,
      hb: this.touch.hb,
      steer: this.touch.steer,
    };
  }

  /* ---------- Экраны ---------- */
  showScreen(name, show) {
    for (const k in this.screens) this.screens[k].classList.toggle('hidden', true);
    if (name) this.screens[name].classList.toggle('hidden', !show);
  }

  showHud(show) { this.$('hud').classList.toggle('hidden', !show); }

  /* ---------- HUD ---------- */
  _setText(el, text) {
    if (el.textContent !== text) el.textContent = text; // сравнение строк дешевле лишней DOM-записи
  }

  updateHud(player, gameState, orders, hour, camera, world) {
    const els = this._els;
    this._setText(els.money, fmtMoney(gameState.money));
    const stars = '★'.repeat(Math.round(gameState.rating / 20)) + '☆'.repeat(5 - Math.round(gameState.rating / 20));
    this._setText(els.rating, stars + ' ' + Math.round(gameState.rating));
    this._setText(els.clock, fmtClock(hour));
    this._setText(els.day, 'День ' + gameState.day);
    const kmh = Math.round(Math.abs(player.speed) * 3.6);
    els['speed-val'].textContent = kmh;
    els['fuel-bar'].style.width = clamp(player.fuel / player.stats.tank * 100, 0, 100) + '%';
    els['dmg-bar'].style.width = player.damage + '%';
    els['dmg-bar'].style.background = player.damage > 60 ? '#ff7b72' : 'linear-gradient(90deg,#e3b341,#ff7b72)';
    els['dirt-tip'].classList.toggle('hidden', player.dirt < 0.35);

    // карточка заказа
    const a = orders.active;
    const oc = els['order-card'];
    if (a) {
      oc.classList.remove('hidden');
      els['order-title'].textContent = a.title;
      els['order-desc'].textContent = a.drops[a.dropIdx].name;
      els['order-timer'].style.display = a.timeLimit ? '' : 'none';
      if (a.timeLimit) els['order-timer'].textContent = '⏱ ' + Math.ceil(a.timer) + ' с';
      els['order-pay'].textContent = '≈ ' + fmtMoney(a.estPay) + ' + чаевые';
    } else {
      oc.classList.add('hidden');
    }

    // стрелка-навигатор: появляется только при активном принятом задании и показывает на конечную точку (высадка/цель)
    const nw = els['nav-arrow-wrap'];
    const target = orders.activeDrop;
    if (target) {
      nw.classList.remove('hidden');
      const dx = target.x - player.x, dz = target.z - player.z;
      // ➤ указывает вправо при rotate(0) — смещаем на 90°, чтобы «вперёд» было вверх.
      // Считаем относительно КУРСА МАШИНЫ (heading), а не камеры — иначе при вращении
      // камеры мышью стрелка показывает не туда. Нормализуем в [-π, π], чтобы стрелка
      // доворачивалась кратчайшим путём, а не через 270°.
      let ang = Math.atan2(dx, dz) - player.heading - Math.PI / 2;
      ang = Math.atan2(Math.sin(ang), Math.cos(ang));
      els['nav-arrow'].style.transform = 'rotate(' + Math.round(ang * 180 / Math.PI * 10) / 10 + 'deg)';
      els['nav-dist'].textContent = Math.round(dist2D(player.x, player.z, target.x, target.z)) + ' м';
    } else {
      nw.classList.add('hidden');
    }
  }

  /* ---------- Мини-карта (heading-up: карта вращается, стрелка всегда вверх) ---------- */
  renderMinimap(player, orders, world) {
    const c = this.$('minimap');
    const g = c.getContext('2d');
    const W = c.width;
    this._ensureBaseMap(world);
    const view = 260; // видимая область в единицах мира
    const scale = W / view;
    g.clearRect(0, 0, W, W);
    g.save();
    // поворот: направление машины (heading) всегда смотрит вверх экрана
    g.translate(W / 2, W / 2);
    g.rotate(player.heading - Math.PI);
    g.translate(-player.x * scale, -player.z * scale);
    if (this._baseMap) {
      // базовая карта в пикселях: world->px = (w + 320) * (SIZE/640)
      const bsc = this._mapScale;
      const vx0 = player.x - view / 2, vz0 = player.z - view / 2;
      const srcX = (vx0 + 320) * bsc, srcY = (vz0 + 320) * bsc;
      g.drawImage(this._baseMap, srcX, srcY, view * bsc, view * bsc, vx0 * scale, vz0 * scale, view * scale, view * scale);
    }
    // маршрут до точки высадки, если взят заказ (по дорожной сетке: L-путь через
    // ближайшую вертикальную дорогу; мир-координаты уже в повёрнутом контексте)
    const activeDrop = orders.activeDrop;
    if (orders.active && activeDrop) {
      const CELL = 64;
      const vx = Math.round(player.x / CELL) * CELL;
      const rx = (x) => x * scale, rz = (z) => z * scale;
      g.strokeStyle = 'rgba(255, 214, 80, 0.9)';
      g.lineWidth = 2.5;
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(rx(player.x), rz(player.z));
      g.lineTo(rx(vx), rz(player.z));
      g.lineTo(rx(vx), rz(activeDrop.z));
      g.lineTo(rx(activeDrop.x), rz(activeDrop.z));
      g.stroke();
    }
    // заказы
    for (const o of orders.open) {
      const x = o.pickup.x * scale, y = o.pickup.z * scale;
      g.fillStyle = o.color;
      g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill();
    }
    // цель
    const drop = orders.activeDrop;
    if (drop) {
      const x = drop.x * scale, y = drop.z * scale;
      g.fillStyle = '#ff4040';
      g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, 8, 0, 7); g.stroke();
    }
    g.restore();
    // стрелка игрока — фиксированная, всегда вверх (направление машины)
    g.save();
    g.translate(W / 2, W / 2);
    g.fillStyle = '#f2c12e';
    g.beginPath();
    g.moveTo(0, -7); g.lineTo(5, 6); g.lineTo(0, 3); g.lineTo(-5, 6);
    g.closePath(); g.fill();
    g.strokeStyle = '#1a1a1a'; g.lineWidth = 1; g.stroke();
    g.restore();
  }

  /* Базовая карта города (рисуем один раз) */
  _ensureBaseMap(world) {
    if (this._baseMap) return;
    const SIZE = 680; // пикселей на 640 единиц мира
    this._mapScale = SIZE / 640;
    const c = document.createElement('canvas');
    c.width = SIZE; c.height = SIZE;
    const g = c.getContext('2d');
    const sc = SIZE / 640;
    g.fillStyle = '#182030'; g.fillRect(0, 0, SIZE, SIZE);
    // кварталы-районы лёгкой заливкой
    g.fillStyle = 'rgba(60,90,60,0.35)';
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      g.fillRect((i * 64 + 10 + 320) * sc, (j * 64 + 10 + 320) * sc, 44 * sc, 44 * sc);
    }
    // дороги
    g.fillStyle = '#39424e';
    for (let i = 0; i <= 8; i++) {
      g.fillRect((i * 64 - 6 + 320) * sc, 0, 12 * sc, SIZE);
      g.fillRect(0, (i * 64 - 6 + 320) * sc, SIZE, 12 * sc);
    }
    // озеро
    g.fillStyle = '#2e7fd0';
    g.beginPath(); g.arc((-96 + 320) * sc, (-160 + 320) * sc, 24 * sc, 0, 7); g.fill();
    // здания
    g.fillStyle = 'rgba(180,190,205,0.55)';
    for (const b of world.buildings) {
      g.fillRect((b.x0 + 320) * sc, (b.z0 + 320) * sc, (b.x1 - b.x0) * sc, (b.z1 - b.z0) * sc);
    }
    // заправки
    g.fillStyle = '#2ecc40';
    for (const s of world.fuelStations) {
      g.fillRect((s.x - 2 + 320) * sc, (s.z - 2 + 320) * sc, 4 * sc, 4 * sc);
    }
    // достопримечательности
    g.fillStyle = 'rgba(255,255,255,0.85)';
    for (const lm of world.landmarks) {
      g.beginPath(); g.arc((lm.x + 320) * sc, (lm.z + 320) * sc, 2.2 * sc, 0, 7); g.fill();
    }
    this._baseMap = c;
  }

  /* ---------- Большая карта ---------- */
  renderBigMap(player, orders, world) {
    const c = this.$('bigmap');
    const availW = window.innerWidth * 0.96, availH = window.innerHeight * 0.86;
    const size = Math.min(availW, availH);
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    this._ensureBaseMap(world);
    g.drawImage(this._baseMap, 0, 0, size, size);
    // подписи районов
    g.font = '13px system-ui'; g.fillStyle = 'rgba(255,255,255,0.85)'; g.textAlign = 'center';
    const centers = {
      center: [32, 32], kurort: [-150, -40], prigorod: [40, 180],
      sanatorii: [180, -30], mashuk: [-100, -160], proval: [-72, -160],
      rynok: [96, -32], vokzal: [160, 96],
    };
    for (const d of DISTRICTS) {
      const p = centers[d.id];
      if (!p) continue;
      const x = (p[0] + 320) / 640 * size, y = (p[1] + 320) / 640 * size;
      g.fillStyle = 'rgba(10,14,20,0.75)';
      const w = g.measureText(d.name).width + 12;
      g.fillRect(x - w / 2, y - 10, w, 20);
      g.fillStyle = d.unlock > 0 && player ? '#ffd75e' : '#e8e8e8';
      g.fillText(d.name, x, y + 4);
    }
    // заказы
    for (const o of orders.open) {
      const x = (o.pickup.x + 320) / 640 * size, y = (o.pickup.z + 320) / 640 * size;
      g.fillStyle = o.color;
      g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill();
      g.font = 'bold 11px system-ui'; g.fillStyle = '#fff'; g.textAlign = 'center';
      g.fillText(o.icon, x, y + 4);
    }
    // цель
    const drop = orders.activeDrop;
    if (drop) {
      const x = (drop.x + 320) / 640 * size, y = (drop.z + 320) / 640 * size;
      g.strokeStyle = '#ff4040'; g.lineWidth = 4;
      g.beginPath(); g.arc(x, y, 10, 0, 7); g.stroke();
      g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, 15, 0, 7); g.stroke();
    }
    // игрок
    const px = (player.x + 320) / 640 * size, py = (player.z + 320) / 640 * size;
    g.fillStyle = '#f2c12e';
    g.beginPath(); g.arc(px, py, 7, 0, 7); g.fill();
    g.strokeStyle = '#1a1a1a'; g.lineWidth = 2; g.stroke();
  }

  /* ---------- Контекстная кнопка ---------- */
  setInteract(label, cb) {
    const wrap = this.$('btn-interact-wrap');
    if (label) {
      wrap.classList.remove('hidden');
      this.$('btn-interact').textContent = label;
      this.interactCb = cb;
    } else {
      wrap.classList.add('hidden');
      this.interactCb = null;
    }
  }

  /* ---------- Диалоги пассажиров ---------- */
  /**
   * Показать всплывающее речевое облако диалога пассажира.
   * @param {string} speaker - Имя или роль говорящего
   * @param {string} text - Текст реплики
   * @param {string} [avatar='💬'] - Эмодзи-аватар
   * @param {string} [color='#f2c12e'] - Цвет акцента
   */
  showDialogue(speaker, text, avatar = '💬', color = '#f2c12e') {
    const bubble = this.$('dialogue-bubble');
    if (!bubble) return;
    const spk = this.$('dialogue-speaker');
    const txt = this.$('dialogue-text');
    const avt = this.$('dialogue-avatar');

    if (spk) spk.textContent = speaker || 'Пассажир';
    if (txt) txt.textContent = text || '';
    if (avt) avt.textContent = avatar || '💬';
    if (color) bubble.style.borderColor = color;

    bubble.classList.remove('hidden');
    bubble.style.animation = 'none';
    void bubble.offsetWidth;
    bubble.style.animation = 'bubblePop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';

    if (this._dialogueTimer) clearTimeout(this._dialogueTimer);
    this._dialogueTimer = setTimeout(() => {
      bubble.classList.add('hidden');
    }, 4800);
  }

  /* ---------- Тосты ---------- */
  toast(text, color) {
    const box = this.$('toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    if (color) el.style.borderColor = color;
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.4s'; setTimeout(() => el.remove(), 400); }, 3200);
  }

  /* ---------- Гараж ---------- */
  renderGarage(upgrades, money, player) {
    const st = upgrades.stats();
    const car = CARS[upgrades.carId];
    this.$('garage-car-name').textContent = car.name;
    this.$('garage-car-desc').textContent = car.desc;
    this.$('garage-stats').innerHTML =
      '<span>Макс. скорость: <b>' + Math.round(st.maxSpeed * 3.6) + '</b> км/ч</span>' +
      '<span>Разгон: <b>' + st.accel.toFixed(1) + '</b></span>' +
      '<span>Тормоза: <b>' + Math.round(st.brake) + '</b></span>' +
      '<span>Управление: <b>' + st.grip.toFixed(2) + '</b></span>' +
      '<span>Прочность: <b>' + st.armor.toFixed(2) + '</b></span>' +
      '<span>Бак: <b>' + st.tank + '</b> л</span>' +
      '<span>Вместимость: <b>' + st.capacity + '</b> мест</span>' +
      '<span>Урон: <b>' + Math.round(player.damage) + '%</b></span>';

    const list = this.$('garage-list');
    list.innerHTML = '';
    if (this._garageTab === 'upgrades') {
      for (const key in UPGRADES) {
        const u = UPGRADES[key];
        const lvl = upgrades.levels[key];
        const cost = upgrades.costOf(key);
        const row = document.createElement('div');
        row.className = 'up-row';
        row.innerHTML =
          '<div class="icon">' + u.icon + '</div>' +
          '<div class="info"><div class="name">' + u.name + '</div><div class="desc">' + u.desc + '</div></div>' +
          '<div class="pips">' + '●'.repeat(lvl) + '<span style="color:#4a5462">' + '●'.repeat(u.max - lvl) + '</span></div>' +
          (cost < 0 ? '<button disabled>МАКС</button>' : '<button ' + (money < cost ? 'disabled' : '') + '>' + fmtMoney(cost) + '</button>');
        if (cost >= 0 && money >= cost) {
          row.querySelector('button').addEventListener('click', () => this.game.buyUpgrade(key));
        }
        list.appendChild(row);
      }
    } else if (this._garageTab === 'tuning') {
      const tune = upgrades.tuning;
      const row1 = document.createElement('div');
      row1.className = 'tune-row';
      row1.innerHTML = '<b style="font-size:13px">Цвет:</b>';
      for (const tc of TUNING.colors) {
        const s = document.createElement('div');
        s.className = 'swatch' + (tune.color === tc.c ? ' active' : '');
        s.style.background = tc.c;
        s.addEventListener('click', () => { upgrades.tuning.color = tc.c; this.game.applyTuning(); this.renderGarage(upgrades, money, player); });
        row1.appendChild(s);
      }
      list.appendChild(row1);
      const row2 = document.createElement('div');
      row2.className = 'tune-row';
      row2.innerHTML = '<b style="font-size:13px">Диски:</b>';
      TUNING.rims.forEach((rc, i) => {
        const s = document.createElement('div');
        // swatch-<style> добавляет фоновый узор (см. style.css) — свотч
        // намекает на геометрию диска, не только на цвет заливки
        s.className = 'swatch swatch-' + (rc.style || 'disc') + (tune.rims === i ? ' active' : '');
        s.style.backgroundColor = rc.c;
        s.title = rc.name;
        s.addEventListener('click', () => { upgrades.tuning.rims = i; this.game.applyTuning(); this.renderGarage(upgrades, money, player); });
        row2.appendChild(s);
      });
      list.appendChild(row2);
      const row3 = document.createElement('div');
      row3.className = 'tune-row';
      row3.innerHTML = '<b style="font-size:13px">Спойлер:</b> <input type="checkbox" ' + (tune.spoiler ? 'checked' : '') + ' id="chk-spoiler">';
      list.appendChild(row3);
      this.$('chk-spoiler').addEventListener('change', (e) => { upgrades.tuning.spoiler = e.target.checked; this.game.applyTuning(); });
      const row4 = document.createElement('div');
      row4.className = 'tune-row';
      row4.innerHTML = '<b style="font-size:13px">Обвес:</b>';
      TUNING.bodyKits.forEach((bk, i) => {
        const active = tune.bodyKit === i;
        const b = document.createElement('button');
        b.textContent = bk.name;
        b.style.cssText = 'padding:6px 12px;font-size:12.5px;border-radius:8px;cursor:pointer;' +
          (active ? 'background:#f2c12e;color:#1a1a1a;border:1px solid #f2c12e;font-weight:700'
                  : 'background:rgba(255,255,255,0.05);color:#9aa4b0;border:1px solid rgba(255,255,255,0.12)');
        b.addEventListener('click', () => { upgrades.tuning.bodyKit = i; this.game.applyTuning(); this.renderGarage(upgrades, money, player); });
        row4.appendChild(b);
      });
      list.appendChild(row4);
      const row5 = document.createElement('div');
      row5.className = 'tune-row';
      row5.innerHTML = '<b style="font-size:13px">Декали:</b>';
      TUNING.decals.forEach((dc, i) => {
        const active = tune.decal === i;
        const b = document.createElement('button');
        b.textContent = dc.name;
        b.style.cssText = 'padding:6px 12px;font-size:12.5px;border-radius:8px;cursor:pointer;' +
          (active ? 'background:#f2c12e;color:#1a1a1a;border:1px solid #f2c12e;font-weight:700'
                  : 'background:rgba(255,255,255,0.05);color:#9aa4b0;border:1px solid rgba(255,255,255,0.12)');
        b.addEventListener('click', () => { upgrades.tuning.decal = i; this.game.applyTuning(); this.renderGarage(upgrades, money, player); });
        row5.appendChild(b);
      });
      list.appendChild(row5);
    } else if (this._garageTab === 'cars') {
      for (const key in CARS) {
        const cc = CARS[key];
        const owned = upgrades.ownedCars.includes(key);
        const isSelected = upgrades.carId === key;
        const lockedByRating = !owned && (this.game.rating < cc.unlockRating);
        const div = document.createElement('div');
        div.className = 'car-card';
        div.innerHTML =
          '<div class="name">' + cc.name + (isSelected ? ' <span style="color:#7ee787">✔ Выбрано</span>' : '') + '</div>' +
          '<div class="desc">' + cc.desc + '</div>' +
          '<div style="font-size:11.5px; color:#c9d1d9; margin-top:4px">' +
          '⚡ ' + Math.round(cc.base.maxSpeed * 3.6) + ' км/ч · 👥 ' + cc.base.capacity + ' мест · ⛽ ' + cc.base.tank + ' л · 🛡️ ' + cc.base.armor +
          '</div>' +
          (owned
            ? (isSelected ? '<div style="font-size:12px; color:#7ee787; margin-top:6px; font-weight:700">Активный автомобиль</div>' : '<button data-a="select">Выбрать</button>')
            : (lockedByRating
                ? '<button disabled style="background:#3a4350; color:#8b949e">Требуется рейтинг ' + cc.unlockRating + ' ⭐</button>'
                : '<button data-a="buy">' + fmtMoney(cc.price) + '</button>'));
        const btn = div.querySelector('button[data-a]');
        if (btn) {
          btn.addEventListener('click', () => {
            if (btn.dataset.a === 'buy') this.game.buyCar(key);
            else this.game.selectCar(key);
          });
        }
        list.appendChild(div);
      }
    }
    // кнопки обслуживания
    this.$('btn-repair').textContent = '🔧 Ремонт' + (player.damage > 0 ? ' (' + fmtMoney(Math.round(player.damage * CFG.repairCostPerDmg)) + ')' : '');
    this.$('btn-repair').disabled = player.damage <= 0;
    this.$('btn-wash').textContent = '🧼 Мойка' + (player.dirt > 0.05 ? ' (60 ₽)' : '');
    this.$('btn-wash').disabled = player.dirt <= 0.05;
    const fuelCost = Math.round((st.tank - player.fuel) * CFG.fuelPrice);
    this.$('btn-refuel').textContent = '⛽ Заправить (' + fmtMoney(fuelCost) + ')';
    this.$('btn-refuel').disabled = player.fuel >= st.tank - 1;
  }

  /* ---------- Итоги смены ---------- */
  renderShiftEnd(gameState, shiftStats) {
    const s = shiftStats;
    const g = gameState;
    const stars = '★'.repeat(Math.round(g.rating / 20)) + '☆'.repeat(5 - Math.round(g.rating / 20));
    this.$('se-stats').innerHTML =
      '<div class="big">+ ' + fmtMoney(s.earned) + '</div>' +
      'Выполнено заказов: <b>' + s.orders + '</b> (провалено: ' + s.failed + ')<br>' +
      'Чаевые: <b>' + fmtMoney(s.tips) + '</b><br>' +
      'Пройдено: <b>' + Math.round(s.km) + '</b> км<br>' +
      'Аварий: <b>' + s.crashes + '</b> · Пешеходов задето: <b>' + s.peds + '</b><br>' +
      'Рейтинг: <b>' + Math.round(g.rating) + '</b> ' + stars + '<br>' +
      'Миссий выполнено: <b>' + s.missions + '</b><br>' +
      'Накоплено: <b>' + fmtMoney(g.money) + '</b>';
  }

  /* ---------- Настройки ---------- */
  syncSettings(sound, music) {
    this.$('chk-sound').checked = sound;
    this.$('chk-music').checked = music;
    this.syncVolumeUI();
    this.syncGfxUI();
  }

  /* Слайдеры громкости + список станций — синхронизируются с audio.getVolumes()
     и audio.stations (единственный источник истины для списка станций) */
  syncVolumeUI() {
    const vols = this.game.audio.getVolumes();
    const ids = { master: 'rng-vol-master', music: 'rng-vol-music', sfx: 'rng-vol-sfx', engine: 'rng-vol-engine', ambient: 'rng-vol-ambient' };
    for (const key in ids) {
      const el = this.$(ids[key]);
      if (!el || vols[key] === undefined) continue;
      const pct = Math.round(vols[key] * 100);
      el.value = String(pct);
      const label = document.querySelector('.vol-val[data-for="' + ids[key] + '"]');
      if (label) label.textContent = pct + '%';
    }
    const sel = this.$('sel-radio-station');
    if (sel) {
      if (!sel.options.length) {
        for (const st of this.game.audio.stations) {
          const opt = document.createElement('option');
          opt.value = st.id; opt.textContent = st.icon + ' ' + st.name;
          sel.appendChild(opt);
        }
      }
      sel.value = this.game.audio.getCurrentStation().id;
    }
  }

  syncGfxUI() {
    const g = CFG.gfx;
    this.$('sel-gfx-preset').value = g.preset || 'custom';
    this.$('sel-shadows').value = g.shadows;
    this.$('chk-shadow-actors').checked = g.shadowActors;
    this.$('chk-shadow-actors').disabled = g.shadows !== 'high';
    this.$('sel-pixelratio').value = String(g.pixelRatio);
    this.$('sel-drawdist').value = String(g.drawDistance);
    this.$('sel-traffic-density').value = String(g.trafficDensity);
    this.$('sel-ped-density').value = String(g.pedDensity);
    this.$('chk-rain').checked = g.rain;
  }

  updateRadioDisplay(st) {
    const iconEl = this.$('radio-icon');
    const nameEl = this.$('radio-name');
    if (iconEl) iconEl.textContent = st.icon;
    if (nameEl) nameEl.textContent = st.name;
    this.toast(`📻 Радио: ${st.icon} ${st.name} (${st.genre})`, '#58a6ff');
    const sel = this.$('sel-radio-station');
    if (sel && sel.options.length) sel.value = st.id;
  }
}

import { CFG, DISTRICTS, UPGRADES, CARS, TUNING, MOOD_TIERS } from './config.js';
import { fmtMoney, fmtTime, fmtClock, choice, dist2D } from './utils.js';
import { routeLength } from './gps.js';
import { Events } from './eventbus.js';

const DRIVER_PALETTES = {
  shirt: [0x283848, 0x503525, 0x304030, 0x222226, 0x485868, 0x5c4033, 0x334455, 0x8a2424],
  pants: [0x1a2430, 0x2a2a3a, 0x3a3a4a, 0x4a3a2a, 0x222222, 0xd0c0aa],
  skin:  [0xffdbac, 0xf5d0b0, 0xd8a878, 0xc89060, 0xa87850],
  hair:  [0x1a1a1a, 0x3a2a1a, 0x6a4a2a, 0x8a2a2a, 0xd8c8a8, 0x8a7a6a],
};

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
      'order-card', 'order-title', 'order-progress', 'order-desc', 'order-timer', 'order-pay',
      'order-mood', 'mood-emoji', 'mood-label', 'mood-bar-fill',
      'nav-arrow-wrap', 'nav-arrow', 'nav-dist',
    ]) this._els[id] = document.getElementById(id);
    this.screens = {
      menu: this.$('menu'), pause: this.$('pause'), garage: this.$('garage'),
      settings: this.$('settings'), map: this.$('map-screen'), shiftend: this.$('shiftend'),
    };
    this.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    this.interactCb = null;
    this._interactWrap = null;
    this._interactBtn = null;
    this._lastInteractLabel = undefined;
    this._lastInteractCb = null;
    this._bindButtons();
    this._bindTouch();
    this._baseMap = null;
    this._garageTab = 'upgrades';
    this.toastCount = 0;
    this._dialogueTimer = null;
    this._lastRating = null;
    this._achBannerTimer = null;
    this._lastMoodVisible = null; // dirty-check видимости индикатора настроения
    this._lastMoodTier = -1;      // dirty-check ступени настроения
    this._lastMoodPct = -1;       // dirty-check процента полосы настроения

    Events.on('passenger:speak', (d) => this.showDialogue(d.speaker, d.text, d.avatar, d.color));
    Events.on('radio:changed', (st) => this.updateRadioDisplay(st));
    Events.on('achievement:unlocked', (ach) => this.showAchievementBanner(ach));
    Events.on('order:completed', (r) => { if (r && r.total != null) this.cashPop(r.total); });
    Events.on('crash', () => this.flashCrashVignette());
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
    on('btn-achievements', () => this.showAchievements());
    on('btn-ach-back', () => this.hideAchievements());
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
    // кастомизация водителя
    on('chk-driver-belly', () => {
      const el = this.$('chk-driver-belly');
      if (el) this.game.setDriverOption('belly', el.checked);
    });
    on('chk-driver-cap', () => {
      const el = this.$('chk-driver-cap');
      if (el) this.game.setDriverOption('cap', el.checked);
    });
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
        hbBtn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          if (this._touchWalkMode) {
            if (this.game && typeof this.game._tryPunch === 'function') {
              this.game._tryPunch();
            }
            return;
          }
          this.touch[key] = true;
          hbBtn._pressed = true;
          hbBtn.setPointerCapture(e.pointerId);
        });
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

  updateHud(player, gameState, orders, hour, camera, world, gpsRoute, fuelRoute, gpsTargetType) {
    const els = this._els;
    this._setText(els.money, fmtMoney(gameState.money));
    const stars = '★'.repeat(Math.round(gameState.rating / 20)) + '☆'.repeat(5 - Math.round(gameState.rating / 20));
    this._setText(els.rating, stars + ' ' + Math.round(gameState.rating));

    // рейтинг glow при повышении
    if (this._lastRating !== null && gameState.rating > this._lastRating) {
      els.rating.classList.remove('rating-glow');
      void els.rating.offsetWidth;
      els.rating.classList.add('rating-glow');
      setTimeout(() => els.rating.classList.remove('rating-glow'), 400);
    }
    this._lastRating = gameState.rating;

    // индикатор комбо-серии
    const streak = gameState.comboStreak || 0;
    if (streak >= 3) {
      if (!this._streakEl) {
        this._streakEl = document.createElement('span');
        this._streakEl.style.cssText = 'color:#ff9e3a;font-size:13px;font-weight:700;margin-left:6px;white-space:nowrap;';
        const moneyEl = els.money;
        if (moneyEl && moneyEl.parentNode) moneyEl.parentNode.insertBefore(this._streakEl, moneyEl.nextSibling);
      }
      this._streakEl.textContent = '🔥 x' + streak;
      this._streakEl.style.display = '';
    } else if (this._streakEl) {
      this._streakEl.style.display = 'none';
    }

    // индикатор серии опасных сближений (множитель ×2/×5/×10)
    const nmStreak = gameState._nmStreak || 0;
    let nmMult = 1;
    const nmTiers = CFG.nearMissStreakTiers || [];
    for (let i = 0; i < nmTiers.length; i++) {
      if (nmStreak >= nmTiers[i].count) nmMult = nmTiers[i].mult;
    }
    if (nmMult > 1) {
      if (!this._nmStreakEl) {
        this._nmStreakEl = document.createElement('span');
        this._nmStreakEl.style.cssText = 'color:#70d6ff;font-size:13px;font-weight:700;margin-left:6px;white-space:nowrap;';
        const moneyEl = els.money;
        if (moneyEl && moneyEl.parentNode) moneyEl.parentNode.insertBefore(this._nmStreakEl, moneyEl.nextSibling);
      }
      this._nmStreakEl.textContent = '💨 ×' + nmMult;
      this._nmStreakEl.style.display = '';
    } else if (this._nmStreakEl) {
      this._nmStreakEl.style.display = 'none';
    }
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
      // Мультистоп-прогресс: «Остановка 1/3» при нескольких точках высадки
      const dropCount = (a.drops && a.drops.length) || 1;
      if (dropCount > 1) {
        const prog = els['order-progress'];
        if (prog) {
          prog.classList.remove('hidden');
          prog.textContent = 'Остановка ' + (a.dropIdx + 1) + '/' + dropCount;
        }
      } else {
        const prog = els['order-progress'];
        if (prog) prog.classList.add('hidden');
      }
      els['order-desc'].textContent = a.drops[a.dropIdx].name;
      els['order-timer'].style.display = a.timeLimit ? '' : 'none';
      if (a.timeLimit) els['order-timer'].textContent = '⏱ ' + Math.ceil(a.timer) + ' с';
      els['order-pay'].textContent = '≈ ' + fmtMoney(a.estPay) + ' + чаевые';
    } else {
      oc.classList.add('hidden');
    }

    // Настроение пассажира (стиль вождения) — показываем только при перевозке пассажира
    this._updateMood(player, orders);

    // стрелка-навигатор: появляется только при активном принятом задании или при маршруте к заправке
    const nw = els['nav-arrow-wrap'];
    const orderTarget = orders && orders.activeDrop;
    const isFuelNav = !orderTarget && gpsTargetType === 'fuel' && fuelRoute && fuelRoute.length > 1;
    const target = orderTarget || (isFuelNav ? fuelRoute[fuelRoute.length - 1] : null);
    if (target) {
      nw.classList.remove('hidden');
      const route = orderTarget ? gpsRoute : fuelRoute;
      const hasRoute = route && route.length > 1;
      const navTarget = hasRoute ? route[1] : target;
      const dx = navTarget.x - player.x, dz = navTarget.z - player.z;
      // ➤ указывает вправо при rotate(0) — «вперёд» = -90°.
      // Раскладываем вектор к цели по осям машины: forward=(sin h,cos h),
      // right=(-cos h,sin h) — ПРАВО ИНВЕРТИРОВАНО (-X): камера сзади, поэтому
      // atan2(dx,dz)-heading (вправо=+X) давал инверсию влево/вправо.
      // Угол от оси right: ang = -atan2(forward_comp, right_comp).
      const h = player.heading;
      const fwdC = dx * Math.sin(h) + dz * Math.cos(h);
      const rgtC = -dx * Math.cos(h) + dz * Math.sin(h);
      let ang = -Math.atan2(fwdC, rgtC);
      ang = Math.atan2(Math.sin(ang), Math.cos(ang)); // кратчайший доворот в [-π,π]
      els['nav-arrow'].style.transform = 'rotate(' + Math.round(ang * 180 / Math.PI * 10) / 10 + 'deg)';
      // цвет стрелки: зелёный для заправки
      els['nav-arrow'].style.color = isFuelNav ? '#2ecc40' : '#58a6ff';
      const remainingDist = hasRoute ? routeLength(route) : dist2D(player.x, player.z, target.x, target.z);
      els['nav-dist'].textContent = Math.round(remainingDist) + ' м' + (isFuelNav ? ' ⛽' : '');
    } else {
      nw.classList.add('hidden');
    }

    // Возврат тач-кнопки ручника и сброс прозрачности при вождении
    if (this._touchWalkMode) {
      this._touchWalkMode = false;
      const hbBtn = this.$('btn-hb');
      if (hbBtn) {
        if (hbBtn.textContent !== '🛞') hbBtn.textContent = '🛞';
        hbBtn.style.opacity = '';
      }
    }
    const btnInteract = this.$('btn-interact');
    if (btnInteract && btnInteract.style.opacity !== '') {
      btnInteract.style.opacity = '';
    }
  }

  /**
   * Индикатор настроения пассажира (стиль вождения player.style, 0..1).
   * Чистое представление — не влияет на экономику/награды. Показывается только
   * при перевозке пассажира (passengerCount > 0). Dirty-check: DOM-запись только
   * при смене видимости, ступени или целого процента полосы.
   */
  _updateMood(player, orders) {
    const els = this._els;
    const moodEl = els['order-mood'];
    if (!moodEl) return;
    const hasPassenger = !!(orders && orders.active && player.passengerCount > 0);

    if (this._lastMoodVisible !== hasPassenger) {
      moodEl.classList.toggle('hidden', !hasPassenger);
      this._lastMoodVisible = hasPassenger;
      if (!hasPassenger) {
        this._lastMoodTier = -1;
        this._lastMoodPct = -1;
      }
    }
    if (!hasPassenger) return;

    const style = clamp(player.style, 0, 1);
    const pct = Math.round(style * 100);
    if (this._lastMoodPct !== pct) {
      this._lastMoodPct = pct;
      els['mood-bar-fill'].style.width = pct + '%';
    }

    let tier = 0;
    for (let i = MOOD_TIERS.length - 1; i >= 0; i--) {
      if (style >= MOOD_TIERS[i].minStyle) { tier = i; break; }
    }
    if (this._lastMoodTier !== tier) {
      this._lastMoodTier = tier;
      const mood = MOOD_TIERS[tier];
      this._setText(els['mood-emoji'], mood.emoji);
      this._setText(els['mood-label'], mood.label);
      els['mood-label'].style.color = mood.color;
      els['mood-bar-fill'].style.backgroundColor = mood.color;
    }
  }

  updateWalkHud(ped, gameState, hour, playerCar) {
    const els = this._els;
    this._setText(els.money, fmtMoney(gameState.money));
    const stars = '★'.repeat(Math.round(gameState.rating / 20)) + '☆'.repeat(5 - Math.round(gameState.rating / 20));
    this._setText(els.rating, stars + ' ' + Math.round(gameState.rating));
    this._setText(els.clock, fmtClock(hour));
    this._setText(els.day, 'День ' + gameState.day);
    const kmh = Math.round(Math.abs(ped.speed) * 3.6);
    els['speed-val'].textContent = kmh;

    // Состояние автомобиля игрока
    if (playerCar && playerCar.stats) {
      els['fuel-bar'].style.width = clamp(playerCar.fuel / playerCar.stats.tank * 100, 0, 100) + '%';
      els['dmg-bar'].style.width = playerCar.damage + '%';
      els['dmg-bar'].style.background = playerCar.damage > 60 ? '#ff7b72' : 'linear-gradient(90deg,#e3b341,#ff7b72)';
      els['dirt-tip'].classList.toggle('hidden', playerCar.dirt < 0.35);
    }

    // Заказы и навигатор скрыты в пешем режиме
    els['order-card'].classList.add('hidden');
    els['nav-arrow-wrap'].classList.add('hidden');

    // Кулдаун-индикатор кнопки взаимодействия
    const onPunchCd = ped && (ped.punchCd > 0 || ped.stunT > 0);
    const btnInteract = this.$('btn-interact');
    if (btnInteract) {
      btnInteract.style.opacity = onPunchCd ? '0.5' : '';
    }

    // Тач-кнопка удара в режиме ходьбы
    this._touchWalkMode = true;
    const hbBtn = this.$('btn-hb');
    if (hbBtn) {
      if (hbBtn.textContent !== '👊') hbBtn.textContent = '👊';
      hbBtn.style.opacity = onPunchCd ? '0.5' : '';
    }
  }

  /* ---------- Мини-карта (heading-up: карта вращается, стрелка всегда вверх) ---------- */
  renderMinimap(player, orders, world, traffic, car, gpsRoute, fuelRoute, gpsTargetType) {
    const c = this.$('minimap');
    const g = c.getContext('2d');
    const W = c.width;
    this._ensureBaseMap(world);
    const view = 260; // видимая область в единицах мира
    const scale = W / view;
    g.clearRect(0, 0, W, W);
    g.save();
    // поворот: направление игрока (heading) всегда смотрит вверх экрана
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
    // маршрут до точки высадки или заправки (по дорожной сетке: полилиния GPS-маршрута,
    // либо фолбэк на L-путь; мир-координаты уже в повёрнутом контексте)
    const activeDrop = orders && orders.activeDrop;
    const hasOrderRoute = orders && orders.active && activeDrop;
    const useFuel = !hasOrderRoute && gpsTargetType === 'fuel' && fuelRoute && fuelRoute.length > 1;
    if (hasOrderRoute || useFuel) {
      const route = useFuel ? fuelRoute : gpsRoute;
      const target = useFuel ? fuelRoute[fuelRoute.length - 1] : activeDrop;
      const rx = (x) => x * scale, rz = (z) => z * scale;
      g.strokeStyle = useFuel ? 'rgba(46, 204, 64, 0.95)' : 'rgba(255, 214, 80, 0.9)';
      g.lineWidth = 2.5;
      g.lineJoin = 'round';
      g.beginPath();
      if (route && route.length > 1) {
        g.moveTo(rx(route[0].x), rz(route[0].z));
        for (let i = 1; i < route.length; i++) {
          g.lineTo(rx(route[i].x), rz(route[i].z));
        }
      } else if (target) {
        const CELL = 64;
        const vx = Math.round(player.x / CELL) * CELL;
        g.moveTo(rx(player.x), rz(player.z));
        g.lineTo(rx(vx), rz(player.z));
        g.lineTo(rx(vx), rz(target.z));
        g.lineTo(rx(target.x), rz(target.z));
      }
      g.stroke();
    }
    // полицейские машины
    if (traffic && traffic.cars) {
      const flash = Math.floor(Date.now() / 300) % 2 === 0;
      for (const tcar of traffic.cars) {
        if (!tcar.alive || !tcar.mesh || !tcar.mesh.visible || tcar.beacon !== 'police') continue;
        const cx = tcar.x * scale, cy = tcar.z * scale;
        g.fillStyle = flash ? '#ff4040' : '#4a6aff';
        g.beginPath(); g.arc(cx, cy, 4.5, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(0, 0, 0, 0.8)'; g.lineWidth = 1;
        g.beginPath(); g.arc(cx, cy, 4.5, 0, Math.PI * 2); g.stroke();
      }
    }
    // заказы
    if (orders && orders.open) {
      for (const o of orders.open) {
        const x = o.pickup.x * scale, y = o.pickup.z * scale;
        g.fillStyle = o.color;
        g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill();
      }
    }
    // цель
    const drop = orders && orders.activeDrop;
    if (drop) {
      const x = drop.x * scale, y = drop.z * scale;
      g.fillStyle = '#ff4040';
      g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, 8, 0, 7); g.stroke();
    }
    // машина игрока в режиме пешехода
    if (car && car !== player) {
      const cx = car.x * scale, cz = car.z * scale;
      g.save();
      g.translate(cx, cz);
      g.rotate(car.heading);
      g.fillStyle = '#f2c12e';
      g.fillRect(-2.5 * scale, -5 * scale, 5 * scale, 10 * scale);
      g.strokeStyle = '#1a1a1a';
      g.lineWidth = 1;
      g.strokeRect(-2.5 * scale, -5 * scale, 5 * scale, 10 * scale);
      g.fillStyle = '#ffffff';
      g.fillRect(-1.2 * scale, -1.5 * scale, 2.4 * scale, 3 * scale);
      g.restore();
    }
    g.restore();
    // стрелка игрока — фиксированная, всегда вверх
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
  renderBigMap(player, orders, world, car, gpsRoute, fuelRoute, gpsTargetType) {
    const c = this.$('bigmap');
    const availW = window.innerWidth * 0.96, availH = window.innerHeight * 0.86;
    const size = Math.min(availW, availH);
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    this._ensureBaseMap(world);
    g.drawImage(this._baseMap, 0, 0, size, size);
    // маршрут GPS (заказ или заправка)
    const hasOrderRoute = orders && orders.active && orders.activeDrop;
    const useFuel = !hasOrderRoute && gpsTargetType === 'fuel' && fuelRoute && fuelRoute.length > 1;
    if (hasOrderRoute || useFuel) {
      const route = useFuel ? fuelRoute : gpsRoute;
      if (route && route.length > 1) {
        g.strokeStyle = useFuel ? 'rgba(46, 204, 64, 0.95)' : 'rgba(255, 214, 80, 0.9)';
        g.lineWidth = 3;
        g.lineJoin = 'round';
        g.beginPath();
        g.moveTo((route[0].x + 320) / 640 * size, (route[0].z + 320) / 640 * size);
        for (let i = 1; i < route.length; i++) {
          g.lineTo((route[i].x + 320) / 640 * size, (route[i].z + 320) / 640 * size);
        }
        g.stroke();
      }
    }
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
    if (orders && orders.open) {
      for (const o of orders.open) {
        const x = (o.pickup.x + 320) / 640 * size, y = (o.pickup.z + 320) / 640 * size;
        g.fillStyle = o.color;
        g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill();
        g.font = 'bold 11px system-ui'; g.fillStyle = '#fff'; g.textAlign = 'center';
        g.fillText(o.icon, x, y + 4);
      }
    }
    // цель
    const drop = orders && orders.activeDrop;
    if (drop) {
      const x = (drop.x + 320) / 640 * size, y = (drop.z + 320) / 640 * size;
      g.strokeStyle = '#ff4040'; g.lineWidth = 4;
      g.beginPath(); g.arc(x, y, 10, 0, 7); g.stroke();
      g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, 15, 0, 7); g.stroke();
    }
    // машина (если игрок идёт пешком)
    if (car && car !== player) {
      const cx = (car.x + 320) / 640 * size, cz = (car.z + 320) / 640 * size;
      g.fillStyle = '#f2c12e';
      g.beginPath(); g.arc(cx, cz, 6, 0, 7); g.fill();
      g.strokeStyle = '#1a1a1a'; g.lineWidth = 1.5; g.stroke();
      g.font = '10px system-ui'; g.fillStyle = '#000'; g.textAlign = 'center';
      g.fillText('🚕', cx, cz + 3);
    }
    // игрок
    const px = (player.x + 320) / 640 * size, py = (player.z + 320) / 640 * size;
    g.fillStyle = car ? '#58a6ff' : '#f2c12e';
    g.beginPath(); g.arc(px, py, 7, 0, 7); g.fill();
    g.strokeStyle = '#1a1a1a'; g.lineWidth = 2; g.stroke();
  }

  /* ---------- Контекстная кнопка ---------- */
  setInteract(label, cb) {
    const wrap = this._interactWrap || (this._interactWrap = this.$('btn-interact-wrap'));
    if (label) {
      if (this._lastInteractLabel === label && this._lastInteractCb === cb && wrap && !wrap.classList.contains('hidden')) {
        return; // состояние не изменилось
      }
      if (wrap) wrap.classList.remove('hidden');
      const btn = this._interactBtn || (this._interactBtn = this.$('btn-interact'));
      if (btn) btn.textContent = label;
      this._lastInteractLabel = label;
      this._lastInteractCb = cb;
    } else {
      if (this._lastInteractLabel === null && wrap && wrap.classList.contains('hidden')) return;
      if (wrap) wrap.classList.add('hidden');
      this._lastInteractLabel = null;
      this._lastInteractCb = null;
      const btn = this._interactBtn || (this._interactBtn = this.$('btn-interact'));
      if (btn) btn.style.opacity = '';
    }
    this.interactCb = cb || null;
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

  /* ---------- Достижения ---------- */
  showAchievements() {
    const ach = this.game.achievements;
    if (!ach) return;
    const list = ach.list();
    const count = ach.count();
    const html = list.map(a =>
      `<div class="ach-item ${a.unlocked ? 'unlocked' : 'locked'}">` +
      `<span class="ach-icon">${a.icon}</span>` +
      `<div class="ach-info"><div class="ach-name">${a.unlocked ? a.name : '???'}</div>` +
      `<div class="ach-desc">${a.desc}</div></div></div>`
    ).join('');
    this.$('ach-list').innerHTML =
      `<div style="margin-bottom:12px;font-size:14px;color:#ffd75e;">Открыто: ${count.unlocked} / ${count.total}</div>` + html;
    this.$('achievements-screen').classList.remove('hidden');
  }

  hideAchievements() {
    this.$('achievements-screen').classList.add('hidden');
  }

  /* ---------- Итоги смены ---------- */
  renderShiftEnd(gameState, shiftStats) {
    const s = shiftStats;
    const g = gameState;
    const stars = '★'.repeat(Math.round(g.rating / 20)) + '☆'.repeat(5 - Math.round(g.rating / 20));
    // Достижения
    const ach = this.game.achievements;
    const achCount = ach ? ach.count() : { unlocked: 0, total: 0 };
    const achList = ach ? ach.list().filter(a => a.unlocked) : [];
    let achHtml = '';
    if (achList.length) {
      achHtml = '<div class="ach-section"><div class="ach-title">🏆 Достижения (' + achCount.unlocked + '/' + achCount.total + ')</div>';
      achHtml += '<div class="ach-grid">' + achList.map(a => `<span class="ach-badge" title="${a.desc}">${a.icon} ${a.name}</span>`).join('') + '</div></div>';
    }
    this.$('se-stats').innerHTML =
      '<div class="big">+ ' + fmtMoney(s.earned) + '</div>' +
      'Выполнено заказов: <b>' + s.orders + '</b> (провалено: ' + s.failed + ')<br>' +
      'Чаевые: <b>' + fmtMoney(s.tips) + '</b><br>' +
      'Пройдено: <b>' + Math.round(s.km) + '</b> км<br>' +
      'Аварий: <b>' + s.crashes + '</b> · Пешеходов задето: <b>' + s.peds + '</b><br>' +
      'Опасных сближений: <b>' + (s.nearMisses || 0) + '</b> ⚡<br>' +
      'Заносов: <b>' + (s.drifts || 0) + '</b> 💨 · Идеальных остановок: <b>' + (s.perfectStops || 0) + '</b> ✨<br>' +
      'Рейтинг: <b>' + Math.round(g.rating) + '</b> ' + stars + '<br>' +
      'Миссий выполнено: <b>' + s.missions + '</b><br>' +
      'Накоплено: <b>' + fmtMoney(g.money) + '</b>' +
      achHtml;
  }

  /* ---------- Настройки ---------- */
  syncSettings(sound, music) {
    this.$('chk-sound').checked = sound;
    this.$('chk-music').checked = music;
    this.syncVolumeUI();
    this.syncGfxUI();
    this.syncDriverUI();
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

  syncDriverUI() {
    const opts = this.game.getDriverOptions();

    const chkBelly = this.$('chk-driver-belly');
    if (chkBelly) chkBelly.checked = !!opts.belly;

    const chkCap = this.$('chk-driver-cap');
    if (chkCap) chkCap.checked = opts.cap !== false;

    const swatchGroups = [
      { id: 'driver-shirt-swatches', key: 'shirtColor', colors: DRIVER_PALETTES.shirt },
      { id: 'driver-pants-swatches', key: 'pantsColor', colors: DRIVER_PALETTES.pants },
      { id: 'driver-skin-swatches',  key: 'skinColor',  colors: DRIVER_PALETTES.skin },
      { id: 'driver-hair-swatches',  key: 'hairColor',  colors: DRIVER_PALETTES.hair },
    ];

    for (const grp of swatchGroups) {
      const container = this.$(grp.id);
      if (!container) continue;
      container.innerHTML = '';
      const curVal = opts[grp.key];
      for (const color of grp.colors) {
        const s = document.createElement('div');
        const hex = '#' + color.toString(16).padStart(6, '0');
        const isActive = curVal === color;
        s.className = 'swatch' + (isActive ? ' active' : '');
        s.style.backgroundColor = hex;
        s.addEventListener('click', () => {
          this.game.setDriverOption(grp.key, color);
        });
        container.appendChild(s);
      }
    }
  }

  updateRadioDisplay(st) {
    const iconEl = this.$('radio-icon');
    const nameEl = this.$('radio-name');
    if (iconEl) iconEl.textContent = st.icon;
    if (nameEl) nameEl.textContent = st.name;
    this.toast(`📻 Радио: ${st.icon} ${st.name} (${st.genre})`, '#58a6ff');
    const sel = this.$('sel-radio-station');
    if (sel && sel.options.length) sel.value = st.id;

    // HUD-индикатор станции с частотой
    const hud = this.$('radio-hud');
    if (!hud) return;
    if (st.id === 'off') {
      hud.classList.add('hidden');
      if (this._radioHudTimer) { clearTimeout(this._radioHudTimer); this._radioHudTimer = null; }
      return;
    }
    const hudIcon = this.$('radio-hud-icon');
    const hudName = this.$('radio-hud-name');
    const hudFreq = this.$('radio-hud-freq');
    if (hudIcon) hudIcon.textContent = st.icon;
    if (hudName) hudName.textContent = st.name;
    if (hudFreq) {
      if (st.freq !== undefined) {
        hudFreq.textContent = st.freq;
        hudFreq.style.display = '';
      } else {
        hudFreq.style.display = 'none';
      }
    }
    hud.classList.remove('hidden');
    // Авто-скрытие через 3 секунды
    if (this._radioHudTimer) clearTimeout(this._radioHudTimer);
    this._radioHudTimer = setTimeout(() => {
      hud.classList.add('hidden');
      this._radioHudTimer = null;
    }, 3000);
  }

  /* ---------- Баннер достижения ---------- */
  showAchievementBanner(ach) {
    const banner = this.$('ach-banner');
    if (!banner) return;
    const iconEl = this.$('ach-banner-icon');
    const nameEl = this.$('ach-banner-name');
    if (iconEl) iconEl.textContent = ach.icon || '🏆';
    if (nameEl) nameEl.textContent = (ach.name || 'Достижение') + (ach.toast ? ' — ' + ach.toast : '');

    banner.classList.remove('hidden');
    banner.style.animation = 'none';
    void banner.offsetWidth;
    banner.style.animation = 'achBannerIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)';

    if (this._achBannerTimer) clearTimeout(this._achBannerTimer);
    this._achBannerTimer = setTimeout(() => {
      banner.classList.add('hidden');
      this._achBannerTimer = null;
    }, 2800);

    try { this.game.audio.sfx.achievementFanfare(); } catch (_) {}
  }

  /* ---------- Кэшбайн +₽ ---------- */
  cashPop(amount) {
    const moneyEl = this._els.money || this.$('money');
    if (!moneyEl) return;
    const rect = moneyEl.getBoundingClientRect();
    const span = document.createElement('span');
    span.className = 'cash-pop';
    span.textContent = '+' + fmtMoney(amount);
    span.style.left = (rect.left + rect.width / 2) + 'px';
    span.style.top = (rect.bottom + 4) + 'px';
    document.body.appendChild(span);
    setTimeout(() => span.remove(), 1200);
  }

  /* ---------- Крэш-виньетка ---------- */
  flashCrashVignette() {
    const v = this.$('crash-vignette');
    if (!v) return;
    v.classList.remove('hidden');
    v.classList.add('show');
    setTimeout(() => v.classList.remove('show'), 300);
    setTimeout(() => v.classList.add('hidden'), 600);
  }

  /* ---------- Fade-оверлеи смены ---------- */
  fadeIn() {
    const el = this.$('shift-fade');
    if (!el) return;
    el.classList.remove('hidden');
    void el.offsetWidth;
    el.classList.add('show');
  }

  fadeOut() {
    const el = this.$('shift-fade');
    if (!el) return;
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 800);
  }

  showShiftTitle(day, hour, weather) {
    this.fadeIn();
    const el = this.$('shift-fade');
    if (!el) return;
    const time = hour != null ? fmtClock(hour) : '';
    const wIcon = weather === 'rain' ? '🌧' : weather === 'night' ? '🌙' : '☀️';
    const title = document.createElement('div');
    title.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;';
    title.innerHTML = '<div style="font-size:38px;font-weight:800;color:#ffd75e;letter-spacing:3px;">ДЕНЬ ' + (day || 1) + '</div>' +
      '<div style="font-size:16px;color:#c9d1d9;letter-spacing:2px;">ПЯТИГОРСК · ' + time + ' ' + wIcon + '</div>';
    el.appendChild(title);
    setTimeout(() => {
      title.style.opacity = '0';
      title.style.transition = 'opacity 0.6s';
      setTimeout(() => { title.remove(); this.fadeOut(); }, 600);
    }, 2000);
  }
}

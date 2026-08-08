import { CFG, CFG_GFX_PRESETS, UPGRADES, CARS, TUNING } from './config.js';

export class UpgradeSystem {
  constructor() {
    this.levels = { engine: 0, suspension: 0, brakes: 0, armor: 0, tank: 0, capacity: 0 };
    this.tuning = { color: '#f2c12e', rims: 0, spoiler: false };
    this.carId = 'taxi';
    this.ownedCars = ['taxi'];
  }

  costOf(upId) {
    const u = UPGRADES[upId];
    const lvl = this.levels[upId];
    if (lvl >= u.max) return -1;
    return Math.round(u.base * Math.pow(u.mult, lvl));
  }

  buy(upId, money) {
    const cost = this.costOf(upId);
    if (cost < 0 || money < cost) return { ok: false };
    this.levels[upId]++;
    return { ok: true, cost };
  }

  /* Итоговые характеристики автомобиля */
  stats() {
    const carDef = CARS[this.carId] || CARS.taxi;
    const base = carDef.base;
    const s = { ...base, isTaxi: this.carId === 'taxi', carId: this.carId };
    s.maxSpeed += this.levels.engine * 3.2;
    s.accel += this.levels.engine * 1.6;
    s.grip += this.levels.suspension * 0.05;
    s.steer += this.levels.suspension * 0.18;
    s.brake += this.levels.brakes * 5;
    s.armor += this.levels.armor * 0.35;
    s.tank += this.levels.tank * 50;
    s.capacity += this.levels.capacity;
    return s;
  }

  /* Цвет кузова из тюнинга */
  colorHex() {
    const c = TUNING.colors.find((t) => t.c === this.tuning.color);
    return (c || TUNING.colors[0]).c;
  }

  tuningForCar() {
    const rims = TUNING.rims[this.tuning.rims];
    return {
      color: parseInt(this.tuning.color.replace('#', ''), 16),
      rims: parseInt(rims.c.replace('#', ''), 16),
      rimStyle: rims.style || 'disc',
      spoiler: this.tuning.spoiler,
    };
  }

  /* --- Сохранение --- */
  save(data) {
    try {
      localStorage.setItem('5gor_save_v1', JSON.stringify({
        money: data.money, rating: data.rating, levels: this.levels, tuning: this.tuning,
        carId: this.carId, ownedCars: this.ownedCars,
        stats: data.stats, day: data.day,
        sound: data.sound, music: data.music, quality: CFG.quality, gfx: CFG.gfx,
      }));
    } catch (e) { /* приватный режим */ }
  }

  load() {
    try {
      const raw = localStorage.getItem('5gor_save_v1');
      if (!raw) return null;
      const d = JSON.parse(raw);
      this.levels = { ...this.levels, ...(d.levels || {}) };
      this.tuning = { ...this.tuning, ...(d.tuning || {}) };
      this.carId = d.carId || 'taxi';
      this.ownedCars = d.ownedCars || ['taxi'];
      if (d.sound !== undefined) window._sndPref = d.sound;
      if (d.music !== undefined) window._musPref = d.music;
      if (d.quality) CFG.quality = d.quality;
      // gfx — новая схема; старые сохранения без неё откатываются на пресет по quality
      if (d.gfx) CFG.gfx = { ...CFG.gfx, ...d.gfx };
      else if (d.quality) CFG.gfx = { ...CFG.gfx, ...CFG_GFX_PRESETS[d.quality === 'high' ? 'high' : 'low'], preset: d.quality === 'high' ? 'high' : 'low' };
      return d;
    } catch (e) { return null; }
  }

  clear() {
    try { localStorage.removeItem('5gor_save_v1'); } catch (e) { }
  }
}

/* Новая игра: стартовое состояние */
function newGameState() {
  return {
    money: CFG.startMoney,
    rating: 0,
    day: 1,
    stats: { orders: 0, earned: 0, tips: 0, crashes: 0, peds: 0, km: 0, failed: 0, missions: 0 },
    playerPos: { x: 0, z: 20, heading: 0 },
    fuel: CFG.startFuel,
    damage: 0,
  };
}

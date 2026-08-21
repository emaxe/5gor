/* ============================================================
 * 5GOR — Полицейские штрафы
 * police.js — детект нарушений ПДД игроком при наличии патрульной машины рядом
 * ============================================================ */

import { CFG } from './config.js';
import { dist2D, clamp, segmentIntersectsAABB } from './utils.js';
import { Events } from './eventbus.js';

/**
 * @typedef {Object} ViolationConfig
 * @property {string} id - Идентификатор нарушения
 * @property {string} label - Текст для тоста
 * @property {number} fine - Сумма штрафа
 * @property {number} ratingLoss - Потеря рейтинга
 * @property {number} cooldown - Кулдаун между штрафами этого типа, сек
 */

const VIOLATIONS = {
  speeding:  { id: 'speeding',  label: 'Превышение скорости!',            fine: 300,  ratingLoss: 3,  cooldown: 8 },
  redLight:  { id: 'redLight',  label: 'Проезд на красный свет!',          fine: 500,  ratingLoss: 5,  cooldown: 10 },
  hitPed:    { id: 'hitPed',    label: 'Сбит пешеход! Штраф от полиции.',   fine: 800,  ratingLoss: 10, cooldown: 12 },
  pedPunch:  { id: 'pedPunch',  label: 'Нападение на прохожего!',          fine: 500,  ratingLoss: 5,  cooldown: 15 },
};

/** Радиус детекции нарушений патрульной машиной */
const POLICE_DETECT_RADIUS = 60;
/** Порог скорости для превышения (в игровых ед/с, ~108 км/ч) */
const SPEED_THRESHOLD = 30;

/**
 * Менеджер полицейских штрафов: отслеживает нарушения игрока,
 * если патрульная машина находится в радиусе детекции.
 */
export class PoliceManager {
  constructor() {
    /** @type {Object<string, number>} кулдауны по типам нарушений (timestamp) */
    this._cooldowns = {};
    /** @type {number} секунд до истечения текущего кулдауна */
    this._cdTimers = {};
  }

  /**
   * Проверить, есть ли полицейская машина рядом с игроком И в прямой видимости
   * (не перекрыта зданием).
   * @param {import('./player.js').PlayerCar} player - Машина игрока
   * @param {import('./traffic.js').TrafficManager} traffic - Менеджер трафика
   * @param {import('./citygen.js').World} [world] - Мир (для проверки видимости)
   * @returns {boolean}
   */
  _policeNearby(player, traffic, world) {
    if (!traffic || !traffic.cars) return false;
    for (const car of traffic.cars) {
      if (!car.alive || !car.mesh || !car.mesh.visible || car.beacon !== 'police') continue;
      const d = dist2D(car.x, car.z, player.x, player.z);
      if (d < POLICE_DETECT_RADIUS) {
        // Полиция штрафует только если видит нарушение — сквозь здания не видит
        if (!this._hasLineOfSight(car.x, car.z, player.x, player.z, world)) continue;
        return true;
      }
    }
    return false;
  }

  /**
   * Проверить прямую видимость между двумя точками (нет перекрывающих зданий).
   * Использует spatial hash зданий (ячейки 16×16м) для эффективного запроса.
   * @param {number} x0 - X первой точки (патруль)
   * @param {number} z0 - Z первой точки (патруль)
   * @param {number} x1 - X второй точки (игрок)
   * @param {number} z1 - Z второй точки (игрок)
   * @param {import('./citygen.js').World} [world]
   * @returns {boolean} true, если видимость не перекрыта зданиями
   */
  _hasLineOfSight(x0, z0, x1, z1, world) {
    if (!world) return true;
    // Обходим только ячейки, которые покрывает отрезок (bounding box отрезка).
    // Здание в соседней ячейке может дублироваться — повторный тест дешёвый,
    // Set для дедупликации не создаём (zero-alloc).
    const cell = world._buildingHashCell || 16;
    const minCx = Math.floor(Math.min(x0, x1) / cell);
    const maxCx = Math.floor(Math.max(x0, x1) / cell);
    const minCz = Math.floor(Math.min(z0, z1) / cell);
    const maxCz = Math.floor(Math.max(z0, z1) / cell);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = world._buildingHash.get(cx + ',' + cz);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          if (segmentIntersectsAABB(x0, z0, x1, z1, bucket[i])) return false;
        }
      }
    }
    return true;
  }

  /**
   * Проверить нарушение скоростного режима.
   * @param {import('./player.js').PlayerCar} player
   * @param {import('./traffic.js').TrafficManager} traffic
   * @param {import('./citygen.js').World} [world]
   */
  checkSpeeding(player, traffic, world) {
    if (this._onCooldown('speeding')) return;
    if (Math.abs(player.speed) < SPEED_THRESHOLD) return;
    // Только на дороге — не штрафуем за езду по бездорожью (там и так медленно)
    const onRoad = world ? world.onRoad(player.x, player.z) : player.onRoad;
    if (!onRoad) return;
    if (!this._policeNearby(player, traffic, world)) return;
    this._fine(VIOLATIONS.speeding);
  }

  /**
   * Проверить проезд на красный свет.
   * Вызывается из game._drive() когда игрок пересекает перекрёсток.
   * @param {import('./player.js').PlayerCar} player
   * @param {import('./traffic.js').TrafficManager} traffic
   * @param {Array} lights - Список светофоров мира
   * @param {import('./citygen.js').World} [world]
   */
  checkRedLight(player, traffic, lights, world) {
    if (this._onCooldown('redLight')) return;
    if (Math.abs(player.speed) < 3) return; // Стоит/медленно едет — не нарушение
    const onRoad = world ? world.onRoad(player.x, player.z) : player.onRoad;
    if (onRoad !== undefined && !onRoad) return; // Вне дороги светофоров нет
    if (!this._policeNearby(player, traffic, world)) return;
    if (!lights || !lights.length) return;

    const px = player.x, pz = player.z;
    // Вектор курса: forward = (sin h, cos h)
    // Движение вдоль Z если |cos(h)| > |sin(h)|, движение вдоль X если |sin(h)| > |cos(h)|
    const absCos = Math.abs(Math.cos(player.heading));
    const absSin = Math.abs(Math.sin(player.heading));
    const movingAlongZ = absCos > absSin;
    // Направление движения вдоль оси: >0 = +Z/+X, <0 = −Z/−X
    const dirZ = Math.cos(player.heading);
    const dirX = Math.sin(player.heading);

    for (const l of lights) {
      if (!l.isec) continue;
      // Светофор должен контролировать ось движения игрока
      if (movingAlongZ !== (l.axis === 'z')) continue;
      // Игрок должен быть на той же дороге, что и светофор (поперечное смещение
      // от оси дороги до столба ~8.2 м; параллельная дорога — на 64 м дальше)
      const side = movingAlongZ ? Math.abs(px - l.x) : Math.abs(pz - l.z);
      if (side > 13) continue;
      // Светофор должен быть ВПЕРЕДИ по ходу — игрок ещё не проехал перекрёсток.
      // Если он уже на дальней стороне (ahead <= 0), он пересёк стоп-линию раньше
      // (возможно на зелёный) — это не нарушение.
      const ahead = movingAlongZ
        ? (dirZ > 0 ? l.isec.z - pz : pz - l.isec.z)
        : (dirX > 0 ? l.isec.x - px : px - l.isec.x);
      if (ahead <= 0) continue;
      // Игрок должен быть ВНУТРИ перекрёстка (пересёк стоп-линию на ~6 м от центра),
      // а не просто приближаться к нему. Иначе штрафуем за подъезд к красному.
      const d = dist2D(px, pz, l.isec.x, l.isec.z);
      if (d > 8) continue;
      // state: 0 = зелёный, 1 = жёлтый, 2 = красный
      if (l.state === 2) {
        this._fine(VIOLATIONS.redLight);
        return;
      }
    }
  }

  /**
   * Сбита пешехода — штраф от полиции если рядом патруль.
   * @param {import('./player.js').PlayerCar} player
   * @param {import('./traffic.js').TrafficManager} traffic
   * @param {import('./citygen.js').World} [world]
   */
  checkHitPed(player, traffic, world) {
    if (this._onCooldown('hitPed')) return;
    if (!this._policeNearby(player, traffic, world)) return;
    this._fine(VIOLATIONS.hitPed);
  }

  /**
   * Нападение на прохожего — штраф от полиции если рядом патруль.
   * @param {import('./playerped.js').PlayerPed} playerPed
   * @param {import('./traffic.js').TrafficManager} traffic
   * @param {import('./citygen.js').World} [world]
   */
  checkPunchPed(playerPed, traffic, world) {
    if (this._onCooldown('pedPunch')) return;
    if (!this._policeNearby(playerPed, traffic, world)) return;
    this._fine(VIOLATIONS.pedPunch);
  }

  /**
   * Применить штраф: списать деньги, понизить рейтинг, показать тост.
   * @param {ViolationConfig} v
   */
  _fine(v) {
    this._cdTimers[v.id] = v.cooldown;
    Events.emit('police:fine', v);
    Events.emit('toast', { text: `🚨 ${v.label} Штраф: ${v.fine} ₽, рейтинг -${v.ratingLoss}`, color: '#ff6b6b' });
  }

  /**
   * Проверить кулдаун нарушения.
   * @param {string} id
   * @returns {boolean}
   */
  _onCooldown(id) {
    return (this._cdTimers[id] || 0) > 0;
  }

  /**
   * Обновление кулдаунов (вызывается каждый кадр).
   * @param {number} dt
   */
  update(dt) {
    for (const id in this._cdTimers) {
      if (this._cdTimers[id] > 0) {
        this._cdTimers[id] -= dt;
        if (this._cdTimers[id] < 0) this._cdTimers[id] = 0;
      }
    }
  }

  /**
   * Сброс состояния (новая смена).
   */
  reset() {
    this._cdTimers = {};
  }
}
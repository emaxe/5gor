import * as THREE from 'three';
import { CFG, LANDMARKS, DISTRICTS } from './config.js';
import { dist2D, rand, choice, pickWeighted, fmtMoney, makeMarkerTexture, makeBeamSprite, buildPedMesh, attachParcelBox, detachParcelBox } from './utils.js';
import { Events } from './eventbus.js';
import { getPassengerDialogue, PASSENGER_NAMES, CLIENT_AVATARS } from './dialogues.js';

export const ORDER_META = {
  normal:  { name: 'Обычная поездка',  icon: 'P', color: '#3e8ede', mult: 1.0,  time: 0,   desc: 'Обычная поездка по городу' },
  urgent:  { name: 'Срочный заказ',    icon: '!', color: '#e03a3a', mult: 1.6,  time: 75,  desc: 'Срочно! Пассажир торопится' },
  vip:     { name: 'VIP-клиент',       icon: 'V', color: '#d4af37', mult: 1.5,  time: 0,   desc: 'Аккуратная езда, без аварий' },
  package: { name: 'Посылка',          icon: 'Г', color: '#8a5a2a', mult: 1.15, time: 0,   desc: 'Хрупкий груз — без резких движений' },
  drunk:   { name: 'Весёлый пассажир', icon: 'Д', color: '#9a5ac0', mult: 1.35, time: 0,   desc: 'Может передумать по пути...' },
  group:   { name: 'Коллективная',     icon: 'К', color: '#3e9e6e', mult: 0.9,  time: 0,   desc: 'Несколько остановок' },
  race:    { name: 'Гонка с таксистом',icon: 'R', color: '#e86020', mult: 1.9,  time: 90,  desc: 'Обгони конкурента у вокзала!' },
  tour:    { name: 'Экскурсия',        icon: 'Т', color: '#2e9ec8', mult: 2.0,  time: 0,   desc: 'Покажите клиенту достопримечательности' },
};

const MISSION_TEMPLATES = [
  {
    id: 'grandma', type: 'mission', title: 'Бабушка на рынок', rating: 10, pay: 900, icon: 'Б', color: '#e87a3a', time: 0,
    desc: 'Бабушка Зинаида просит отвезти её на рынок «Лира». Она щедрая!',
    make(world) {
      return { pickup: Orders.pickPoint(world, 'center'), drops: [{ x: 96, z: -8, name: 'Рынок «Лира»' }] };
    },
  },
  {
    id: 'doctor', type: 'mission', title: 'Врач в санаторий', rating: 25, pay: 1200, icon: '+', color: '#d94040', time: 100,
    desc: 'Доктор Соколова опаздывает на обход. Домчите до санатория!',
    make(world) {
      return { pickup: Orders.pickPoint(world, 'vokzal'), drops: [{ x: 140, z: -80, name: 'Санаторий «Лесной»' }] };
    },
  },
  {
    id: 'race', type: 'race', title: 'Гонка с бомбилой', rating: 35, pay: 1600, icon: 'R', color: '#e86020', time: 85,
    desc: 'Конкурент вызвался наперегонки до вокзала. Успеешь — премия!',
    make(world) {
      // Финиш — реальная точка подачи у вокзала (на дороге), а не хардкод
      // (160,96) в центре квартала вокзала, куда невозможно проехать.
      const fin = Orders.pickPoint(world, 'vokzal');
      return { pickup: Orders.pickPoint(world, 'kurort'), drops: [{ x: fin.x, z: fin.z, name: 'Ж/д вокзал' }] };
    },
  },
  {
    id: 'tour', type: 'tour', title: 'Экскурсия по Пятигорску', rating: 45, pay: 2400, icon: 'Т', color: '#2e9ec8', time: 0,
    desc: 'Туристы хотят увидеть Провал, Эолову арфу и смотровую башню.',
    make(world) {
      return {
        pickup: Orders.pickPoint(world, 'center'),
        drops: [
          { x: -72, z: -160, name: 'Озеро Провал' },
          { x: 12, z: -350, name: 'Эолова арфа' },
          { x: 0, z: -448, name: 'Смотровая башня' },
        ],
      };
    },
  },
  {
    id: 'night', type: 'mission', title: 'Ночной рейс на Машук', rating: 60, pay: 1900, icon: 'М', color: '#6a6ac8', time: 130,
    desc: 'Клиент хочет встретить рассвет на Машуке. Ночью платят вдвойне!',
    make(world) {
      return { pickup: Orders.pickPoint(world, 'prigorod'), drops: [{ x: 0, z: -448, name: 'Смотровая башня' }] };
    },
  },
];

const REVIEWS = {
  5: [
    'Долетели как на крыльях!',
    'Идеально, лучший водитель Пятигорска!',
    'Чистая машина, вежливый водитель — 5 звёзд!',
    'Такое впечатление, что летели!',
  ],
  4: [
    'Норм поездка, но газку сбрасывай на поворотах',
    'Хорошо, только помыл бы машину',
    'Почти идеально, мелочи',
  ],
  3: [
    'Бывало и лучше...',
    'Резковато едешь, брат',
    'Машина как из-под трактора',
  ],
  2: [
    'Укачало всего, на горках подлетали',
    'Грязюка в салоне, чаевых не дам',
  ],
  1: [
    'Это не такси, а экстрим!',
    'Ужас, чуть не разбились!',
    'Пешком быстрее и безопаснее!',
  ],
};

/**
 * @typedef {Object} OrderPickup
 * @property {number} x - Координата X подачи
 * @property {number} z - Координата Z подачи
 * @property {string} [name] - Название точки
 * @property {string} [district] - ID района
 */

/**
 * @typedef {Object} OrderDrop
 * @property {number} x - Координата X высадки
 * @property {number} z - Координата Z высадки
 * @property {string} name - Название точки высадки
 */

/**
 * @typedef {Object} Order
 * @property {number} id - Уникальный ID заказа
 * @property {string} type - Тип заказа
 * @property {string} title - Название заказа
 * @property {string} desc - Описание заказа
 * @property {string} icon - Иконка заказа
 * @property {string} color - Цвет маркера
 * @property {string|null} missionId - ID сюжетной миссии (если есть)
 * @property {OrderPickup} pickup - Точка подачи
 * @property {OrderDrop[]} drops - Список точек назначения
 * @property {number} dropIdx - Текущий индекс точки высадки
 * @property {string} state - Статус заказа ('open'|'active'|'done'|'failed')
 * @property {number} estPay - Расчетная оплата
 * @property {number} pay - Итоговая оплата
 * @property {number} timeLimit - Лимит времени в секундах
 * @property {number} timer - Оставшееся время
 * @property {number} dist - Общая дистанция в метрах
 * @property {Object|null} marker - Ссылка на трехмерный маркер заказа
 * @property {boolean} drunkChanged - Поменял ли пьяный пассажир маршрут
 * @property {boolean} fragileBroken - Разбит ли хрупкий груз
 * @property {number} startTime - Время принятия заказа
 * @property {Object|null} [passenger] - Данные визуального пассажира
 */

/**
 * Менеджер заказов и пассажиров в игре.
 */
class PassengerManager {
  /**
   * @param {import('./citygen.js').World} world - Игровой мир
   */
  constructor(world) {
    this.world = world;
    /** @type {Order[]} доступные заказы */
    this.open = [];
    /** @type {Order|null} текущий активный заказ */
    this.active = null;
    this._id = 1;
    this._spawnT = 0.4;  // первый заказ почти сразу
    /** @type {string[]} id выполненных миссий за смену */
    this.completed = [];
    this._dropBeam = null;   // световой столб финальной точки высадки
    this._dropT = 0;
    this._cabPassenger = null; // пассажир в салоне (виден сквозь стекло)
    this._walkers = [];        // пассажиры, которые вышли и уходят
  }

  static pickPoint(world, districtId) {
    const pts = world.pickupPoints.filter((p) => p.district === districtId);
    return pts.length ? choice(pts) : choice(world.pickupPoints);
  }

  /* Случайная точка района, чаще — недалеко от игрока */
  _randPoint(districtId, player) {
    const pts = this.world.pickupPoints.filter((p) => p.district === districtId);
    if (!pts.length) return choice(this.world.pickupPoints);
    // 60%: точка в радиусе 60..240 м от игрока (чтобы заказ был достижим и виден)
    if (player && Math.random() < 0.6) {
      const near = pts.filter((p) => {
        const d = dist2D(p.x, p.z, player.x, player.z);
        return d > 40 && d < 240;
      });
      if (near.length) return choice(near);
    }
    return choice(pts);
  }

  /* Точка высадки, гарантированно расположенная НЕ МЕНЕЕ minDistance м от начальной */
  _randFarPoint(fromPt, districts, minDistance = 150, player) {
    const allPts = this.world.pickupPoints;
    const candidates = allPts.filter((p) => {
      if (districts && !districts.some((d) => d.id === p.district)) return false;
      const d = dist2D(p.x, p.z, fromPt.x, fromPt.z);
      return d >= minDistance;
    });

    if (candidates.length) return choice(candidates);

    const fallback = allPts.filter((p) => dist2D(p.x, p.z, fromPt.x, fromPt.z) >= minDistance);
    if (fallback.length) return choice(fallback);

    let maxD = 0;
    let best = allPts[0];
    for (const p of allPts) {
      const d = dist2D(p.x, p.z, fromPt.x, fromPt.z);
      if (d > maxD) { maxD = d; best = p; }
    }
    return best;
  }

  unlockedDistricts(rating) {
    return DISTRICTS.filter((d) => rating >= d.unlock);
  }

  /* --- Генерация нового заказа --- */
  spawn(rating, hour, capacity, player) {
    if (this.open.length >= CFG.maxOpenOrders) return;
    const unDistricts = this.unlockedDistricts(rating);
    if (!unDistricts.length) return;

    // миссия?
    const available = MISSION_TEMPLATES.filter((m) => rating >= m.rating && !this.completed.includes(m.id));
    if (available.length && Math.random() < 0.3) {
      const m = choice(available);
      const geo = m.make(this.world);
      const order = this._makeOrder(m.type, m.title, m.desc, geo.pickup, geo.drops, m.pay, m.time, m.icon, m.color, m.id, hour, capacity);
      if (order) { this.open.push(order); this._placeMarker(order); this._placePassenger(order); }
      return;
    }

    // обычный заказ
    const isNight = hour >= CFG.nightStartHour || hour < CFG.nightEndHour;
    const typeRoll = Math.random();
    let type = 'normal';
    if (isNight) {
      // Ночь: больше срочных и пьяных, меньше VIP/экскурсий, нет групп
      if (typeRoll < 0.30) type = 'urgent';
      else if (typeRoll < 0.42) type = 'vip';
      else if (typeRoll < 0.52) type = 'package';
      else if (typeRoll < 0.72) type = 'drunk';       // 20% — пьяные пассажиры
      else if (typeRoll < 0.78 && rating >= 15) type = 'tour';
      // остальное — normal
    } else {
      if (typeRoll < 0.20) type = 'urgent';
      else if (typeRoll < 0.32) type = 'vip';
      else if (typeRoll < 0.44) type = 'package';
      else if (typeRoll < 0.52) type = 'drunk';
      else if (typeRoll < 0.62 && capacity >= 2) type = 'group';
      else if (typeRoll < 0.70 && rating >= 15) type = 'tour';
    }

    const pickD = choice(unDistricts);
    let pickup = this._randPoint(pickD.id, player);
    // не спавнить у игрока
    for (let i = 0; i < 5 && dist2D(pickup.x, pickup.z, player.x, player.z) < 18; i++) pickup = this._randPoint(pickD.id, player);

    // Гарантируем полноценную поездку через город: дистанция между точками НЕ МЕНЕЕ 150 метров
    const MIN_TRIP_DIST = 150;
    let drops;
    if (type === 'group') {
      const p1 = this._randFarPoint(pickup, unDistricts, MIN_TRIP_DIST, player);
      const p2 = this._randFarPoint(p1, unDistricts, 130, player);
      drops = [
        { x: p1.x, z: p1.z, name: this._districtName(p1.district) },
        { x: p2.x, z: p2.z, name: this._districtName(p2.district) }
      ];
    } else if (type === 'tour') {
      const lm = this._randomLandmark(rating);
      drops = [{ x: lm.x, z: lm.z, name: lm.name }];
      if (Math.random() < 0.5) {
        const lm2 = this._randomLandmark(rating, lm.id);
        if (dist2D(lm.x, lm.z, lm2.x, lm2.z) >= 120) {
          drops.push({ x: lm2.x, z: lm2.z, name: lm2.name });
        }
      }
    } else {
      const dp = this._randFarPoint(pickup, unDistricts, MIN_TRIP_DIST, player);
      drops = [{ x: dp.x, z: dp.z, name: this._districtName(dp.district) }];
    }

    const order = this._makeOrder(type, ORDER_META[type].name, ORDER_META[type].desc, pickup, drops, null, ORDER_META[type].time, ORDER_META[type].icon, ORDER_META[type].color, null, hour, capacity);
    if (order) { this.open.push(order); this._placeMarker(order); this._placePassenger(order); }
  }

  _districtName(id) {
    const d = DISTRICTS.find((dd) => dd.id === id);
    return d ? d.name : id;
  }

  _randomLandmark(rating, excludeId) {
    const lm = this.world.landmarks.filter((l) => l.id !== excludeId && this._lmUnlock(l) <= rating);
    return lm.length ? choice(lm) : choice(this.world.landmarks);
  }

  _lmUnlock(lm) {
    const map = { proval: 15, rynok: 30, vokzal: 75, cable: 60, gazebo: 60, tower: 60 };
    return map[lm.id] || 0;
  }

  /* Создать объект заказа */
  _makeOrder(type, title, desc, pickup, drops, payOverride, timeLimit, icon, color, missionId, hour, capacity) {
    if (!pickup) return null;
    let dist = 0;
    let prev = pickup;
    for (const d of drops) { dist += Math.abs(d.x - prev.x) + Math.abs(d.z - prev.z); prev = d; }
    const estPay = payOverride || Math.round((CFG.baseFare + dist * CFG.farePerUnit) * (ORDER_META[type]?.mult || 1.0));
    const clientName = missionId === 'grandma' ? 'Бабушка Зинаида' : missionId === 'doctor' ? 'Доктор Соколова' : choice(PASSENGER_NAMES);
    const clientAvatar = CLIENT_AVATARS[type] || '👨‍💼';
    return {
      id: this._id++, type, title, desc, icon, color, missionId,
      clientName, clientAvatar,
      pickup, drops, dropIdx: 0,
      state: 'open',          // open | active | done | failed
      estPay, pay: estPay,
      timeLimit: timeLimit || 0,
      timer: timeLimit || 0,
      dist,
      marker: null,
      drunkChanged: false,
      fragileBroken: false,
      startTime: 0,
    };
  }

  /* --- Маркер на карте --- */
  _placeMarker(order) {
    const tex = makeMarkerTexture(order.color, order.icon);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(4.2, 4.2, 1);
    spr.position.set(order.pickup.x, 4.2, order.pickup.z);
    this.world.scene.add(spr);
    const beam = makeBeamSprite(order.color, 12);
    beam.position.set(order.pickup.x, 0, order.pickup.z);
    this.world.scene.add(beam);
    order.marker = { spr, beam, t: Math.random() * 6 };
  }

  /* --- Пассажир: ждёт у точки → садится → едет → выходит --- */
  _faceRoad(mesh, x, z) {
    let bx = 0, bz = 0, best = 1e9;
    for (const r of this.world.roadsV) {
      const d = Math.abs(x - r.c);
      if (d < best) { best = d; bx = r.c - x; bz = 0; }
    }
    for (const r of this.world.roadsH) {
      const d = Math.abs(z - r.c);
      if (d < best) { best = d; bx = 0; bz = r.c - z; }
    }
    const l = Math.hypot(bx, bz) || 1;
    mesh.rotation.y = Math.atan2(bx / l, bz / l);
  }

  _placePassenger(order) {
    const mesh = buildPedMesh();
    const h = this.world ? this.world.heightAt(order.pickup.x, order.pickup.z) : 0;
    mesh.position.set(order.pickup.x, h + 0.02, order.pickup.z);
    this._faceRoad(mesh, order.pickup.x, order.pickup.z);
    this.world.scene.add(mesh);
    if (order.type === 'package') {
      attachParcelBox(mesh);
    }
    order.passenger = { mesh, state: 'wait', x: order.pickup.x, z: order.pickup.z, t: rand(0, 6), walkT: 0, wx: 0, wz: 0 };
  }

  _removePassenger(order) {
    if (order.passenger) {
      if (order.passenger.mesh.parent) this.world.scene.remove(order.passenger.mesh);
      order.passenger = null;
    }
  }

  /* Пассажир в салоне (виден сквозь стекло): голова и плечи на пассажирском сиденье */
  _cabIn(player, order) {
    // bodyGroup — визуальная подгруппа кузова (крен/клевок при вождении),
    // пассажир едет вместе с ней, а не с корневой group (там же колёса)
    const parentGroup = player && (player.bodyGroup || player.group);
    if (!parentGroup) return;
    if (order && order.type === 'package') {
      this._cabOut();
      return; // Для посылки человек в салон НЕ садится!
    }
    if (!this._cabPassenger) {
      const mesh = buildPedMesh();
      for (const leg of mesh.userData.legs) leg.visible = false;
      for (const arm of mesh.userData.arms) arm.visible = false;
      mesh.scale.setScalar(0.78);
      mesh.position.set(0.55, 0.06, -0.25);
      this._cabPassenger = mesh;
    }
    if (!this._cabPassenger.parent) parentGroup.add(this._cabPassenger);
    this._cabPassenger.visible = true;
  }

  _cabOut() {
    if (this._cabPassenger) this._cabPassenger.visible = false;
  }

  /* --- Световой столб над финальной точкой высадки (подсветка в мире) --- */
  _showDropMarker(drop, dt) {
    if (!this._dropBeam) {
      this._dropBeam = makeBeamSprite('#ffd040', 13);
      this.world.scene.add(this._dropBeam);
    }
    this._dropBeam.visible = true;
    this._dropBeam.position.set(drop.x, 0, drop.z);
    this._dropT += dt;
    const s = 1.6 + Math.sin(this._dropT * 4) * 0.25;
    this._dropBeam.scale.set(s, 13, 1);
  }

  _hideDropMarker() {
    if (this._dropBeam) this._dropBeam.visible = false;
  }

  /* --- Взять заказ --- */
  /**
   * Принять заказ игроком.
   * @param {Order} order - Заказ для принятия
   * @param {import('./player.js').PlayerCar} player - Машина игрока
   * @returns {boolean} Успешно ли принят заказ
   */
  accept(order, player) {
    if (order.state !== 'open') return false;
    // Требование полной остановки машины!
    if (Math.abs(player.speed) > 0.8) {
      Events.emit('toast', { text: 'Для посадки/забора посылки полностью остановите машину!', color: '#ff9900' });
      return false;
    }

    order.state = 'active';
    order.startTime = performance.now();
    if (order.timeLimit) {
      order.timer = order.timeLimit;
    }
    this._removeMarker(order);

    // Человек у точки забора (отправитель или пассажир)
    if (order.passenger) {
      const pas = order.passenger;
      if (order.type === 'package') {
        // Отправитель передаёт посылку: убираем коробку из его рук, а сам он
        // превращается в обычного городского пешехода и уходит по своим делам
        detachParcelBox(pas.mesh);
        if (this.world && this.world.peds) {
          this.world.peds.adoptPedestrian(pas.mesh, order.pickup.x, order.pickup.z);
        }
        order.passenger = null;
      } else {
        // Обычный пассажир (и врачи/миссии) садится внутрь такси:
        // убираем 3D-модель пассажира со сцены на улице
        pas.state = 'riding';
        pas.mesh.visible = false;
        if (pas.mesh.parent) {
          pas.mesh.parent.remove(pas.mesh);
        }
      }
    }
    this._cabIn(player, order);
    this.active = order;
    this.open = this.open.filter((o) => o.id !== order.id);
    player.passengerCount = order.type === 'package' ? 0 : 1;
    player.style = 0.7;
    player.styleTimer = 0;

    // Для посылки: спавним получателя у точки доставки — он ждёт посылку
    if (order.type === 'package') {
      const drop = order.drops[order.drops.length - 1];
      const rMesh = buildPedMesh();
      const h = this.world ? this.world.heightAt(drop.x, drop.z) : 0;
      rMesh.position.set(drop.x, h + 0.02, drop.z);
      this._faceRoad(rMesh, drop.x, drop.z);
      this.world.scene.add(rMesh);
      order.recipient = { mesh: rMesh, state: 'wait', x: drop.x, z: drop.z, t: rand(0, 6) };
    }
    Events.emit('order:accepted', { order, player });
    const dlg = getPassengerDialogue('pickup', order, this.weather);
    Events.emit('passenger:speak', { speaker: dlg.name, text: dlg.text, avatar: dlg.avatar, color: dlg.color });
    return true;
  }

  _removeMarker(order) {
    if (order.marker) {
      this.world.scene.remove(order.marker.spr);
      this.world.scene.remove(order.marker.beam);
      order.marker.spr.material.dispose();
      order.marker.beam.material.dispose();
      order.marker = null;
    }
  }

  /* --- Обновление --- */
  update(dt, player, hour, rating, capacity, world, weather) {
    if (weather !== undefined) this.weather = weather;
    // спавн новых заказов — ночью реже
    const isNight = hour >= CFG.nightStartHour || hour < CFG.nightEndHour;
    this._spawnT -= dt;
    if (this._spawnT <= 0) {
      this.spawn(rating, hour, capacity, player);
      const nightGap = isNight ? CFG.orderSpawnEverySec * 1.6 : CFG.orderSpawnEverySec;
      this._spawnT = nightGap + rand(0, 4);
    }
    // таймеры открытых заказов
    for (let i = this.open.length - 1; i >= 0; i--) {
      const o = this.open[i];
      if (o.marker) {
        o.marker.t += dt;
        const s = 4.2 + Math.sin(o.marker.t * 3) * 0.6;
        o.marker.spr.scale.set(s, s, 1);
      }
      // пассажир ждёт: лёгкое покачивание
      const pas = o.passenger;
      if (pas && pas.state === 'wait') {
        pas.t += dt;
        const h = this.world ? this.world.heightAt(pas.x, pas.z) : 0;
        pas.mesh.position.y = h + 0.02 + Math.abs(Math.sin(pas.t * 2)) * 0.05;
      }
      if (o.timeLimit) {
        o.timer -= dt;
        if (o.timer <= 0) { this._removeMarker(o); this._removePassenger(o); this.open.splice(i, 1); }
      } else {
        // случайное исчезновение старых заказов
        o._age = (o._age || 0) + dt;
        if (o._age > CFG.orderExpireSec && Math.random() < dt * 0.5) { this._removeMarker(o); this._removePassenger(o); this.open.splice(i, 1); }
      }
    }

    // активный заказ
    const a = this.active;
    if (a) {
      if (a.timeLimit) {
        a.timer -= dt;
        if (a.timer <= 0) { this.fail(a, 'time'); return; }
        if (a.timer < 10) {
          const sec = Math.ceil(a.timer);
          if (sec !== a._lastWarnSec) {
            a._lastWarnSec = sec;
            Events.emit('order:timer', { left: sec });
          }
        }
      }
      const drop = a.drops[a.dropIdx];
      // подсветка финальной точки высадки в мире
      this._showDropMarker(drop, dt);
      // «пьяный» пассажир меняет маршрут на полпути
      if (a.type === 'drunk' && !a.drunkChanged) {
        const done = this._legProgress(player, drop, a);
        if (done > 0.45) {
          a.drunkChanged = true;
          const nd = this._randPoint(choice(this.unlockedDistricts(rating)).id, player);
          a.drops[a.dropIdx] = { x: nd.x, z: nd.z, name: '…передумал, едем: ' + this._districtName(nd.district) };
          a.estPay = Math.round(a.estPay * 1.3);
          Events.emit('toast', { text: 'Пассажир передумал! Новый адрес: ' + a.drops[a.dropIdx].name, color: '#c070e0' });
          const dlg = getPassengerDialogue('detour', a, this.weather);
          Events.emit('passenger:speak', { speaker: dlg.name, text: dlg.text, avatar: dlg.avatar, color: '#c070e0' });
        }
      }
      // у VIP клиент выходит при аварии
      // (обрабатывается через Events.crash в game)
      // анимация ожидания получателя посылки
      if (a.recipient && a.recipient.state === 'wait') {
        a.recipient.t += dt;
        const h = this.world ? this.world.heightAt(a.recipient.x, a.recipient.z) : 0;
        a.recipient.mesh.position.y = h + 0.02 + Math.abs(Math.sin(a.recipient.t * 2)) * 0.05;
      }
    } else {
      this._hideDropMarker();
    }

    // вышедшие пассажиры уходят (идут от дороги и исчезают)
    for (let i = this._walkers.length - 1; i >= 0; i--) {
      const p = this._walkers[i];
      p.walkT += dt;
      if (p.walkT > 6) { this.world.scene.remove(p.mesh); this._walkers.splice(i, 1); continue; }
      p.mesh.position.x += p.wx * 1.8 * dt;
      p.mesh.position.z += p.wz * 1.8 * dt;
      const ph = p.walkT * 9;
      const u = p.mesh.userData;
      if (u && u.legs) {
        u.legs[0].rotation.x = Math.sin(ph) * 0.55;
        u.legs[1].rotation.x = -Math.sin(ph) * 0.55;
        u.arms[0].rotation.x = -Math.sin(ph) * 0.4;
        u.arms[1].rotation.x = Math.sin(ph) * 0.4;
      }
    }
  }

  _legProgress(player, drop, order) {
    const d0 = order.dist || 1;
    const legDist = Math.abs(drop.x - order.pickup.x) + Math.abs(drop.z - order.pickup.z);
    const remaining = Math.abs(player.x - drop.x) + Math.abs(player.z - drop.z);
    return clamp(1 - remaining / Math.max(legDist, 1), 0, 1);
  }

  /* --- Завершение поездки --- */
  complete(player, hour, rating) {
    const a = this.active;
    if (!a) return null;
    const drop = a.drops[a.dropIdx];
    const dist = dist2D(player.x, player.z, drop.x, drop.z);
    if (dist > 7) return null;

    // Требование полной остановки машины!
    if (Math.abs(player.speed) > 0.8) {
      Events.emit('toast', { text: 'Для высадки/передачи посылки полностью остановите машину!', color: '#ff9900' });
      return null;
    }

    // финальная остановка?
    const isLast = a.dropIdx >= a.drops.length - 1;
    if (!isLast) {
      // следующая остановка
      a.dropIdx++;
      Events.emit('toast', { text: 'Следующая остановка: ' + a.drops[a.dropIdx].name, color: '#3e9e6e' });
      return { partial: true };
    }
    // расчёт оплаты
    const night = hour >= CFG.nightStartHour || hour < CFG.nightEndHour;
    const timeFrac = a.timeLimit ? clamp(1 - a.timer / a.timeLimit, 0, 1) : 0;
    let pay = a.estPay;
    if (a.timeLimit) pay = Math.round(pay * (1 + CFG.timeBonusMax * (1 - timeFrac)));
    if (night) pay = Math.round(pay * CFG.nightMult);
    if (rating >= 60) pay = Math.round(pay * 1.15); // премиум-клиенты
    // чаевые за стиль
    const dirtPenalty = 1 - player.dirt * 0.5;
    const tips = Math.round(CFG.tipsMax * player.style * (a.type === 'vip' ? 1.5 : 1) * dirtPenalty);
    if (a.type === 'package' && a.fragileBroken) pay = Math.round(pay * 0.5);
    const total = pay + tips;

    // оценка пассажира (1-5 звёзд)
    let stars = 5;
    stars -= Math.round((1 - player.style) * 3);
    if (player.dirt > 0.4) stars -= 1;
    if (a.fragileBroken) stars -= 2;
    stars = Math.max(1, Math.min(5, Math.round(stars)));
    if (a.type === 'vip' && stars < 4) stars -= 1;
    stars = Math.max(1, Math.min(5, Math.round(stars)));
    const pool = REVIEWS[stars] || REVIEWS[3];
    const review = choice(pool);

    this.active = null;
    this._hideDropMarker();
    this._cabOut();

    if (a.type === 'package') {
      // Для посылки: передаём коробку ожидающему получателю (спавнится при accept)
      // и он уходит по своим делам как обычный пешеход
      if (a.recipient && a.recipient.mesh) {
        attachParcelBox(a.recipient.mesh);
        if (this.world && this.world.peds) {
          this.world.peds.adoptPedestrian(a.recipient.mesh, drop.x, drop.z);
        }
        a.recipient = null;
      } else {
        // Фолбэк: если получатель пропал (фол от старого кода), создаём нового
        const recipientMesh = buildPedMesh();
        const h = this.world ? this.world.heightAt(drop.x, drop.z) : 0;
        recipientMesh.position.set(drop.x, h + 0.02, drop.z);
        this.world.scene.add(recipientMesh);
        attachParcelBox(recipientMesh);
        if (this.world && this.world.peds) {
          this.world.peds.adoptPedestrian(recipientMesh, drop.x, drop.z);
        }
      }
    } else {
      // Для пассажира: высаживаем его из машины, он выходит на тротуар и уходит
      const pas = a.passenger;
      if (pas && pas.mesh) {
        pas.mesh.visible = true;
        this.world.scene.add(pas.mesh);
        const offsetSide = Math.random() < 0.5 ? 1.5 : -1.5;
        pas.mesh.position.set(drop.x + offsetSide, 0, drop.z + offsetSide);
        let bx = 0, bz = 0, best = 1e9;
        for (const r of this.world.roadsV) {
          const d = Math.abs(drop.x - r.c);
          if (d < best) { best = d; bx = drop.x - r.c; bz = 0; }
        }
        for (const r of this.world.roadsH) {
          const d = Math.abs(drop.z - r.c);
          if (d < best) { best = d; bx = 0; bz = drop.z - r.c; }
        }
        const l = Math.hypot(bx, bz) || 1;
        const walkerObj = {
          mesh: pas.mesh,
          state: 'walk',
          walkT: 0,
          wx: bx / l,
          wz: bz / l
        };
        pas.mesh.rotation.y = Math.atan2(walkerObj.wx, walkerObj.wz);
        this._walkers.push(walkerObj);
      }
    }

    player.passengerCount = 0;
    const res = {
      title: a.title, pay: pay, tips, total, type: a.type, missionId: a.missionId,
      est: a.estPay, dist: a.dist, partial: false, stars, review,
    };
    const dlg = getPassengerDialogue('dropoff', a, this.weather);
    Events.emit('passenger:speak', { speaker: dlg.name, text: dlg.text, avatar: dlg.avatar, color: '#7ee787' });
    Events.emit('order:rated', { stars, review, type: a.type, total });
    Events.emit('order:completed', res);
    return res;
  }

  /* --- Провал заказа --- */
  /**
   * Считать заказ проваленным.
   * @param {Order} a - Заказ
   * @param {string} reason - Причина провала ('time'|'vip'|'crash')
   */
  fail(a, reason) {
    if (!this.active || this.active.id !== a.id) return;
    this.active = null;
    this._hideDropMarker();
    this._cabOut();
    this._removePassenger(a);
    // Удаляем ожидающего получателя посылки
    if (a.recipient && a.recipient.mesh) {
      if (a.recipient.mesh.parent) this.world.scene.remove(a.recipient.mesh);
      a.recipient = null;
    }
    Events.emit('order:failed', { reason, order: a });
    Events.emit('toast', { text: reason === 'time' ? 'Заказ провален: время вышло!' : 'Пассажир ушёл!', color: '#e05050' });
  }

  /* Авария во время поездки (вызывается из game при crash) */
  /**
   * Обработка столкновения во время поездки.
   * @param {number} impact - Сила удара
   * @returns {number} Штраф (если есть)
   */
  onCrash(impact) {
    const a = this.active;
    if (!a) return;
    if (a.type === 'package') a.fragileBroken = true;
    if (impact > 8) {
      const dlg = getPassengerDialogue('crash', a, this.weather);
      Events.emit('passenger:speak', { speaker: dlg.name, text: dlg.text, avatar: '😱', color: '#ff6b6b' });
    }
    if (a.type === 'vip' && impact > 12) {
      this.fail(a, 'vip');
      Events.emit('toast', { text: 'VIP-клиент в шоке и ушёл. -100 ₽', color: '#e05050' });
      return -100;
    }
    return 0;
  }

  markerPositions() {
    return this.open.map((o) => ({ x: o.pickup.x, z: o.pickup.z, icon: o.icon, color: o.color, title: o.title }));
  }

  get activeDrop() {
    return this.active ? this.active.drops[this.active.dropIdx] : null;
  }

  reset() {
    for (const o of this.open) { this._removeMarker(o); this._removePassenger(o); }
    // Удаляем получателя посылки если активный заказ был типа package
    if (this.active && this.active.recipient && this.active.recipient.mesh) {
      if (this.active.recipient.mesh.parent) this.world.scene.remove(this.active.recipient.mesh);
    }
    this.open = [];
    this.active = null;
    this.completed = [];
    this._hideDropMarker();
    this._cabOut();
    for (const p of this._walkers) this.world.scene.remove(p.mesh);
    this._walkers = [];
  }
}

export const Orders = PassengerManager;
export const OrdersManager = PassengerManager;
export { PassengerManager, MISSION_TEMPLATES };

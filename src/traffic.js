import * as THREE from 'three';
import { CFG } from './config.js';
import { rand, clamp, choice, lerpAngle, makeTaxiTexture, makePlateTexture, mergeColored, makeSpeechSprite, updateSpeechSprite } from './utils.js';
import { Events } from './eventbus.js';

const _tempTrafficWp = { x: 0, z: 0 };
const _tempTrafficFrom = { x: 0, z: 0 };
const _tempTrafficTo = { x: 0, z: 0 };
const _tempLightRet = { dist: 0, state: 0 };

const DRIVER_RAM_QUOTES = [
  "Куда прёшь, дрова везёшь?!",
  "Смотри куда рулишь, шумахер!",
  "Права за салом купил?!",
  "Эй! Машину помнёшь!",
  "Ты у меня щас за ремонт заплатишь!",
  "Тормоза проверь, ведро!",
  "Ослеп что ли, осел?!"
];

const DRIVER_PED_QUOTES = [
  "Куда под колёса лезешь?!",
  "Шевелись на зебре!",
  "Зелёный не вечный!",
  "Давай быстрей, сайгак!",
  "Смотри по сторонам, пешеход!"
];

const DRIVER_HIT_PED_QUOTES = [
  "Ослеп что ли под колёса прыгать?!",
  "Куда выскочил, осел?!",
  "Сумасшедший! Чуть насмерть не сбил!"
];

const PED_REPLY_QUOTES = [
  "На зебре я главный!",
  "Подождёшь, не трамвай!",
  "Красный горит, куда сигналишь?!",
  "Не дрова везёшь, подождёшь!",
  "Сам пешком иди!"
];

export const TRAFFIC_TYPES = [
  { name: 'sedan', r: 2.0, len: 4.4, w: 1.9, colors: [0xe8e8e8, 0x9aa0a8, 0x5060a0, 0xb03030, 0x2a2a2a, 0xc0a070] },
  { name: 'suv', r: 2.2, len: 4.8, w: 2.0, colors: [0x3a4a3a, 0x505860, 0x8a7050, 0x2a2a2a] },
  { name: 'van', r: 2.3, len: 5.2, w: 2.1, colors: [0xd8d8d0, 0xa8b8a0, 0xc8a060, 0xe8e0d0] },
  { name: 'truck', r: 2.6, len: 7.0, w: 2.3, colors: [0x6a7a8a, 0x9a6a4a, 0x4a5a6a] },
  { name: 'taxi', r: 2.0, len: 4.4, w: 1.9, colors: [0xf2c12e] },
];

/**
 * Менеджер городского трафика (управление автомобилями NPC, перекрестками и светофорами).
 */
export class TrafficManager {
  /**
   * @param {THREE.Scene} scene - Трёхмерная сцена Three.js
   */
  constructor(scene) {
    this.scene = scene;
    /** @type {Array<Object>} список активных автомобилей трафика */
    this.cars = [];
    this._geo = new Map();        // тип -> merged-геометрия кузова
    this.matColored = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.matBodyTex = new THREE.MeshLambertMaterial({ map: makeTaxiTexture('#f2c12e') });
    this.lightsRef = [];          // [{isec:{x,z}, state}] — от мира

    // Водители сигналят и ругаются при таране игроком
    Events.on('crash', (d) => {
      if (d && d.victim === 'car' && d.car && d.impact > 3) {
        Events.emit('horn');
        this.say(d.car, choice(DRIVER_RAM_QUOTES), 3.0);
      }
    });
  }

  /* --- Сборка модели типа (каждый вызов — новая машина) --- */
  _buildCar(type) {
    const def = TRAFFIC_TYPES[type];
    const grp = new THREE.Group();
    const isTruck = type === 3;
    const isTaxi = type === 4;
    const bodyCol = isTaxi ? null : choice(def.colors);
    const glassCol = 0x1c2430;
    const darkCol = 0x22262c;
    const lightCol = 0xf4f6f8;

    const parts = [];
    const addBox = (w, h, d, col, x, y, z) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y, z);
      parts.push({ g, c: col });
    };

    // нижняя часть кузова (пороги)
    addBox(def.w * 0.98, 0.42, def.len, bodyCol || 0xe8b92e, 0, 0.72, 0);
    // капот (перед) и багажник (зад) — чуть выше, уже
    addBox(def.w * 0.92, 0.24, def.len * 0.34, bodyCol || 0xf2c12e, 0, 0.98, def.len * 0.31);
    addBox(def.w * 0.92, 0.24, def.len * 0.3, bodyCol || 0xf2c12e, 0, 0.98, -def.len * 0.29);
    // кабина: стекло (тёмное) + крыша
    addBox(def.w * 0.86, 0.46, def.len * 0.42, glassCol, 0, 1.32, -def.len * 0.02);
    addBox(def.w * 0.8, 0.1, def.len * 0.4, bodyCol || 0xf2c12e, 0, 1.58, -def.len * 0.02);
    // бамперы
    addBox(def.w * 1.06, 0.2, 0.2, darkCol, 0, 0.56, def.len / 2 + 0.12);
    addBox(def.w * 1.06, 0.2, 0.2, darkCol, 0, 0.56, -def.len / 2 - 0.12);
    // боковые зеркала
    addBox(0.14, 0.1, 0.12, bodyCol || 0xf2c12e, def.w / 2 + 0.06, 1.06, def.len * 0.22);
    addBox(0.14, 0.1, 0.12, bodyCol || 0xf2c12e, -(def.w / 2 + 0.06), 1.06, def.len * 0.22);

    if (isTruck) {
      // грузовик: кабина смещена вперёд, сзади высокий кузов
      parts.length = 0;
      addBox(def.w * 0.98, 0.4, def.len * 0.2, darkCol, 0, 0.62, def.len * 0.36);
      addBox(def.w * 0.9, 0.5, 0.9, choice(def.colors), 0, 1.0, def.len * 0.36);
      addBox(def.w * 0.84, 0.3, 0.7, glassCol, 0, 1.36, def.len * 0.36);
      addBox(def.w * 0.96, 1.5, def.len * 0.55, choice(def.colors), 0, 1.35, -def.len * 0.1);
      addBox(def.w * 1.06, 0.2, 0.2, darkCol, 0, 0.56, def.len / 2 + 0.12);
      addBox(def.w * 1.06, 0.2, 0.2, darkCol, 0, 0.56, -def.len / 2 - 0.12);
    }

    let bodyMesh;
    if (isTaxi) {
      // такси: весь кузов с текстурой «шашечек» — одна текстурированная часть
      const g = new THREE.BoxGeometry(def.w, 0.42, def.len);
      bodyMesh = new THREE.Mesh(g, this.matBodyTex);
      bodyMesh.position.y = 0.72;
      grp.add(bodyMesh);
      // кабина поверх
      const cab = new THREE.Mesh(new THREE.BoxGeometry(def.w * 0.86, 0.46, def.len * 0.42), new THREE.MeshLambertMaterial({ color: glassCol }));
      cab.position.set(0, 1.32, -def.len * 0.02);
      grp.add(cab);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(def.w * 0.8, 0.1, def.len * 0.4), new THREE.MeshLambertMaterial({ color: 0xf2c12e }));
      roof.position.set(0, 1.58, -def.len * 0.02);
      grp.add(roof);
    } else {
      const merged = mergeColored(parts);
      bodyMesh = new THREE.Mesh(merged, this.matColored);
      grp.add(bodyMesh);
    }

    // фары и стоп-сигналы (отдельные меши — яркие цвета)
    const headMat = new THREE.MeshLambertMaterial({ color: 0xfff8e0, emissive: 0x665522 });
    const stopMat = new THREE.MeshLambertMaterial({ color: 0xff2020, emissive: 0x551111 });
    for (const s of [-1, 1]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.1), headMat);
      hl.position.set(s * def.w * 0.34, 0.9, def.len / 2 + 0.06);
      grp.add(hl);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.1), stopMat);
      tl.position.set(s * def.w * 0.34, 0.9, -def.len / 2 - 0.06);
      grp.add(tl);
    }
    // номерной знак сзади
    const plateMat = new THREE.MeshLambertMaterial({ map: makePlateTexture() });
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.05), plateMat);
    plate.position.set(0, 0.62, -def.len / 2 - 0.16);
    grp.add(plate);

    // колёса: шина + диск
    const wheelZ = [def.len * 0.3, -def.len * 0.3];
    for (const sx of [-1, 1]) for (const sz of wheelZ) {
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.3, 10), new THREE.MeshLambertMaterial({ color: 0x1a1a1c }));
      tire.rotation.z = Math.PI / 2;
      tire.position.set(sx * (def.w / 2 + 0.05), 0.46, sz);
      grp.add(tire);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.32, 8), new THREE.MeshLambertMaterial({ color: lightCol }));
      rim.rotation.z = Math.PI / 2;
      rim.position.set(sx * (def.w / 2 + 0.05), 0.46, sz);
      grp.add(rim);
    }
    // антенна на крыше (не у грузовика — у него кузов)
    if (!isTruck) {
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.5, 4), new THREE.MeshLambertMaterial({ color: darkCol }));
      ant.position.set(-def.w * 0.28, 1.72, -def.len * 0.1);
      grp.add(ant);
    }
    // ручки дверей
    for (const s of [-1, 1]) {
      const hd = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.34), new THREE.MeshLambertMaterial({ color: darkCol }));
      hd.position.set(s * (def.w / 2 + 0.02), 0.82, -def.len * 0.08);
      grp.add(hd);
    }
    // шашечки на крыше такси
    if (isTaxi) {
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.22, 0.35), new THREE.MeshLambertMaterial({ color: 0xf2c12e, emissive: 0x806010 }));
      sign.position.set(0, 1.72, -def.len * 0.02);
      grp.add(sign);
    }
    grp.userData.type = TRAFFIC_TYPES[type].name;
    return grp;
  }

  /* --- Заполнить пул --- */
  spawn(count, player) {
    while (this.cars.length < count) {
      const type = Math.random() < 0.14 ? 4 : (Math.random() < 0.35 ? Math.floor(Math.random() * 4) : Math.floor(Math.random() * 3));
      const mesh = this._buildCar(type);
      const car = {
        type, mesh, alive: true, radius: TRAFFIC_TYPES[type].r,
        axis: 'z', coord: 0, dir: 1, pos: 0, speed: 0, target: 10, lane: 1, turnT: 0,
        speechSprite: null, speechT: 0, yellCd: 0
      };
      this.cars.push(car);
      this.scene.add(mesh);
    }
    for (const car of this.cars) this.placeNear(car, player);
  }

  placeNear(car, player) {
    const r = this._randRoad(player);
    car.axis = r.axis;
    car.coord = r.coord;
    car.dir = r.dir;
    car.pos = r.pos;
    car.turn = null;
    car.turnT = 0;
    car.speed = rand(6, 13);
    car.target = car.speed;
    car.speechT = 0;
    car.yellCd = 0;
    if (car.speechSprite) updateSpeechSprite(car.speechSprite, '');
    this._sync(car);
  }

  /* Случайная дорога неподалёку от игрока, но НЕ в ближнем поле видимости
     (≥ 75 м от игрока) — машины не «выскакивают» из ниоткуда перед глазами */
  _randRoad(px, pz) {
    let best = null;
    for (let i = 0; i < 10; i++) {
      let r;
      if (Math.random() < 0.5) {
        const coord = clamp(Math.round((px + rand(-80, 80)) / CFG.CELL) * CFG.CELL, -256, 256);
        r = { axis: 'z', coord, pos: clamp(pz + rand(-140, 140), -256, 256), dir: Math.random() < 0.5 ? 1 : -1 };
      } else {
        const coord = clamp(Math.round((pz + rand(-80, 80)) / CFG.CELL) * CFG.CELL, -256, 256);
        r = { axis: 'x', coord, pos: clamp(px + rand(-140, 140), -256, 256), dir: Math.random() < 0.5 ? 1 : -1 };
      }
      const wx = r.axis === 'z' ? r.coord - r.dir * 2.5 : r.pos;
      const wz = r.axis === 'z' ? r.pos : r.coord + r.dir * 2.5;
      const d = Math.hypot(wx - px, wz - pz);
      if (d >= 75) return r;
      best = r;
    }
    return best;
  }

  /* Мир. координаты: правая полоса движения (ПДД, правостороннее).
     Движение в +Z: правая сторона — −X; в −Z: +X; в +X: +Z; в −X: −Z. */
  _worldPos(car, out = _tempTrafficWp) {
    if (car.axis === 'z') {
      out.x = car.coord - car.dir * 2.5;
      out.z = car.pos;
    } else {
      out.x = car.pos;
      out.z = car.coord + car.dir * 2.5;
    }
    return out;
  }

  _heading(car) {
    return car.axis === 'z' ? (car.dir > 0 ? 0 : Math.PI) : (car.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
  }

  update(dt, player, world, density, peds) {
    const px = player.x, pz = player.z;
    for (const car of this.cars) {
      if (!car.alive) continue;
      const wp = this._worldPos(car, _tempTrafficWp);
      car.x = wp.x; car.z = wp.z;

      // Облака речи водителя
      if (car.speechT > 0) {
        car.speechT -= dt;
        if (car.speechT <= 0 && car.speechSprite) updateSpeechSprite(car.speechSprite, '');
      }
      if (car.yellCd > 0) car.yellCd -= dt;

      if (Math.hypot(car.x - px, car.z - pz) > 260) {
        this.placeNear(car, player);
        continue;
      }
      if (Math.abs(car.pos) > 268) { car.dir = -car.dir; car.pos = clamp(car.pos, -268, 268); }

      car.target = rand(7, 13) * (density || 1);
      car.target = clamp(car.target, 4, 16);

      // дистанция до впереди идущих
      for (const other of this.cars) {
        if (other === car || !other.alive) continue;
        if (other.axis !== car.axis || other.coord !== car.coord || other.dir !== car.dir) continue;
        const d = (other.pos - car.pos) * car.dir;
        if (d > 0 && d < 16) { car.target = Math.min(car.target, other.speed - 2); break; }
      }

      // взаимодействия с пешеходами (пропуск, переругивание, случайное сбитие)
      if (peds) {
        for (const p of peds.cars) {
          if (!p.alive) continue;
          const isSameRoad = p.axis === car.axis && p.coord === car.coord;
          const dP = (p.pos - car.pos) * car.dir;

          // 1. Ругань водителя и пешехода на зебре
          if (isSameRoad && p.mode === 'cross' && p.cross) {
            const off = Math.abs((p.axis === 'z' ? p.x - p.coord : p.z - p.coord));
            if (off <= 7.5 && dP > 0 && dP < 24) {
              car.target = Math.min(car.target, 0); // пропускаем
              if (car.yellCd <= 0 && dP < 16 && Math.random() < 0.12) {
                car.yellCd = 7.0;
                Events.emit('horn');
                this.say(car, choice(DRIVER_PED_QUOTES), 2.5);
                peds.say(p, choice(PED_REPLY_QUOTES), 2.5);
              }
            }
          }

          // 2. Наезд машиной трафика на пешехода
          const distFull = Math.hypot(car.x - p.x, car.z - p.z);
          if (distFull < car.radius + 0.65 && p.knockT <= 0 && p.hitCd <= 0) {
            p.hitCd = 1.2;
            const nx = (p.x - car.x) / (distFull || 1);
            const nz = (p.z - car.z) / (distFull || 1);
            if (car.speed > 2.5) {
              // Машина трафика сбивает пешехода!
              peds._knockDown(p, nx, nz, car.speed);
              Events.emit('trafficHitPed');
              Events.emit('horn');
              this.say(car, choice(DRIVER_HIT_PED_QUOTES), 3.0);
              car.speed = Math.max(1, car.speed - 3.5);
            } else {
              // Толкает / пешеход уворачивается
              peds._dodge(p, nx, nz, car.speed);
              peds.say(p, "Совсем ослеп, водила?!", 2.5);
            }
          }
        }
      }

      // игрок впереди в нашей полосе — тормозим
      const dP = (car.axis === 'z' ? (car.dir > 0 ? (pz - car.pos) : (car.pos - pz)) : (car.dir > 0 ? (px - car.pos) : (car.pos - px)));
      if (dP > 0 && dP < 14 && Math.abs((car.axis === 'z' ? px : pz) - car.coord) < 5.5) {
        car.target = Math.min(car.target, 2);
      }

      // светофор: стоп-линия в 6.5 м до перекрёстка. Тормозим, если успеваем
      // остановиться до неё; если уже на/за линией — проезжаем (въехал — проезжай)
      const l = this._lightAhead(car);
      if (l && l.state !== 0) {
        const stopLine = 6.5;
        if (l.dist > stopLine) {
          const brakeDist = car.speed * car.speed / 20; // тормозной путь при 10 м/с²
          if (l.dist > brakeDist) car.target = Math.min(car.target, 0);
        } else if (car.speed < 1) {
          car.target = Math.min(car.target, 0); // уже у линии — ждём зелёный
        }
      }

      const diff = car.target - car.speed;
      car.speed += clamp(diff, -10 * dt, 5 * dt);
      car.speed = clamp(car.speed, 0, 18);

      // активный поворот: движемся по дуге Безье через центр перекрёстка
      if (car.turn) {
        const T = car.turn;
        T.t += dt;
        const k = clamp(T.t / T.dur, 0, 1);
        const u = 1 - k;
        const bx = u * u * T.fromX + 2 * u * k * T.ctrlX + k * k * T.toX;
        const bz = u * u * T.fromZ + 2 * u * k * T.ctrlZ + k * k * T.toZ;
        car.x = bx; car.z = bz;
        car.mesh.position.set(bx, 0, bz);
        car.mesh.rotation.y = lerpAngle(T.fromH, T.toH, k);
        const df = car.target - car.speed;
        car.speed += clamp(df, -10 * dt, 5 * dt);
        car.speed = clamp(car.speed, 0, 18);
        if (k >= 1) {
          car.axis = T.newAxis; car.coord = T.newCoord; car.pos = T.newPos; car.dir = T.newDir;
          car.turn = null;
        }
        continue;
      }

      car.pos += car.speed * dt * car.dir;

      // выбор направления на перекрёстке
      if (car.turnT > 0) { car.turnT -= dt; }
      else {
        const isec = this._nearestIntersection(car);
        if (isec && Math.abs(car.pos - (car.axis === 'z' ? isec.z : isec.x)) < 2.5) {
          this._chooseDirection(car, isec);
        }
      }

      this._sync(car);
    }
  }

  _nearestIntersection(car) {
    for (const isec of WORLD_INTERSECTIONS) {
      if (car.axis === 'z') { if (Math.abs(isec.x - car.coord) < 0.1 && Math.abs(isec.z - car.pos) < 3) return isec; }
      else if (Math.abs(isec.z - car.coord) < 0.1 && Math.abs(isec.x - car.pos) < 3) return isec;
    }
    return null;
  }

  _chooseDirection(car, isec) {
    const roll = Math.random();
    if (roll < 0.58) { car.turnT = 0.3; return; } // прямо
    const right = roll < 0.8; // 22% направо, 20% налево
    // конечные параметры новой дороги (ПДД: с правой полосы — правый поворот в
    // правую полосу новой дороги, левый — тоже в правую полосу)
    let newAxis, newCoord, newDir;
    if (car.axis === 'z') {
      newAxis = 'x';
      newCoord = isec.z;
      // движение в +Z: направо = −X, налево = +X; в −Z: направо = +X, налево = −X
      newDir = right ? -car.dir : car.dir;
    } else {
      newAxis = 'z';
      newCoord = isec.x;
      // движение в +X: направо = +Z, налево = −Z; в −X: направо = −Z, налево = +Z
      newDir = right ? car.dir : -car.dir;
    }
    // мировая точка старта и финиша
    const from = this._worldPos(car, _tempTrafficFrom);
    const to = this._worldPos({ axis: newAxis, coord: newCoord, pos: (car.axis === 'z' ? isec.x : isec.z), dir: newDir }, _tempTrafficTo);
    // длительность поворота зависит от скорости (дуга ~3.5 м)
    const arcLen = Math.hypot(to.x - from.x, to.z - from.z);
    const dur = clamp(arcLen / Math.max(car.speed, 4) * 1.15, 0.5, 1.4);
    // контрольная точка: правый поворот — малый радиус по углу перекрёстка
    // (пересечение полос), левый — через центр перекрёстка
    let ctrlX, ctrlZ;
    if (right) {
      if (car.axis === 'z') { ctrlX = from.x; ctrlZ = to.z; }
      else { ctrlX = to.x; ctrlZ = from.z; }
    } else { ctrlX = isec.x; ctrlZ = isec.z; }
    car.turn = {
      t: 0, dur,
      fromX: from.x, fromZ: from.z,
      toX: to.x, toZ: to.z,
      ctrlX, ctrlZ,
      fromH: this._heading(car),
      toH: newAxis === 'z' ? (newDir > 0 ? 0 : Math.PI) : (newDir > 0 ? Math.PI / 2 : -Math.PI / 2),
      newAxis, newCoord, newPos: (car.axis === 'z' ? isec.x : isec.z), newDir,
    };
    car.turnT = dur + 0.2; // не выбираем направление, пока поворачиваем
  }

  /* Ближайший светофор впереди для полосы машины (свой светофор своей оси) */
  _lightAhead(car) {
    const wp = this._worldPos(car, _tempTrafficWp);
    for (const l of this.lightsRef) {
      if (l.axis !== car.axis) continue; // светофор поперечной дороги не наш
      // поперечное смещение: машина на своей полосе (2.5), светофор у угла (9)
      const side = car.axis === 'z' ? Math.abs(wp.x - l.x) : Math.abs(wp.z - l.z);
      if (side > 13) continue;
      // расстояние до СТОП-ЗОНЫ перекрёстка (не до светофора — тот на дальнем углу)
      const dist = car.axis === 'z'
        ? (car.dir > 0 ? l.isec.z - wp.z : wp.z - l.isec.z)
        : (car.dir > 0 ? l.isec.x - wp.x : wp.x - l.isec.x);
      if (dist <= 0 || dist > 45) continue;
      // светофор должен оставаться впереди по ходу (не проехали его угол)
      const ahead = car.axis === 'z'
        ? (car.dir > 0 ? l.z - wp.z : wp.z - l.z)
        : (car.dir > 0 ? l.x - wp.x : wp.x - l.x);
      if (ahead <= 0) continue;
      _tempLightRet.dist = dist;
      _tempLightRet.state = l.state;
      return _tempLightRet;
    }
    return null;
  }

  say(car, text, duration = 3.0) {
    if (!car.speechSprite) {
      car.speechSprite = makeSpeechSprite(text);
      car.mesh.add(car.speechSprite);
    } else {
      updateSpeechSprite(car.speechSprite, text);
    }
    car.speechT = duration;
    Events.emit('spatial:shout', { x: car.x, z: car.z, text, type: 'driver', avatar: '🚘' });
  }

  _sync(car) {
    const wp = this._worldPos(car, _tempTrafficWp);
    car.mesh.position.set(wp.x, 0, wp.z);
    car.mesh.rotation.y = this._heading(car);
  }
}

/* Перекрёстки мира (заполняется после World.build в game.js) */
export let WORLD_INTERSECTIONS = [];

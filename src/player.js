import * as THREE from 'three';
import { CFG } from './config.js';
import { clamp, lerp, dist2D, circleAABB, makePlateTexture, makeTaxiSignTexture, makeCheckerStripTexture } from './utils.js';
import { buildCarModel } from './carmodel.js';
import { Events } from './eventbus.js';

const _tempPlayerCircleRes = { nx: 0, nz: 0, depth: 0 };

/* carType (config.js CARS[].base.carType) -> силуэт + габариты (carmodel.js CAR_SHAPES) */
const CAR_TYPE_SHAPE = {
  taxi:     { shape: 'sedan', w: 1.9,  len: 4.3 },
  classic:  { shape: 'retro', w: 1.85, len: 4.0 },
  comfort:  { shape: 'hatch', w: 1.92, len: 4.25 },
  minivan:  { shape: 'van',   w: 2.05, len: 4.7 },
  business: { shape: 'premium', w: 1.95, len: 4.6 },
};

/**
 * Класс автомобиля игрока (физика, коллизии, визуал и свойства).
 */
export class PlayerCar {
  /**
   * @param {THREE.Scene} scene - Трёхмерная сцена Three.js
   * @param {import('./config.js').CarStats} stats - Характеристики машины
   */
  constructor(scene, stats) {
    this.scene = scene;
    /** @type {import('./config.js').CarStats} характеристики машины */
    this.stats = stats;
    this.x = 0; this.z = 8;
    /** @type {number} угол поворота машины (0 = +Z) */
    this.heading = 0;
    this.velX = 0; this.velZ = 0;
    /** @type {number} текущая скорость */
    this.speed = 0;
    this.steerVisual = 0;
    /** @type {number} текущий остаток топлива */
    this.fuel = CFG.startFuel;
    /** @type {number} уровень повреждений (0..100%) */
    this.damage = 0;
    /** @type {number} уровень загрязнения (0..1) */
    this.dirt = 0;
    this.stallTimer = 0;
    this.lightsOn = false;
    this.hornTimer = 0;
    this.slip = 0;               // интенсивность заноса (для звука)
    this.style = 0.7;            // стиль вождения текущей поездки
    this.styleTimer = 0;
    this.offroadTimer = 0;
    this.passengerCount = 0;
    /** @type {import('./config.js').Tuning} параметры тюнинга */
    this.tuning = { color: 0xf2c12e, rims: 0xb8b8b8, spoiler: false };
    this.groundY = 0.5;
    this._builtCarType = null;
    this._roll = 0; this._pitch = 0;
    this._blinkT = 0;
    this._initMaterials();
    this._build();
    this._buildLights();
  }

  /* --- Материалы: создаются один раз и переживают пересборку геометрии,
     чтобы смена тюнинга (цвет/диски) не требовала перекомпиляции шейдеров --- */
  _initMaterials() {
    this.matBody = new THREE.MeshLambertMaterial({ color: this.tuning.color });
    this.matDark = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });
    this.matChrome = new THREE.MeshLambertMaterial({ color: 0xc8c8c8 });
    this.matGlass = new THREE.MeshLambertMaterial({ color: 0x9fd8e8, transparent: true, opacity: 0.8 });
    this.matHead = new THREE.MeshLambertMaterial({ color: 0x8a8368, emissive: 0xfff6d8, emissiveIntensity: 0 });
    this.matStop = new THREE.MeshLambertMaterial({ color: 0x551010, emissive: 0xff2020, emissiveIntensity: 0.25 });
    this.matTurnA = new THREE.MeshLambertMaterial({ color: 0x4a2c00, emissive: 0xff9500, emissiveIntensity: 0 });
    this.matTurnB = new THREE.MeshLambertMaterial({ color: 0x4a2c00, emissive: 0xff9500, emissiveIntensity: 0 });
    this.matReverse = new THREE.MeshLambertMaterial({ color: 0x555555, emissive: 0xffffff, emissiveIntensity: 0 });
    this.matRim = new THREE.MeshLambertMaterial({ color: this.tuning.rims });
    this.matPlate = new THREE.MeshLambertMaterial({ map: makePlateTexture() });
    this.matSign = new THREE.MeshLambertMaterial({ map: makeTaxiSignTexture(), emissive: 0x806010, emissiveIntensity: 0 });
    this.matLivery = new THREE.MeshLambertMaterial({ map: makeCheckerStripTexture() });
  }

  /* --- Сборка модели из примитивов (только при смене типа машины —
     смена цвета/дисков/спойлера идёт через _applyTuning без пересборки) --- */
  _build() {
    const cType = this.stats.carType || 'taxi';
    if (this.group && this._builtCarType === cType) { this._applyTuning(this.tuning); return; }
    if (this.group) { this.scene.remove(this.group); this._disposeGroup(this.group); }
    this._builtCarType = cType;

    const def = CAR_TYPE_SHAPE[cType] || CAR_TYPE_SHAPE.taxi;
    const built = buildCarModel({
      shape: def.shape, w: def.w, len: def.len, animated: true,
      matBody: this.matBody, matDark: this.matDark, matChrome: this.matChrome, matGlass: this.matGlass,
      matHead: this.matHead, matStop: this.matStop, matTurnA: this.matTurnA, matTurnB: this.matTurnB,
      matReverse: this.matReverse, matRim: this.matRim, matPlate: this.matPlate,
      matSign: this.matSign, matLivery: this.matLivery,
      hasPlate: true, hasSign: !!this.stats.isTaxi, hasLivery: !!this.stats.isTaxi,
    });

    // спойлер строится всегда (скрыт по умолчанию) — включение в _applyTuning
    // не требует пересборки геометрии
    const spoilerY = def.shape === 'van' ? 1.9 : def.shape === 'premium' ? 1.5 : 1.42;
    this.spoilerGroup = new THREE.Group();
    const wing = new THREE.Mesh(new THREE.BoxGeometry(def.w * 0.9, 0.1, 0.5), this.matBody);
    wing.position.set(0, spoilerY, -def.len * 0.46);
    this.spoilerGroup.add(wing);
    for (const s of [-1, 1]) {
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.3), this.matDark);
      strut.position.set(def.w * 0.32 * s, spoilerY - 0.16, -def.len * 0.43);
      this.spoilerGroup.add(strut);
    }
    this.spoilerGroup.visible = false;
    built.bodyGroup.add(this.spoilerGroup);

    this.group = built.group;
    this.bodyGroup = built.bodyGroup;
    this.wheels = built.wheels;
    this.steerPivots = built.steerPivots;
    this.lampRefs = built.refs;
    this.wheelR = built.wheelR;

    this.scene.add(this.group);
    if (this.headSpot) this.group.add(this.headSpot, this.headTarget); // переносим фонарь-прожектор при пересборке
    this._applyTuning(this.tuning);
    this._updateMeshPos();
  }

  /**
   * Применить цвет кузова / диски / спойлер без пересборки геометрии.
   * @param {import('./config.js').Tuning} tuning
   */
  _applyTuning(tuning) {
    this.matBody.color.setHex(tuning.color);
    this.matRim.color.setHex(tuning.rims);
    if (this.spoilerGroup) this.spoilerGroup.visible = !!tuning.spoiler;
  }

  _disposeGroup(g) {
    // материалы принадлежат PlayerCar (созданы в _initMaterials) и переживают
    // пересборку — освобождаем только геометрию старой модели
    g.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }

  _buildLights() {
    this.headSpot = new THREE.SpotLight(0xfff2cc, 1.4, 70, 0.55, 0.4);
    this.headSpot.position.set(0, 1, 2.4);
    this.headSpot.visible = false;
    this.group.add(this.headSpot);
    this.headTarget = new THREE.Object3D();
    this.headTarget.position.set(0, 0.2, 12);
    this.group.add(this.headTarget);
    this.headSpot.target = this.headTarget;
  }

  /**
   * Установить параметры тюнинга кузова и пересобрать модель (или, если тип
   * машины не менялся, просто перекрасить материалы — см. _build/_applyTuning).
   * @param {import('./config.js').Tuning} tuning
   */
  setTuning(tuning) {
    this.tuning = tuning;
    this._build();
  }

  /**
   * Применить обновленные характеристики автомобиля.
   * @param {import('./config.js').CarStats} stats
   */
  applyUpgrades(stats) {
    this.stats = stats;
  }

  get position() { return { x: this.x, z: this.z }; }

  get isStalled() { return this.stallTimer > 0; }
  get engineDead() { return this.fuel <= 0 || this.isStalled; }

  /* --- Физика --- */
  /**
   * Обновить физику машины за кадр.
   * @param {number} dt - Прошедшее время в секундах
   * @param {import('./input.js').InputManager} input - Инпут игрока
   * @param {import('./citygen.js').World} world - Игровой мир
   * @param {import('./traffic.js').TrafficManager} traffic - Трафик
   */
  update(dt, input, world, traffic) {
    const st = this.stats;
    const onRoad = world.onRoad(this.x, this.z);
    const slope = world.heightAt(this.x, this.z) > 0.5;
    const gripMul = (onRoad ? 1 : 0.55) * (slope ? 0.85 : 1);
    const weatherGrip = this._weatherGrip || 1;

    // направление взгляда
    const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
    let fwdSpeed = this.velX * fwdX + this.velZ * fwdZ;
    const latX = -fwdZ, latZ = fwdX;
    let latSpeed = this.velX * latX + this.velZ * latZ;

    // педали
    const canDrive = !this.engineDead;
    let accelV = 0;
    if (canDrive) {
      if (input.throttle > 0) accelV += st.accel * input.throttle;
      if (input.brake > 0) {
        if (fwdSpeed > 0.5) accelV -= st.brake * input.brake;
        else accelV -= st.accel * 0.6 * input.brake; // реверс
      }
      if (input.throttle === 0 && input.brake === 0) accelV -= Math.sign(fwdSpeed) * 3.5; // сопротивление
    } else {
      accelV -= Math.sign(fwdSpeed) * 6;
    }
    if (this.stallTimer > 0) this.stallTimer -= dt;

    fwdSpeed += accelV * dt;
    fwdSpeed = clamp(fwdSpeed, -7, st.maxSpeed);

    // руление (знак минус: при камере сзади положительный steer = поворот направо на экране)
    const speedFactor = clamp(Math.abs(fwdSpeed) / 12, 0, 1);
    let steerRate = st.steer * speedFactor * (1 - Math.abs(fwdSpeed) / (st.maxSpeed * 1.6));
    if (input.handbrake && Math.abs(fwdSpeed) > 4) steerRate *= 1.5;
    // при движении назад руль инвертируем: корма едет туда, куда «показывает» руль
    const steerDir = fwdSpeed < -0.1 ? -1 : 1;
    this.heading -= input.steer * steerRate * dt * gripMul * steerDir;
    if (input.steer === 0) this.heading += latSpeed * 0.06 * dt * gripMul;

    // сцепление: латеральная скорость гасится (или растёт при ручнике)
    const grip = gripMul * weatherGrip * st.grip * (input.handbrake ? 0.28 : 1);
    latSpeed *= Math.max(0, 1 - grip * 2.2 * dt);

    // занос для звука
    this.slip = Math.abs(latSpeed) / 8 + (input.handbrake && Math.abs(fwdSpeed) > 5 ? 0.5 : 0);

    // цели кренов кузова (чисто визуальные, сглаживаются в _updateMeshPos):
    // крен от боковой скорости в повороте, клевок от продольного ускорения/торможения
    this._targetRoll = clamp(-latSpeed * 0.018, -0.07, 0.07);
    this._targetPitch = clamp(-accelV * 0.0011, -0.06, 0.06);

    this.velX = fwdX * fwdSpeed + latX * latSpeed;
    this.velZ = fwdZ * fwdSpeed + latZ * latSpeed;
    this.x += this.velX * dt;
    this.z += this.velZ * dt;
    this._clampToMap(dt);
    this.speed = Math.hypot(this.velX, this.velZ);

    // топливо
    if (canDrive) {
      const cons = (0.11 + 0.10 * (Math.abs(fwdSpeed) / st.maxSpeed)) * dt;
      this.fuel = Math.max(0, this.fuel - cons);
      if (this.fuel <= 0) Events.emit('noFuel');
    }
    // грязь
    this.dirt = Math.min(1, this.dirt + dt * 0.0012 * (1 + this.speed / 20));
    // стиль вождения (для чаевых)
    if (this.passengerCount > 0) {
      this.styleTimer += dt;
      const jerk = Math.min(1, Math.abs(accelV) / 40) * 0.7 + Math.min(1, this.slip) * 0.5;
      if (this.styleTimer > 1) { this.styleTimer = 0; this.style = clamp(this.style - jerk * 0.03, 0, 1); }
      if (!onRoad) { this.offroadTimer += dt; this.style = clamp(this.style - dt * 0.05, 0, 1); }
    }

    this._collide(world, traffic);
    this._updateLamps(dt, input, fwdSpeed);
    this._updateMeshPos(dt);

    // звук
    if (this.hornTimer > 0) { this.hornTimer -= dt; }
  }

  /* --- Коллизии: здания, пропсы, машины, пешеходы, озёра --- */
  _collide(world, traffic) {
    const r = 2.0;
    // здания
    for (const b of world.buildings) {
      const c = circleAABB(this.x, this.z, r, b);
      if (c) this._resolve(c, false, world);
    }
    // пропсы
    for (const p of world.propsAABB) {
      const c = circleAABB(this.x, this.z, r, p);
      if (c) this._resolve(c, false, world);
    }
    // круглые коллайдеры (озеро)
    for (const cld of world.circleColliders) {
      const d = dist2D(this.x, this.z, cld.x, cld.z);
      if (d < cld.r + r) {
        if (d > 1e-6) {
          _tempPlayerCircleRes.nx = (this.x - cld.x) / d;
          _tempPlayerCircleRes.nz = (this.z - cld.z) / d;
        } else {
          _tempPlayerCircleRes.nx = 0;
          _tempPlayerCircleRes.nz = 1;
        }
        _tempPlayerCircleRes.depth = cld.r + r - d;
        this._resolve(_tempPlayerCircleRes, false, world);
      }
    }
    // трафик
    if (traffic) {
      for (const car of traffic.cars) {
        if (!car.alive) continue;
        const d = dist2D(this.x, this.z, car.x, car.z);
        const rr = r + car.radius;
        if (d < rr && d > 1e-4) {
          const nx = (this.x - car.x) / d, nz = (this.z - car.z) / d;
          // расталкивание
          this.x = car.x + nx * rr; this.z = car.z + nz * rr;
          const vn = this.velX * nx + this.velZ * nz;
          if (vn < -2) {
            this.velX -= nx * vn * 1.35; this.velZ -= nz * vn * 1.35;
            const impact = -vn;
            this._damage(impact, world, 'car');
            car.speed = Math.max(1, car.speed - impact * 0.4);
            Events.emit('crash', { impact, victim: 'car', car });
            this.style = clamp(this.style - 0.12, 0, 1);
          }
        }
      }
    }
    // пешеходы (включая пешеходов города и ждущих клиентов на остановках):
    // на малой скорости — отталкиваем вбок, на высокой — сбиваем.
    // Два последовательных прохода вместо [...world.peds.cars] + push каждый
    // кадр (OPT-18) — источники уже существуют как списки, промежуточный
    // массив не нужен.
    if (world.peds) {
      for (const p of world.peds.cars) this._collidePed(p, r, world);
      if (world.gameRef && world.gameRef.orders) {
        for (const o of world.gameRef.orders.open) {
          if (o.passenger && o.passenger.mesh) this._collidePed(o.passenger, r, world);
        }
      }
    }
  }

  _collidePed(p, r, world) {
    if (p.alive === false || p.x === undefined || p.z === undefined) return;
    const d = dist2D(this.x, this.z, p.x, p.z);
    const rr = r + 0.55;
    if (d >= rr || d < 1e-4) return;
    const nx = (p.x - this.x) / d, nz = (p.z - this.z) / d;
    // выталкиваем из-под машины на границу контакта
    p.x = this.x + nx * rr;
    p.z = this.z + nz * rr;
    if (p.mesh) {
      p.mesh.position.x = p.x;
      p.mesh.position.z = p.z;
    }
    if (p.hitCd > 0) return; // уже уворачивается/сбит — не дёргаем повторно

    // Относительная скорость движения НА пешехода
    const relVel = this.velX * nx + this.velZ * nz;

    if (Math.abs(this.speed) > 4.2 && relVel > 1.5) {
      // Реальное наезд/сбивание с ощутимой скоростью
      Events.emit('hitPed', { byPlayer: true });
      this._damage(6, world, 'ped');
      p.hitCd = 2.0;
      if (world.peds._knockDown) world.peds._knockDown(p, nx, nz, Math.abs(this.speed));
    } else if (Math.abs(this.speed) > 1.0 && relVel > 0.2) {
      // Легкое касание/уворот: пешеход отскакивает вбок
      p.hitCd = 1.2;
      const sp = Math.abs(this.speed) || 1;
      const carVX = this.velX / sp, carVZ = this.velZ / sp;
      const perpX = -carVZ, perpZ = carVX;
      const sideSign = Math.sign(nx * perpX + nz * perpZ) || 1;
      const dx = perpX * sideSign * 1.3 + nx * 0.4;
      const dz = perpZ * sideSign * 1.3 + nz * 0.4;
      if (world.peds._dodge) world.peds._dodge(p, dx, dz, Math.abs(this.speed));
    }
  }

  /* --- Граница карты: город (±308) + выступ Машука на севере (|x|≤85, z до -470) --- */
  _clampToMap(dt) {
    if (this._edgeCd > 0) this._edgeCd -= dt;
    const prevX = this.x, prevZ = this.z;
    let nx = clamp(this.x, -308, 308), nz = clamp(this.z, -308, 308);
    // севернее города — узкий выступ серпантина к башне
    if (this.z < -300 && Math.abs(this.x) <= 85) {
      nx = this.x;
      nz = clamp(this.z, -470, -300);
    }
    if (nx !== this.x || nz !== this.z) {
      if (nx !== this.x) this.velX = 0;
      if (nz !== this.z) this.velZ = 0;
      this.x = nx; this.z = nz;
      if (!(this._edgeCd > 0)) {
        this._edgeCd = 2.5;
        Events.emit('edge', {});
      }
    }
  }

  _resolve(c, soft, world) {
    const impact = Math.abs(this.velX * c.nx + this.velZ * c.nz);
    this.x += c.nx * c.depth; this.z += c.nz * c.depth;
    const vn = this.velX * c.nx + this.velZ * c.nz;
    if (vn < 0) {
      this.velX -= c.nx * vn * 1.5;
      this.velZ -= c.nz * vn * 1.5;
      if (impact > 6) {
        this._damage(impact, world, 'static');
        Events.emit('crash', { impact, victim: 'static' });
        this.style = clamp(this.style - 0.06, 0, 1);
      }
    }
  }

  _damage(impact, world, victim) {
    const dmg = impact * impact * 0.018 / this.stats.armor;
    this.damage = Math.min(100, this.damage + dmg);
    if (impact > 20 && this.damage > 60 && !this.isStalled) {
      this.stallTimer = 2.5;
      this.speed = 0; this.velX = 0; this.velZ = 0;
      Events.emit('stall', {});
    }
  }

  _updateMeshPos(dt = 0.016) {
    const g = this.group;
    g.position.set(this.x, this.groundY, this.z);
    g.rotation.y = this.heading;
    // колёса: спин вокруг собственной оси (локальный X), руль — поворот пивота
    const spin = this.speed / (this.wheelR || 0.38);
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.rotation.x -= spin * dt;
      const pivot = this.steerPivots[i];
      // знак минус: поворот heading при steer>0 уводит машину в -X, колёса должны смотреть туда же
      if (pivot) pivot.rotation.y = -this.steerVisual * 0.5;
    }
    this.steerVisual = lerp(this.steerVisual, this._steerIn || 0, 0.15);

    // живая механика кузова: плавный крен в поворотах и клевок при разгоне/торможении
    // (только визуал — на физику/коллизии не влияет, колёса и группа-корпус независимы)
    this._roll = lerp(this._roll, this._targetRoll || 0, 0.14);
    this._pitch = lerp(this._pitch, this._targetPitch || 0, 0.14);
    if (this.bodyGroup) { this.bodyGroup.rotation.z = this._roll; this.bodyGroup.rotation.x = this._pitch; }
  }

  /* Рабочий свет: фары, стопы, задний ход, поворотники, плафон "ТАКСИ" —
     только смена emissiveIntensity общих материалов, без пересоздания мешей */
  _updateLamps(dt, input, fwdSpeed) {
    if (this.matHead) this.matHead.emissiveIntensity = this.lightsOn ? 1.1 : 0;
    const braking = input.brake > 0 && Math.abs(this.speed) > 0.05;
    if (this.matStop) this.matStop.emissiveIntensity = braking ? 1.1 : 0.25;
    if (this.matReverse) this.matReverse.emissiveIntensity = fwdSpeed < -0.1 ? 0.9 : 0;

    // поворотники мигают, пока руль отклонён (сторона A = -X, см. carmodel.js)
    this._blinkT = (this._blinkT + dt) % 0.9;
    const blinkOn = this._blinkT < 0.45;
    const steer = input.steer || 0;
    if (this.matTurnA) this.matTurnA.emissiveIntensity = (steer > 0.15 && blinkOn) ? 1.3 : 0;
    if (this.matTurnB) this.matTurnB.emissiveIntensity = (steer < -0.15 && blinkOn) ? 1.3 : 0;

    // плафон "ТАКСИ": горит — свободна, приглушён — занята пассажиром
    if (this.matSign) this.matSign.emissiveIntensity = this.passengerCount > 0 ? 0.06 : 0.5;
  }

  setSteer(s) { this._steerIn = s; }

  /* Постановка на землю с учётом рельефа */
  snapToTerrain(world) {
    this.groundY = 0.5 + world.heightAt(this.x, this.z);
    this._updateMeshPos();
  }

  setPos(x, z, heading) {
    this.x = x; this.z = z; this.heading = heading;
    this.velX = 0; this.velZ = 0; this.speed = 0;
  }

  repair() { this.damage = 0; }
  wash() { this.dirt = 0; }
  refuel() { this.fuel = this.stats.tank; }

  toggleLights() {
    this.lightsOn = !this.lightsOn;
    this.headSpot.visible = this.lightsOn;
    return this.lightsOn;
  }
}

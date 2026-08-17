import * as THREE from 'three';
import { CFG } from './config.js';
import { clamp, dist2D, circleAABB, turnToward, buildPedMesh } from './utils.js';

/* Габариты кузова автомобиля для вычисления капсульного коллайдера (длина, ширина) */
const PED_CAR_SHAPES = {
  taxi:     { w: 1.9,  len: 4.3 },
  classic:  { w: 1.85, len: 4.0 },
  comfort:  { w: 1.92, len: 4.25 },
  minivan:  { w: 2.05, len: 4.7 },
  business: { w: 1.95, len: 4.6 },
  sport:    { w: 1.9,  len: 4.35 },
  offroad:  { w: 2.05, len: 4.8 },
};

/**
 * Класс пешехода-аватара игрока (физика, коллизии, визуал и анимация ходьбы/бега).
 */
export class PlayerPed {
  /**
   * @param {THREE.Scene} scene - Трёхмерная сцена Three.js
   */
  constructor(scene) {
    this.scene = scene;
    this.x = 0;
    this.z = 0;
    this.groundY = 0;
    this.heading = 0;
    this.speed = 0;
    this.walkPhase = 0;
    this.isRunning = false;
    this._tempVec = { x: 0, z: 0 };
    this.mesh = buildPedMesh('regular');
    if (this.mesh && this.scene) {
      this.scene.add(this.mesh);
    }
  }

  get position() {
    return { x: this.x, z: this.z };
  }

  /**
   * Установить позицию и направление взгляда пешехода.
   * @param {number} x
   * @param {number} z
   * @param {number} heading
   */
  setPos(x, z, heading = 0) {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.speed = 0;
    this.walkPhase = 0;
    if (this.mesh) {
      this.mesh.position.set(this.x, this.groundY, this.z);
      this.mesh.rotation.y = this.heading;
    }
  }

  /**
   * Обновление состояния пешехода за кадр.
   * @param {number} dt - Прошедшее время в секундах
   * @param {object} input - Ввод игрока
   * @param {object} world - Мир (здания, пропсы, рельеф, коллайдеры)
   * @param {object} peds - Менеджер пешеходов NPC
   * @param {object} playerCar - Автомобиль игрока
   */
  update(dt, input, world, peds, playerCar) {
    let moveFwd = 0;
    let moveRight = 0;

    if (input) {
      if (typeof input.walkForward === 'number' || typeof input.walkRight === 'number') {
        moveFwd = input.walkForward || 0;
        moveRight = input.walkRight || 0;
      } else if (input.keys) {
        const k = input.keys;
        if (k.has('KeyW') || k.has('ArrowUp')) moveFwd += 1;
        if (k.has('KeyS') || k.has('ArrowDown')) moveFwd -= 1;
        if (k.has('KeyD') || k.has('ArrowRight')) moveRight += 1;
        if (k.has('KeyA') || k.has('ArrowLeft')) moveRight -= 1;
      }
    }

    // Если угол камеры передан в input (при прямом чтении клавиш) — проецируем относительно камеры
    if (input && typeof input.camYaw === 'number' && typeof input.walkForward !== 'number') {
      const cy = Math.cos(input.camYaw), sy = Math.sin(input.camYaw);
      this._tempVec.x = moveRight * cy + moveFwd * sy;
      this._tempVec.z = -moveRight * sy + moveFwd * cy;
    } else {
      this._tempVec.x = moveRight;
      this._tempVec.z = moveFwd;
    }

    const lenSq = this._tempVec.x * this._tempVec.x + this._tempVec.z * this._tempVec.z;
    const len = Math.sqrt(lenSq);
    const hasMove = len > 1e-4;

    if (lenSq > 1) {
      const invLen = 1 / len;
      this._tempVec.x *= invLen;
      this._tempVec.z *= invLen;
    }

    const isShift = !!((input && input.keys && (input.keys.has('ShiftLeft') || input.keys.has('ShiftRight'))) || (input && input.isRunning));
    this.isRunning = isShift && hasMove;

    const walkSpeed = (CFG && CFG.pedWalkSpeed) || 2.4;
    const runSpeed = (CFG && CFG.pedRunSpeed) || 4.8;
    const targetMaxSpeed = this.isRunning ? runSpeed : walkSpeed;

    if (hasMove) {
      this.speed = targetMaxSpeed * Math.min(1, len);
      this.x += this._tempVec.x * this.speed * dt;
      this.z += this._tempVec.z * this.speed * dt;

      const targetHeading = Math.atan2(this._tempVec.x, this._tempVec.z);
      this.heading = turnToward(this.heading, targetHeading, dt * 14.0);

      this.walkPhase += dt * this.speed * (this.isRunning ? 3.6 : 3.0);
    } else {
      this.speed = 0;
    }

    this._collide(world, peds, playerCar);

    if (world && typeof world.heightAt === 'function') {
      this.groundY = world.heightAt(this.x, this.z);
    }

    if (this.mesh) {
      this.mesh.position.set(this.x, this.groundY, this.z);
      this.mesh.rotation.y = this.heading;
      this._animate();
    }
  }

  /**
   * Разрешение коллизий со статикой, машиной игрока, водоёмами и границами карты.
   * @param {object} world
   * @param {object} peds
   * @param {object} playerCar
   */
  _collide(world, peds, playerCar) {
    if (!world) return;

    // 1. Здания: circleAABB (радиус 0.35) с выталкиванием по нормали
    if (world.buildings) {
      for (let i = 0; i < world.buildings.length; i++) {
        const c = circleAABB(this.x, this.z, 0.35, world.buildings[i]);
        if (c) {
          this.x += c.nx * c.depth;
          this.z += c.nz * c.depth;
        }
      }
    }

    // 2. Пропсы и заборы: spatial hash или propsAABB
    if (world._propHash) {
      const cell = world._propHashCell || 10;
      const cx = Math.floor(this.x / cell);
      const cz = Math.floor(this.z / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = world._propHash.get((cx + dx) + ',' + (cz + dz));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) {
            const c = circleAABB(this.x, this.z, 0.35, bucket[i]);
            if (c) {
              this.x += c.nx * c.depth;
              this.z += c.nz * c.depth;
            }
          }
        }
      }
    } else if (world.propsAABB) {
      for (let i = 0; i < world.propsAABB.length; i++) {
        const c = circleAABB(this.x, this.z, 0.35, world.propsAABB[i]);
        if (c) {
          this.x += c.nx * c.depth;
          this.z += c.nz * c.depth;
        }
      }
    }

    // 3. Озёра и фонтаны: круглые коллайдеры
    if (world.circleColliders) {
      for (let i = 0; i < world.circleColliders.length; i++) {
        const cld = world.circleColliders[i];
        const d = dist2D(this.x, this.z, cld.x, cld.z);
        const rr = cld.r + 0.35;
        if (d < rr) {
          if (d > 1e-6) {
            const nx = (this.x - cld.x) / d;
            const nz = (this.z - cld.z) / d;
            const depth = rr - d;
            this.x += nx * depth;
            this.z += nz * depth;
          } else {
            this.z += rr;
          }
        }
      }
    }

    // 4. Своя машина: капсульный коллайдер (3 круга)
    if (playerCar) {
      const cType = (playerCar.stats && playerCar.stats.carType) || 'taxi';
      const shape = PED_CAR_SHAPES[cType] || PED_CAR_SHAPES.taxi;
      const halfW = shape.w / 2;
      const halfL = shape.len / 2;
      const rc = halfW * 1.03;
      const sep = halfL - halfW;
      const fwdX = Math.sin(playerCar.heading), fwdZ = Math.cos(playerCar.heading);
      const totalR = rc + 0.35;

      const offs = [sep, 0, -sep];
      for (let i = 0; i < 3; i++) {
        const cx = playerCar.x + fwdX * offs[i];
        const cz = playerCar.z + fwdZ * offs[i];
        const d = dist2D(this.x, this.z, cx, cz);
        if (d < totalR && d > 1e-6) {
          const nx = (this.x - cx) / d;
          const nz = (this.z - cz) / d;
          const depth = totalR - d;
          this.x += nx * depth;
          this.z += nz * depth;
        }
      }
    }

    // Пешеходы NPC (мягкое расталкивание)
    if (peds && peds.cars) {
      for (let i = 0; i < peds.cars.length; i++) {
        const p = peds.cars[i];
        if (p.alive === false || p.x === undefined || p.z === undefined) continue;
        if (p.mesh && !p.mesh.visible) continue;
        const d = dist2D(this.x, this.z, p.x, p.z);
        const rr = 0.7;
        if (d < rr && d > 1e-4) {
          const nx = (this.x - p.x) / d;
          const nz = (this.z - p.z) / d;
          const depth = (rr - d) * 0.5;
          this.x += nx * depth;
          this.z += nz * depth;
        }
      }
    }

    // 5. Границы карты: город (±308) + серпантин Машука на севере
    let nx = clamp(this.x, -308, 308);
    let nz = clamp(this.z, -308, 308);
    if (this.z < -300 && Math.abs(this.x) <= 85) {
      nx = this.x;
      nz = clamp(this.z, -470, -300);
    }
    this.x = nx;
    this.z = nz;
  }

  /**
   * Анимация суставов ног и рук при ходьбе/беге.
   */
  _animate() {
    if (!this.mesh) return;
    const u = this.mesh.userData;
    if (!u) return;

    const moving = this.speed > 0.05;
    if (moving) {
      const amp = this.isRunning ? 0.82 : 0.55;
      const sw = Math.sin(this.walkPhase);
      if (u.legs && u.legs.length >= 2) {
        u.legs[0].rotation.x = sw * amp;
        u.legs[1].rotation.x = -sw * amp;
      }
      if (u.arms && u.arms.length >= 2) {
        u.arms[0].rotation.x = -sw * amp * 0.72;
        u.arms[1].rotation.x = sw * amp * 0.72;
      }
    } else {
      if (u.legs && u.legs.length >= 2) {
        u.legs[0].rotation.x = 0;
        u.legs[1].rotation.x = 0;
      }
      if (u.arms && u.arms.length >= 2) {
        u.arms[0].rotation.x = 0;
        u.arms[1].rotation.x = 0;
      }
    }
  }

  /**
   * Удалить меш пешехода из сцены.
   */
  dispose() {
    if (this.mesh && this.scene) {
      this.scene.remove(this.mesh);
    }
  }
}

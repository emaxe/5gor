import * as THREE from 'three';
import { CFG, CAR_TYPE_SHAPE } from './config.js';
import { clamp, dist2D, circleAABB, turnToward, buildPedMesh, buildDriverMesh, disposeMeshGeometries } from './utils.js';

/**
 * Класс пешехода-аватара игрока (физика, коллизии, визуал и анимация ходьбы/бега).
 */
export class PlayerPed {
  /**
   * @param {THREE.Scene} scene - Трёхмерная сцена Three.js
   * @param {object} [options={}] - Опции кастомизации водителя
   */
  constructor(scene, options = {}) {
    this.scene = scene;
    this.options = options ? { ...options } : {};
    this.x = 0;
    this.z = 0;
    this.groundY = 0;
    this.heading = 0;
    this.speed = 0;
    this.walkPhase = 0;
    this.isRunning = false;
    this.punchCd = 0;
    this.punchAnimT = 0;
    this.maxHp = (CFG && CFG.pedPlayerMaxHp !== undefined) ? CFG.pedPlayerMaxHp : 3;
    this.hp = this.maxHp;
    this.stunT = 0;
    this.knockVx = 0;
    this.knockVz = 0;
    this.knockT = 0;
    this.isKnockedOut = false;
    this.vy = 0;              // вертикальная скорость (прыжок/гравитация)
    this.yOff = 0;            // текущая высота над землёй (прыжок)
    this.jumpCd = 0;          // кулдаун прыжка
    this.hitCd = 0;           // кулдаун наезда машины трафика
    this._tempVec = { x: 0, z: 0 };
    this.mesh = buildDriverMesh(this.options);
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
    this.punchCd = 0;
    this.punchAnimT = 0;
    this.hp = this.maxHp;
    this.stunT = 0;
    this.knockVx = 0;
    this.knockVz = 0;
    this.knockT = 0;
    this.isKnockedOut = false;
    this.vy = 0;
    this.yOff = 0;
    this.jumpCd = 0;
    this.hitCd = 0;
    if (this.mesh) {
      this.mesh.position.set(this.x, this.groundY, this.z);
      this.mesh.rotation.set(0, this.heading, 0);
    }
  }

  /**
   * Прыжок (если на земле и кулдаун прошёл).
   * @returns {boolean} true, если прыжок выполнен
   */
  jump() {
    if (this.stunT > 0 || this.knockT > 0 || this.jumpCd > 0) return false;
    if (this.vy > 0) return false; // уже в воздухе
    const jumpSpeed = (CFG && CFG.pedJumpSpeed !== undefined) ? CFG.pedJumpSpeed : 6.5;
    this.vy = jumpSpeed;
    this.jumpCd = (CFG && CFG.pedJumpCooldown !== undefined) ? CFG.pedJumpCooldown : 0.25;
    return true;
  }

  /**
   * Запустить действие удара (если кулдаун прошёл и игрок не оглушён).
   * @returns {boolean} true, если удар выполнен, иначе false
   */
  punch() {
    if (this.stunT > 0 || this.punchCd > 0) return false;
    this.punchCd = (CFG && CFG.pedPunchCooldown !== undefined) ? CFG.pedPunchCooldown : 0.8;
    this.punchAnimT = 0.3;
    return true;
  }

  /**
   * Получить удар / пинок от пешехода в ответ.
   * @param {number} fromX - X-координата источника удара
   * @param {number} fromZ - Z-координата источника удара
   * @param {number} damage - Наносимый урон (по умолчанию 1)
   * @returns {boolean} true если игрок нокаутирован (исчерпано всё HP)
   */
  takeHit(fromX, fromZ, damage = 1) {
    this.hp = Math.max(0, this.hp - damage);
    const dx = this.x - fromX;
    const dz = this.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    const dirX = dx / len;
    const dirZ = dz / len;

    if (this.hp <= 0) {
      const downDur = (CFG && CFG.pedPlayerDownDuration !== undefined) ? CFG.pedPlayerDownDuration : 2.0;
      this.stunT = downDur;
      this.isKnockedOut = true;
      this.knockVx = dirX * 5.5;
      this.knockVz = dirZ * 5.5;
      this.knockT = 0.4;
    } else {
      const stunDur = (CFG && CFG.pedPlayerStunDuration !== undefined) ? CFG.pedPlayerStunDuration : 0.6;
      this.stunT = stunDur;
      this.isKnockedOut = false;
      this.knockVx = dirX * 4.0;
      this.knockVz = dirZ * 4.0;
      this.knockT = 0.25;
    }
    this.speed = 0;
    return this.hp <= 0;
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
    if (this.punchCd > 0) {
      this.punchCd = Math.max(0, this.punchCd - dt);
    }
    if (this.punchAnimT > 0) {
      this.punchAnimT = Math.max(0, this.punchAnimT - dt);
    }
    if (this.hitCd > 0) {
      this.hitCd = Math.max(0, this.hitCd - dt);
    }

    if (this.stunT > 0) {
      this.stunT = Math.max(0, this.stunT - dt);
      if (this.stunT <= 0 && this.isKnockedOut) {
        this.isKnockedOut = false;
        this.hp = this.maxHp;
      }
    }

    if (this.knockT > 0) {
      this.knockT = Math.max(0, this.knockT - dt);
      this.x += this.knockVx * dt;
      this.z += this.knockVz * dt;
      this.knockVx *= Math.max(0, 1 - dt * 6.0);
      this.knockVz *= Math.max(0, 1 - dt * 6.0);
      this.speed = 0;
    } else if (this.stunT > 0) {
      this.speed = 0;
    } else {
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

      // Если угол камеры передан в input (при прямом чтении клавиш) — проецируем относительно камеры.
      // ВНИМАНИЕ: экранное «вправо» = −X при взгляде в +Z (камера за спиной, ось X зеркалится),
      // поэтому знак moveRight инвертирован относительно наивной формулы.
      if (input && typeof input.camYaw === 'number' && typeof input.walkForward !== 'number') {
        const cy = Math.cos(input.camYaw), sy = Math.sin(input.camYaw);
        this._tempVec.x = -moveRight * cy + moveFwd * sy;
        this._tempVec.z = moveRight * sy + moveFwd * cy;
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

      const walkSpeed = (CFG && CFG.pedWalkSpeed) || 3.1;
      const runSpeed = (CFG && CFG.pedRunSpeed) || 5.8;
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
    }

    this._collide(world, peds, playerCar);

    // Прыжок/гравитация: вертикальная скорость и высота над землёй
    if (this.jumpCd > 0) this.jumpCd = Math.max(0, this.jumpCd - dt);
    if (world && typeof world.heightAt === 'function') {
      this.groundY = world.heightAt(this.x, this.z);
    }
    if (this.vy > 0 || this.yOff > 0) {
      const g = (CFG && CFG.pedGravity !== undefined) ? CFG.pedGravity : 20.0;
      this.vy -= g * dt;
      this.yOff += this.vy * dt;
      if (this.yOff <= 0) { this.yOff = 0; this.vy = 0; } // приземлился
    }

    if (this.mesh) {
      this.mesh.position.set(this.x, this.groundY + this.yOff, this.z);
      if (this.isKnockedOut) {
        this.mesh.rotation.set(Math.PI / 2 * 0.8, this.heading, 0);
      } else {
        this.mesh.rotation.set(0, this.heading, 0);
      }
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
    const py = world.heightAt ? world.heightAt(this.x, this.z) : 0;

    // 1. Здания: circleAABB (радиус 0.35) с выталкиванием по нормали
    if (world._buildingHash) {
      const cell = world._buildingHashCell || 16;
      const cx = Math.floor(this.x / cell);
      const cz = Math.floor(this.z / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = world._buildingHash.get((cx + dx) + ',' + (cz + dz));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) {
            const c = circleAABB(this.x, this.z, 0.35, bucket[i], py, 1.7);
            if (c) {
              this.x += c.nx * c.depth;
              this.z += c.nz * c.depth;
            }
          }
        }
      }
    } else if (world.buildings) {
      for (let i = 0; i < world.buildings.length; i++) {
        const c = circleAABB(this.x, this.z, 0.35, world.buildings[i], py, 1.7);
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
            const c = circleAABB(this.x, this.z, 0.35, bucket[i], py, 1.7);
            if (c) {
              this.x += c.nx * c.depth;
              this.z += c.nz * c.depth;
            }
          }
        }
      }
    } else if (world.propsAABB) {
      for (let i = 0; i < world.propsAABB.length; i++) {
        const c = circleAABB(this.x, this.z, 0.35, world.propsAABB[i], py, 1.7);
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
      const shape = CAR_TYPE_SHAPE[cType] || CAR_TYPE_SHAPE.taxi;
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
   * Анимация суставов ног и рук при ходьбе/беге, ударе и получении урона.
   */
  _animate() {
    if (!this.mesh) return;
    const u = this.mesh.userData;
    if (!u) return;

    if (this.isKnockedOut) {
      if (u.legs && u.legs.length >= 2) {
        u.legs[0].rotation.x = 0.2;
        u.legs[1].rotation.x = -0.2;
      }
      if (u.arms && u.arms.length >= 2) {
        u.arms[0].rotation.x = 0.8;
        u.arms[1].rotation.x = 0.8;
      }
      return;
    }

    if (this.stunT > 0) {
      if (u.legs && u.legs.length >= 2) {
        u.legs[0].rotation.x = 0;
        u.legs[1].rotation.x = 0;
      }
      if (u.arms && u.arms.length >= 2) {
        u.arms[0].rotation.x = -0.9;
        u.arms[1].rotation.x = -0.9;
      }
      return;
    }

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

    if (this.punchAnimT > 0 && u.arms && u.arms.length >= 2) {
      const k = clamp(1.0 - this.punchAnimT / 0.3, 0, 1);
      const armAngle = -Math.sin(k * Math.PI) * 1.2;
      u.arms[1].rotation.x = armAngle; // правая рука вперёд
      u.arms[0].rotation.x = -0.5;     // левая для баланса
    }
  }

  /**
   * Применить новые опции кастомизации водителя и пересоздать 3D-меш.
   * @param {object} options
   */
  applyDriverOptions(options) {
    if (this.mesh && this.scene) {
      this.scene.remove(this.mesh);
    }
    this.options = options ? { ...options } : {};
    this.mesh = buildDriverMesh(this.options);
    if (this.mesh && this.scene) {
      this.scene.add(this.mesh);
      this.mesh.position.set(this.x, this.groundY, this.z);
      if (this.isKnockedOut) {
        this.mesh.rotation.set(Math.PI / 2 * 0.8, this.heading, 0);
      } else {
        this.mesh.rotation.set(0, this.heading, 0);
      }
    }
  }

  /**
   * Удалить меш пешехода из сцены.
   */
  dispose() {
    if (this.mesh && this.scene) {
      this.scene.remove(this.mesh);
      disposeMeshGeometries(this.mesh);
    }
  }
}

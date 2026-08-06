/* ============================================================
 * player.js — машина игрока: аркадная физика, заносы, коллизии
 * ============================================================ */

class PlayerCar {
  constructor(scene, stats) {
    this.scene = scene;
    this.stats = stats; // базовые + апгрейды (пересчитываются из UpgradeSystem)
    this.x = 0; this.z = 8;
    this.heading = 0;            // 0 = +Z
    this.velX = 0; this.velZ = 0;
    this.speed = 0;
    this.steerVisual = 0;
    this.fuel = CFG.startFuel;
    this.damage = 0;
    this.dirt = 0;
    this.stallTimer = 0;
    this.lightsOn = false;
    this.hornTimer = 0;
    this.slip = 0;               // интенсивность заноса (для звука)
    this.style = 0.7;            // стиль вождения текущей поездки
    this.styleTimer = 0;
    this.offroadTimer = 0;
    this.passengerCount = 0;
    this.tuning = { color: 0xf2c12e, rims: 0xb8b8b8, spoiler: false };
    this.groundY = 0.5;
    this._build();
    this._buildLights();
  }

  /* --- Сборка модели из примитивов --- */
  _build() {
    if (this.group) { this.scene.remove(this.group); this._disposeGroup(this.group); }
    const g = new THREE.Group();
    const bodyTex = makeTaxiTexture('#' + this.tuning.color.toString(16).padStart(6, '0'));
    const bodyMat = new THREE.MeshLambertMaterial({ map: bodyTex });
    const cabinMat = new THREE.MeshLambertMaterial({ color: 0x1c2430 });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });
    const rimMat = new THREE.MeshLambertMaterial({ color: this.tuning.rims });
    const trimMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });
    const plateTex = makePlateTexture();
    const plateMat = new THREE.MeshLambertMaterial({ map: plateTex });

    // кузов
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.75, 4.3), bodyMat);
    body.position.y = 0.62;
    g.add(body);
    // кабина
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.62, 2.1), cabinMat);
    cabin.position.set(0, 1.08, -0.25);
    g.add(cabin);
    // капот/бамперы
    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.28, 0.7), trimMat);
    hood.position.set(0, 0.72, 1.95);
    g.add(hood);
    const rear = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.28, 0.5), trimMat);
    rear.position.set(0, 0.72, -2.05);
    g.add(rear);
    // фары и стоп-сигналы
    for (const s of [-1, 1]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.1), new THREE.MeshBasicMaterial({ color: 0xfff6d8 }));
      hl.position.set(0.62 * s, 0.72, 2.16);
      g.add(hl);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.1), new THREE.MeshBasicMaterial({ color: 0xd03030 }));
      tl.position.set(0.62 * s, 0.72, -2.16);
      g.add(tl);
    }
    // номер
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.35, 0.06), plateMat);
    plate.position.set(0, 0.5, 2.17);
    g.add(plate);
    // спойлер
    if (this.tuning.spoiler) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.1, 0.5), bodyMat);
      sp.position.set(0, 1.15, -2.05);
      g.add(sp);
      for (const s of [-1, 1]) {
        const st = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.3), trimMat);
        st.position.set(0.6 * s, 1.0, -1.95);
        g.add(st);
      }
    }
    // стёкла: лобовое, заднее, боковые (кабина остаётся каркасом)
    const glassMat = new THREE.MeshLambertMaterial({ color: 0x9fd8e8, transparent: true, opacity: 0.8 });
    const ws = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 0.06), glassMat);
    ws.position.set(0, 1.24, 0.92);
    ws.rotation.x = -0.45;
    g.add(ws);
    const wr = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 0.06), glassMat);
    wr.position.set(0, 1.24, -1.38);
    wr.rotation.x = 0.45;
    g.add(wr);
    for (const s of [-1, 1]) {
      const wl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.44, 1.7), glassMat);
      wl.position.set(0.86 * s, 1.2, -0.25);
      g.add(wl);
    }
    // ручки дверей
    for (const s of [-1, 1]) {
      const hd = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.4), trimMat);
      hd.position.set(0.95 * s, 0.8, 0.35);
      g.add(hd);
    }
    // антенна
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.7, 4), darkMat);
    ant.position.set(-0.55, 1.75, -0.9);
    g.add(ant);
    // крыша-шашечки (такси-сигнал)
    if (this.stats.isTaxi) {
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.22, 0.35), new THREE.MeshLambertMaterial({ color: 0xf2c12e, emissive: 0x806010 }));
      sign.position.set(0, 1.44, 0.5);
      g.add(sign);
    }
    // колёса: передние — на рулевых пивотах (поворот вокруг оси Y пивота,
    // спин — вокруг собственной оси колеса), задние — просто спины
    this.wheels = [];
    this.steerPivots = [];
    const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 10);
    const hubGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.34, 8);
    const hubMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });
    for (const [sx, sz, front] of [[-0.98, 1.42, true], [0.98, 1.42, true], [-0.98, -1.45, false], [0.98, -1.45, false]]) {
      const w = new THREE.Mesh(wheelGeo, rimMat);
      w.rotation.z = Math.PI / 2; // ось колеса — локальный X
      w.userData.front = front;
      w.userData.baseZ = sz;
      // ступица — тёмный диск в центре
      const hub = new THREE.Mesh(hubGeo, hubMat);
      hub.rotation.z = Math.PI / 2;
      w.add(hub);
      if (front) {
        const pivot = new THREE.Group();
        pivot.position.set(sx, 0, sz);
        w.position.set(0, 0.38, 0);
        pivot.add(w);
        g.add(pivot);
        this.steerPivots.push(pivot);
      } else {
        w.position.set(sx, 0.38, sz);
        g.add(w);
        this.steerPivots.push(null);
      }
      this.wheels.push(w);
    }
    this.group = g;
    this.scene.add(g);
    this._updateMeshPos();
  }

  _disposeGroup(g) {
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose()); else o.material.dispose(); }
    });
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

  setTuning(tuning) {
    this.tuning = tuning;
    this._build();
  }

  applyUpgrades(stats) {
    this.stats = stats;
  }

  get position() { return { x: this.x, z: this.z }; }

  get isStalled() { return this.stallTimer > 0; }
  get engineDead() { return this.fuel <= 0 || this.isStalled; }

  /* --- Физика --- */
  update(dt, input, world, traffic) {
    const st = this.stats;
    const onRoad = world.distToRoad(this.x, this.z) < CFG.HALF + CFG.SIDE + 3;
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
        const n = d > 1e-6 ? { nx: (this.x - cld.x) / d, nz: (this.z - cld.z) / d } : { nx: 0, nz: 1 };
        this._resolve({ ...n, depth: cld.r + r - d }, false, world);
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
            Events.emit('crash', { impact, victim: 'car' });
            this.style = clamp(this.style - 0.12, 0, 1);
          }
        }
      }
    }
    // пешеходы: на малой скорости — просто отталкиваем вбок (уворачивается),
    // на высокой — сбиваем (отлетает и лежит). Никаких телепортов.
    if (world.peds) {
      for (const p of world.peds.cars) {
        if (!p.alive) continue;
        const d = dist2D(this.x, this.z, p.x, p.z);
        const rr = r + 0.55;
        if (d >= rr || d < 1e-4) continue;
        const nx = (p.x - this.x) / d, nz = (p.z - this.z) / d;
        // выталкиваем из-под машины на границу контакта
        p.x = this.x + nx * rr;
        p.z = this.z + nz * rr;
        if (p.hitCd > 0) continue; // уже уворачивается/сбит — не дёргаем повторно
        const rel = this.velX * nx + this.velZ * nz;
        if (this.speed > 9 && rel > 2) {
          // сбивание: пешеход отлетает в сторону удара
          Events.emit('hitPed', {});
          this._damage(6, world, 'ped');
          p.hitCd = 2.0;
          world.peds._knockDown(p, nx, nz, this.speed);
        } else {
          // уворот: пешеход прыгает вбок и убегает
          p.hitCd = 1.2;
          const sp = this.speed || 1;
          const carVX = this.velX / sp, carVZ = this.velZ / sp;
          const perpX = -carVZ, perpZ = carVX;
          const sideSign = Math.sign(nx * perpX + nz * perpZ) || 1;
          const dx = perpX * sideSign * 1.3 + nx * 0.4;
          const dz = perpZ * sideSign * 1.3 + nz * 0.4;
          world.peds._dodge(p, dx, dz, this.speed);
        }
      }
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
    const spin = this.speed / 0.38;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.rotation.x -= spin * dt;
      const pivot = this.steerPivots[i];
      // знак минус: поворот heading при steer>0 уводит машину в -X, колёса должны смотреть туда же
      if (pivot) pivot.rotation.y = -this.steerVisual * 0.5;
    }
    this.steerVisual = lerp(this.steerVisual, this._steerIn || 0, 0.15);
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

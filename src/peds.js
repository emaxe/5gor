/* ============================================================
 * peds.js — пешеходы: Object Pool, тротуары, переходы по зебре
 *
 * Режимы:
 *  walk  — идёт по тротуару вдоль дороги
 *  cross — переходит дорогу поперёк (по зебре на перекрёстке)
 *  wait  — стоит у края, ждёт, пока проедут машины
 *  turn  — огибает угол квартала по диагонали (поворот на перекрёстке)
 * ============================================================ */

const PED_COLORS = [0xd8a878, 0x8a5a3a, 0xc89060, 0xa87850, 0xb08058, 0x6a4a30];
const PED_SIDE = CFG.HALF + CFG.SIDE / 2; // 8 — центр тротуара от оси дороги

class PedestrianManager {
  constructor(scene) {
    this.scene = scene;
    this.cars = []; // сущности
    this.trafficRef = null;
    this._count = 0;
  }

  /* Гуманоид из примитивов: отдельные ноги/руки — анимация ходьбы */
  _buildPed() {
    return buildPedMesh();
  }

  /* Анимация ходьбы: махи ногами/руками по фазе шага */
  _animate(p) {
    const u = p.mesh.userData;
    if (!u || !u.legs) return;
    const moving = p.knockT <= 0 && p.speed > 0 && (p.mode === 'walk' || p.mode === 'cross' || p.mode === 'turn' || p.mode === 'flee');
    const ph = p.walk || 0;
    const amp = p.mode === 'flee' ? 0.75 : 0.55;
    if (moving) {
      const sw = Math.sin(ph);
      u.legs[0].rotation.x = sw * amp;
      u.legs[1].rotation.x = -sw * amp;
      u.arms[0].rotation.x = -sw * amp * 0.72;
      u.arms[1].rotation.x = sw * amp * 0.72;
    } else {
      u.legs[0].rotation.x = 0; u.legs[1].rotation.x = 0;
      u.arms[0].rotation.x = 0; u.arms[1].rotation.x = 0;
    }
  }

  /* Спавн: рядом с игроком (в радиусе 40–160 м), а не по всему городу */
  spawn(count, px, pz) {
    while (this.cars.length < count) {
      const mesh = this._buildPed();
      const ped = { mesh, alive: true, x: 0, z: 0, axis: 'z', dir: 1, speed: 0, side: 1, turnT: 0, mode: 'walk', cross: null, turn: null, waitT: 0, fx: 0, fz: 0, fvx: 0, fvz: 0, fleeT: 0, knockT: 0, hitCd: 0 };
      this.cars.push(ped);
      this.scene.add(mesh);
    }
    const ox = px !== undefined ? px : 0, oz = pz !== undefined ? pz : 0;
    for (const p of this.cars) this._randPlace(p, ox, oz);
  }

  /* Случайное место на тротуаре рядом с (px,pz), но НЕ ближе 65 м к игроку —
     пешеходы не «материализуются» перед глазами */
  _randPlace(p, px, pz) {
    let place = null;
    for (let i = 0; i < 10; i++) {
      const vertical = Math.random() < 0.5;
      const coord = clamp(Math.round((px + rand(-70, 70)) / CFG.CELL) * CFG.CELL, -256, 256);
      const axis = vertical ? 'z' : 'x';
      const pos = clamp((vertical ? pz : px) + rand(-70, 70), -256, 256);
      const side = Math.random() < 0.5 ? -1 : 1;
      const wx = axis === 'z' ? coord + side * PED_SIDE : pos;
      const wz = axis === 'z' ? pos : coord + side * PED_SIDE;
      if (Math.hypot(wx - px, wz - pz) >= 65 || i === 9) { place = { axis, coord, pos, side }; break; }
    }
    p.axis = place.axis;
    p.coord = place.coord;
    p.pos = place.pos;
    p.side = place.side;
    p.dir = Math.random() < 0.5 ? 1 : -1;
    p.speed = rand(1.6, 3.2);
    p.turnT = 0;
    p.mode = 'walk';
    p.cross = null;
    p.turn = null;
    p.waitT = 0;
    p.fx = 0; p.fz = 0; p.fvx = 0; p.fvz = 0;
    p.fleeT = 0; p.knockT = 0; p.hitCd = 0;
    this._sync(p);
  }

  /* Мировые координаты в зависимости от режима */
  _worldPos(p) {
    // уворачивание/лежит — свободное перемещение
    if (p.knockT > 0 || p.mode === 'flee') return { x: p.fx, z: p.fz };
    if (p.mode === 'cross' && p.cross) {
      const k = clamp(p.cross.t / p.cross.dur, 0, 1);
      const off = lerp(p.cross.from, p.cross.to, k);
      return p.axis === 'z' ? { x: p.coord + off, z: p.pos } : { x: p.pos, z: p.coord + off };
    }
    if (p.mode === 'turn' && p.turn) {
      const k = clamp(p.turn.t / p.turn.dur, 0, 1);
      return { x: lerp(p.turn.x0, p.turn.x1, k), z: lerp(p.turn.z0, p.turn.z1, k) };
    }
    const off = p.side * PED_SIDE;
    return p.axis === 'z' ? { x: p.coord + off, z: p.pos } : { x: p.pos, z: p.coord + off };
  }

  _heading(p) {
    let h;
    if (p.mode === 'flee') {
      h = Math.atan2(p.fvx, p.fvz);
    } else if (p.mode === 'turn' && p.turn) {
      h = Math.atan2(p.turn.x1 - p.turn.x0, p.turn.z1 - p.turn.z0);
    } else if (p.mode === 'cross' && p.cross) {
      // идём поперёк дороги
      const toPlus = p.cross.to > p.cross.from;
      h = p.axis === 'z' ? (toPlus ? Math.PI / 2 : -Math.PI / 2) : (toPlus ? 0 : Math.PI);
    } else {
      h = p.axis === 'z' ? (p.dir > 0 ? 0 : Math.PI) : (p.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    }
    // лёгкое покачивание при ходьбе
    if (p.walk) h += Math.sin(p.walk) * 0.06;
    return h;
  }

  /* Есть ли машина на нашей дороге ближе dist от точки перехода.
     Стоящий трафик (светофор/пробка) не блокирует переход; машина игрока тоже считается */
  _carOnRoad(p, dist) {
    const tr = this.trafficRef;
    if (tr) {
      for (const c of tr.cars) {
        if (!c.alive || c.axis !== p.axis || c.coord !== p.coord) continue;
        if (c.speed > 0.8 && Math.abs(c.pos - p.pos) < dist) return true;
      }
    }
    const pl = this._playerRef;
    if (pl && pl.speed > 1.5) {
      const onRoad = p.axis === 'z' ? Math.abs(pl.x - p.coord) < 11 : Math.abs(pl.z - p.coord) < 11;
      const along = p.axis === 'z' ? pl.z : pl.x;
      if (onRoad && Math.abs(along - p.pos) < dist) return true;
    }
    return false;
  }

  /* --- Обычная ходьба по тротуару --- */
  _updateWalk(p, dt) {
    p.pos += p.speed * dt * p.dir;
    if (p.turnT > 0) { p.turnT -= dt; return; }
    // край города — разворот
    if (Math.abs(p.pos) > 232) {
      p.dir = -p.dir;
      p.pos = clamp(p.pos, -232, 232);
      p.turnT = 0.5;
      return;
    }
    // пересекли линию перекрёстка — выбираем, что делать
    const isec = Math.round(p.pos / CFG.CELL) * CFG.CELL;
    if (Math.abs(isec) <= 256 && Math.abs(p.pos - isec) < 1.2) this._decide(p, isec);
  }

  /* Решение на перекрёстке: в основном идём прямо, изредка поворачиваем,
     переходим дорогу редко (раньше 38% — пешеходы метались туда-сюда) */
  _decide(p, isec) {
    const roll = Math.random();
    if (roll < 0.14) { this._startCross(p); return; }       // изредка перейти дорогу
    if (roll < 0.42) { this._startTurn(p, isec); return; }  // свернуть за угол
    if (roll < 0.50) { p.dir = -p.dir; p.turnT = 1.2; return; } // развернуться
    p.turnT = rand(0.3, 0.8);                               // идти прямо
  }

  /* Начать переход: встаём на линию зебры, сначала ждём просвета */
  _startCross(p) {
    p.pos = Math.round(p.pos / CFG.CELL) * CFG.CELL;
    p.mode = 'wait';
    p.waitT = 0;
    p.cross = {
      from: p.side * PED_SIDE,
      to: -p.side * PED_SIDE,
      t: 0,
      dur: (PED_SIDE * 2) / (p.speed * 1.3), // на переходе шаг быстрее
    };
  }

  /* Ждём просвета; если долго не появляется — идём (трафик уступает переходу) */
  _updateWait(p, dt) {
    p.waitT += dt;
    if (p.waitT > 4.5) { p.mode = 'cross'; return; }
    if (this._carOnRoad(p, 34)) return;
    p.mode = 'cross';
  }

  /* Переход через дорогу */
  _updateCross(p, dt) {
    const c = p.cross;
    c.t += dt;
    if (c.t >= c.dur) {
      // дошли до противоположного тротуара
      p.side = c.to > 0 ? 1 : -1;
      p.mode = 'walk';
      p.cross = null;
      p.turnT = 2.2; // пауза, чтобы не шарахаться туда-обратно
    } else if (this._carOnRoad(p, 18)) {
      c.t += dt * 1.6; // машина близко — добегаем
    }
  }

  /* Поворот на перекрёстке: срезаем угол квартала по диагонали */
  _startTurn(p, isec) {
    const wp0 = this._worldPos(p);
    const side = p.side;
    const oldCoord = p.coord;
    let x1, z1;
    if (p.axis === 'z') {
      // поворачиваем на горизонтальную дорогу (z = isec)
      x1 = oldCoord;
      z1 = isec + side * PED_SIDE;
      p.axis = 'x'; p.coord = isec; p.pos = oldCoord;
    } else {
      // поворачиваем на вертикальную дорогу (x = isec)
      x1 = isec + side * PED_SIDE;
      z1 = oldCoord;
      p.axis = 'z'; p.coord = isec; p.pos = oldCoord;
    }
    p.mode = 'turn';
    p.turn = {
      x0: wp0.x, z0: wp0.z, x1, z1, t: 0,
      dur: Math.hypot(x1 - wp0.x, z1 - wp0.z) / p.speed,
    };
  }

  _updateTurn(p, dt) {
    const t = p.turn;
    t.t += dt;
    if (t.t >= t.dur) { p.mode = 'walk'; p.turn = null; p.turnT = 1.0; }
  }

  update(dt, player, traffic) {
    this.trafficRef = traffic;
    this._playerRef = player;
    for (const p of this.cars) {
      if (!p.alive) continue;
      if (p.hitCd > 0) p.hitCd -= dt;
      p.walk = (p.walk || 0) + dt * p.speed * 4;

      if (p.knockT > 0) {
        // сбит: скользит по асфальту, потом встаёт и убегает
        p.knockT -= dt;
        p.fx += p.fvx * dt * 0.25;
        p.fz += p.fvz * dt * 0.25;
        if (p.knockT <= 0) this._startFlee(p, p.fvx, p.fvz, 3.4);
      } else if (p.mode === 'flee') {
        // уворачивается от машины
        p.fx += p.fvx * dt;
        p.fz += p.fvz * dt;
        p.fleeT -= dt;
        if (p.fleeT <= 0) this._snapToSidewalk(p);
      } else if (p.mode === 'cross') this._updateCross(p, dt);
      else if (p.mode === 'turn') this._updateTurn(p, dt);
      else if (p.mode === 'wait') this._updateWait(p, dt);
      else this._updateWalk(p, dt);

      const wp = this._worldPos(p);
      p.x = wp.x; p.z = wp.z;

      // далеко от игрока — переспавниваем рядом (город «живой» вокруг)
      if (Math.abs(p.x - player.x) > 260 || Math.abs(p.z - player.z) > 260) {
        this._randPlace(p, player.x, player.z);
        continue;
      }

      this._animate(p);
      this._sync(p);
    }
  }

  /* Увернуться от машины: убегает вбок, потом возвращается на тротуар */
  _dodge(p, dx, dz, carSpeed) {
    p.fx = p.x; p.fz = p.z;
    this._startFlee(p, dx, dz, Math.max(3.2, carSpeed * 0.9 + 0.8));
  }

  /* Сбит машиной: отлетает, лежит, потом встаёт и убегает */
  _knockDown(p, dx, dz, carSpeed) {
    p.fx = p.x; p.fz = p.z;
    p.mode = 'walk';
    p.knockT = 2.0;
    p.cross = null; p.turn = null;
    const sp = 3 + Math.min(carSpeed, 16) * 0.3;
    const len = Math.hypot(dx, dz) || 1;
    p.fvx = (dx / len) * sp;
    p.fvz = (dz / len) * sp;
  }

  /* Свободное убегание (fx/fz) */
  _startFlee(p, dx, dz, speed) {
    p.mode = 'flee';
    p.fleeT = 1.0 + speed * 0.15;
    const len = Math.hypot(dx, dz) || 1;
    p.fvx = (dx / len) * speed;
    p.fvz = (dz / len) * speed;
    p.cross = null; p.turn = null;
  }

  /* Вернуть убежавшего на ближайший тротуар (без прыжков) */
  _snapToSidewalk(p) {
    const rx = clamp(Math.round(p.fx / CFG.CELL) * CFG.CELL, -256, 256);
    const rz = clamp(Math.round(p.fz / CFG.CELL) * CFG.CELL, -256, 256);
    if (Math.abs(p.fx - rx) <= Math.abs(p.fz - rz)) {
      p.axis = 'z'; p.coord = rx; p.pos = clamp(p.fz, -256, 256); p.side = p.fx >= rx ? 1 : -1;
    } else {
      p.axis = 'x'; p.coord = rz; p.pos = clamp(p.fx, -256, 256); p.side = p.fz >= rz ? 1 : -1;
    }
    p.mode = 'walk';
    p.turnT = 0.8;
    p.speed = rand(1.6, 3.2);
  }

  _sync(p) {
    const wp = this._worldPos(p);
    const h = this.world ? this.world.heightAt(wp.x, wp.z) : 0;
    p.mesh.position.set(wp.x, h + 0.02, wp.z);
    if (p.knockT > 0) {
      // лежит на асфальте в сторону удара
      p.mesh.rotation.set(0, Math.atan2(p.fvx, p.fvz), Math.PI / 2);
    } else {
      p.mesh.rotation.x = 0; p.mesh.rotation.z = 0;
      p.mesh.rotation.y = this._heading(p);
    }
  }
}

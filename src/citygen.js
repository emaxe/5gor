import * as THREE from 'three';
import { CFG, DISTRICTS, PALETTES, LANDMARKS, FUEL_STATIONS } from './config.js';
import { mulberry32, dist2D, rand, clamp, choice, makeCanvas, canvasToTexture, lerp, mergeColored, makePlateTexture, makeTaxiTexture, getWindowMaterial, getRoofMaterial } from './utils.js';

/**
 * Класс игрового мира: процедурная генерация города, дорожной сети, зданий и освещения.
 */
export class World {
  /**
   * @param {THREE.Scene} scene - Сцена Three.js
   */
  constructor(scene) {
    this.scene = scene;
    this.rng = mulberry32(20260805);
    /** @type {Array<{x0: number, z0: number, x1: number, z1: number, h: number, mesh: THREE.Mesh}>} список зданий с AABB */
    this.buildings = [];
    /** @type {Array<{x0: number, z0: number, x1: number, z1: number}>} пропсы с AABB */
    this.propsAABB = [];
    /** @type {Array<{x: number, z: number, r: number}>} круглые коллайдеры */
    this.circleColliders = [];
    this.roadsV = [];
    this.roadsH = [];
    this.intersections = [];
    /** @type {Array<{x: number, z: number, district: string}>} точки подачи такси */
    this.pickupPoints = [];
    this.lights = [];          // светофоры {group, phase, state}
    this.fuelStations = FUEL_STATIONS.map((s) => ({ ...s }));
    this.landmarks = LANDMARKS.map((l) => ({ ...l }));
    this.lampHeadMesh = null;
    this.roadMats = [];        // материалы асфальта (для эффекта намокания)
    this.windowMats = new Set(); // уникальные материалы стен с окнами (для ночной подсветки)
    this._bottomMat = null;    // общий материал днища зданий (создаётся один раз в build())
    this._strips = [];         // участки серпантина
    this.hill = { x: 0, z: -440, r: 170, h: 60 };
    this.time = 0;
  }

  /* Район квартала */
  blockDistrict(bi, bj) {
    if (bi === 3 && bj === 3 || bi === 4 && bj === 3 || bi === 4 && bj === 4) return 'center';
    if (bi === 3 && bj === 4) return 'center';
    if (bi === 5 && bj === 3) return 'rynok';
    if (bi === 6 && bj === 5) return 'vokzal';
    if (bi === 2 && bj === 1) return 'proval';
    if (bi <= 2 && bj <= 1) return 'mashuk';
    if (bi >= 5 && bj <= 5) return 'sanatorii';
    if (bj >= 6) return 'prigorod';
    if (bi <= 2) return 'kurort';
    return 'center';
  }

  blockSpecial(bi, bj) {
    if (bi === 3 && bj === 4) return 'park';
    if (bi === 2 && bj === 1) return 'lake';
    if (bi === 5 && bj === 3) return 'rynok';
    if (bi === 6 && bj === 5) return 'vokzal';
    return null;
  }

  blockRect(bi, bj) {
    const x0 = -246 + bi * CFG.CELL, z0 = -246 + bj * CFG.CELL;
    return { x0, z0, x1: x0 + 44, z1: z0 + 44 };
  }

  /* --- Высота земли в точке (Машук + серпантин) --- */
  heightAt(x, z) {
    let h = 0;
    const hx = x - this.hill.x, hz = z - this.hill.z;
    const d = Math.hypot(hx, hz);
    if (d < this.hill.r) h = Math.max(h, this.hill.h * Math.pow(1 - d / this.hill.r, 1.5));
    const d2 = Math.hypot(x - 55, z + 500);
    if (d2 < 70) h = Math.max(h, 26 * Math.pow(1 - d2 / 70, 1.5));
    for (const s of this._strips) {
      if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) {
        if (s.axis === 'z') { const t = (z - s.z0) / (s.z1 - s.z0); h = Math.max(h, s.h0 + (s.h1 - s.h0) * t); }
        else { const t = (x - s.x0) / (s.x1 - s.x0); h = Math.max(h, s.h0 + (s.h1 - s.h0) * t); }
      }
    }
    return h;
  }

  /* Расстояние до ближайшей дороги (для проверки «вне дороги») */
  distToRoad(x, z) {
    let best = 1e9;
    for (const r of this.roadsV) {
      const dz = Math.max(0, Math.abs(z) - (256 + CFG.GRID_EXT));
      best = Math.min(best, Math.hypot(x - r.c, dz));
    }
    for (const r of this.roadsH) {
      const dx = Math.max(0, Math.abs(x) - (256 + CFG.GRID_EXT));
      best = Math.min(best, Math.hypot(z - r.c, dx));
    }
    return best;
  }

  /**
   * Проверяет, валидна ли позиция для спавна столба, дерева или объекта:
   * 1. Запрещает попадание на проезжую часть дороги (отступ от оси дороги < 6.3 м)
   * 2. Запрещает прохождение сквозь стены и контур зданий
   * 3. Запрещает попадание в водно-парковые зоны (Провал, фонтаны)
   * 4. Запрещает наложение предметов друг на друга
   */
  isPositionValid(x, z, radius = 0.8) {
    // 1. Никаких предметов на проезжей части дороги (ширина дороги 12 м = 6 м полуширина)
    if (this.distToRoad(x, z) < 6.3) return false;

    // 2. Никаких предметов внутри контура или стен зданий
    for (const b of this.buildings) {
      if (x > b.x0 - radius && x < b.x1 + radius && z > b.z0 - radius && z < b.z1 + radius) {
        return false;
      }
    }

    // 3. Никаких предметов в озёрах, бассейнах или парковых объектах
    for (const c of this.circleColliders) {
      if (Math.hypot(x - c.x, z - c.z) < c.r + radius + 0.8) return false;
    }

    // 4. Запрет наложения предметов друг на друга
    for (const p of this.propsAABB) {
      if (x > p.x0 - radius && x < p.x1 + radius && z > p.z0 - radius && z < p.z1 + radius) {
        return false;
      }
    }

    return true;
  }

  /* ================= СТРОИТЕЛЬСТВО ================= */
  build() {
    this._bottomMat = new THREE.MeshLambertMaterial({ color: 0x555550 });
    this._ground();
    this._roads();
    this._crosswalks();
    this._mountains();
    this._hillAndSerpentine();
    this._buildings();
    this._specials();
    this._trees();
    this._lamps();
    this._props();
    this._fuelStations();
    this._trafficLights();
    this._cableCar();
    this._signs();
    this._collectPickupPoints();
  }

  _ground() {
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(1700, 1700),
      new THREE.MeshLambertMaterial({ color: 0x7fae6a })
    );
    g.rotation.x = -Math.PI / 2;
    this.scene.add(g);
  }

  _roads() {
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.82, metalness: 0.05 });
    this.roadMats.push(roadMat);
    // тротуар — текстура плитки (canvas), repeat под размеры лент
    const sideTex = this._pavementTexture();
    const sideTexH = this._pavementTexture('pavement_h');
    sideTexH.repeat.set(200, 8);
    sideTex.repeat.set(8, 200);
    const sideMat = new THREE.MeshLambertMaterial({ map: sideTex });
    const sideMatH = new THREE.MeshLambertMaterial({ map: sideTexH });
    const curbMat = new THREE.MeshLambertMaterial({ color: 0xbcbcb4 });
    const len = 512 + CFG.GRID_EXT * 2;
    const C = CFG.CELL, H = CFG.HALF;
    for (let i = 0; i <= 8; i++) {
      const c = -256 + i * C;
      // вертикальная дорога
      const rv = new THREE.Mesh(new THREE.BoxGeometry(CFG.ROAD_W, 0.1, len), roadMat);
      rv.position.set(c, 0.05, 0);
      this.scene.add(rv);
      this.roadsV.push({ c, from: -292, to: 292 });
      // горизонтальная
      const rh = new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, CFG.ROAD_W), roadMat);
      rh.position.set(0, 0.05, c);
      this.scene.add(rh);
      this.roadsH.push({ c, from: -292, to: 292 });
      // тротуары
      for (const s of [-1, 1]) {
        const swV = new THREE.Mesh(new THREE.BoxGeometry(CFG.SIDE, 0.1, len), sideMat);
        swV.position.set(c + s * (H + CFG.SIDE / 2), 0.1, 0);
        this.scene.add(swV);
        const swH = new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, CFG.SIDE), sideMatH);
        swH.position.set(0, 0.1, c + s * (H + CFG.SIDE / 2));
        this.scene.add(swH);
        // бордюры
        const cbV = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, len), curbMat);
        cbV.position.set(c + s * (H + 0.25), 0.14, 0);
        this.scene.add(cbV);
        const cbH = new THREE.Mesh(new THREE.BoxGeometry(len, 0.16, 0.5), curbMat);
        cbH.position.set(0, 0.14, c + s * (H + 0.25));
        this.scene.add(cbH);
      }
    }
    // площади-перекрёстки (поверх лент, чтобы не было z-fighting)
    const isecMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.80, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -1 });
    this.roadMats.push(isecMat);
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      this.intersections.push({ x: -256 + i * CFG.CELL, z: -256 + j * CFG.CELL });
    }
    const isecGeo = new THREE.BoxGeometry(CFG.ROAD_W, 0.08, CFG.ROAD_W);
    const isecMesh = new THREE.InstancedMesh(isecGeo, isecMat, this.intersections.length);
    const m4Isec = new THREE.Matrix4();
    this.intersections.forEach(({ x, z }, idx) => {
      m4Isec.makeTranslation(x, 0.055, z);
      isecMesh.setMatrixAt(idx, m4Isec);
    });
    this.scene.add(isecMesh);
    // разметка — пунктир по центру каждой дороги; для дорог вдоль X геометрия
    // штриха развёрнута на 90°, иначе пунктир лежит поперёк проезжей части
    const dashGeo = new THREE.BoxGeometry(0.25, 0.03, 3.2);  // дороги вдоль Z
    const dashGeoH = new THREE.BoxGeometry(3.2, 0.03, 0.25); // дороги вдоль X
    const dashMat = new THREE.MeshLambertMaterial({ color: 0xe8e8dc });
    const dashesV = [];
    for (const r of this.roadsV) {
      for (let z = -272; z <= 272; z += 6.4) {
        const m = new THREE.Matrix4();
        m.makeTranslation(r.c, 0.09, z);
        dashesV.push(m);
      }
    }
    const dashesH = [];
    for (const r of this.roadsH) {
      for (let x = -272; x <= 272; x += 6.4) {
        const m = new THREE.Matrix4();
        m.makeTranslation(x, 0.09, r.c);
        dashesH.push(m);
      }
    }
    const dashMeshV = new THREE.InstancedMesh(dashGeo, dashMat, dashesV.length);
    dashesV.forEach((m, i) => dashMeshV.setMatrixAt(i, m));
    this.scene.add(dashMeshV);
    const dashMeshH = new THREE.InstancedMesh(dashGeoH, dashMat, dashesH.length);
    dashesH.forEach((m, i) => dashMeshH.setMatrixAt(i, m));
    this.scene.add(dashMeshH);
  }

  _crosswalks() {
    const stripeGeo = new THREE.BoxGeometry(0.6, 0.03, 3.4);
    const stripeMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const spots = [
      { x: 0, z: 0 }, { x: -64, z: -64 }, { x: 64, z: -64 }, { x: 64, z: 64 },
      { x: -128, z: 0 }, { x: 0, z: 128 }, { x: 128, z: -128 }, { x: -64, z: 128 },
    ];
    const list = [];
    for (const s of spots) {
      for (let k = -1; k <= 1; k++) {
        const m1 = new THREE.Matrix4(); m1.makeTranslation(s.x - k * 1.2, 0.095, s.z + 4.2);
        const m2 = new THREE.Matrix4(); m2.makeTranslation(s.x - k * 1.2, 0.095, s.z - 4.2);
        const m3 = new THREE.Matrix4(); m3.makeTranslation(s.x + 4.2, 0.095, s.z - k * 1.2);
        const m4 = new THREE.Matrix4(); m4.makeTranslation(s.x - 4.2, 0.095, s.z - k * 1.2);
        list.push(m1, m2, m3, m4);
      }
    }
    const mesh = new THREE.InstancedMesh(stripeGeo, stripeMat, list.length);
    list.forEach((m, i) => mesh.setMatrixAt(i, m));
    this.scene.add(mesh);
  }

  _mountains() {
    // 5-главая гора Бештау — главная вершина Кавказских Минеральных Вод
    const bGroup = new THREE.Group();
    const bMat = new THREE.MeshLambertMaterial({ color: 0x7a8e98 });
    const bPeakMat = new THREE.MeshLambertMaterial({ color: 0x90a4b0 });

    const beshtauPeaks = [
      { x: 0,   z: 0,    r: 250, h: 260 }, // Большой Тау
      { x: -95, z: 65,   r: 145, h: 185 }, // Малый Тау
      { x: 105, z: -55,  r: 135, h: 165 }, // Лисий Нос
      { x: -65, z: -105, r: 155, h: 175 }, // Лохматая
      { x: 85,  z: 95,   r: 125, h: 155 }, // Козьи Скалы
    ];

    for (const p of beshtauPeaks) {
      const m = new THREE.Mesh(new THREE.ConeGeometry(p.r, p.h, 7, 2), p.r > 200 ? bPeakMat : bMat);
      m.position.set(-680 + p.x, p.h / 2 - 2, -1050 + p.z);
      bGroup.add(m);
    }
    this.scene.add(bGroup);

    // Окружающие горные массивы (Змейка, Железная, Джинальский хребет)
    const defs = [
      { x: 480, z: -1100, r: 230, h: 215, c: 0x7e8e98 }, // Змейка
      { x: -1100, z: -600, r: 200, h: 190, c: 0x74848e }, // Железная
      { x: 1050, z: 300, r: 340, h: 165, c: 0x9aa8a0 },   // Джинальский хребет
      { x: 300, z: 1050, r: 300, h: 150, c: 0xa0aaa0 },
      { x: 980, z: -320, r: 270, h: 135, c: 0xa8b0a0 },
      { x: -1000, z: 400, r: 260, h: 130, c: 0xa4aca4 },
    ];
    for (const d of defs) {
      const m = new THREE.Mesh(new THREE.ConeGeometry(d.r, d.h, 8, 2), new THREE.MeshLambertMaterial({ color: d.c }));
      m.position.set(d.x, d.h / 2 - 2, d.z);
      m.rotation.y = this.rng() * Math.PI;
      this.scene.add(m);
    }
    // невысокие холмы вокруг города
    const hillDefs = [
      { x: -420, z: 380, r: 150, h: 45 }, { x: 430, z: -420, r: 120, h: 35 },
      { x: 460, z: 340, r: 170, h: 40 }, { x: -450, z: -480, r: 100, h: 30 },
    ];
    for (const d of hillDefs) {
      const m = new THREE.Mesh(new THREE.ConeGeometry(d.r, d.h, 7, 1), new THREE.MeshLambertMaterial({ color: 0x6f9a6a }));
      m.position.set(d.x, d.h / 2 - 1, d.z);
      this.scene.add(m);
    }
  }

  _hillAndSerpentine() {
    // Гора Машук — естественный плавный горный конус
    const hill = new THREE.Mesh(
      new THREE.ConeGeometry(this.hill.r, this.hill.h, 24, 6),
      new THREE.MeshLambertMaterial({ color: 0x5a885a })
    );
    hill.position.set(this.hill.x, this.hill.h / 2 - 1, this.hill.z);
    this.scene.add(hill);

    // Вторая вершина
    const peak = new THREE.Mesh(new THREE.ConeGeometry(75, 28, 12, 3), new THREE.MeshLambertMaterial({ color: 0x628e62 }));
    peak.position.set(55, 28 / 2 - 1, -500);
    this.scene.add(peak);

    // Серпантин: [axis, x0,z0, x1,z1, h0,h1]
    // Начинается прямо от городской проезжей части z = -256!
    const segs = [
      ['z', 6.5, -256, 13.5, -300, 0.1, 4],   // Въездной пандус с проспекта z=-256
      ['z', 6.5, -300, 13.5, -330, 4, 16],    // 1-й подъём
      ['x', 10, -333.5, 70, -326.5, 16, 16],  // 1-я площадка/поворот
      ['z', 66.5, -330, 73.5, -360, 16, 28],  // 2-й подъём
      ['x', 10, -363.5, 70, -356.5, 28, 28],  // 2-я площадка/поворот
      ['z', 6.5, -360, 13.5, -390, 28, 40],   // 3-й подъём
      ['x', 10, -393.5, 70, -386.5, 40, 40],  // 3-я площадка/поворот
      ['z', 66.5, -390, 73.5, -415, 40, 52],  // 4-й подъём
      ['x', 20, -418.5, 70, -411.5, 52, 52],  // 4-я площадка/поворот
      ['z', 16.5, -415, 23.5, -440, 52, 58],  // Выезд к Смотровой башне на вершине (58м)
    ];

    const roadMat = new THREE.MeshStandardMaterial({ color: 0x3e434a, roughness: 0.82, metalness: 0.05 });
    this.roadMats.push(roadMat);
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x787870 });
    const fillMat = new THREE.MeshLambertMaterial({ color: 0x547d54 });
    const guards = [];
    const guardGeo = new THREE.CylinderGeometry(0.14, 0.18, 1.0, 5);

    for (const [axis, x0, z0, x1, z1, h0, h1] of segs) {
      let xc, zc, l, rotX = 0, rotZ = 0;
      if (axis === 'z') {
        xc = (x0 + x1) / 2; zc = (z0 + z1) / 2; l = z1 - z0;
        rotX = Math.atan2(h1 - h0, Math.abs(l));
      } else {
        xc = (x0 + x1) / 2; zc = (z0 + z1) / 2; l = x1 - x0;
        rotZ = -Math.atan2(h1 - h0, Math.abs(l));
      }

      const lenAbs = Math.abs(l);

      // 1. Полотно серпантина
      const m = new THREE.Mesh(new THREE.BoxGeometry(axis === 'z' ? 7.2 : lenAbs + 0.8, 0.35, axis === 'z' ? lenAbs + 0.8 : 7.2), roadMat);
      m.position.set(xc, (h0 + h1) / 2 + 0.1, zc);
      m.rotation.x = rotX;
      m.rotation.z = rotZ;
      this.scene.add(m);
      this._strips.push({ axis, x0, x1, z0, z1, h0, h1 });

      // 2. Аккуратная горная насыпь под полотном дороги (устраняет просветы без уродования горы)
      const midH = (h0 + h1) / 2;
      const fillGeo = new THREE.BoxGeometry(axis === 'z' ? 7.4 : lenAbs, Math.max(0.6, midH), axis === 'z' ? lenAbs : 7.4);
      const fillMesh = new THREE.Mesh(fillGeo, fillMat);
      fillMesh.position.set(xc, Math.max(0.3, midH / 2), zc);
      fillMesh.rotation.x = rotX;
      fillMesh.rotation.z = rotZ;
      this.scene.add(fillMesh);

      // 3. Подпорный каменный бордюр/стенка на обрыве
      const sideWall = new THREE.Mesh(
        new THREE.BoxGeometry(axis === 'z' ? 0.45 : lenAbs, 0.7, axis === 'z' ? lenAbs : 0.45),
        wallMat
      );
      const offX = axis === 'z' ? (xc > 30 ? 3.6 : -3.6) : 0;
      const offZ = axis === 'z' ? 0 : (zc < -370 ? -3.6 : 3.6);
      sideWall.position.set(xc + offX, midH + 0.35, zc + offZ);
      sideWall.rotation.x = rotX;
      sideWall.rotation.z = rotZ;
      this.scene.add(sideWall);

      // Отбойники
      const pad = 3.2;
      for (let t = 3; t < lenAbs - 2; t += 8) {
        if (axis === 'z') {
          const zz = z0 + Math.sign(l) * t;
          const hh = h0 + (h1 - h0) * (t / lenAbs);
          guards.push(new THREE.Matrix4().makeTranslation(xc - pad, hh + 0.5, zz));
          guards.push(new THREE.Matrix4().makeTranslation(xc + pad, hh + 0.5, zz));
        } else {
          const xx = x0 + Math.sign(l) * t;
          const hh = h0 + (h1 - h0) * (t / lenAbs);
          guards.push(new THREE.Matrix4().makeTranslation(xx, hh + 0.5, zc - pad));
          guards.push(new THREE.Matrix4().makeTranslation(xx, hh + 0.5, zc + pad));
        }
      }
    }
    if (guards.length) {
      const gm = new THREE.InstancedMesh(guardGeo, new THREE.MeshLambertMaterial({ color: 0x6a6a6a }), guards.length);
      guards.forEach((m, i) => gm.setMatrixAt(i, m));
      this.scene.add(gm);
    }

    // смотровая башня на вершине
    const tb = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.6, 18, 8), new THREE.MeshLambertMaterial({ color: 0xd8d0c0 }));
    tb.position.set(0, 58 + 9, -448);
    this.scene.add(tb);
    const troof = new THREE.Mesh(new THREE.ConeGeometry(4.6, 4, 8), new THREE.MeshLambertMaterial({ color: 0x8a4a2a }));
    troof.position.set(0, 58 + 18 + 2, -448);
    this.scene.add(troof);
    this.propsAABB.push({ x0: -4, z0: -452, x1: 4, z1: -444 });

    // беседка «Эолова арфа» на склоне
    this._gazebo(10, -357, 28);

    // каменный грот Лермонтова (в парке)
    this._grotto(-52, 8);
  }

  _gazebo(x, z, y) {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xe8e0d0 });
    const colGeo = new THREE.CylinderGeometry(0.18, 0.22, 2.6, 6);
    const colsMesh = new THREE.InstancedMesh(colGeo, mat, 6);
    const m4Col = new THREE.Matrix4();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      m4Col.makeTranslation(Math.cos(a) * 1.7, y + 1.3, Math.sin(a) * 1.7);
      colsMesh.setMatrixAt(i, m4Col);
    }
    g.add(colsMesh);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.6, 1.6, 8), new THREE.MeshLambertMaterial({ color: 0x7a8a5a }));
    roof.position.y = y + 2.6 + 0.8;
    g.add(roof);
    g.position.set(x, 0, z);
    this.scene.add(g);
    this.propsAABB.push({ x0: x - 2.4, z0: z - 2.4, x1: x + 2.4, z1: z + 2.4 });
  }

  _grotto(x, z) {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x8a8a84 });
    const p1 = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.6, 3.6, 7), mat);
    p1.position.set(-2, 1.8, 0); g.add(p1);
    const p2 = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.6, 3.6, 7), mat);
    p2.position.set(2, 1.8, 0); g.add(p2);
    const top = new THREE.Mesh(new THREE.BoxGeometry(5.4, 1.6, 3.4), mat);
    top.position.set(0, 3.6, 0); g.add(top);
    const dark = new THREE.Mesh(new THREE.BoxGeometry(4.0, 2.2, 1.6), new THREE.MeshLambertMaterial({ color: 0x2a2a2a }));
    dark.position.set(0, 1.9, 0.8); g.add(dark);
    g.position.set(x, 0.16, z);
    this.scene.add(g);
    this.propsAABB.push({ x0: x - 3, z0: z - 2, x1: x + 3, z1: z + 2 });
  }

  /* --- Здания --- */
  _buildings() {
    for (let bi = 0; bi < 8; bi++) for (let bj = 0; bj < 8; bj++) {
      if (this.blockSpecial(bi, bj)) continue;
      const dist = this.blockDistrict(bi, bj);
      const d = DISTRICTS.find((dd) => dd.id === dist);
      if (!d) continue;
      const r = this.blockRect(bi, bj);
      const placed = [];
      const attempts = d.dens * 3 + 2;
      for (let k = 0; k < attempts; k++) {
        if (placed.length >= d.dens + 1) break;
        const w = rand(12, Math.min(38, r.x1 - r.x0 - 6));
        const dep = rand(12, Math.min(38, r.z1 - r.z0 - 6));
        const x = rand(r.x0 + 4, r.x1 - 4 - w);
        const z = rand(r.z0 + 4, r.z1 - 4 - dep);
        let ok = true;
        for (const p of placed) {
          if (x < p.x1 + 5 && p.x < x + w + 5 && z < p.z1 + 5 && p.z < z + dep + 5) { ok = false; break; }
        }
        if (!ok) continue;
        const h = rand(d.height[0], d.height[1]);
        placed.push({ x, z, w, dep });
        this._building(x, z, w, dep, h, d);
      }
    }
  }

  _building(x, z, w, dep, h, dist) {
    const palette = dist.palette;
    const cols = clamp(Math.round(w / 4.2), 2, 9);
    const rows = clamp(Math.round(h / 3.2 / 2) * 2, 2, 14);
    const lit = dist.id === 'center' ? 0.22 : 0.12;
    // sideMat/roofMat переиспользуются из кеша (utils.js) по составному ключу —
    // не создаём новый материал на каждое здание
    const sideMat = getWindowMaterial(palette, cols, rows, lit);
    this.windowMats.add(sideMat);
    const roofMat = getRoofMaterial(palette, choice(PALETTES[palette]));
    const bottomMat = this._bottomMat;
    const mats = [sideMat, sideMat, roofMat, bottomMat, sideMat, sideMat];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, dep), mats);
    mesh.position.set(x + w / 2, 0.15 + h / 2, z + dep / 2);
    mesh.castShadow = true;
    this.scene.add(mesh);
    if (this.rng() < 0.22) {
      const pyr = new THREE.Mesh(new THREE.ConeGeometry(w * 0.62, h * 0.42, 4), roofMat);
      pyr.rotation.y = Math.PI / 4;
      pyr.position.set(x + w / 2, 0.15 + h + h * 0.21, z + dep / 2);
      this.scene.add(pyr);
    }
    this.buildings.push({ x0: x, z0: z, x1: x + w, z1: z + dep, h, mesh });
    // козырёк над входом у части зданий (выступ за фасад)
    if (this.rng() < 0.3 && h > 5) {
      const aw = new THREE.Mesh(new THREE.BoxGeometry(Math.min(w * 0.3, 4), 0.1, 1.1), roofMat);
      const side = Math.floor(this.rng() * 4);
      const hy = 0.15 + Math.min(h * 0.3, 4.5);
      if (side === 0) aw.position.set(x + w / 2, hy, z + dep / 2 + dep / 2 + 0.55);
      else if (side === 1) aw.position.set(x + w / 2, hy, z + dep / 2 - dep / 2 - 0.55);
      else if (side === 2) aw.position.set(x + w / 2 + w / 2 + 0.55, hy, z + dep / 2);
      else aw.position.set(x + w / 2 - w / 2 - 0.55, hy, z + dep / 2);
      aw.rotation.y = side < 2 ? 0 : Math.PI / 2;
      this.scene.add(aw);
    }
  }

  /* --- Особые кварталы --- */
  _specials() {
    this._parkCvetnik();
    this._lakeProval();
    this._market();
    this._station();
    this._narzan();
    this._eagleMonument();
    this._pyatigorskTramway();
    this._ostapBenderStatue();
    this._tvTower();
    this._cityStela();
  }

  /* Памятник Орлу на Горячей горе — главный символ Пятигорска и КМВ */
  _eagleMonument() {
    const cx = -38, cz = 20;
    const g = new THREE.Group();
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x8a8a80 });
    const eagleMat = new THREE.MeshLambertMaterial({ color: 0x6a5a4a });
    const goldMat = new THREE.MeshLambertMaterial({ color: 0xd8a030 });
    const snakeMat = new THREE.MeshLambertMaterial({ color: 0x2e4a30 });

    // Каменный постамент (имитация скалы)
    const base1 = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.0, 1.2, 8), stoneMat);
    base1.position.y = 0.6; g.add(base1);
    const base2 = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.3, 1.4, 8), stoneMat);
    base2.position.y = 1.9; g.add(base2);

    // Змея вокруг скалы
    const snake = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.22, 6, 16), snakeMat);
    snake.rotation.x = Math.PI / 2.3;
    snake.position.y = 2.1; g.add(snake);

    // Орел (туловище, голова, клюв, крылья)
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.6, 6), eagleMat);
    body.position.y = 3.2; body.rotation.x = -0.3; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.35, 6, 6), eagleMat);
    head.position.set(0, 4.0, 0.3); g.add(head);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.4, 4), goldMat);
    beak.position.set(0, 3.95, 0.65); beak.rotation.x = Math.PI / 2; g.add(beak);

    // Расправленные крылья
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.15, 0.8), eagleMat);
      wing.position.set(s * 1.1, 3.6, -0.1);
      wing.rotation.z = s * 0.3;
      wing.rotation.y = s * 0.2;
      g.add(wing);
    }

    g.position.set(cx, 0, cz);
    this.scene.add(g);
    this.propsAABB.push({ x0: cx - 3.2, z0: cz - 3.2, x1: cx + 3.2, z1: cz + 3.2 });
  }

  /* Пятигорский узкоколейный Трамвай (реалистичные рельсы со шпалами, вагон КТМ-1) */
  _pyatigorskTramway() {
    const railMat = new THREE.MeshLambertMaterial({ color: 0xc4c4cc });
    const tieMat = new THREE.MeshLambertMaterial({ color: 0x3e342a });
    const bedMat = new THREE.MeshLambertMaterial({ color: 0x48484c });
    const metalMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3c });
    const tramBodyMat = new THREE.MeshLambertMaterial({ color: 0xcc2222 });
    const tramCreamMat = new THREE.MeshLambertMaterial({ color: 0xf4eedc });
    const glassMat = new THREE.MeshLambertMaterial({ color: 0x1c2836, transparent: true, opacity: 0.7 });
    const doorMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2c });
    const seatMat = new THREE.MeshLambertMaterial({ color: 0x8a5a3a });

    // 1. Межрельсовое мощение / желоб в асфальте (от x = -240 до x = 240)
    const bed = new THREE.Mesh(new THREE.BoxGeometry(480, 0.03, 1.5), bedMat);
    bed.position.set(0, 0.04, 0);
    this.scene.add(bed);

    // 2. Деревянные шпалы вдоль путей через каждые 2.5 м
    const tiesM = [];
    const tieGeo = new THREE.BoxGeometry(0.25, 0.05, 1.4);
    for (let x = -238; x <= 238; x += 2.5) {
      tiesM.push(new THREE.Matrix4().makeTranslation(x, 0.06, 0));
    }
    const tieMesh = new THREE.InstancedMesh(tieGeo, tieMat, tiesM.length);
    tiesM.forEach((m, i) => tieMesh.setMatrixAt(i, m));
    this.scene.add(tieMesh);

    // 3. Стальные головки рельсов (узкая колея 1000 мм — отступ ±0.55 м)
    for (const off of [-0.55, 0.55]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(480, 0.09, 0.07), railMat);
      rail.position.set(0, 0.1, off);
      this.scene.add(rail);
    }

    // (ПРОВОДА И СТОЛБЫ УБРАНЫ ПО ТРЕБОВАНИЮ ПОЛЬЗОВАТЕЛЯ)

    // 4. Детализированный 3D-трамвайчик КТМ-1 / Татра
    const tram = new THREE.Group();

    // Нижняя рама и тележки
    const frame = new THREE.Mesh(new THREE.BoxGeometry(10.2, 0.3, 2.2), metalMat);
    frame.position.y = 0.5; tram.add(frame);

    // Бамперы
    for (const sx of [-5.15, 5.15]) {
      const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.35, 2.3), metalMat);
      bumper.position.set(sx, 0.5, 0); tram.add(bumper);
      const coupler = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.6, 6), metalMat);
      coupler.rotation.z = Math.PI / 2;
      coupler.position.set(sx + (sx > 0 ? 0.3 : -0.3), 0.45, 0); tram.add(coupler);
    }

    // Колёса (4 колесные пары)
    const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.1, 12);
    wheelGeo.rotateX(Math.PI / 2);
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x222224 });
    for (const wx of [-2.8, -1.6, 1.6, 2.8]) {
      for (const wz of [-0.55, 0.55]) {
        const wh = new THREE.Mesh(wheelGeo, wheelMat);
        wh.position.set(wx, 0.35, wz); tram.add(wh);
      }
    }

    // Основной красный кузов
    const body = new THREE.Mesh(new THREE.BoxGeometry(10.0, 1.4, 2.36), tramBodyMat);
    body.position.y = 1.35; tram.add(body);

    // Бежевая верхняя полоса
    const topStrip = new THREE.Mesh(new THREE.BoxGeometry(10.05, 0.7, 2.38), tramCreamMat);
    topStrip.position.y = 2.4; tram.add(topStrip);

    // Закруглённая крыша
    const roof = new THREE.Mesh(new THREE.BoxGeometry(9.8, 0.35, 2.25), tramCreamMat);
    roof.position.y = 2.9; tram.add(roof);

    // Вентиляционные короба на крыше
    for (const rx of [-2.5, 0, 2.5]) {
      const vent = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 0.8), metalMat);
      vent.position.set(rx, 3.12, 0); tram.add(vent);
    }

    // Пантограф на крыше
    const pantoFrame = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 1.2), metalMat);
    pantoFrame.position.set(-0.5, 3.12, 0); tram.add(pantoFrame);
    const pantoLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 5), metalMat);
    pantoLeg.rotation.z = Math.PI / 4;
    pantoLeg.position.set(-0.5, 3.7, 0); tram.add(pantoLeg);
    const pantoHead = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 1.6), metalMat);
    pantoHead.position.set(-0.1, 4.2, 0); tram.add(pantoHead);

    // Остекление (боковые и лобовые стёкла)
    const glass = new THREE.Mesh(new THREE.BoxGeometry(9.6, 0.85, 2.42), glassMat);
    glass.position.y = 2.15; tram.add(glass);

    // Пассажирские двери (3 двустворчатые двери сбоку)
    for (const dx of [-3.2, 0, 3.2]) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.8, 0.08), doorMat);
      door.position.set(dx, 1.55, 1.16); tram.add(door);
      const doorGlass = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 0.1), glassMat);
      doorGlass.position.set(dx, 1.9, 1.16); tram.add(doorGlass);
    }

    // Салон: Сиденья внутри вагона
    for (let sx = -3.8; sx <= 3.8; sx += 1.2) {
      for (const sz of [-0.7, 0.7]) {
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.4, 0.45), seatMat);
        seat.position.set(sx, 1.0, sz); tram.add(seat);
      }
    }

    // Передние фары (яркий тёплый свет)
    const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfff0aa });
    for (const hz of [-0.6, 0.6]) {
      const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 10), headlightMat);
      hl.rotation.z = Math.PI / 2;
      hl.position.set(-5.06, 1.1, hz); tram.add(hl);
    }

    // Задние красные габариты
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2222 });
    for (const tz of [-0.7, 0.7]) {
      const tl = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.1, 8), tailMat);
      tl.rotation.z = Math.PI / 2;
      tl.position.set(5.06, 1.1, tz); tram.add(tl);
    }

    // Маршрутный софит / Маршрутоуказатель «№ 1 ЦВЕТНИК — ВОКЗАЛ» над лобовым стеклом
    const routeBox = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.35, 1.2), new THREE.MeshLambertMaterial({ color: 0x111111 }));
    routeBox.position.set(-5.02, 2.55, 0); tram.add(routeBox);
    const routeSign = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.28, 1.1), new THREE.MeshBasicMaterial({ color: 0xffdf66 }));
    routeSign.position.set(-5.1, 2.55, 0); tram.add(routeSign);

    tram.position.set(-32, 0, 0);
    this.scene.add(tram);
    this.propsAABB.push({ x0: -38, z0: -1.5, x1: -26, z1: 1.5 });

    // Остановки трамвая («Парк Цветник», «Вокзал», «Лира»)
    this._tramStop(-36, -7.5);
    this._tramStop(148, 7.5);
    this._tramStop(88, -7.5);
  }

  _tramStop(x, z) {
    const g = new THREE.Group();
    const glassMat = new THREE.MeshLambertMaterial({ color: 0x4a7fa8, transparent: true, opacity: 0.6 });
    const metalMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3c });
    const shelter = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.1, 2.2), metalMat);
    shelter.position.y = 2.4; g.add(shelter);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(4.0, 2.2, 0.08), glassMat);
    wall.position.set(0, 1.1, -1.0); g.add(wall);

    // Локальная скамейка на остановке
    const p1 = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.55), new THREE.MeshLambertMaterial({ color: 0x8a6a44 }));
    p1.position.set(0, 0.55, -0.4); g.add(p1);
    const p2 = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 0.1), new THREE.MeshLambertMaterial({ color: 0x8a6a44 }));
    p2.position.set(0, 0.8, -0.66); g.add(p2);

    g.position.set(x, 0, z);
    this.scene.add(g);
    this.propsAABB.push({ x0: x - 2.2, z0: z - 1.2, x1: x + 2.2, z1: z + 1.2 });
  }

  /* Памятник Остапу Бендеру у входа в Провал */
  _ostapBenderStatue() {
    const cx = -96, cz = -140;
    const g = new THREE.Group();
    const bronzeMat = new THREE.MeshLambertMaterial({ color: 0x7a6a4a });
    const woodMat = new THREE.MeshLambertMaterial({ color: 0x6a4a2a });

    // Остап Бендер в фуражке
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.28, 1.5, 6), bronzeMat);
    body.position.y = 0.8; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 6, 6), bronzeMat);
    head.position.y = 1.7; g.add(head);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.06, 6), bronzeMat);
    cap.position.set(0, 1.82, 0.02); g.add(cap);

    // 12-й стул рядом
    const chairSeat = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.08, 0.45), woodMat);
    chairSeat.position.set(0.45, 0.5, 0); g.add(chairSeat);
    const chairBack = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.5, 0.06), woodMat);
    chairBack.position.set(0.45, 0.75, -0.2); g.add(chairBack);

    // Табличка билетов на Провал
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.4, 0.05), new THREE.MeshLambertMaterial({ color: 0xf2c12e }));
    sign.position.set(-0.5, 0.8, 0); g.add(sign);

    g.position.set(cx, 0, cz);
    this.scene.add(g);
    this.propsAABB.push({ x0: cx - 1.2, z0: cz - 1.2, x1: cx + 1.2, z1: cz + 1.2 });
  }

  /* Пятигорская Телевышка на вершине Машука (красно-белая вышка с маяком) */
  _tvTower() {
    const cx = 0, cz = -448, baseY = 58;
    const g = new THREE.Group();
    const redMat = new THREE.MeshBasicMaterial({ color: 0xee2222 });
    const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    for (let i = 0; i < 8; i++) {
      const r1 = 3.5 * (1 - i / 9);
      const r2 = 3.5 * (1 - (i + 1) / 9);
      const sec = new THREE.Mesh(new THREE.CylinderGeometry(r2, r1, 5.0, 4), i % 2 === 0 ? redMat : whiteMat);
      sec.position.y = baseY + 2.5 + i * 5.0;
      g.add(sec);
    }

    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.4, 12, 4), redMat);
    spire.position.y = baseY + 46; g.add(spire);

    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff3333 }));
    beacon.position.y = baseY + 52; g.add(beacon);

    this.scene.add(g);
  }

  /* Въездная стела «ПЯТИГОРСК — КУРОРТ» */
  _cityStela() {
    const cx = 0, cz = 245;
    const g = new THREE.Group();
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0xd8d0c0 });
    const goldMat = new THREE.MeshLambertMaterial({ color: 0xf2c12e });

    const pillar = new THREE.Mesh(new THREE.BoxGeometry(6.4, 4.5, 0.8), stoneMat);
    pillar.position.y = 2.25; g.add(pillar);
    const topR = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.6, 1.0), goldMat);
    topR.position.y = 4.8; g.add(topR);

    const emblem = new THREE.Mesh(new THREE.CircleGeometry(0.9, 8), goldMat);
    emblem.position.set(0, 2.6, 0.42); g.add(emblem);

    g.position.set(cx, 0, cz);
    this.scene.add(g);
    this.propsAABB.push({ x0: cx - 4, z0: cz - 1, x1: cx + 4, z1: cz + 1 });
  }

  /* Цветник: фонтан, клумбы, скамейки */
  _parkCvetnik() {
    const cx = -32, cz = 32;
    const mat = new THREE.MeshLambertMaterial({ color: 0xb8b8b0 });
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(6, 6.6, 0.9, 12), mat);
    basin.position.set(cx, 0.55, cz);
    this.scene.add(basin);
    const water = new THREE.Mesh(new THREE.CircleGeometry(5.6, 16), new THREE.MeshPhongMaterial({ color: 0x66ccff, transparent: true, opacity: 0.85, shininess: 60 }));
    water.rotation.x = -Math.PI / 2;
    water.position.set(cx, 1.05, cz);
    this.scene.add(water);
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 2.4, 8), mat);
    pillar.position.set(cx, 2.2, cz);
    this.scene.add(pillar);
    const topDisc = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 0.8, 0.35, 8), mat);
    topDisc.position.set(cx, 3.4, cz);
    this.scene.add(topDisc);
    this.propsAABB.push({ x0: cx - 6.6, z0: cz - 6.6, x1: cx + 6.6, z1: cz + 6.6 });
    // клумбы
    const bedColors = [0xd94f4f, 0xe8b84a, 0xb06ad9, 0x5aa85a, 0xe87a3a, 0x4a7fd9];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const b = new THREE.Mesh(new THREE.BoxGeometry(5, 0.45, 1.6), new THREE.MeshLambertMaterial({ color: bedColors[i] }));
      b.position.set(cx + Math.cos(a) * 11, 0.32, cz + Math.sin(a) * 11);
      this.scene.add(b);
      this.propsAABB.push({ x0: b.position.x - 2.5, z0: b.position.z - 0.8, x1: b.position.x + 2.5, z1: b.position.z + 0.8 });
    }
    this._bench(cx + 13, cz - 4, Math.PI / 2);
    this._bench(cx + 13, cz + 4, Math.PI / 2);
    this._bench(cx - 13, cz - 4, -Math.PI / 2);
    this._bench(cx - 13, cz + 4, -Math.PI / 2);
    this._bench(cx - 4, cz + 13, 0);
    this._bench(cx + 4, cz + 13, 0);
  }

  _bench(x, z, rotY) {
    const group = new THREE.Group();
    const p1 = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.55), new THREE.MeshLambertMaterial({ color: 0x8a6a44 }));
    p1.position.y = 0.55; group.add(p1);
    const p2 = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 0.1), new THREE.MeshLambertMaterial({ color: 0x8a6a44 }));
    p2.position.set(0, 0.8, -0.26); group.add(p2);
    for (const s of [-0.78, 0.78]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.42), new THREE.MeshLambertMaterial({ color: 0x5a5a54 }));
      leg.position.set(s, 0.25, 0); group.add(leg);
    }
    group.position.set(x, 0.12, z);
    group.rotation.y = rotY;
    this.scene.add(group);
    const bx = this._rotRect(x, z, rotY, 1.9, 0.7);
    this.propsAABB.push(bx);
  }

  _rotRect(x, z, rot, w, d) {
    const half = (w + d) / 2;
    return { x0: x - half, z0: z - half, x1: x + half, z1: z + half };
  }

  /* Провал: озеро в кратере */
  _lakeProval() {
    const cx = -96, cz = -160;
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(24, 24),
      new THREE.MeshPhongMaterial({ color: 0x33a8ff, emissive: 0x0e5a9e, emissiveIntensity: 0.25, transparent: true, opacity: 0.92, shininess: 80 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(cx, 0.3, cz);
    this.scene.add(water);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(24.4, 1.1, 6, 26),
      new THREE.MeshLambertMaterial({ color: 0x9a9a90 })
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.set(cx, 0.5, cz);
    this.scene.add(rim);
    // столбики ограждения (радиус 24.6 — чтобы не заезжать на проезжую часть:
    // ближайшие дороги x=-64 и z=-192/-128 проходят в 32 м от центра озера)
    const posts = [];
    const postGeo = new THREE.CylinderGeometry(0.14, 0.16, 1.1, 5);
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      posts.push(new THREE.Matrix4().makeTranslation(cx + Math.cos(a) * 24.6, 0.55, cz + Math.sin(a) * 24.6));
    }
    const pm = new THREE.InstancedMesh(postGeo, new THREE.MeshLambertMaterial({ color: 0x8a8a84 }), posts.length);
    posts.forEach((m, i) => pm.setMatrixAt(i, m));
    this.scene.add(pm);
    this.circleColliders.push({ x: cx, z: cz, r: 26 });
  }

  /* Рынок «Лира» */
  _market() {
    const x0 = 80, z0 = -48;
    const stripeTex = this._stripedTexture('#c0392b', '#f0f0e8');
    const postsGeo = new THREE.BoxGeometry(8, 0.8, 4.6);
    const canopyGeo = new THREE.BoxGeometry(8.4, 0.24, 5);
    const legGeo = new THREE.CylinderGeometry(0.16, 0.18, 2.8, 5);
    const crateGeo = new THREE.BoxGeometry(1.1, 0.7, 1.1);

    const postsM = [], canopyM = [], legM = [], crateM = [];

    for (let ri = 0; ri < 3; ri++) for (let ci = 0; ci < 4; ci++) {
      const x = x0 + ci * 9, z = z0 + ri * 14;
      postsM.push(new THREE.Matrix4().makeTranslation(x, 1.4, z));
      canopyM.push(new THREE.Matrix4().makeTranslation(x, 3.1, z));
      for (const sx of [-3, 3]) {
        legM.push(new THREE.Matrix4().makeTranslation(x + sx, 1.5, z));
      }
      this.propsAABB.push({ x0: x - 4.4, z0: z - 2.6, x1: x + 4.4, z1: z + 2.6 });
    }
    for (let i = 0; i < 8; i++) {
      const cx = 79 + this.rng() * 34, cz = -10 + this.rng() * 8;
      crateM.push(new THREE.Matrix4().makeTranslation(cx, 0.5, cz));
      this.propsAABB.push({ x0: cx - 0.6, z0: cz - 0.6, x1: cx + 0.6, z1: cz + 0.6 });
    }

    const postsMesh = new THREE.InstancedMesh(postsGeo, new THREE.MeshLambertMaterial({ color: 0x6a6a60 }), postsM.length);
    postsM.forEach((m, i) => postsMesh.setMatrixAt(i, m));
    this.scene.add(postsMesh);

    const canopyMesh = new THREE.InstancedMesh(canopyGeo, new THREE.MeshLambertMaterial({ map: stripeTex }), canopyM.length);
    canopyM.forEach((m, i) => canopyMesh.setMatrixAt(i, m));
    this.scene.add(canopyMesh);

    const legMesh = new THREE.InstancedMesh(legGeo, new THREE.MeshLambertMaterial({ color: 0x4a4a44 }), legM.length);
    legM.forEach((m, i) => legMesh.setMatrixAt(i, m));
    this.scene.add(legMesh);

    const crateMesh = new THREE.InstancedMesh(crateGeo, new THREE.MeshLambertMaterial({ color: 0xb87a3a }), crateM.length);
    crateM.forEach((m, i) => crateMesh.setMatrixAt(i, m));
    this.scene.add(crateMesh);
  }

  /* Текстура тротуарной плитки (canvas, швы по краям) */
  _pavementTexture(key = 'pavement') {
    if (_texCache.has(key)) return _texCache.get(key);
    const c = makeCanvas(32, 32);
    const g = c.getContext('2d');
    g.fillStyle = '#a8a89e';
    g.fillRect(0, 0, 32, 32);
    g.fillStyle = '#8f8f86';
    g.fillRect(0, 0, 32, 1);
    g.fillRect(0, 0, 1, 32);
    g.fillStyle = '#b6b6ac';
    g.fillRect(1, 1, 30, 30);
    const t = canvasToTexture(c, key);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }

  _stripedTexture(c1, c2) {
    const key = 'strip_' + c1;
    if (_texCache.has(key)) return _texCache.get(key);
    const c = makeCanvas(64, 64);
    const g = c.getContext('2d');
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 === 0 ? c1 : c2;
      g.fillRect(i * 8, 0, 8, 64);
    }
    const t = canvasToTexture(c, key);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* Вокзал */
  _station() {
    const mat = new THREE.MeshLambertMaterial({ color: 0xc8b898 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(56, 14, 18), mat);
    b.position.set(160, 0.15 + 7, 82);
    b.castShadow = true;
    this.scene.add(b);
    const tower = new THREE.Mesh(new THREE.BoxGeometry(9, 26, 9), new THREE.MeshLambertMaterial({ color: 0xd8c8a8 }));
    tower.position.set(160, 0.15 + 13, 82);
    this.scene.add(tower);
    const clock = new THREE.Mesh(new THREE.CircleGeometry(2.6, 14), new THREE.MeshBasicMaterial({ color: 0xf5f5ee }));
    clock.position.set(164.6, 0.15 + 20, 82);
    clock.rotation.y = Math.PI / 2;
    this.scene.add(clock);
    const troof = new THREE.Mesh(new THREE.ConeGeometry(7.5, 6, 4), new THREE.MeshLambertMaterial({ color: 0x6a4a2a }));
    troof.rotation.y = Math.PI / 4;
    troof.position.set(160, 0.15 + 26 + 3, 82);
    this.scene.add(troof);
    this.buildings.push({ x0: 132, z0: 73, x1: 188, z1: 91, h: 14, mesh: b });
    this.buildings.push({ x0: 155.5, z0: 77.5, x1: 164.5, z1: 86.5, h: 26, mesh: tower });
    // платформа и пути
    const plat = new THREE.Mesh(new THREE.BoxGeometry(46, 0.6, 5), new THREE.MeshLambertMaterial({ color: 0xb0b0a8 }));
    plat.position.set(160, 0.32, 100);
    this.scene.add(plat);
    const trackMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });
    for (let i = 0; i < 3; i++) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(90, 0.25, 1.2), trackMat);
      t.position.set(160, 0.16, 106 + i * 4.5);
      this.scene.add(t);
    }
    // поезд
    const train = mergeColored([
      { g: new THREE.BoxGeometry(38, 3.4, 2.9), c: 0x2e8a4e },
      { g: new THREE.BoxGeometry(5, 3.6, 2.9), c: 0x1f6a3a },
      { g: new THREE.BoxGeometry(5, 3.6, 2.9), c: 0x1f6a3a },
      { g: new THREE.BoxGeometry(1, 1.2, 0.4), c: 0xeeeeee },
    ]);
    const tm = new THREE.Mesh(train, new THREE.MeshLambertMaterial({ vertexColors: true }));
    tm.position.set(140, 0.4 + 1.7, 106);
    this.scene.add(tm);
    this.propsAABB.push({ x0: 137, z0: 102.5, x1: 159, z1: 109.5 });
  }

  /* Нарзанные ванны — купол */
  _narzan() {
    const cx = -32, cz = -32;
    const mat = new THREE.MeshLambertMaterial({ color: 0xe8dcc8 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(13, 14, 12, 14), mat);
    body.position.set(cx, 0.15 + 6, cz);
    this.scene.add(body);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(13, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    dome.position.set(cx, 0.15 + 12, cz);
    this.scene.add(dome);

    const colGeo = new THREE.CylinderGeometry(0.6, 0.7, 13.4, 6);
    const colsMesh = new THREE.InstancedMesh(colGeo, mat, 8);
    const m4Col = new THREE.Matrix4();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      m4Col.makeTranslation(cx + Math.cos(a) * 12.6, 0.15 + 6.7, cz + Math.sin(a) * 12.6);
      colsMesh.setMatrixAt(i, m4Col);
    }
    this.scene.add(colsMesh);

    const sgn = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.4, 6), new THREE.MeshLambertMaterial({ color: 0x666666 }));
    sgn.position.set(cx, 0.15 + 12 + 13 + 0.7, cz);
    this.scene.add(sgn);
    this.propsAABB.push({ x0: cx - 14, z0: cz - 14, x1: cx + 14, z1: cz + 14 });
  }

  /* --- Деревья (InstancedMesh) --- */
  _trees() {
    const rng = this.rng;
    const trunkD = new THREE.CylinderGeometry(0.3, 0.45, 2.4, 5);
    trunkD.translate(0, 1.2, 0);
    const crownD = new THREE.SphereGeometry(1.7, 7, 5);
    crownD.translate(0, 2.7, 0);
    const deciduous = mergeColored([{ g: trunkD, c: '#ffffff' }, { g: crownD, c: '#ffffff' }]);
    const trunkC = new THREE.CylinderGeometry(0.3, 0.45, 2.0, 5);
    trunkC.translate(0, 1.0, 0);
    const crownC = new THREE.ConeGeometry(2.2, 5.5, 7);
    crownC.translate(0, 1.5, 0);
    const conifer = mergeColored([{ g: trunkC, c: '#ffffff' }, { g: crownC, c: '#ffffff' }]);
    const dMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: false });
    const cMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: false });
    const spots = []; // {x,z,type}

    const tryAddTree = (x, z, type) => {
      if (!this.isPositionValid(x, z, 1.8)) return;
      // не на серпантине
      for (const s of this._strips) {
        if (s.axis === 'z') { if (x > s.x0 - 6 && x < s.x1 + 6 && z > s.z0 && z < s.z1) return; }
        else { if (x > s.x0 && x < s.x1 && z > s.z0 - 6 && z < s.z1 + 6) return; }
      }
      spots.push({ x, z, type });
      this.propsAABB.push({ x0: x - 1.6, z0: z - 1.6, x1: x + 1.6, z1: z + 1.6 });
    };

    for (let bi = 0; bi < 8; bi++) for (let bj = 0; bj < 8; bj++) {
      const dist = this.blockDistrict(bi, bj);
      const sp = this.blockSpecial(bi, bj);
      const r = this.blockRect(bi, bj);
      let n = { center: 1, kurort: 3, prigorod: 2, sanatorii: 4, mashuk: 3, proval: 8, rynok: 2, vokzal: 3 }[dist] || 2;
      if (sp === 'park') n = 12;
      for (let k = 0; k < n; k++) {
        const x = rng() * 44 + r.x0, z = rng() * 44 + r.z0;
        if (sp === 'park') {
          const dc = dist2D(x, z, -32, 32);
          if (dc < 15) continue; // не в фонтане
        }
        tryAddTree(x, z, rng() < 0.75 ? 0 : 1);
      }
    }
    // опушка Машука и предгорье
    for (let k = 0; k < 70; k++) {
      const x = (rng() - 0.5) * 320, z = -300 - rng() * 200;
      tryAddTree(x, z, rng() < 0.35 ? 0 : 1);
    }
    // окраины
    for (let k = 0; k < 60; k++) {
      const a = rng() * Math.PI * 2, dd = 320 + rng() * 300;
      tryAddTree(Math.cos(a) * dd, Math.sin(a) * dd, rng() < 0.7 ? 0 : 1);
    }

    const dMesh = new THREE.InstancedMesh(deciduous, dMat, spots.filter((s) => s.type === 0).length);
    const cMesh = new THREE.InstancedMesh(conifer, cMat, spots.filter((s) => s.type === 1).length);
    const dCols = [0x5a9a4a, 0x6aaa55, 0x4d8a42, 0x74b25e];
    const cCols = [0x2e6a3e, 0x3a7a48, 0x275a33];
    let di = 0, ci = 0;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3();
    for (const sp of spots) {
      const isD = sp.type === 0;
      const target = isD ? dMesh : cMesh;
      const idx = isD ? di++ : ci++;
      e.set(0, rng() * Math.PI * 2, 0);
      q.setFromEuler(e);
      const sc = 0.75 + rng() * 0.6;
      s.set(sc, sc * (0.85 + rng() * 0.4), sc);
      m4.compose(new THREE.Vector3(sp.x, 0.1, sp.z), q, s);
      target.setMatrixAt(idx, m4);
      target.setColorAt(idx, new THREE.Color(choice(isD ? dCols : cCols)));
    }
    this.scene.add(dMesh, cMesh);
  }

  /* --- Фонари --- */
  _lamps() {
    const poleC = new THREE.CylinderGeometry(0.12, 0.16, 5.6, 6);
    poleC.translate(0, 2.8, 0);
    const headC = new THREE.BoxGeometry(0.55, 0.2, 0.4);
    headC.translate(0.35, 5.6, 0);
    const poleGeo = mergeColored([{ g: poleC, c: '#ffffff' }, { g: headC, c: '#ffffff' }]);
    const headGeo = headC;
    const pos = [];
    const step = 48;
    // offset 8.5 — на тротуаре у края дороги
    const LAMP_OFF = 8.5;
    const Z0 = -224 + 24;

    for (const r of this.roadsV) {
      let side = 1;
      for (let z = Z0; z <= 224 + 24; z += step) {
        const lx = r.c - LAMP_OFF * side;
        if (this.isPositionValid(lx, z, 0.5)) {
          pos.push({ x: lx, z, rot: side === 1 ? 0 : Math.PI, side });
          this.propsAABB.push({ x0: lx - 0.4, z0: z - 0.4, x1: lx + 0.4, z1: z + 0.4 });
        }
        side = -side;
      }
    }
    for (const r of this.roadsH) {
      let side = 1;
      for (let x = Z0; x <= 224 + 24; x += step) {
        const lz = r.c - LAMP_OFF * side;
        if (this.isPositionValid(x, lz, 0.5)) {
          pos.push({ x, z: lz, rot: -side * Math.PI / 2, side });
          this.propsAABB.push({ x0: x - 0.4, z0: lz - 0.4, x1: x + 0.4, z1: lz + 0.4 });
        }
        side = -side;
      }
    }

    const poleMat = new THREE.MeshLambertMaterial({ color: 0x4a4a4a });
    const headMat = new THREE.MeshBasicMaterial({ color: 0xfff2b0 });
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, pos.length);
    const heads = new THREE.InstancedMesh(headGeo, headMat, pos.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1);
    pos.forEach((p, i) => {
      e.set(0, p.rot, 0); q.setFromEuler(e);
      m4.compose(new THREE.Vector3(p.x, 0.1, p.z), q, s);
      poles.setMatrixAt(i, m4);
      heads.setMatrixAt(i, m4);
    });
    this.scene.add(poles);
    heads.visible = false;
    this.scene.add(heads);
    this.lampHeadMesh = heads;
  }

  /* --- Скамейки, урны, кусты --- */
  _props() {
    // урны
    const binB = new THREE.CylinderGeometry(0.34, 0.4, 0.85, 7);
    binB.translate(0, 0.425, 0);
    const binL = new THREE.CylinderGeometry(0.45, 0.4, 0.12, 7);
    binL.translate(0, 0.89, 0);
    const binGeo = mergeColored([{ g: binB, c: '#ffffff' }, { g: binL, c: '#ffffff' }]);
    const bins = [];
    for (let i = 0; i < 30; i++) {
      const road = this.rng() < 0.5;
      const c = (this.rng() - 0.5) * 460;
      const side = choice([-1, 1]);
      let x, z;
      if (road) { x = Math.round(c / CFG.CELL) * CFG.CELL + 8.5 * side; z = (this.rng() - 0.5) * 440; }
      else { z = Math.round(c / CFG.CELL) * CFG.CELL + 8.5 * side; x = (this.rng() - 0.5) * 440; }
      if (!this.isPositionValid(x, z, 0.6)) continue;
      bins.push(new THREE.Matrix4().makeTranslation(x, 0.1, z));
      this.propsAABB.push({ x0: x - 0.5, z0: z - 0.5, x1: x + 0.5, z1: z + 0.5 });
    }
    const binMesh = new THREE.InstancedMesh(binGeo, new THREE.MeshLambertMaterial({ color: 0x7a7a72 }), bins.length);
    bins.forEach((m, i) => binMesh.setMatrixAt(i, m));
    this.scene.add(binMesh);

    // кусты
    const bushGeo = new THREE.SphereGeometry(0.9, 6, 4);
    const bushes = [];
    for (let i = 0; i < 50; i++) {
      const x = (this.rng() - 0.5) * 500, z = (this.rng() - 0.5) * 500;
      if (!this.isPositionValid(x, z, 1.2)) continue;
      const m4 = new THREE.Matrix4();
      const e2 = new THREE.Euler(0, this.rng() * 6.28, 0);
      const q2 = new THREE.Quaternion().setFromEuler(e2);
      m4.compose(new THREE.Vector3(x, 0.12, z), q2, new THREE.Vector3(1, 0.7, 1));
      bushes.push(m4);
      this.propsAABB.push({ x0: x - 1.0, z0: z - 1.0, x1: x + 1.0, z1: z + 1.0 });
    }
    const bushMesh = new THREE.InstancedMesh(bushGeo, new THREE.MeshLambertMaterial({ color: 0x4a8a42 }), bushes.length);
    bushes.forEach((m, i) => bushMesh.setMatrixAt(i, m));
    this.scene.add(bushMesh);
  }

  _inCity(x, z) { return Math.abs(x) < 250 && Math.abs(z) < 250; }

  /* --- Заправки --- */
  _fuelStations() {
    const tex = (() => {
      const key = 'azs';
      if (_texCache.has(key)) return _texCache.get(key);
      const c = makeCanvas(256, 128);
      const g = c.getContext('2d');
      g.fillStyle = '#e03030'; g.fillRect(0, 0, 256, 128);
      g.fillStyle = '#fff'; g.font = 'bold 64px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('АЗС', 128, 66);
      const t = canvasToTexture(c, key);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const placed = [];
    // координаты заправок в конфиге лежат на перекрёстках (кратны CELL) —
    // ищем свободное место в углах кварталов вокруг перекрёстка
    // (сначала свой квартал, затем соседние перекрёстки)
    const D = [14, 18, 22, 26, 30];
    const centers = [[0, 0], [64, 0], [-64, 0], [0, 64], [0, -64], [64, 64], [-64, 64], [64, -64], [-64, -64], [128, 0], [-128, 0], [0, 128], [0, -128]];
    for (const s of this.fuelStations) {
      let x = s.x, z = s.z;
      outer:
      for (const [gx, gz] of centers) {
        for (const dx of D) for (const dz of D) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          const cx = s.x + gx + dx * sx, cz = s.z + gz + dz * sz;
          if (Math.abs(cx) > 290 || Math.abs(cz) > 290) continue;
          if (this.distToRoad(cx, cz) < CFG.HALF + CFG.SIDE + 2) continue; // на дороге
          for (const b of this.buildings) {
            if (cx + 6 > b.x0 - 2 && cx - 6 < b.x1 + 2 && cz + 4 > b.z0 - 2 && cz - 4 < b.z1 + 2) continue outer;
          }
          for (const p of placed) {
            if (Math.abs(cx - p.x) < 14 && Math.abs(cz - p.z) < 12) continue outer;
          }
          x = cx; z = cz;
          break outer;
        }
      }
      placed.push({ x, z });
      s.x = x; s.z = z; // записываем реальную позицию (для refuel-интеракции)
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(9, 0.3, 5), new THREE.MeshLambertMaterial({ color: 0xd84040 }));
      canopy.position.set(x, 3.4, z);
      this.scene.add(canopy);
      for (const sx of [-3.4, 3.4]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 3.2, 5), new THREE.MeshLambertMaterial({ color: 0x6a6a6a }));
        leg.position.set(x + sx, 1.6, z);
        this.scene.add(leg);
      }
      const pump = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.5, 0.9), new THREE.MeshLambertMaterial({ color: 0xdddddd }));
      pump.position.set(x, 0.75, z + 1.8);
      this.scene.add(pump);
      // коллайдеры: ноги навеса и колонка
      this.propsAABB.push({ x0: x - 4.2, z0: z - 0.6, x1: x + 4.2, z1: z + 0.6 });
      this.propsAABB.push({ x0: x - 0.8, z0: z + 1.2, x1: x + 0.8, z1: z + 2.4 });
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
      spr.scale.set(4, 2, 1);
      spr.position.set(x, 5.6, z);
      this.scene.add(spr);
    }
  }

  /* --- Светофоры на перекрёстках (каждый второй: 1,3,5,7) --- */
  _trafficLights() {
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
    const housMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
    const poleGeo = new THREE.CylinderGeometry(0.14, 0.18, 4.2, 6);
    poleGeo.translate(0, 2.1, 0);
    // козырёк над лампами — лампы остаются открытыми и видны со всех сторон
    const housGeo = new THREE.BoxGeometry(0.56, 0.14, 0.7);
    housGeo.translate(0, 5.0, 0);
    const lampGeo = new THREE.SphereGeometry(0.2, 8, 6);
    const bright = [0xff4040, 0xffb030, 0x40e040];
    const dark = [0x3a1010, 0x3a2a10, 0x103a10];
    for (let i = 1; i < 8; i += 2) for (let j = 1; j < 8; j += 2) {
      const x = -256 + i * CFG.CELL, z = -256 + j * CFG.CELL;
      // 4 светофора по углам перекрёстка (на тротуаре, не на проезжей части):
      // СВ — для полосы V в +Z, ЮВ — для H в +X, ЮЗ — для V в −Z, СЗ — для H в −X
      const corners = [
        { x: x + 9, z: z + 9, axis: 'z' },
        { x: x + 9, z: z - 9, axis: 'x' },
        { x: x - 9, z: z - 9, axis: 'z' },
        { x: x - 9, z: z + 9, axis: 'x' },
      ];
      for (const sp of corners) {
        const g = new THREE.Group();
        g.position.set(sp.x, 0, sp.z);
        const pole = new THREE.Mesh(poleGeo, poleMat);
        g.add(pole);
        const housing = new THREE.Mesh(housGeo, housMat);
        g.add(housing);
        const lamps = [];
        for (let k = 0; k < 3; k++) {
          const lamp = new THREE.Mesh(lampGeo, new THREE.MeshBasicMaterial({ color: dark[k] }));
          lamp.position.set(0, 4.7 - k * 0.5, 0);
          lamp.userData.i = k;
          g.add(lamp);
          lamps.push(lamp);
        }
        // лампы «смотрят» вдоль своей дороги (к подъезжающим полосам)
        g.rotation.y = sp.axis === 'z' ? 0 : Math.PI / 2;
        this.scene.add(g);
        // off — «зелёная волна» вдоль X: перекрёстки восточнее сдвинуты по фазе
        this.lights.push({ group: g, axis: sp.axis, x: sp.x, z: sp.z, isec: { x, z }, state: 0, off: -(x / CFG.CELL) * 1.6, lamps });
      }
    }
  }

  /* --- Канатная дорога на Машук --- */
  _cableCar() {
    const base = new THREE.Vector3(20, 1.5, -288);
    const top = new THREE.Vector3(0, 62, -448);
    const dir = new THREE.Vector3().subVectors(top, base);
    const len = dir.length();
    const cableMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });
    for (const off of [-1.4, 1.4]) {
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, len, 5), cableMat);
      const mid = new THREE.Vector3().lerpVectors(base, top, 0.5);
      mid.x += off;
      cable.position.copy(mid);
      cable.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      this.scene.add(cable);
    }
    // опоры
    for (const t of [0.3, 0.55, 0.8]) {
      const p = new THREE.Vector3().lerpVectors(base, top, t);
      const h = p.y - this.heightAt(p.x, p.z) + 4;
      const tower = new THREE.Mesh(new THREE.BoxGeometry(1, h, 1), new THREE.MeshLambertMaterial({ color: 0x8a6a44 }));
      tower.position.set(p.x, this.heightAt(p.x, p.z) + h / 2, p.z);
      this.scene.add(tower);
    }
    // кабинки
    for (const t of [0.35, 0.62]) {
      const p = new THREE.Vector3().lerpVectors(base, top, t);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.3, 1.5), new THREE.MeshLambertMaterial({ color: 0xe86030 }));
      cab.position.set(p.x, p.y - 2, p.z);
      this.scene.add(cab);
    }
    // нижняя станция
    const st = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 7), new THREE.MeshLambertMaterial({ color: 0xc8b898 }));
    st.position.set(20, 2.6, -288);
    this.scene.add(st);
    this.propsAABB.push({ x0: 14, z0: -292, x1: 26, z1: -284 });
  }

  /* --- Дорожные знаки на перекрёстках --- */
  _signs() {
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.07, 2.1, 5);
    poleGeo.translate(0, 1.05, 0);
    const discGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.07, 12);
    discGeo.translate(0, 2.1, 0);
    const signGeo = mergeColored([{ g: poleGeo, c: '#ffffff' }, { g: discGeo, c: '#ffffff' }]);
    const colors = [0xd84040, 0x2a6ad8, 0xd8a030, 0x2a8a50];
    const items = [];
    const used = new Set();
    for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) {
      if (this.rng() < 0.5) continue; // не на каждом перекрёстке
      const x = -256 + i * CFG.CELL, z = -256 + j * CFG.CELL;
      for (const [ox, oz, rot] of [[7.8, 7.8, 0], [-7.8, -7.8, Math.PI]]) {
        const sx = x + ox, sz = z + oz;
        if (Math.abs(sx) > 300 || Math.abs(sz) > 300) continue;
        if (!this.isPositionValid(sx, sz, 0.4)) continue;
        const key = Math.round(sx) + ',' + Math.round(sz);
        if (used.has(key)) continue;
        used.add(key);
        items.push({ x: sx, z: sz, rot, c: choice(colors) });
        this.propsAABB.push({ x0: sx - 0.4, z0: sz - 0.4, x1: sx + 0.4, z1: sz + 0.4 });
      }
    }
    const mesh = new THREE.InstancedMesh(signGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), items.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1);
    items.forEach((it, i) => {
      e.set(0, it.rot, 0); q.setFromEuler(e);
      m4.compose(new THREE.Vector3(it.x, 0.1, it.z), q, s);
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, new THREE.Color(it.c));
    });
    this.scene.add(mesh);
  }

  /* --- Светофоры на перекрёстках (каждый второй: 1,3,5,7) --- */
  _trafficLights() {
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
    const housMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
    const poleGeo = new THREE.CylinderGeometry(0.14, 0.18, 4.2, 6);
    poleGeo.translate(0, 2.1, 0);
    // козырёк над лампами — лампы остаются открытыми и видны со всех сторон
    const housGeo = new THREE.BoxGeometry(0.56, 0.14, 0.7);
    housGeo.translate(0, 5.0, 0);
    const lampGeo = new THREE.SphereGeometry(0.2, 8, 6);

    const corners = [];
    for (let i = 1; i < 8; i += 2) for (let j = 1; j < 8; j += 2) {
      const x = -256 + i * CFG.CELL, z = -256 + j * CFG.CELL;
      const rawCorners = [
        { x: x + 8.2, z: z + 8.2, axis: 'z', isecX: x, isecZ: z },
        { x: x + 8.2, z: z - 8.2, axis: 'x', isecX: x, isecZ: z },
        { x: x - 8.2, z: z - 8.2, axis: 'z', isecX: x, isecZ: z },
        { x: x - 8.2, z: z + 8.2, axis: 'x', isecX: x, isecZ: z }
      ];
      for (const sp of rawCorners) {
        if (!this.isPositionValid(sp.x, sp.z, 0.4)) continue;
        corners.push(sp);
        this.propsAABB.push({ x0: sp.x - 0.4, z0: sp.z - 0.4, x1: sp.x + 0.4, z1: sp.z + 0.4 });
      }
    }

    const polesMesh = new THREE.InstancedMesh(poleGeo, poleMat, corners.length);
    const housMesh = new THREE.InstancedMesh(housGeo, housMat, corners.length);
    const lampsMesh = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), corners.length * 3);

    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1);
    const dark = [0x3a1010, 0x3a2a10, 0x103a10];

    corners.forEach((sp, idx) => {
      const rotY = sp.axis === 'z' ? 0 : Math.PI / 2;
      e.set(0, rotY, 0); q.setFromEuler(e);
      m4.compose(new THREE.Vector3(sp.x, 0, sp.z), q, s);
      polesMesh.setMatrixAt(idx, m4);
      housMesh.setMatrixAt(idx, m4);

      for (let k = 0; k < 3; k++) {
        const lampIdx = idx * 3 + k;
        m4.makeTranslation(sp.x, 4.7 - k * 0.5, sp.z);
        lampsMesh.setMatrixAt(lampIdx, m4);
        lampsMesh.setColorAt(lampIdx, new THREE.Color(dark[k]));
      }

      this.lights.push({
        idx,
        axis: sp.axis,
        x: sp.x,
        z: sp.z,
        isec: { x: sp.isecX, z: sp.isecZ },
        state: 0,
        off: -(sp.isecX / CFG.CELL) * 1.6,
      });
    });

    this.scene.add(polesMesh);
    this.scene.add(housMesh);
    this.scene.add(lampsMesh);
    this.trafficLampMesh = lampsMesh;
  }

  /* --- Точки посадки пассажиров --- */
  _collectPickupPoints() {
    for (const r of this.roadsV) {
      for (let z = -208; z <= 208; z += 48) {
        for (const side of [-1, 1]) {
          const x = r.c + side * (CFG.HALF + CFG.SIDE / 2);
          // точка не должна попадать на поперечную дорогу (перекрёсток)
          if (this.distToRoad(x, z) < CFG.HALF) continue;
          const bi = clamp(Math.floor((x + 256) / CFG.CELL), 0, 7);
          const bj = clamp(Math.floor((z + 256) / CFG.CELL), 0, 7);
          const d = this.blockDistrict(bi, bj);
          this.pickupPoints.push({ x, z, district: d });
        }
      }
    }
    for (const r of this.roadsH) {
      for (let x = -208; x <= 208; x += 48) {
        for (const side of [-1, 1]) {
          const z = r.c + side * (CFG.HALF + CFG.SIDE / 2);
          if (this.distToRoad(x, z) < CFG.HALF) continue;
          const bi = clamp(Math.floor((x + 256) / CFG.CELL), 0, 7);
          const bj = clamp(Math.floor((z + 256) / CFG.CELL), 0, 7);
          const d = this.blockDistrict(bi, bj);
          this.pickupPoints.push({ x, z, district: d });
        }
      }
    }
  }

  /* --- Обновление мира: светофоры, фонари, фонтан --- */
  update(dt, hour, weather) {
    this.time += dt;
    const night = hour >= CFG.nightStartHour || hour < CFG.nightEndHour;
    if (this.lampHeadMesh) this.lampHeadMesh.visible = night;
    // плавная подсветка окон зданий ночью
    const winTarget = night ? 0.85 : 0.04;
    this._winI = this._winI === undefined ? 0.04 : this._winI;
    // порог применяется к расстоянию до цели, а не к величине шага lerp —
    // иначе _winI застревает на ~68% пути к цели (шаг сам по себе затухает раньше)
    const atWinTarget = Math.abs(this._winI - winTarget) < 0.005;
    if (!atWinTarget) {
      this._winI += (winTarget - this._winI) * 0.03;
      for (const m of this.windowMats) m.emissiveIntensity = this._winI;
    }

    // динамический эффект мокрого асфальта
    const wetTarget = weather === 'rain' ? 1.0 : 0.0;
    const atWetTarget = Math.abs((this.wetness || 0) - wetTarget) < 0.002;
    if (!atWetTarget) {
      this.wetness = lerp(this.wetness || 0, wetTarget, dt * 0.7);
      if (this.roadMats && this.roadMats.length) {
        const roughness = lerp(0.82, 0.22, this.wetness);
        const metalness = lerp(0.05, 0.42, this.wetness);
        for (const m of this.roadMats) {
          m.roughness = roughness;
          m.metalness = metalness;
        }
      }
    }

    let lampsUpdated = false;
    const bright = [0xff4040, 0xffb030, 0x40e040];
    const dark = [0x3a1010, 0x3a2a10, 0x103a10];
    const tempColor = new THREE.Color();

    for (const l of this.lights) {
      // цикл 16 с: 0-6 зелёный, 6-8 жёлтый, 8-14 красный, 14-16 жёлтый (для оси 'z');
      // для оси 'x' фаза сдвинута на полцикла. off — «зелёная волна» по X.
      const t = (((this.time + l.off) % 16) + 16) % 16;
      const oldState = l.state;
      if (l.axis === 'z') l.state = t < 6 ? 0 : t < 8 ? 1 : (t < 14 ? 2 : 1);
      else l.state = t < 8 ? 2 : (t < 14 ? 0 : 1);

      if (oldState !== l.state || !this._lampInit) {
        lampsUpdated = true;
        for (let k = 0; k < 3; k++) {
          const lampIdx = l.idx * 3 + k;
          const isOn = (k === 0 && l.state === 2) || (k === 1 && l.state === 1) || (k === 2 && l.state === 0);
          const colHex = isOn ? bright[k] : dark[k];
          this.trafficLampMesh.setColorAt(lampIdx, tempColor.setHex(colHex));
        }
      }
    }
    if (lampsUpdated && this.trafficLampMesh) {
      this.trafficLampMesh.instanceColor.needsUpdate = true;
      this._lampInit = true;
    }
  }
}

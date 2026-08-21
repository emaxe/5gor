import * as THREE from 'three';
import { CFG, DISTRICTS, PALETTES, LANDMARKS, FUEL_STATIONS } from './config.js';
import { mulberry32, dist2D, rand, clamp, choice, makeCanvas, canvasToTexture, lerp, mergeColored, mergeGeoms, makePlateTexture, makeTaxiTexture, getWindowMaterial, getRoofMaterial, smin, smax } from './utils.js';
import { taperedBox } from './carmodel.js';

// Цвета ламп светофора (красный/жёлтый/зелёный, вкл/выкл) — общие константы вместо
// пересоздания массивов на каждый кадр в update() (OPT-18)
const TRAFFIC_LIGHT_BRIGHT = [0xff4040, 0xffb030, 0x40e040];
const TRAFFIC_LIGHT_DARK = [0x3a1010, 0x3a2a10, 0x103a10];

/* Палитра поезда у вокзала — общая для _station() и _stationVehicle() (один
   vertexColors-материал на весь состав, цвета живут в атрибуте вершин) */
const TRAIN_PAL = {
  loco: 0x2e7a46,   // кузов тепловоза
  car: 0x1b5230,    // кузов пассажирского вагона
  band: 0xe6d9a8,   // светлая полоса ливреи
  under: 0x26282c,  // рама, тележки, подножки
  dark: 0x17181b,   // автосцепки, жалюзи, двери
  wheel: 0x141416,
  hub: 0x8a8a92,
  roof: 0x40464e,
  glass: 0x223040,
};

/* Палитра рынка «Лира» — вся мелочь рынка живёт в одном vertexColors-буфере */
const MK = {
  stall: 0x8a6a44, post: 0x6a6a60, rail: 0x7a6a52, stone: 0xb0a898,
  crate: 0xb87a3a, crate2: 0xa06a30, sack: 0xd8c8a0, metal: 0x5a5a54,
  valance: 0xf0f0e8,
};
const MK_GOODS = [0xd23b2e, 0xe8a021, 0x9ac13a, 0x7a3f9a, 0xe06a2a, 0xd8d040];

/* Палитра Цветника */
const PK = { stone: 0xb8b8b0, stoneD: 0xa4a49c, kerb: 0xcac4b6, wood: 0x8a6a44 };
const PK_FLOWERS = [0xd94f4f, 0xe8b84a, 0xb06ad9, 0x5aa85a, 0xe87a3a, 0x4a7fd9, 0xe86aa0, 0xf0e8d0];

/* Скамья и вазон — общие цвета (материал один на всё: World._vcMat()) */
const BENCH_WOOD = 0x8a6a44, BENCH_LEG = 0x5a5a54;
const PLANTER_STONE = 0xbdb4a2, PLANTER_RIM = 0xd2cabb, PLANTER_LEAF = 0x4f8a3f;

/* Ручной тайлинг текстуры через UV конкретной геометрии, а НЕ через texture.repeat:
   кешированные текстуры (_texCache) общие на всех потребителей ключа — поменять
   repeat у общего инстанса значит сломать текстуру везде, где он уже используется
   (так уже задан repeat 8×200 у тротуарной текстуры в _roads()). */
function uvTile(g, su, sv) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

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
    /** @type {Map<string, Array<object>>} spatial hash propsAABB по ячейкам 10×10м */
    this._propHash = new Map();
    this._propHashCell = 10;
    /** @type {Map<string, Array<object>>} spatial hash buildings по ячейкам 16×16м */
    this._buildingHash = new Map();
    this._buildingHashCell = 16;
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
    this._serp = null;         // ось серпантина (точки, длина, spatial hash)
    this.hill = { x: 0, z: -448, r: 155, hc: 66, top: 58 };   // Машук: центр под башней, плато на вершине
    this.peak2 = { x: 55, z: -500, r: 70, hc: 46, top: 40 };  // вторая вершина
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
    if (bi === 3 && bj === 3) return 'narzan'; // купол Нарзанных ванн 28 м — застройку в квартал не пускаем
    return null;
  }

  blockRect(bi, bj) {
    const x0 = -246 + bi * CFG.CELL, z0 = -246 + bj * CFG.CELL;
    return { x0, z0, x1: x0 + 44, z1: z0 + 44 };
  }

  /* --- Базовый рельеф без дороги: Машук + вторая вершина, гладко сопряжённые --- */
  _baseHeight(x, z) {
    const H = this.hill, P = this.peak2;
    let h = smin(H.hc * (1 - Math.hypot(x - H.x, z - H.z) / H.r), H.top, 6);
    h = smax(h, smin(P.hc * (1 - Math.hypot(x - P.x, z - P.z) / P.r), P.top, 4), 8);
    h = smax(h, 0, 3);                                          // мягкая подошва
    return h * clamp((-z - 288) / 12, 0, 1);                    // фейд у торца проспекта (z = -292)
  }

  /* --- Высота земли в точке (Машук + серпантин) --- */
  heightAt(x, z) {
    // Машук (0,-448) R=155 + подошва ~7 м + вторая вершина (55,-500) R=70
    // + подходной участок серпантина от проспекта x=128, z=-292
    if (z > -260 || z < -640 || x < -190 || x > 190) return 0;
    const hb = this._baseHeight(x, z);
    const q = this._serpNear(x, z);
    if (!q) return hb;
    const W = 3.6, B = 8;                                       // полуширина полотна, ширина откоса
    if (q.d <= W) return q.y;                                   // полка (bench)
    if (q.d >= W + B) return hb;
    const t = (q.d - W) / B;
    return q.y + (hb - q.y) * t * t * (3 - 2 * t);              // smoothstep-откос
  }

  /* Расстояние до ближайшей дороги (для проверки «вне дороги») */
  distToRoad(x, z) {
    let best = 1e9;
    const dzOuter = Math.max(0, Math.abs(z) - (256 + CFG.GRID_EXT)); // инвариант цикла — не зависит от r
    for (const r of this.roadsV) {
      best = Math.min(best, Math.hypot(x - r.c, dzOuter));
    }
    const dxOuter = Math.max(0, Math.abs(x) - (256 + CFG.GRID_EXT)); // инвариант цикла — не зависит от r
    for (const r of this.roadsH) {
      best = Math.min(best, Math.hypot(z - r.c, dxOuter));
    }
    return best;
  }

  /* Находится ли точка на проезжей части (город или серпантин Машука) */
  onRoad(x, z) {
    if (this.distToRoad(x, z) < CFG.HALF + CFG.SIDE + 3) return true;
    return this.distToSerp(x, z) < 4.4;
  }

  /* Ближайшая ось дороги (горизонтальной/вертикальной) и расстояние до неё.
     Используется для асфальтового заезда АЗС. */
  _nearestRoadAxis(x, z) {
    let best = null, bestD = Infinity;
    const dzOuter = Math.max(0, Math.abs(z) - (256 + CFG.GRID_EXT));
    for (const r of this.roadsV) {
      const d = Math.hypot(x - r.c, dzOuter);
      if (d < bestD) { bestD = d; best = { horiz: false, c: r.c }; }
    }
    const dxOuter = Math.max(0, Math.abs(x) - (256 + CFG.GRID_EXT));
    for (const r of this.roadsH) {
      const d = Math.hypot(z - r.c, dxOuter);
      if (d < bestD) { bestD = d; best = { horiz: true, c: r.c }; }
    }
    return best;
  }

  /* Добавляет AABB пропса в общий список и в spatial hash по ячейкам 10×10м */
  addPropAABB(aabb, overheadY = Infinity) {
    aabb.y = overheadY;
    this.propsAABB.push(aabb);
    const cx0 = Math.floor(aabb.x0 / this._propHashCell);
    const cx1 = Math.floor(aabb.x1 / this._propHashCell);
    const cz0 = Math.floor(aabb.z0 / this._propHashCell);
    const cz1 = Math.floor(aabb.z1 / this._propHashCell);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const key = cx + ',' + cz;
        if (!this._propHash.has(key)) this._propHash.set(key, []);
        this._propHash.get(key).push(aabb);
      }
    }
  }

  /* Проверяет коллизию (x, z, radius) с пропсами из 9 соседних ячеек spatial hash */
  _checkPropCollision(x, z, radius, playerY = 0, playerH = 1.5) {
    const cx = Math.floor(x / this._propHashCell);
    const cz = Math.floor(z / this._propHashCell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = this._propHash.get((cx + dx) + ',' + (cz + dz));
        if (!bucket) continue;
        for (const p of bucket) {
          if (x > p.x0 - radius && x < p.x1 + radius && z > p.z0 - radius && z < p.z1 + radius) {
            if (p.y !== undefined && p.y !== Infinity && playerY + playerH > p.y) continue;
            return true;
          }
        }
      }
    }
    return false;
  }

  /* Строит spatial hash для зданий по ячейкам 16×16м */
  _buildBuildingHash() {
    this._buildingHash.clear();
    for (const b of this.buildings) {
      const cx0 = Math.floor(b.x0 / this._buildingHashCell);
      const cx1 = Math.floor(b.x1 / this._buildingHashCell);
      const cz0 = Math.floor(b.z0 / this._buildingHashCell);
      const cz1 = Math.floor(b.z1 / this._buildingHashCell);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const key = cx + ',' + cz;
          if (!this._buildingHash.has(key)) this._buildingHash.set(key, []);
          this._buildingHash.get(key).push(b);
        }
      }
    }
  }

  /* Проверяет близость к точкам посадки такси (pickupPoints) */
  _isNearPickupPoint(x, z, margin = 2.0) {
    const nearZ = Math.round((z + 208) / 48) * 48 - 208;
    if (Math.abs(z - nearZ) < margin && nearZ >= -208 && nearZ <= 208) {
      for (const r of this.roadsV) {
        if (Math.abs(x - (r.c + 8.0)) < margin || Math.abs(x - (r.c - 8.0)) < margin) return true;
      }
    }
    const nearX = Math.round((x + 208) / 48) * 48 - 208;
    if (Math.abs(x - nearX) < margin && nearX >= -208 && nearX <= 208) {
      for (const r of this.roadsH) {
        if (Math.abs(z - (r.c + 8.0)) < margin || Math.abs(z - (r.c - 8.0)) < margin) return true;
      }
    }
    return false;
  }

  /* Проверяет близость к входам пешеходных переходов (зебр) */
  _isNearCrosswalk(x, z, margin = 1.8) {
    for (const isec of this.intersections) {
      const dx = Math.abs(x - isec.x);
      const dz = Math.abs(z - isec.z);
      if (Math.abs(dx - 8.0) < margin && Math.abs(dz - 6.2) < margin) return true;
      if (Math.abs(dx - 6.2) < margin && Math.abs(dz - 8.0) < margin) return true;
    }
    return false;
  }

  /**
   * Проверяет, валидна ли позиция для спавна столба, дерева или объекта:
   * 1. Запрещает попадание на проезжую часть дороги (ширина дороги 12 м = 6 м полуширина)
   * 2. Запрещает прохождение сквозь стены и контур зданий
   * 3. Запрещает попадание в водно-парковые зоны (Провал, фонтаны)
   * 4. Запрещает блокирование точек посадки пассажиров и зебр
   * 5. Запрещает наложение предметов друг на друга
   */
  isPositionValid(x, z, radius = 0.8) {
    // 1. Никаких предметов на проезжей части дороги
    if (this.distToRoad(x, z) < 6.0 + radius + 0.3) return false;

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

    // 4. Запрет блокирования точек посадки пассажиров
    if (this._isNearPickupPoint(x, z, radius + 1.2)) return false;

    // 5. Запрет блокирования пешеходных переходов
    if (this._isNearCrosswalk(x, z, radius + 0.8)) return false;

    // 6. Запрет наложения предметов друг на друга
    if (this._checkPropCollision(x, z, radius)) return false;

    return true;
  }

  /* ================= СТРОИТЕЛЬСТВО ================= */
  build() {
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
    this._streetBenches();
    this._planters();
    this._busStops();
    this._wasteBins();
    this._kiosks();
    this._playgrounds();
    this._parkedCars();
    this._collectPickupPoints();
    this._buildBuildingHash();
  }

  _ground() {
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(1700, 1700),
      new THREE.MeshLambertMaterial({ color: 0x7fae6a })
    );
    g.rotation.x = -Math.PI / 2;
    g.position.y = -0.05;   // чуть ниже сетки горы (_hillMesh) — без щелей и z-fighting на стыке
    g.receiveShadow = true;
    this.scene.add(g);
  }

  _roads() {
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.82, metalness: 0.05 });
    this.roadMats.push(roadMat);

    const sideTex = this._pavementTexture();
    const sideTexH = this._pavementTexture('pavement_h');
    sideTexH.repeat.set(200, 8);
    sideTex.repeat.set(8, 200);
    const sideMat = new THREE.MeshLambertMaterial({ map: sideTex });
    const sideMatH = new THREE.MeshLambertMaterial({ map: sideTexH });
    const curbMat = new THREE.MeshLambertMaterial({ color: 0xbcbcb4 });

    // Длина дорог строго в пределах застройки города (±256 м)
    const len = 512;
    const C = CFG.CELL, H = CFG.HALF;

    // Сетка перекрёстков
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        this.intersections.push({ x: -256 + i * C, z: -256 + j * C });
      }
    }

    // Дорожное полотно (асфальтовые полосы)
    for (let i = 0; i <= 8; i++) {
      const c = -256 + i * C;
      // Вертикальная дорога
      const rv = new THREE.Mesh(new THREE.BoxGeometry(CFG.ROAD_W, 0.1, len), roadMat);
      rv.position.set(c, 0.05, 0);
      rv.receiveShadow = true;
      this.scene.add(rv);
      this.roadsV.push({ c, from: -256, to: 256 });

      // Горизонтальная дорога
      const rh = new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, CFG.ROAD_W), roadMat);
      rh.position.set(0, 0.05, c);
      rh.receiveShadow = true;
      this.scene.add(rh);
      this.roadsH.push({ c, from: -256, to: 256 });
    }

    // Декоративные барьеры окончания городских дорог (на торцах выездов)
    this._cityBoundaries();
    // Тротуары и бордюры — разбиваем по кварталам (МЕЖДУ перекрёстками),
    // чтобы тротуары НЕ заходили на перекрёстки! Секции копятся по чанкам
    // 128×128 м × 3 материала (sideV/sideH/curb) и сливаются в конце (OPT-13) —
    // 576 отдельных мешей → до ~48 (16 чанков × 3 материала), с сохранением
    // per-chunk frustum culling вместо одного глобального мержа на весь город.
    const blockLen = C - CFG.ROAD_W; // 44 м длина тротуара на квартал
    const chunkKey = (x, z) => `${Math.floor(x / 128)}_${Math.floor(z / 128)}`;
    const chunks = new Map(); // key -> { sideV: [], sideH: [], curb: [] }
    const pushToChunk = (list, x, z, geo) => {
      const k = chunkKey(x, z);
      if (!chunks.has(k)) chunks.set(k, { sideV: [], sideH: [], curb: [] });
      chunks.get(k)[list].push(geo);
    };
    for (let i = 0; i <= 8; i++) {
      const c = -256 + i * C;
      for (let j = 0; j < 8; j++) {
        const segCenter = -256 + j * C + C / 2;

        for (const s of [-1, 1]) {
          // Вертикальные секции тротуара
          const swVx = c + s * (H + CFG.SIDE / 2);
          pushToChunk('sideV', swVx, segCenter,
            new THREE.BoxGeometry(CFG.SIDE, 0.1, blockLen).translate(swVx, 0.1, segCenter));

          // Боковой бордюр вдоль V-дороги
          const cbVx = c + s * (H + 0.25);
          pushToChunk('curb', cbVx, segCenter,
            new THREE.BoxGeometry(0.5, 0.16, blockLen).translate(cbVx, 0.14, segCenter));

          // Горизонтальные секции тротуара
          const swHz = c + s * (H + CFG.SIDE / 2);
          pushToChunk('sideH', segCenter, swHz,
            new THREE.BoxGeometry(blockLen, 0.1, CFG.SIDE).translate(segCenter, 0.1, swHz));

          // Боковой бордюр вдоль H-дороги
          const cbHz = c + s * (H + 0.25);
          pushToChunk('curb', segCenter, cbHz,
            new THREE.BoxGeometry(blockLen, 0.16, 0.5).translate(segCenter, 0.14, cbHz));
        }
      }
    }
    for (const { sideV, sideH, curb } of chunks.values()) {
      if (sideV.length) { const m = new THREE.Mesh(mergeGeoms(sideV), sideMat); m.receiveShadow = true; this.scene.add(m); }
      if (sideH.length) { const m = new THREE.Mesh(mergeGeoms(sideH), sideMatH); m.receiveShadow = true; this.scene.add(m); }
      if (curb.length) { const m = new THREE.Mesh(mergeGeoms(curb), curbMat); m.receiveShadow = true; this.scene.add(m); }
    }

    // Центральная пунктирная разметка полос
    const dashGeo = new THREE.BoxGeometry(0.25, 0.03, 3.2);  // дороги вдоль Z
    const dashGeoH = new THREE.BoxGeometry(3.2, 0.03, 0.25); // дороги вдоль X
    const dashMat = new THREE.MeshLambertMaterial({ color: 0xe8e8dc, polygonOffset: true, polygonOffsetFactor: -3 });

    const isecCoords = this.intersections.map(i => i.x);

    const dashesV = [];
    for (const r of this.roadsV) {
      for (let z = -288; z <= 288; z += 6.4) {
        // Пропускаем спавн штриха, если он попадает внутрь зоны перекрёстка (±8.5 м от центра перекрёстка)
        const insideIsec = isecCoords.some(cz => Math.abs(z - cz) < H + 1.5);
        if (insideIsec) continue;

        const m = new THREE.Matrix4();
        m.makeTranslation(r.c, 0.12, z);
        dashesV.push(m);
      }
    }

    const dashesH = [];
    for (const r of this.roadsH) {
      for (let x = -288; x <= 288; x += 6.4) {
        const insideIsec = isecCoords.some(cx => Math.abs(x - cx) < H + 1.5);
        if (insideIsec) continue;

        const m = new THREE.Matrix4();
        m.makeTranslation(x, 0.12, r.c);
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

  /* --- Красивые барьеры и знаки окончания городской зоны на выездах --- */
  _cityBoundaries() {
    const barrierMat = new THREE.MeshLambertMaterial({ color: 0xd84030 }); // Красно-белый барьер
    const stripeMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const postMat = new THREE.MeshLambertMaterial({ color: 0x333333 });

    const barrierGeo = new THREE.BoxGeometry(CFG.ROAD_W + 1.0, 1.1, 0.4);
    const stripeGeo = new THREE.BoxGeometry(0.8, 0.9, 0.42);

    const placeEndBarrier = (x, z, isHorizontal) => {
      const g = new THREE.Group();
      const base = new THREE.Mesh(barrierGeo, barrierMat);
      base.position.y = 0.55;
      g.add(base);

      // Красно-белые диагональные полосы на барьере
      for (let s = -4; s <= 4; s += 2) {
        const str = new THREE.Mesh(stripeGeo, stripeMat);
        str.position.set(s * 1.2, 0.55, 0);
        g.add(str);
      }

      // Дорожный знак "Тупик / Конец зоны" над барьером
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.2, 6), postMat);
      post.position.set(0, 1.1, 0);
      g.add(post);

      const sign = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 0.08), new THREE.MeshLambertMaterial({ color: 0x2266cc }));
      sign.position.set(0, 2.0, 0);
      g.add(sign);

      const innerSquare = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.1), new THREE.MeshLambertMaterial({ color: 0xffffff }));
      innerSquare.position.set(0, 2.0, 0);
      g.add(innerSquare);

      const redSquare = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.11), new THREE.MeshLambertMaterial({ color: 0xee2222 }));
      redSquare.position.set(0, 2.25, 0);
      g.add(redSquare);

      g.position.set(x, 0, z);
      if (isHorizontal) g.rotation.y = Math.PI / 2;

      this.scene.add(g);
      this.addPropAABB({
        x0: x - (isHorizontal ? 1.0 : (CFG.ROAD_W / 2 + 1)),
        z0: z - (isHorizontal ? (CFG.ROAD_W / 2 + 1) : 1.0),
        x1: x + (isHorizontal ? 1.0 : (CFG.ROAD_W / 2 + 1)),
        z1: z + (isHorizontal ? (CFG.ROAD_W / 2 + 1) : 1.0),
      });
    };

    // Выезды на север (кроме центрального серпантина на Машук), юг, запад и восток
    // Барьеры за последним перекрёстком (±262), не на зебре (±256)
    const BARRIER_OFFSET = 262;
    for (const r of this.roadsV) {
      // За исключением центральной дороги на Машук по оси z = -256 (r.c === 0 на севере)
      if (r.c !== 0) {
        placeEndBarrier(r.c, -BARRIER_OFFSET, false); // Северные тупики
      }
      placeEndBarrier(r.c, BARRIER_OFFSET, false);   // Южные тупики
    }

    for (const r of this.roadsH) {
      placeEndBarrier(-BARRIER_OFFSET, r.c, true);   // Западные тупики
      placeEndBarrier(BARRIER_OFFSET, r.c, true);    // Восточные тупики
    }
  }

  _crosswalks() {
    const stripeGeoV = new THREE.BoxGeometry(0.6, 0.03, 3.4);  // полосы разметки через горизонтальную дорогу (вдоль X)
    const stripeGeoH = new THREE.BoxGeometry(3.4, 0.03, 0.6);  // полосы разметки через вертикальную дорогу (вдоль Z)
    const stripeMat = new THREE.MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2 });

    const listV = [];
    const listH = [];

    for (const isec of this.intersections) {
      const sx = isec.x, sz = isec.z;
      // 4 зебры вокруг каждого перекрёстка
      for (let k = -2; k <= 2; k++) {
        const off = k * 1.1;
        // Верхний и нижний подходы к перекрёстку (полосы вдоль X)
        const mNorth = new THREE.Matrix4().makeTranslation(sx + off, 0.11, sz - 6.2);
        const mSouth = new THREE.Matrix4().makeTranslation(sx + off, 0.11, sz + 6.2);
        listV.push(mNorth, mSouth);

        // Левый и правый подходы к перекрёстку (полосы вдоль Z)
        const mWest = new THREE.Matrix4().makeTranslation(sx - 6.2, 0.11, sz + off);
        const mEast = new THREE.Matrix4().makeTranslation(sx + 6.2, 0.11, sz + off);
        listH.push(mWest, mEast);
      }
    }

    const meshV = new THREE.InstancedMesh(stripeGeoV, stripeMat, listV.length);
    listV.forEach((m, i) => meshV.setMatrixAt(i, m));
    this.scene.add(meshV);

    const meshH = new THREE.InstancedMesh(stripeGeoH, stripeMat, listH.length);
    listH.forEach((m, i) => meshH.setMatrixAt(i, m));
    this.scene.add(meshH);
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
    this._serpBuild();       // ось серпантина (нужна heightAt() и _hillMesh() ниже)
    this._hillMesh();        // сетка рельефа Машука, совпадающая с heightAt() пиксель-в-пиксель
    this._serpRoadMesh();    // полотно дороги лентой по оси
    this._serpFurniture();   // отбойники, перила, подпорные стенки

    // смотровая башня на вершине (высота берётся из heightAt — совпадает с плато)
    const hy = this.heightAt(this.hill.x, this.hill.z);
    const tb = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.6, 18, 8), new THREE.MeshLambertMaterial({ color: 0xd8d0c0 }));
    tb.position.set(this.hill.x, hy + 9, this.hill.z);
    this.scene.add(tb);
    const troof = new THREE.Mesh(new THREE.ConeGeometry(4.6, 4, 8), new THREE.MeshLambertMaterial({ color: 0x8a4a2a }));
    troof.position.set(this.hill.x, hy + 18 + 2, this.hill.z);
    this.scene.add(troof);
    this.addPropAABB({ x0: this.hill.x - 4, z0: this.hill.z - 4, x1: this.hill.x + 4, z1: this.hill.z + 4 });

    // беседка «Эолова арфа» на обочине (8 м по внешней нормали от полотна серпантина)
    this._gazebo(15, -343, this.heightAt(15, -343));

    // каменный грот Лермонтова (в парке)
    this._grotto(-52, 8);
  }

  /* Марш-траектория «линия+дуга»: гарантирует точный радиус поворота на виражах
     (в отличие от сплайна через опорные точки, где кривизна между узлами непредсказуема).
     legs: {type:'line', len} | {type:'arc', radius, angle (рад, + = влево)} */
  _serpMarch(x0, z0, h0, legs, step = 2) {
    const pts = [{ x: x0, z: z0, s: 0 }];
    let x = x0, z = z0, h = h0, s = 0;
    for (const leg of legs) {
      if (leg.type === 'line') {
        const n = Math.max(1, Math.round(leg.len / step));
        const dx = Math.cos(h), dz = Math.sin(h);
        for (let i = 1; i <= n; i++) { const t = leg.len * i / n; pts.push({ x: x + dx * t, z: z + dz * t, s: s + t }); }
        x += dx * leg.len; z += dz * leg.len; s += leg.len;
      } else {
        const R = leg.radius, dh = leg.angle, sgn = Math.sign(dh);
        const cx = x - sgn * R * Math.sin(h), cz = z + sgn * R * Math.cos(h);
        const theta0 = Math.atan2(z - cz, x - cx);
        const arcLen = Math.abs(dh) * R, n = Math.max(1, Math.round(arcLen / step));
        for (let i = 1; i <= n; i++) {
          const frac = i / n, theta = theta0 + sgn * Math.abs(dh) * frac;
          pts.push({ x: cx + R * Math.cos(theta), z: cz + R * Math.sin(theta), s: s + arcLen * frac });
        }
        x = cx + R * Math.cos(theta0 + dh); z = cz + R * Math.sin(theta0 + dh); h += dh; s += arcLen;
      }
    }
    return pts;
  }

  /* --- Ось серпантина: от торца проспекта (128,-292) три шпильки Р=13м на склон Машука --- */
  _serpBuild() {
    const D2R = Math.PI / 180;
    const pts = this._serpMarch(128, -292, -170 * D2R, [
      { type: 'line', len: 140 },                     // траверс 1
      { type: 'arc', radius: 13, angle: 150 * D2R },  // ШПИЛЬКА 1
      { type: 'line', len: 80 },                      // траверс 2
      { type: 'arc', radius: 13, angle: -150 * D2R }, // ШПИЛЬКА 2
      { type: 'line', len: 100 },                     // траверс 3
      { type: 'arc', radius: 13, angle: 150 * D2R },  // ШПИЛЬКА 3
      { type: 'line', len: 41 },                      // выезд на площадку вершины
    ], 2);
    const S = pts[pts.length - 1].s;
    for (const p of pts) p.y = this._serpProfile(p.s, S);
    this._serp = { pts, len: S };
    this._serpHash();
  }

  /* Продольный профиль: короткий горизонтальный подход, постоянный уклон, скругления переломов */
  _serpProfile(s, S) {
    const S0 = 20, VC = 24, TOP = this.hill.top;
    const g = TOP / (S - S0 - VC / 2);
    if (s <= S0 - VC / 2) return 0;
    if (s < S0 + VC / 2) { const t = (s - S0 + VC / 2) / VC; return g * VC * t * t / 2; }
    if (s > S - VC) { const t = (S - s) / VC; return TOP - g * VC * t * t / 2; }
    return Math.min(g * (s - S0), TOP);
  }

  /* Spatial hash оси серпантина по ячейкам 8×8 м — для _serpNear() каждый кадр */
  _serpHash() {
    const CELL = 8, INFL = 14;                          // INFL > полуширина полки(3.6) + откос(8)
    const map = new Map(), P = this._serp.pts;
    for (let i = 0; i < P.length - 1; i++) {
      const x0 = Math.min(P[i].x, P[i + 1].x) - INFL, x1 = Math.max(P[i].x, P[i + 1].x) + INFL;
      const z0 = Math.min(P[i].z, P[i + 1].z) - INFL, z1 = Math.max(P[i].z, P[i + 1].z) + INFL;
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
        for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
          const k = cx + ',' + cz; let b = map.get(k); if (!b) map.set(k, b = []); b.push(i);
        }
    }
    this._serp.hash = map; this._serp.cell = CELL;
  }

  /* Ближайшая точка оси серпантина (и площадки вершины): {d, y} либо null вне зоны влияния */
  _serpNear(x, z) {
    const S = this._serp;
    if (!S) return null;
    const b = S.hash.get(Math.floor(x / S.cell) + ',' + Math.floor(z / S.cell));
    let bd = Infinity, by = 0;
    if (b) for (let n = 0; n < b.length; n++) {
      const a = S.pts[b[n]], c = S.pts[b[n] + 1];
      const dx = c.x - a.x, dz = c.z - a.z;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
      if (d < bd) { bd = d; by = a.y + (c.y - a.y) * t; }
    }
    const dt = Math.max(0, Math.hypot(x - this.hill.x, z - this.hill.z) - 20);  // плоская площадка вершины r=20
    if (dt < bd) { bd = dt; by = this.hill.top; }
    return bd < 14 ? { d: bd, y: by } : null;
  }

  /* Расстояние до оси серпантина (Infinity вне зоны влияния) — для деревьев и onRoad() */
  distToSerp(x, z) { const q = this._serpNear(x, z); return q ? q.d : Infinity; }

  /* --- Меш горы Машук: сетка по heightAt(), совпадает с физикой пиксель-в-пиксель --- */
  _hillMesh() {
    const X0 = -190, X1 = 190, Z0 = -640, Z1 = -260, STEP = 3;
    const nx = Math.round((X1 - X0) / STEP), nz = Math.round((Z1 - Z0) / STEP);
    const rowW = nx + 1;
    const gridY = new Float32Array(rowW * (nz + 1));
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = X0 + i * STEP, z = Z0 + j * STEP;
      let y = this.heightAt(x, z);
      const q = this._serpNear(x, z);
      if (q && q.d < 3.6 + 1.5 * STEP) y = Math.min(y, q.y - 0.15);   // не пробивать полотно дороги
      gridY[j * rowW + i] = y;
    }
    const pos = [], idx = [];
    const vIdx = new Int32Array(rowW * (nz + 1)).fill(-1);
    let vc = 0;
    const addV = (i, j) => {
      const k = j * rowW + i;
      if (vIdx[k] === -1) { vIdx[k] = vc++; pos.push(X0 + i * STEP, gridY[k], Z0 + j * STEP); }
      return vIdx[k];
    };
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      // квады, целиком лежащие в плоском грунте (y≈0), пропускаем — их накрывает _ground()
      const y00 = gridY[j * rowW + i], y10 = gridY[j * rowW + i + 1];
      const y01 = gridY[(j + 1) * rowW + i], y11 = gridY[(j + 1) * rowW + i + 1];
      if (y00 < 0.02 && y10 < 0.02 && y01 < 0.02 && y11 < 0.02) continue;
      const a = addV(i, j), b = addV(i + 1, j), c = addV(i, j + 1), d = addV(i + 1, j + 1);
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x5a885a, flatShading: true })));
  }

  /* Текстура асфальта серпантина с пунктирной осевой линией (шаг 6.4м — как у городских дорог) */
  _serpMarkingTexture() {
    const key = 'serp_road';
    if (_texCache.has(key)) return _texCache.get(key);
    const c = makeCanvas(32, 64);
    const g = c.getContext('2d');
    g.fillStyle = '#3e434a'; g.fillRect(0, 0, 32, 64);
    g.fillStyle = '#e8e8dc'; g.fillRect(14, 4, 4, 24);
    const t = canvasToTexture(c, key);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* --- Полотно серпантина: лента по оси, точно на полке heightAt(), без щелей и z-fighting --- */
  _serpRoadMesh() {
    const P = this._serp.pts, W = 3.6, DROP = 0.5;
    const roadMat = new THREE.MeshStandardMaterial({ map: this._serpMarkingTexture(), roughness: 0.82, metalness: 0.05 });
    this.roadMats.push(roadMat);
    const pos = [], uv = [], idx = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(i - 1, 0)], b = P[Math.min(i + 1, P.length - 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      const nx = -tz, nz = tx;
      const p = P[i], v = p.s / 6.4;
      pos.push(p.x - nx * W, p.y + 0.08 - DROP, p.z - nz * W);
      pos.push(p.x - nx * W, p.y + 0.08, p.z - nz * W);
      pos.push(p.x + nx * W, p.y + 0.08, p.z + nz * W);
      pos.push(p.x + nx * W, p.y + 0.08 - DROP, p.z + nz * W);
      uv.push(0, v, 0, v, 1, v, 1, v);
    }
    for (let i = 0; i < P.length - 1; i++) {
      const b0 = i * 4, b1 = (i + 1) * 4;
      for (let k = 0; k < 3; k++) {
        idx.push(b0 + k, b0 + k + 1, b1 + k);
        idx.push(b1 + k, b0 + k + 1, b1 + k + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.scene.add(new THREE.Mesh(geo, roadMat));
  }

  /* --- Обвязка серпантина: отбойники+перила с обрывистой стороны, подпорные стенки со стороны склона --- */
  _serpFurniture() {
    const P = this._serp.pts, W = 3.6, STEP = 4.5;
    const guardMat = new THREE.MeshLambertMaterial({ color: 0x6a6a6a });
    const railMat = new THREE.MeshLambertMaterial({ color: 0xd8d8d0 });
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x787870 });
    const guardGeo = new THREE.CylinderGeometry(0.14, 0.18, 1.0, 5);
    const railGeo = new THREE.BoxGeometry(0.1, 0.22, STEP + 0.2);
    const guards = [], rails = [], walls = [];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 0, 1);

    let acc = 0;
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i];
      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      acc += segLen;
      if (acc < STEP) continue;
      acc = 0;
      let tx = b.x - a.x, tz = b.z - a.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      const nx = -tz, nz = tx;
      // сторона склона: наружу от центра горы — там обрыв, туда ставим отбойник
      const rx = b.x - this.hill.x, rz = b.z - this.hill.z;
      const outward = (nx * rx + nz * rz) > 0 ? 1 : -1;
      const ex = b.x + nx * outward * (W + 0.5), ez = b.z + nz * outward * (W + 0.5);
      if (this.heightAt(ex, ez) < b.y - 0.4) {
        guards.push(new THREE.Matrix4().makeTranslation(ex, b.y + 0.5, ez));
        m4.compose(new THREE.Vector3(ex, b.y + 0.6, ez), q.setFromUnitVectors(up, new THREE.Vector3(tx, 0, tz)), new THREE.Vector3(1, 1, 1));
        rails.push(m4.clone());
      }
      // сторона склона (внутрь, к горе) — если рельеф выше полотна, там срез, ставим подпорную стенку
      const ix = b.x - nx * outward * (W + 0.2), iz = b.z - nz * outward * (W + 0.2);
      const wallH = this.heightAt(ix, iz) - b.y;
      if (wallH > 1.0) {
        const wm = new THREE.Matrix4();
        const s = new THREE.Vector3(0.4, Math.min(wallH + 0.4, 12), STEP + 0.4);
        wm.compose(new THREE.Vector3(ix, b.y + s.y / 2 - 0.2, iz), q.setFromUnitVectors(up, new THREE.Vector3(tx, 0, tz)), s);
        walls.push(wm);
      }
    }
    if (guards.length) { const gm = new THREE.InstancedMesh(guardGeo, guardMat, guards.length); guards.forEach((m, i) => gm.setMatrixAt(i, m)); this.scene.add(gm); }
    if (rails.length) { const rm = new THREE.InstancedMesh(railGeo, railMat, rails.length); rails.forEach((m, i) => rm.setMatrixAt(i, m)); this.scene.add(rm); }
    if (walls.length) { const wm2 = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), wallMat, walls.length); walls.forEach((m, i) => wm2.setMatrixAt(i, m)); this.scene.add(wm2); }
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
      // 6 колонн (solid)
      const colX = x + Math.cos(a) * 1.7;
      const colZ = z + Math.sin(a) * 1.7;
      this.addPropAABB({ x0: colX - 0.25, z0: colZ - 0.25, x1: colX + 0.25, z1: colZ + 0.25 });
    }
    g.add(colsMesh);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.6, 1.6, 8), new THREE.MeshLambertMaterial({ color: 0x7a8a5a }));
    roof.position.y = y + 2.6 + 0.8;
    g.add(roof);
    g.position.set(x, 0, z);
    this.scene.add(g);
    // Крыша беседки (overhead, y + 2.6)
    this.addPropAABB({ x0: x - 2.6, z0: z - 2.6, x1: x + 2.6, z1: z + 2.6 }, y + 2.6);
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
    this.addPropAABB({ x0: x - 3, z0: z - 2, x1: x + 3, z1: z + 2 });
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
    const cy = 0.15 + h / 2;
    // Стены — 4 PlaneGeometry слитые в одну геометрию с одним материалом (не массив
    // материалов, см. OPT-16a) — иначе three.js разворачивает грани BoxGeometry
    // в 6 отдельных draw calls.
    // Направления нормалей выверены так, чтобы front-face (winding) каждой стены
    // смотрел НАРУЖУ от здания — иначе backface culling прячет ближнюю к камере
    // стену и показывает дальнюю (баг: «вижу заднюю стенку дома, но не переднюю»).
    const wallGeo = mergeGeoms([
      new THREE.PlaneGeometry(dep, h).rotateY(-Math.PI / 2).translate(x, cy, z + dep / 2),       // x=x, наружу -X
      new THREE.PlaneGeometry(dep, h).rotateY(Math.PI / 2).translate(x + w, cy, z + dep / 2),    // x=x+w, наружу +X
      new THREE.PlaneGeometry(w, h).rotateY(Math.PI).translate(x + w / 2, cy, z),                // z=z, наружу -Z
      new THREE.PlaneGeometry(w, h).translate(x + w / 2, cy, z + dep),                            // z=z+dep, наружу +Z
    ]);
    const roofGeo = new THREE.PlaneGeometry(w, dep).rotateX(-Math.PI / 2).translate(x + w / 2, 0.15 + h, z + dep / 2);

    // Стена и крыша — отдельные меши НА ЗДАНИЕ (не сливаются между зданиями чанком,
    // см. откат OPT-16b): при слиянии по чанку соседние (в т.ч. пересекающиеся —
    // генератор кварталов не проверяет здания из разных блоков между собой)
    // здания разной высоты попадали в один меш, и крыша одного здания «улетала»
    // на высоту другого — визуально несвязный плавающий кусок. На меш-на-здание
    // этот баг невозможен: geometry каждого меша строго ограничена своим x/z/w/dep/h.
    const wallMesh = new THREE.Mesh(wallGeo, sideMat);
    // castShadow только если здание целиком внутри бокса shadow-камеры (±SHADOW_HALF
    // вокруг центра карты) — иначе GPU обрезает меш по границе бокса и тень
    // выглядит «оторванной» от здания.
    wallGeo.computeBoundingBox();
    const bb = wallGeo.boundingBox;
    const half = CFG.SHADOW_HALF;
    if (bb.min.x >= -half && bb.max.x <= half && bb.min.z >= -half && bb.max.z <= half) {
      wallMesh.castShadow = true;
    }
    this.scene.add(wallMesh);
    this.scene.add(new THREE.Mesh(roofGeo, roofMat));

    if (this.rng() < 0.22) {
      const pyr = new THREE.Mesh(new THREE.ConeGeometry(w * 0.62, h * 0.42, 4), roofMat);
      pyr.rotation.y = Math.PI / 4;
      pyr.position.set(x + w / 2, 0.15 + h + h * 0.21, z + dep / 2);
      this.scene.add(pyr);
    }
    this.buildings.push({ x0: x, z0: z, x1: x + w, z1: z + dep, h, mesh: wallMesh });
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
    const cx = -40, cz = -340;
    const baseY = this.heightAt(cx, cz);
    const g = new THREE.Group();
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x8a8a80 });
    const eagleMat = new THREE.MeshLambertMaterial({ color: 0x6a5a4a });
    const goldMat = new THREE.MeshLambertMaterial({ color: 0xd8a030 });
    const snakeMat = new THREE.MeshLambertMaterial({ color: 0x2e4a30 });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x4a3a2a });

    // Каменный постамент (имитация скалы) — 3 ступени
    const base1 = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.2, 1.0, 8), stoneMat);
    base1.position.y = 0.5; g.add(base1);
    const base2 = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.5, 1.2, 8), stoneMat);
    base2.position.y = 1.6; g.add(base2);
    const base3 = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.8, 0.8, 8), stoneMat);
    base3.position.y = 2.6; g.add(base3);

    // Змея — 2 сегмента Torus, обвивающих постамент
    const snake1 = new THREE.Mesh(new THREE.TorusGeometry(1.8, 0.2, 6, 20, Math.PI * 1.3), snakeMat);
    snake1.rotation.x = Math.PI / 2.2; snake1.rotation.z = 0.3;
    snake1.position.set(0.3, 1.8, 0); g.add(snake1);
    const snake2 = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.18, 6, 16, Math.PI * 1.1), snakeMat);
    snake2.rotation.x = Math.PI / 1.8; snake2.rotation.z = -0.5;
    snake2.position.set(-0.2, 2.3, 0.4); g.add(snake2);
    // Голова змеи
    const snakeHead = new THREE.Mesh(new THREE.SphereGeometry(0.15, 5, 5), snakeMat);
    snakeHead.position.set(1.6, 2.8, 0.6); g.add(snakeHead);

    // Орел — туловище (конус, чуть крупнее)
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.85, 1.8, 6), eagleMat);
    body.position.y = 3.6; body.rotation.x = -0.3; g.add(body);

    // Голова орла
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 8, 6), eagleMat);
    head.position.set(0, 4.6, 0.35); g.add(head);
    // Хохолок на голове
    const crest = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.35, 4), eagleMat);
    crest.position.set(0, 4.95, 0.2); crest.rotation.x = -0.4; g.add(crest);
    // Клюв — золотой конус
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.5, 5), goldMat);
    beak.position.set(0, 4.5, 0.75); beak.rotation.x = Math.PI / 2; g.add(beak);
    // Глаза
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 5, 5), darkMat);
      eye.position.set(sx * 0.22, 4.65, 0.55); g.add(eye);
    }

    // Расправленные крылья — единая связная конструкция с перекрытием сегментов
    for (const s of [-1, 1]) {
      // 1. Основание крыла (плечо): глубоко входит в туловище (x от ±0.08 до ±1.32)
      const wingBase = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.16, 0.85), eagleMat);
      wingBase.position.set(s * 0.7, 3.85, -0.05);
      wingBase.rotation.set(-0.1, s * 0.15, s * 0.28);
      g.add(wingBase);

      // 2. Средняя часть (предплечье): гладко продолжает основание с перекрытием (x от ±1.17 до ±2.43)
      const wingMid = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.13, 0.72), eagleMat);
      wingMid.position.set(s * 1.8, 4.30, -0.22);
      wingMid.rotation.set(-0.15, s * 0.25, s * 0.42);
      g.add(wingMid);

      // 3. Кончик крыла (маховые перья): плавно завершает изгиб крыла вверх (x от ±2.23 до ±3.17)
      const wingTip = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.10, 0.58), eagleMat);
      wingTip.position.set(s * 2.7, 4.90, -0.42);
      wingTip.rotation.set(-0.2, s * 0.35, s * 0.60);
      g.add(wingTip);

      // 4. Нижний веер перьев (основание): добавляет крылу ширину и объем сзади/снизу
      const wingFeathersInner = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.08, 0.65), eagleMat);
      wingFeathersInner.position.set(s * 0.95, 3.62, -0.28);
      wingFeathersInner.rotation.set(-0.28, s * 0.12, s * 0.20);
      g.add(wingFeathersInner);

      // 5. Вторичные маховые перья (середина): связывает нижний ярус с кончиком крыла
      const wingFeathersOuter = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.07, 0.52), eagleMat);
      wingFeathersOuter.position.set(s * 2.05, 4.02, -0.46);
      wingFeathersOuter.rotation.set(-0.30, s * 0.24, s * 0.35);
      g.add(wingFeathersOuter);
    }

    // Когти на змее — маленькие конусы
    for (const sx of [-0.4, 0, 0.4]) {
      const claw = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.25, 4), goldMat);
      claw.position.set(sx, 2.9, 0.3); claw.rotation.x = 0.5; g.add(claw);
    }

    // Хвост орла
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.08, 0.9), eagleMat);
    tail.position.set(0, 3.3, -0.8); tail.rotation.x = 0.3; g.add(tail);

    g.position.set(cx, baseY, cz);
    this.scene.add(g);
    this.addPropAABB({ x0: cx - 3.5, z0: cz - 3.5, x1: cx + 3.5, z1: cz + 3.5 });
  }

  /* Пятигорский узкоколейный Трамвай (реалистичные рельсы со шпалами, вагон КТМ-1) */
  _pyatigorskTramway() {
    const railMat = new THREE.MeshLambertMaterial({ color: 0xc4c4cc });
    const tieMat = new THREE.MeshLambertMaterial({ color: 0x3e342a });
    const bedMat = new THREE.MeshLambertMaterial({ color: 0x48484c });
    const glassMat = new THREE.MeshLambertMaterial({ color: 0x1c2836, transparent: true, opacity: 0.7 });

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

    // 4. Детализированный 3D-трамвайчик КТМ-1 / Татра — статичные непрозрачные
    // части (рама, бамперы, колёса, кузов, полоса, крыша, вентиляция,
    // пантограф, двери, сиденья) слиты в один vertexColors-меш вместо ~20
    // отдельных draw call'ов; стекло/фонари/маршрутный указатель остаются
    // отдельными мешами (своя прозрачность/emissive).
    const tram = new THREE.Group();
    const tramMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const tp = [];
    const addTP = (g, c) => tp.push({ g, c });

    // рама и тележки
    addTP(new THREE.BoxGeometry(10.2, 0.3, 2.2).translate(0, 0.5, 0), 0x3a3a3c);
    for (const sx of [-5.15, 5.15]) {
      addTP(new THREE.BoxGeometry(0.2, 0.35, 2.3).translate(sx, 0.5, 0), 0x3a3a3c);
      addTP(new THREE.CylinderGeometry(0.06, 0.06, 0.6, 6).rotateZ(Math.PI / 2).translate(sx + (sx > 0 ? 0.3 : -0.3), 0.45, 0), 0x3a3a3c);
    }
    // колёса (4 колёсные пары)
    const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.1, 12).rotateX(Math.PI / 2);
    for (const wx of [-2.8, -1.6, 1.6, 2.8]) {
      for (const wz of [-0.55, 0.55]) addTP(wheelGeo.clone().translate(wx, 0.35, wz), 0x222224);
    }
    // основной красный кузов — скруглённые (тапередные) торцы вместо плоских
    // граней: ось капота/кормы трамвая вдоль X, поэтому 90°-поворот меняет
    // местами "длину"(d) и "ширину"(w) у taperedBox
    addTP(taperedBox(2.3, 1.4, 9.9, { frontRise: -0.55, backRise: -0.55, topW: 2.12 }).rotateY(Math.PI / 2).translate(0, 1.35, 0), 0xcc2222);
    // бежевая верхняя полоса + крыша
    addTP(new THREE.BoxGeometry(10.05, 0.7, 2.38).translate(0, 2.4, 0), 0xf4eedc);
    addTP(new THREE.BoxGeometry(9.8, 0.35, 2.25).translate(0, 2.9, 0), 0xf4eedc);
    // вентиляционные короба на крыше
    for (const rx of [-2.5, 0, 2.5]) addTP(new THREE.BoxGeometry(1.2, 0.12, 0.8).translate(rx, 3.12, 0), 0x3a3a3c);
    // пантограф
    addTP(new THREE.BoxGeometry(1.6, 0.08, 1.2).translate(-0.5, 3.12, 0), 0x3a3a3c);
    addTP(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 5).rotateZ(Math.PI / 4).translate(-0.5, 3.7, 0), 0x3a3a3c);
    addTP(new THREE.BoxGeometry(0.1, 0.06, 1.6).translate(-0.1, 4.2, 0), 0x3a3a3c);
    // двери (панель, без стекла)
    for (const dx of [-3.2, 0, 3.2]) addTP(new THREE.BoxGeometry(1.1, 1.8, 0.08).translate(dx, 1.55, 1.16), 0x2a2a2c);
    // сиденья салона (видны через остекление)
    for (let sx = -3.8; sx <= 3.8; sx += 1.2) {
      for (const sz of [-0.7, 0.7]) addTP(new THREE.BoxGeometry(0.45, 0.4, 0.45).translate(sx, 1.0, sz), 0x8a5a3a);
    }
    // маршрутный софит (тёмный короб, светящаяся табличка — отдельным мешом ниже)
    addTP(new THREE.BoxGeometry(0.15, 0.35, 1.2).translate(-5.02, 2.55, 0), 0x111111);

    tram.add(new THREE.Mesh(mergeColored(tp), tramMat));

    // Остекление (боковые/лобовые стёкла + дверные, один прозрачный меш)
    const glassParts = [new THREE.BoxGeometry(9.6, 0.85, 2.42).translate(0, 2.15, 0)];
    for (const dx of [-3.2, 0, 3.2]) glassParts.push(new THREE.BoxGeometry(0.9, 0.8, 0.1).translate(dx, 1.9, 1.16));
    tram.add(new THREE.Mesh(mergeGeoms(glassParts), glassMat));

    // Передние фары (яркий тёплый свет) — один меш
    const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfff0aa });
    const headGeo = [-0.6, 0.6].map((hz) => new THREE.CylinderGeometry(0.16, 0.16, 0.1, 10).rotateZ(Math.PI / 2).translate(-5.06, 1.1, hz));
    tram.add(new THREE.Mesh(mergeGeoms(headGeo), headlightMat));

    // Задние красные габариты — один меш
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2222 });
    const tailGeo = [-0.7, 0.7].map((tz) => new THREE.CylinderGeometry(0.12, 0.12, 0.1, 8).rotateZ(Math.PI / 2).translate(5.06, 1.1, tz));
    tram.add(new THREE.Mesh(mergeGeoms(tailGeo), tailMat));

    // Маршрутоуказатель «№ 1 ЦВЕТНИК — ВОКЗАЛ» — светящаяся табличка над лобовым стеклом
    const routeSign = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.28, 1.1), new THREE.MeshBasicMaterial({ color: 0xffdf66 }));
    routeSign.position.set(-5.1, 2.55, 0); tram.add(routeSign);

    tram.position.set(-200, 0, 0);
    this.scene.add(tram);
    this.tram = tram;
    this.tramAnim = { pos: -200, dir: 1, speed: 8 };

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
    // Задняя стенка (solid)
    this.addPropAABB({ x0: x - 2.1, z0: z - 1.15, x1: x + 2.1, z1: z - 0.85 });
    // Скамейка (solid)
    this.addPropAABB({ x0: x - 1.0, z0: z - 0.6, x1: x + 1.0, z1: z - 0.2 });
    // Навес (overhead, y=2.4)
    this.addPropAABB({ x0: x - 2.2, z0: z - 1.2, x1: x + 2.2, z1: z + 1.2 }, 2.4);
  }

  /* Памятник Остапу Бендеру у входа в Провал */
  _ostapBenderStatue() {
    // Северо-восточный угол квартала (2,1), у перекрёстка (−64,−128). Старая
    // точка (−96,−140) лежала в 20 м от центра озера — ВНУТРИ circleCollider
    // {x:−96,z:−160,r:26}, машина упиралась в невидимую стену за 8 м до
    // памятника. Ближний угол AABB новой точки — 30.1 м от центра озера
    // (нужно больше 26 + 2.0 радиуса машины).
    const cx = -74, cz = -137;
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
    this.addPropAABB({ x0: cx - 1.2, z0: cz - 1.2, x1: cx + 1.2, z1: cz + 1.2 });
  }

  /* Пятигорская Телевышка на вершине Машука (красно-белая вышка с маяком) */
  _tvTower() {
    const cx = this.hill.x, cz = this.hill.z, baseY = this.heightAt(cx, cz);
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
    // Была на (0, 245) — прямо на оси дороги x=0 (ширина 12 м, x:-6..6), AABB
    // x:-4..4 перекрывал ВСЮ проезжую часть северного выезда. Переносим на
    // газон ЗА бордюром (x=20 — 14 м от оси дороги, бордюр на 6+4=10), чтобы
    // стела стояла рядом с трассой, а не посреди неё.
    const cx = 20, cz = 245;
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
    this.addPropAABB({ x0: cx - 4, z0: cz - 1, x1: cx + 4, z1: cz + 1 });
  }

  /* Цветник — квартал bi=3,bj=4 (x −54..−10, z 10..54).
     Draw calls: мощение 1 + слитая статика 1 + вода 1 = 3 (было 34).
     Памятник Орлу (−38,20) стоит почти на радиусе колец, поэтому его сектор
     исключается предикатом free() — сам монумент (позиция/AABB) не трогается. */
  _parkCvetnik() {
    const CX = -32, CZ = 32;
    const EGX = -38, EGZ = 20, EGR = 6.8;
    const free = (x, z) => dist2D(x, z, EGX, EGZ) > EGR;
    const p = [], wat = [], pave = [];
    const bx = (w, h, d, c, x, y, z) => p.push({ g: new THREE.BoxGeometry(w, h, d).translate(x, y, z), c });
    const cyl = (r1, r2, h, seg, c, x, y, z) => p.push({ g: new THREE.CylinderGeometry(r1, r2, h, seg).translate(x, y, z), c });
    const water = (r, y) => wat.push({ g: new THREE.CircleGeometry(r, 24).rotateX(-Math.PI / 2).translate(CX, y, CZ), c: '#ffffff' });

    /* 1. Мощение: круглая площадь + 4 радиальные дорожки до краёв квартала +
       входные «карманы». Плиты — коробки высотой 0.2 (верх 0.15, вровень
       с тротуарами, blockRect совпадает с их внешними краями). */
    const RP = 10.9;
    pave.push(uvTile(new THREE.CylinderGeometry(RP, RP, 0.2, 40).translate(CX, 0.05, CZ), RP, RP));
    for (let k = 0; k < 4; k++) {
      const ux = Math.round(Math.cos(k * Math.PI / 2)), uz = Math.round(Math.sin(k * Math.PI / 2));
      const alongX = k % 2 === 0;
      const path = alongX ? new THREE.BoxGeometry(11.4, 0.2, 2.8) : new THREE.BoxGeometry(2.8, 0.2, 11.4);
      pave.push(uvTile(path.translate(CX + ux * 16.3, 0.05, CZ + uz * 16.3),
        alongX ? 5.7 : 1.4, alongX ? 1.4 : 5.7));
      for (const s of [-1, 1]) {                      // карманы по бокам входа (не перекрывают дорожку)
        const lobe = alongX ? new THREE.BoxGeometry(3.4, 0.2, 2.0) : new THREE.BoxGeometry(2.0, 0.2, 3.4);
        pave.push(uvTile(lobe.translate(CX + ux * 20.3 - uz * s * 2.4, 0.05, CZ + uz * 20.3 + ux * s * 2.4),
          alongX ? 1.7 : 1.0, alongX ? 1.0 : 1.7));
      }
    }

    /* 2. Фонтан: ступень, чаша, тумба, две тарелки, шар. Вода лежит НАД
       верхом каждой чаши/тарелки (иначе диск прячется внутри цилиндра). */
    cyl(7.90, 8.20, 0.34, 28, PK.kerb,  CX, 0.32, CZ);   // ступень 0.15..0.49
    cyl(6.90, 7.20, 0.80, 28, PK.stone, CX, 0.89, CZ);   // борт чаши 0.49..1.29
    cyl(1.05, 1.50, 1.20, 12, PK.stone, CX, 1.89, CZ);   // тумба 1.29..2.49
    cyl(3.00, 1.30, 0.40, 18, PK.stone, CX, 2.69, CZ);   // нижняя тарелка 2.49..2.89
    cyl(0.50, 0.70, 1.40, 10, PK.stone, CX, 3.59, CZ);   // колонна 2.89..4.29
    cyl(1.60, 0.75, 0.34, 14, PK.stone, CX, 4.46, CZ);   // верхняя тарелка 4.29..4.63
    p.push({ g: new THREE.SphereGeometry(0.36, 10, 8).translate(CX, 4.95, CZ), c: PK.stoneD });
    water(6.50, 1.31); water(2.85, 2.91); water(1.45, 4.65);
    wat.push({ g: new THREE.CylinderGeometry(0.10, 0.18, 1.5, 6).translate(CX, 5.55, CZ), c: '#ffffff' });
    this.addPropAABB({ x0: CX - 8.2, z0: CZ - 8.2, x1: CX + 8.2, z1: CZ + 8.2 });

    /* 3. Клумбы: 8 секторов, длинная ось ПО КАСАТЕЛЬНОЙ (раньше все коробки
       смотрели одинаково и кольцо не читалось). Сектор Орла пропускаем. */
    const RB = 12.8;
    for (let k = 0; k < 8; k++) {
      const a = (22.5 + k * 45) * Math.PI / 180;
      const fx = CX + Math.cos(a) * RB, fz = CZ + Math.sin(a) * RB;
      if (!free(fx, fz)) continue;
      const rot = -a - Math.PI / 2;
      p.push({ g: new THREE.BoxGeometry(5.2, 0.7, 1.9).rotateY(rot).translate(fx, 0.30, fz), c: PK.kerb });
      p.push({ g: new THREE.BoxGeometry(4.6, 0.24, 1.34).rotateY(rot).translate(fx, 0.72, fz),
               c: PK_FLOWERS[k % PK_FLOWERS.length] });
      for (const t of [-1.5, 0, 1.5]) {
        p.push({ g: new THREE.SphereGeometry(0.5, 8, 5).scale(1, 0.6, 1)
          .translate(fx + Math.cos(rot) * t, 0.88, fz - Math.sin(rot) * t),
          c: PK_FLOWERS[(k + 3) % PK_FLOWERS.length] });
      }
      this.addPropAABB(this._rotRect(fx, fz, rot, 5.2, 1.9));
    }

    /* 4. Скамьи кольцом — ЛИЦОМ к фонтану, со всех сторон, включая южную
       (раньше 6 скамей стояли к фонтану спиной, юга не было вовсе). */
    for (let k = 0; k < 8; k++) {
      const a = (22.5 + k * 45) * Math.PI / 180;
      const sx = CX + Math.cos(a) * 15.8, sz = CZ + Math.sin(a) * 15.8;
      if (!free(sx, sz)) continue;
      this._bench(sx, sz, -a - Math.PI / 2, 0, p);
    }

    /* 5. Вазоны у четырёх входов в парк (стоят на карманах мощения) */
    for (let k = 0; k < 4; k++) {
      const ux = Math.round(Math.cos(k * Math.PI / 2)), uz = Math.round(Math.sin(k * Math.PI / 2));
      for (const s of [-1, 1]) {
        const vx = CX + ux * 20.3 - uz * s * 2.4, vz = CZ + uz * 20.3 + ux * s * 2.4;
        if (!free(vx, vz)) continue;
        this._planter(p, vx, vz, (k * 2 + s) * 0.35, PK_FLOWERS[(k * 2 + (s + 1) / 2) % PK_FLOWERS.length]);
      }
    }

    /* 6. Пергола в дальнем углу (пустой угол квартала, вне колец и вне Орла) */
    const GX = -46, GZ = 45.5;
    for (const gx of [-2.6, 0, 2.6]) for (const gz of [-1.5, 1.5]) bx(0.26, 3.0, 0.26, PK.wood, GX + gx, 1.40, GZ + gz);
    for (const gz of [-1.5, 1.5]) bx(6.0, 0.22, 0.30, PK.wood, GX, 3.01, GZ + gz);
    for (let k = 0; k <= 8; k++) bx(0.12, 0.14, 3.5, PK.wood, GX - 2.8 + k * 0.7, 3.19, GZ);
    this._bench(GX, GZ, -Math.atan2(GZ - CZ, GX - CX) - Math.PI / 2, 0, p);
    // 6 стоек (solid)
    for (const gx of [-2.6, 0, 2.6]) for (const gz of [-1.5, 1.5]) {
      this.addPropAABB({ x0: GX + gx - 0.2, z0: GZ + gz - 0.2, x1: GX + gx + 0.2, z1: GZ + gz + 0.2 });
    }
    // Балки перголы (overhead, y=3.0)
    this.addPropAABB({ x0: GX - 3.0, z0: GZ - 1.9, x1: GX + 3.0, z1: GZ + 1.9 }, 3.0);

    /* 7. Меши */
    this.scene.add(new THREE.Mesh(mergeGeoms(pave),
      new THREE.MeshLambertMaterial({ map: this._pavementTexture('pavement_park') })));
    this.scene.add(new THREE.Mesh(mergeColored(p), this._vcMat()));
    this.scene.add(new THREE.Mesh(mergeColored(wat),
      new THREE.MeshPhongMaterial({ color: 0x66ccff, transparent: true, opacity: 0.85, shininess: 60 })));
  }

  /* Один MeshLambertMaterial({vertexColors}) на всю слитую мелочь города:
     меши разные, но материал общий — нет лишних переключений программы. */
  _vcMat() {
    if (!this._vcMatCache) this._vcMatCache = new THREE.MeshLambertMaterial({ vertexColors: true });
    return this._vcMatCache;
  }

  /**
   * Скамья. Если передан parts — геометрия пишется в общий merge-буфер вызывающего
   * (как _stationVehicle), иначе строится отдельный слитый меш. Раньше каждая скамья
   * = 4 меша + 3 новых материала; теперь 1 меш на партию (или 1 на скамью).
   * Спинка в локальных координатах на z=-0.26 ⇒ сидящий смотрит в локальный +z,
   * то есть в мир по (sin rotY, cos rotY).
   */
  _bench(x, z, rotY, y = 0.12, parts = null) {
    const out = parts || [];
    const put = (g, c) => out.push({ g: g.rotateY(rotY).translate(x, y, z), c });
    put(new THREE.BoxGeometry(1.8, 0.1, 0.55).translate(0, 0.55, 0), BENCH_WOOD);
    put(new THREE.BoxGeometry(1.8, 0.55, 0.1).translate(0, 0.8, -0.26), BENCH_WOOD);
    for (const s of [-0.78, 0.78]) {
      put(new THREE.BoxGeometry(0.12, 0.5, 0.42).translate(s, 0.25, 0), BENCH_LEG);
    }
    this.addPropAABB(this._rotRect(x, z, rotY, 1.9, 0.7));
    if (!parts) this.scene.add(new THREE.Mesh(mergeColored(out), this._vcMat()));
  }

  /**
   * Вазон с цветами (первый экземпляр такого хелпера в проекте). Пишет геометрию
   * в общий буфер parts — вазоны всего города укладываются в один draw call.
   * Регистрирует свой AABB сам, как _bench().
   */
  _planter(parts, x, z, rotY = 0, color = 0xd94f4f, y = 0.1) {
    const put = (g, c) => parts.push({ g: g.rotateY(rotY).translate(x, y, z), c });
    put(new THREE.CylinderGeometry(0.28, 0.34, 0.14, 8).translate(0, 0.07, 0), PLANTER_STONE);
    put(new THREE.CylinderGeometry(0.46, 0.30, 0.46, 8).translate(0, 0.37, 0), PLANTER_STONE);
    put(new THREE.CylinderGeometry(0.52, 0.48, 0.13, 8).translate(0, 0.66, 0), PLANTER_RIM);
    put(new THREE.SphereGeometry(0.44, 8, 5).scale(1, 0.5, 1).translate(0, 0.74, 0), PLANTER_LEAF);
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + 0.4;
      put(new THREE.SphereGeometry(0.15, 6, 4).translate(Math.cos(a) * 0.24, 0.84, Math.sin(a) * 0.24), color);
    }
    this.addPropAABB({ x0: x - 0.6, z0: z - 0.6, x1: x + 0.6, z1: z + 0.6 });
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

  /* Рынок «Лира» — квартал bi=5,bj=3 (x 74..118, z −54..−10).
     Средний интервал колонн раздвинут: получился центральный проезд ровно
     по оси x=96 — это и есть центр квартала и точка высадки заказа «Рынок
     Лира» (config.js LANDMARKS + orders.js). Раньше эта точка лежала внутри
     AABB палатки (98,−34), а ящики (cz = −10 + rng()*8) сыпались на дорогу z=0.
     Draw calls: мощение 1 + слитая мелочь 1 + навесы 1 + вывеска 1 = 4 (было 4). */
  _market() {
    const BX = 96, BZ = -32;                                   // центр квартала = точка высадки
    const COLS = [79, 88, 104, 113], ROWS = [-48, -34, -20];
    const FX0 = 74.4, FX1 = 117.6, FZ0 = -53.6, FZ1 = -11.2;   // линия ограды
    const p = [], can = [];                                    // p — vertexColors, can — навесы
    const bx = (arr, w, h, d, c, x, y, z) =>
      arr.push({ g: new THREE.BoxGeometry(w, h, d).translate(x, y, z), c });
    const cyl = (r1, r2, h, seg, c, x, y, z) =>
      p.push({ g: new THREE.CylinderGeometry(r1, r2, h, seg).translate(x, y, z), c });

    /* 1. Мощение всего квартала. Плита 44×44 высотой 0.2 — верх 0.15, вровень
       с тротуарами (blockRect совпадает с их внешними краями). Свой ключ
       текстуры + uvTile: repeat общего инстанса 'pavement' не трогаем. */
    this.scene.add(new THREE.Mesh(
      uvTile(new THREE.BoxGeometry(44, 0.2, 44).translate(BX, 0.05, BZ), 22, 22),
      new THREE.MeshLambertMaterial({ map: this._pavementTexture('pavement_market') })));
    bx(p, 7.2, 0.02, 7.2, 0xc8c2b2, BX, 0.16, BZ);   // площадка высадки (без AABB — по ней ездят)

    /* 2. Двенадцать палаток. Ноги 0.15..3.25 упираются в навес 3.23..3.47 —
       раньше навес висел в 0.2 м над ногами. Подзор по краям навеса и лотки
       с товаром на прилавке дают силуэт вместо «парящих плит». */
    for (let ri = 0; ri < ROWS.length; ri++) for (let ci = 0; ci < COLS.length; ci++) {
      const x = COLS[ci], z = ROWS[ri];
      bx(p, 8.0, 0.8, 4.6, MK.stall, x, 1.55, z);                       // прилавок 1.15..1.95
      for (const sx of [-3.6, 3.6]) for (const sz of [-1.9, 1.9]) {
        cyl(0.14, 0.17, 3.1, 5, MK.post, x + sx, 1.70, z + sz);          // 4 стойки (было 2)
      }
      bx(can, 8.4, 0.24, 5.0, 0xffffff, x, 3.35, z);                     // навес
      for (const sz of [-2.56, 2.56]) bx(p, 8.4, 0.36, 0.12, MK.valance, x, 3.05, z + sz);
      for (let k = 0; k < 4; k++) {
        bx(p, 1.5, 0.3, 1.2, MK_GOODS[(k + ci + ri * 2) % MK_GOODS.length], x - 2.7 + k * 1.8, 2.10, z);
      }
      for (const sx of [-3.1, 3.1]) bx(p, 1.0, 0.62, 1.0, MK.crate, x + sx, 0.46, z + (sx > 0 ? 1.4 : -1.4));
      // 4 стойки (solid)
      for (const sx of [-3.6, 3.6]) for (const sz of [-1.9, 1.9]) {
        this.addPropAABB({ x0: x + sx - 0.2, z0: z + sz - 0.2, x1: x + sx + 0.2, z1: z + sz + 0.2 });
      }
      // Навес (overhead, y=3.35)
      this.addPropAABB({ x0: x - 4.4, z0: z - 2.6, x1: x + 4.4, z1: z + 2.6 }, 3.35);
    }

    /* 3. Ограда по периметру. AABB — один на прогон (5 штук), а не на столб:
       player.js перебирает propsAABB линейно каждый кадр. */
    const fence = (x0, z0, x1, z1) => {
      const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
      const len = alongX ? x1 - x0 : z1 - z0;
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      for (const y of [0.62, 1.08]) {
        if (alongX) bx(p, len, 0.08, 0.06, MK.rail, mx, y, mz);
        else bx(p, 0.06, 0.08, len, MK.rail, mx, y, mz);
      }
      const n = Math.max(1, Math.round(len / 2.4));
      for (let i = 0; i <= n; i++) {
        cyl(0.09, 0.11, 1.3, 5, MK.post, x0 + (x1 - x0) * (i / n), 0.80, z0 + (z1 - z0) * (i / n));
      }
      this.addPropAABB(alongX ? { x0, z0: mz - 0.3, x1, z1: mz + 0.3 }
                              : { x0: mx - 0.3, z0, x1: mx + 0.3, z1 });
    };
    fence(FX0, FZ0, FX0, FZ1);      // запад
    fence(FX1, FZ0, FX1, FZ1);      // восток
    fence(FX0, FZ0, FX1, FZ0);      // юг
    fence(FX0, FZ1, 90.2, FZ1);     // север, левое крыло
    fence(101.8, FZ1, FX1, FZ1);    // север, правое крыло  (створ 8.4 м над проездом)

    /* 4. Ворота с вывеской. Просвет 91.8..100.2 — машина (радиус 2) проходит. */
    for (const gx of [91, 101]) {
      bx(p, 1.5, 3.5, 1.5, MK.stone, gx, 1.90, FZ1);       // тумба 0.15..3.65
      bx(p, 1.8, 0.22, 1.8, MK.stone, gx, 3.76, FZ1);      // навершие
      this.addPropAABB({ x0: gx - 0.85, z0: FZ1 - 0.85, x1: gx + 0.85, z1: FZ1 + 0.85 });
    }
    bx(p, 11.6, 0.55, 1.0, MK.post, BX, 4.15, FZ1);        // перекладина 3.87..4.42
    for (let k = 0; k < 9; k++) {                           // флажки под перекладиной
      bx(p, 0.36, 0.44, 0.04, MK_GOODS[k % MK_GOODS.length], BX - 4 + k, 3.64, FZ1);
    }
    const signTex = this._signTexture('РЫНОК «ЛИРА»', 'sign_rynok', '#7c1f18', '#f4e2b8');
    this.scene.add(new THREE.Mesh(mergeGeoms([
      new THREE.PlaneGeometry(9.6, 1.35).translate(BX, 4.15, FZ1 + 0.54),
      new THREE.PlaneGeometry(9.6, 1.35).rotateY(Math.PI).translate(BX, 4.15, FZ1 - 0.54),
    ]), new THREE.MeshLambertMaterial({
      map: signTex, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.2 })));

    /* 5. Водоразборная колонка (северная полоса) и весы (проход между рядами) */
    cyl(1.05, 1.15, 0.90, 12, MK.stone, 85, 0.60, -14.5);
    cyl(1.05, 1.05, 0.14, 12, MK.stone, 85, 1.12, -14.5);
    for (const sx of [-0.95, 0.95]) bx(p, 0.16, 1.55, 0.16, MK.post, 85 + sx, 1.92, -14.5);
    bx(p, 2.5, 0.16, 1.2, MK.post, 85, 2.78, -14.5);
    p.push({ g: new THREE.CylinderGeometry(0.09, 0.09, 1.7, 6).rotateZ(Math.PI / 2).translate(85, 2.45, -14.5), c: MK.metal });
    cyl(0.24, 0.20, 0.34, 8, MK.metal, 85, 1.40, -14.5);   // ведро
    this.addPropAABB({ x0: 83.6, z0: -15.9, x1: 86.4, z1: -13.1 });

    bx(p, 1.7, 0.70, 1.3, MK.stall, 108, 0.50, -27);
    bx(p, 1.4, 0.10, 1.1, MK.metal, 108, 0.90, -27);
    cyl(0.07, 0.07, 1.10, 6, MK.metal, 108, 1.50, -27);
    p.push({ g: new THREE.CylinderGeometry(0.42, 0.42, 0.10, 12).rotateX(Math.PI / 2).translate(108, 2.10, -27), c: 0xf0ece0 });
    this.addPropAABB({ x0: 106.9, z0: -28.1, x1: 109.1, z1: -25.9 });

    /* 6. Ящики и мешки — валидированный разброс вместо cz = −10 + rng()*8
       (половина ящиков падала на асфальт дороги z=0). isPositionValid уже знает
       про дорогу, палатки, ограду и ворота; проезд исключаем явно. */
    for (let i = 0; i < 30; i++) {
      const cx = 75.5 + this.rng() * 41, cz = -52.5 + this.rng() * 40;
      if (Math.abs(cx - BX) < 5.0) continue;                 // центральный проезд — свободен
      if (!this.isPositionValid(cx, cz, 0.8)) continue;
      if (this.rng() < 0.35) {
        cyl(0.34, 0.50, 0.86, 8, MK.sack, cx, 0.58, cz);
      } else {
        const rot = (this.rng() - 0.5) * 0.9;
        const n = this.rng() < 0.4 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          p.push({ g: new THREE.BoxGeometry(1.05, 0.62, 1.05).rotateY(rot + k * 0.3)
            .translate(cx, 0.46 + k * 0.62, cz), c: k ? MK.crate2 : MK.crate });
        }
      }
      this.addPropAABB({ x0: cx - 0.7, z0: cz - 0.7, x1: cx + 0.7, z1: cz + 0.7 });
    }

    /* 7. Меши */
    this.scene.add(new THREE.Mesh(mergeColored(p), this._vcMat()));
    this.scene.add(new THREE.Mesh(mergeColored(can),
      new THREE.MeshLambertMaterial({ map: this._stripedTexture('#c0392b', '#f0f0e8') })));
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

  /* Циферблат вокзальных часов: белый диск, риски, стрелки на 10:10 */
  _clockTexture() {
    const key = 'station_clock';
    if (_texCache.has(key)) return _texCache.get(key);
    const c = makeCanvas(256, 256);
    const g = c.getContext('2d');
    g.fillStyle = '#f4f1e6';
    g.beginPath(); g.arc(128, 128, 120, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#2a2a26'; g.lineWidth = 8; g.stroke();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const big = i % 3 === 0;
      g.lineWidth = big ? 12 : 5;
      const r0 = big ? 82 : 94;
      g.beginPath();
      g.moveTo(128 + Math.sin(a) * r0, 128 - Math.cos(a) * r0);
      g.lineTo(128 + Math.sin(a) * 108, 128 - Math.cos(a) * 108);
      g.stroke();
    }
    g.lineCap = 'round'; g.strokeStyle = '#1a1a18';
    const hand = (ang, len, w) => {
      g.lineWidth = w;
      g.beginPath(); g.moveTo(128, 128);
      g.lineTo(128 + Math.sin(ang) * len, 128 - Math.cos(ang) * len); g.stroke();
    };
    hand((10 + 10 / 60) / 12 * Math.PI * 2, 60, 14);  // часовая
    hand((10 / 60) * Math.PI * 2, 92, 8);             // минутная
    g.fillStyle = '#b03028';
    g.beginPath(); g.arc(128, 128, 8, 0, Math.PI * 2); g.fill();
    const t = canvasToTexture(c, key);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* Текстура вывески: тёмная доска с рамкой и текстом (по образцу таблички АЗС) */
  _signTexture(text, key, bg = '#1b2a3a', fg = '#f2ead6') {
    if (_texCache.has(key)) return _texCache.get(key);
    const c = makeCanvas(512, 96);
    const g = c.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, 512, 96);
    g.strokeStyle = fg; g.lineWidth = 4; g.strokeRect(6, 6, 500, 84);
    g.fillStyle = fg; g.font = 'bold 54px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 256, 51);
    const t = canvasToTexture(c, key);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /**
   * Один экипаж стоящего у перрона состава. Вся статика пишется в общие
   * merged-буферы вызывающего кода, поэтому экипаж не добавляет draw call'ов.
   * Колёса статичны (поезд декоративный и не едет) — сливаются вместе с кузовом,
   * как колёса машин в traffic.js. Ось состава — X, поэтому цилиндры колёс
   * разворачиваются rotateX(PI/2) (ось Z), а не rotateZ, как у машин.
   * @param {{body: Array, glow: Array, head: Array, red: Array}} bufs буферы геометрии
   * @param {number} cx центр экипажа по X (мировые координаты)
   * @param {number} tz ось пути по Z
   * @param {number} y0 уровень головки рельса
   * @param {number} len длина экипажа
   * @param {'loco'|'car'|'tail'} kind локомотив / вагон / последний вагон (с красными огнями)
   */
  _stationVehicle(bufs, cx, tz, y0, len, kind) {
    const P = TRAIN_PAL;
    const half = len / 2;
    const bx = (w, h, d, c, x, y, z) =>
      bufs.body.push({ g: new THREE.BoxGeometry(w, h, d).translate(cx + x, y0 + y, tz + z), c });
    const gl = (w, h, d, x, y, z) =>
      bufs.glow.push({ g: new THREE.BoxGeometry(w, h, d).translate(cx + x, y0 + y, tz + z), c: P.glass });
    const cylZ = (r, h, seg, c, x, y, z) =>
      bufs.body.push({ g: new THREE.CylinderGeometry(r, r, h, seg).rotateX(Math.PI / 2).translate(cx + x, y0 + y, tz + z), c });
    const cylY = (r, h, seg, c, x, y, z) =>
      bufs.body.push({ g: new THREE.CylinderGeometry(r, r, h, seg).translate(cx + x, y0 + y, tz + z), c });

    /* --- Ходовая часть: две двухосные тележки --- */
    for (const s of [-1, 1]) {
      const bogie = s * (half - 2.5);
      bx(4.9, 0.6, 2.15, P.under, bogie, 0.9, 0);
      for (const a of [-1.2, 1.2]) {
        for (const wz of [-0.6, 0.6]) {
          cylZ(0.5, 0.22, 12, P.wheel, bogie + a, 0.5, wz);
          cylZ(0.24, 0.24, 8, P.hub, bogie + a, 0.5, wz);
        }
      }
    }

    /* --- Рама и автосцепки СА-3 --- */
    bx(len - 0.4, 0.45, 2.6, P.under, 0, 1.32, 0);
    for (const s of [-1, 1]) {
      bx(0.3, 0.55, 2.5, P.dark, s * (half - 0.12), 1.3, 0);   // буферный брус
      bx(0.5, 0.42, 0.5, P.dark, s * (half + 0.2), 1.15, 0);   // автосцепка
    }

    if (kind === 'loco') {
      /* --- Тепловоз: капот, ливрея, кабины по обоим концам --- */
      bx(len - 0.5, 2.7, 2.9, P.loco, 0, 2.85, 0);             // кузов 1.5..4.2
      bx(len - 0.4, 0.32, 2.96, P.band, 0, 1.74, 0);           // нижняя полоса
      bx(len - 0.4, 0.18, 2.96, P.band, 0, 3.98, 0);           // подкрышевая полоса
      bx(len - 1.1, 0.42, 2.72, P.roof, 0, 4.41, 0);           // крыша 4.2..4.62
      for (let k = 0; k < 5; k++) for (const sz of [-1, 1]) {  // жалюзи машинного отделения
        bx(1.0, 1.25, 0.1, P.dark, -3.2 + k * 1.6, 2.8, sz * 1.47);
      }
      for (const s of [-1, 1]) {
        bx(0.14, 1.5, 2.62, P.dark, s * (half - 0.32), 3.42, 0);        // маска лобовой части
        gl(0.16, 0.95, 2.05, s * (half - 0.24), 3.45, 0);               // лобовое стекло
        for (const sz of [-1, 1]) {
          gl(1.2, 0.85, 0.1, s * (half - 1.6), 3.45, sz * 1.47);        // боковое окно кабины
          bx(0.9, 2.0, 0.1, P.dark, s * (half - 2.6), 2.5, sz * 1.47);  // дверь кабины
        }
        bx(1.0, 0.14, 0.55, P.under, s * (half - 0.6), 1.05, 0);        // подножка
      }
      for (const fx of [1.6, 3.4]) cylY(0.55, 0.18, 10, P.roof, fx, 4.71, 0);  // вентиляторы холодильника
      cylY(0.26, 0.55, 8, P.dark, -1.4, 4.9, 0.6);                              // выхлопная труба
      bx(0.6, 0.16, 0.16, P.dark, -3.6, 4.7, -0.5);                             // тифон
      /* Фары — отдельным emissive-мешем: свечение теряется при слиянии в vertexColors */
      for (const sz of [-0.95, 0.95]) {
        bufs.head.push(new THREE.BoxGeometry(0.2, 0.3, 0.34).translate(cx - (half - 0.18), y0 + 2.1, tz + sz));
      }
      bufs.head.push(new THREE.BoxGeometry(0.2, 0.26, 0.4).translate(cx - (half - 0.18), y0 + 4.1, tz));
    } else {
      /* --- Пассажирский вагон --- */
      bx(len - 0.4, 2.45, 2.9, P.car, 0, 2.72, 0);             // кузов 1.5..3.95
      bx(len - 0.3, 0.26, 2.96, P.band, 0, 1.7, 0);            // светлая юбка
      bx(len - 1.0, 0.3, 2.8, P.roof, 0, 4.08, 0);             // крыша
      bx(len - 1.6, 0.22, 2.2, P.roof, 0, 4.32, 0);            // конёк
      for (let k = 0; k < 6; k++) for (const sz of [-1, 1]) {  // окна салона
        gl(1.0, 0.95, 0.1, -4.25 + k * 1.7, 3.15, sz * 1.47);
      }
      for (const s of [-1, 1]) for (const sz of [-1, 1]) {     // тамбурные двери
        bx(0.95, 2.05, 0.1, P.dark, s * (half - 1.4), 2.52, sz * 1.47);
        gl(0.6, 0.5, 0.12, s * (half - 1.4), 3.15, sz * 1.47);
        bx(1.1, 0.12, 0.5, P.under, s * (half - 1.4), 1.05, sz * 1.3);  // подножка
      }
      for (const s of [-1, 1]) bx(0.4, 2.2, 1.7, P.dark, s * (half - 0.05), 2.6, 0);  // межвагонный переход
      for (const sz of [-1, 1]) bx(2.6, 0.4, 0.08, P.band, 0, 1.98, sz * 1.47);       // маршрутная табличка
      for (const rx of [-4, -1.3, 1.4, 4.1]) bx(0.45, 0.14, 0.6, P.under, rx, 4.5, 0); // дефлекторы
      if (kind === 'tail') {
        for (const sz of [-1.1, 1.1]) {
          bufs.red.push(new THREE.BoxGeometry(0.18, 0.26, 0.3).translate(cx + (half - 0.12), y0 + 2.1, tz + sz));
        }
      }
    }
  }

  /* Вокзал: здание с башней и часами, крытый перрон, три пути и стоящий состав */
  _station() {
    const CX = 160, CZ = 82;              // центр здания
    const PLAT_TOP = 1.0;                 // верх платформы
    const RAIL_Y = 0.45;                  // головка рельса
    const TRACK_Z = [106, 110.5, 115];    // оси трёх путей (как было)
    const PLAT_Z = 101;                   // ось платформы (глубина 7 м: 97.5..104.5)

    /* Палитра (все константы локальны — _station() вызывается ровно один раз) */
    const C_WALL = 0xc8b898, C_TRIM = 0xe8dcc4, C_BASE = 0x9a8c70;
    const C_ROOF = 0x6a4a2a, C_DOOR = 0x4a3423, C_GLASS = 0x2a3442;
    const C_MET = 0x6a6a66, C_PAVE = 0xb0b0a8, C_EDGE = 0xe8c840;
    const C_BALLAST = 0x3a3733, C_SLEEP = 0x4a3a2c, C_RAIL = 0xa8a8b0;

    /* Материалы: ОДИН vertexColors на все merged-меши вокзала, ОДИН «светящийся»
       на все окна (регистрируется в windowMats — ночная подсветка из update()) */
    const matVC = new THREE.MeshLambertMaterial({ vertexColors: true });
    const matGlow = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xffd070, emissiveIntensity: 0.04 });
    this.windowMats.add(matGlow);
    const matHead = new THREE.MeshLambertMaterial({ color: 0xfff4cc, emissive: 0xfff0aa, emissiveIntensity: 0.9 });
    const matRed = new THREE.MeshLambertMaterial({ color: 0x8e1f1f, emissive: 0xff2a2a, emissiveIntensity: 0.8 });

    /* Буферы геометрии: st — камень здания, yd — перрон и пути, gw — окна,
       hd/rd — emissive-огни (сливаются отдельно, свечение теряется в vertexColors) */
    const st = [], yd = [], gw = [], hd = [], rd = [];
    const bx = (arr, w, h, d, c, x, y, z) => arr.push({ g: new THREE.BoxGeometry(w, h, d).translate(x, y, z), c });

    /* ================= 1. Здание ================= */
    const mat = new THREE.MeshLambertMaterial({ color: C_WALL });
    const b = new THREE.Mesh(new THREE.BoxGeometry(56, 14, 18), mat);
    b.position.set(CX, 0.15 + 7, CZ);
    this.scene.add(b);                         // castShadow не нужен: x=160 вне SHADOW_HALF=90
    const tower = new THREE.Mesh(new THREE.BoxGeometry(9, 26, 9), new THREE.MeshLambertMaterial({ color: 0xd8c8a8 }));
    tower.position.set(CX, 0.15 + 13, CZ);
    this.scene.add(tower);
    const troof = new THREE.Mesh(new THREE.ConeGeometry(7.5, 6, 4), new THREE.MeshLambertMaterial({ color: C_ROOF }));
    troof.rotation.y = Math.PI / 4;
    troof.position.set(CX, 0.15 + 26 + 3, CZ);
    this.scene.add(troof);

    /* Цоколь, междуэтажный пояс, карниз, аттик */
    bx(st, 56.6, 1.6, 18.6, C_BASE, CX, 0.75, CZ);      // -0.05..1.55
    bx(st, 56.6, 0.45, 18.6, C_TRIM, CX, 7.6, CZ);      // пояс 7.375..7.825
    bx(st, 58.0, 0.8, 20.0, C_TRIM, CX, 13.75, CZ);     // карниз 13.35..14.15
    bx(st, 56.8, 1.2, 18.8, C_WALL, CX, 14.75, CZ);     // аттик 14.15..15.35
    bx(st, 57.4, 0.35, 19.4, C_TRIM, CX, 15.52, CZ);    // отлив аттика

    /* Окно: наличник + подоконник в буфер камня, стекло — в «светящийся» буфер.
       Наличник 0.34 выступает на 0.17, стекло 0.4 — на 0.2, поэтому стекло
       читается как панель внутри рамки (тот же приём «слоёных плит», что в traffic.js). */
    const addWin = (x, y, z, w, h, alongX) => {
      const fw = alongX ? w + 0.55 : 0.34, fd = alongX ? 0.34 : w + 0.55;
      const gwd = alongX ? 0.4 : w, gww = alongX ? w : 0.4;
      bx(st, fw, h + 0.55, fd, C_TRIM, x, y, z);
      bx(gw, gww, h, gwd, C_GLASS, x, y, z);
      bx(st, fw + 0.3, 0.18, fd + 0.3, C_TRIM, x, y - h / 2 - 0.42, z);  // подоконник
    };
    const winX = [-23.4, -18.1, -12.8, -7.5, 7.5, 12.8, 18.1, 23.4];
    for (const dx of winX) for (const wz of [91, 73]) {
      addWin(CX + dx, 5.0, wz, 2.4, 4.0, true);      // 1-й этаж: 3.0..7.0
      addWin(CX + dx, 10.4, wz, 2.0, 2.4, true);     // 2-й этаж: 9.2..11.6
    }
    for (const wx of [132, 188]) for (const dz of [-4.6, 4.6]) {
      addWin(wx, 5.0, CZ + dz, 2.4, 4.0, false);
      addWin(wx, 10.4, CZ + dz, 2.0, 2.4, false);
    }

    /* Порталы входов с двух сторон: со двора (z=73) и с перрона (z=91) */
    for (const s of [1, -1]) {
      const wz = s > 0 ? 91 : 73;                    // s = наружная нормаль по Z
      bx(st, 11, 7.3, 0.6, C_TRIM, CX, 3.65, wz);
      for (const dx of [-1.05, 1.05]) bx(st, 1.9, 4.4, 0.5, C_DOOR, CX + dx, 2.35, wz + s * 0.25);
      bx(gw, 6.4, 1.4, 0.5, C_GLASS, CX, 5.5, wz + s * 0.25);              // фрамуга
      for (const dx of [-4.7, 4.7]) {
        st.push({ g: new THREE.CylinderGeometry(0.45, 0.5, 6.9, 10).translate(CX + dx, 3.45, wz + s * 0.4), c: C_TRIM });
      }
      bx(st, 13, 0.22, 2.0, C_BASE, CX, 0.26, wz + s * 1.0);               // стилобат, 2 ступени
      bx(st, 11.5, 0.22, 1.4, C_BASE, CX, 0.48, wz + s * 0.7);
    }

    /* Башня: угловые лопатки, пояса, проёмы звонницы, шпиль-навершие */
    for (const sx of [-4.2, 4.2]) for (const sz of [-4.2, 4.2]) {
      bx(st, 1.2, 26, 1.2, C_TRIM, CX + sx, 13.15, CZ + sz);
    }
    bx(st, 10.4, 0.5, 10.4, C_TRIM, CX, 15.6, CZ);
    bx(st, 10.8, 0.65, 10.8, C_TRIM, CX, 25.8, CZ);
    for (const s of [-1, 1]) {
      bx(st, 2.4, 3.4, 0.3, 0x1e2228, CX, 23.4, CZ + s * 4.55);           // проёмы звонницы
      bx(st, 0.3, 3.4, 2.4, 0x1e2228, CX + s * 4.55, 23.4, CZ);
    }
    st.push({ g: new THREE.CylinderGeometry(0.12, 0.12, 2.8, 6).translate(CX, 33.5, CZ), c: 0x7a6a4a });
    st.push({ g: new THREE.SphereGeometry(0.5, 8, 6).translate(CX, 35.2, CZ), c: 0xd8b83a });

    /* Основания четырёх циферблатов */
    for (const [dx, dz] of [[0, 4.62], [0, -4.62], [4.62, 0], [-4.62, 0]]) {
      const g = new THREE.CylinderGeometry(3.05, 3.05, 0.36, 16);
      if (dz !== 0) g.rotateX(Math.PI / 2); else g.rotateZ(Math.PI / 2);
      st.push({ g: g.translate(CX + dx, 19.0, CZ + dz), c: C_TRIM });
    }

    /* ================= 2. Перрон, навес, пути ================= */
    bx(yd, 46, 1.05, 7, C_PAVE, CX, 0.475, PLAT_Z);                        // платформа -0.05..1.0
    bx(yd, 45, 0.05, 6.6, 0xbdb9ad, CX, PLAT_TOP + 0.01, PLAT_Z);          // мощение
    bx(yd, 46, 0.16, 0.9, 0xa8a49c, CX, PLAT_TOP - 0.04, 104.1);           // краевой камень
    bx(yd, 46, 0.06, 0.45, C_EDGE, CX, PLAT_TOP + 0.04, 104.1);            // жёлтая линия безопасности
    for (const sx of [143, 177]) {                                          // лестницы на платформу
      bx(yd, 6, 0.35, 0.9, C_PAVE, sx, 0.125, 96.15);
      bx(yd, 6, 0.70, 0.9, C_PAVE, sx, 0.30, 97.05);
    }
    /* Навес: 6 колонн + кровля с фризом. Колонны слиты в общий буфер —
       для разовой статики merge дешевле InstancedMesh (0 доп. draw call вместо 1). */
    for (let k = 0; k < 6; k++) {
      const x = CX - 19 + k * 7.6;
      yd.push({ g: new THREE.CylinderGeometry(0.2, 0.26, 4.3, 8).translate(x, PLAT_TOP + 2.15, PLAT_Z), c: C_MET });
    }
    bx(yd, 40, 0.35, 7.2, C_MET, CX, 5.475, PLAT_Z);
    for (const sz of [-3.6, 3.6]) bx(yd, 40, 0.5, 0.2, C_TRIM, CX, 5.2, PLAT_Z + sz);
    for (let k = 0; k < 5; k++) bx(gw, 0.6, 0.22, 0.6, 0xffeec0, CX - 18 + k * 9, 5.2, PLAT_Z);  // плафоны
    /* Касса и багаж на перроне */
    bx(yd, 3.2, 2.6, 2.4, 0xd0c4a4, 170, PLAT_TOP + 1.3, 100.6);
    bx(yd, 0.1, 1.0, 1.4, C_GLASS, 168.35, PLAT_TOP + 1.7, 100.6);
    bx(yd, 3.6, 0.2, 2.8, C_ROOF, 170, PLAT_TOP + 2.7, 100.6);
    for (const [lx, lz, lh] of [[164, 99.4, 0.5], [164.9, 99.6, 0.35], [151, 102.8, 0.45]]) {
      bx(yd, 0.9, lh, 0.6, 0x8a6a44, lx, PLAT_TOP + lh / 2, lz);
    }
    /* Три пути: балласт + шпалы + рельсовые нити (было 3 плоские плиты = 3 draw call) */
    for (const tz of TRACK_Z) {
      bx(yd, 90, 0.30, 3.0, C_BALLAST, CX, 0.10, tz);                      // -0.05..0.25
      for (let x = 118; x <= 202; x += 2.2) {
        if (Math.abs(x - 128) < 7.5 || Math.abs(x - 192) < 7.5) continue;  // проезжая часть — шпал нет
        bx(yd, 0.32, 0.10, 2.5, C_SLEEP, x, 0.30, tz);                     // 0.25..0.35
      }
      for (const off of [-0.6, 0.6]) bx(yd, 90, 0.10, 0.12, C_RAIL, CX, 0.40, tz + off);  // 0.35..0.45
    }
    /* Выходной светофор у первого пути */
    yd.push({ g: new THREE.CylinderGeometry(0.16, 0.2, 5.0, 6).translate(184.5, 2.5, 105.0), c: C_MET });
    bx(yd, 0.55, 1.6, 0.45, 0x2a2c30, 184.5, 5.6, 105.0);
    bx(yd, 0.34, 0.34, 0.12, 0x1a1c20, 184.5, 5.15, 104.78);               // погашенная линза
    rd.push(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 8).rotateX(Math.PI / 2).translate(184.5, 5.95, 104.78));

    /* ================= 3. Состав: тепловоз + 2 вагона ================= */
    const bufs = { body: [], glow: gw, head: hd, red: rd };
    this._stationVehicle(bufs, 145, TRACK_Z[0], RAIL_Y, 14, 'loco');
    this._stationVehicle(bufs, 160, TRACK_Z[0], RAIL_Y, 14, 'car');
    this._stationVehicle(bufs, 175, TRACK_Z[0], RAIL_Y, 14, 'tail');

    /* ================= 4. Меши ================= */
    this.scene.add(new THREE.Mesh(mergeColored(st), matVC));
    this.scene.add(new THREE.Mesh(mergeColored(yd), matVC));
    this.scene.add(new THREE.Mesh(mergeColored(bufs.body), matVC));
    this.scene.add(new THREE.Mesh(mergeColored(gw), matGlow));
    this.scene.add(new THREE.Mesh(mergeGeoms(hd), matHead));
    this.scene.add(new THREE.Mesh(mergeGeoms(rd), matRed));

    /* Четыре циферблата — InstancedMesh (текстуру нельзя слить в vertexColors-буфер) */
    const clockTex = this._clockTexture();
    const clockMesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(2.6, 20),
      new THREE.MeshBasicMaterial({ map: clockTex }), 4);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const one = new THREE.Vector3(1, 1, 1), pv = new THREE.Vector3();
    [[CX, CZ + 4.85, 0], [CX, CZ - 4.85, Math.PI],
     [CX + 4.85, CZ, Math.PI / 2], [CX - 4.85, CZ, -Math.PI / 2]].forEach((f, i) => {
      e.set(0, f[2], 0); q.setFromEuler(e);
      pv.set(f[0], 19.0, f[1]);
      m4.compose(pv, q, one);
      clockMesh.setMatrixAt(i, m4);
    });
    this.scene.add(clockMesh);

    /* Вывески: «ПЯТИГОРСК» на перрон, «ВОКЗАЛ» на город */
    const signMat = (text, key) => {
      const tex = this._signTexture(text, key);
      return new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 });
    };
    const signPlat = new THREE.Mesh(new THREE.PlaneGeometry(11, 1.5), signMat('ПЯТИГОРСК', 'sign_pyatigorsk'));
    signPlat.position.set(CX, 8.7, 91.12);
    this.scene.add(signPlat);
    const signStreet = new THREE.Mesh(new THREE.PlaneGeometry(11, 1.5), signMat('ВОКЗАЛ', 'sign_vokzal'));
    signStreet.position.set(CX, 8.7, 72.88);
    signStreet.rotation.y = Math.PI;
    this.scene.add(signStreet);

    /* Полосатый козырёк над городским входом (тот же хелпер, что у рынка) */
    const awn = new THREE.Mesh(new THREE.BoxGeometry(10, 0.3, 2.8),
      new THREE.MeshLambertMaterial({ map: this._stripedTexture('#2c6e49', '#f0efe4') }));
    awn.position.set(CX, 5.6, 71.5);
    this.scene.add(awn);

    /* Скамьи на перроне — переиспользуем _bench() (4-й аргумент: высота платформы) */
    this._bench(148, 99.6, 0, PLAT_TOP);
    this._bench(160, 99.6, 0, PLAT_TOP);
    this._bench(172, 99.6, 0, PLAT_TOP);

    /* ================= 5. Коллизии и миникарта ================= */
    this.buildings.push({ x0: 132, z0: 73, x1: 188, z1: 91, h: 15.4, mesh: b });
    this.buildings.push({ x0: 155.5, z0: 77.5, x1: 164.5, z1: 86.5, h: 26, mesh: tower });
    // Перрон под навесом — единый AABB (дешевле, чем 6 AABB под колонны:
    // player.js перебирает propsAABB линейно каждый кадр).
    // Северная граница 97.4 — точка высадки заказа (160, 96) остаётся доступной.
    this.addPropAABB({ x0: 137, z0: 97.4, x1: 183, z1: 104.6 });
    // Состав: тепловоз 138..152, вагоны 153..167 и 168..182 (+ автосцепки и фары)
    this.addPropAABB({ x0: 137.5, z0: 104.4, x1: 182.5, z1: 107.6 });
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
    this.addPropAABB({ x0: cx - 14, z0: cz - 14, x1: cx + 14, z1: cz + 14 });
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

    const tryAddTree = (x, z, type, isPark = false) => {
      // Деревья в кварталах сажаем во дворах/скверах (distToRoad >= 11.5), не на тротуарах и не на дорогах
      if (!isPark && this.distToRoad(x, z) < 11.5) return;
      if (!this.isPositionValid(x, z, 1.8)) return;
      if (this.distToSerp(x, z) < 12) return;   // не на серпантине (полка+откос)
      spots.push({ x, z, type });
      this.addPropAABB({ x0: x - 0.45, z0: z - 0.45, x1: x + 0.45, z1: z + 0.45 }, 2.7);
    };

    for (let bi = 0; bi < 8; bi++) for (let bj = 0; bj < 8; bj++) {
      const dist = this.blockDistrict(bi, bj);
      const sp = this.blockSpecial(bi, bj);
      const r = this.blockRect(bi, bj);
      if (sp === 'rynok') continue; // рынок мощён и обнесён оградой
      let n = { center: 1, kurort: 3, prigorod: 2, sanatorii: 4, mashuk: 3, proval: 8, rynok: 2, vokzal: 3 }[dist] || 2;
      if (sp === 'park') n = 12;
      for (let k = 0; k < n; k++) {
        const x = rng() * 44 + r.x0, z = rng() * 44 + r.z0;
        if (sp === 'park') {
          const dc = dist2D(x, z, -32, 32);
          if (dc < 18) continue;                                            // площадь, клумбы, скамьи
          if (Math.abs(x + 32) < 3.4 || Math.abs(z - 32) < 3.4) continue;   // радиальные дорожки
        }
        tryAddTree(x, z, rng() < 0.75 ? 0 : 1, sp === 'park');
      }
    }
    // опушка Машука и предгорье
    for (let k = 0; k < 70; k++) {
      const x = (rng() - 0.5) * 320, z = -300 - rng() * 200;
      tryAddTree(x, z, rng() < 0.35 ? 0 : 1, true);
    }
    // Окраины и зеленое кольцо за пределами застройки города
    for (let k = 0; k < 280; k++) {
      const a = rng() * Math.PI * 2, dd = 265 + rng() * 140;
      const tx = Math.cos(a) * dd, tz = Math.sin(a) * dd;
      tryAddTree(tx, tz, rng() < 0.65 ? 0 : 1, true);
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
      m4.compose(new THREE.Vector3(sp.x, this.heightAt(sp.x, sp.z) + 0.1, sp.z), q, s);
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
    // offset 9.0 — на внешнем крае тротуара (пешеходы ходят по 8.0, проезжая часть до 6.0)
    const LAMP_OFF = 9.0;
    const Z0 = -224 + 24;

    for (const r of this.roadsV) {
      let side = 1;
      for (let z = Z0; z <= 224 + 24; z += step) {
        const lx = r.c - LAMP_OFF * side;
        if (this.isPositionValid(lx, z, 0.5)) {
          pos.push({ x: lx, z, rot: side === 1 ? 0 : Math.PI, side });
          this.addPropAABB({ x0: lx - 0.2, z0: z - 0.2, x1: lx + 0.2, z1: z + 0.2 });
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
          this.addPropAABB({ x0: x - 0.2, z0: lz - 0.2, x1: x + 0.2, z1: lz + 0.2 });
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

  /* --- Урны и кусты --- */
  _props() {
    // урны: у скамеек, остановок, входов и перекрёстков (не на газоне)
    const binB = new THREE.CylinderGeometry(0.34, 0.4, 0.85, 7);
    binB.translate(0, 0.425, 0);
    const binL = new THREE.CylinderGeometry(0.45, 0.4, 0.12, 7);
    binL.translate(0, 0.89, 0);
    const binGeo = mergeColored([{ g: binB, c: '#ffffff' }, { g: binL, c: '#ffffff' }]);
    const bins = [];

    // Привязываем урны к перекрёсткам и ключевым зонам (оффсет 9.0 м)
    for (const isec of this.intersections) {
      if (this.rng() < 0.45) {
        for (const [ox, oz] of [[9.0, 14.0], [-9.0, -14.0], [14.0, -9.0]]) {
          const bx = isec.x + ox, bz = isec.z + oz;
          if (this.isPositionValid(bx, bz, 0.6)) {
            bins.push(new THREE.Matrix4().makeTranslation(bx, 0.1, bz));
            this.addPropAABB({ x0: bx - 0.5, z0: bz - 0.5, x1: bx + 0.5, z1: bz + 0.5 });
          }
        }
      }
    }
    const binMesh = new THREE.InstancedMesh(binGeo, new THREE.MeshLambertMaterial({ color: 0x7a7a72 }), bins.length);
    bins.forEach((m, i) => binMesh.setMatrixAt(i, m));
    this.scene.add(binMesh);

    // кусты: вдоль границ дворов / зданий (distToRoad 10.5..13м) и в парковых зонах (не на тротуарах и не на дорогах)
    const bushGeo = new THREE.SphereGeometry(0.9, 6, 4);
    const bushes = [];
    for (let bi = 0; bi < 8; bi++) for (let bj = 0; bj < 8; bj++) {
      const sp = this.blockSpecial(bi, bj);
      if (sp === 'rynok') continue;
      const r = this.blockRect(bi, bj);
      const count = sp === 'park' ? 14 : 3;
      for (let k = 0; k < count; k++) {
        const x = r.x0 + 4 + this.rng() * 36;
        const z = r.z0 + 4 + this.rng() * 36;
        if (sp !== 'park' && (this.distToRoad(x, z) < 10.5 || this.distToRoad(x, z) > 13.5)) continue;
        if (!this.isPositionValid(x, z, 1.2)) continue;
        const m4 = new THREE.Matrix4();
        const e2 = new THREE.Euler(0, this.rng() * 6.28, 0);
        const q2 = new THREE.Quaternion().setFromEuler(e2);
        m4.compose(new THREE.Vector3(x, 0.12, z), q2, new THREE.Vector3(1, 0.7, 1));
        bushes.push(m4);
        this.addPropAABB({ x0: x - 1.0, z0: z - 1.0, x1: x + 1.0, z1: z + 1.0 });
      }
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

      // Бетонная площадка под АЗС и асфальтовый заезд от ближайшей дороги.
      // Раньше заправка стояла на голой траве в поле — без асфальта и подъезда
      // к ней (жалоба). Теперь: тёмная площадка 16×12 под навесом + полоса
      // асфальта до кромки ближайшей дороги, как на реальных АЗС.
      // Площадку ужимаем так, чтобы она не наезжала на проезжую часть
      // (бордюр на 10 м от оси дороги): кромка площадки со стороны дороги
      // не ближе 10 м от оси.
      const nearestRoad = this._nearestRoadAxis(x, z);
      const padW = 16, padD = 12;
      let padX0 = x - padW / 2, padX1 = x + padW / 2;
      let padZ0 = z - padD / 2, padZ1 = z + padD / 2;
      if (nearestRoad) {
        const edge = 10; // бордюр от оси
        if (!nearestRoad.horiz) {
          if (x < nearestRoad.c) padX0 = Math.max(padX0, nearestRoad.c - edge + 1);
          else padX1 = Math.min(padX1, nearestRoad.c + edge - 1);
        } else {
          if (z < nearestRoad.c) padZ0 = Math.max(padZ0, nearestRoad.c - edge + 1);
          else padZ1 = Math.min(padZ1, nearestRoad.c + edge - 1);
        }
      }
      const padMat = new THREE.MeshLambertMaterial({ color: 0x3a3f46, roughness: 0.9 });
      const pad = new THREE.Mesh(new THREE.BoxGeometry(padX1 - padX0, 0.12, padZ1 - padZ0), padMat);
      pad.position.set((padX0 + padX1) / 2, 0.04, (padZ0 + padZ1) / 2);
      pad.receiveShadow = true;
      this.scene.add(pad);

      // Полоса заезда от кромки площадки до бордюра дороги
      if (nearestRoad) {
        const roadEdge = nearestRoad.horiz ? nearestRoad.c - Math.sign(nearestRoad.c - z) * 10 : nearestRoad.c - Math.sign(nearestRoad.c - x) * 10;
        const padEdge = nearestRoad.horiz
          ? (z < nearestRoad.c ? padZ0 : padZ1)
          : (x < nearestRoad.c ? padX0 : padX1);
        const stripLen = Math.abs(roadEdge - padEdge);
        const stripMat = new THREE.MeshLambertMaterial({ color: 0x3a3f46, roughness: 0.9 });
        let strip;
        if (nearestRoad.horiz) {
          strip = new THREE.Mesh(new THREE.BoxGeometry(5, 0.1, stripLen), stripMat);
          strip.position.set(x, 0.05, (roadEdge + padEdge) / 2);
        } else {
          strip = new THREE.Mesh(new THREE.BoxGeometry(stripLen, 0.1, 5), stripMat);
          strip.position.set((roadEdge + padEdge) / 2, 0.05, z);
        }
        strip.receiveShadow = true;
        this.scene.add(strip);
      }

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
      // коллайдеры: 2 опоры навеса (solid) и колонка (solid до 1.5м)
      for (const sx of [-3.4, 3.4]) {
        this.addPropAABB({ x0: x + sx - 0.3, z0: z - 0.3, x1: x + sx + 0.3, z1: z + 0.3 }, 3.2);
      }
      this.addPropAABB({ x0: x - 0.8, z0: z + 1.2, x1: x + 0.8, z1: z + 2.4 }, 1.5);
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
      spr.scale.set(4, 2, 1);
      spr.position.set(x, 5.6, z);
      this.scene.add(spr);
    }
  }



  /* --- Канатная дорога на Машук --- */
  _cableCar() {
    // +8 (не +4) — прямая линия троса иначе слегка задевает 1-й траверс серпантина у подошвы горы
    const base = new THREE.Vector3(20, this.heightAt(20, -288) + 8, -288);
    const top = new THREE.Vector3(this.hill.x, this.heightAt(this.hill.x, this.hill.z) + 12, this.hill.z);
    const dir = new THREE.Vector3().subVectors(top, base);
    const len = dir.length();
    const dirN = dir.clone().normalize();

    // материалы
    const cableMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });
    const towerMat = new THREE.MeshLambertMaterial({ color: 0x8a6a44 });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x4a3a2a });
    const stationMat = new THREE.MeshLambertMaterial({ color: 0xc8b898 });

    // Точки крепления тросов на опорах (по линии base→top)
    // Каждая опора: { t (0..1), height (высота головы опоры над землёй) }
    const towerTs = [0.0, 0.28, 0.55, 0.78, 1.0]; // включая базу и вершину
    const towerHeads = []; // позиции голов опор для крепления тросов

    for (let i = 0; i < towerTs.length; i++) {
      const t = towerTs[i];
      const p = new THREE.Vector3().lerpVectors(base, top, t);
      const groundY = this.heightAt(p.x, p.z);

      if (i === 0) {
        // Нижняя станция — здание, трос крепится к крыше
        const st = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 8), stationMat);
        st.position.set(p.x, groundY + 3, p.z);
        this.scene.add(st);
        // крыша-платформа
        const roof = new THREE.Mesh(new THREE.BoxGeometry(8, 0.4, 6), darkMat);
        roof.position.set(p.x, groundY + 6.2, p.z);
        this.scene.add(roof);
        this.addPropAABB({ x0: p.x - 5, z0: p.z - 4, x1: p.x + 5, z1: p.z + 4 });
        towerHeads.push(new THREE.Vector3(p.x, groundY + 6.4, p.z));
        continue;
      }

      if (i === towerTs.length - 1) {
        // Верхняя станция — площадка на вершине Машука
        const plat = new THREE.Mesh(new THREE.BoxGeometry(6, 0.5, 6), darkMat);
        plat.position.set(p.x, groundY + 0.3, p.z);
        this.scene.add(plat);
        towerHeads.push(new THREE.Vector3(p.x, groundY + 0.6, p.z));
        continue;
      }

      // Промежуточная опора: А-образная конструкция
      const towerH = Math.max(6, p.y - groundY + 2);
      const baseW = 2.2; // ширина основания
      // две ноги (наклонные)
      for (const sx of [-1, 1]) {
        const legGeo = new THREE.CylinderGeometry(0.12, 0.18, towerH, 6);
        // наклон ноги: основание на ±baseW, верх на ±0.3
        const bx = p.x + sx * baseW;
        const tx = p.x + sx * 0.3;
        const midX = (bx + tx) / 2;
        const legDir = new THREE.Vector3(tx - bx, towerH, 0);
        const leg = new THREE.Mesh(legGeo, towerMat);
        leg.position.set(midX, groundY + towerH / 2, p.z);
        leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), legDir.clone().normalize());
        this.scene.add(leg);
      }
      // поперечина (горизонтальная перекладина на верхушке)
      const cross = new THREE.Mesh(new THREE.BoxGeometry(baseW * 2 + 0.6, 0.3, 0.4), darkMat);
      cross.position.set(p.x, groundY + towerH, p.z);
      this.scene.add(cross);
      // голова опоры — точки крепления тросов
      towerHeads.push(new THREE.Vector3(p.x, groundY + towerH + 0.2, p.z));
    }

    // Тросы: два параллельных, крепятся к головам опор
    // Трос идёт не по прямой base→top, а по ломаной через головы опор
    for (const off of [-1.4, 1.4]) {
      for (let i = 0; i < towerHeads.length - 1; i++) {
        const a = towerHeads[i].clone();
        const b = towerHeads[i + 1].clone();
        // смещение перпендикулярно линии троса
        const perpX = -dirN.z * off;
        const perpZ = dirN.x * off;
        a.x += perpX; a.z += perpZ;
        b.x += perpX; b.z += perpZ;
        const segLen = a.distanceTo(b);
        const segDir = new THREE.Vector3().subVectors(b, a).normalize();
        const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, segLen, 5), cableMat);
        const mid = new THREE.Vector3().lerpVectors(a, b, 0.5);
        cable.position.copy(mid);
        cable.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), segDir);
        this.scene.add(cable);
      }
    }

    // Кабинки: подвешены к тросу на подвесе (тонкая тяга + корпус)
    // Сохраняем в this.cableCars для анимации в update()
    this.cableCars = [];
    for (const t0 of [0.20, 0.55]) {
      const cab = this._buildCableCarCab();
      this.scene.add(cab);
      this.cableCars.push({ group: cab, t: t0, speed: 0.012, dir: 1 });
    }
    // сохраняем головы опор для позиционирования кабинок в update()
    this._cableHeads = towerHeads;
    this._cableBase = base;
    this._cableTop = top;
  }

  /* Сборка кабинки фуникулёра: корпус + подвес + ролик */
  _buildCableCarCab() {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0xe86030 });
    const glassMat = new THREE.MeshLambertMaterial({ color: 0x4a6a8a, transparent: true, opacity: 0.6 });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });

    // корпус
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 1.6), bodyMat);
    body.position.y = 0;
    g.add(body);
    // окна (по бокам)
    for (const sx of [-1, 1]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.7, 1.2), glassMat);
      win.position.set(sx * 0.92, 0.1, 0);
      g.add(win);
    }
    // крыша
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.2, 1.8), darkMat);
    roof.position.y = 0.8;
    g.add(roof);
    // подвес — вертикальная тяга от крыши вверх к тросу
    const hanger = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.8, 0.1), darkMat);
    hanger.position.y = 1.8;
    g.add(hanger);
    // ролик (зажим на тросе)
    const clamp = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.4, 8), darkMat);
    clamp.rotation.z = Math.PI / 2;
    clamp.position.y = 2.7;
    g.add(clamp);

    return g;
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
        this.addPropAABB({ x0: sx - 0.4, z0: sz - 0.4, x1: sx + 0.4, z1: sz + 0.4 });
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

  /* --- Скамьи на тротуарах курортных/центральных районов ---
     Оффсет 9.2, а не 8.5 (как у фонарей/урн): пешеходы ходят по 8.0
     (см. peds.js), край тротуара — 10.0, так скамья не режет полосу
     пешеходов и не съезжает на газон. Вызывается после _signs() —
     фонари/урны/знаки/светофоры уже в propsAABB и учтены isPositionValid. */
  _streetBenches() {
    const OFF = 9.2;
    const OK = { kurort: 1, sanatorii: 1, vokzal: 1, center: 1 };
    const parts = [];
    const put = (x, z, rot) => {
      const bi = clamp(Math.floor((x + 256) / CFG.CELL), 0, 7);
      const bj = clamp(Math.floor((z + 256) / CFG.CELL), 0, 7);
      if (!OK[this.blockDistrict(bi, bj)]) return;
      if (this.rng() > 0.45) return;
      if (!this.isPositionValid(x, z, 1.4)) return;
      this._bench(x, z, rot, 0.12, parts);          // AABB регистрирует сам _bench()
    };
    let side = 1;
    // шаг 64 от −184: точки не совпадают с pickupPoints (те кратны 48 от −208)
    for (const r of this.roadsV) {
      for (let z = -184; z <= 184; z += 64) {
        side = -side;
        put(r.c + OFF * side, z, -side * Math.PI / 2);   // лицом (локальный +z) к дороге
      }
    }
    for (const r of this.roadsH) {
      for (let x = -184; x <= 184; x += 64) {
        side = -side;
        put(x, r.c + OFF * side, side > 0 ? Math.PI : 0);
      }
    }
    if (parts.length) this.scene.add(new THREE.Mesh(mergeColored(parts), this._vcMat()));
  }

  /* --- Вазоны с цветами на тротуарах --- */
  _planters() {
    const OFF = 9.2;
    const DENS = { kurort: 0.45, sanatorii: 0.40, center: 0.35, vokzal: 0.25,
                   rynok: 0.20, proval: 0.15, prigorod: 0.08, mashuk: 0 };
    const parts = [];
    const put = (x, z, rot) => {
      const bi = clamp(Math.floor((x + 256) / CFG.CELL), 0, 7);
      const bj = clamp(Math.floor((z + 256) / CFG.CELL), 0, 7);
      if (this.rng() > (DENS[this.blockDistrict(bi, bj)] || 0)) return;
      if (!this.isPositionValid(x, z, 0.7)) return;
      this._planter(parts, x, z, rot, PK_FLOWERS[(this.rng() * PK_FLOWERS.length) | 0]);
    };
    let side = 1;
    for (const r of this.roadsV) {
      for (let z = -190; z <= 190; z += 40) { side = -side; put(r.c + OFF * side, z, this.rng() * 0.8); }
    }
    for (const r of this.roadsH) {
      for (let x = -190; x <= 190; x += 40) { side = -side; put(x, r.c + OFF * side, this.rng() * 0.8); }
    }
    if (parts.length) this.scene.add(new THREE.Mesh(mergeColored(parts), this._vcMat()));
  }

  /* --- Светофоры на перекрёстках (каждый второй: 1,3,5,7) --- */
  /* --- Светофоры на перекрёстках (каждый второй: 1,3,5,7) --- */
  _trafficLights() {
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x484a4c });
    const housMat = new THREE.MeshLambertMaterial({ color: 0x1c1c1e });

    // 1. Детализированный столб (бетонный фундамент, юбка, столб, кронштейны, крышка)
    const baseG = new THREE.CylinderGeometry(0.28, 0.32, 0.35, 8);
    baseG.translate(0, 0.175, 0);

    const collarG = new THREE.CylinderGeometry(0.20, 0.24, 0.3, 8);
    collarG.translate(0, 0.45, 0);

    const mainPoleG = new THREE.CylinderGeometry(0.12, 0.17, 4.1, 8);
    mainPoleG.translate(0, 2.55, 0);

    const armG = new THREE.BoxGeometry(0.12, 0.12, 0.35);
    armG.translate(0, 4.3, 0.175);

    const capG = new THREE.CylinderGeometry(0.14, 0.14, 0.1, 8);
    capG.translate(0, 4.65, 0);

    const pedArmG = new THREE.BoxGeometry(0.08, 0.08, 0.25);
    pedArmG.translate(0, 2.3, 0.125);

    const poleGeo = mergeGeoms([baseG, collarG, mainPoleG, armG, capG, pedArmG]);

    // 2. Детализированный корпус (ящик, задний щит, 3 оправы + 3 козырька, корпус пешеходного светофора + 2 козырька)
    const housParts = [];

    const bodyG = new THREE.BoxGeometry(0.50, 1.60, 0.26);
    bodyG.translate(0, 4.2, 0.28);
    housParts.push(bodyG);

    const plateG = new THREE.BoxGeometry(0.62, 1.72, 0.03);
    plateG.translate(0, 4.2, 0.14);
    housParts.push(plateG);

    for (let k = 0; k < 3; k++) {
      const y = 4.7 - k * 0.5;
      const bezG = new THREE.CylinderGeometry(0.21, 0.21, 0.04, 12);
      bezG.rotateX(Math.PI / 2);
      bezG.translate(0, y, 0.41);
      housParts.push(bezG);

      const visorG = new THREE.BoxGeometry(0.44, 0.05, 0.22);
      visorG.rotateX(0.22);
      visorG.translate(0, y + 0.19, 0.48);
      housParts.push(visorG);
    }

    const pedBodyG = new THREE.BoxGeometry(0.28, 0.60, 0.18);
    pedBodyG.translate(0, 2.3, 0.22);
    housParts.push(pedBodyG);

    const pedPlateG = new THREE.BoxGeometry(0.34, 0.66, 0.02);
    pedPlateG.translate(0, 2.3, 0.12);
    housParts.push(pedPlateG);

    for (let k = 0; k < 2; k++) {
      const y = k === 0 ? 2.48 : 2.12;
      const pedBezG = new THREE.CylinderGeometry(0.12, 0.12, 0.04, 12);
      pedBezG.rotateX(Math.PI / 2);
      pedBezG.translate(0, y, 0.31);
      housParts.push(pedBezG);

      const pedVisorG = new THREE.BoxGeometry(0.26, 0.04, 0.16);
      pedVisorG.rotateX(0.22);
      pedVisorG.translate(0, y + 0.13, 0.35);
      housParts.push(pedVisorG);
    }

    const housGeo = mergeGeoms(housParts);

    // 3. Выпуклые линзы ламп (автомобильные 3шт + пешеходные 2шт)
    const lampGeo = new THREE.SphereGeometry(0.18, 12, 10);
    const pedLampGeo = new THREE.SphereGeometry(0.09, 10, 8);

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
        this.addPropAABB({ x0: sp.x - 0.4, z0: sp.z - 0.4, x1: sp.x + 0.4, z1: sp.z + 0.4 });
      }
    }

    const polesMesh = new THREE.InstancedMesh(poleGeo, poleMat, corners.length);
    const housMesh = new THREE.InstancedMesh(housGeo, housMat, corners.length);
    const lampsMesh = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), corners.length * 3);
    const pedLampMesh = new THREE.InstancedMesh(pedLampGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), corners.length * 2);

    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1);
    const posVec = new THREE.Vector3();

    corners.forEach((sp, idx) => {
      const rotY = sp.axis === 'z' ? 0 : Math.PI / 2;
      e.set(0, rotY, 0); q.setFromEuler(e);
      const hy = this.heightAt(sp.x, sp.z);
      posVec.set(sp.x, hy, sp.z);
      m4.compose(posVec, q, s);
      polesMesh.setMatrixAt(idx, m4);
      housMesh.setMatrixAt(idx, m4);

      for (let k = 0; k < 3; k++) {
        const lampIdx = idx * 3 + k;
        const localPos = new THREE.Vector3(0, 4.7 - k * 0.5, 0.40);
        localPos.applyQuaternion(q);
        localPos.add(posVec);
        m4.compose(localPos, q, s);
        lampsMesh.setMatrixAt(lampIdx, m4);
        lampsMesh.setColorAt(lampIdx, new THREE.Color(TRAFFIC_LIGHT_DARK[k]));
      }

      for (let k = 0; k < 2; k++) {
        const pedIdx = idx * 2 + k;
        const localPedPos = new THREE.Vector3(0, k === 0 ? 2.48 : 2.12, 0.30);
        localPedPos.applyQuaternion(q);
        localPedPos.add(posVec);
        m4.compose(localPedPos, q, s);
        pedLampMesh.setMatrixAt(pedIdx, m4);
        pedLampMesh.setColorAt(pedIdx, new THREE.Color(k === 0 ? 0x3a1010 : 0x103a10));
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
    this.scene.add(pedLampMesh);
    this.trafficLampMesh = lampsMesh;
    this.pedLampMesh = pedLampMesh;
  }

  /* --- Остановки общественного транспорта --- */
  _busStops() {
    const glassMat = new THREE.MeshLambertMaterial({ color: 0x4a7fa8, transparent: true, opacity: 0.6 });
    const metalMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3c });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x2e4a62 });
    const parts = [];

    const placeBusStop = (x, z, rotY) => {
      if (!this.isPositionValid(x, z, 1.4)) return;
      const shelter = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.12, 2.0), roofMat);
      shelter.position.set(x, 2.4, z); shelter.rotation.y = rotY;
      this.scene.add(shelter);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(3.8, 2.2, 0.08), glassMat);
      const wx = x + Math.sin(rotY) * (-0.9);
      const wz = z + Math.cos(rotY) * (-0.9);
      wall.position.set(wx, 1.1, wz);
      wall.rotation.y = rotY;
      this.scene.add(wall);

      // Скамейка внутри навеса (AABB скамейки регистрирует сам _bench)
      this._bench(x, z, rotY, 0.12, parts);

      // Задняя стенка (solid)
      const isAlongX = Math.abs(Math.cos(rotY)) > 0.5;
      if (isAlongX) {
        this.addPropAABB({ x0: wx - 2.0, z0: wz - 0.15, x1: wx + 2.0, z1: wz + 0.15 });
      } else {
        this.addPropAABB({ x0: wx - 0.15, z0: wz - 2.0, x1: wx + 0.15, z1: wz + 2.0 });
      }

      // Навес (overhead, y=2.4)
      this.addPropAABB(this._rotRect(x, z, rotY, 4.2, 2.2), 2.4);
    };

    const stopLocations = [
      { x: -55, z: -18, rotY: Math.PI / 2 },
      { x: 55, z: 18, rotY: -Math.PI / 2 },
      { x: 120, z: 55, rotY: 0 },
      { x: 73, z: -18, rotY: Math.PI / 2 },
      { x: -18, z: 73, rotY: Math.PI },
      { x: 18, z: -120, rotY: 0 },
    ];

    for (const loc of stopLocations) {
      placeBusStop(loc.x, loc.z, loc.rotY);
    }
    if (parts.length) this.scene.add(new THREE.Mesh(mergeColored(parts), this._vcMat()));
  }

  /* --- Мусорные контейнеры у домов --- */
  _wasteBins() {
    const padMat = new THREE.MeshLambertMaterial({ color: 0x8a8a82 });
    const binMat1 = new THREE.MeshLambertMaterial({ color: 0x2e6a3e });
    const binMat2 = new THREE.MeshLambertMaterial({ color: 0x2e4a6a });
    const fenceMat = new THREE.MeshLambertMaterial({ color: 0x5a5a54 });

    for (let bi = 0; bi < 8; bi++) {
      for (let bj = 0; bj < 8; bj++) {
        const dist = this.blockDistrict(bi, bj);
        if (dist === 'mashuk' || dist === 'proval' || this.blockSpecial(bi, bj)) continue;
        const r = this.blockRect(bi, bj);
        const x = r.x0 + 12 + (bi % 2) * 16;
        const z = r.z0 + 12 + (bj % 2) * 16;
        if (this.distToRoad(x, z) < 11.5) continue;
        if (!this.isPositionValid(x, z, 1.5)) continue;

        const pad = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.1, 2.2), padMat);
        pad.position.set(x, 0.05, z);
        this.scene.add(pad);

        for (const [ox, mat] of [[-0.7, binMat1], [0.7, binMat2]]) {
          const dumpster = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.1, 0.9), mat);
          dumpster.position.set(x + ox, 0.6, z);
          this.scene.add(dumpster);
        }

        const f1 = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.2, 0.1), fenceMat);
        f1.position.set(x, 0.6, z - 1.1);
        const f2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 2.2), fenceMat);
        f2.position.set(x - 1.65, 0.6, z);
        const f3 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 2.2), fenceMat);
        f3.position.set(x + 1.65, 0.6, z);
        this.scene.add(f1, f2, f3);

        this.addPropAABB({ x0: x - 1.8, z0: z - 1.3, x1: x + 1.8, z1: z + 1.3 });
      }
    }
  }

  /* --- Торговые киоски (Печать, Нарзан, Мороженое) --- */
  _kiosks() {
    const spots = [
      { x: 170, z: 80, text: 'ПЕЧАТЬ', color: 0x2a5ad8 },
      { x: -50, z: -18, text: 'НАРЗАН', color: 0x2a8a50 },
      { x: 96, z: -96, text: 'МОРОЖЕНОЕ', color: 0xd88a2a },
      { x: -18, z: -50, text: 'ПРЕССА', color: 0xc83a2a },
      { x: 36, z: 100, text: 'СУВЕНИРЫ', color: 0x8a3ad8 },
    ];

    for (const sp of spots) {
      // Киоск не должен стоять вплотную к дороге — иначе он перекрывает угол
      // перекрёстка и мешает проезду (см. СУВЕНИРЫ на (50,120): 8 м от дороги).
      // Держим киоски в глубине квартала, минимум в 12 м от оси дороги.
      if (this.distToRoad(sp.x, sp.z) < 12) continue;
      if (!this.isPositionValid(sp.x, sp.z, 1.5)) continue;

      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.5, 2.0), new THREE.MeshLambertMaterial({ color: 0xe8e4dc }));
      body.position.y = 1.25; g.add(body);

      const win = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 0.1), new THREE.MeshBasicMaterial({ color: 0xffea9f }));
      win.position.set(0, 1.4, 1.01); g.add(win);

      const awn = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.1, 0.8), new THREE.MeshLambertMaterial({ color: sp.color }));
      awn.position.set(0, 2.0, 1.3); g.add(awn);

      const signTex = this._signTexture(sp.text, 'kiosk_' + sp.text, '#1b2a3a', '#f2ead6');
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.5), new THREE.MeshBasicMaterial({ map: signTex }));
      sign.position.set(0, 2.35, 1.02); g.add(sign);

      g.position.set(sp.x, 0, sp.z);
      this.scene.add(g);
      // Корпус киоска (solid)
      this.addPropAABB({ x0: sp.x - 1.35, z0: sp.z - 1.05, x1: sp.x + 1.35, z1: sp.z + 1.05 });
      // Козырёк (overhead, y=2.0)
      this.addPropAABB({ x0: sp.x - 1.25, z0: sp.z + 0.9, x1: sp.x + 1.25, z1: sp.z + 1.75 }, 2.0);
    }
  }

  /* --- Детские площадки в жилых кварталах --- */
  _playgrounds() {
    const spots = [
      { x: -140, z: 140 },
      { x: 140, z: -140 },
      { x: -140, z: -140 },
      { x: 140, z: 140 },
    ];

    for (const sp of spots) {
      if (this.distToRoad(sp.x, sp.z) < 14) continue;
      if (!this.isPositionValid(sp.x, sp.z, 3.2)) continue;

      const g = new THREE.Group();
      const sand = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.25, 3.0), new THREE.MeshLambertMaterial({ color: 0xd8c880 }));
      sand.position.set(-1.5, 0.125, -1.5); g.add(sand);

      const slideMat = new THREE.MeshLambertMaterial({ color: 0xd83a2a });
      const slide = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.8, 2.4), slideMat);
      slide.position.set(1.8, 0.9, 1.0); g.add(slide);

      const swingMat = new THREE.MeshLambertMaterial({ color: 0x2a7ad8 });
      const frame = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.2, 0.1), swingMat);
      frame.position.set(-1.0, 1.1, 1.8); g.add(frame);

      g.position.set(sp.x, 0, sp.z);
      this.scene.add(g);
      // Песочница (solid, низкий бортик 0.3м)
      this.addPropAABB({ x0: sp.x - 3.1, z0: sp.z - 3.1, x1: sp.x + 0.1, z1: sp.z + 0.1 }, 0.3);
      // Горка (solid, h=1.8м)
      this.addPropAABB({ x0: sp.x + 1.35, z0: sp.z - 0.25, x1: sp.x + 2.25, z1: sp.z + 2.25 }, 1.8);
      // Качели (solid рама, h=2.2м)
      this.addPropAABB({ x0: sp.x - 2.25, z0: sp.z + 1.65, x1: sp.x + 0.25, z1: sp.z + 1.95 }, 2.2);
    }
  }

  /* --- Припаркованные авто на площадках (вокзал, рынок, санатории) --- */
  _parkedCars() {
    const spots = [
      { x: 148, z: 58, rot: 0 },
      { x: 154, z: 58, rot: 0 },
      { x: 160, z: 58, rot: 0 },
      { x: 80, z: -50, rot: Math.PI / 2 },
      { x: 80, z: -45, rot: Math.PI / 2 },
      { x: -110, z: 120, rot: 0 },
      { x: -104, z: 120, rot: 0 },
    ];

    const carCols = [0x3a5ad8, 0xd83a3a, 0x3ad85a, 0xd8d8d8, 0x2a2a2c, 0xd8a02a];
    let colIdx = 0;

    for (const sp of spots) {
      if (!this.isPositionValid(sp.x, sp.z, 1.4)) continue;

      const bodyMat = new THREE.MeshLambertMaterial({ color: carCols[colIdx % carCols.length] });
      colIdx++;
      const car = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.4, 4.2), bodyMat);
      car.position.set(sp.x, 0.7, sp.z);
      car.rotation.y = sp.rot;
      this.scene.add(car);

      this.addPropAABB(this._rotRect(sp.x, sp.z, sp.rot, 2.2, 4.4));
    }
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
    const tempColor = new THREE.Color();

    for (const l of this.lights) {
      // Цикл 16 с:
      // Для оси 'z': 0-6 зелёный (0), 6-8 жёлтый (1), 8-16 красный (2)
      // Для оси 'x': 0-8 красный (2), 8-14 зелёный (0), 14-16 жёлтый (1)
      const t = (((this.time + l.off) % 16) + 16) % 16;
      const oldState = l.state;
      if (l.axis === 'z') l.state = t < 6 ? 0 : t < 8 ? 1 : 2;
      else l.state = t < 8 ? 2 : (t < 14 ? 0 : 1);

      if (oldState !== l.state || !this._lampInit) {
        lampsUpdated = true;
        for (let k = 0; k < 3; k++) {
          const lampIdx = l.idx * 3 + k;
          const isOn = (k === 0 && l.state === 2) || (k === 1 && l.state === 1) || (k === 2 && l.state === 0);
          const colHex = isOn ? TRAFFIC_LIGHT_BRIGHT[k] : TRAFFIC_LIGHT_DARK[k];
          this.trafficLampMesh.setColorAt(lampIdx, tempColor.setHex(colHex));
        }
        if (this.pedLampMesh) {
          for (let k = 0; k < 2; k++) {
            const pedIdx = l.idx * 2 + k;
            // k=0: Красный силуэт пешехода (горит, когда машинам 0 или 1)
            // k=1: Зелёный силуэт пешехода (горит, когда машинам 2 — красный)
            const pedIsOn = (k === 0 && l.state !== 2) || (k === 1 && l.state === 2);
            const pedColHex = pedIsOn ? (k === 0 ? 0xff2222 : 0x22ff44) : (k === 0 ? 0x3a1010 : 0x103a10);
            this.pedLampMesh.setColorAt(pedIdx, tempColor.setHex(pedColHex));
          }
        }
      }
    }
    if (lampsUpdated && this.trafficLampMesh) {
      this.trafficLampMesh.instanceColor.needsUpdate = true;
      if (this.pedLampMesh) this.pedLampMesh.instanceColor.needsUpdate = true;
      this._lampInit = true;
    }

    // Анимация кабинок фуникулёра
    if (this.cableCars && this._cableHeads) {
      // перпендикуляр к линии троса (для бокового смещения кабинки к одному из тросов)
      const cableDir = new THREE.Vector3().subVectors(this._cableTop, this._cableBase).normalize();
      const perp = new THREE.Vector3(-cableDir.z, 0, cableDir.x);
      for (let ci = 0; ci < this.cableCars.length; ci++) {
        const car = this.cableCars[ci];
        car.t += car.dir * car.speed * dt;
        if (car.t >= 0.92) { car.t = 0.92; car.dir = -1; }
        if (car.t <= 0.05) { car.t = 0.05; car.dir = 1; }
        // позиция на ломаной линии через головы опор
        const pos = this._cablePointAt(car.t);
        // боковое смещение к одному из двух тросов (±1.4м)
        const sideOff = ci === 0 ? -1.4 : 1.4;
        // ролик (y=2.7 в локальных координатах) должен быть на тросе → опускаем групп
        car.group.position.set(
          pos.x + perp.x * sideOff,
          pos.y - 2.7,
          pos.z + perp.z * sideOff
        );
        // ориентация кабинки вдоль направления троса
        const next = this._cablePointAt(Math.min(0.99, car.t + 0.01));
        const lookDir = new THREE.Vector3().subVectors(next, pos);
        if (lookDir.lengthSq() > 0.001) {
          car.group.rotation.y = Math.atan2(lookDir.x, lookDir.z);
        }
      }
    }

    // Анимация трамвая по рельсам (ось X, z=0)
    if (this.tram && this.tramAnim) {
      const ta = this.tramAnim;
      ta.pos += ta.dir * ta.speed * dt;
      if (ta.pos > 220) { ta.pos = 220; ta.dir = -1; }
      if (ta.pos < -220) { ta.pos = -220; ta.dir = 1; }
      this.tram.position.x = ta.pos;
    }
  }

  /* Позиция точки на ломаной линии троса (через головы опор) при параметре t (0..1) */
  _cablePointAt(t) {
    const heads = this._cableHeads;
    if (!heads || heads.length < 2) return new THREE.Vector3();
    // общая длина ломаной
    let totalLen = 0;
    const segLens = [];
    for (let i = 0; i < heads.length - 1; i++) {
      const sl = heads[i].distanceTo(heads[i + 1]);
      segLens.push(sl);
      totalLen += sl;
    }
    const target = t * totalLen;
    let acc = 0;
    for (let i = 0; i < segLens.length; i++) {
      if (acc + segLens[i] >= target) {
        const localT = (target - acc) / segLens[i];
        return new THREE.Vector3().lerpVectors(heads[i], heads[i + 1], localT);
      }
      acc += segLens[i];
    }
    return heads[heads.length - 1].clone();
  }
}

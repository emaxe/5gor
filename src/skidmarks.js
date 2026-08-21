/* ============================================================
 * 5GOR — skidmarks.js
 * Резиновые следы шин при заносе/ручнике (визуальный полиш).
 * Кольцевой буфер из квадов — ноль аллокаций после конструктора.
 * Читает уже существующее поле player.slip (интенсивность заноса).
 * ============================================================ */

/* Габариты задней оси по типу кузова (совпадает с CAR_TYPE_SHAPE в player.js) */
const SKID_SHAPE = {
  taxi:     { w: 1.9,  len: 4.3 },
  classic:  { w: 1.85, len: 4.0 },
  comfort:  { w: 1.92, len: 4.25 },
  minivan:  { w: 2.05, len: 4.7 },
  business: { w: 1.95, len: 4.6 },
  sport:    { w: 1.9,  len: 4.35 },
  offroad:  { w: 2.05, len: 4.8 },
};

export class SkidMarks {
  /**
   * @param {THREE.Scene} scene - сцена Three.js
   */
  constructor(scene) {
    this.scene = scene;
    const MAX = CFG.skidMaxSegments;

    // по 2 квада на шаг (левое/правое заднее колесо), 4 вершины × 3 координаты
    this.MAX = MAX;
    this.positions = new Float32Array(MAX * 2 * 4 * 3);
    // индексы заполняются один раз: [b, b+1, b+2, b, b+2, b+3] на квад
    const indices = new Uint16Array(MAX * 2 * 6);
    for (let q = 0; q < MAX * 2; q++) {
      const b = q * 4;
      const o = q * 6;
      indices[o] = b; indices[o + 1] = b + 1; indices[o + 2] = b + 2;
      indices[o + 3] = b; indices[o + 4] = b + 2; indices[o + 5] = b + 3;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2000);

    const mat = new THREE.MeshBasicMaterial({
      color: 0x14161a, transparent: true, opacity: 0.5,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);

    // головной индекс (в вершинах), текущая пара точек колес
    this._head = 0;
    this._hasPrev = false;
    this._plX = 0; this._plZ = 0; this._prX = 0; this._prZ = 0;
  }

  /* Скалярный кэш геометрии задней оси для текущей машины (по carType). */
  _syncShape(player) {
    const s = SKID_SHAPE[player.stats.carType] || SKID_SHAPE.taxi;
    this._halfTrack = s.w * 0.42;      // полуширина колеи задней оси
    this._backOff = -s.len * 0.31;     // задняя ось от центра масс (капсула ~ центр)
  }

  /**
   * Вызывается каждый кадр из game._drive(). Рисует ленту пока машина заносится.
   * @param {object} player - PlayerCar
   * @param {object} world - World (для world.heightAt)
   */
  update(player, world) {
    // гейты: занос достаточно сильный и скорость не «пятнистая»
    if (!player.slip || player.slip < CFG.skidMinSlip) {
      this._hasPrev = false;
      return;
    }
    if (Math.abs(player.speed) < CFG.skidMinSpeed) {
      // держим предыдущую точку (машина крутится на месте — лента не «пульсирует»)
      return;
    }
    this._syncShape(player);

    const h = player.heading;
    const sinH = Math.sin(h), cosH = Math.cos(h);
    // fwd = (sin h, cos h); side = (cos h, -sin h) (как в физике)
    const fwdX = sinH, fwdZ = cosH;
    const sideX = cosH, sideZ = -sinH;
    const bx = player.x + fwdX * this._backOff;
    const bz = player.z + fwdZ * this._backOff;
    const ht = this._halfTrack;
    const curLX = bx + sideX * ht, curLZ = bz + sideZ * ht;
    const curRX = bx - sideX * ht, curRZ = bz - sideZ * ht;

    if (!this._hasPrev) {
      this._plX = curLX; this._plZ = curLZ;
      this._prX = curRX; this._prZ = curRZ;
      this._hasPrev = true;
      return;
    }

    // слишком близко к прошлому сегменту — не плодим квады каждый кадр
    const dx = curLX - this._plX, dz = curLZ - this._plZ;
    if (dx * dx + dz * dz < CFG.skidSegLen * CFG.skidSegLen) return;

    const w = CFG.skidWidth;
    const y = world.heightAt(player.x, player.z) + 0.03; // зазор против z-fighting
    // два квада: левое колесо и правое колесо (prev→cur, ширина w)
    this._writeQuad(this._head, this._plX, this._plZ, this._prX, this._prZ,
      curLX, curLZ, curRX, curRZ, y, w);
    this._head = (this._head + 2) % this.MAX;

    this._plX = curLX; this._plZ = curLZ;
    this._prX = curRX; this._prZ = curRZ;
  }

  /* Записывает два квада (лево/право) в позиции буфера. */
  _writeQuad(head, lx0, lz0, rx0, rz0, lx1, lz1, rx1, rz1, y, w) {
    // левый квад: 4 вершины (prev-left, prev-right, cur-right, cur-left)
    const hl = w * 0.5;
    const base = head * 2 * 4 * 3; // head считаем в квадах (лево+право)
    const P = this.positions;
    // нормаль к оси следа (для ширины)
    // слева: ось между prevL→curL; берём бок = нормализованный перп
    let aX = lx1 - lx0, aZ = lz1 - lz0;
    const al = Math.hypot(aX, aZ) || 1;
    aX /= al; aZ /= al;
    const bxX = -aZ, bxZ = aX; // перпендикуляр
    // вершины левого квада
    P[base] = lx0 + bxX * hl; P[base + 1] = y; P[base + 2] = lz0 + bxZ * hl;
    P[base + 3] = lx0 - bxX * hl; P[base + 4] = y; P[base + 5] = lz0 - bxZ * hl;
    P[base + 6] = lx1 - bxX * hl; P[base + 7] = y; P[base + 8] = lz1 - bxZ * hl;
    P[base + 9] = lx1 + bxX * hl; P[base + 10] = y; P[base + 11] = lz1 + bxZ * hl;
    // правый квад
    const rbase = base + 4 * 3;
    P[rbase] = rx0 + bxX * hl; P[rbase + 1] = y; P[rbase + 2] = rz0 + bxZ * hl;
    P[rbase + 3] = rx0 - bxX * hl; P[rbase + 4] = y; P[rbase + 5] = rz0 - bxZ * hl;
    P[rbase + 6] = rx1 - bxX * hl; P[rbase + 7] = y; P[rbase + 8] = rz1 - bxZ * hl;
    P[rbase + 9] = rx1 + bxX * hl; P[rbase + 10] = y; P[rbase + 11] = rz1 + bxZ * hl;
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }

  /* Разрыв ленты (телепорт). */
  resetTrail() {
    this._hasPrev = false;
  }

  /* Полная очистка (новая смена / эвакуатор). Обнуляем все вершины. */
  clear() {
    this.positions.fill(0);
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this._hasPrev = false;
  }
}

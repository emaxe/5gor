/* ============================================================
 * utils.js — математика, Event Bus, merge геометрий, Canvas-текстуры
 * ============================================================ */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const choice = (arr) => arr[(Math.random() * arr.length) | 0];
const dist2D = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const fmtMoney = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const fmtTime = (min) => `${Math.floor(min / 60)}:${String(Math.floor(min % 60)).padStart(2, '0')}`;
/* Часы из float-часа: 9.5 -> "09:30" */
const fmtClock = (hour) => {
  const h = Math.floor(hour), m = Math.floor((hour - h) * 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
};

/* Выбор с весами из массива [{v, w}] */
function pickWeighted(items) {
  let total = 0;
  for (const it of items) total += it.w;
  let r = Math.random() * total;
  for (const it of items) { r -= it.w; if (r <= 0) return it.v; }
  return items[items.length - 1].v;
}

/* Плавный поворот угла: возвращает a, повёрнутый к b на max(delta) */
function turnToward(a, b, maxDelta) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
}

/* Линейная интерполяция углов по кратчайшей дуге */
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/* --- Event Bus (Observer) --- */
const Events = {
  _m: new Map(),
  on(e, fn) { if (!this._m.has(e)) this._m.set(e, []); this._m.get(e).push(fn); return () => this.off(e, fn); },
  off(e, fn) { const a = this._m.get(e); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
  emit(e, data) { const a = this._m.get(e); if (a) for (const fn of a.slice()) { try { fn(data); } catch (err) { console.error('[event]', e, err); } } },
};

/* --- Canvas хелперы --- */
const _texCache = new Map();
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function canvasToTexture(canvas, key, repeatX = 1, repeatY = 1) {
  if (key && _texCache.has(key)) return _texCache.get(key);
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 1;
  if (key) _texCache.set(key, t);
  return t;
}

/* Текстура окон для здания. wIn,hIn — окна по ширине/высоте, lit — часть светящихся окон */
function makeWindowTexture(palette, wIn, hIn, lit) {
  const key = `win_${palette}_${wIn}_${hIn}_${lit}`;
  if (_texCache.has(key)) return _texCache.get(key);
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  const wall = choice(PALETTES[palette]);
  g.fillStyle = wall; g.fillRect(0, 0, 256, 256);
  const cw = 256 / wIn, ch = 256 / hIn;
  for (let i = 0; i < wIn; i++) for (let j = 0; j < hIn; j++) {
    const on = Math.random() < lit;
    g.fillStyle = on ? (Math.random() < 0.5 ? '#ffe9a8' : '#ffd876') : '#39434f';
    const mx = i * cw + cw * 0.22, my = j * ch + ch * 0.22;
    g.fillRect(mx, my, cw * 0.56, ch * 0.56);
    if (on) { g.fillStyle = 'rgba(255,220,120,0.5)'; g.fillRect(mx + cw * 0.16, my + ch * 0.18, cw * 0.24, ch * 0.2); }
  }
  const t = canvasToTexture(c, key);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* Текстура «шашечек такси» + надпись */
function makeTaxiTexture(colorHex) {
  const key = 'taxi_' + colorHex;
  if (_texCache.has(key)) return _texCache.get(key);
  const c = makeCanvas(512, 256);
  const g = c.getContext('2d');
  g.fillStyle = colorHex; g.fillRect(0, 0, 512, 256);
  // шашечки по низу
  const ch = 44, cw = 44;
  for (let i = 0; i < 12; i++) for (let j = 0; j < 2; j++) {
    if ((i + j) % 2 === 0) { g.fillStyle = '#1a1a1a'; g.fillRect(i * cw, 256 - ch * (j + 1), cw, ch); }
  }
  // надпись TAXI
  g.fillStyle = '#1a1a1a';
  g.font = 'bold 120px Arial';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('TAXI', 256, 105);
  g.strokeStyle = '#1a1a1a'; g.lineWidth = 6;
  g.strokeRect(6, 6, 500, 244);
  const t = canvasToTexture(c, key);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makePlateTexture() {
  const key = 'plate';
  if (_texCache.has(key)) return _texCache.get(key);
  const c = makeCanvas(128, 64);
  const g = c.getContext('2d');
  g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, 128, 64);
  g.strokeStyle = '#333'; g.lineWidth = 4; g.strokeRect(2, 2, 124, 60);
  g.fillStyle = '#222'; g.font = 'bold 34px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('5GOR 126', 64, 34);
  const t = canvasToTexture(c, key);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* Значок-маркер на спрайте (кружок + буква) */
function makeMarkerTexture(bg, letter) {
  const key = 'mk_' + bg + '_' + letter;
  if (_texCache.has(key)) return _texCache.get(key);
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2);
  g.fillStyle = bg; g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = 8; g.stroke();
  g.fillStyle = '#fff'; g.font = 'bold 64px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(letter, 64, 70);
  const t = canvasToTexture(c, key);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* --- Слияние геометрий в одну (с цветами вершин для окрашенных частей) --- */
/* parts: [{g: BufferGeometry, c: color(string|number)}] */
function mergeColored(parts) {
  const pos = [], nor = [], uv = [], col = [], idx = [];
  let off = 0;
  for (const p of parts) {
    const geo = p.g;
    const gp = geo.attributes.position.array;
    const gn = geo.attributes.normal ? geo.attributes.normal.array : null;
    const gu = geo.attributes.uv ? geo.attributes.uv.array : null;
    const cc = new THREE.Color(p.c);
    const count = gp.length / 3;
    if (geo.index) { const gi = geo.index.array; for (let i = 0; i < gi.length; i++) idx.push(gi[i] + off); }
    else for (let i = 0; i < count; i++) idx.push(off + i);
    for (let i = 0; i < gp.length; i++) pos.push(gp[i]);
    if (gn) for (let i = 0; i < gn.length; i++) nor.push(gn[i]);
    else for (let i = 0; i < gp.length; i++) nor.push(0);
    if (gu) for (let i = 0; i < gu.length; i++) uv.push(gu[i]);
    else for (let i = 0; i < count * 2; i++) uv.push(0);
    for (let i = 0; i < count; i++) { col.push(cc.r, cc.g, cc.b); }
    off += count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

function mergeGeoms(geoms) {
  return mergeColored(geoms.map((g) => ({ g, c: '#ffffff' })));
}

/* Генератор псевдослучайных чисел (для повторяемости города) */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Спрайт-молния под маркером (световой столб) */
function makeBeamSprite(color, height) {
  const c = makeCanvas(64, 256);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, color);
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 256);
  const t = canvasToTexture(c, 'beam_' + color + '_' + height);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0.55 }));
  s.scale.set(1.6, height, 1);
  s.position.y = height / 2 + 0.8;
  return s;
}

/* Гуманоид-пешеход из примитивов (торс, голова, ноги, руки с пивотами) —
   используется пешеходами и пассажирами такси */
function buildPedMesh() {
  const skin = choice([0xd8a878, 0x8a5a3a, 0xc89060, 0xa87850, 0xb08058, 0x6a4a30]);
  const cloth = choice([0x4060a0, 0xa04040, 0x409060, 0xa08040, 0x604080, 0x888888, 0xc07830, 0x3090a0]);
  const pants = choice([0x2a2a3a, 0x3a3a4a, 0x4a3a2a, 0x5a5a5a]);
  const hairC = choice([0x1a1a1a, 0x3a2a1a, 0x6a4a2a, 0xd8c8a8, 0x8a2a2a, 0x2a2a4a]);
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
  const g = new THREE.Group();
  // торс
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.68, 0.34), mat(cloth));
  torso.position.y = 1.05;
  g.add(torso);
  // голова + волосы (у большинства)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 6), mat(skin));
  head.position.y = 1.62;
  g.add(head);
  if (Math.random() < 0.75) {
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.27, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(hairC));
    hair.position.y = 1.63;
    g.add(hair);
  }
  // ноги: пивоты в бёдрах (геометрия смещена вниз), со ступнями
  const legGeo = new THREE.BoxGeometry(0.18, 0.75, 0.2);
  legGeo.translate(0, -0.375, 0);
  const shoeGeo = new THREE.BoxGeometry(0.2, 0.12, 0.32);
  shoeGeo.translate(0, -0.77, 0.04);
  const legs = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Group();
    leg.add(new THREE.Mesh(legGeo, mat(pants)));
    leg.add(new THREE.Mesh(shoeGeo, mat(0x202020)));
    leg.position.set(0.13 * s, 1.05, 0);
    g.add(leg);
    legs.push(leg);
  }
  // руки: пивоты в плечах
  const armGeo = new THREE.BoxGeometry(0.15, 0.62, 0.15);
  armGeo.translate(0, -0.31, 0);
  const arms = [];
  for (const s of [-1, 1]) {
    const arm = new THREE.Group();
    arm.add(new THREE.Mesh(armGeo, mat(cloth)));
    arm.position.set(0.39 * s, 1.32, 0);
    g.add(arm);
    arms.push(arm);
  }
  g.userData = { legs, arms };
  return g;
}

/* Коллизия круга с AABB. Возвращает {nx,nz,depth} или null */
function circleAABB(px, pz, r, box) {
  const cx = clamp(px, box.x0, box.x1);
  const cz = clamp(pz, box.z0, box.z1);
  let dx = px - cx, dz = pz - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > r * r) return null;
  const d = Math.sqrt(d2);
  if (d > 1e-6) return { nx: dx / d, nz: dz / d, depth: r - d };
  // центр внутри бокса — выталкиваем по минимальному проникновению
  const l = px - box.x0, rgt = box.x1 - px, t = pz - box.z0, b = box.z1 - pz;
  const m = Math.min(l, rgt, t, b);
  if (m === l) return { nx: -1, nz: 0, depth: r + l };
  if (m === rgt) return { nx: 1, nz: 0, depth: r + rgt };
  if (m === t) return { nx: 0, nz: -1, depth: r + t };
  return { nx: 0, nz: 1, depth: r + b };
}

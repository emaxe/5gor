import * as THREE from 'three';
import { PALETTES } from './config.js';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const choice = (arr) => arr[(Math.random() * arr.length) | 0];
export const dist2D = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
export const fmtMoney = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
export const fmtTime = (min) => `${Math.floor(min / 60)}:${String(Math.floor(min % 60)).padStart(2, '0')}`;
/* Часы из float-часа: 9.5 -> "09:30" */
export const fmtClock = (hour) => {
  const h = Math.floor(hour), m = Math.floor((hour - h) * 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
};

/* Отображение ошибок */
export function showError(err) {
  const el = document.getElementById('err-msg');
  if (el) el.textContent = String(err && err.stack ? err.stack : err);
  const box = document.getElementById('error-screen');
  if (box) box.style.display = 'flex';
}

/* Выбор с весами из массива [{v, w}] */
export function pickWeighted(items) {
  let total = 0;
  for (const it of items) total += it.w;
  let r = Math.random() * total;
  for (const it of items) { r -= it.w; if (r <= 0) return it.v; }
  return items[items.length - 1].v;
}

/* Плавный поворот угла: возвращает a, повёрнутый к b на max(delta) */
export function turnToward(a, b, maxDelta) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
}

/* Линейная интерполяция углов по кратчайшей дуге */
export function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/* --- Event Bus moved to src/eventbus.js --- */


/* --- Canvas хелперы --- */
const _texCache = new Map();
export function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

export function canvasToTexture(canvas, key, repeatX = 1, repeatY = 1) {
  if (key && _texCache.has(key)) return _texCache.get(key);
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 1;
  if (key) _texCache.set(key, t);
  return t;
}

/* Текстура окон для здания. wIn,hIn — окна по ширине/высоте, lit — часть светящихся окон */
export function makeWindowTexture(palette, wIn, hIn, lit) {
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

/* Кеш материалов зданий (окна + крыши) — по ключу, аналогично _texCache */
const _matCache = new Map();

/* Материал стены с окнами, разделяемый между всеми зданиями с одинаковым (palette, cols, rows, lit) */
export function getWindowMaterial(palette, cols, rows, lit) {
  const key = `win_${palette}_${cols}_${rows}_${lit}`;
  if (_matCache.has(key)) return _matCache.get(key);
  const winTex = makeWindowTexture(palette, cols, rows, lit);
  const mat = new THREE.MeshLambertMaterial({ map: winTex });
  mat.emissiveMap = winTex;
  mat.emissive = new THREE.Color(0xffffff);
  mat.emissiveIntensity = 0.04;
  _matCache.set(key, mat);
  return mat;
}

/* Материал крыши, разделяемый между всеми зданиями с одинаковым (palette, baseColorHex) */
export function getRoofMaterial(palette, baseColorHex) {
  const key = `roof_${palette}_${baseColorHex}`;
  if (_matCache.has(key)) return _matCache.get(key);
  const roofC = new THREE.Color(baseColorHex).multiplyScalar(0.62);
  const mat = new THREE.MeshLambertMaterial({ color: roofC });
  _matCache.set(key, mat);
  return mat;
}

/* Текстура «шашечек такси» + надпись */
export function makeTaxiTexture(colorHex) {
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

export function makePlateTexture() {
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
export function makeMarkerTexture(bg, letter) {
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
export function mergeColored(parts) {
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

export function mergeGeoms(geoms) {
  return mergeColored(geoms.map((g) => ({ g, c: '#ffffff' })));
}

/* Генератор псевдослучайных чисел (для повторяемости города) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Спрайт-молния под маркером (световой столб) */
export function makeBeamSprite(color, height) {
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

/* Создание 3D-облака речи над головой пешехода (Canvas Texture Sprite) */
export function makeSpeechSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  
  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(4.2, 1.05, 1.0);
  sprite.position.y = 2.4;
  sprite.visible = false;
  sprite.userData = { texture, canvas, ctx };

  if (text) updateSpeechSprite(sprite, text);
  return sprite;
}

export function updateSpeechSprite(sprite, text) {
  if (!sprite || !sprite.userData || !sprite.userData.canvas) return;
  const { canvas, ctx, texture } = sprite.userData;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!text) {
    sprite.visible = false;
    return;
  }

  // Облако речи (скруглённый прямоугольник с рамкой)
  ctx.fillStyle = 'rgba(15, 20, 28, 0.92)';
  ctx.strokeStyle = '#f2c12e';
  ctx.lineWidth = 3;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(4, 4, 248, 50, 10);
  else ctx.rect(4, 4, 248, 50);
  ctx.fill();
  ctx.stroke();

  // Указатель у низа плашки
  ctx.fillStyle = '#f2c12e';
  ctx.beginPath();
  ctx.moveTo(120, 54);
  ctx.lineTo(136, 54);
  ctx.lineTo(128, 62);
  ctx.closePath();
  ctx.fill();

  // Текст реплики
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const displayText = text.length > 29 ? text.slice(0, 28) + '…' : text;
  ctx.fillText(displayText, 128, 28);

  texture.needsUpdate = true;
  sprite.visible = true;
}

/* Гуманоид-пешеход из примитивов с поддержкой 5 архетипов (гопник, бабушка, бегун, студент, бизнесмен, обычный) */
export function buildPedMesh(archetype) {
  const types = ['gopnik', 'grandma', 'runner', 'student', 'businessman', 'regular'];
  const arch = archetype || choice(types);

  let skin = choice([0xd8a878, 0x8a5a3a, 0xc89060, 0xa87850, 0xb08058, 0x6a4a30]);
  let cloth = choice([0x4060a0, 0xa04040, 0x409060, 0xa08040, 0x604080, 0x888888, 0xc07830, 0x3090a0]);
  let pants = choice([0x2a2a3a, 0x3a3a4a, 0x4a3a2a, 0x5a5a5a]);
  let hairC = choice([0x1a1a1a, 0x3a2a1a, 0x6a4a2a, 0xd8c8a8, 0x8a2a2a, 0x2a2a4a]);
  
  let scaleY = rand(0.92, 1.08);
  let scaleXZ = rand(0.92, 1.08);

  if (arch === 'gopnik') {
    cloth = choice([0x1e222a, 0x1a2e40, 0x2b382b]);
    pants = cloth;
    scaleY = rand(0.95, 1.05);
  } else if (arch === 'grandma') {
    cloth = choice([0x604050, 0x4a5a40, 0x5a4a3a]);
    pants = choice([0x3a2a3a, 0x2a2a2a]);
    scaleY = rand(0.86, 0.94);
    scaleXZ = rand(1.0, 1.12);
  } else if (arch === 'runner') {
    cloth = choice([0xee3322, 0x22ee44, 0xeecc00, 0x00ccee]);
    pants = choice([0x111111, 0x222233]);
    scaleY = rand(1.0, 1.12);
    scaleXZ = rand(0.88, 0.96);
  } else if (arch === 'businessman') {
    cloth = choice([0x1c2430, 0x2a2e36, 0x383430]);
    pants = cloth;
    scaleY = rand(1.0, 1.08);
  } else if (arch === 'student') {
    cloth = choice([0xd86030, 0x3090d8, 0x9040d8]);
    pants = choice([0x3a4a5a, 0x2a2a3a]);
  }

  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
  const g = new THREE.Group();

  // торс
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.68, 0.34), mat(cloth));
  torso.position.y = 1.05;
  g.add(torso);

  // голова + волосы
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 6), mat(skin));
  head.position.y = 1.62;
  g.add(head);

  if (arch !== 'grandma' && arch !== 'gopnik') {
    if (Math.random() < 0.8) {
      const hair = new THREE.Mesh(new THREE.SphereGeometry(0.27, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(hairC));
      hair.position.y = 1.63;
      g.add(hair);
    }
  }

  // Детали архетипов (аксессуары)
  if (arch === 'gopnik') {
    // Кепка-восьмиклинка
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.08, 8), mat(0x1a1a1c));
    cap.position.set(0, 1.76, 0.02);
    g.add(cap);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.16), mat(0x1a1a1c));
    visor.position.set(0, 1.74, 0.24);
    g.add(visor);
  } else if (arch === 'grandma') {
    // Платок на голову
    const scarf = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.7), mat(0xd8a8a8));
    scarf.position.y = 1.63;
    g.add(scarf);
    // Сумка в руке
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.25, 0.12), mat(0x4a3a2a));
    bag.position.set(0.35, 0.9, 0.1);
    g.add(bag);
  } else if (arch === 'runner') {
    // Повязка на лоб
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.06, 8), mat(0xffffff));
    band.position.y = 1.68;
    g.add(band);
  } else if (arch === 'student') {
    // Наушники на ушах
    const hp = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.04, 4, 12, Math.PI), mat(0x222222));
    hp.rotation.x = Math.PI / 2;
    hp.position.set(0, 1.65, 0);
    g.add(hp);
    // Рюкзак на спине
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.45, 0.22), mat(0x205080));
    pack.position.set(0, 1.1, -0.25);
    g.add(pack);
  } else if (arch === 'businessman') {
    // Портфель в руке
    const caseMesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.28, 0.36), mat(0x1a1410));
    caseMesh.position.set(0.38, 0.85, 0.05);
    g.add(caseMesh);
  }

  // ноги
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

  // руки
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

  g.scale.set(scaleXZ, scaleY, scaleXZ);
  g.userData = { legs, arms, archetype: arch };
  return g;
}

/* Коллизия круга с AABB. Возвращает {nx,nz,depth} или null */
export function circleAABB(px, pz, r, box) {
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

/**
 * Проверяет, находится ли точка (x, z) в зоне видимости камеры игрока.
 * @param {number} x - Координата X
 * @param {number} z - Координата Z
 * @param {number} px - Координата X игрока
 * @param {number} pz - Координата Z игрока
 * @param {number} heading - Направление игрока в радианах (0 = +Z)
 * @param {number} maxDist - Максимальная дальность сектора видимости
 * @returns {boolean} true, если точка видна спереди в поле зрения
 */
export function isInPlayerView(x, z, px, pz, heading, maxDist = 135) {
  const dx = x - px;
  const dz = z - pz;
  const dist = Math.hypot(dx, dz);
  if (dist > maxDist) return false;

  const angleToPoint = Math.atan2(dx, dz);
  let angleDiff = angleToPoint - heading;

  while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
  while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

  // Вектор спереди ±75 градусов — перед глазами игрока
  return Math.abs(angleDiff) < (75 * Math.PI / 180);
}

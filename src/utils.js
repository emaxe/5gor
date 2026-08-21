import * as THREE from 'three';
import { PALETTES } from './config.js';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/* Гладкий минимум/максимум (полиномиальный, C¹) — для сопряжения форм рельефа */
export const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
export const smax = (a, b, k) => -smin(-a, -b, k);
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

/* Текстура плафона "ТАКСИ" на крыше (жёлтый фон, тёмная надпись по центру
   каждой из 4 граней короба-плафона — один и тот же кадр на map+emissiveMap) */
export function makeTaxiSignTexture() {
  const key = 'taxiSign';
  if (_texCache.has(key)) return _texCache.get(key);
  const c = makeCanvas(256, 128);
  const g = c.getContext('2d');
  g.fillStyle = '#f2c12e'; g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#1a1a1a'; g.lineWidth = 5; g.strokeRect(4, 4, 248, 120);
  g.fillStyle = '#1a1a1a';
  g.font = 'bold 56px Arial';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('ТАКСИ', 128, 66);
  const t = canvasToTexture(c, key);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* Клетчатая полоса ливреи такси — тянется по борту повторением (RepeatWrapping),
   не зависит от длины кузова конкретной машины */
export function makeCheckerStripTexture() {
  const key = 'checkerStrip';
  if (_texCache.has(key)) return _texCache.get(key);
  const c = makeCanvas(128, 32);
  const g = c.getContext('2d');
  g.fillStyle = '#f2c12e'; g.fillRect(0, 0, 128, 32);
  const cs = 16;
  for (let i = 0; i < 8; i++) {
    if (i % 2 === 0) { g.fillStyle = '#1a1a1a'; g.fillRect(i * cs, 0, cs, 32); }
  }
  const t = canvasToTexture(c, key);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(3, 1);
  return t;
}

/* Декаль-полоса из 2 цветов — по образцу makeCheckerStripTexture(), но
   параметризована (цвета в ключе кэша), иначе смена цвета декали не
   отрисуется — старая текстура возьмётся из кэша по фиксированному ключу */
export function makeStripeDecalTexture(colorA, colorB) {
  const key = 'stripeDecal_' + colorA + '_' + colorB;
  if (_texCache.has(key)) return _texCache.get(key);
  const c = makeCanvas(128, 32);
  const g = c.getContext('2d');
  g.fillStyle = colorA; g.fillRect(0, 0, 128, 32);
  g.fillStyle = colorB;
  g.fillRect(0, 9, 128, 6);
  g.fillRect(0, 17, 128, 6);
  const t = canvasToTexture(c, key);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* Гоночная декаль — широкая центральная полоса с тонкими кантами (фикс.
   цвета, без параметров — один ключ кэша, как у makeCheckerStripTexture) */
export function makeRacingDecalTexture() {
  const key = 'racingDecal';
  if (_texCache.has(key)) return _texCache.get(key);
  const c = makeCanvas(128, 32);
  const g = c.getContext('2d');
  g.fillStyle = '#151515'; g.fillRect(0, 0, 128, 32);
  g.fillStyle = '#ffffff'; g.fillRect(0, 6, 128, 20);
  g.fillStyle = '#c0392b';
  g.fillRect(0, 4, 128, 3);
  g.fillRect(0, 25, 128, 3);
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
  // depthTest: true — облачко речи должно скрываться за зданиями/стенами,
  // а не просвечивать сквозь них (жалоба: видно облачко прохожего за зданием,
  // хотя самого прохожего не видно). Раньше было false — спрайт всегда поверх.
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true });
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

/* Вспомогательные материалы для пешеходов и животных (кеш по цвету — общий
   материал переиспользуется между всеми пешеходами вместо нового на каждый вызов) */
const _pedMatCache = new Map();
function getPedMat(color) {
  if (_pedMatCache.has(color)) return _pedMatCache.get(color);
  const m = new THREE.MeshLambertMaterial({ color });
  _pedMatCache.set(color, m);
  return m;
}

/* Общий материал с vertexColors для слитой статики пешехода (торс/голова/аксессуары,
   ноги) — один материал на всех пешеходов, цвет каждой части задаётся через
   атрибут color в mergeColored (OPT-14) */
let _pedColoredMat = null;
function getPedColoredMat() {
  if (!_pedColoredMat) _pedColoredMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return _pedColoredMat;
}

/* Модель собаки */
export function buildDogMesh() {
  const coat = choice([0xc89040, 0x3a2e2b, 0x8a5a2a, 0xe0d0b0, 0x222222, 0x908070]);
  const mCoat = getPedMat(coat);
  const mSnout = getPedMat(0x1a1a1a);
  const mCollar = getPedMat(choice([0xee2222, 0x2288ee, 0xeecc00, 0x22cc44]));

  const g = new THREE.Group();

  // Туловище
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.35, 0.65), mCoat);
  body.position.y = 0.38;
  g.add(body);

  // Шея и голова
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.52, 0.3);
  
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.3), mCoat);
  head.position.set(0, 0.08, 0.08);
  headGroup.add(head);

  // Мордочка и нос
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.16), mCoat);
  snout.position.set(0, 0.04, 0.26);
  headGroup.add(snout);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), mSnout);
  nose.position.set(0, 0.08, 0.33);
  headGroup.add(nose);

  // Уши (висячие или стоячие)
  const floppyEars = Math.random() < 0.5;
  for (const s of [-1, 1]) {
    const earGeo = floppyEars ? new THREE.BoxGeometry(0.08, 0.16, 0.1) : new THREE.BoxGeometry(0.06, 0.14, 0.06);
    const ear = new THREE.Mesh(earGeo, mCoat);
    if (floppyEars) {
      ear.position.set(s * 0.14, 0.12, 0.04);
    } else {
      ear.position.set(s * 0.1, 0.22, 0.04);
    }
    headGroup.add(ear);
  }

  // Ошейник
  const collar = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.06, 0.26), mCollar);
  collar.position.set(0, 0.0, 0.02);
  headGroup.add(collar);

  g.add(headGroup);

  // Хвост
  const tail = new THREE.Group();
  const tailMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.35, 6), mCoat);
  tailMesh.position.set(0, 0.15, -0.15);
  tailMesh.rotation.x = Math.PI / 3;
  tail.add(tailMesh);
  tail.position.set(0, 0.42, -0.32);
  g.add(tail);

  // Ноги
  const legs = [];
  const legGeo = new THREE.BoxGeometry(0.1, 0.32, 0.1);
  legGeo.translate(0, -0.16, 0);

  const legPositions = [
    [-0.12, 0.32, 0.22],  // пп
    [0.12, 0.32, 0.22],   // лп
    [-0.12, 0.32, -0.22], // пз
    [0.12, 0.32, -0.22]   // лз
  ];

  for (let i = 0; i < 4; i++) {
    const leg = new THREE.Group();
    leg.add(new THREE.Mesh(legGeo, mCoat));
    leg.position.set(legPositions[i][0], legPositions[i][1], legPositions[i][2]);
    g.add(leg);
    legs.push(leg);
  }

  g.scale.set(1.1, 1.1, 1.1);
  g.userData = { legs, head: headGroup, tail, archetype: 'dog', isAnimal: true };
  return g;
}

/* Модель кошки */
export function buildCatMesh() {
  const coat = choice([0x222222, 0xe8e8e8, 0xee8822, 0x888888, 0x554433, 0xd4a359]);
  const mCoat = getPedMat(coat);
  const mPink = getPedMat(0xeeaaab);
  const mEyes = getPedMat(choice([0x22cc44, 0xeecc00, 0x22aacc]));

  const g = new THREE.Group();

  // Туловище
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 0.45), mCoat);
  body.position.y = 0.26;
  g.add(body);

  // Голова
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.36, 0.2);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.18, 0.2), mCoat);
  head.position.set(0, 0.06, 0.04);
  headGroup.add(head);

  // Глазки
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.02), mEyes);
    eye.position.set(s * 0.06, 0.08, 0.15);
    headGroup.add(eye);

    // Стоячие острые ушки
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.1, 4), mCoat);
    ear.position.set(s * 0.07, 0.19, 0.04);
    ear.rotation.y = Math.PI / 4;
    headGroup.add(ear);
  }

  // Носик
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.02), mPink);
  nose.position.set(0, 0.05, 0.15);
  headGroup.add(nose);

  g.add(headGroup);

  // Длинный изогнутый хвост
  const tail = new THREE.Group();
  const tailMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.38, 5), mCoat);
  tailMesh.position.set(0, 0.18, -0.1);
  tailMesh.rotation.x = Math.PI / 4;
  tail.add(tailMesh);
  tail.position.set(0, 0.3, -0.22);
  g.add(tail);

  // Ножки
  const legs = [];
  const legGeo = new THREE.BoxGeometry(0.07, 0.22, 0.07);
  legGeo.translate(0, -0.11, 0);

  const legPositions = [
    [-0.08, 0.22, 0.16],
    [0.08, 0.22, 0.16],
    [-0.08, 0.22, -0.16],
    [0.08, 0.22, -0.16]
  ];

  for (let i = 0; i < 4; i++) {
    const leg = new THREE.Group();
    leg.add(new THREE.Mesh(legGeo, mCoat));
    leg.position.set(legPositions[i][0], legPositions[i][1], legPositions[i][2]);
    g.add(leg);
    legs.push(leg);
  }

  g.scale.set(0.95, 0.95, 0.95);
  g.userData = { legs, head: headGroup, tail, archetype: 'cat', isAnimal: true };
  return g;
}

/* Высота шеи пешехода для вращения головы (пивот) */
const HEAD_PIVOT_Y = 1.42;

/* Гуманоид-пешеход из примитивов с повышенной детализацией и разнообразием */
export function buildPedMesh(archetype) {
  if (archetype === 'dog') return buildDogMesh();
  if (archetype === 'cat') return buildCatMesh();

  const types = ['gopnik', 'grandma', 'runner', 'student', 'businessman', 'tourist', 'child', 'regular',
    'elder', 'mom', 'worker', 'musician', 'nurse'];
  const arch = archetype || choice(types);

  let skin = choice([0xf5d0b0, 0xd8a878, 0x8a5a3a, 0xc89060, 0xa87850, 0xb08058, 0x6a4a30, 0xffdbac, 0xecd0b8, 0x9c6b45, 0x523320]);
  let cloth = choice([0x4060a0, 0xa04040, 0x409060, 0xa08040, 0x604080, 0x888888, 0xc07830, 0x3090a0, 0xe05566, 0x22aa88, 0x2b4c7e, 0x5b6d5b, 0x6e263c, 0xc2a649, 0x4d5d36, 0xd2b48c]);
  let pants = choice([0x2a2a3a, 0x3a3a4a, 0x4a3a2a, 0x5a5a5a, 0x1a2430, 0xd0c0aa, 0x1e3799, 0x2c2c54, 0x384030, 0x484848]);
  let hairC = choice([0x1a1a1a, 0x3a2a1a, 0x6a4a2a, 0xd8c8a8, 0x8a2a2a, 0x2a2a4a, 0x995522, 0xdcdde1, 0x718093, 0xb0885a, 0x4a4a4a]);
  let shoeC = choice([0x202020, 0x111111, 0xeeeeee, 0x5a3a20, 0x3a3a3a, 0x8a4a2a]);

  let scaleY = rand(0.92, 1.08);
  let scaleXZ = rand(0.92, 1.08);

  if (arch === 'gopnik') {
    cloth = choice([0x1e222a, 0x1a2e40, 0x2b382b, 0x111115]);
    pants = cloth;
    scaleY = rand(0.95, 1.05);
  } else if (arch === 'grandma') {
    cloth = choice([0x604050, 0x4a5a40, 0x5a4a3a, 0x703848]);
    pants = choice([0x3a2a3a, 0x2a2a2a]);
    scaleY = rand(0.84, 0.92);
    scaleXZ = rand(1.02, 1.15);
  } else if (arch === 'runner') {
    cloth = choice([0xee3322, 0x22ee44, 0xeecc00, 0x00ccee, 0xff22aa]);
    pants = choice([0x111111, 0x222233]);
    scaleY = rand(1.0, 1.12);
    scaleXZ = rand(0.88, 0.96);
  } else if (arch === 'businessman') {
    cloth = choice([0x1c2430, 0x2a2e36, 0x383430, 0x151c24]);
    pants = cloth;
    scaleY = rand(1.02, 1.10);
  } else if (arch === 'student') {
    cloth = choice([0xd86030, 0x3090d8, 0x9040d8, 0xe0a020]);
    pants = choice([0x3a4a5a, 0x2a2a3a, 0x223344]);
  } else if (arch === 'tourist') {
    cloth = choice([0xccaa33, 0xdd6633, 0x33aa99, 0x77bb44]);
    pants = choice([0x998877, 0x445566, 0xaa9988]);
    scaleY = rand(0.96, 1.06);
  } else if (arch === 'child') {
    cloth = choice([0xff5555, 0x33bbff, 0xffcc00, 0x44dd66]);
    pants = choice([0x224488, 0x882244]);
    scaleY = rand(0.70, 0.78);
    scaleXZ = rand(0.72, 0.80);
  } else if (arch === 'elder') {
    // Бородатый старик: тёплые выцветшие тона, сутулый, с бородой
    cloth = choice([0x8a7a5a, 0x6a5a4a, 0x7a6a5a, 0x5a4a3a]);
    pants = choice([0x4a3a2a, 0x3a2a1a, 0x5a4a3a]);
    scaleY = rand(0.82, 0.90);
    scaleXZ = rand(1.0, 1.1);
  } else if (arch === 'mom') {
    // Мама с коляской: светлая одежда, чуть полнее
    cloth = choice([0xd8a0a0, 0xc0a0d8, 0xa0c8d8, 0xe0b0a0]);
    pants = choice([0x5a4a5a, 0x4a4a5a, 0x6a5a6a]);
    scaleY = rand(0.95, 1.02);
    scaleXZ = rand(1.0, 1.12);
  } else if (arch === 'worker') {
    // Рабочий: спецовка, каска, крепкий
    cloth = choice([0x2a4a6a, 0x3a5a3a, 0x4a4a4a, 0x5a5a3a]);
    pants = choice([0x2a2a3a, 0x3a3a4a, 0x1a2a3a]);
    scaleY = rand(1.0, 1.1);
    scaleXZ = rand(1.0, 1.1);
  } else if (arch === 'musician') {
    // Уличный музыкант: яркая одежда, берет
    cloth = choice([0x8a3a3a, 0x3a5a8a, 0x6a3a6a, 0x3a6a5a]);
    pants = choice([0x2a2a3a, 0x3a2a2a, 0x2a3a2a]);
    scaleY = rand(0.95, 1.05);
  } else if (arch === 'nurse') {
    // Медсестра: белый халат, шапочка
    cloth = choice([0xe8e8e8, 0xf0f0f0, 0xffffff, 0xe0e8f0]);
    pants = choice([0xffffff, 0xe8e8e8, 0xf0f0f0]);
    scaleY = rand(0.95, 1.05);
    scaleXZ = rand(0.95, 1.05);
  }

  const mat = (c) => getPedMat(c);
  const g = new THREE.Group();

  // Статичные части торса и аксессуаров
  const parts = [];
  // Детали головы (собираются в абсолютных координатах и переносятся в отдельную Group userData.head)
  const headParts = [];

  // Торс
  parts.push({ g: new THREE.BoxGeometry(0.56, 0.68, 0.34).translate(0, 1.05, 0), c: cloth });

  // Жилетка / куртка детализация (полоска куртки)
  if (Math.random() < 0.6) {
    parts.push({ g: new THREE.BoxGeometry(0.06, 0.66, 0.02).translate(0, 1.05, 0.175), c: 0xdddddd });
  }

  // Голова + нос
  headParts.push({ g: new THREE.SphereGeometry(0.26, 10, 8).translate(0, 1.62, 0), c: skin });
  headParts.push({ g: new THREE.BoxGeometry(0.04, 0.04, 0.04).translate(0, 1.62, 0.26), c: skin });

  // Очки / солнцезащитные очки
  if (Math.random() < 0.35 || arch === 'businessman' || arch === 'tourist') {
    const glassColor = arch === 'businessman' || Math.random() < 0.6 ? 0x111115 : 0x88ccff;
    headParts.push({ g: new THREE.BoxGeometry(0.36, 0.08, 0.06).translate(0, 1.64, 0.23), c: glassColor });
  }

  // Волосы / Шляпы / Аксессуары
  if (arch === 'gopnik') {
    // Кепка-восьмиклинка: сидит на МАКУШКЕ
    headParts.push({ g: new THREE.CylinderGeometry(0.28, 0.28, 0.10, 8).translate(0, 1.84, 0.02), c: 0x1a1a1c });
    headParts.push({ g: new THREE.BoxGeometry(0.24, 0.02, 0.16).translate(0, 1.79, 0.24), c: 0x1a1a1c });
    // Ремень через плечо + поясная сумка-барсетка
    parts.push({ g: new THREE.BoxGeometry(0.04, 0.58, 0.02).rotateZ(0.6).translate(0, 1.05, 0.175), c: 0x111111 });
    parts.push({ g: new THREE.BoxGeometry(0.04, 0.58, 0.02).rotateZ(-0.6).translate(0, 1.05, -0.175), c: 0x111111 });
    parts.push({ g: new THREE.BoxGeometry(0.18, 0.12, 0.06).translate(0.06, 1.1, 0.19), c: 0x111111 });
    // Белые лампасы на куртке
    parts.push({ g: new THREE.BoxGeometry(0.02, 0.66, 0.35).translate(0.285, 1.05, 0), c: 0xffffff });
    parts.push({ g: new THREE.BoxGeometry(0.02, 0.66, 0.35).translate(-0.285, 1.05, 0), c: 0xffffff });
  } else if (arch === 'grandma') {
    // Платок на голову
    headParts.push({ g: new THREE.SphereGeometry(0.28, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.7).translate(0, 1.63, 0), c: 0xd8a8a8 });
    // Сумка/авоська или палочка
    if (Math.random() < 0.5) {
      parts.push({ g: new THREE.BoxGeometry(0.22, 0.28, 0.14).translate(0.36, 0.88, 0.1), c: choice([0x4a3a2a, 0xd0c8a0, 0x6a4a3a]) });
    } else {
      parts.push({ g: new THREE.CylinderGeometry(0.025, 0.025, 0.95, 6).translate(0.38, 0.65, 0.1), c: 0x5a3a1a });
    }
  } else if (arch === 'runner') {
    // Повязка на лоб и причёска
    headParts.push({ g: new THREE.CylinderGeometry(0.27, 0.27, 0.06, 8).translate(0, 1.68, 0), c: 0xffffff });
    headParts.push({ g: new THREE.SphereGeometry(0.27, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 1.63, 0), c: hairC });
  } else if (arch === 'student') {
    // Наушники на ушах и причёска
    headParts.push({ g: new THREE.TorusGeometry(0.27, 0.04, 4, 12, Math.PI).rotateX(Math.PI / 2).translate(0, 1.65, 0), c: 0x222222 });
    headParts.push({ g: new THREE.SphereGeometry(0.27, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 1.63, 0), c: hairC });
    // Рюкзак на спине с карманом
    const bagColor = choice([0x205080, 0x803020, 0x306030, 0x222222]);
    parts.push({ g: new THREE.BoxGeometry(0.38, 0.45, 0.20).translate(0, 1.1, -0.24), c: bagColor });
    parts.push({ g: new THREE.BoxGeometry(0.26, 0.20, 0.08).translate(0, 1.0, -0.35), c: bagColor });
    parts.push({ g: new THREE.BoxGeometry(0.22, 0.02, 0.09).translate(0, 1.11, -0.35), c: 0xcccccc });
  } else if (arch === 'businessman') {
    // Портфель в руке
    parts.push({ g: new THREE.BoxGeometry(0.1, 0.28, 0.36).translate(0.38, 0.85, 0.05), c: 0x1a1410 });
    // Галстук на груди
    parts.push({ g: new THREE.BoxGeometry(0.06, 0.35, 0.02).translate(0, 1.12, 0.175), c: choice([0x8a2020, 0x204080, 0x8a7020]) });
    // Причёска бизнесмена
    headParts.push({ g: new THREE.SphereGeometry(0.27, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0, 1.64, 0), c: 0x221a14 });
  } else if (arch === 'tourist') {
    // Панамка / кепка туриста
    headParts.push({ g: new THREE.CylinderGeometry(0.42, 0.42, 0.02, 10).translate(0, 1.74, 0), c: 0xddccaa });
    headParts.push({ g: new THREE.CylinderGeometry(0.26, 0.27, 0.16, 10).translate(0, 1.83, 0), c: 0xddccaa });
    // Фотоаппарат на груди с объективом
    parts.push({ g: new THREE.BoxGeometry(0.18, 0.14, 0.12).translate(0, 1.15, 0.22), c: 0x222222 });
    parts.push({ g: new THREE.CylinderGeometry(0.05, 0.05, 0.05, 8).rotateX(Math.PI / 2).translate(0.03, 1.15, 0.29), c: 0x444444 });
  } else if (arch === 'elder') {
    // Бородатый старик: седая борода + лысина/седые волосы
    headParts.push({ g: new THREE.SphereGeometry(0.27, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0, 1.64, 0), c: 0xd8d8d8 });
    // Борода (полусфера под лицом)
    headParts.push({ g: new THREE.SphereGeometry(0.2, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.6).translate(0, 1.5, 0.1), c: 0xd8d8d8 });
    // Трость в руке
    parts.push({ g: new THREE.CylinderGeometry(0.03, 0.03, 1.1, 6).translate(0.4, 0.75, 0.1), c: 0x5a3a1a });
  } else if (arch === 'mom') {
    // Мама с коляской: волосы в пучок + коляска перед собой
    headParts.push({ g: new THREE.SphereGeometry(0.27, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.6).translate(0, 1.64, 0), c: 0x4a2a1a });
    headParts.push({ g: new THREE.SphereGeometry(0.1, 6, 6).translate(0, 1.84, -0.14), c: 0x4a2a1a });
    // Коляска (корпус + колёса) перед мамой
    parts.push({ g: new THREE.BoxGeometry(0.5, 0.4, 0.7).translate(0, 0.7, 0.5), c: 0x3a5a8a });
    parts.push({ g: new THREE.CylinderGeometry(0.12, 0.12, 0.1, 8).rotateX(Math.PI / 2).translate(0, 0.35, 0.5), c: 0x222222 });
    parts.push({ g: new THREE.CylinderGeometry(0.12, 0.12, 0.1, 8).rotateX(Math.PI / 2).translate(0, 0.35, 0.9), c: 0x222222 });
  } else if (arch === 'worker') {
    // Рабочий: каска + светоотражающие полоски + инструмент в руке
    headParts.push({ g: new THREE.SphereGeometry(0.28, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0, 1.66, 0), c: 0xe8c020 });
    headParts.push({ g: new THREE.CylinderGeometry(0.3, 0.3, 0.05, 8).translate(0, 1.78, 0), c: 0xe8c020 });
    // Светоотражающие полоски на спецовке
    parts.push({ g: new THREE.BoxGeometry(0.54, 0.04, 0.02).translate(0, 1.18, 0.175), c: 0xd4e157 });
    parts.push({ g: new THREE.BoxGeometry(0.54, 0.04, 0.02).translate(0, 0.92, 0.175), c: 0xd4e157 });
    parts.push({ g: new THREE.BoxGeometry(0.54, 0.04, 0.02).translate(0, 1.18, -0.175), c: 0xd4e157 });
    // Гаечный ключ в руке
    parts.push({ g: new THREE.BoxGeometry(0.05, 0.5, 0.05).translate(0.42, 0.9, 0.1), c: 0x888888 });
  } else if (arch === 'musician') {
    // Уличный музыкант: берет + аккордеон или чехол гитары
    headParts.push({ g: new THREE.SphereGeometry(0.28, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0, 1.66, 0), c: 0x2a2a2a });
    headParts.push({ g: new THREE.CylinderGeometry(0.3, 0.3, 0.06, 8).translate(0, 1.78, 0), c: 0x8a3a3a });
    if (Math.random() < 0.5) {
      // Аккордеон (корпус + меха)
      parts.push({ g: new THREE.BoxGeometry(0.4, 0.3, 0.2).translate(0, 1.1, 0.25), c: 0x8a3a3a });
      parts.push({ g: new THREE.BoxGeometry(0.42, 0.2, 0.1).translate(0, 1.1, 0.18), c: 0xdddddd });
    } else {
      // Чехол гитары за спиной и ремень
      parts.push({ g: new THREE.BoxGeometry(0.30, 0.48, 0.14).rotateZ(0.25).translate(0.05, 1.15, -0.24), c: 0x1f1f1f });
      parts.push({ g: new THREE.BoxGeometry(0.09, 0.40, 0.09).rotateZ(0.25).translate(-0.06, 1.50, -0.24), c: 0x1f1f1f });
      parts.push({ g: new THREE.BoxGeometry(0.04, 0.58, 0.02).rotateZ(-0.5).translate(0, 1.08, 0.175), c: 0x1f1f1f });
    }
  } else if (arch === 'nurse') {
    // Медсестра: белая шапочка с крестом + фонендоскоп
    headParts.push({ g: new THREE.SphereGeometry(0.28, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0, 1.66, 0), c: 0xffffff });
    headParts.push({ g: new THREE.BoxGeometry(0.3, 0.05, 0.3).translate(0, 1.78, 0), c: 0xffffff });
    // Красный крест на шапочке
    headParts.push({ g: new THREE.BoxGeometry(0.12, 0.04, 0.04).translate(0, 1.78, 0.1), c: 0xcc2222 });
    headParts.push({ g: new THREE.BoxGeometry(0.04, 0.04, 0.12).translate(0, 1.78, 0.1), c: 0xcc2222 });
    // Фонендоскоп на шее
    parts.push({ g: new THREE.TorusGeometry(0.1, 0.02, 4, 8).rotateX(Math.PI / 2).translate(0, 1.35, 0.15), c: 0x222222 });
  } else if (arch === 'child') {
    headParts.push({ g: new THREE.SphereGeometry(0.27, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 1.63, 0), c: hairC });
  } else {
    // Разнообразные причёски для обычных пешеходов
    const hairStyle = Math.floor(Math.random() * 3);
    if (hairStyle === 0) {
      headParts.push({ g: new THREE.SphereGeometry(0.27, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 1.63, 0), c: hairC });
    } else if (hairStyle === 1) {
      // Пышная причёска / пучок
      headParts.push({ g: new THREE.SphereGeometry(0.28, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.6).translate(0, 1.64, 0), c: hairC });
      headParts.push({ g: new THREE.SphereGeometry(0.12, 6, 6).translate(0, 1.82, -0.16), c: hairC });
    } else {
      headParts.push({ g: new THREE.SphereGeometry(0.27, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0, 1.64, 0), c: hairC });
    }
    // Шарф на шее (шанс ~30%)
    if (Math.random() < 0.3) {
      const scarfC = choice([0xbb3333, 0x336699, 0xddaa33, 0x338866, 0x664488]);
      parts.push({ g: new THREE.TorusGeometry(0.16, 0.06, 5, 10).rotateX(Math.PI / 2).translate(0, 1.37, 0), c: scarfC });
      parts.push({ g: new THREE.BoxGeometry(0.1, 0.24, 0.04).translate(0.06, 1.22, 0.18), c: scarfC });
    }
  }

  // Мердж статичных частей корпуса
  const staticMesh = new THREE.Mesh(mergeColored(parts), getPedColoredMat());

  // Голова: мердж в абсолютных координатах → сдвиг вниз к пивоту → Group с position.y = HEAD_PIVOT_Y
  const headGeo = mergeColored(headParts);
  headGeo.translate(0, -HEAD_PIVOT_Y, 0);
  const headGroup = new THREE.Group();
  headGroup.add(new THREE.Mesh(headGeo, getPedColoredMat()));
  headGroup.position.y = HEAD_PIVOT_Y;

  // Группа верхнего корпуса для боббинга/дыхания
  const upper = new THREE.Group();
  upper.add(staticMesh);
  upper.add(headGroup);

  // Ноги — legGeo+shoeGeo сливаются в один vertexColors-меш на ногу (OPT-14),
  // группа-обёртка сохраняется как есть (нужна для rotation.x при ходьбе).
  const legGeo = new THREE.BoxGeometry(0.18, 0.75, 0.2);
  legGeo.translate(0, -0.375, 0);
  const shoeGeo = new THREE.BoxGeometry(0.2, 0.12, 0.32);
  shoeGeo.translate(0, -0.77, 0.04);
  const legGeoMerged = mergeColored([{ g: legGeo, c: pants }, { g: shoeGeo, c: shoeC }]);
  const legs = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Group();
    leg.add(new THREE.Mesh(legGeoMerged, getPedColoredMat()));
    leg.position.set(0.13 * s, 1.05, 0);
    g.add(leg);
    legs.push(leg);
  }

  // Руки (добавляются в upper)
  const armGeo = new THREE.BoxGeometry(0.15, 0.62, 0.15);
  armGeo.translate(0, -0.31, 0);
  const arms = [];
  for (const s of [-1, 1]) {
    const arm = new THREE.Group();
    arm.add(new THREE.Mesh(armGeo, mat(cloth)));
    arm.position.set(0.39 * s, 1.32, 0);
    upper.add(arm);
    arms.push(arm);
  }

  g.add(upper);

  g.scale.set(scaleXZ, scaleY, scaleXZ);
  g.userData = { legs, arms, head: headGroup, upper, idleSeed: Math.random() * 100, archetype: arch, isAnimal: false };
  return g;
}

/* Детализированная модель водителя такси с кастомизацией */
export function buildDriverMesh(options = {}) {
  const belly = options.belly !== undefined ? !!options.belly : (Math.random() < 0.45);
  const skin = options.skinColor || choice([0xf5d0b0, 0xd8a878, 0xc89060, 0xa87850, 0xffdbac, 0xecd0b8, 0x9c6b45]);
  const shirt = options.shirtColor || choice([0x283848, 0x503525, 0x304030, 0x222226, 0x485868, 0x5c4033, 0x334455, 0x3b4a3f, 0x4a3b32]);
  const pants = options.pantsColor || choice([0x1a2430, 0x2a2a3a, 0x3a3a4a, 0x4a3a2a, 0x222222, 0x1e3799, 0x2c2c54]);
  const hairC = options.hairColor || choice([0x1a1a1a, 0x3a2a1a, 0x6a4a2a, 0x8a7a6a, 0xdcdde1, 0x718093, 0x4a4a4a]);

  const capStyle = options.capStyle || (options.cap === false ? 'none' : 'taxi');     // 'taxi' | 'flat' | 'beanie' | 'none'
  const facial  = options.facialHair || (options.facialHair === undefined ? 'mustache' : 'none'); // 'mustache' | 'beard' | 'goatee' | 'none'
  let glasses = options.glasses || 'auto';        // 'auto' | 'aviators' | 'round' | 'none'
  if (glasses === 'auto') {
    glasses = Math.random() < 0.7 ? 'aviators' : 'none';
  }
  const bulk = options.bulk || rand(0.95, 1.06);    // обхват плеч
  const height = options.height || rand(0.96, 1.05); // рост

  const g = new THREE.Group();
  const parts = [];

  // 1. Торс и живот
  if (belly) {
    // Полный торс с животиком
    parts.push({ g: new THREE.BoxGeometry(0.60, 0.68, 0.38).translate(0, 1.05, 0), c: shirt });
    parts.push({ g: new THREE.BoxGeometry(0.48, 0.38, 0.14).translate(0, 0.96, 0.19), c: shirt });
    // Ремень и пряжка
    parts.push({ g: new THREE.BoxGeometry(0.56, 0.08, 0.40).translate(0, 0.73, 0.01), c: 0x1a1a1a });
    parts.push({ g: new THREE.BoxGeometry(0.10, 0.08, 0.04).translate(0, 0.73, 0.22), c: 0xd4af37 });
  } else {
    // Обычный торс
    parts.push({ g: new THREE.BoxGeometry(0.56, 0.68, 0.34).translate(0, 1.05, 0), c: shirt });
    // Ремень и пряжка
    parts.push({ g: new THREE.BoxGeometry(0.52, 0.08, 0.34).translate(0, 0.73, 0), c: 0x1a1a1a });
    parts.push({ g: new THREE.BoxGeometry(0.10, 0.08, 0.04).translate(0, 0.73, 0.18), c: 0xd4af37 });
  }

  // Молния куртки по центру
  const fz = belly ? 0.265 : 0.175;
  parts.push({ g: new THREE.BoxGeometry(0.04, 0.64, 0.02).translate(0, 1.05, fz), c: 0xcccccc });

  // Воротник
  parts.push({ g: new THREE.BoxGeometry(0.32, 0.08, 0.08).translate(0, 1.36, belly ? 0.14 : 0.11), c: shirt });

  // Шашечки такси на правой стороне груди
  const cx = 0.14;
  const cy = 1.15;
  const cz = belly ? 0.265 : 0.175;
  parts.push({ g: new THREE.BoxGeometry(0.20, 0.05, 0.01).translate(cx, cy, cz), c: 0x111111 });
  const checkOffsets = [-0.06, -0.02, 0.02, 0.06];
  for (let i = 0; i < checkOffsets.length; i++) {
    parts.push({
      g: new THREE.BoxGeometry(0.038, 0.045, 0.015).translate(cx + checkOffsets[i], cy, cz + 0.005),
      c: (i % 2 === 0 ? 0xf5b020 : 0x111111)
    });
  }

  // Бейджик таксиста на левой стороне груди
  const bx = -0.14;
  const by = 1.15;
  const bz = belly ? 0.265 : 0.175;
  parts.push({ g: new THREE.BoxGeometry(0.09, 0.11, 0.015).translate(bx, by, bz), c: 0xf5b020 });
  parts.push({ g: new THREE.BoxGeometry(0.07, 0.08, 0.02).translate(bx, by, bz + 0.004), c: 0xffffff });
  parts.push({ g: new THREE.BoxGeometry(0.028, 0.035, 0.025).translate(bx - 0.015, by + 0.012, bz + 0.007), c: 0x224477 });
  parts.push({ g: new THREE.BoxGeometry(0.045, 0.015, 0.025).translate(bx, by - 0.018, bz + 0.007), c: 0x333333 });

  // Рация на поясе
  const radioX = belly ? -0.32 : -0.28;
  parts.push({ g: new THREE.BoxGeometry(0.08, 0.13, 0.06).translate(radioX, 0.85, 0), c: 0x222222 });
  parts.push({ g: new THREE.CylinderGeometry(0.01, 0.01, 0.10, 4).translate(radioX, 0.96, 0), c: 0x111111 });

  // Шея и голова
  parts.push({ g: new THREE.CylinderGeometry(0.11, 0.12, 0.12, 8).translate(0, 1.41, 0), c: skin });
  parts.push({ g: new THREE.SphereGeometry(0.26, 10, 8).translate(0, 1.62, 0), c: skin });
  parts.push({ g: new THREE.BoxGeometry(0.06, 0.06, 0.06).translate(0, 1.62, 0.26), c: skin });

  // Очки
  if (glasses === 'aviators') {
    parts.push({ g: new THREE.BoxGeometry(0.36, 0.08, 0.05).translate(0, 1.64, 0.24), c: 0x15181c });
    parts.push({ g: new THREE.BoxGeometry(0.06, 0.02, 0.055).translate(0, 1.66, 0.245), c: 0xd4af37 });
  } else if (glasses === 'round') {
    parts.push({ g: new THREE.CylinderGeometry(0.07, 0.07, 0.04, 8).rotateX(Math.PI / 2).translate(-0.09, 1.64, 0.24), c: 0x111111 });
    parts.push({ g: new THREE.CylinderGeometry(0.07, 0.07, 0.04, 8).rotateX(Math.PI / 2).translate(0.09, 1.64, 0.24), c: 0x111111 });
    parts.push({ g: new THREE.BoxGeometry(0.06, 0.015, 0.04).translate(0, 1.64, 0.245), c: 0xd4af37 });
  }

  // Растительность на лице
  if (facial === 'mustache') {
    parts.push({ g: new THREE.BoxGeometry(0.14, 0.04, 0.04).translate(0, 1.55, 0.26), c: hairC });
  } else if (facial === 'beard') {
    parts.push({ g: new THREE.SphereGeometry(0.2, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.6).translate(0, 1.5, 0.1), c: hairC });
    parts.push({ g: new THREE.BoxGeometry(0.14, 0.04, 0.04).translate(0, 1.55, 0.26), c: hairC });
  } else if (facial === 'goatee') {
    parts.push({ g: new THREE.BoxGeometry(0.08, 0.08, 0.04).translate(0, 1.48, 0.25), c: hairC });
    parts.push({ g: new THREE.BoxGeometry(0.12, 0.03, 0.03).translate(0, 1.55, 0.26), c: hairC });
  }

  // Волосы (база)
  parts.push({ g: new THREE.SphereGeometry(0.27, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 1.63, 0), c: hairC });

  // Головной убор
  if (capStyle === 'taxi') {
    // Тулья кепки: сидит на МАКУШКЕ (верх головы 1.88), а не на уровне лба.
    parts.push({ g: new THREE.CylinderGeometry(0.29, 0.28, 0.10, 10).translate(0, 1.85, 0.02), c: 0x1f2328 });
    // Козырёк — на нижней кромке тульи
    parts.push({ g: new THREE.BoxGeometry(0.26, 0.025, 0.16).translate(0, 1.80, 0.24), c: 0x111111 });
    // Кнопка сверху
    parts.push({ g: new THREE.CylinderGeometry(0.035, 0.035, 0.02, 6).translate(0, 1.91, 0.02), c: 0xf5b020 });
    // Околыш с шашечками на кепке
    parts.push({ g: new THREE.BoxGeometry(0.28, 0.035, 0.02).translate(0, 1.84, 0.20), c: 0x111111 });
    const capCheckers = [-0.09, -0.03, 0.03, 0.09];
    for (let i = 0; i < capCheckers.length; i++) {
      parts.push({
        g: new THREE.BoxGeometry(0.05, 0.03, 0.025).translate(capCheckers[i], 1.84, 0.205),
        c: (i % 2 === 0 ? 0xf5b020 : 0x111111)
      });
    }
  } else if (capStyle === 'flat') {
    parts.push({ g: new THREE.CylinderGeometry(0.29, 0.29, 0.10, 8).translate(0, 1.84, 0.02), c: 0x25282e });
    parts.push({ g: new THREE.BoxGeometry(0.25, 0.02, 0.16).translate(0, 1.79, 0.24), c: 0x25282e });
    parts.push({ g: new THREE.CylinderGeometry(0.03, 0.03, 0.02, 6).translate(0, 1.90, 0.02), c: 0x25282e });
  } else if (capStyle === 'beanie') {
    const beanieC = choice([0x222222, 0x334455, 0x553333, 0x335544]);
    parts.push({ g: new THREE.SphereGeometry(0.28, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 1.68, 0), c: beanieC });
    parts.push({ g: new THREE.CylinderGeometry(0.285, 0.285, 0.08, 10).translate(0, 1.72, 0), c: beanieC });
  } else {
    // Причёска без головного убора
    parts.push({ g: new THREE.SphereGeometry(0.28, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.6).translate(0, 1.64, 0), c: hairC });
  }

  const staticMesh = new THREE.Mesh(mergeColored(parts), getPedColoredMat());
  g.add(staticMesh);

  // Ноги (брюки + обувь)
  const legGeo = new THREE.BoxGeometry(0.19, 0.75, 0.21);
  legGeo.translate(0, -0.375, 0);
  const shoeGeo = new THREE.BoxGeometry(0.21, 0.12, 0.32);
  shoeGeo.translate(0, -0.77, 0.04);
  const legGeoMerged = mergeColored([{ g: legGeo, c: pants }, { g: shoeGeo, c: 0x1f1f23 }]);
  const legs = [];
  const legSpread = belly ? 0.15 : 0.13;
  for (const s of [-1, 1]) {
    const leg = new THREE.Group();
    leg.add(new THREE.Mesh(legGeoMerged, getPedColoredMat()));
    leg.position.set(legSpread * s, 1.05, 0);
    g.add(leg);
    legs.push(leg);
  }

  // Руки (рукава одежды + кисти рук)
  const armSleeveGeo = new THREE.BoxGeometry(0.16, 0.48, 0.16);
  armSleeveGeo.translate(0, -0.24, 0);
  const handGeo = new THREE.BoxGeometry(0.13, 0.14, 0.13);
  handGeo.translate(0, -0.55, 0);
  const armGeoMerged = mergeColored([{ g: armSleeveGeo, c: shirt }, { g: handGeo, c: skin }]);
  const arms = [];
  const armSpread = belly ? 0.42 : 0.39;
  for (const s of [-1, 1]) {
    const arm = new THREE.Group();
    arm.add(new THREE.Mesh(armGeoMerged, getPedColoredMat()));
    arm.position.set(armSpread * s, 1.32, 0);
    g.add(arm);
    arms.push(arm);
  }

  g.scale.set(bulk, height, bulk);
  g.userData = { legs, arms, archetype: 'driver', isAnimal: false };
  return g;
}

/* Материалы посылки — модульные константы (не создавать заново на каждый attachParcelBox) */
const _parcelBoxMat = new THREE.MeshLambertMaterial({ color: 0x8a5a2a });
const _parcelTapeMat = new THREE.MeshLambertMaterial({ color: 0xe0c080 });

/* Прикрепить модель посылки к пешеходу (отправителю или получателю) */
export function attachParcelBox(pedMesh) {
  if (!pedMesh) return;
  const boxMat = _parcelBoxMat;
  const tapeMat = _parcelTapeMat;
  
  const parcelGroup = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.28, 0.32), boxMat);
  box.position.set(0, 1.05, 0.26);
  parcelGroup.add(box);

  const tape1 = new THREE.Mesh(new THREE.BoxGeometry(0.37, 0.05, 0.05), tapeMat);
  tape1.position.set(0, 1.18, 0.26);
  parcelGroup.add(tape1);

  const tape2 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.33), tapeMat);
  tape2.position.set(0, 1.18, 0.26);
  parcelGroup.add(tape2);

  pedMesh.add(parcelGroup);
  pedMesh.userData.parcelBox = parcelGroup;
  
  // Согнуть руки вперёд, удерживая коробку
  if (pedMesh.userData && pedMesh.userData.arms) {
    pedMesh.userData.arms[0].rotation.x = -0.7;
    pedMesh.userData.arms[1].rotation.x = -0.7;
  }
}

export function detachParcelBox(pedMesh) {
  if (pedMesh && pedMesh.userData && pedMesh.userData.parcelBox) {
    pedMesh.remove(pedMesh.userData.parcelBox);
    pedMesh.userData.parcelBox = null;
    if (pedMesh.userData.arms) {
      pedMesh.userData.arms[0].rotation.x = 0;
      pedMesh.userData.arms[1].rotation.x = 0;
    }
  }
}

/* Переиспользуемый результат circleAABB — вызывающий код потребляет его сразу
   (this._resolve(c, ...)), не переживает кадр, поэтому одного общего объекта
   достаточно вместо {nx,nz,depth} на каждый вызов (OPT-18, ~600 раз/кадр). */
const _circleAABBRes = { nx: 0, nz: 0, depth: 0 };

/* Коллизия круга с AABB. Возвращает _circleAABBRes (мутируется) или null */
export function circleAABB(px, pz, r, box, playerY = 0, playerH = 1.5) {
  if (box.y !== undefined && box.y !== Infinity && playerY + playerH > box.y) return null;
  const cx = clamp(px, box.x0, box.x1);
  const cz = clamp(pz, box.z0, box.z1);
  let dx = px - cx, dz = pz - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > r * r) return null;
  const d = Math.sqrt(d2);
  if (d > 1e-6) {
    _circleAABBRes.nx = dx / d; _circleAABBRes.nz = dz / d; _circleAABBRes.depth = r - d;
    return _circleAABBRes;
  }
  // центр внутри бокса — выталкиваем по минимальному проникновению
  const l = px - box.x0, rgt = box.x1 - px, t = pz - box.z0, b = box.z1 - pz;
  const m = Math.min(l, rgt, t, b);
  if (m === l) { _circleAABBRes.nx = -1; _circleAABBRes.nz = 0; _circleAABBRes.depth = r + l; }
  else if (m === rgt) { _circleAABBRes.nx = 1; _circleAABBRes.nz = 0; _circleAABBRes.depth = r + rgt; }
  else if (m === t) { _circleAABBRes.nx = 0; _circleAABBRes.nz = -1; _circleAABBRes.depth = r + t; }
  else { _circleAABBRes.nx = 0; _circleAABBRes.nz = 1; _circleAABBRes.depth = r + b; }
  return _circleAABBRes;
}

/**
 * Проверка пересечения 2D-отрезка [(x0, z0) -> (x1, z1)] с осепараллельным
 * прямоугольником (AABB). Slab method, zero-alloc — только скалярная арифметика.
 * @param {number} x0
 * @param {number} z0
 * @param {number} x1
 * @param {number} z1
 * @param {{x0: number, z0: number, x1: number, z1: number}} box
 * @returns {boolean} true, если отрезок пересекает или касается AABB
 */
export function segmentIntersectsAABB(x0, z0, x1, z1, box) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  let tMin = 0;
  let tMax = 1;

  if (Math.abs(dx) < 1e-8) {
    if (x0 < box.x0 || x0 > box.x1) return false;
  } else {
    const invDx = 1 / dx;
    let t1 = (box.x0 - x0) * invDx;
    let t2 = (box.x1 - x0) * invDx;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return false;
  }

  if (Math.abs(dz) < 1e-8) {
    if (z0 < box.z0 || z0 > box.z1) return false;
  } else {
    const invDz = 1 / dz;
    let t1 = (box.z0 - z0) * invDz;
    let t2 = (box.z1 - z0) * invDz;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return false;
  }

  return true;
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

import * as THREE from 'three';
import { mergeColored, mergeGeoms } from './utils.js';

/* Кеш слитых vertexColors-геометрий кузова НЕ-animated машин (трафик) — ключ
   включает цвет, т.к. он запечён в вершины. Экономит mergeColored() (самая
   тяжёлая часть сборки — обход всех вершин) при повторном спавне того же
   сочетания силуэт+цвета. */
const _bodyGeoCache = new Map();
export function getBodyGeometry(key, build) {
  if (_bodyGeoCache.has(key)) return _bodyGeoCache.get(key);
  const g = build();
  _bodyGeoCache.set(key, g);
  return g;
}

/**
 * Общая фабрика 3D-моделей наземного транспорта. Единственное место, где
 * описан силуэт машины — используется и игроком (player.js), и трафиком
 * (traffic.js), чтобы не дублировать геометрию колёс/фар/стёкол дважды.
 *
 * Игрок получает "анимируемую" сборку (отдельные меши на общих материалах —
 * можно красить/мигать без пересборки геометрии), трафик — "статичную"
 * сборку (всё, что не двигается, слито в один vertexColors-меш ради
 * производительности при 14+ машинах на сцене).
 */

/* --- Усечённый бокс (фрустум) с плоским шейдингом ---------------------
   6 граней, каждая — 2 треугольника с независимыми вершинами (non-indexed),
   поэтому computeVertexNormals() даёт корректный плоский шейдинг без ручной
   расстановки нормалей. Верх грани можно сузить (topW/topD), сдвинуть по Z
   (topDZ — сажает "теплицу" салона глубже в кузов) и приподнять/опустить
   отдельно перед/зад (frontRise/backRise — это и даёт скошенный капот,
   покатый багажник, наклонное лобовое стекло без лишних треугольников). */
export function taperedBox(w, h, d, opts = {}) {
  const topW = opts.topW ?? w;
  const topD = opts.topD ?? d;
  const topDZ = opts.topDZ ?? 0;
  const y0 = -h / 2;
  const yTopF = h / 2 + (opts.frontRise ?? 0);
  const yTopB = h / 2 + (opts.backRise ?? 0);

  const bfl = [-w / 2, y0, d / 2], bfr = [w / 2, y0, d / 2];
  const bbl = [-w / 2, y0, -d / 2], bbr = [w / 2, y0, -d / 2];
  const tfl = [-topW / 2, yTopF, topD / 2 + topDZ], tfr = [topW / 2, yTopF, topD / 2 + topDZ];
  const tbl = [-topW / 2, yTopB, -topD / 2 + topDZ], tbr = [topW / 2, yTopB, -topD / 2 + topDZ];

  const pos = [];
  const quad = (a, b, c, d2) => { pos.push(...a, ...b, ...c, ...a, ...c, ...d2); };
  quad(bfl, bfr, tfr, tfl); // перед (+z)
  quad(bbr, bbl, tbl, tbr); // зад (-z)
  quad(bbl, bfl, tfl, tbl); // левый борт (-x)
  quad(bfr, bbr, tbr, tfr); // правый борт (+x)
  quad(tfl, tfr, tbr, tbl); // крыша
  quad(bbl, bbr, bfr, bfl); // днище

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  if (opts.x || opts.y || opts.z) geo.translate(opts.x || 0, opts.y || 0, opts.z || 0);
  return geo;
}

/* Геометрия колеса: цилиндр развёрнут осью по X (ось вращения — локальный X) */
function wheelGeo(r, tw, seg = 12) { return new THREE.CylinderGeometry(r, r, tw, seg).rotateZ(Math.PI / 2); }

/* --- Стили дисков (rimStyle: 'disc'|'spoke'|'chrome') -------------------
   'disc' — сплошной цилиндр (как раньше). 'spoke' — тот же цилиндр + 5
   тонких радиальных боксов-спиц поверх. 'chrome' — та же геометрия, что
   и 'disc', но красится matChrome/светлым цветом вместо matRim/rimColor
   (см. вызовы ниже). Спицы строятся в "естественной" системе координат
   цилиндра (ось Y, радиальная плоскость — XZ) — до применения общего
   поворота, которым диск ставится на колесо (rotateZ(PI/2) для статичной
   НЕ-animated геометрии, mesh.rotation.z для animated). */
function rimSpokeBars(r, tw, count = 5) {
  const barLen = r * 0.94, barW = r * 0.16, barH = tw + 0.05;
  const bars = [];
  for (let i = 0; i < count; i++) {
    bars.push(new THREE.BoxGeometry(barW, barH, barLen).translate(0, 0, barLen / 2).rotateY(i * (Math.PI * 2 / count)));
  }
  return bars;
}

/* Геометрия диска для НЕ-animated (трафик) ветки — уже с запечённым
   поворотом (как wheelGeo), спицы (если есть) слиты в ту же геометрию,
   чтобы не плодить лишний draw call (см. mergeColored ниже). */
function buildStaticRimGeo(style, r, tw, seg) {
  const disc = wheelGeo(r, tw, seg);
  if (style !== 'spoke') return disc;
  return mergeGeoms([disc, ...rimSpokeBars(r, tw).map((g) => g.rotateZ(Math.PI / 2))]);
}

/* --- Боди-кит (bodyKit: 'stock'|'sport') ---------------------------------
   Работает поверх любого силуэта (CAR_SHAPES) — не завязан на конкретные
   пропорции threeBoxCar/boxVanCar, поэтому размеры считаются от dims (w/len)
   и радиуса колеса (даёт разумную высоту от земли для любого типа кузова).
   'stock' — обвеса нет (пустой массив). 'sport' — тонкий передний сплиттер
   под бампером + пороги вдоль порогов по обеим сторонам. Возвращает parts
   в том же формате {g,role}, что и CAR_SHAPES — buildCarModel раскладывает
   их по той же логике (animated: отдельные меши в скрываемой группе,
   НЕ-animated: сливаются в staticColored вместе с кузовом). */
function bodyKitParts(dims, kit) {
  if (kit !== 'sport') return [];
  const { w, len, wheelR = 0.38 } = dims;
  const y = wheelR * 0.5;
  const parts = [
    // передний сплиттер
    { g: new THREE.BoxGeometry(w * 1.06, wheelR * 0.22, 0.22).translate(0, y, len / 2 + 0.06), role: 'dark' },
  ];
  // пороги
  for (const s of [-1, 1]) {
    parts.push({ g: new THREE.BoxGeometry(0.12, wheelR * 0.3, len * 0.52).translate(s * (w / 2 + 0.03), y, 0), role: 'dark' });
  }
  return parts;
}

const insetAnchor = (a) => ({
  x: a.x - Math.sign(a.x) * a.w * 0.55, y: a.y, z: a.z, w: a.w * 0.46, h: a.h * 0.68, d: a.d,
});
const lampMesh = (a) => new THREE.BoxGeometry(a.w, a.h, a.d).translate(a.x, a.y, a.z);

/* ========================================================================
   Профили силуэтов. threeBoxCar — легковые (капот/салон/багажник),
   boxVanCar — кабина-над-двигателем (фургон/автобус/пикап/грузовик).
   Обе возвращают { parts:[{g,role}], glass:[geom], wheel, lampFront,
   lampRear, roofSign, liveryStripe, plate } — геометрия уже "запечена"
   (translate применён), поэтому части можно как слить, так и оставить
   раздельными мешами без потери позиционирования. ======================= */

function threeBoxCar(dims, o = {}) {
  const { w, len } = dims;
  const opt = {
    deckY: 0.72, deckH: 0.42, beltW: 0.98,
    hoodFrac: 0.32, hoodRise: -0.30,
    trunkFrac: 0.28, trunkRise: -0.30,
    cabW: 0.86, cabH: 0.46, cabY: 1.32, cabTopWfrac: 0.9, cabDZfrac: -0.02,
    roofW: 0.78, roofH: 0.1, roofY: 1.58, roofFrac: 0.4, roofDZfrac: -0.02,
    chromeBumper: false, chromeTrim: false, wheelR: 0.38,
    ...o,
  };
  const parts = [], glass = [];
  const add = (g, role) => parts.push({ g, role });
  const hoodLen = len * opt.hoodFrac, trunkLen = len * opt.trunkFrac;

  add(taperedBox(w * opt.beltW, opt.deckH, len, { y: opt.deckY }), 'body');
  add(taperedBox(w * 0.92, opt.deckH * 0.9, hoodLen, {
    frontRise: opt.hoodRise, y: opt.deckY + 0.02, z: len / 2 - hoodLen / 2,
  }), 'body');
  add(taperedBox(w * 0.92, opt.deckH * 0.9, trunkLen, {
    backRise: opt.trunkRise, y: opt.deckY + 0.02, z: -(len / 2 - trunkLen / 2),
  }), 'body');

  // "теплица" салона — единый тонированный блок (окна+стойки), как в исходном стиле
  glass.push(taperedBox(w * opt.cabW, opt.cabH, len - hoodLen - trunkLen, {
    topW: w * opt.cabW * opt.cabTopWfrac, topD: (len - hoodLen - trunkLen) * 0.92,
    topDZ: len * opt.cabDZfrac, y: opt.cabY,
  }));
  add(taperedBox(w * opt.roofW, opt.roofH, len * opt.roofFrac, {
    y: opt.roofY, z: len * opt.roofDZfrac,
  }), 'body');

  const bumperRole = opt.chromeBumper ? 'chrome' : 'dark';
  for (const s of [1, -1]) {
    add(new THREE.BoxGeometry(w * 1.04, 0.16, 0.16).translate(0, opt.deckY - opt.deckH * 0.42, s * (len / 2 + 0.07)), bumperRole);
  }
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.14, 0.1, 0.16).translate(s * (w / 2 + 0.07), opt.cabY - opt.cabH * 0.3, len * 0.12), opt.chromeTrim ? 'chrome' : 'dark');
    add(new THREE.BoxGeometry(0.03, 0.06, 0.32).translate(s * (w * opt.beltW / 2 + 0.015), opt.deckY + 0.1, 0), 'dark');
  }
  if (opt.chromeTrim) {
    add(new THREE.BoxGeometry(w * opt.beltW + 0.02, 0.035, len * 0.7).translate(0, opt.deckY + opt.deckH * 0.5, 0), 'chrome');
  }

  const lampFront = [-1, 1].map((s) => ({ x: s * w * 0.32, y: opt.deckY, z: len / 2 + 0.045, w: 0.28, h: 0.15, d: 0.08 }));
  const lampRear = [-1, 1].map((s) => ({ x: s * w * 0.32, y: opt.deckY, z: -(len / 2 + 0.045), w: 0.26, h: 0.13, d: 0.08 }));

  return {
    parts, glass,
    wheel: { r: opt.wheelR, tw: 0.3, front: { x: w * 0.47, z: len * 0.31 }, rear: { x: w * 0.47, z: -len * 0.31 } },
    lampFront, lampRear,
    roofSign: { x: 0, y: opt.roofY + opt.roofH / 2 + 0.11, z: len * opt.roofDZfrac },
    liveryStripe: { y: opt.deckY, z: 0, w: len * 0.82, h: opt.deckH * 0.62 },
    plate: { x: 0, y: opt.deckY - 0.06, z: -(len / 2 + 0.05) },
  };
}

function boxVanCar(dims, o = {}) {
  const { w, len } = dims;
  const opt = {
    deckY: 0.62, deckH: 0.4,
    cabLenFrac: 0.22, cabH: 0.9, cabY: 1.05, windshieldRise: -0.28,
    cargoLenFrac: 0.68, cargoH: 1.5, cargoY: 1.35,
    openBed: false, bedWallH: 0.35, sideGlass: false, wheelR: 0.38,
    ...o,
  };
  const parts = [], glass = [];
  const add = (g, role) => parts.push({ g, role });
  const cabLen = len * opt.cabLenFrac;
  const cargoLen = len * opt.cargoLenFrac;
  const cargoZ = -(len / 2 - cabLen - cargoLen / 2 - 0.04);

  add(new THREE.BoxGeometry(w * 0.96, opt.deckH, len).translate(0, opt.deckY, 0), 'body');
  add(taperedBox(w * 0.94, opt.cabH, cabLen, {
    frontRise: opt.windshieldRise * 0.35, y: opt.cabY, z: len / 2 - cabLen / 2,
  }), 'body');
  glass.push(taperedBox(w * 0.86, opt.cabH * 0.55, cabLen * 0.75, {
    frontRise: opt.windshieldRise, y: opt.cabY + opt.cabH * 0.16, z: len / 2 - cabLen * 0.32,
  }));

  if (opt.openBed) {
    const bedLen = Math.max(0.6, len - cabLen - 0.15);
    const bedZ = -(len / 2 - cabLen - bedLen / 2 - 0.06);
    add(new THREE.BoxGeometry(w * 0.94, opt.bedWallH, bedLen).translate(0, opt.deckY + opt.deckH / 2 + opt.bedWallH / 2, bedZ), 'body');
  } else {
    add(new THREE.BoxGeometry(w * 0.98, opt.cargoH, cargoLen).translate(0, opt.cargoY, cargoZ), 'body');
    if (opt.sideGlass) {
      for (const s of [-1, 1]) {
        glass.push(new THREE.BoxGeometry(0.02, opt.cargoH * 0.34, cargoLen * 0.82).translate(s * w * 0.49, opt.cargoY + opt.cargoH * 0.1, cargoZ));
      }
    }
  }

  for (const s of [1, -1]) {
    add(new THREE.BoxGeometry(w * 1.02, 0.16, 0.16).translate(0, opt.deckY - opt.deckH * 0.4, s * (len / 2 + 0.07)), 'dark');
  }
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.14, 0.1, 0.16).translate(s * (w / 2 + 0.07), opt.cabY - 0.05, len / 2 - cabLen * 0.5), 'dark');
  }

  const lampFront = [-1, 1].map((s) => ({ x: s * w * 0.34, y: opt.deckY, z: len / 2 + 0.045, w: 0.26, h: 0.16, d: 0.08 }));
  const lampRear = [-1, 1].map((s) => ({ x: s * w * 0.34, y: opt.deckY, z: -(len / 2 + 0.045), w: 0.24, h: 0.15, d: 0.08 }));

  return {
    parts, glass,
    wheel: { r: opt.wheelR, tw: 0.3, front: { x: w * 0.47, z: len / 2 - cabLen * 0.55 }, rear: { x: w * 0.47, z: -(len / 2 - cabLen - (opt.openBed ? (len - cabLen) * 0.4 : cargoLen * 0.35)) } },
    lampFront, lampRear,
    roofSign: { x: 0, y: opt.cabY + opt.cabH / 2 + 0.13, z: len / 2 - cabLen * 0.5 },
    liveryStripe: { y: opt.deckY + 0.1, z: -0.1, w: len * 0.7, h: opt.deckH * 0.7 },
    plate: { x: 0, y: opt.deckY - 0.04, z: -(len / 2 + 0.05) },
  };
}

export const CAR_SHAPES = {
  sedan: (d) => threeBoxCar(d, {}),
  hatch: (d) => threeBoxCar(d, {
    trunkFrac: 0.13, trunkRise: -0.36, roofFrac: 0.52, cabDZfrac: -0.06, roofDZfrac: -0.08,
  }),
  wagon: (d) => threeBoxCar(d, {
    trunkFrac: 0.22, trunkRise: -0.05, roofFrac: 0.62, roofDZfrac: -0.1, cabTopWfrac: 0.94,
  }),
  coupe: (d) => threeBoxCar(d, {
    deckY: 0.66, deckH: 0.38, cabY: 1.2, cabH: 0.4, roofY: 1.42,
    hoodFrac: 0.4, trunkFrac: 0.34, cabDZfrac: -0.08, cabTopWfrac: 0.8, roofFrac: 0.24,
  }),
  suv: (d) => threeBoxCar(d, {
    deckY: 0.92, deckH: 0.5, cabY: 1.58, cabH: 0.56, roofY: 1.9, roofH: 0.12,
    roofFrac: 0.58, cabTopWfrac: 0.96, hoodFrac: 0.28, trunkFrac: 0.24, wheelR: 0.44,
  }),
  retro: (d) => threeBoxCar(d, {
    cabTopWfrac: 0.96, cabDZfrac: 0, roofFrac: 0.34, hoodRise: -0.16, trunkRise: -0.16, chromeBumper: true,
  }),
  premium: (d) => threeBoxCar(d, {
    deckY: 0.68, deckH: 0.4, cabY: 1.22, cabH: 0.42, roofY: 1.46,
    hoodFrac: 0.4, trunkFrac: 0.32, cabTopWfrac: 0.86, roofFrac: 0.3, chromeTrim: true,
  }),
  van: (d) => boxVanCar(d, { sideGlass: true }),
  bus: (d) => boxVanCar(d, {
    cabLenFrac: 0.16, cabH: 1.1, cabY: 1.15, cargoLenFrac: 0.8, cargoH: 1.65, cargoY: 1.45, sideGlass: true,
  }),
  pickup: (d) => boxVanCar(d, { openBed: true, cabLenFrac: 0.36, cabH: 1.0 }),
  truck: (d) => boxVanCar(d, {
    cabLenFrac: 0.2, cabH: 1.15, cabY: 1.2, cargoLenFrac: 0.72, cargoH: 1.9, cargoY: 1.58, sideGlass: false,
  }),
};

/**
 * Собрать 3D-модель машины.
 * @param {Object} spec
 * @param {string} spec.shape - ключ CAR_SHAPES
 * @param {number} spec.w - ширина
 * @param {number} spec.len - длина
 * @param {boolean} spec.animated - true для игрока (раздельные меши, можно анимировать/красить),
 *   false для трафика (всё статичное сливается в один меш)
 * @param {THREE.Material} spec.matBody - материал кузова (для трафика — общий vertexColors)
 * @param {THREE.Material} spec.matDark - материал тёмных деталей (бамперы, зеркала, ручки)
 * @param {THREE.Material} [spec.matChrome] - материал хромированных деталей (ретро/бизнес)
 * @param {THREE.Material} spec.matGlass - материал стёкол
 * @param {THREE.Material} spec.matHead - материал фар
 * @param {THREE.Material} spec.matStop - материал стоп-сигналов
 * @param {THREE.Material} [spec.matTurnA] - материал поворотников, сторона A (только animated)
 * @param {THREE.Material} [spec.matTurnB] - материал поворотников, сторона B (только animated)
 * @param {THREE.Material} [spec.matReverse] - материал фонаря заднего хода (только animated)
 * @param {THREE.Material} [spec.matRim] - материал дисков
 * @param {THREE.Material} [spec.matPlate] - материал номерного знака
 * @param {THREE.Material} [spec.matSign] - материал плафона "ТАКСИ"
 * @param {THREE.Material} [spec.matLivery] - материал полосы ливреи (шашечки)
 * @param {number} [spec.bodyColor] - цвет кузова (только для НЕ-animated — запекается в вершины)
 * @param {number} [spec.darkColor]
 * @param {number} [spec.chromeColor]
 * @param {number} [spec.tireColor] - цвет шины (НЕ-animated, наружный цилиндр колеса)
 * @param {number} [spec.rimColor] - цвет диска (НЕ-animated, внутренний цилиндр колеса; игнорируется при rimStyle==='chrome' — используется chromeColor)
 * @param {string} [spec.rimStyle='disc'] - 'disc'|'spoke'|'chrome' — стиль сборки диска (геометрия, не только цвет).
 *   Для animated (игрок) строятся сразу все 3 варианта как дочерние меши колеса
 *   (wheels[i].rimVariants), rimStyle задаёт, какой из них видим изначально —
 *   переключение между ними без пересборки идёт через player.js:_applyTuning().
 *   Для НЕ-animated (трафик) строится только один вариант, спицы (если есть)
 *   запекаются в staticColored вместе с кузовом (без лишнего draw call).
 * @param {string} [spec.bodyKit='stock'] - 'stock'|'sport' — обвес кузова (см. bodyKitParts).
 *   Для animated (игрок) sport-детали строятся всегда как отдельная скрываемая группа
 *   (built.refs.bodyKit), spec.bodyKit задаёт только начальную видимость — переключение
 *   без пересборки идёт через player.js:_applyTuning(). Для НЕ-animated (трафик) детали
 *   строятся только если spec.bodyKit==='sport' и сразу сливаются в staticColored.
 * @param {boolean} [spec.hasPlate=true]
 * @param {boolean} [spec.hasSign=false] - плафон "ТАКСИ"
 * @param {boolean} [spec.hasLivery=false] - шашечки по бортам. Для animated (игрок)
 *   anchor-меш декали строится ВСЕГДА независимо от этого флага (built.refs.decal) —
 *   hasLivery здесь ни на что не влияет (дефолт выбора декали считает upgrades.js).
 *   Для НЕ-animated (трафик) поведение прежнее: anchor строится только при hasLivery===true.
 * @param {string|null} [spec.beacon] - 'police'|'ambulance'|null — маячок на крыше
 */
export function buildCarModel(spec) {
  const {
    shape, w, len, animated = false,
    matBody, matDark, matChrome, matGlass,
    matHead, matStop, matTurnA, matTurnB, matReverse,
    matRim, matHub, matPlate, matSign, matLivery,
    matBeaconRed, matBeaconBlue,
    bodyColor = 0xcccccc, darkColor = 0x22262c, chromeColor = 0xc8c8c8, tireColor = 0x18181a, rimColor = 0xc4c8cc,
    rimStyle = 'disc', bodyKit = 'stock',
    hasPlate = true, hasSign = false, hasLivery = false, beacon = null,
  } = spec;

  const shapeFn = CAR_SHAPES[shape] || CAR_SHAPES.sedan;
  const built = shapeFn({ w, len });

  const group = new THREE.Group();
  const bodyGroup = new THREE.Group();
  group.add(bodyGroup);
  const refs = {};

  const roleParts = { body: [], dark: [], chrome: [] };
  for (const p of built.parts) roleParts[p.role || 'body'].push(p.g);

  // НЕ-animated (трафик): всё статичное — кузов, бамперы, зеркала, колёса,
  // ступицы — копится сюда и сливается ОДНИМ mergeColored() в самом конце
  // (после расчёта колёс), чтобы получить единственный draw call на машину.
  const staticColored = animated ? null : [
    ...roleParts.body.map((g) => ({ g, c: bodyColor })),
    ...roleParts.dark.map((g) => ({ g, c: darkColor })),
    ...roleParts.chrome.map((g) => ({ g, c: chromeColor })),
  ];
  if (animated) {
    for (const g of roleParts.body) bodyGroup.add(new THREE.Mesh(g, matBody));
    for (const g of roleParts.dark) bodyGroup.add(new THREE.Mesh(g, matDark));
    for (const g of roleParts.chrome) bodyGroup.add(new THREE.Mesh(g, matChrome || matDark));
  }

  if (built.glass.length) {
    const glassGeo = built.glass.length === 1 ? built.glass[0] : mergeGeoms(built.glass);
    refs.glass = new THREE.Mesh(glassGeo, matGlass);
    bodyGroup.add(refs.glass);
  }

  // --- фары/фонари ---
  const front = built.lampFront, rear = built.lampRear;
  if (animated) {
    refs.head = front.map((a) => { const m = new THREE.Mesh(lampMesh(a), matHead); bodyGroup.add(m); return m; });
    refs.brake = rear.map((a) => { const m = new THREE.Mesh(lampMesh(a), matStop); bodyGroup.add(m); return m; });
    if (matTurnA && matTurnB) {
      // index 0 = сторона A (в threeBoxCar/boxVanCar это s=-1), index 1 = сторона B —
      // одна пара материалов на перед+зад одной стороны, чтобы мигать синхронно
      const turnMat = [matTurnA, matTurnB];
      refs.turnF = front.map((a, i) => { const m = new THREE.Mesh(lampMesh(insetAnchor(a)), turnMat[i]); bodyGroup.add(m); return m; });
      refs.turnR = rear.map((a, i) => { const m = new THREE.Mesh(lampMesh(insetAnchor(a)), turnMat[i]); bodyGroup.add(m); return m; });
    }
    if (matReverse && rear.length) {
      const ra = rear[0];
      const revA = { x: 0, y: ra.y, z: ra.z, w: ra.w * 0.6, h: ra.h * 0.5, d: ra.d };
      refs.reverse = new THREE.Mesh(lampMesh(revA), matReverse);
      bodyGroup.add(refs.reverse);
    }
  } else {
    if (front.length) bodyGroup.add(new THREE.Mesh(mergeGeoms(front.map(lampMesh)), matHead));
    if (rear.length) bodyGroup.add(new THREE.Mesh(mergeGeoms(rear.map(lampMesh)), matStop));
  }

  // --- номер ---
  if (hasPlate && built.plate && matPlate) {
    const pg = new THREE.BoxGeometry(0.7, 0.26, 0.05).translate(built.plate.x, built.plate.y, built.plate.z);
    bodyGroup.add(new THREE.Mesh(pg, matPlate));
  }

  // --- декаль/ливрея: полоса по обоим бортам ---
  // animated (игрок): anchor строится ВСЕГДА, независимо от hasLivery — декаль
  // выбирается в гараже (см. player.js:_applyTuning, читает built.refs.decal),
  // видимость и текстура matLivery.map переключаются без пересборки геометрии.
  // hasLivery для animated тут больше не участвует — он лишь определяет
  // ДЕФОЛТ выбора декали (taxi -> 'checker', остальные -> 'none', см.
  // upgrades.js). НЕ-animated (трафик): поведение НЕ меняем — anchor строится
  // только при hasLivery (запечённые шашечки такси), как и раньше.
  if (built.liveryStripe && matLivery && (animated || hasLivery)) {
    const ls = built.liveryStripe;
    const decalGroup = animated ? new THREE.Group() : null;
    for (const s of [-1, 1]) {
      const g = new THREE.PlaneGeometry(ls.w, ls.h);
      // нормаль плоскости по умолчанию (0,0,1); разворачиваем наружу от борта
      g.rotateY(s > 0 ? Math.PI / 2 : -Math.PI / 2);
      g.translate(s * (w / 2 + 0.012), ls.y, ls.z);
      const mesh = new THREE.Mesh(g, matLivery);
      if (decalGroup) decalGroup.add(mesh); else bodyGroup.add(mesh);
    }
    if (decalGroup) { bodyGroup.add(decalGroup); refs.decal = decalGroup; }
  }

  // --- плафон "ТАКСИ" на крыше ---
  if (hasSign && built.roofSign && matSign) {
    const rs = built.roofSign;
    const g = new THREE.BoxGeometry(0.5, 0.2, 0.32).translate(rs.x, rs.y, rs.z);
    refs.sign = new THREE.Mesh(g, matSign);
    bodyGroup.add(refs.sign);
  }

  // --- маячок спецтранспорта (полиция/скорая) ---
  if (beacon && built.roofSign && matBeaconRed && matBeaconBlue) {
    const rs = built.roofSign;
    const barGeo = () => new THREE.BoxGeometry(0.4, 0.13, 0.2);
    refs.beaconRed = new THREE.Mesh(barGeo().translate(rs.x - 0.1, rs.y, rs.z), matBeaconRed);
    refs.beaconBlue = new THREE.Mesh(barGeo().translate(rs.x + 0.1, rs.y, rs.z), matBeaconBlue);
    bodyGroup.add(refs.beaconRed, refs.beaconBlue);
  }

  // --- боди-кит (сплиттер + пороги, bodyKit: 'stock'|'sport') ---
  if (animated) {
    // в отличие от rimVariants (3 стиля) тут всего 2 состояния (пусто/полный
    // обвес) — строим сразу "полный" sport-вариант как отдельную группу и
    // переключаем видимость всей группы целиком; player.js:_applyTuning()
    // читает refs.bodyKit и не требует пересборки геометрии кузова.
    const kitParts = bodyKitParts({ w, len, wheelR: built.wheel.r }, 'sport');
    if (kitParts.length) {
      const kitGroup = new THREE.Group();
      for (const { g } of kitParts) kitGroup.add(new THREE.Mesh(g, matDark));
      kitGroup.visible = bodyKit === 'sport';
      bodyGroup.add(kitGroup);
      refs.bodyKit = kitGroup;
    }
  } else {
    // трафик: детали (если bodyKit==='sport') сразу сливаются в staticColored
    // вместе с кузовом/колёсами — mergeColored() ниже даёт единственный draw call
    for (const { g } of bodyKitParts({ w, len, wheelR: built.wheel.r }, bodyKit)) {
      staticColored.push({ g, c: darkColor });
    }
  }

  // --- колёса ---
  const wheels = [];
  const steerPivots = [];
  const wr = built.wheel.r, wtw = built.wheel.tw;
  const layout = [
    [-built.wheel.front.x, built.wheel.front.z, true],
    [built.wheel.front.x, built.wheel.front.z, true],
    [-built.wheel.rear.x, built.wheel.rear.z, false],
    [built.wheel.rear.x, built.wheel.rear.z, false],
  ];

  if (animated) {
    // геометрия БЕЗ запечённого поворота: ориентация задаётся mesh.rotation.z
    // (как и раньше в player.js), потому что колесо ещё будет крутиться
    // покадрово вокруг локального X — запекать поворот в геометрию для
    // анимируемого колеса нельзя (сломает ось вращения, см. NPC-ветку ниже,
    // где геометрия статична и запекать безопасно).
    const tireGeo = new THREE.CylinderGeometry(wr, wr, wtw, 12);
    const rimR = wr * 0.58, rimTw = wtw + 0.035;
    const discGeo = new THREE.CylinderGeometry(rimR, rimR, rimTw, 10);
    // все 3 стиля диска строятся сразу (а не только выбранный rimStyle) —
    // player.js:_applyTuning() переключает видимость без пересборки геометрии
    // кузова при смене тюнинга (см. wheels[i].rimVariants)
    const spokeGeo = matRim ? mergeGeoms([discGeo, ...rimSpokeBars(rimR, rimTw)]) : null;
    for (const [sx, sz, isFront] of layout) {
      const tw3 = new THREE.Mesh(tireGeo, matDark);
      tw3.rotation.z = Math.PI / 2;
      tw3.userData.front = isFront;
      if (matRim) {
        const rimVariants = {
          disc: new THREE.Mesh(discGeo, matRim),
          spoke: new THREE.Mesh(spokeGeo, matRim),
          chrome: new THREE.Mesh(discGeo, matChrome || matRim),
        };
        for (const key in rimVariants) {
          rimVariants[key].visible = key === rimStyle;
          tw3.add(rimVariants[key]);
        }
        tw3.rimVariants = rimVariants;
      }
      if (isFront) {
        const pivot = new THREE.Group();
        pivot.position.set(sx, wr, sz);
        pivot.add(tw3);
        group.add(pivot);
        steerPivots.push(pivot);
      } else {
        tw3.position.set(sx, wr, sz);
        group.add(tw3);
        steerPivots.push(null);
      }
      wheels.push(tw3);
    }
  } else {
    // колёса NPC не вращаются (см. traffic.js) — сливаем их вместе с кузовом
    // в один-единственный vertexColors-меш вместо отдельного draw call.
    // Снаружи тёмная шина (tireColor), внутри — диск (rimColor).
    const rimBakedColor = rimStyle === 'chrome' ? chromeColor : rimColor;
    for (const [sx, sz] of layout) {
      staticColored.push({ g: wheelGeo(wr, wtw, 10).translate(sx, wr, sz), c: tireColor });
      staticColored.push({ g: buildStaticRimGeo(rimStyle, wr * 0.58, wtw + 0.035, 8).translate(sx, wr, sz), c: rimBakedColor });
    }
    const cacheKey = spec.cacheKey || `${shape}|${w}|${len}|${bodyColor}|${darkColor}|${chromeColor}|${tireColor}|${rimColor}|${rimStyle}|${bodyKit}`;
    const mergedGeo = getBodyGeometry(cacheKey, () => mergeColored(staticColored));
    bodyGroup.add(new THREE.Mesh(mergedGeo, matBody));
  }

  return { group, bodyGroup, wheels, steerPivots, refs, wheelR: wr };
}

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
   как [{g}] (без role — все детали здесь всегда красятся в 'dark', см.
   consumption sites в buildCarModel; roleParts-диспетчер используют только
   CAR_SHAPES-детали): animated — отдельные меши в скрываемой группе,
   НЕ-animated — сливаются в staticColored вместе с кузовом. */
/* --- Багажник на крыше (roofRack) ----------------------------------------
   Строится в buildCarModel (не в threeBoxCar/boxVanCar), потому что нужен
   ОДИН приём геометрии для обеих фабрик — зависит только от anchor'а
   built.roofRack (см. threeBoxCar/boxVanCar, паттерн как у roofSign) и
   ширины машины. Фабрика возвращает anchor только если её силуэт разрешает
   багажник (per-shape опция roofRackOk в CAR_SHAPES — wagon/suv/van), иначе
   built.roofRack === null и buildCarModel ничего не строит независимо от
   spec.hasRoofRack. 2 продольных рельса вдоль anchor.z + 2 поперечные дуги. */
function roofRackParts(rr, w) {
  const railW = w * 0.72;
  const parts = [];
  for (const s of [-1, 1]) {
    parts.push({ g: new THREE.BoxGeometry(0.04, 0.035, rr.len).translate(rr.x + s * railW / 2, rr.y, rr.z) });
  }
  for (const s of [-1, 1]) {
    parts.push({ g: new THREE.BoxGeometry(railW + 0.04, 0.03, 0.04).translate(rr.x, rr.y, rr.z + s * rr.len * 0.32) });
  }
  return parts;
}

function bodyKitParts(dims, kit) {
  if (kit !== 'sport') return [];
  const { w, len, wheelR = 0.38 } = dims;
  const y = wheelR * 0.5;
  const parts = [
    // передний сплиттер
    { g: new THREE.BoxGeometry(w * 1.06, wheelR * 0.22, 0.22).translate(0, y, len / 2 + 0.06) },
  ];
  // пороги
  for (const s of [-1, 1]) {
    parts.push({ g: new THREE.BoxGeometry(0.12, wheelR * 0.3, len * 0.52).translate(s * (w / 2 + 0.03), y, 0) });
  }
  return parts;
}

const insetAnchor = (a) => ({
  x: a.x - Math.sign(a.x) * a.w * 0.55, y: a.y, z: a.z, w: a.w * 0.46, h: a.h * 0.68, d: a.d,
});
const lampMesh = (a) => new THREE.BoxGeometry(a.w, a.h, a.d).translate(a.x, a.y, a.z);

/* --- Относительные вариации силуэта -------------------------------------
   Опция вида `<имя>Delta` не задаёт значение, а ПРИБАВЛЯЕТСЯ к базовому
   значению одноимённой опции конкретного силуэта (базы у sedan/suv/coupe и
   т.д. разные, см. CAR_SHAPES). Так одна таблица дельт работает на всё
   семейство силуэтов, а вызывающая сторона (traffic.js) не обязана знать
   базовые значения каждого силуэта. Механизм общий для threeBoxCar и
   boxVanCar и автоматически подхватывает любую новую числовую опцию. */
const _badDeltaWarned = new Set();
function applyOptDeltas(opt, o) {
  for (const k in o) {
    if (!k.endsWith('Delta')) continue;
    const base = k.slice(0, -5);
    if (typeof opt[base] === 'number') { opt[base] += o[k]; continue; }
    /* Нераспознанную дельту (опечатка `cargoHeighDelta`, дельта к нечисловой
       опции `openBedDelta`) проглатывать нельзя: геометрия не изменится, а
       carGeoCacheKey всё равно сериализует ДРУГОЙ shapeOpts — в кэше появится
       запись, байт-в-байт дублирующая существующую геометрию, а вариант тихо
       станет "мёртвым". Это ровно тот класс рассинхрона, который лечит
       carGeoCacheKey, поэтому шумим. Один раз на ключ — иначе спам на каждый
       спавн машины. */
    if (!_badDeltaWarned.has(k)) {
      _badDeltaWarned.add(k);
      console.warn(`carmodel: дельта "${k}" не применена — опции "${base}" нет у силуэта или она не числовая`);
    }
  }
  return opt;
}

/* ========================================================================
   Профили силуэтов. threeBoxCar — легковые (капот/салон/багажник),
   boxVanCar — кабина-над-двигателем (фургон/автобус/пикап/грузовик).
   Обе возвращают { parts:[{g,role}], glass:[geom], wheel, lampFront,
   lampRear, roofSign, liveryStripe, plate } — геометрия уже "запечена"
   (translate применён), поэтому части можно как слить, так и оставить
   раздельными мешами без потери позиционирования. ======================= */

function threeBoxCar(dims, o = {}) {
  const { w, len } = dims;
  const opt = applyOptDeltas({
    deckY: 0.72, deckH: 0.42, beltW: 0.98,
    hoodFrac: 0.32, hoodRise: -0.30,
    trunkFrac: 0.28, trunkRise: -0.30,
    cabW: 0.86, cabH: 0.46, cabY: 1.32, cabTopWfrac: 0.9, cabDZfrac: -0.02,
    roofW: 0.78, roofH: 0.1, roofY: 1.58, roofFrac: 0.4, roofDZfrac: -0.02,
    chromeBumper: false, chromeTrim: false, wheelR: 0.38,
    hasExhaust: false, roofRackOk: false,
    ...o,
  }, o);
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
    // зеркало: корпус (тот же anchor, что и у прежнего плейсхолдера) + ножка
    // крепления между бортом и корпусом зеркала — ножка всегда 'dark'
    // (пластиковый кронштейн), даже если сам корпус хромирован (chromeTrim)
    add(new THREE.BoxGeometry(0.14, 0.1, 0.16).translate(s * (w / 2 + 0.07), opt.cabY - opt.cabH * 0.3, len * 0.12), opt.chromeTrim ? 'chrome' : 'dark');
    add(new THREE.BoxGeometry(0.05, 0.045, 0.05).translate(s * (w / 2 + 0.03), opt.cabY - opt.cabH * 0.3, len * 0.12), 'dark');
    add(new THREE.BoxGeometry(0.03, 0.06, 0.32).translate(s * (w * opt.beltW / 2 + 0.015), opt.deckY + 0.1, 0), 'dark');
    // шов дверей — тонкая инсетная тёмная полоса вдоль борта (тот же приём,
    // что у chromeTrim ниже, но безусловная НОВАЯ деталь, не завязанная на
    // chromeTrim: вертикальная линия у границы дверей, а не горизонтальный пояс)
    add(new THREE.BoxGeometry(0.025, opt.deckH * 0.86, 0.03).translate(s * (w * opt.beltW / 2 + 0.008), opt.deckY, len * 0.02), 'dark');
  }
  if (opt.chromeTrim) {
    add(new THREE.BoxGeometry(w * opt.beltW + 0.02, 0.035, len * 0.7).translate(0, opt.deckY + opt.deckH * 0.5, 0), 'chrome');
  }
  if (opt.hasExhaust) {
    // выхлопная труба — маленький цилиндр под задним бампером (sedan/coupe/hatch).
    // Y считаем ОТ САМОГО БАМПЕРА (см. bumperRole-блок выше: центр
    // deckY - deckH*0.42, полу-высота 0.08), а не от deckY напрямую — иначе
    // при разных deckY/deckH у sedan/coupe/hatch труба рискует снова
    // оказаться внутри bounding box бампера. -0.15 = -0.08 (низ бампера) -
    // 0.05 (радиус трубы) - 0.02 (зазор) — труба гарантированно ЦЕЛИКОМ
    // ниже бампера по Y (не спрятана внутри его объёма), Z чуть смещён
    // назад, чтобы кончик трубы также торчал за задний край бампера.
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 8).rotateX(Math.PI / 2)
      .translate(w * 0.22, opt.deckY - opt.deckH * 0.42 - 0.15, -(len / 2 + 0.10)), 'dark');
  }

  const lampFront = [-1, 1].map((s) => ({ x: s * w * 0.32, y: opt.deckY, z: len / 2 + 0.045, w: 0.28, h: 0.15, d: 0.08 }));
  const lampRear = [-1, 1].map((s) => ({ x: s * w * 0.32, y: opt.deckY, z: -(len / 2 + 0.045), w: 0.26, h: 0.13, d: 0.08 }));

  return {
    parts, glass,
    wheel: { r: opt.wheelR, tw: 0.3, front: { x: w * 0.47, z: len * 0.31 }, rear: { x: w * 0.47, z: -len * 0.31 } },
    lampFront, lampRear,
    roofSign: { x: 0, y: opt.roofY + opt.roofH / 2 + 0.11, z: len * opt.roofDZfrac },
    // anchor только когда силуэт разрешает багажник (wagon/suv, roofRackOk
    // в CAR_SHAPES) — buildCarModel строит геометрию лишь при наличии anchor'а
    roofRack: opt.roofRackOk
      ? { x: 0, y: opt.roofY + opt.roofH / 2 + 0.05, z: len * opt.roofDZfrac, len: len * opt.roofFrac * 0.85 }
      : null,
    liveryStripe: { y: opt.deckY, z: 0, w: len * 0.82, h: opt.deckH * 0.62 },
    plate: { x: 0, y: opt.deckY - 0.06, z: -(len / 2 + 0.05) },
  };
}

function boxVanCar(dims, o = {}) {
  const { w, len } = dims;
  const opt = applyOptDeltas({
    deckY: 0.62, deckH: 0.4,
    cabLenFrac: 0.22, cabH: 0.9, cabY: 1.05, windshieldRise: -0.28,
    cargoLenFrac: 0.68, cargoH: 1.5, cargoY: 1.35,
    openBed: false, bedWallH: 0.35, sideGlass: false, wheelR: 0.38,
    roofRackOk: false,
    ...o,
  }, o);
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
    // зеркало: корпус (тот же anchor, что и у прежнего плейсхолдера) + ножка
    // крепления, тот же приём, что в threeBoxCar
    add(new THREE.BoxGeometry(0.14, 0.1, 0.16).translate(s * (w / 2 + 0.07), opt.cabY - 0.05, len / 2 - cabLen * 0.5), 'dark');
    add(new THREE.BoxGeometry(0.05, 0.045, 0.05).translate(s * (w / 2 + 0.03), opt.cabY - 0.05, len / 2 - cabLen * 0.5), 'dark');
    // шов дверей — тонкая инсетная тёмная полоса вдоль борта кабины
    add(new THREE.BoxGeometry(0.025, opt.cabH * 0.55, 0.03).translate(s * (w * 0.94 / 2 + 0.008), opt.cabY - opt.cabH * 0.05, len / 2 - cabLen * 0.5), 'dark');
  }

  const lampFront = [-1, 1].map((s) => ({ x: s * w * 0.34, y: opt.deckY, z: len / 2 + 0.045, w: 0.26, h: 0.16, d: 0.08 }));
  const lampRear = [-1, 1].map((s) => ({ x: s * w * 0.34, y: opt.deckY, z: -(len / 2 + 0.045), w: 0.24, h: 0.15, d: 0.08 }));

  return {
    parts, glass,
    wheel: { r: opt.wheelR, tw: 0.3, front: { x: w * 0.47, z: len / 2 - cabLen * 0.55 }, rear: { x: w * 0.47, z: -(len / 2 - cabLen - (opt.openBed ? (len - cabLen) * 0.4 : cargoLen * 0.35)) } },
    lampFront, lampRear,
    roofSign: { x: 0, y: opt.cabY + opt.cabH / 2 + 0.13, z: len / 2 - cabLen * 0.5 },
    // над ГРУЗОВЫМ ОТСЕКОМ (не над кабиной, как roofSign) — иначе накладывался
    // бы на плафон такси/маячок у машин с hasSign/beacon (см. бриф Task 7)
    roofRack: opt.roofRackOk
      ? { x: 0, y: opt.cargoY + opt.cargoH / 2 + 0.06, z: cargoZ, len: cargoLen * 0.8 }
      : null,
    liveryStripe: { y: opt.deckY + 0.1, z: -0.1, w: len * 0.7, h: opt.deckH * 0.7 },
    plate: { x: 0, y: opt.deckY - 0.04, z: -(len / 2 + 0.05) },
  };
}

/* Второй аргумент (o) — внешние опции силуэта (spec.shapeOpts в buildCarModel):
   прозрачно доходят до threeBoxCar/boxVanCar и ПЕРЕКРЫВАЮТ базовые опции
   конкретного силуэта. Без него (игрок, старые вызовы) поведение прежнее. */
export const CAR_SHAPES = {
  sedan: (d, o) => threeBoxCar(d, { hasExhaust: true, ...o }),
  hatch: (d, o) => threeBoxCar(d, {
    trunkFrac: 0.13, trunkRise: -0.36, roofFrac: 0.52, cabDZfrac: -0.06, roofDZfrac: -0.08, hasExhaust: true, ...o,
  }),
  wagon: (d, o) => threeBoxCar(d, {
    trunkFrac: 0.22, trunkRise: -0.05, roofFrac: 0.62, roofDZfrac: -0.1, cabTopWfrac: 0.94, roofRackOk: true, ...o,
  }),
  coupe: (d, o) => threeBoxCar(d, {
    deckY: 0.66, deckH: 0.38, cabY: 1.2, cabH: 0.4, roofY: 1.42,
    hoodFrac: 0.4, trunkFrac: 0.34, cabDZfrac: -0.08, cabTopWfrac: 0.8, roofFrac: 0.24, hasExhaust: true, ...o,
  }),
  suv: (d, o) => threeBoxCar(d, {
    deckY: 0.92, deckH: 0.5, cabY: 1.58, cabH: 0.56, roofY: 1.9, roofH: 0.12,
    roofFrac: 0.58, cabTopWfrac: 0.96, hoodFrac: 0.28, trunkFrac: 0.24, wheelR: 0.44, roofRackOk: true, ...o,
  }),
  retro: (d, o) => threeBoxCar(d, {
    cabTopWfrac: 0.96, cabDZfrac: 0, roofFrac: 0.34, hoodRise: -0.16, trunkRise: -0.16, chromeBumper: true, ...o,
  }),
  premium: (d, o) => threeBoxCar(d, {
    deckY: 0.68, deckH: 0.4, cabY: 1.22, cabH: 0.42, roofY: 1.46,
    hoodFrac: 0.4, trunkFrac: 0.32, cabTopWfrac: 0.86, roofFrac: 0.3, chromeTrim: true, ...o,
  }),
  van: (d, o) => boxVanCar(d, { sideGlass: true, roofRackOk: true, ...o }),
  bus: (d, o) => boxVanCar(d, {
    cabLenFrac: 0.16, cabH: 1.1, cabY: 1.15, cargoLenFrac: 0.8, cargoH: 1.65, cargoY: 1.45, sideGlass: true, ...o,
  }),
  pickup: (d, o) => boxVanCar(d, { openBed: true, cabLenFrac: 0.36, cabH: 1.0, ...o }),
  truck: (d, o) => boxVanCar(d, {
    cabLenFrac: 0.2, cabH: 1.15, cabY: 1.2, cargoLenFrac: 0.72, cargoH: 1.9, cargoY: 1.58, sideGlass: false, ...o,
  }),
};

/* --- Таблицы дискретных вариантов силуэта (борьба с клоновостью) ---------
   Вариация НЕ случайный float, а фиксированный индекс в маленькой таблице —
   иначе cacheKey (см. carGeoCacheKey) стал бы бесконечным множеством, и
   _bodyGeoCache рос бы на каждый спавн. Значения — ОТНОСИТЕЛЬНЫЕ дельты
   (см. applyOptDeltas), поэтому одна таблица корректна для всего семейства
   силуэтов: coupe с hoodFrac 0.4 и suv с 0.28 получают одинаковый по смыслу
   разброс "±2 шага" от своей базы. Вариант 0 — базовый силуэт (пустые опции). */
const VARIANTS_THREEBOX = [  // шаг 0.02 по hoodFrac/roofFrac
  {},
  { hoodFracDelta: 0.04, roofFracDelta: -0.02 },
  { hoodFracDelta: -0.04, roofFracDelta: 0.02 },
  { hoodFracDelta: 0.02, roofFracDelta: 0.04 },
  { hoodFracDelta: -0.02, roofFracDelta: -0.04 },
];
/* У boxVanCar нет hoodFrac/roofFrac — вариация идёт по длине кабины/кузова и
   высоте фургона. cabLen и cargoLen меняются в противофазе, чтобы сумма
   "кабина+кузов" не вылезала за габарит len. cargoH у pickup (openBed) не
   используется — поэтому у каждого варианта СВОЯ дельта cabLenFrac, иначе
   пикапы разных вариантов дали бы одинаковую геометрию под разными ключами. */
const VARIANTS_BOXVAN = [    // шаг 0.015 по длинам, 0.08 по высоте кузова
  {},
  { cabLenFracDelta: 0.03, cargoLenFracDelta: -0.03, cargoHDelta: 0.08 },
  { cabLenFracDelta: -0.03, cargoLenFracDelta: 0.03, cargoHDelta: -0.08 },
  { cabLenFracDelta: 0.015, cargoLenFracDelta: -0.015, cargoHDelta: -0.16 },
  { cabLenFracDelta: -0.015, cargoLenFracDelta: 0.015, cargoHDelta: 0.16 },
];
const _variantsFor = (keys, table) => Object.fromEntries(keys.map((k) => [k, table]));

/** Силуэт (ключ CAR_SHAPES) -> таблица вариантов; индекс в таблице = variantIdx. */
export const SHAPE_VARIANTS = {
  ..._variantsFor(['sedan', 'hatch', 'wagon', 'coupe', 'suv', 'retro', 'premium'], VARIANTS_THREEBOX),
  ..._variantsFor(['van', 'bus', 'pickup', 'truck'], VARIANTS_BOXVAN),
};

/** Таблица вариантов силуэта (для неизвестного силуэта — как у sedan). */
export function shapeVariants(shape) {
  return SHAPE_VARIANTS[shape] || VARIANTS_THREEBOX;
}

/* --- Ключ кэша слитой геометрии ------------------------------------------
   ЕДИНСТВЕННЫЙ источник правды о том, "что влияет на слитую геометрию":
   поля spec, попадающие в staticColored -> mergeColored() (кузов/тёмные/
   хром-детали/обвес/колёса + запечённые в вершины цвета).
   Стёкла, фары/стопы, номер, плафон такси, маячок и decal-anchor кэш НЕ
   затрагивают (это отдельные меши вне staticColored) — их в ключе нет.

   Геометрические поля БЕЗ дефолта (обязан задать вызывающий) — перечислены
   в GEO_SPEC_REQUIRED и уходят в ключ как есть: подставлять им фиктивный
   дефолт нельзя, иначе spec с забытым w (геометрия NaN) получил бы тот же
   ключ, что и валидный spec с w из дефолта.
   Поля С дефолтом — в GEO_SPEC_DEFAULTS; ЭТИ ЖЕ значения используются как
   дефолты деструктуризации в buildCarModel ниже (все до единого), поэтому
   разъехаться они не могут.
   Добавляешь новый геометрический параметр (напр. hasRoofRack) — дописываешь
   ОДНУ строку в один из двух списков, и он автоматически попадает в ключ. */
const GEO_SPEC_REQUIRED = ['shape', 'w', 'len'];
const GEO_SPEC_DEFAULTS = {
  bodyColor: 0xcccccc, darkColor: 0x22262c, chromeColor: 0xc8c8c8,
  tireColor: 0x18181a, rimColor: 0xc4c8cc,
  rimStyle: 'disc', bodyKit: 'stock',
  shapeOpts: null,
  hasRoofRack: false,
};

/* Значения сериализуем рекурсивно: объекты (shapeOpts) — по отсортированным
   ключам, чтобы порядок полей не менял ключ. */
function _geoKeyVal(v) {
  if (v === null || typeof v !== 'object') return String(v);
  return Object.keys(v).sort().map((k) => `${k}=${_geoKeyVal(v[k])}`).join(',');
}

/**
 * Детерминированный ключ кэша слитой геометрии кузова по spec.
 * Одинаковый spec -> одинаковый ключ; любое отличие в геометрически значимом
 * поле -> другой ключ (см. GEO_SPEC_DEFAULTS).
 * @param {Object} spec - тот же объект, что уходит в buildCarModel
 * @returns {string}
 */
export function carGeoCacheKey(spec) {
  // неизвестный силуэт собирается как sedan (см. buildCarModel) — нормализуем,
  // чтобы ключ описывал ФАКТИЧЕСКИ построенную геометрию
  const shape = CAR_SHAPES[spec.shape] ? spec.shape : 'sedan';
  const req = GEO_SPEC_REQUIRED.map((k) => _geoKeyVal(k === 'shape' ? shape : spec[k]));
  const opt = Object.keys(GEO_SPEC_DEFAULTS).map((k) => _geoKeyVal(spec[k] ?? GEO_SPEC_DEFAULTS[k]));
  return [...req, ...opt].join('|');
}

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
 * @param {Object} [spec.shapeOpts] - доп. опции силуэта, прозрачно доходят до
 *   threeBoxCar/boxVanCar и перекрывают базовые опции силуэта (см. CAR_SHAPES).
 *   Опции вида `<имя>Delta` прибавляются к базовому значению соответствующей
 *   опции (см. applyOptDeltas) — так работает дискретная вариация силуэта
 *   трафика (SHAPE_VARIANTS). Игрок его не передаёт — геометрия как раньше.
 * @param {boolean} [spec.hasPlate=true]
 * @param {boolean} [spec.hasSign=false] - плафон "ТАКСИ"
 * @param {boolean} [spec.hasLivery=false] - шашечки по бортам. Для animated (игрок)
 *   anchor-меш декали строится ВСЕГДА независимо от этого флага (built.refs.decal) —
 *   hasLivery здесь ни на что не влияет (дефолт выбора декали считает upgrades.js).
 *   Для НЕ-animated (трафик) поведение прежнее: anchor строится только при hasLivery===true.
 * @param {string|null} [spec.beacon] - 'police'|'ambulance'|null — маячок на крыше
 * @param {boolean} [spec.hasRoofRack=false] - багажник на крыше. Геометрически значим
 *   (меняет staticColored/статичную сборку трафика), поэтому участвует в GEO_SPEC_DEFAULTS
 *   и carGeoCacheKey. Реально строится только когда И spec.hasRoofRack===true, И силуэт
 *   разрешает багажник (built.roofRack !== null — см. per-shape опцию roofRackOk у
 *   wagon/suv/van в CAR_SHAPES); для остальных силуэтов флаг ни на что не влияет.
 */
export function buildCarModel(spec) {
  const {
    shape, w, len, animated = false,
    matBody, matDark, matChrome, matGlass,
    matHead, matStop, matTurnA, matTurnB, matReverse,
    matRim, matHub, matPlate, matSign, matLivery,
    matBeaconRed, matBeaconBlue,
    bodyColor = GEO_SPEC_DEFAULTS.bodyColor, darkColor = GEO_SPEC_DEFAULTS.darkColor,
    chromeColor = GEO_SPEC_DEFAULTS.chromeColor, tireColor = GEO_SPEC_DEFAULTS.tireColor,
    rimColor = GEO_SPEC_DEFAULTS.rimColor,
    rimStyle = GEO_SPEC_DEFAULTS.rimStyle, bodyKit = GEO_SPEC_DEFAULTS.bodyKit,
    shapeOpts = GEO_SPEC_DEFAULTS.shapeOpts,
    hasPlate = true, hasSign = false, hasLivery = false, beacon = null,
    hasRoofRack = GEO_SPEC_DEFAULTS.hasRoofRack,
  } = spec;

  const shapeFn = CAR_SHAPES[shape] || CAR_SHAPES.sedan;
  const built = shapeFn({ w, len }, shapeOpts || {});

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

  // --- багажник на крыше (wagon/suv/van, spec.hasRoofRack) ---
  // built.roofRack !== null только когда силуэт разрешает багажник
  // (roofRackOk в CAR_SHAPES) — hasRoofRack на прочих силуэтах не даёт эффекта
  if (hasRoofRack && built.roofRack) {
    const rackParts = roofRackParts(built.roofRack, w);
    if (animated) {
      const rackGroup = new THREE.Group();
      for (const { g } of rackParts) rackGroup.add(new THREE.Mesh(g, matDark));
      bodyGroup.add(rackGroup);
      refs.roofRack = rackGroup;
    } else {
      for (const { g } of rackParts) staticColored.push({ g, c: darkColor });
    }
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
    // ключ считает carGeoCacheKey по самому spec — единственное место, знающее
    // список геометрически значимых полей (см. GEO_SPEC_DEFAULTS). Вызывающая
    // сторона свой ключ не собирает (иначе два шаблона разъедутся).
    const mergedGeo = getBodyGeometry(carGeoCacheKey(spec), () => mergeColored(staticColored));
    bodyGroup.add(new THREE.Mesh(mergedGeo, matBody));
  }

  return { group, bodyGroup, wheels, steerPivots, refs, wheelR: wr };
}

import * as THREE from 'three';
import { CFG } from './config.js';
import { rand, clamp, choice, lerpAngle, makePlateTexture, makeTaxiSignTexture, makeCheckerStripTexture, makeSpeechSprite, updateSpeechSprite, isInPlayerView } from './utils.js';
import { buildCarModel, shapeVariants } from './carmodel.js';
import { Events } from './eventbus.js';

const _tempTrafficWp = { x: 0, z: 0 };
const _tempTrafficFrom = { x: 0, z: 0 };
const _tempTrafficTo = { x: 0, z: 0 };
const _tempLightRet = { dist: 0, state: 0 };

const DRIVER_RAM_QUOTES = [
  "Куда прёшь, дрова везёшь?!",
  "Смотри куда рулишь, шумахер!",
  "Права за салом купил?!",
  "Эй! Машину помнёшь!",
  "Ты у меня щас за ремонт заплатишь!",
  "Тормоза проверь, ведро!",
  "Ослеп что ли, осел?!",
  "Вай, Приору мою помял, шакал!",
  "Ты где так подрезать учился, а?!",
  "Слышь, бампер мне выпрямлять за свой счет будешь!",
  "Твою ж... Совсем страх потерял на дороге?!",
  "Эй, чучело на желтом такси, стой говорю!",
  "Мамой клянусь, щас вылезу и фары тебе разобью!",
  "Куда ты лезешь, видишь едет машина?!",
  "Вай-бай, новый крыло помял, гад!",
  "Ты на такси или на танке?!",
  "Слышь, у меня тут пассажиры, а ты в багажник лезешь!",
  "Вай, зачем так близко, я же не маршрутка!",
  "Ты в зеркала вообще смотришь, джигит?!",
  "Эй, жёлтое такси, ты на подъёме тормозить умеешь?!"
];

const DRIVER_PED_QUOTES = [
  "Куда под колёса лезешь?!",
  "Шевелись на зебре!",
  "Зелёный не вечный!",
  "Давай быстрей, сайгак!",
  "Смотри по сторонам, пешеход!",
  "Эй, сайгак, ноги в руки и бегом!",
  "Шевели поршнями, зелёный кончается!",
  "Твою ж... Оглянись, тут машина едет!",
  "Эй, курортник, на Машуке зебр нет, а тут есть!",
  "Слышь, ушей натянул, сигнала не слышишь?!"
];

// Водитель ругает пешехода, который переходит ВНЕ зебры (нарушитель)
const DRIVER_PED_JWALK_QUOTES = [
  "Куда прешь вне зебры, жить надоело?!",
  "Тут зебры нет, а ты прёшь!",
  "Эй, нарушитель, на переходе иди!",
  "Вне зебры переходишь, джигит?!",
  "Слышь, тут не зебра, а ты прёшь под колёса!",
  "Куда внаглую через дорогу, светофор для тебя не писан?!"
];

const DRIVER_HIT_PED_QUOTES = [
  "Ослеп что ли под колёса прыгать?!",
  "Куда выскочил, осел?!",
  "Сумасшедший! Чуть насмерть не сбил!",
  "Вай, за что-о-о?! Под колеса сам бросился!",
  "Ты с ума сшел?! На капот мне прыгнул!",
  "Твою ж дивизию! Живой хоть, сайгак?!",
  "Эй, разуй глаза! Я же тормозил как мог!",
  "Мамой клянусь, он сам под машину выскочил!",
  "Вай, я же не нарочно! Смотри по сторонам!",
  "Ты куда смотрел, тут же машина едет!",
  "Эй, живой?! Я чуть инфаркт не получил!",
  "Слышь, наушники вынь, тут дорога!"
];

const PED_REPLY_QUOTES = [
  "На зебре я главный!",
  "Подождёшь, не трамвай!",
  "Красный горит, куда сигналишь?!",
  "Не дрова везёшь, подождёшь!",
  "Сам пешком иди!",
  "Сигналит он еще, баран на педалях!",
  "Потише газуй, у меня нарзан прольется!",
  "Права в Ессентуках купил и умничает!",
  "Слышь, пешеход всегда прав, запомни!",
  "Пешком походи, остынь, джигит!",
  "Эй, колымага, тормоза сначала почини!"
];

// Ответ пешехода-нарушителя, которого водитель отчитал за переход вне зебры
const PED_REPLY_JWALK_QUOTES = [
  "А мне всё равно, тут все так ходят!",
  "Ты не ГАИ, чтобы меня учить!",
  "Спешу я, понял?! Не до твоих зебр!",
  "Вот ещё, буду я на тебя смотреть!",
  "Сам нарушаешь, а меня учишь!",
  "Тормози заранее, я тут хозяин!",
  "Вай, иди своей дорогой, джигит!"
];

/* Типы трафика: силуэт (carmodel.js CAR_SHAPES) + габариты + палитра + вес
   спавна (относительный, не обязан суммироваться в 100 — см. pickTrafficType).
   forceColor — у машины фиксированный "служебный" цвет (полиция/такси/маршрутка),
   не выбирается случайно из палитры. beacon — маячок на крыше. livery —
   шашечки по бортам + плафон "ТАКСИ" (только у самого такси). bodyKit —
   'sport'|'stock' (см. carmodel.js bodyKitParts), по умолчанию 'stock'
   (см. _buildCar). */
export const TRAFFIC_TYPES = [
  // --- легковые ---
  { name: 'sedan', shape: 'sedan', r: 2.0, len: 4.4, w: 1.9, weight: 16, colors: [0xe8e8e8, 0x9aa0a8, 0x5060a0, 0xb03030, 0x2a2a2a, 0xc0a070] },
  { name: 'hatch', shape: 'hatch', r: 1.9, len: 4.0, w: 1.85, weight: 12, colors: [0xd0d0d0, 0x3a5aa0, 0xc03030, 0x2a2a2a, 0xe0c040] },
  { name: 'wagon', shape: 'wagon', r: 2.1, len: 4.6, w: 1.9, weight: 8, colors: [0x4a5a4a, 0x8a8a90, 0x2a2a2a, 0xa0703a] },
  { name: 'coupe', shape: 'coupe', r: 1.9, len: 4.3, w: 1.88, weight: 5, colors: [0xc02030, 0x1a1a1a, 0xd8d8d8, 0x2050a0] },
  { name: 'coupe_sport', shape: 'coupe', r: 1.95, len: 4.35, w: 1.92, weight: 3, colors: [0xe8c000, 0x141414, 0xf0f0f0, 0xc02030], bodyKit: 'sport' },
  { name: 'suv', shape: 'suv', r: 2.3, len: 4.8, w: 2.0, weight: 10, colors: [0x3a4a3a, 0x505860, 0x8a7050, 0x2a2a2a] },
  { name: 'suv_sport', shape: 'suv', r: 2.35, len: 4.75, w: 2.05, weight: 3, colors: [0x141414, 0xf4f4f4, 0xb02020], bodyKit: 'sport' },
  // --- бизнес/премиум ---
  { name: 'cab_black', shape: 'sedan', r: 2.05, len: 4.6, w: 1.92, weight: 4, colors: [0x141414, 0x1c2438, 0x2a2a2a, 0x203020] },
  { name: 'limo', shape: 'sedan', r: 2.2, len: 6.2, w: 1.95, weight: 0.6, colors: [0x101010, 0xf0f0f0] },
  // --- коммерческий транспорт ---
  { name: 'van', shape: 'van', r: 2.3, len: 5.2, w: 2.1, weight: 7, colors: [0xd8d8d0, 0xa8b8a0, 0xc8a060, 0xe8e0d0] },
  { name: 'pickup', shape: 'pickup', r: 2.2, len: 5.0, w: 1.95, weight: 4, colors: [0x5a5a5a, 0xa03030, 0x2a2a2a, 0xc8c8c0] },
  { name: 'truck', shape: 'truck', r: 2.6, len: 7.0, w: 2.3, weight: 5, colors: [0x6a7a8a, 0x9a6a4a, 0x4a5a6a] },
  // --- общественный/спецтранспорт ---
  { name: 'marshrutka', shape: 'van', r: 2.3, len: 5.4, w: 2.05, weight: 4, colors: [0xf0f0f0], forceColor: true },
  { name: 'bus', shape: 'bus', r: 2.9, len: 8.5, w: 2.35, weight: 2, colors: [0xe4e4e4], forceColor: true },
  { name: 'police', shape: 'sedan', r: 2.0, len: 4.4, w: 1.9, weight: 6, colors: [0xe8e8e8], forceColor: true, beacon: 'police', policeLivery: true },
  { name: 'ambulance', shape: 'van', r: 2.3, len: 5.0, w: 2.0, weight: 1, colors: [0xf4f4f0], forceColor: true, beacon: 'ambulance' },
  // --- ретро/советские ---
  { name: 'zhiguli', shape: 'retro', r: 1.9, len: 4.1, w: 1.75, weight: 9, colors: [0xd8c088, 0x6a4a6a, 0xa8c8d8, 0xc03030, 0xe8e4d0] },
  { name: 'volga', shape: 'retro', r: 2.1, len: 4.7, w: 1.85, weight: 5, colors: [0x2a3a2a, 0x1a1a1a, 0xc8c0a8] },
  { name: 'bukhanka', shape: 'van', r: 2.1, len: 4.4, w: 1.9, weight: 3, colors: [0xa8c8d8, 0xe8e4d0, 0x4a6a4a] },
  // --- такси (жёлтая ливрея, как у игрока) ---
  { name: 'taxi', shape: 'sedan', r: 2.0, len: 4.4, w: 1.9, weight: 8, colors: [0xf2c12e], forceColor: true, livery: true },
];

const TRAFFIC_WEIGHT_TOTAL = TRAFFIC_TYPES.reduce((s, t) => s + t.weight, 0);
function pickTrafficType() {
  let r = Math.random() * TRAFFIC_WEIGHT_TOTAL;
  for (let i = 0; i < TRAFFIC_TYPES.length; i++) {
    r -= TRAFFIC_TYPES[i].weight;
    if (r <= 0) return i;
  }
  return TRAFFIC_TYPES.length - 1;
}

/**
 * Менеджер городского трафика (управление автомобилями NPC, перекрестками и светофорами).
 */
export class TrafficManager {
  /**
   * @param {THREE.Scene} scene - Трёхмерная сцена Three.js
   */
  constructor(scene) {
    this.scene = scene;
    /** @type {Array<Object>} список активных автомобилей трафика */
    this.cars = [];
    // Материалы общие на весь трафик (OPT-15) — carmodel.js сливает кузов+колёса
    // каждой NPC-машины в один vertexColors-меш на этом материале.
    this.matColored = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.matGlass = new THREE.MeshLambertMaterial({ color: 0x1c2836, transparent: true, opacity: 0.72 });
    this.matHead = new THREE.MeshLambertMaterial({ color: 0xfff8e0, emissive: 0x665522 });
    this.matStop = new THREE.MeshLambertMaterial({ color: 0xff2020, emissive: 0x551111 });
    this.matPlate = new THREE.MeshLambertMaterial({ map: makePlateTexture() });
    this.matSign = new THREE.MeshLambertMaterial({ map: makeTaxiSignTexture(), emissive: 0x806010, emissiveIntensity: 0.35 });
    this.matLivery = new THREE.MeshLambertMaterial({ map: makeCheckerStripTexture() });
    this.matBeaconRed = new THREE.MeshLambertMaterial({ color: 0x550000, emissive: 0xff2020, emissiveIntensity: 0.75 });
    this.matBeaconBlue = new THREE.MeshLambertMaterial({ color: 0x000555, emissive: 0x3060ff, emissiveIntensity: 0.75 });
    this.lightsRef = [];          // [{isec:{x,z}, state}] — от мира
    this._beaconT = 0;

    // Водители сигналят и ругаются при таране игроком
    Events.on('crash', (d) => {
      if (d && d.victim === 'car' && d.car && d.impact > 3) {
        Events.emit('horn', { sourceX: d.car.x, sourceZ: d.car.z });
        this.say(d.car, choice(DRIVER_RAM_QUOTES), 3.0);
      }
    });
  }

  /* --- Сборка модели типа через общую фабрику carmodel.js (статичная сборка —
     кузов+колёса+мелочёвка сливаются в 1 меш, см. buildCarModel) --- */
  _buildCar(typeIdx) {
    const def = TRAFFIC_TYPES[typeIdx];
    const bodyColor = def.forceColor ? def.colors[0] : choice(def.colors);
    const darkColor = 0x22262c;
    const chromeColor = def.shape === 'retro' ? 0xd8d8d8 : 0xc8c8c8;

    // Полицейская ливрея: синяя полоса на белом кузове
    const isPolice = !!def.policeLivery;
    const liveryMat = isPolice
      ? new THREE.MeshLambertMaterial({ color: 0x1a3a8a })
      : this.matLivery;

    const variants = shapeVariants(def.shape);
    const shapeOpts = variants[(Math.random() * variants.length) | 0];
    const built = buildCarModel({
      shape: def.shape, w: def.w, len: def.len, animated: false,
      matBody: this.matColored, matGlass: this.matGlass,
      matHead: this.matHead, matStop: this.matStop,
      matPlate: this.matPlate, matSign: this.matSign, matLivery: liveryMat,
      matBeaconRed: this.matBeaconRed, matBeaconBlue: this.matBeaconBlue,
      bodyColor, darkColor, chromeColor, bodyKit: def.bodyKit || 'stock', shapeOpts,
      hasPlate: true, hasSign: !!def.livery, hasLivery: !!def.livery || isPolice, beacon: def.beacon || null,
      hasRoofRack: true,
    });
    built.group.userData.type = def.name;
    built.group.userData.refs = built.refs;
    return built.group;
  }

  /* --- Заполнить пул --- */
  spawn(count, player) {
    const policeIdx = TRAFFIC_TYPES.findIndex(t => t.beacon === 'police');
    while (this.cars.length < count) {
      // Гарантируем хотя бы 1 патрульную машину в трафике
      let typeIdx;
      const hasPolice = this.cars.some(c => TRAFFIC_TYPES[c.type].beacon === 'police');
      if (policeIdx >= 0 && !hasPolice && this.cars.length === count - 1) {
        typeIdx = policeIdx;
      } else {
        typeIdx = pickTrafficType();
      }
      const def = TRAFFIC_TYPES[typeIdx];
      const mesh = this._buildCar(typeIdx);
      const refs = mesh.userData.refs || {};
      const car = {
        type: typeIdx, mesh, alive: true, radius: def.r,
        axis: 'z', coord: 0, dir: 1, pos: 0, speed: 0, target: 10, lane: 1, turnT: 0,
        speechSprite: null, speechT: 0, yellCd: 0,
        beacon: def.beacon || null,
        beaconRed: refs.beaconRed || null, beaconBlue: refs.beaconBlue || null,
        aggressive: Math.random() < 0.04,
        turnAroundT: 0,
      };
      this.cars.push(car);
      this.scene.add(mesh);
    }
    for (const car of this.cars) this.placeNear(car, player);
  }

  placeNear(car, player) {
    const r = this._randRoad(player.x, player.z);
    car.axis = r.axis;
    car.coord = r.coord;
    car.dir = r.dir;
    car.pos = r.pos;
    car.turn = null;
    car.turnT = 0;
    car.speed = rand(6, 13);
    car.target = car.speed;
    car.speechT = 0;
    car.yellCd = 0;
    car.aggressive = Math.random() < 0.04;
    car.turnAroundT = 0;
    delete car._runRedDecision;
    if (car.speechSprite) updateSpeechSprite(car.speechSprite, '');
    this._sync(car);
  }

  _isIntersectionClear(isec, car, peds) {
    if (!isec) return false;
    if (peds) {
      for (const p of peds.cars) {
        if (p.alive && (p.mode === 'cross' || p.mode === 'wait')) {
          if (Math.hypot(p.x - isec.x, p.z - isec.z) < 10) return false;
        }
      }
    }
    for (const other of this.cars) {
      if (other === car || !other.alive) continue;
      if (Math.hypot(other.x - isec.x, other.z - isec.z) < 8.5) return false;
    }
    return true;
  }

  /* Случайная дорога неподалёку от игрока, но НЕ в ближнем поле видимости
     (≥ 75 м от игрока) — машины не «выскакивают» из ниоткуда перед глазами */
  _randRoad(px, pz) {
    let best = null;
    for (let i = 0; i < 10; i++) {
      let r;
      if (Math.random() < 0.5) {
        const coord = clamp(Math.round((px + rand(-80, 80)) / CFG.CELL) * CFG.CELL, -256, 256);
        r = { axis: 'z', coord, pos: clamp(pz + rand(-140, 140), -256, 256), dir: Math.random() < 0.5 ? 1 : -1 };
      } else {
        const coord = clamp(Math.round((pz + rand(-80, 80)) / CFG.CELL) * CFG.CELL, -256, 256);
        r = { axis: 'x', coord, pos: clamp(px + rand(-140, 140), -256, 256), dir: Math.random() < 0.5 ? 1 : -1 };
      }
      const wx = r.axis === 'z' ? r.coord - r.dir * 2.5 : r.pos;
      const wz = r.axis === 'z' ? r.pos : r.coord + r.dir * 2.5;
      const d = Math.hypot(wx - px, wz - pz);
      if (d >= 75) return r;
      best = r;
    }
    return best;
  }

  /* Мир. координаты: правая полоса движения (ПДД, правостороннее).
     Движение в +Z: правая сторона — −X; в −Z: +X; в +X: +Z; в −X: −Z. */
  _worldPos(car, out = _tempTrafficWp) {
    if (car.axis === 'z') {
      out.x = car.coord - car.dir * 2.5;
      out.z = car.pos;
    } else {
      out.x = car.pos;
      out.z = car.coord + car.dir * 2.5;
    }
    return out;
  }

  _heading(car) {
    return car.axis === 'z' ? (car.dir > 0 ? 0 : Math.PI) : (car.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
  }

  update(dt, player, world, density, peds) {
    const px = player.x, pz = player.z;
    // маячок полиции/скорой: красный/синий мигают в противофазе
    this._beaconT = (this._beaconT + dt) % 0.6;
    const beaconRedOn = this._beaconT < 0.3;
    for (const car of this.cars) {
      if (!car.alive) continue;
      if (car.beaconRed) { car.beaconRed.visible = beaconRedOn; car.beaconBlue.visible = !beaconRedOn; }
      const wp = this._worldPos(car, _tempTrafficWp);
      car.x = wp.x; car.z = wp.z;

      // Облака речи водителя
      if (car.speechT > 0) {
        car.speechT -= dt;
        if (car.speechT <= 0 && car.speechSprite) updateSpeechSprite(car.speechSprite, '');
        // Показываем облачко только если машина в поле зрения игрока
        else if (car.speechSprite) {
          const inView = isInPlayerView(car.x, car.z, px, pz, player.heading, 60);
          if (car.speechSprite.visible !== inView) car.speechSprite.visible = inView;
        }
      }
      if (car.yellCd > 0) car.yellCd -= dt;

      if (Math.hypot(car.x - px, car.z - pz) > 260) {
        this.placeNear(car, player);
        continue;
      }
      // Плавный разворот на границе карты
      if (!car.turn && Math.abs(car.pos) > 250) {
        car.target = 0;
        car.turnAroundT += dt;
        if (car.speed < 2.0 || car.turnAroundT > 1.2) {
          this._startUTurn(car);
          car.turnAroundT = 0;
        }
      }

      const baseTarget = car.aggressive ? rand(9, 15) * (density || 1) * 1.25 : rand(7, 13) * (density || 1);
      car.target = clamp(baseTarget, 4, car.aggressive ? 18 : 16);

      // пропсы (барьеры, заборы, ящики) — тормозим перед ними
      if (world) {
        const aheadPos = car.pos + car.dir * 5;
        const ax = car.axis === 'z' ? car.coord - car.dir * 2.5 : aheadPos;
        const az = car.axis === 'z' ? aheadPos : car.coord + car.dir * 2.5;
        if (world._checkPropCollision(ax, az, 1.0)) {
          car.target = 0;
        }
      }

      // уступаем спецтранспорту с сиреной (скорая / полиция) сзади
      if (!car.beacon && !car.beaconRed) {
        for (const emergency of this.cars) {
          if (emergency === car || !emergency.alive) continue;
          if (!emergency.beacon && !emergency.beaconRed) continue;
          if (emergency.axis !== car.axis || emergency.coord !== car.coord) continue;
          const d = (car.pos - emergency.pos) * emergency.dir;
          if (d > 0 && d < 25 && emergency.dir === car.dir) {
            car.target = Math.min(car.target, 3);
            break;
          }
        }
      }

      // динамическая безопасная дистанция до впереди идущих
      for (const other of this.cars) {
        if (other === car || !other.alive) continue;
        if (other.axis !== car.axis || other.coord !== car.coord || other.dir !== car.dir) continue;
        const d = (other.pos - car.pos) * car.dir;
        const safeDist = car.aggressive ? (car.speed * 0.8 + 2) : (car.speed * 1.5 + 4);
        if (d > 0 && d < Math.max(6, safeDist)) { car.target = Math.min(car.target, Math.max(0, other.speed - 1.5)); break; }
      }

      // взаимодействия с пешеходами (пропуск, переругивание, случайное сбитие)
      if (peds) {
        for (const p of peds.cars) {
          if (!p.alive) continue;
          const isSameRoad = p.axis === car.axis && p.coord === car.coord;
          const dP = (p.pos - car.pos) * car.dir;

          // 1. Ругань водителя и пешехода на зебре + уступание дороги
          if (isSameRoad && (p.mode === 'cross' || p.mode === 'wait') && p.cross) {
            const off = Math.abs((p.axis === 'z' ? p.x - p.coord : p.z - p.coord));
            if (off <= 7.5 && dP > 0 && dP < 24) {
              const yieldDist = car.aggressive ? 6.0 : 20.0;
              if (dP < yieldDist) {
                car.target = Math.min(car.target, 0); // пропускаем
              }
              if (car.yellCd <= 0 && dP < 16 && Math.random() < 0.12) {
                car.yellCd = 7.0;
                Events.emit('horn', { sourceX: car.x, sourceZ: car.z });
                // Фраза в тему: если пешеход переходит вне зебры — ругаем за это,
                // иначе — обычная ругань на зебре
                const jwalk = !!(p.cross && p.cross.jwalk);
                this.say(car, choice(jwalk ? DRIVER_PED_JWALK_QUOTES : DRIVER_PED_QUOTES), 2.5);
                peds.say(p, choice(jwalk ? PED_REPLY_JWALK_QUOTES : PED_REPLY_QUOTES), 2.5);
              }
            }
          }

          // 2. Наезд машиной трафика на пешехода
          const distFull = Math.hypot(car.x - p.x, car.z - p.z);
          if (distFull < car.radius + 0.65 && p.knockT <= 0 && p.hitCd <= 0) {
            p.hitCd = 1.2;
            const nx = (p.x - car.x) / (distFull || 1);
            const nz = (p.z - car.z) / (distFull || 1);
            if (car.speed > 2.5) {
              // Машина трафика сбивает пешехода!
              peds._knockDown(p, nx, nz, car.speed);
              Events.emit('trafficHitPed');
              Events.emit('horn', { sourceX: car.x, sourceZ: car.z });
              this.say(car, choice(DRIVER_HIT_PED_QUOTES), 3.0);
              car.speed = Math.max(1, car.speed - 3.5);
            } else {
              // Толкает / пешеход уворачивается
              peds._dodge(p, nx, nz, car.speed);
              peds.say(p, "Совсем ослеп, водила?!", 2.5);
            }
          }
        }
      }

      // уступаем пешеходам на зебре при повороте
      if (peds && car.turn) {
        for (const p of peds.cars) {
          if (!p.alive || (p.mode !== 'cross' && p.mode !== 'wait')) continue;
          const distToPed = Math.hypot(p.x - car.x, p.z - car.z);
          const yieldDist = car.aggressive ? 6.0 : 10.0;
          if (distToPed < yieldDist) {
            car.target = Math.min(car.target, 0);
            break;
          }
        }
      }

      // приоритет на перекрёстке: машина, у которой нет поворота, уступает уже поворачивающей
      if (!car.turn) {
        const isec = this._nearestIntersection(car);
        if (isec && Math.abs(car.pos - (car.axis === 'z' ? isec.z : isec.x)) < 7.0) {
          for (const other of this.cars) {
            if (other === car || !other.alive) continue;
            if (other.turn && Math.hypot(other.x - isec.x, other.z - isec.z) < 8.5) {
              car.target = Math.min(car.target, 0);
              break;
            }
          }
        }
      }

      // игрок впереди в нашей полосе — тормозим
      const dP = (car.axis === 'z' ? (car.dir > 0 ? (pz - car.pos) : (car.pos - pz)) : (car.dir > 0 ? (px - car.pos) : (car.pos - px)));
      if (dP > 0 && dP < 14 && Math.abs((car.axis === 'z' ? px : pz) - car.coord) < 5.5) {
        car.target = Math.min(car.target, 2);
      }

      // светофор: жёлтый — проезд если близко, красный — стоп (кроме редких лихачей при пустом перекрёстке)
      const l = this._lightAhead(car);
      if (l && l.state !== 0) {
        const stopLine = 6.5;
        const brakeDist = (car.speed * car.speed) / 20;

        if (l.state === 1) { // Жёлтый свет
          if (l.dist >= brakeDist + stopLine) {
            car.target = Math.min(car.target, 0);
          }
        } else if (l.state === 2) { // Красный свет
          let willRunRed = false;
          if (car.aggressive) {
            if (car._runRedDecision === undefined) {
              car._runRedDecision = Math.random() < 0.3;
            }
            if (car._runRedDecision && this._isIntersectionClear(l.isec, car, peds)) {
              willRunRed = true;
            }
          }
          if (!willRunRed) {
            if (l.dist > stopLine) {
              if (l.dist <= brakeDist + stopLine + 3) {
                car.target = Math.min(car.target, 0);
              }
            } else if (car.speed < 1) {
              car.target = Math.min(car.target, 0); // уже у линии — ждём зелёный
            }
          }
        }
      } else if (car._runRedDecision !== undefined) {
        delete car._runRedDecision;
      }

      const diff = car.target - car.speed;
      car.speed += clamp(diff, -10 * dt, 5 * dt);
      car.speed = clamp(car.speed, 0, 18);

      // активный поворот: движемся по дуге Безье через центр перекрёстка или разворот
      if (car.turn) {
        const T = car.turn;
        T.t += dt;
        const k = clamp(T.t / T.dur, 0, 1);
        const u = 1 - k;
        const bx = u * u * T.fromX + 2 * u * k * T.ctrlX + k * k * T.toX;
        const bz = u * u * T.fromZ + 2 * u * k * T.ctrlZ + k * k * T.toZ;
        car.x = bx; car.z = bz;
        car.mesh.position.set(bx, 0, bz);

        // Плавный поворот курса от стартового к конечному по кратчайшей дуге.
        // Касательная к Безье здесь НЕ используется: контрольные точки поворотов
        // не дают касательной непрерывности на обоих концах (правый поворот даёт
        // концевую касательную +X при нужном курсе −X, левый — стартовую касательную
        // вбок из-за контрольной точки в центре перекрёстка). Из-за этого нос
        // сначала уводило в сторону, а в конце резко дёргало в нужный курс («юла»).
        // Линейная интерполяция курса по времени даёт ровный поворот без скачков.
        car.mesh.rotation.y = lerpAngle(T.fromH, T.toH, k);

        const df = car.target - car.speed;
        car.speed += clamp(df, -10 * dt, 5 * dt);
        car.speed = clamp(car.speed, 0, 18);
        if (k >= 1) {
          car.axis = T.newAxis; car.coord = T.newCoord; car.pos = T.newPos; car.dir = T.newDir;
          car.turn = null;
        }
        continue;
      }

      car.pos += car.speed * dt * car.dir;

      // выбор направления на перекрёстке
      if (car.turnT > 0) { car.turnT -= dt; }
      else {
        const isec = this._nearestIntersection(car);
        if (isec && Math.abs(car.pos - (car.axis === 'z' ? isec.z : isec.x)) < 2.5) {
          this._chooseDirection(car, isec);
        }
      }

      this._sync(car);
    }
  }

  _nearestIntersection(car) {
    for (const isec of WORLD_INTERSECTIONS) {
      if (car.axis === 'z') { if (Math.abs(isec.x - car.coord) < 0.1 && Math.abs(isec.z - car.pos) < 3) return isec; }
      else if (Math.abs(isec.z - car.coord) < 0.1 && Math.abs(isec.x - car.pos) < 3) return isec;
    }
    return null;
  }

  _chooseDirection(car, isec) {
    const roll = Math.random();
    if (roll < 0.58) { car.turnT = 0.3; return; } // прямо
    const right = roll < 0.8; // 22% направо, 20% налево
    // конечные параметры новой дороги (ПДД: с правой полосы — правый поворот в
    // правую полосу новой дороги, левый — тоже в правую полосу)
    let newAxis, newCoord, newDir;
    if (car.axis === 'z') {
      newAxis = 'x';
      newCoord = isec.z;
      // движение в +Z: направо = −X, налево = +X; в −Z: направо = +X, налево = −X
      newDir = right ? -car.dir : car.dir;
    } else {
      newAxis = 'z';
      newCoord = isec.x;
      // движение в +X: направо = +Z, налево = −Z; в −X: направо = −Z, налево = +Z
      newDir = right ? car.dir : -car.dir;
    }
    // мировая точка старта и финиша
    const from = this._worldPos(car, _tempTrafficFrom);
    const to = this._worldPos({ axis: newAxis, coord: newCoord, pos: (car.axis === 'z' ? isec.x : isec.z), dir: newDir }, _tempTrafficTo);
    // длительность поворота зависит от скорости (дуга ~3.5 м)
    const arcLen = Math.hypot(to.x - from.x, to.z - from.z);
    const dur = clamp(arcLen / Math.max(car.speed, 4) * 1.15, 0.5, 1.4);
    // контрольная точка: правый поворот — малый радиус по углу перекрёстка
    // (пересечение полос), левый — через центр перекрёстка
    let ctrlX, ctrlZ;
    if (right) {
      if (car.axis === 'z') { ctrlX = from.x; ctrlZ = to.z; }
      else { ctrlX = to.x; ctrlZ = from.z; }
    } else { ctrlX = isec.x; ctrlZ = isec.z; }
    car.turn = {
      t: 0, dur,
      fromX: from.x, fromZ: from.z,
      toX: to.x, toZ: to.z,
      ctrlX, ctrlZ,
      fromH: this._heading(car),
      toH: newAxis === 'z' ? (newDir > 0 ? 0 : Math.PI) : (newDir > 0 ? Math.PI / 2 : -Math.PI / 2),
      newAxis, newCoord, newPos: (car.axis === 'z' ? isec.x : isec.z), newDir,
    };
    car.turnT = dur + 0.2; // не выбираем направление, пока поворачиваем
  }

  /* Плавный U-образный разворот на границе города */
  _startUTurn(car) {
    const newDir = -car.dir;
    // Новая позиция после разворота — внутри границ города
    const newPos = clamp(car.pos - car.dir * 4, -245, 245);
    const from = this._worldPos(car, _tempTrafficFrom);
    const to = this._worldPos({ axis: car.axis, coord: car.coord, pos: newPos, dir: newDir }, _tempTrafficTo);

    // Контрольная точка выдвинута вперёд по ходу движения для создания петли U-turn
    let ctrlX, ctrlZ;
    if (car.axis === 'z') {
      ctrlX = car.coord;
      ctrlZ = car.pos + car.dir * 7;
    } else {
      ctrlX = car.pos + car.dir * 7;
      ctrlZ = car.coord;
    }

    const fromH = this._heading(car);
    const toH = car.axis === 'z' ? (newDir > 0 ? 0 : Math.PI) : (newDir > 0 ? Math.PI / 2 : -Math.PI / 2);
    const dur = 1.8; // Длительность разворота в секундах

    car.turn = {
      t: 0, dur,
      fromX: from.x, fromZ: from.z,
      toX: to.x, toZ: to.z,
      ctrlX, ctrlZ,
      fromH, toH,
      newAxis: car.axis, newCoord: car.coord, newPos, newDir,
    };
    car.target = 6;
  }

  /* Ближайший светофор впереди для полосы машины (свой светофор своей оси) */
  _lightAhead(car) {
    const wp = this._worldPos(car, _tempTrafficWp);
    for (const l of this.lightsRef) {
      if (l.axis !== car.axis) continue; // светофор поперечной дороги не наш
      // поперечное смещение: машина на своей полосе (2.5), светофор у угла (9)
      const side = car.axis === 'z' ? Math.abs(wp.x - l.x) : Math.abs(wp.z - l.z);
      if (side > 13) continue;
      // расстояние до СТОП-ЗОНЫ перекрёстка (не до светофора — тот на дальнем углу)
      const dist = car.axis === 'z'
        ? (car.dir > 0 ? l.isec.z - wp.z : wp.z - l.isec.z)
        : (car.dir > 0 ? l.isec.x - wp.x : wp.x - l.isec.x);
      if (dist <= 0 || dist > 30) continue;
      // светофор должен оставаться впереди по ходу (не проехали его угол)
      const ahead = car.axis === 'z'
        ? (car.dir > 0 ? l.z - wp.z : wp.z - l.z)
        : (car.dir > 0 ? l.x - wp.x : wp.x - l.x);
      if (ahead <= 0) continue;
      _tempLightRet.dist = dist;
      _tempLightRet.state = l.state;
      return _tempLightRet;
    }
    return null;
  }

  say(car, text, duration = 3.0) {
    if (!car.speechSprite) {
      car.speechSprite = makeSpeechSprite(text);
      car.mesh.add(car.speechSprite);
    } else {
      updateSpeechSprite(car.speechSprite, text);
    }
    car.speechT = duration;
    Events.emit('spatial:shout', { x: car.x, z: car.z, text, type: 'driver', avatar: '🚘' });
  }

  _sync(car) {
    const wp = this._worldPos(car, _tempTrafficWp);
    car.mesh.position.set(wp.x, 0, wp.z);
    car.mesh.rotation.y = this._heading(car);
  }
}

/* Перекрёстки мира (заполняется после World.build в game.js) */
export let WORLD_INTERSECTIONS = [];

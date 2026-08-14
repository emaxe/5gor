import * as THREE from 'three';
import { CFG } from './config.js';
import { rand, clamp, lerp, choice, buildPedMesh, makeSpeechSprite, updateSpeechSprite, isInPlayerView } from './utils.js';
import { Events } from './eventbus.js';
import { PedGraph } from './pedgraph.js';
import { probeForwardBlocked, FORWARD_DISTANCES, segmentBlocked, reachableTarget } from './pedavoid.js';

const _tempPedWp = { x: 0, z: 0 };
const _tempPedWpSync = { x: 0, z: 0 };
const _tempPedWpTurn = { x: 0, z: 0 };
const _tempPedProbe = { x: 0, z: 0 };

const PED_COLORS = [0xd8a878, 0x8a5a3a, 0xc89060, 0xa87850, 0xb08058, 0x6a4a30];
const PED_SIDE = CFG.HALF + CFG.SIDE / 2; // 8 — центр тротуара от оси дороги
const PED_TURN_LIMIT = 232; // граница разворота пешехода в _updateWalk (раньше хардкод)

const IDLE_QUOTES = [
  "Пятигорск сегодня прекрасен!",
  "Эх, успеть бы на 1-ю маршрутку...",
  "Опять на Галерее пробка...",
  "На Машуке сегодня туман красивый",
  "Вай, какой воздух на КМВ!",
  "Надо зайти нарзана попить...",
  "Где здесь ближайшая аптека?",
  "Такси в городе стали быстрее...",
  "В Цветнике опять розы цветут!",
  "Пятигорский курорт — лучший в мире!",
  "На Провале Остап Бендер стоял!"
];

const ANIMAL_DOG_QUOTES = [
  "Гав-гав!",
  "Тяв!",
  "Вуф!",
  "Р-р-р, гав!"
];

const ANIMAL_CAT_QUOTES = [
  "Мяу!",
  "Мурр-мяу!",
  "Фр-р-р!",
  "Мяу-мяу..."
];

const CURSE_QUOTES = [
  "Куда прёшь, дрова везёшь?!",
  "Права за салом купил?!",
  "Смотри куда рулишь, шумахер!",
  "Ослеп что ли, осел?!",
  "Тормоза проверь, ведро!",
  "Ты у меня щас пешком пойдёшь!",
  "Урод на колёсах!",
  "Чуть ноги не оторвал!"
];

const KICK_QUOTES = [
  "На нах! Ездить научись!",
  "Получи, ведро с болтами!",
  "Вот тебе за подрез!",
  "Ещё раз подрежешь — колесо откручу!"
];

/**
 * Менеджер пешеходов и животных (спавн, осознанный ИИ движения к целям, анимации, ругань и животные).
 */
export class PedestrianManager {
  /**
   * @param {THREE.Scene} scene - Трёхмерная сцена Three.js
   */
  constructor(scene) {
    this.scene = scene;
    /** @type {Array<Object>} список активных пешеходов и животных */
    this.cars = []; // сущности
    this.trafficRef = null;
    this._count = 0;
    this.graph = null;
    this._classifyTimer = 0;
    this._obstacleAtBound = (x, z) => this._obstacleAt(x, z);
  }

  /* Реплика над головой пешехода / животного */
  say(p, text, duration = 3.0) {
    if (!p.speechSprite) {
      p.speechSprite = makeSpeechSprite(text);
      p.mesh.add(p.speechSprite);
    } else {
      updateSpeechSprite(p.speechSprite, text);
    }
    p.speechT = duration;
    const avatar = p.isAnimal ? (p.archetype === 'dog' ? '🐕' : '🐈') : '🏃';
    const speaker = p.isAnimal ? (p.archetype === 'dog' ? 'Собака рядом' : 'Кот рядом') : 'Пешеход рядом';
    Events.emit('spatial:shout', { x: p.x, z: p.z, text, type: 'scream', avatar, speaker });
  }

  /* Построение 3D-модели */
  _buildPed(archetype) {
    return buildPedMesh(archetype);
  }

  /* Анимация ходьбы/бега/ругани/удара ногой и движения животных */
  _animate(p) {
    const u = p.mesh.userData;
    if (!u) return;

    if (p.isAnimal) {
      // Анимация животного (4 лапы + хвост + голова)
      const moving = p.knockT <= 0 && p.speed > 0 && (p.mode === 'walk' || p.mode === 'run' || p.mode === 'cross' || p.mode === 'turn' || p.mode === 'flee');
      const ph = p.walk || 0;
      if (moving && u.legs && u.legs.length === 4) {
        const sw = Math.sin(ph * 1.4);
        // Диагональная рысь
        u.legs[0].rotation.x = sw * 0.6;   // пп
        u.legs[1].rotation.x = -sw * 0.6;  // лп
        u.legs[2].rotation.x = -sw * 0.6;  // пз
        u.legs[3].rotation.x = sw * 0.6;   // лз
        if (u.tail) u.tail.rotation.y = Math.sin(ph * 2.0) * 0.35;
        if (u.head) u.head.rotation.x = Math.sin(ph * 1.4) * 0.08;
      } else if (u.legs && u.legs.length === 4) {
        for (let i = 0; i < 4; i++) u.legs[i].rotation.x = 0;
        if (u.tail) u.tail.rotation.y = 0;
        if (u.head) u.head.rotation.x = 0;
      }
      return;
    }

    // Анимация человека
    if (!u.legs) return;
    const moving = p.knockT <= 0 && p.speed > 0 && (p.mode === 'walk' || p.mode === 'run' || p.mode === 'cross' || p.mode === 'turn' || p.mode === 'flee');
    const ph = p.walk || 0;
    let amp = p.mode === 'flee' ? 0.75 : (p.mode === 'run' ? 0.82 : 0.55);

    if (p.kickT > 0) {
      // Анимация удара ногой по машине
      const k = clamp(1.0 - p.kickT / 0.6, 0, 1);
      const legAngle = -Math.sin(k * Math.PI) * 1.35;
      u.legs[1].rotation.x = legAngle; // правая нога машет вперёд
      u.legs[0].rotation.x = 0;
      u.arms[0].rotation.x = -0.8;
      u.arms[1].rotation.x = 0.8;
    } else if (p.angerT > 0 && !moving) {
      // Анимация гнева (машет руками)
      const sw = Math.sin(Date.now() * 0.012);
      u.arms[0].rotation.x = -1.2 + sw * 0.3;
      u.arms[1].rotation.x = -1.2 - sw * 0.3;
      u.legs[0].rotation.x = 0; u.legs[1].rotation.x = 0;
    } else if (moving) {
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

  /* Спавн с поддержкой разных архетипов людей и животных */
  spawn(count, player) {
    const archTypes = [
      'gopnik', 'grandma', 'runner', 'student', 'businessman', 'tourist', 'child', 'regular',
      'dog', 'dog', 'cat', 'cat' // Добавляем животных в пул спавна (~25% от состава)
    ];
    while (this.cars.length < count) {
      const arch = choice(archTypes);
      const mesh = this._buildPed(arch);
      const speechSprite = makeSpeechSprite();
      mesh.add(speechSprite);

      const isAnimal = arch === 'dog' || arch === 'cat';

      const ped = {
        mesh, speechSprite, archetype: arch, isAnimal, alive: true, x: 0, z: 0, axis: 'z', dir: 1,
        speed: 0, baseSpeed: 2.2, side: 1, turnT: 0, mode: 'walk', cross: null, turn: null,
        targetPos: null, targetIsec: null,
        waitT: 0, fx: 0, fz: 0, fvx: 0, fvz: 0, fleeT: 0, knockT: 0, hitCd: 0,
        angerT: 0, kickT: 0, kickCd: 0, speechT: 0, chatCd: rand(10, 30),
        violator: Math.random() < CFG.pedViolatorChance,
        active: false, nearZone: false, laneOff: 0,
        route: null, routeIdx: 0, _edgeKind: null, edgeEnd: 0,
        idleT: 0, _blockedT: 0, _stuckT: 0, _reroute: 0,
        _blockedTurnIsec: null,
      };
      this.cars.push(ped);
      this.scene.add(mesh);
    }
    for (const p of this.cars) this._randPlace(p, player);
  }

  /* Размещение пешехода с гарантированной защитой от появления в зоне видимости игрока */
  _randPlace(p, player) {
    // Оба живых вызывающих (реплейс на >210 м в update(), и spawn() при
    // старте новой смены через _applyDensity) могут получить пешехода, ещё
    // активного с живым маршрутом — маршрут описывает совсем другую часть
    // города и после телепортации ниже стал бы протухшим (см. находка 3
    // финального ревью). Разбираем AI-состояние маршрута централизованно
    // ДО применения новой позиции.
    this._deactivate(p);
    const px = player && player.x !== undefined ? player.x : 0;
    const pz = player && player.z !== undefined ? player.z : 0;
    const heading = player && player.heading !== undefined ? player.heading : 0;
    const pSpeed = player && player.speed !== undefined ? Math.abs(player.speed) : 0;

    let place = null;

    for (let i = 0; i < 30; i++) {
      const vertical = Math.random() < 0.5;
      const rx = rand(-160, 160);
      const rz = rand(-160, 160);
      const coord = clamp(Math.round(((vertical ? px : pz) + (vertical ? rx : rz)) / CFG.CELL) * CFG.CELL, -256, 256);
      const axis = vertical ? 'z' : 'x';
      const pos = clamp((vertical ? pz : px) + (vertical ? rz : rx), -256, 256);
      const side = Math.random() < 0.5 ? -1 : 1;

      const wx = axis === 'z' ? coord + side * PED_SIDE : pos;
      const wz = axis === 'z' ? pos : coord + side * PED_SIDE;
      const d = Math.hypot(wx - px, wz - pz);

      if (this._spotBlocked(wx, wz)) continue;
      if (d < 50) continue;

      const viewDist = Math.min(145, 115 + pSpeed * 1.6);
      if (isInPlayerView(wx, wz, px, pz, heading, viewDist)) continue;

      place = { axis, coord, pos, side };
      break;
    }

    if (!place) {
      const backAngle = heading + Math.PI + rand(-0.7, 0.7);
      const backDist = rand(70, 115);
      const bx = clamp(px + Math.sin(backAngle) * backDist, -250, 250);
      const bz = clamp(pz + Math.cos(backAngle) * backDist, -250, 250);
      const vertical = Math.random() < 0.5;
      const coord = clamp(Math.round((vertical ? bx : bz) / CFG.CELL) * CFG.CELL, -256, 256);
      const axis = vertical ? 'z' : 'x';
      const pos = clamp(vertical ? bz : bx, -256, 256);
      place = { axis, coord, pos, side: Math.random() < 0.5 ? 1 : -1 };
    }

    p.axis = place.axis;
    p.coord = place.coord;
    p.pos = place.pos;
    p.side = place.side;
    p.dir = Math.random() < 0.5 ? 1 : -1;

    if (p.archetype === 'runner') p.baseSpeed = rand(4.0, 5.0);
    else if (p.archetype === 'grandma') p.baseSpeed = rand(1.3, 1.7);
    else if (p.archetype === 'gopnik') p.baseSpeed = rand(2.3, 2.9);
    else if (p.archetype === 'dog') p.baseSpeed = rand(3.0, 4.2);
    else if (p.archetype === 'cat') p.baseSpeed = rand(2.2, 3.5);
    else if (p.archetype === 'child') p.baseSpeed = rand(2.0, 2.6);
    else p.baseSpeed = rand(1.8, 2.7);

    p.speed = p.baseSpeed;
    p.mode = (p.archetype === 'runner' || p.archetype === 'dog') ? 'run' : 'walk';

    p.turnT = 0;
    p.cross = null;
    p.turn = null;
    p.targetPos = null;
    p.targetIsec = null;
    p.waitT = 0;
    p.fx = 0; p.fz = 0; p.fvx = 0; p.fvz = 0;
    p.fleeT = 0; p.knockT = 0; p.hitCd = 0;
    p.angerT = 0; p.kickT = 0; p.kickCd = 0; p.speechT = 0;
    p.chatCd = rand(10, 30);
    if (p.speechSprite) updateSpeechSprite(p.speechSprite, '');
    const wp = this._worldPos(p, _tempPedWp);
    p.x = wp.x; p.z = wp.z;
    this._sync(p);

    // Назначаем начальную целевую позицию для осмысленного маршрута
    this._assignNewTarget(p);
  }

  /* Назначение целевого перекрёстка для пешехода. Цель ограничена достижимым
     диапазоном — пешеход разворачивается на PED_TURN_LIMIT (232), так что
     перекрёсток 256 никогда не достигается, и бесконечная корректировка
     направления в _updateWalk заставляла его топтаться на краю. maxReachable
     вычисляется из PED_TURN_LIMIT и CFG.CELL, не хардкодится (ревью 2.3). */
  _assignNewTarget(p) {
    const isecStep = CFG.CELL;
    const maxReachable = Math.floor(PED_TURN_LIMIT / isecStep) * isecStep; // 192
    const targetIsec = Math.round((p.pos + p.dir * rand(isecStep * 1.5, isecStep * 3.5)) / isecStep) * isecStep;
    p.targetIsec = reachableTarget(targetIsec, isecStep, maxReachable);
  }

  /* Мировые координаты в зависимости от режима */
  _worldPos(p, out = _tempPedWp) {
    if (p.knockT > 0 || p.mode === 'flee') { out.x = p.fx; out.z = p.fz; return out; }
    if (p.mode === 'cross' && p.cross) {
      const k = clamp(p.cross.t / p.cross.dur, 0, 1);
      const off = lerp(p.cross.from, p.cross.to, k);
      if (p.axis === 'z') { out.x = p.coord + off; out.z = p.pos; }
      else { out.x = p.pos; out.z = p.coord + off; }
      return out;
    }
    if (p.mode === 'turn' && p.turn) {
      const k = clamp(p.turn.t / p.turn.dur, 0, 1);
      out.x = lerp(p.turn.x0, p.turn.x1, k);
      out.z = lerp(p.turn.z0, p.turn.z1, k);
      return out;
    }
    const off = p.side * PED_SIDE + (p.laneOff || 0);
    if (p.axis === 'z') { out.x = p.coord + off; out.z = p.pos; }
    else { out.x = p.pos; out.z = p.coord + off; }
    return out;
  }

  /* Поиск светофора */
  _getLightForPed(p) {
    if (p.isAnimal) return null; // Животные игнорируют светофоры!
    if (p.cross && p.cross.jwalk) return null; // незаконный переход светофором не управляется
    if (!this.lightsRef || !this.lightsRef.length) return null;
    const isecVal = Math.round(p.pos / CFG.CELL) * CFG.CELL;
    const targetIsecX = p.axis === 'z' ? p.coord : isecVal;
    const targetIsecZ = p.axis === 'z' ? isecVal : p.coord;
    for (const l of this.lightsRef) {
      if (l.axis === p.axis && Math.abs(l.isec.x - targetIsecX) < 2 && Math.abs(l.isec.z - targetIsecZ) < 2) {
        return l;
      }
    }
    return null;
  }

  _heading(p) {
    if ((p.mode === 'kick' || p.angerT > 0) && p.targetAngle !== undefined) {
      return p.targetAngle;
    }
    let h;
    if (p.mode === 'flee') {
      h = Math.atan2(p.fvx, p.fvz);
    } else if (p.mode === 'turn' && p.turn) {
      h = Math.atan2(p.turn.x1 - p.turn.x0, p.turn.z1 - p.turn.z0);
    } else if (p.mode === 'cross' && p.cross) {
      const toPlus = p.cross.to > p.cross.from;
      h = p.axis === 'z' ? (toPlus ? Math.PI / 2 : -Math.PI / 2) : (toPlus ? 0 : Math.PI);
    } else if (p.mode === 'wait' && p.cross) {
      const toPlus = p.cross.to > p.cross.from;
      h = p.axis === 'z' ? (toPlus ? Math.PI / 2 : -Math.PI / 2) : (toPlus ? 0 : Math.PI);
    } else {
      h = p.axis === 'z' ? (p.dir > 0 ? 0 : Math.PI) : (p.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    }
    if (p.walk && p.mode !== 'wait') h += Math.sin(p.walk) * 0.04;
    return h;
  }

  /* Построить граф ходьбы из мира + POI (достопримечательности, точки подачи,
     заправки) + одноразовый spatial hash зданий (ячейки 16 м) для _obstacleAt
     (Task 6) — линейный перебор ~250 AABB на каждого активного пешехода
     каждый кадр слишком дорог. */
  initGraph(world) {
    this.world = world;
    if (!world || !world.intersections || !world.intersections.length) return;
    const graph = new PedGraph();
    graph.build(world.intersections);
    const pois = [];
    for (const l of world.landmarks || []) pois.push({ x: l.x, z: l.z, tag: l.id });
    for (const p of world.pickupPoints || []) pois.push({ x: p.x, z: p.z, tag: 'pickup' });
    for (const s of world.fuelStations || []) pois.push({ x: s.x, z: s.z, tag: 'fuel' });
    graph.setPOIs(pois);
    this.graph = graph;

    this._buildingHash = new Map();
    const cell = 16;
    for (const b of world.buildings || []) {
      const cx0 = Math.floor(b.x0 / cell), cx1 = Math.floor(b.x1 / cell);
      const cz0 = Math.floor(b.z0 / cell), cz1 = Math.floor(b.z1 / cell);
      for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
        const key = cx + ',' + cz;
        if (!this._buildingHash.has(key)) this._buildingHash.set(key, []);
        this._buildingHash.get(key).push(b);
      }
    }
  }

  /* Классификация зон (0.5 с, гистерезис) — активная/ближняя/дальняя.
     Животные и скрытые (mesh.visible=false, см. game.js _applyDensity)
     полный ИИ не получают. Не более 2 новых активаций за тик — каждая стоит
     один полный проход Dijkstra (~1-3 мс); при резком появлении сразу
     нескольких пешеходов в зоне это защита от фриза кадра (см. спеку,
     «Производительность»).
     Не деактивируем посреди cross/wait/turn — не только по правилу спеки
     («не обрывать переход»), но и из-за конкретного технического риска для
     turn: активный поворот (через graph-ребро kind='turn') откладывает
     обновление p.axis/p.coord/p.pos до ЗАВЕРШЕНИЯ (в ветке `turn` внутри
     `_updateActive`, Task 5) — если деактивировать пешехода до этого момента,
     visual-интерполяция (p.turn) доиграет через общий `_updateTurn`, но
     axis/coord/pos останутся от ДО поворота, а `_worldPos` после обнуления
     p.turn считает мировую позицию именно по ним — пешеход визуально
     телепортируется обратно в точку начала поворота. */
  _classify(dt) {
    // кулдауны пересчёта маршрута тикают каждый кадр, не только на классификации
    for (const p of this.cars) {
      if (p._reroute > 0) p._reroute -= dt;
    }
    this._classifyTimer -= dt;
    if (this._classifyTimer > 0) return;
    this._classifyTimer = 0.5;
    if (!this.graph) return;
    const pl = this._playerRef;
    const px = pl && pl.x !== undefined ? pl.x : 0;
    const pz = pl && pl.z !== undefined ? pl.z : 0;
    let activations = 0;
    for (const p of this.cars) {
      if (!p.alive || p.isAnimal || !p.mesh.visible) continue;
      const d = Math.hypot(p.x - px, p.z - pz);
      p.nearZone = d <= CFG.pedNearRadius;
      if (!p.active && d <= CFG.pedActiveRadius) {
        if (activations >= 2 || p._reroute > 0) continue;
        this._activate(p);
        activations++;
      } else if (p.active && d > CFG.pedActiveRadius + 5 && p.mode !== 'cross' && p.mode !== 'wait' && p.mode !== 'turn') {
        this._deactivate(p);
      }
    }
  }

  /* Если пешеход стоит внутри препятствия — попытаться сдвинуть его
     вдоль ленты (±1.5, ±3.0) и поперёк (±1.0). Возвращает true если
     удалось найти свободную точку. Используется в _activate: дальний
     пешеход (без _avoidStatic) мог зайти в AABB, и при активации маршрут
     стартует изнутри статики — 1.5 с пешеход стоит в лавочке. */
  _nudgeOutOfObstacle(p) {
    if (!this.world) return false;
    const wp = this._worldPos(p, _tempPedWp);
    if (!this._obstacleAt(wp.x, wp.z)) return true;
    for (const along of [0, 1.5, -1.5, 3.0, -3.0]) {
      for (const across of [0, 1.0, -1.0]) {
        const off = p.side * PED_SIDE + across;
        const tx = p.axis === 'z' ? p.coord + off : wp.x + along * p.dir;
        const tz = p.axis === 'z' ? wp.z + along * p.dir : p.coord + off;
        if (!this._obstacleAt(tx, tz)) {
          if (p.axis === 'z') { p.pos = tz; p.laneOff = across; }
          else { p.pos = tx; p.laneOff = across; }
          return true;
        }
      }
    }
    return false;
  }

  /* Активировать: узел входа на СВОЕЙ ленте -> цель -> маршрут.
     Ранний выход при отлёте/убегании/пинке — не обрывает их сменой mode.
     Ровно один проход Dijkstra (routesFrom) на активацию — дальше выбор
     цели и восстановление пути работают по готовым dist/prev без повторных
     проходов (см. pedgraph.js, комментарий у routesFrom). */
  _activate(p) {
    if (!this.graph || p.isAnimal) return;
    if (p.knockT > 0 || p.mode === 'flee' || p.mode === 'kick') return;
    p.route = null; p.routeIdx = 0; p.laneOff = 0;
    this._nudgeOutOfObstacle(p);  // сдвинуться из препятствия если стоит внутри — ПОСЛЕ
                                   // сброса laneOff, иначе боковой сдвиг затирается (G4)

    const fromId = this.graph.nodeOnLane(p.axis, p.coord, p.side, p.pos);
    if (fromId == null) { p.active = false; p._reroute = 2.0; return; }

    const { dist, prev } = this.graph.routesFrom(fromId, p.violator);
    const toId = this._pickDestination(p, fromId, dist);
    if (toId == null || toId === fromId) { p.active = false; p._reroute = 2.0; return; }

    const path = this.graph.pathTo(prev, fromId, toId);
    if (!path || path.length < 2) { p.active = false; p._reroute = 2.0; return; }

    const fromNode = this.graph.nodes[fromId];
    const approach = {
      kind: 'walk', axis: p.axis, coord: p.coord, side: p.side,
      posStart: p.pos, posEnd: p.axis === 'z' ? fromNode.z : fromNode.x,
    };
    p.route = [approach, ...this._edgesFor(path)];
    p.routeIdx = 0;
    p.active = true;
    p.mode = (p.archetype === 'runner' || p.archetype === 'dog') ? 'run' : 'walk';
    this._startEdge(p);
  }

  /* Режим "отдыха" (не задействован в маршруте) по архетипу — единая точка,
     чтобы новые/изменённые места (_deactivate, восстановление после kick) не
     расходились между собой (см. финальное ревью: восстановление после kick
     раньше не учитывало archetype === 'dog'). */
  _restMode(p) {
    return (p.archetype === 'runner' || p.archetype === 'dog') ? 'run' : 'walk';
  }

  /* Централизованный разбор жизненного цикла активного маршрута. Помимо
     active/route/routeIdx/laneOff сбрасывает и _edgeKind/edgeEnd — без этого
     пешеход, чей маршрут разобран здесь (наезд/пинок игрока, реплейс на
     >210 м, старт новой смены), но у которого следующий тик почему-то опять
     попадёт в активную walk-ветку _updateActive, увидит protухший _edgeKind
     от старого маршрута (см. находки финального ревью по kick/_randPlace). */
  _deactivate(p) {
    p.active = false;
    p.route = null; p.routeIdx = 0;
    p.laneOff = 0;
    p._edgeKind = null; p.edgeEnd = 0;
    if (p.mode === 'idle') p.mode = this._restMode(p);
  }

  /* Выбор цели: гибрид POI (по архетипу, взвешенно) + случайная — всё в
     пределах готовой карты dist[] (2-6 walk-рёбер ~ dist 1-3), БЕЗ повторных
     вызовов Dijkstra (dist уже посчитан один раз в _activate). */
  _pickDestination(p, fromId, dist) {
    if (p.archetype === 'tourist') {
      const id = this._pickPoiFor(fromId, dist, 'cvetnik', 'proval');
      if (id != null) return id;
    }
    if (p.archetype === 'grandma') {
      const id = this._pickPoiFor(fromId, dist, 'rynok', 'pickup', 'fuel');
      if (id != null) return id;
    }
    if (Math.random() < 0.5) {
      const id = this._pickWeightedPoi(fromId, dist);
      if (id != null) return id;
    }
    return this._pickRandomNode(fromId, dist);
  }

  /* POI нужной категории в пределах dist[1,3]: случайный из ДО ТРЁХ ближайших
     подходящих, не считая узел прибытия и всё ближе 1 (иначе пешеход у своей
     единственной ближайшей достопримечательности после idle тут же выбирает
     её же снова — toId===fromId, активация молча ничего не делает, а таймер
     простоя уже истёк: вечный idle без движения). БЕЗ fallback на весь список
     POI — по той же причине. */
  _pickPoiFor(fromId, dist, ...tags) {
    const g = this.graph;
    const pool = g.poiList
      .filter(po => tags.some(t => po.tag && po.tag.includes(t)))
      .filter(po => po.node !== fromId && dist[po.node] >= 1 && dist[po.node] <= 3)
      .sort((a, b) => dist[a.node] - dist[b.node]);
    if (!pool.length) return null;
    const top = pool.slice(0, 3);
    return top[Math.floor(Math.random() * top.length)].node;
  }

  /* Случайный POI без привязки к архетипу, взвешенно по категориям:
     достопримечательность 0.5 / точка подачи такси 0.35 / заправка 0.15.
     Без весов точки подачи (~300 шт.) забивают выбор — достопримечательности
     (9 шт.) практически никогда не выпадают. */
  _pickWeightedPoi(fromId, dist) {
    const g = this.graph;
    const inRange = g.poiList.filter(po => po.node !== fromId && dist[po.node] >= 1 && dist[po.node] <= 3);
    if (!inRange.length) return null;
    const byCat = { landmark: [], pickup: [], fuel: [] };
    for (const po of inRange) {
      const cat = po.tag === 'pickup' ? 'pickup' : po.tag === 'fuel' ? 'fuel' : 'landmark';
      byCat[cat].push(po);
    }
    const weights = [['landmark', 0.5], ['pickup', 0.35], ['fuel', 0.15]].filter(([c]) => byCat[c].length);
    if (!weights.length) return null;
    const total = weights.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    let cat = weights[weights.length - 1][0];
    for (const [c, w] of weights) { if (r < w) { cat = c; break; } r -= w; }
    const list = byCat[cat];
    return list[Math.floor(Math.random() * list.length)].node;
  }

  /* Случайный тротуарный узел на графовой дистанции 2-6 рёбер (dist∈[1,3]),
     по готовой карте dist[] — без единого повторного Dijkstra. */
  _pickRandomNode(fromId, dist) {
    const g = this.graph;
    const candidates = [];
    for (const n of g.nodes) {
      if ((n.kind !== 'lane' && n.kind !== 'mid') || n.id === fromId) continue;
      const d = dist[n.id];
      if (d >= 1 && d <= 3) candidates.push(n.id);
    }
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /* Маршрут -> массив дескрипторов рёбер (сливаем пару cross через центр в
     один описатель — сторона departure берётся с некруглого узла, см.
     pedgraph.js edgeInfo). routeIdx индексирует ЭТОТ массив, а не исходный
     path — каждый элемент = один шаг движения, поэтому _finishEdge всегда
     продвигает на 1, без отдельного поля advance. */
  _edgesFor(path) {
    const out = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i], b = path[i + 1];
      const e = this.graph.edgeInfo(a, b);
      if (!e) continue;
      if (e.kind === 'cross' && i + 2 < path.length && this.graph.nodes[b].kind === 'center') {
        out.push(e);
        i += 1;
        continue;
      }
      out.push(e);
    }
    return out;
  }

  /* Начать движение по текущему ребру маршрута */
  _startEdge(p) {
    if (p.routeIdx >= p.route.length) { this._arrive(p); return; }
    const e = p.route[p.routeIdx];
    p._edgeKind = e.kind;
    p.speed = p.baseSpeed;
    if (e.kind === 'walk') {
      p.axis = e.axis; p.coord = e.coord; p.side = e.side;
      p.dir = e.posEnd >= e.posStart ? 1 : -1;
      p.mode = (p.archetype === 'runner' || p.archetype === 'dog') ? 'run' : 'walk';
      p.edgeEnd = e.posEnd;
      p.cross = null; p.turn = null;
    } else if (e.kind === 'cross' || e.kind === 'jwalk') {
      p.axis = e.axis; p.coord = e.coord; p.side = e.side; p.pos = e.pos;
      p.cross = null; p.turn = null;
      this._startCross(p, e.kind === 'jwalk');
    } else if (e.kind === 'turn') {
      p.mode = 'turn';
      p.cross = null;
      // Начало дуги — текущая мировая позиция пешехода, не запечённые e.x0/e.z0:
      // если позицию перед поворотом сдвинул _nudgeOutOfObstacle (Task 7) или выход
      // с зебры (Task 6), запечённые координаты телепортировали бы пешехода обратно
      // в исходную точку в момент старта анимации (grill-plan G3).
      const wp0 = this._worldPos(p, _tempPedWpTurn);
      p.turn = {
        x0: wp0.x, z0: wp0.z, x1: e.x1, z1: e.z1, t: 0,
        dur: Math.hypot(e.x1 - wp0.x, e.z1 - wp0.z) / Math.max(p.speed, 0.5),
      };
      p._turnTo = e;
    }
  }

  /* Всегда продвигает на 1 элемент p.route — см. комментарий у _edgesFor. */
  _finishEdge(p) {
    p.routeIdx += 1;
    this._startEdge(p);
  }

  _arrive(p) {
    p.route = null; p.routeIdx = 0;
    p.active = true;
    p.mode = 'idle';
    p.speed = 0;
    p.cross = null; p.turn = null;
    p.idleT = rand(CFG.pedIdleTime[0], CFG.pedIdleTime[1]);
    p.laneOff = 0;
  }

  /* Есть ли приближающаяся машина на нашей дороге рядом с переходом */
  _carOnRoad(p, dist) {
    if (p.isAnimal) return false; // Животные не проверяют машины строго перед переходом (перебегают)
    const safeDist = dist || 32;
    const tr = this.trafficRef;
    if (tr) {
      for (const c of tr.cars) {
        if (!c.alive || c.axis !== p.axis || c.coord !== p.coord) continue;
        const dPos = (c.pos - p.pos) * c.dir;
        if (c.speed > 0.8 && Math.abs(c.pos - p.pos) < safeDist) {
          if (dPos < 3) return true;
        }
      }
    }
    const pl = this._playerRef;
    if (pl && Math.abs(pl.speed) > 1.0) {
      const plOnRoad = p.axis === 'z' ? Math.abs(pl.x - p.coord) < 9 : Math.abs(pl.z - p.coord) < 9;
      if (plOnRoad) {
        const plPos = p.axis === 'z' ? pl.z : pl.x;
        const plDist = Math.abs(plPos - p.pos);
        const dynamicDist = Math.max(safeDist, Math.abs(pl.speed) * 2.5);
        if (plDist < dynamicDist) return true;
      }
    }
    return false;
  }

  /* Осознанное движение по тротуару */
  _updateWalk(p, dt) {
    if (p.nearZone && !p.active) {
      p.speed = p.baseSpeed; // восстановление после предыдущей блокировки — см. _avoidStatic
      this._avoidStatic(p, dt);
    }
    p.pos += p.speed * dt * p.dir;
    if (p.turnT > 0) { p.turnT -= dt; return; }
    if (Math.abs(p.pos) > PED_TURN_LIMIT) {
      p.dir = -p.dir;
      p.pos = clamp(p.pos, -PED_TURN_LIMIT, PED_TURN_LIMIT);
      p.turnT = 0.5;
      this._assignNewTarget(p);
      return;
    }

    const isec = Math.round(p.pos / CFG.CELL) * CFG.CELL;
    // Корректировка направления согласно цели p.targetIsec
    if (p.targetIsec !== null) {
      if ((p.targetIsec > p.pos && p.dir < 0) || (p.targetIsec < p.pos && p.dir > 0)) {
        p.dir = p.targetIsec >= p.pos ? 1 : -1;
      }
    }

    if (Math.abs(isec) <= 256 && Math.abs(p.pos - isec) < 1.2) {
      this._decide(p, isec);
    }
  }

  /* Осознанный выбор действия на перекрёстке */
  _decide(p, isec) {
    // Анти-flip-flop (ревью 2.2): если пешеход ушёл от заблокированного
    // перекрёстка — обнулить. Если всё ещё на нём — не пытаться повернуть.
    if (p._blockedTurnIsec !== null && Math.abs(isec - p._blockedTurnIsec) > CFG.CELL * 0.5) {
      p._blockedTurnIsec = null;
    }
    // Если животное — оно часто просто перебегает дорогу или поворачивает.
    // turnBlocked-гейт как в человеческой ветке ниже (grill-plan G5): без
    // него животное в составном случае (заблокировано и по ходу через
    // _avoidStatic — speed=0, и на повороте) может флип-флопить на том же
    // перекрёстке — turnT=1.2 истечёт, а _decide попробует _startTurn снова.
    if (p.isAnimal) {
      const animalRoll = Math.random();
      const turnBlocked = p._blockedTurnIsec === isec;
      if (animalRoll < 0.35) { this._startCross(p); return; }
      if (!turnBlocked && animalRoll < 0.70) { this._startTurn(p, isec); return; }
      p.turnT = rand(0.4, 0.9);
      return;
    }

    // Для человека: если достиг целевого перекрёстка — выбирает поворот или переход для продолжения пути
    const reachedTarget = p.targetIsec !== null && Math.abs(isec - p.targetIsec) < CFG.CELL * 0.5;
    const roll = Math.random();
    const turnBlocked = p._blockedTurnIsec === isec;

    if (reachedTarget) {
      this._assignNewTarget(p);
      if (!turnBlocked && roll < 0.45) { this._startTurn(p, isec); return; }
      if (roll < 0.85) { this._startCross(p); return; }
      p.turnT = 1.0;
      return;
    }

    // Проходной перекрёсток — преимущественно идём прямо
    if (!turnBlocked && roll < 0.10) { this._startCross(p); return; }
    if (!turnBlocked && roll < 0.25) { this._startTurn(p, isec); return; }
    p.turnT = rand(0.5, 1.2);
  }

  /* Начать переход */
  _startCross(p, jwalk = false) {
    if (!jwalk) p.pos = Math.round(p.pos / CFG.CELL) * CFG.CELL;
    p.mode = p.isAnimal ? 'cross' : 'wait'; // Животные сразу идут на переход
    p.waitT = 0;
    const crossSpeed = p.isAnimal ? p.speed * 1.5 : p.speed * 1.3;
    p.cross = {
      from: p.side * PED_SIDE,
      to: -p.side * PED_SIDE,
      t: 0,
      dur: (PED_SIDE * 2) / crossSpeed,
      jwalk,
    };
  }

  /* Ожидание светофора / проезда */
  _updateWait(p, dt) {
    p.waitT += dt;

    const light = this._getLightForPed(p);
    if (light) {
      if (light.state !== 2 && !p.violator) {
        if (p.waitT > 22.0) this._cancelCross(p);
        return;
      }
      if (this._carOnRoad(p, 25)) return;
      p.mode = 'cross';
    } else {
      if (this._carOnRoad(p, 32)) {
        if (p.waitT > 12.0) this._cancelCross(p);
        return;
      }
      p.mode = 'cross';
    }
  }

  _cancelCross(p) {
    p.cross = null;
    if (p.active && (p._edgeKind === 'cross' || p._edgeKind === 'jwalk')) {
      // маршрут через эту зебру отменён (слишком долгий красный / машины) —
      // не выдаём это за завершённый переход; пересчитаем маршрут заново
      p.route = null; p.routeIdx = 0; p.active = false; p._reroute = 0.5;
    }
    p.mode = (p.archetype === 'runner' || p.archetype === 'dog') ? 'run' : 'walk';
    p.turnT = 1.5;
  }

  /* Переход через дорогу по зебре */
  _updateCross(p, dt) {
    const c = p.cross;
    if (!c) { p.mode = (p.archetype === 'runner' || p.archetype === 'dog') ? 'run' : 'walk'; return; }

    const light = this._getLightForPed(p);
    const lightTurnedRed = light && light.state !== 2;
    const carApproaching = this._carOnRoad(p, 20);

    if (lightTurnedRed || carApproaching) {
      c.t += dt * 1.6;
    } else {
      c.t += dt;
    }

    if (c.t >= c.dur) {
      p.side = c.to > 0 ? 1 : -1;
      p.mode = (p.archetype === 'runner' || p.archetype === 'dog') ? 'run' : 'walk';
      p.cross = null;
      p.turnT = 2.2;
      // Если точка выхода занята статикой — сдвинуться вдоль тротуара
      // в направлении движения (p.dir сохранён с до перехода).
      if (this.world) {
        const outOff = p.side * PED_SIDE;
        const ox = p.axis === 'z' ? p.coord + outOff : p.pos;
        const oz = p.axis === 'z' ? p.pos : p.coord + outOff;
        if (this._obstacleAt(ox, oz)) {
          for (const step of [1.5, -1.5, 3.0, -3.0]) {
            const tx = p.axis === 'z' ? ox : ox + step * p.dir;
            const tz = p.axis === 'z' ? oz + step * p.dir : oz;
            if (!this._obstacleAt(tx, tz)) {
              p.pos = p.axis === 'z' ? tz : tx;
              break;
            }
          }
        }
      }
    }
  }

  /* Поворот на перекрёстке. Перед поворотом проверяет дугу (прямую от
     текущей позиции до новой) на препятствия — на углах стоят светофоры,
     знаки, фонари. Если занято: отказ от поворота, запоминаем заблокированный
     перекрёсток в p._blockedTurnIsec (анти-flip-flop, ревью 2.2), идём прямо. */
  _startTurn(p, isec) {
    const wp0 = this._worldPos(p, _tempPedWpTurn);
    const side = p.side;
    const oldCoord = p.coord;
    let x1, z1;
    if (p.axis === 'z') {
      x1 = oldCoord;
      z1 = isec + side * PED_SIDE;
    } else {
      x1 = isec + side * PED_SIDE;
      z1 = oldCoord;
    }
    // Проверить дугу поворота. Радиус корпуса пешехода 0.4 уже учтён в
    // _obstacleAt (_checkPropCollision(x, z, 0.4)) — отдельная ширина дуги
    // не нужна (ревью 2.4).
    if (this.world && segmentBlocked(wp0.x, wp0.z, x1, z1, (x, z) => this._obstacleAt(x, z), 8)) {
      p._blockedTurnIsec = isec;
      p.turnT = 1.2;
      return;
    }
    if (p.axis === 'z') { p.axis = 'x'; p.coord = isec; p.pos = oldCoord; }
    else { p.axis = 'z'; p.coord = isec; p.pos = oldCoord; }
    p.mode = 'turn';
    p.turn = {
      x0: wp0.x, z0: wp0.z, x1, z1, t: 0,
      dur: Math.hypot(x1 - wp0.x, z1 - wp0.z) / Math.max(p.speed, 0.5),
    };
  }

  _updateTurn(p, dt) {
    const t = p.turn;
    t.t += dt;
    if (t.t >= t.dur) {
      p.mode = (p.archetype === 'runner' || p.archetype === 'dog') ? 'run' : 'walk';
      p.turn = null;
      p.turnT = 1.0;
    }
  }

  /* Точка на ленте с заданным боковым смещением (для проверки препятствий) */
  _lanePoint(p, off, out = _tempPedProbe) {
    const o = p.side * PED_SIDE + off;
    if (p.axis === 'z') { out.x = p.coord + o; out.z = p.pos; }
    else { out.x = p.pos; out.z = p.coord + o; }
    return out;
  }

  /* Есть ли статическое препятствие (пропс/здание/круглый коллайдер) в точке.
     Здания — через одноразовый spatial hash (initGraph, Task 4), не линейным
     перебором ~250 AABB на каждого активного пешехода каждый кадр. */
  _obstacleAt(x, z) {
    const w = this.world;
    if (!w) return false;
    if (w._checkPropCollision(x, z, 0.4)) return true;
    if (this._buildingHash) {
      const cell = 16;
      const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const bucket = this._buildingHash.get((cx + dx) + ',' + (cz + dz));
        if (!bucket) continue;
        for (const b of bucket) {
          if (x > b.x0 - 0.3 && x < b.x1 + 0.3 && z > b.z0 - 0.3 && z < b.z1 + 0.3) return true;
        }
      }
    }
    for (const c of w.circleColliders) {
      if (Math.hypot(x - c.x, z - c.z) < c.r + 0.3) return true;
    }
    return false;
  }

  /* Свободно ли место для спавна (нет статики, машин, игрока) */
  _spotBlocked(x, z) {
    if (this._obstacleAt(x, z)) return true;
    const tr = this.trafficRef;
    if (tr) {
      for (const c of tr.cars) {
        if (c.alive && Math.hypot(c.x - x, c.z - z) < c.radius + 1.1) return true;
      }
    }
    const pl = this._playerRef;
    if (pl && Math.hypot(pl.x - x, pl.z - z) < 3.0) return true;
    return false;
  }

  /* Боковое смещение вокруг статики (активная и ближняя зоны). Multi-probe:
     три точки вперёд (0.6, 1.4, 2.2 м) — один probe на 2.2 м пропускал узкие
     столбы/урны в слепой зоне ~1.4 м. probeForwardBlocked — zero-alloc, для
     hot-path. laneOff ограничен ±1.5 (полуширина тротуара 2 м минус запас
     на корпус пешехода). Полная блокировка дольше 1.5 с — явная реакция:
     активный пересчитывает маршрут, пассивный разворачивается. */
  _avoidStatic(p, dt) {
    if (!this.world || (!p.nearZone && !p.active)) return;
    const dirX = p.axis === 'z' ? 0 : p.dir;
    const dirZ = p.axis === 'z' ? p.dir : 0;
    const baseOff = p.laneOff || 0;
    const probe0 = this._lanePoint(p, baseOff);
    // this._obstacleAtBound — захостен один раз в конструкторе (grill-plan G9), не
    // аллоцировать замыкание здесь каждый кадр на каждого пешехода.
    if (!probeForwardBlocked(probe0.x, probe0.z, dirX, dirZ, FORWARD_DISTANCES, this._obstacleAtBound)) {
      p.laneOff *= Math.max(0, 1 - 4 * dt);
      if (Math.abs(p.laneOff) < 0.02) p.laneOff = 0;
      p._stuckT = 0;
      return;
    }
    for (const o of [1.4, -1.4, 2.4, -2.4]) {
      const cand = clamp(baseOff + o, -1.5, 1.5);
      const pr0 = this._lanePoint(p, cand);
      if (!probeForwardBlocked(pr0.x, pr0.z, dirX, dirZ, FORWARD_DISTANCES, this._obstacleAtBound)) {
        p.laneOff = cand; p._stuckT = 0; return;
      }
    }
    // заблокировано с обеих сторон
    p.speed = 0;
    p._stuckT += dt;
    if (p._stuckT > 1.5) {
      p._stuckT = 0;
      if (p.active) {
        // не держим протухший маршрут — деактивация с коротким кулдауном
        // даёт _classify пере-активировать пешехода на следующем тике с
        // новой целью, минуя препятствие
        p.route = null; p.routeIdx = 0; p.active = false; p._reroute = 0.3;
      } else {
        p.dir = -p.dir; p.turnT = 0.5;
      }
    }
  }

  /* Разъезд активных пешеходов на одной ленте (кар-фолловинг + обгон).
     Лидер с сильно отличающимся laneOff (>0.9 м) пропускается — иначе
     пешеход, ушедший вбок для обгона, продолжает считаться «впереди» и
     обгон никогда не завершается (dt — не 1/60, чтобы таймер не зависел от
     частоты кадров). */
  _avoidPeds(p, dt) {
    for (const o of this.cars) {
      if (o === p || !o.alive || !o.active) continue;
      if (o.mode !== 'walk' && o.mode !== 'run' && o.mode !== 'idle' && o.mode !== 'wait') continue;
      if (o.axis !== p.axis || o.coord !== p.coord || o.side !== p.side) continue;
      if (Math.abs((o.laneOff || 0) - (p.laneOff || 0)) > 0.9) continue;
      const d = (o.pos - p.pos) * p.dir;
      if (d <= 0 || d > 2.2) continue;
      const leaderSpeed = (o.mode === 'idle' || o.mode === 'wait') ? 0 : o.speed;
      if (p.speed > leaderSpeed) p.speed = Math.max(0.3, leaderSpeed);
      if (leaderSpeed < p.baseSpeed * 0.6) {
        p._blockedT += dt;
        if (p._blockedT > 1.0 && p.laneOff === 0) {
          // Встречные (o.dir !== p.dir) видят друг друга "впереди"
          // ОДНОВРЕМЕННО: формула ниже для обгона ((o.laneOff||0)>=0?-1.4:1.4)
          // при laneOff=0 с обеих сторон даёт ОДИНАКОВЫЙ знак для обоих — оба
          // уходят в одну и ту же сторону и продолжают блокировать друг
          // друга. Для встречных используем правило, зависящее только от
          // собственного p.dir — у встречных dir противоположны, значит и
          // знак гарантированно разный, они расходятся. Для обгона (тот же
          // dir, лидер медленнее) сторона по-прежнему выбирается от лидера.
          const headOn = o.dir !== p.dir;
          p.laneOff = headOn
            ? (p.dir > 0 ? 1.4 : -1.4)
            : ((o.laneOff || 0) >= 0 ? -1.4 : 1.4);
          p.speed = Math.min(p.baseSpeed * 1.25, p.speed + 0.5);
        }
      } else {
        p._blockedT = 0;
      }
    }
    if (p._blockedT > 2.0) p._blockedT = 0; // не копим вечно
  }

  /* Активное движение по маршруту (активная зона) */
  _updateActive(p, dt) {
    if (p.mode === 'kick') return;
    if (p.mode === 'idle') {
      p.idleT -= dt;
      if (p.idleT <= 0) this._activate(p);
      return;
    }
    // Защита от рассинхронизации: p.active=true, mode уже не 'idle', но
    // маршрут отсутствует (например, idle-пешехода толкнула/сбила машина —
    // _checkNearMissAndKick восстанавливает mode в walk/run, не зная про
    // route=null, выставленный _arrive). Без этой проверки walk-хвост ниже
    // мог дойти до _finishEdge -> _startEdge -> `p.route.length` на null и
    // уронить update() КАЖДЫЙ кадр (см. находка 1 финального ревью).
    if (!p.route) { this._deactivate(p); return; }
    if (p.mode === 'wait') {
      this._updateWait(p, dt);
      return;
    }
    if (p.mode === 'cross') {
      this._updateCross(p, dt);
      if (p.cross === null && (p._edgeKind === 'cross' || p._edgeKind === 'jwalk')) {
        this._finishEdge(p);
      }
      return;
    }
    if (p.mode === 'turn') {
      this._updateTurn(p, dt);
      if (p.turn === null && p._edgeKind === 'turn') {
        const t = p._turnTo;
        p.axis = t.newAxis; p.coord = t.newCoord; p.side = t.newSide; p.pos = t.newPos;
        this._finishEdge(p);
      }
      return;
    }
    // walk/run по ленте: скорость восстанавливаем КАЖДЫЙ кадр, иначе пешеход,
    // один раз упёршийся в препятствие/лидера (_avoidStatic/_avoidPeds ставят
    // speed=0 или снижают его), остаётся замороженным навсегда — ничто больше
    // не поднимает speed обратно к baseSpeed.
    p.speed = p.baseSpeed;
    this._avoidStatic(p, dt);
    // Деактивация зависшего пешехода внутри _avoidStatic (p.active=false; p.route=null)
    // не сбрасывает p._edgeKind — без этого return код ниже может дойти до
    // _finishEdge -> _startEdge -> p.route.length на null и уронить update() кадра
    // (grill-plan G2).
    if (!p.active || !p.route) return;
    this._avoidPeds(p, dt);
    p.pos += p.speed * dt * p.dir;
    if (p._edgeKind === 'walk' && Math.abs(p.pos - p.edgeEnd) < 0.7) {
      this._finishEdge(p);
      return;
    }
    // ВАЖНО: здесь НЕТ проверки `p._edgeKind === 'cross' || 'jwalk'` — если
    // она сюда попала, значит переход был прерван через _cancelCross (см.
    // ниже), а не завершён по-настоящему; притворяться, что дорога перейдена,
    // и продвигать routeIdx — баг (пешеход остаётся на своей стороне, а
    // маршрут думает, что он уже на другой). Настоящее завершение перехода
    // обрабатывается веткой `p.mode === 'cross'` выше.
  }

  /* Реакция на близкий проезд игрока (Near-Miss) и пинание авто */
  _checkNearMissAndKick(p, player, dt) {
    if (!player || p.knockT > 0 || p.mode === 'flee') return;

    const dx = player.x - p.x;
    const dz = player.z - p.z;
    const dist = Math.hypot(dx, dz);

    if (dist > 12) return;

    // Животные пугаются и отбегают
    if (p.isAnimal) {
      if (dist < 4.5 && Math.abs(player.speed) > 2.0 && p.fleeT <= 0) {
        this._startFlee(p, -dx, -dz, 4.0);
        this.say(p, p.archetype === 'dog' ? choice(ANIMAL_DOG_QUOTES) : choice(ANIMAL_CAT_QUOTES), 2.0);
      }
      return;
    }

    // Детекция подрезания / подбегания игрока к человеку
    if (dist < 3.2 && player.speed > 2.5 && p.hitCd <= 0 && p.angerT <= 0 && p.mode !== 'cross') {
      p.angerT = 4.0;
      p.targetAngle = Math.atan2(dx, dz);
      this.say(p, choice(CURSE_QUOTES), 3.0);
    }

    // Разъярённый пешеход пинает авто игрока
    if (p.angerT > 0) {
      p.angerT -= dt;
      if (dist < 2.4 && Math.abs(player.speed) < 3.5 && p.kickCd <= 0 && p.kickT <= 0) {
        p.mode = 'kick';
        p.kickT = 0.6;
        p.kickCd = 6.0;
        p.targetAngle = Math.atan2(dx, dz);
        Events.emit('ped:kick');
        this.say(p, choice(KICK_QUOTES), 2.5);
      }
    }

    if (p.kickCd > 0) p.kickCd -= dt;
    if (p.kickT > 0) {
      p.kickT -= dt;
      if (p.kickT <= 0 && p.mode === 'kick') {
        // Пинок мог застать пешехода посреди cross/wait/turn маршрута — mode
        // здесь безусловно перезаписывался в 'walk'/'run', оставляя p.turn/
        // p.route/_edgeKind от прерванного шага рассинхронизированными
        // (см. находка 2 финального ревью). Для АКТИВНЫХ пешеходов не
        // восстанавливаем mode напрямую, а полностью разбираем маршрут через
        // _deactivate — на следующем тике _classify реактивирует пешехода с
        // чистого листа. Для неактивных (обычная прогулка по тротуару)
        // поведение не меняем.
        const wasActive = p.active;
        p.mode = this._restMode(p);
        if (wasActive) {
          // Разбираем и turn/cross-состояние прерванного шага маршрута —
          // _deactivate само их не трогает (используется и из мест, где
          // mode гарантированно не turn/cross), а здесь mode только что был
          // 'kick' поверх любого из них.
          p.turn = null; p.cross = null;
          this._deactivate(p);
        }
      }
    }
  }

  update(dt, player, traffic, world) {
    this.trafficRef = traffic;
    this._playerRef = player;
    if (world) this.world = world;
    if (world && !this.graph) this.initGraph(world);
    if (traffic && traffic.lightsRef) this.lightsRef = traffic.lightsRef;
    this._classify(dt);
    if (world && world.lights) this.lightsRef = world.lights;

    for (const p of this.cars) {
      if (!p.alive) continue;
      if (p.hitCd > 0) p.hitCd -= dt;
      p.walk = (p.walk || 0) + dt * p.speed * (p.mode === 'run' ? 6 : 4);

      // Облака речи
      if (p.speechT > 0) {
        p.speechT -= dt;
        if (p.speechT <= 0 && p.speechSprite) updateSpeechSprite(p.speechSprite, '');
      } else {
        p.chatCd -= dt;
        if (p.chatCd <= 0 && Math.hypot(p.x - player.x, p.z - player.z) < 45) {
          if (p.isAnimal) {
            this.say(p, p.archetype === 'dog' ? choice(ANIMAL_DOG_QUOTES) : choice(ANIMAL_CAT_QUOTES), 2.0);
          } else {
            this.say(p, choice(IDLE_QUOTES), 3.0);
          }
          p.chatCd = rand(16, 36);
        }
      }

      this._checkNearMissAndKick(p, player, dt);

      if (p.knockT > 0) {
        p.knockT -= dt;
        p.fx += p.fvx * dt * 0.25;
        p.fz += p.fvz * dt * 0.25;
        if (p.knockT <= 0) this._startFlee(p, p.fvx, p.fvz, 3.4);
      } else if (p.mode === 'flee') {
        p.fx += p.fvx * dt;
        p.fz += p.fvz * dt;
        p.fleeT -= dt;
        if (p.fleeT <= 0) this._snapToSidewalk(p);
      } else if (p.active) this._updateActive(p, dt);
      else if (p.mode === 'cross') this._updateCross(p, dt);
      else if (p.mode === 'turn') this._updateTurn(p, dt);
      else if (p.mode === 'wait') this._updateWait(p, dt);
      else if (p.mode !== 'kick') this._updateWalk(p, dt);

      const wp = this._worldPos(p, _tempPedWp);
      p.x = wp.x; p.z = wp.z;

      if (Math.hypot(p.x - player.x, p.z - player.z) > 210) {
        this._randPlace(p, player);
        continue;
      }

      this._animate(p);
      this._sync(p);
    }
  }

  /* Увернуться от машины */
  _dodge(p, dx, dz, carSpeed) {
    p.fx = p.x; p.fz = p.z;
    this._startFlee(p, dx, dz, Math.max(3.2, carSpeed * 0.9 + 0.8));
  }

  /* Сбит машиной */
  _knockDown(p, dx, dz, carSpeed) {
    p.fx = p.x; p.fz = p.z;
    p.mode = 'walk';
    p.knockT = 2.0;
    p.cross = null; p.turn = null;
    const sp = 3 + Math.min(carSpeed, 16) * 0.3;
    const len = Math.hypot(dx, dz) || 1;
    p.fvx = (dx / len) * sp;
    p.fvz = (dz / len) * sp;
    if (p.isAnimal) {
      this.say(p, p.archetype === 'dog' ? "Уау-гав!" : "Мяу-у-у!", 2.0);
    } else {
      this.say(p, "Аааах!!", 2.0);
    }
  }

  /* Свободное убегание */
  _startFlee(p, dx, dz, speed) {
    p.mode = 'flee';
    p.fleeT = 1.0 + speed * 0.15;
    const len = Math.hypot(dx, dz) || 1;
    p.fvx = (dx / len) * speed;
    p.fvz = (dz / len) * speed;
    p.cross = null; p.turn = null;
    if (!p.isAnimal) {
      this.say(p, "Сайгак на колёсах!", 2.5);
    }
  }

  /* Превратить готовую модель клиента (отправитель/получатель посылки) в полноценного
     городского пешехода: он уходит с точки и дальше живёт по общим правилам ИИ */
  adoptPedestrian(mesh, x, z) {
    const ped = {
      mesh,
      archetype: (mesh.userData && mesh.userData.archetype) || 'regular',
      isAnimal: false, alive: true, x: 0, z: 0, axis: 'z', dir: Math.random() < 0.5 ? 1 : -1,
      speed: 0, baseSpeed: rand(1.8, 2.7), side: 1, turnT: 0, mode: 'walk', cross: null, turn: null,
      targetPos: null, targetIsec: null,
      waitT: 0, fx: 0, fz: 0, fvx: 0, fvz: 0, fleeT: 0, knockT: 0, hitCd: 0,
      angerT: 0, kickT: 0, kickCd: 0, speechT: 0, chatCd: rand(10, 30), walk: 0,
      violator: Math.random() < CFG.pedViolatorChance,
      active: false, nearZone: false, laneOff: 0,
      route: null, routeIdx: 0, _edgeKind: null, edgeEnd: 0,
      idleT: 0, _blockedT: 0, _stuckT: 0, _reroute: 0,
      _blockedTurnIsec: null,
    };
    ped.fx = x; ped.fz = z;
    this._snapToSidewalk(ped);
    const wp = this._worldPos(ped, _tempPedWpSync);
    ped.x = wp.x; ped.z = wp.z;
    this.cars.push(ped);
    if (this._playerRef && Math.hypot(ped.x - this._playerRef.x, ped.z - this._playerRef.z) <= CFG.pedActiveRadius) {
      this._activate(ped);
    }
    return ped;
  }

  /* Вернуть убежавшего на тротуар */
  _snapToSidewalk(p) {
    const rx = clamp(Math.round(p.fx / CFG.CELL) * CFG.CELL, -256, 256);
    const rz = clamp(Math.round(p.fz / CFG.CELL) * CFG.CELL, -256, 256);
    if (Math.abs(p.fx - rx) <= Math.abs(p.fz - rz)) {
      p.axis = 'z'; p.coord = rx; p.pos = clamp(p.fz, -256, 256); p.side = p.fx >= rx ? 1 : -1;
    } else {
      p.axis = 'x'; p.coord = rz; p.pos = clamp(p.fx, -256, 256); p.side = p.fz >= rz ? 1 : -1;
    }
    p.mode = (p.archetype === 'runner' || p.archetype === 'dog') ? 'run' : 'walk';
    p.turnT = 0.8;
    p.speed = p.baseSpeed;
    this._assignNewTarget(p);
    if (this.graph && p.active) this._activate(p);
  }

  _sync(p) {
    const h = this.world ? this.world.heightAt(p.x, p.z) : 0;
    p.mesh.position.set(p.x, h + 0.02, p.z);
    if (p.knockT > 0) {
      p.mesh.rotation.set(0, Math.atan2(p.fvx, p.fvz), Math.PI / 2);
    } else {
      p.mesh.rotation.x = 0; p.mesh.rotation.z = 0;
      p.mesh.rotation.y = this._heading(p);
    }
  }

  debugSummary() {
    if (!this.graph) return 'graph: none';
    const active = this.cars.filter(p => p.active).length;
    const near = this.cars.filter(p => p.nearZone).length;
    const routes = this.cars.filter(p => p.route).length;
    return `nodes:${this.graph.nodes.length} active:${active} near:${near} routed:${routes}`;
  }
}


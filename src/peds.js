import * as THREE from 'three';
import { CFG } from './config.js';
import { rand, clamp, lerp, choice, buildPedMesh, makeSpeechSprite, updateSpeechSprite, isInPlayerView } from './utils.js';
import { Events } from './eventbus.js';

const _tempPedWp = { x: 0, z: 0 };
const _tempPedWpSync = { x: 0, z: 0 };
const _tempPedWpTurn = { x: 0, z: 0 };

const PED_COLORS = [0xd8a878, 0x8a5a3a, 0xc89060, 0xa87850, 0xb08058, 0x6a4a30];
const PED_SIDE = CFG.HALF + CFG.SIDE / 2; // 8 — центр тротуара от оси дороги

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
        angerT: 0, kickT: 0, kickCd: 0, speechT: 0, chatCd: rand(10, 30)
      };
      this.cars.push(ped);
      this.scene.add(mesh);
    }
    for (const p of this.cars) this._randPlace(p, player);
  }

  /* Размещение пешехода с гарантированной защитой от появления в зоне видимости игрока */
  _randPlace(p, player) {
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

  /* Назначение целевого пункта для пешехода */
  _assignNewTarget(p) {
    const isecStep = CFG.CELL;
    // Выбираем целевой перекрёсток впереди по вектору или на расстоянии 2-4 блоков
    const targetIsec = Math.round((p.pos + p.dir * rand(isecStep * 1.5, isecStep * 3.5)) / isecStep) * isecStep;
    p.targetIsec = clamp(targetIsec, -256, 256);
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
    const off = p.side * PED_SIDE;
    if (p.axis === 'z') { out.x = p.coord + off; out.z = p.pos; }
    else { out.x = p.pos; out.z = p.coord + off; }
    return out;
  }

  /* Поиск светофора */
  _getLightForPed(p) {
    if (p.isAnimal) return null; // Животные игнорируют светофоры!
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
    p.pos += p.speed * dt * p.dir;
    if (p.turnT > 0) { p.turnT -= dt; return; }
    if (Math.abs(p.pos) > 232) {
      p.dir = -p.dir;
      p.pos = clamp(p.pos, -232, 232);
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
    // Если животное — оно часто просто перебегает дорогу или поворачивает
    if (p.isAnimal) {
      const animalRoll = Math.random();
      if (animalRoll < 0.35) { this._startCross(p); return; }
      if (animalRoll < 0.70) { this._startTurn(p, isec); return; }
      p.turnT = rand(0.4, 0.9);
      return;
    }

    // Для человека: если достиг целевого перекрёстка — выбирает поворот или переход для продолжения пути
    const reachedTarget = p.targetIsec !== null && Math.abs(isec - p.targetIsec) < CFG.CELL * 0.5;
    const roll = Math.random();

    if (reachedTarget) {
      this._assignNewTarget(p);
      if (roll < 0.45) { this._startTurn(p, isec); return; }
      if (roll < 0.85) { this._startCross(p); return; }
      p.turnT = 1.0;
      return;
    }

    // Проходной перекрёсток — преимущественно идём прямо
    if (roll < 0.10) { this._startCross(p); return; }
    if (roll < 0.25) { this._startTurn(p, isec); return; }
    p.turnT = rand(0.5, 1.2);
  }

  /* Начать переход */
  _startCross(p) {
    p.pos = Math.round(p.pos / CFG.CELL) * CFG.CELL;
    p.mode = p.isAnimal ? 'cross' : 'wait'; // Животные сразу идут на переход
    p.waitT = 0;
    const crossSpeed = p.isAnimal ? p.speed * 1.5 : p.speed * 1.3;
    p.cross = {
      from: p.side * PED_SIDE,
      to: -p.side * PED_SIDE,
      t: 0,
      dur: (PED_SIDE * 2) / crossSpeed,
    };
  }

  /* Ожидание светофора / проезда */
  _updateWait(p, dt) {
    p.waitT += dt;

    const light = this._getLightForPed(p);
    if (light) {
      if (light.state !== 2) {
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
    p.mode = (p.archetype === 'runner' || p.archetype === 'dog') ? 'run' : 'walk';
    p.cross = null;
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
    }
  }

  /* Поворот на перекрёстке */
  _startTurn(p, isec) {
    const wp0 = this._worldPos(p, _tempPedWpTurn);
    const side = p.side;
    const oldCoord = p.coord;
    let x1, z1;
    if (p.axis === 'z') {
      x1 = oldCoord;
      z1 = isec + side * PED_SIDE;
      p.axis = 'x'; p.coord = isec; p.pos = oldCoord;
    } else {
      x1 = isec + side * PED_SIDE;
      z1 = oldCoord;
      p.axis = 'z'; p.coord = isec; p.pos = oldCoord;
    }
    p.mode = 'turn';
    p.turn = {
      x0: wp0.x, z0: wp0.z, x1, z1, t: 0,
      dur: Math.hypot(x1 - wp0.x, z1 - wp0.z) / p.speed,
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
      if (p.kickT <= 0 && p.mode === 'kick') p.mode = p.archetype === 'runner' ? 'run' : 'walk';
    }
  }

  update(dt, player, traffic, world) {
    this.trafficRef = traffic;
    this._playerRef = player;
    if (world) this.world = world;
    if (traffic && traffic.lightsRef) this.lightsRef = traffic.lightsRef;
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
      } else if (p.mode === 'cross') this._updateCross(p, dt);
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
    };
    ped.fx = x; ped.fz = z;
    this._snapToSidewalk(ped);
    const wp = this._worldPos(ped, _tempPedWpSync);
    ped.x = wp.x; ped.z = wp.z;
    this.cars.push(ped);
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
}


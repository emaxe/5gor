# Пешеходы проходят сквозь статику и тупят на краю — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Убрать прохождение пешеходов сквозь столбы/лавочки/кусты/знаки/светофоры и застой на краю карты.

**Architecture:** Вынести геометрические пробы в чистый модуль `pedavoid.js` (без THREE/DOM — тестируется в node) и переиспользовать его из `peds.js`. Точечные правки в `peds.js`: zero-alloc multi-probe в `_avoidStatic`, проверка дуги поворота в `_startTurn` с анти-flip-flop, достижимая цель `targetIsec`. Плюс мелкие: проверка выхода с зебры и сдвиг из препятствия при активации.

**Tech Stack:** vanilla JS (ESM), `node:test`, `node:assert/strict`. Сборка через `python3 build.py` (см. AGENTS.md — `build.py` — регулярки, порядок в `MODULES` важен).

---

## Контекст для разработчика

### Что вообще происходит

`src/peds.js` — менеджер пешеходов (`PedestrianManager`). Пешеходы ходят по тротуарам (offset `±8` от оси дороги — `CFG.HALF + CFG.SIDE/2 = 6 + 4/2 = 8`, константа `PED_SIDE` в `peds.js`). Статика города (столбы фонарей, урны, кусты, лавочки, знаки, светофоры) лежит в `world.propsAABB` (AABB-прямоугольники) и `world.circleColliders` (круги) в `src/citygen.js`.

### Где стоит статика на тротуаре (offset от оси дороги)

| Объект | offset | Размер AABB (м) | Источник в citygen.js |
|---|---|---|---|
| Фонари | 8.5 | 0.8 × 0.8 | `_lamps` :1944, столб 0.12 r |
| Урны | 8.5 | 1.0 × 1.0 | `_props` :1998, цилиндр 0.4 r |
| Кусты | random | 2.0 × 2.0 | `_props` :2024, сфера 0.9 r |
| Скамьи | 9.2 | 2.6 × 2.6 (повёрнутый `_rotRect`) | `_streetBenches` :2224, `_bench` :1273 |
| Вазоны | 9.2 | 1.2 × 1.2 | `_planters` :2254, `_planter` :1290 |
| Знаки | 7.8 | 0.8 × 0.8 | `_signs` :2185 |
| Светофоры | 8.2 | 0.8 × 0.8 | `_trafficLights` :2276 |

Пешеход ходит по `x = road ± 8` (offset `PED_SIDE = 8`). Узкая статика на 8.5 (фонари, урны) — в 0.5 м от оси движения. Широкая (лавочки на 9.2 — 2.6 м AABB) доходит до `9.2 + 1.3 = 10.5`, но сидящий пешеход на 8.0 с корпусом ~0.3 доходит до 8.3. Лавка на 9.2-1.3=7.9 может цеплять.

### Существующая защита (peds.js:842-877, `_avoidStatic`)

```js
_avoidStatic(p, dt) {
  if (!this.world || (!p.nearZone && !p.active)) return;
  const look = 2.2;
  // один probe ВПЕРЁД на 2.2 м от текущей позиции
  // ...
  if (!this._obstacleAt(probe.x, probe.z)) { /* чисто, гасим laneOff */ return; }
  // если занято — пробуем 4 боковых оффсета (±1.4, ±2.4)
  // если все заняты — speed=0, _stuckT, через 1.5с — разворот/перерасчёт
}
```

Проблемы:
1. **Один probe на 2.2 м вперёд**. Между пешеходом (на `p.pos`) и probe-точкой (`p.pos + 2.2*dir`) — "слепая" полоса ~1.4 м (считая радиус корпуса 0.4). Узкий столб (AABB 0.8) в этом зазоре не детектится — пешеход влетает и проходит сквозь, потому что `_obstacleAt` на probe-точке через 2.2 м уже чисто (столб остался позади probe).
2. Только на `nearZone` (≤150 м) и `active` (≤110 м). Дальние пешеходы обходят только на бэкапе `_decide` в перекрёстках.
3. **Не проверяет точку под собой** — пешеход, заспавненный/реактивированный внутри препятствия, из него не выходит.

### `_obstacleAt(x, z)` (peds.js:801-820)

```js
_obstacleAt(x, z) {
  const w = this.world;
  if (!w) return false;
  if (w._checkPropCollision(x, z, 0.4)) return true;       // propsAABB, radius 0.4
  // ... здания через spatial hash ...
  for (const c of w.circleColliders) {
    if (Math.hypot(x - c.x, z - c.z) < c.r + 0.3) return true;  // озёра, radius + 0.3
  }
  return false;
}
```

`_checkPropCollision` (citygen.js:176-189) — spatial hash propsAABB по ячейкам 10×10 м, проверяет AABB с радиусом 0.4. Узкие столбы (AABB 0.8) детектятся только когда probe-точка в их AABB + 0.4. **Радиус корпуса пешехода 0.4 уже учтён в `_obstacleAt`** — это важно для `segmentBlocked` (Task 4): чистая функция сэмплирует точки на отрезке, а `_obstacleAt` вокруг каждой точки уже добавляет радиус 0.4, так что столб на 0.2 м от линии отрезка будет пойман.

### `_startTurn` (peds.js:759-778) — срез угла

```js
_startTurn(p, isec) {
  const wp0 = this._worldPos(p, _tempPedWpTurn);  // текущая позиция
  // ...
  if (p.axis === 'z') {
    x1 = oldCoord;                                 // та же x-координата дороги
    z1 = isec + side * PED_SIDE;                   // новое z на перпендикулярной ленте
    p.axis = 'x'; p.coord = isec; p.pos = oldCoord;
  }
  // ... прямая линия от (wp0.x, wp0.z) до (x1, z1), без проверки препятствий
  p.turn = { x0: wp0.x, z0: wp0.z, x1, z1, t: 0, dur: ... };
}
```

Поворот — прямая линия от текущей позиции до новой. Пешеход на ленте `z` с `side=+1` стоит на `(x=coord+8, z=isec±small)`. Поворачивает на ленту `x`: новая позиция `(x=isec+8, z=coord)`. Прямая между ними срезает угол перекрёстка, где стоят светофоры (offset 8.2), знаки (7.8), фонари (8.5). AABB там ~0.8 м — пешеход проходит сквозь.

### `targetIsec` (peds.js:274-279, 646-656) — тупёж на краю

```js
_assignNewTarget(p) {
  const targetIsec = Math.round((p.pos + p.dir * rand(isecStep * 1.5, isecStep * 3.5)) / isecStep) * isecStep;
  p.targetIsec = clamp(targetIsec, -256, 256);
}
// в _updateWalk:
if (p.targetIsec !== null) {
  if ((p.targetIsec > p.pos && p.dir < 0) || (p.targetIsec < p.pos && p.dir > 0)) {
    p.dir = p.targetIsec >= p.pos ? 1 : -1;
  }
}
```

Перекрёстки в городе: `-256, -192, -128, -64, 0, 64, 128, 192, 256` (`CFG.CELL = 64`, 9×9). Но `Math.abs(p.pos) > 232` → пешеход разворачивается (peds.js:638). Цель 256 или -256 **недостижима** — пешеход никогда не дойдёт до `|isec - targetIsec| < 32`. Каждый кадр `_updateWalk` корректирует направление к 256, а граница 232 разворачивает обратно. Бесконечный цикл на краю. Константа `232` — хардкод в `_updateWalk` (peds.js:638), без имени.

### `_updateCross` (peds.js:736-756) — выход на занятую точку

```js
if (c.t >= c.dur) {
  p.side = c.to > 0 ? 1 : -1;
  p.mode = (p.archetype === 'runner' || p.archetype === 'dog') ? 'run' : 'walk';
  p.cross = null;
  p.turnT = 2.2;
}
```

После перехода пешеход оказывается на другой стороне на `(coord + to, pos)`. Если там стоит лавочка/столб — он внутри препятствия и `_avoidStatic` его не выгонит (нет probe под собой).

### `_activate` (peds.js:417-442) — активация внутри препятствия

Дальний пешеход (раньше был в `nearZone=false`, без `_avoidStatic`) мог за это время зайти в AABB (через `_updateWalk` без обхода). При активации `_activate` начинает маршрут, но не проверяет, не стоит ли пешеход внутри статики. Первый шаг `walk` к узлу — `_avoidStatic` его там и найдёт, `speed=0`, `_stuckT`, 1.5 с — перерасчёт. Но визуально 1.5 с пешеход стоит внутри лавочки.

### Ограничения сборщика (AGENTS.md → .agents/rules/bundler-constraints.md)

`build.py` — регулярки, не транспилятор. Однострочные import/export, общий global scope после сборки, порядок в `MODULES` — порядок зависимостей. Новые модули добавляем в `build.py` `MODULES` в правильном порядке (зависимости раньше).

### Тесты

`node:test`, запуск: `node --test tests/*.test.mjs` (явный путь обязателен, голый `node --test tests/` не находит тесты в Node 22 — см. `.agents/rules/testing.md`). Существующий: `tests/pedgraph.test.mjs` — стиль: `import` из `../src/`, `test('название', () => {...})`, `assert.ok/equal/deepEqual`.

### Существующий `_obstacleAt` нельзя тестировать в node

`_obstacleAt` — метод `PedestrianManager`, который импортирует `three` и `utils.js` (там `document.createElement`). В node без DOM это падает. Поэтому **новые геометрические пробы выносим в чистый модуль `pedavoid.js`** (без THREE/DOM, только `config.js` если нужно) — он тестируется в node, а `peds.js` переиспользует его функции.

---

## Замечания ревью (2026-08-09-pedestrians-review.md) и реакция

| # | Замечание | Реакция | Где учтено |
|---|---|---|---|
| 2.1 | `buildForwardProbes` аллоцирует массив + объекты каждый выз → GC-нагрузка в 60 FPS цикле | **Принято.** Добавить zero-alloc `probeForwardBlocked` + константный `FORWARD_DISTANCES`. `buildForwardProbes` оставить только для тестов геометрии. | Task 1, Task 2 |
| 2.2 | После отказа от поворота `turnT=1.2` истечёт → `_decide` на том же перекрёстке попробует снова → flip-flop каждые 1.2 с | **Принято.** Добавить `p._blockedTurnIsec`; в `_decide` скипать поворот на этом перекрёстке, обнулять при уходе. | Task 4 |
| 2.3 | Магическое `192` вычислять из `CFG.CELL` и границы 232 | **Принято.** Вынести `232` в именованную константу, `maxReachable` считать как `floor(PED_TURN_LIMIT / CELL) * CELL`. | Task 5 |
| 2.4 | `segmentBlocked` сэмплирует тонкую линию без радиуса пешехода | **Не требует код-правок.** `_obstacleAt` уже добавляет радиус 0.4 (`_checkPropCollision(x, z, 0.4)`), так что столб на 0.2 м от линии отрезка будет пойман. Добавить примечание в Task 4. | Task 4 (примечание) |

---

## Замечания grill-plan (.grill-plan/20260809-174313-pedestrians-through-static/verdict.md) и реакция

Черновик этого плана прошёл прожарку тремя независимыми рецензентами (claude, agy/Gemini,
opencode) — 5 раундов, 18 найденных issue, все закрыты согласованными правками. Три были
**blocker** (план в исходном виде нельзя было выполнять): сломанная сборка, крэш рантайма,
ложная геометрическая предпосылка сразу двух задач. Полный протокол спора — в
`verdict.md` по пути выше.

| # | Замечание | Реакция | Где учтено |
|---|---|---|---|
| G1 (blocker) | `build.py`: записи `MODULES` — имена файлов без префикса `src/` (сборщик сам делает `SRC / m`), а план предписывал `'src/pedavoid.js'` — привело бы к `FileNotFoundError` на первом же `python3 build.py` | **Принято.** Убрать префикс `src/`. | Task 1 |
| G2 (blocker) | `_updateActive` не имеет early-return после `_avoidStatic` — деактивация активного пешехода (`p.route=null; p.active=false`) на той же итерации кадра может дойти до `_finishEdge → _startEdge → p.route.length` на `null` и уронить `update()` | **Принято.** Добавить `if (!p.active \|\| !p.route) return;` сразу после `_avoidStatic`. Баг существовал в коде и до этого плана — Task 2 его лишь чаще триггерит через multi-probe, поэтому фикс обязателен именно здесь. | Task 2 |
| G3 (blocker) | Активные пешеходы (110-150 м от игрока — которых реально видно) поворачивают через `_startEdge`, не через `_startTurn` — `segmentBlocked` их не защищает вообще. Вдобавок сама предпосылка «поворот срезает угол со светофорами/знаками» геометрически не подтверждается: светофор на углу стоит в 5.94 м от линии поворота, знак — в 5.37 м, фонари вне перекрёстков вообще (проверено по координатам `citygen.js` и расчётом расстояния точка-прямая) | **Принято частично.** Убрать ложный claim из обоснования Task 3/4. Не городить route-rejection/пересчёт Dijkstra для несуществующей на практике коллизии. Вместо этого — `_startEdge` для `kind==='turn'` переякоривает начало дуги на текущую позицию пешехода (чинит реальный баг — визуальный телепорт после нуджа/зебры, не саму мнимую коллизию). Честно задокументировать ограничение в тексте плана: если «срез угла» воспроизводится в игре, это, вероятно, проход по проезжей части на диагонали поворота — отдельная, не покрытая этим планом проблема. | Task 3, Task 4 |
| G4 (major) | `_activate`, Task 7: `_nudgeOutOfObstacle(p)` выставляет `p.laneOff = across`, но следующая же строка `p.laneOff = 0` это затирает — для самого частого случая (чистый боковой уход) фикс был бы тихо неработающим | **Принято.** Переставить порядок: сброс `p.laneOff = 0` — до вызова `_nudgeOutOfObstacle`. | Task 7 |
| G5 (major) | `_decide`, animal-ветка: вызывает `_startTurn` без проверки `turnBlocked` (в отличие от человеческой ветки) — в составном случае (заблокирован одновременно и по ходу через `_avoidStatic`, и на повороте) животное может флип-флопить на том же перекрёстке | **Принято.** Добавить `turnBlocked`-гейт в animal-ветку по аналогии с человеческой. | Task 4 |
| G6 (minor) | `_decide`, `reachedTarget`-ветка: `roll < (turnBlocked ? 0.85 : 0.85)` — тернарник всегда возвращает 0.85, мёртвый код | **Принято.** Заменить на `roll < 0.85`. | Task 4 |
| G7 (blocker) | Task 5, тест `reachableTarget(96, 64, 192)` ожидает `64`, но `Math.round(96/64) === Math.round(1.5) === 2` в JS (округление половинки вверх, проверено `node -e`) — тест реально падает | **Принято.** Исправить ожидание теста на `128`. | Task 5 |
| G8 (minor) | Self-Review → Риски п.4: текст описывает поведение (`_assignNewTarget` даёт цель `-64..128`), которого нет в коде — на границе при `dir=+1` цель остаётся `192` (клип), разворот идёт через `PED_TURN_LIMIT` в `_updateWalk` | **Принято.** Переписать текст риска под реальный код. | Task 5 (Self-Review) |
| G9 (minor) | `_avoidStatic`: `const obs = (x, z) => this._obstacleAt(x, z);` — замыкание аллоцируется каждый кадр на каждого пешехода, противоречит заявленному «zero-alloc hot-path» | **Принято.** Захостить `this._obstacleAtBound` один раз в конструкторе. | Task 2 |
| G10 (minor) | File Structure упоминает `_randPlace` как модифицируемое место, но ни один Task её не трогает — функция уже защищена через `_spotBlocked` | **Принято.** Убрать упоминание. | File Structure |

---

## File Structure

### Новые файлы

- `src/pedavoid.js` — чистые геометрические пробы для обхода препятствий: `probeForwardBlocked` (zero-alloc), `buildForwardProbes` (для тестов), `segmentBlocked`, `reachableTarget`. Без THREE/DOM, тестируется в node.
- `tests/pedavoid.test.mjs` — тесты на `pedavoid.js`, стиль `tests/pedgraph.test.mjs`.

### Модифицируемые файлы

- `src/peds.js` — правки в `_avoidStatic` (zero-alloc multi-probe, obstacle-callback захостен один раз в конструкторе), `_updateActive` (ранний return после `_avoidStatic` при деактивации активного пешехода), `_startTurn` (проверка дуги + анти-flip-flop), `_startEdge` (переякорение начала дуги поворота на текущую позицию пешехода), `_decide` (учёт `_blockedTurnIsec`, включая animal-ветку), `_assignNewTarget` (достижимая цель), `_updateCross` (проверка выхода), `_activate` (сдвиг из препятствия — порядок присваиваний важен). Добавить поле `_blockedTurnIsec` в спавн-объект пешехода и в `adoptPedestrian`. Импорт из `pedavoid.js`.
- `build.py` — добавить `pedavoid.js` в `MODULES` (после `pedgraph.js`, перед `peds.js` — `peds.js` зависит от `pedavoid.js`; в `MODULES` — только имя файла, без префикса `src/`, сборщик сам делает `SRC / m`).

---

## Task 1: Модуль pedavoid.js — probeForwardBlocked + buildForwardProbes

**Files:**
- Create: `src/pedavoid.js`
- Test: `tests/pedavoid.test.mjs`
- Modify: `build.py` (добавить `pedavoid.js` — без префикса `src/` — в `MODULES`)

`probeForwardBlocked` — zero-alloc хелпер для hot-path (`_avoidStatic` бежит каждый кадр на каждом активном пешеходе): не создаёт массивов/объектов, проверяет точки на лету через callback. `buildForwardProbes` — аллоцирующий хелпер для тестов геометрии, чтобы сравнивать массив точек через `deepEqual`.

- [ ] **Step 1: Создать `src/pedavoid.js`**

```js
// src/pedavoid.js
// Чистые геометрические пробы для обхода статических препятствий пешеходами.
// Без THREE/DOM — тестируется в node. Переиспользуется из peds.js.

// Константные расстояния для multi-probe в _avoidStatic. Не аллоцировать
// массив каждый кадр — _avoidStatic бежит на каждом активном пешеходе.
export const FORWARD_DISTANCES = [0.6, 1.4, 2.2];

/**
 * Zero-alloc проверка: есть ли препятствие в любой из probe-точек вперёд
 * по направлению движения. Точки строятся на лету, без массивов/объектов.
 * Для hot-path (_avoidStatic каждый кадр).
 *
 * @param {number} x0 — стартовая x
 * @param {number} z0 — стартовая z
 * @param {number} dirX — единичный вектор направления x (0 для оси z)
 * @param {number} dirZ — единичный вектор направления z (0 для оси x)
 * @param {number[]} distances — расстояния пробов (м), обычно FORWARD_DISTANCES
 * @param {(x: number, z: number) => boolean} obstacleFn — true если точка занята
 * @returns {boolean} true если хотя бы одна точка занята
 */
export function probeForwardBlocked(x0, z0, dirX, dirZ, distances, obstacleFn) {
  for (let i = 0; i < distances.length; i++) {
    const d = distances[i];
    if (obstacleFn(x0 + dirX * d, z0 + dirZ * d)) return true;
  }
  return false;
}

/**
 * Аллоцирующий хелпер: строит массив probe-точек вперёд. Для тестов геометрии
 * (deepEqual на массиве точек). В hot-path использовать probeForwardBlocked.
 *
 * @param {number} x0 — стартовая x
 * @param {number} z0 — стартовая z
 * @param {number} dirX — единичный вектор направления x
 * @param {number} dirZ — единичный вектор направления z
 * @param {number[]} distances — расстояния пробов (м)
 * @returns {Array<{x: number, z: number}>}
 */
export function buildForwardProbes(x0, z0, dirX, dirZ, distances) {
  const out = [];
  for (const d of distances) {
    out.push({ x: x0 + dirX * d, z: z0 + dirZ * d });
  }
  return out;
}
```

- [ ] **Step 2: Создать `tests/pedavoid.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeForwardBlocked, buildForwardProbes, FORWARD_DISTANCES } from '../src/pedavoid.js';

test('FORWARD_DISTANCES — три расстояния', () => {
  assert.deepEqual(FORWARD_DISTANCES, [0.6, 1.4, 2.2]);
});

test('probeForwardBlocked: true если хотя бы одна точка занята', () => {
  const obs = (x, z) => x === 1.4 && z === 0;
  assert.equal(probeForwardBlocked(0, 0, 1, 0, [0.6, 1.4, 2.2], obs), true);
});

test('probeForwardBlocked: false если все точки свободны', () => {
  const obs = (x, z) => x === 100 && z === 100;
  assert.equal(probeForwardBlocked(0, 0, 1, 0, [0.6, 1.4, 2.2], obs), false);
});

test('probeForwardBlocked: пустой массив — false', () => {
  assert.equal(probeForwardBlocked(0, 0, 1, 0, [], () => true), false);
});

test('probeForwardBlocked: диагональ', () => {
  const obs = (x, z) => x === 10 && z === 11;
  assert.equal(probeForwardBlocked(10, 10, 0, 1, [1.0], obs), true);
});

test('buildForwardProbes: точки по направлениям и расстояниям', () => {
  const probes = buildForwardProbes(0, 0, 1, 0, [0.6, 1.4, 2.2]);
  assert.deepEqual(probes, [
    { x: 0.6, z: 0 },
    { x: 1.4, z: 0 },
    { x: 2.2, z: 0 },
  ]);
});

test('buildForwardProbes: диагональ', () => {
  const probes = buildForwardProbes(10, 10, 0, 1, [1.0]);
  assert.deepEqual(probes, [{ x: 10, z: 11 }]);
});
```

- [ ] **Step 3: Добавить `pedavoid.js` в `MODULES` в `build.py`**

Открыть `build.py`, найти список `MODULES`. **Важно:** записи в `MODULES` — это просто
имена файлов без префикса `src/` (сборщик читает их как `(SRC / m).read_text(...)`, где
`SRC = ROOT / "src"` уже указывает на директорию `src` — префикс `src/` даст путь
`src/src/pedavoid.js` и `FileNotFoundError` при `python3 build.py`). Добавить
`'pedavoid.js'` после `'pedgraph.js'` и перед `'peds.js'` (порядок = порядок зависимостей,
`peds.js` импортирует из `pedavoid.js`).

- [ ] **Step 4: Прогнать тест**

Run: `node --test tests/pedavoid.test.mjs`
Expected: 7 pass, 0 fail.

- [ ] **Step 5: Коммит**

```bash
git add src/pedavoid.js tests/pedavoid.test.mjs build.py
git commit -m "feat(peds): добавить модуль pedavoid с probeForwardBlocked"
```

---

## Task 2: Multi-probe в _avoidStatic

**Files:**
- Modify: `src/peds.js:842-877` (`_avoidStatic`)

Сейчас `_avoidStatic` (peds.js:842-877) делает один probe на 2.2 м вперёд. Между пешеходом и probe — слепая зона ~1.4 м, где узкие препятствия (столбы AABB 0.8) не детектятся. Решение: три probe на `0.6, 1.4, 2.2` м через zero-alloc `probeForwardBlocked` (ревью 2.1: никаких аллокаций в hot-path).

**grill-plan G2/G9:** в этот же Task входят ещё два фикса, найденные при прожарке плана
(`verdict.md`) — оба в `_updateActive`/конструкторе, не в `_avoidStatic` напрямую, но
логически относятся к той же группе правок:
- **G9** — `probeForwardBlocked` принимает `obstacleFn`-коллбек; создавать его как
  `(x, z) => this._obstacleAt(x, z)` внутри `_avoidStatic` значит аллоцировать замыкание
  каждый кадр на каждого активного/near-zone пешехода — то, против чего борется сам этот
  Task (ревью 2.1). Коллбек нужно захостить один раз в конструкторе.
- **G2** — деактивация зависшего активного пешехода в `_avoidStatic`
  (`p.route = null; p.active = false;`, см. Step 2 ниже) не сбрасывает `p._edgeKind`.
  `_updateActive` (peds.js:919-971) после вызова `_avoidStatic` не имеет проверки на
  `p.active`/`p.route` и на той же итерации кадра может дойти до
  `_finishEdge → _startEdge → p.route.length` на `null` — `TypeError`, роняющий весь
  `update()` кадра. Баг существовал в коде и до этого плана (та же деактивация уже есть
  в текущем `_avoidStatic`), но multi-probe триггерит блокировку чаще — фикс обязателен.

- [ ] **Step 1: Импортировать из `pedavoid.js` в `peds.js`**

В начале `src/peds.js` (после строки `import { PedGraph } from './pedgraph.js';`):

```js
import { probeForwardBlocked, FORWARD_DISTANCES } from './pedavoid.js';
```

- [ ] **Step 1b: Захостить obstacle-callback в конструкторе (G9)**

В `src/peds.js`, конструктор `PedestrianManager` (строки 68-76), добавить после
`this._classifyTimer = 0;`:

```js
    this._classifyTimer = 0;
    this._obstacleAtBound = (x, z) => this._obstacleAt(x, z);
  }
```

`_obstacleAtBound` — один и тот же объект-функция на весь жизненный цикл менеджера,
переиспользуется в `_avoidStatic` (Step 2) вместо создания замыкания каждый кадр.

- [ ] **Step 2: Переписать `_avoidStatic` на multi-probe**

В `src/peds.js` заменить тело `_avoidStatic` (строки 842-877) на:

```js
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
```

- [ ] **Step 2b: Ранний return в `_updateActive` после деактивации (G2)**

В `src/peds.js`, `_updateActive` (строки 919-971), сразу после вызова
`this._avoidStatic(p, dt);` (перед `this._avoidPeds(p, dt);`) добавить проверку:

```js
    p.speed = p.baseSpeed;
    this._avoidStatic(p, dt);
    // Деактивация зависшего пешехода внутри _avoidStatic (p.active=false; p.route=null)
    // не сбрасывает p._edgeKind — без этого return код ниже может дойти до
    // _finishEdge -> _startEdge -> p.route.length на null и уронить update() кадра
    // (grill-plan G2).
    if (!p.active || !p.route) return;
    this._avoidPeds(p, dt);
```

- [ ] **Step 3: Пересобрать**

Run: `python3 build.py`
Expected: `index.html` пересобран без ошибок.

- [ ] **Step 4: Прогнать все тесты**

Run: `node --test tests/*.test.mjs`
Expected: все pass (14 в `pedgraph` + 7 в `pedavoid` = 21).

- [ ] **Step 5: Коммит**

```bash
git add src/peds.js build.py index.html
git commit -m "fix(peds): multi-probe в _avoidStatic, ранний return в _updateActive, обстакл-коллбек захостен"
```

---

## Task 3: segmentBlocked для проверки дуги поворота

**Files:**
- Modify: `src/pedavoid.js` (добавить `segmentBlocked`)
- Test: `tests/pedavoid.test.mjs`

Для проверки дуги поворота в `_startTurn` нужен сэмпл-проверщик отрезка: берём N точек вдоль отрезка и проверяем каждую через `obstacleFn`. **Радиус корпуса пешехода учитывается в `_obstacleAt` (через `_checkPropCollision(x, z, 0.4)`)** — `segmentBlocked` сэмплирует тонкую линию, но `_obstacleAt` вокруг каждой точки уже добавляет 0.4 м, так что столб на 0.2 м от линии отрезка будет пойман.

**Важная оговорка (grill-plan G3):** на практике `segmentBlocked` на дуге поворота почти
никогда не сработает. Угловые светофоры стоят в 5.94 м от линии поворота, знаки — в
5.37 м, фонари вообще не привязаны к перекрёсткам (проверено расчётом расстояния
точка-прямая по координатам `citygen.js`). Изначальный claim плана «поворот срезает угол
со светофорами/знаками» геометрически не подтверждается. `segmentBlocked` в `_startTurn`
всё равно стоит оставить — это дешёвая generic-защита от редкого случая (пропс прямо на
линии старта дуги), но не воспринимать её как решение симптома «пешеходы срезают углы» из
брифа. Если этот симптом реально воспроизводится в игре, вероятная причина — пешеход по
прямой линии поворота физически проходит через проезжую часть перекрёстка (диагональ
`x+z=const` пересекает дорогу в районе центра перекрёстка), а это отдельная, не покрытая
данным планом проблема (маршрутизация/геометрия дуги, не коллизия со статикой).

- [ ] **Step 1: Добавить `segmentBlocked` в `src/pedavoid.js`**

```js
/**
 * Проверяет, пересекает ли отрезок (x0,z0)-(x1,z1) препятствие.
 * Сэмплит N точек вдоль отрезка (включая концы) и проверяет каждую.
 * ВНИМАНИЕ: радиус корпуса пешехода НЕ закладён — obstacleFn должен сам
 * добавлять радиус (как _obstacleAt → _checkPropCollision(x, z, 0.4)).
 * @param {number} x0 — старт x
 * @param {number} z0 — старт z
 * @param {number} x1 — конец x
 * @param {number} z1 — конец z
 * @param {(x: number, z: number) => boolean} obstacleFn
 * @param {number} [steps=6] — число точек сэмплинга
 * @returns {boolean} true если хотя бы одна точка занята
 */
export function segmentBlocked(x0, z0, x1, z1, obstacleFn, steps = 6) {
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (obstacleFn(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return true;
  }
  return false;
}
```

- [ ] **Step 2: Добавить тесты в `tests/pedavoid.test.mjs`**

```js
import { segmentBlocked } from '../src/pedavoid.js';

test('segmentBlocked: false на чистом отрезке', () => {
  const obs = (x, z) => x === 100 && z === 100;
  assert.equal(segmentBlocked(0, 0, 10, 0, obs), false);
});

test('segmentBlocked: true если препятствие попадает в сэмпл', () => {
  const obs = (x, z) => x === 5 && z === 0;
  assert.equal(segmentBlocked(0, 0, 10, 0, obs, 10), true);
});

test('segmentBlocked: концы включены в проверку', () => {
  const obs = (x, z) => x === 0 && z === 0;
  assert.equal(segmentBlocked(0, 0, 10, 0, obs), true);
});

test('segmentBlocked: шаги по умолчанию = 6 (7 вызовов)', () => {
  let calls = 0;
  const obs = () => { calls++; return false; };
  segmentBlocked(0, 0, 10, 0, obs);
  assert.equal(calls, 7);  // 0..6 включительно
});
```

- [ ] **Step 3: Прогнать тест**

Run: `node --test tests/pedavoid.test.mjs`
Expected: 11 pass (7+4), 0 fail.

- [ ] **Step 4: Коммит**

```bash
git add src/pedavoid.js tests/pedavoid.test.mjs
git commit -m "feat(peds): segmentBlocked для проверки дуги поворота"
```

---

## Task 4: Проверка дуги поворота в _startTurn + анти-flip-flop

**Files:**
- Modify: `src/peds.js:169-179` (поле `_blockedTurnIsec` в спавн-объекте)
- Modify: `src/peds.js:1138-1150` (поле `_blockedTurnIsec` в `adoptPedestrian`)
- Modify: `src/peds.js:759-778` (`_startTurn`)
- Modify: `src/peds.js:659-686` (`_decide` — скипать поворот на заблокированном перекрёстке)

Сейчас `_startTurn` срезает угол перекрёстка прямой линией без проверки статики. На углах стоят светофоры (8.2), знаки (7.8), фонари (8.5) — пешеход проходит сквозь. Решение: если `segmentBlocked` на дуге поворота находит препятствие, отказаться от поворота, запомнить `p._blockedTurnIsec = isec`, продолжить прямо (ревью 2.2: без запоминания `turnT=1.2` истечёт → `_decide` на том же перекрёстке попробует снова → flip-flop каждые 1.2 с). В `_decide` скипать поворот на `_blockedTurnIsec`, обнулять при уходе от него.

Радиус корпуса уже учтён в `_obstacleAt` (через `_checkPropCollision(x, z, 0.4)`, ревью 2.4) — отдельная ширина дуги не нужна.

**Важная оговорка (grill-plan G3):** `_startTurn` вызывается только из `_decide` — это
путь ПАССИВНОЙ модели пешеходов (`p.active === false`). Активные пешеходы (в радиусе
~110-150 м от игрока — те, кого видно чаще всего) двигаются по маршруту `p.route` и
поворачивают через `_startEdge` (ветка `e.kind === 'turn'`), которая берёт координаты
дуги напрямую из графового ребра, минуя `_startTurn` и `segmentBlocked` целиком. Этот
Task их не защищает. Решение сознательно не пытается роду `segmentBlocked`-проверку в
`_startEdge`/маршрутизацию активных пешеходов — раз коллизия дуги со статикой
геометрически почти не встречается (см. оговорку в Task 3), там нужен только один
точечный фикс: переякорить начало анимации поворота на текущую позицию пешехода вместо
запечённых координат графа (Step 5 ниже) — это чинит реальный визуальный баг (телепорт
после нуджа/зебры), не мнимую коллизию.

- [ ] **Step 1: Импортировать `segmentBlocked` в `peds.js`**

Обновить строку импорта в начале `src/peds.js`:

```js
import { probeForwardBlocked, FORWARD_DISTANCES, segmentBlocked } from './pedavoid.js';
```

- [ ] **Step 2: Добавить поле `_blockedTurnIsec` в спавн-объект пешехода**

В `src/peds.js` `spawn` (строка 169-179), в объект `ped` добавить `_blockedTurnIsec: null` после `_reroute: 0`:

```js
      violator: Math.random() < CFG.pedViolatorChance,
      active: false, nearZone: false, laneOff: 0,
      route: null, routeIdx: 0, _edgeKind: null, edgeEnd: 0,
      idleT: 0, _blockedT: 0, _stuckT: 0, _reroute: 0,
      _blockedTurnIsec: null,
    };
```

- [ ] **Step 3: Добавить поле `_blockedTurnIsec` в `adoptPedestrian`**

В `src/peds.js` `adoptPedestrian` (~строка 1138-1150), в объект `ped` добавить `_blockedTurnIsec: null` после `_reroute: 0`:

```js
      route: null, routeIdx: 0, _edgeKind: null, edgeEnd: 0,
      idleT: 0, _blockedT: 0, _stuckT: 0, _reroute: 0,
      _blockedTurnIsec: null,
    };
```

- [ ] **Step 4: Переписать `_startTurn` с проверкой дуги**

В `src/peds.js` заменить тело `_startTurn` (строки 759-778) на:

```js
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
```

- [ ] **Step 5: В `_decide` скипать поворот на заблокированном перекрёстке**

В `src/peds.js` `_decide` (строки 659-686), в самом начале функции (после проверки `p.isAnimal`), добавить обнуление `_blockedTurnIsec` при уходе и скип поворота на нём:

```js
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
```

Примечание: в `reachedTarget`-ветке при `turnBlocked` `roll < 0.85` без `!turnBlocked`-проверки — переход дороги остаётся доступным (он через `_startCross`, не `_startTurn`), а поворот скипается. Вероятности чуть сдвигаются, но это приемлемо: пешеход на заблокированном перекрёстке либо переходит зебру, либо ждёт. Тернарник `turnBlocked ? 0.85 : 0.85` из черновика был мёртвым кодом (обе ветки давали одно и то же число) — заменён на `0.85` напрямую (grill-plan G6).

- [ ] **Step 5b: Переякорить начало дуги в `_startEdge` для активных пешеходов (G3)**

Активные пешеходы поворачивают через `_startEdge` (`e.kind === 'turn'`), не через
`_startTurn` — эта ветка строит `p.turn` из запечённых координат графового ребра
(`e.x0/e.z0`), не из текущей позиции пешехода. Если перед поворотом позицию сдвинул
`_nudgeOutOfObstacle` (Task 7) или сдвиг на выходе с зебры (Task 6), пешехода
телепортирует обратно в исходную точку в момент старта анимации поворота. Переякорить
начало дуги на текущую мировую позицию — конец дуги (`e.x1/e.z1`) не трогать, это цель
поворота из графа.

В `src/peds.js` заменить ветку `else if (e.kind === 'turn')` в `_startEdge` (строки
576-584) на:

```js
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
```

`_tempPedWpTurn` — тот же переиспользуемый temp-объект, что уже использует `_startTurn`
(строка 9); `_startEdge` и `_startTurn` никогда не вызываются в одном кадре друг за
другом синхронно, реентерабельность не страдает.

- [ ] **Step 6: Пересобрать**

Run: `python3 build.py`
Expected: `index.html` пересобран без ошибок.

- [ ] **Step 7: Прогнать тесты**

Run: `node --test tests/*.test.mjs`
Expected: все pass.

- [ ] **Step 8: Коммит**

```bash
git add src/peds.js build.py index.html
git commit -m "fix(peds): проверка дуги поворота в _startTurn, анти-flip-flop через _blockedTurnIsec, переякорение _startEdge"
```

---

## Task 5: Достижимая цель targetIsec

**Files:**
- Modify: `src/peds.js` (добавить именованную константу `PED_TURN_LIMIT`)
- Modify: `src/peds.js:274-279` (`_assignNewTarget`)
- Modify: `src/peds.js:638-644` (использовать `PED_TURN_LIMIT` вместо хардкода 232)
- Test: `tests/pedavoid.test.mjs` (добавить тест на `reachableTarget`)

Сейчас `targetIsec` зажат в `clamp(..., -256, 256)`, а пешеход разворачивается на `±232` (хардкод в `_updateWalk`). Цель 256 недостижима — пешеход топчется на краю. Решение: вынести `232` в именованную константу `PED_TURN_LIMIT`, `maxReachable` вычислять как `Math.floor(PED_TURN_LIMIT / CFG.CELL) * CFG.CELL` (= 192), а не хардкодить 192 (ревью 2.3).

- [ ] **Step 1: Добавить `reachableTarget` в `src/pedavoid.js`**

```js
/**
 * Возвращает ближайший допустимый перекрёсток к желаемой цели.
 * Перекрёстки в городе: k*step, где step=CFG.CELL (64). Достижимые:
 * от -maxReachable до +maxReachable (пешеход разворачивается на
 * PED_TURN_LIMIT, так что крайний перекрёсток — Math.floor(PED_TURN_LIMIT / step) * step).
 * @param {number} desired — желаемая координата перекрёстка
 * @param {number} step — шаг сетки (CFG.CELL)
 * @param {number} maxReachable — максимальный достижимый перекрёсток (±),
 *        вычислять как Math.floor(PED_TURN_LIMIT / step) * step, не хардкодить
 * @returns {number}
 */
export function reachableTarget(desired, step, maxReachable) {
  const maxK = Math.floor(maxReachable / step);
  const k = Math.round(desired / step);
  const clampedK = Math.max(-maxK, Math.min(maxK, k));
  return clampedK * step;
}
```

- [ ] **Step 2: Добавить тесты на `reachableTarget` в `tests/pedavoid.test.mjs`**

```js
import { reachableTarget } from '../src/pedavoid.js';

test('reachableTarget: цель в пределах сетки — без изменений', () => {
  assert.equal(reachableTarget(64, 64, 192), 64);
  assert.equal(reachableTarget(-128, 64, 192), -128);
});

test('reachableTarget: цель 256 обрезается до 192', () => {
  assert.equal(reachableTarget(256, 64, 192), 192);
  assert.equal(reachableTarget(-256, 64, 192), -192);
});

test('reachableTarget: цель 300 обрезается до 192', () => {
  assert.equal(reachableTarget(300, 64, 192), 192);
});

test('reachableTarget: промежуточная цель округляется к ближайшему перекрёстку', () => {
  // JS Math.round округляет половинку вверх (к +Infinity): Math.round(96/64) ===
  // Math.round(1.5) === 2, значит 96 округляется к 128, не к 64 (grill-plan G7,
  // проверено node -e "console.log(Math.round(96/64))").
  assert.equal(reachableTarget(96, 64, 192), 128);
  assert.equal(reachableTarget(97, 64, 192), 128);
});

test('reachableTarget: maxReachable вычисляется из PED_TURN_LIMIT и step', () => {
  // Math.floor(232 / 64) * 64 === 192
  assert.equal(Math.floor(232 / 64) * 64, 192);
});
```

- [ ] **Step 3: Прогнать тест**

Run: `node --test tests/pedavoid.test.mjs`
Expected: 16 pass (11+5), 0 fail.

- [ ] **Step 4: Импортировать `reachableTarget` в `peds.js`**

Обновить строку импорта:

```js
import { probeForwardBlocked, FORWARD_DISTANCES, segmentBlocked, reachableTarget } from './pedavoid.js';
```

- [ ] **Step 5: Добавить именованную константу `PED_TURN_LIMIT` в `peds.js`**

В начале `src/peds.js`, рядом с `const PED_SIDE = ...` (строка 13), добавить:

```js
const PED_SIDE = CFG.HALF + CFG.SIDE / 2; // 8 — центр тротуара от оси дороги
const PED_TURN_LIMIT = 232; // граница разворота пешехода в _updateWalk (раньше хардкод)
```

- [ ] **Step 6: Использовать `PED_TURN_LIMIT` в `_updateWalk`**

В `src/peds.js` `_updateWalk` (строки 638-644), заменить `232` на `PED_TURN_LIMIT`:

```js
    if (Math.abs(p.pos) > PED_TURN_LIMIT) {
      p.dir = -p.dir;
      p.pos = clamp(p.pos, -PED_TURN_LIMIT, PED_TURN_LIMIT);
      p.turnT = 0.5;
      this._assignNewTarget(p);
      return;
    }
```

- [ ] **Step 7: Переписать `_assignNewTarget`**

В `src/peds.js` заменить `_assignNewTarget` (строки 274-279) на:

```js
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
```

- [ ] **Step 8: Пересобрать и прогнать тесты**

Run: `python3 build.py && node --test tests/*.test.mjs`
Expected: `index.html` пересобран, все тесты pass.

- [ ] **Step 9: Коммит**

```bash
git add src/pedavoid.js src/peds.js tests/pedavoid.test.mjs build.py index.html
git commit -m "fix(peds): targetIsec ограничить достижимым диапазоном через PED_TURN_LIMIT"
```

---

## Task 6: Проверка выхода с зебры в _updateCross

**Files:**
- Modify: `src/peds.js:736-756` (`_updateCross`)

После перехода пешеход оказывается на `(coord + to, pos)` на другой стороне. Если там лавочка/столб — он внутри препятствия и `_avoidStatic` его не выгонит (нет probe под собой). Решение: при завершении перехода проверить точку, и если занято — сдвинуть `p.pos` вдоль тротуара на 1-2 м в направлении движения.

- [ ] **Step 1: Переписать завершение `_updateCross`**

В `src/peds.js` заменить финал `_updateCross` (строки 750-756) на:

```js
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
```

- [ ] **Step 2: Пересобрать и прогнать тесты**

Run: `python3 build.py && node --test tests/*.test.mjs`
Expected: `index.html` пересобран, все тесты pass.

- [ ] **Step 3: Коммит**

```bash
git add src/peds.js build.py index.html
git commit -m "fix(peds): сдвиг с занятой точки после перехода зебры"
```

---

## Task 7: Сдвиг из препятствия при активации

**Files:**
- Modify: `src/peds.js:417-442` (`_activate`)

Дальний пешеход (без `_avoidStatic`) мог зайти в AABB. При `_activate` маршрут стартует, но пешеход внутри статики — 1.5 с стоит там. Решение: в начале `_activate` проверить текущую позицию и если занято — попытаться сдвинуть вдоль/поперёк ленты.

- [ ] **Step 1: Добавить метод `_nudgeOutOfObstacle` в `PedestrianManager`**

В `src/peds.js` перед `_activate` (после `_restMode`, ~строка 450) добавить:

```js
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
```

- [ ] **Step 2: Вызвать `_nudgeOutOfObstacle` в начале `_activate`**

В `src/peds.js` `_activate` (строки 417-442) вставить вызов `_nudgeOutOfObstacle` **ПОСЛЕ**
`p.route = null; p.routeIdx = 0; p.laneOff = 0;`, не до неё (grill-plan G4: в обратном
порядке `_nudgeOutOfObstacle` выставляет `p.laneOff = across`, чтобы вытащить пешехода
вбок, а следующая же строка тут же затирает это в `0` — для самого частого случая
(чистый боковой уход без смещения вдоль тротуара, `along=0`) Task 7 был бы тихо
неработающим):

```js
  _activate(p) {
    if (!this.graph || p.isAnimal) return;
    if (p.knockT > 0 || p.mode === 'flee' || p.mode === 'kick') return;
    p.route = null; p.routeIdx = 0; p.laneOff = 0;
    this._nudgeOutOfObstacle(p);  // сдвинуться из препятствия если стоит внутри — ПОСЛЕ
                                   // сброса laneOff, иначе боковой сдвиг затирается (G4)
    // ... (всё что ниже без изменений)
  }
```

- [ ] **Step 3: Пересобрать и прогнать тесты**

Run: `python3 build.py && node --test tests/*.test.mjs`
Expected: `index.html` пересобран, все тесты pass.

- [ ] **Step 4: Коммит**

```bash
git add src/peds.js build.py index.html
git commit -m "fix(peds): сдвиг из препятствия при активации пешехода"
```

---

## Task 8: Финальная пересборка и ручная проверка

**Files:**
- Modify: `index.html` (финальная пересборка)

- [ ] **Step 1: Финальная пересборка**

Run: `python3 build.py`
Expected: `index.html` пересобран без ошибок.

- [ ] **Step 2: Прогнать все тесты**

Run: `node --test tests/*.test.mjs`
Expected: все pass (14 в `pedgraph` + 16 в `pedavoid` = 30).

- [ ] **Step 3: Открыть игру в браузере и проверить вручную**

Открыть `index.html` в браузере. Проверить:
1. Пешеходы больше не проходят сквозь столбы фонарей (особенно на лентах с offset 8.5).
2. Пешеходы (пассивные, не в маршруте) не срезают углы перекрёстков со светофорами/знаками
   там, где пропс реально оказался на линии старта дуги. Если пешеходы визуально «срезают
   угол» иначе (по диагонали через проезжую часть) — это известное ограничение (grill-plan
   G3), не баг этого прогона, фиксировать отдельным issue, не пытаться чинить в рамках
   этого плана.
3. Пешеходы не топчутся на краю карты (±232).
4. После перехода зебры пешеходы не застревают внутри лавочек на другой стороне и не
   телепортируются в исходную точку, если следующий шаг маршрута — поворот.
5. Пешеходы в дальней зоне (110-150 м) при подходе к игроку не стоят 1.5 с внутри статики.
6. Нет flip-flop у перекрёстков: пешеход (включая животных), отказавшийся от поворота
   из-за столба, идёт прямо, не дёргается на месте.

- [ ] **Step 4: Коммит финальной пересборки (если были правки после Step 3)**

```bash
git add index.html
git commit -m "build: пересобрать index.html (фиксы пешеходов)"
```

---

## Self-Review

### Спец-покрытие

| Проблема из брифа | Задача |
|---|---|
| Проходят сквозь столбы | Task 2 (multi-probe 0.6+1.4+2.2) |
| Проходят сквозь лавочки | Task 2 (лавочка 2.6 м AABB ловится probe 1.4+2.2) |
| Проходят сквозь кусты | Task 2 (куст 2.0 м AABB ловится) |
| Тупят с краю дороги | Task 5 (`reachableTarget` + `PED_TURN_LIMIT`) |
| Срезают углы со светофорами/знаками | **Частично, не так как задумывалось изначально** (grill-plan G3): `segmentBlocked` в Task 4 покрывает только пассивных пешеходов и на практике почти не срабатывает — светофоры/знаки геометрически стоят слишком далеко от линии поворота (5.4-5.9 м). Реально фиксится только визуальный телепорт на повороте (Task 4, `_startEdge` re-anchor). Если симптом «срез угла» воспроизводится в игре — вероятная причина (проход по проезжей части на диагонали) вне scope этого плана, см. Task 3. |
| Застревают после зебры | Task 6 (сдвиг с занятой точки) + Task 4 (`_startEdge` re-anchor не даёт откату к старой точке, если следующим ребром идёт поворот) |
| Стоят внутри статики при активации | Task 7 (`_nudgeOutOfObstacle`) |

### Учтённые замечания ревью

| # | Замечание | Учтено в |
|---|---|---|
| 2.1 | GC-нагрузка от аллокаций в `_avoidStatic` | Task 1 (`probeForwardBlocked` zero-alloc + `FORWARD_DISTANCES`), Task 2 (использование) |
| 2.2 | Flip-flop при отказе от поворота | Task 4 (`_blockedTurnIsec` в спавн-объекте + `_decide` скипает поворот) |
| 2.3 | Магическое `192` | Task 5 (`PED_TURN_LIMIT` константа, `maxReachable = Math.floor(PED_TURN_LIMIT / CFG.CELL) * CFG.CELL`) |
| 2.4 | Ширина дуги `segmentBlocked` | Task 3 (примечание в JSDoc: радиус учтён в `_obstacleAt`), Task 4 (комментарий) |

### Placeholder scan

Нет TBD/TODO. Все шаги содержат конкретный код и команды.

### Type consistency

- `_obstacleAt(x, z)` — сигнатура одна во всех вызовах.
- `_lanePoint(p, off, out)` — сигнатура одна.
- `_worldPos(p, out)` — сигнатура одна.
- `probeForwardBlocked(x0, z0, dirX, dirZ, distances, obstacleFn)` — одна.
- `buildForwardProbes(x0, z0, dirX, dirZ, distances)` — одна (для тестов).
- `segmentBlocked(x0, z0, x1, z1, obstacleFn, steps)` — одна.
- `reachableTarget(desired, step, maxReachable)` — одна (без default, всегда передаём явно).
- `FORWARD_DISTANCES` — константный массив `[0.6, 1.4, 2.2]`.
- `PED_TURN_LIMIT` — константа `232`.
- `_blockedTurnIsec` — поле в спавн-объекте и в `adoptPedestrian`, `null` или число.

### Риски

1. **Производительность**: `segmentBlocked` с 8 шагами в `_startTurn` — это 8 вызовов `_obstacleAt`. Повороты происходят на перекрёстках, не каждый кадр — раз в несколько секунд на пешехода. При 34 пешеходах и ~5 активных перекрёстков в секунду — 40 вызовов/с. `propsAABB` в spatial hash (10 м ячейка), здания в spatial hash (16 м ячейка), `circleColliders` — ~5 шт. Не страшно. Multi-probe в `_avoidStatic`: 3 вызова вместо 1 — на ~10-15 активных +30-45 вызовов/кадр, spatial hash O(1). Не страшно.

2. **`_startTurn` отказ от поворота**: если дуга всегда занята (угол с тремя столбами), пешеход никогда не повернёт и пойдёт прямо. Это лучше, чем проходить сквозь — он дойдёт до следующего перекрёстка и попробует там. Если упрётся в тупик — `_avoidStatic` развернёт. Анти-flip-flop (`_blockedTurnIsec`) не даёт ему дёргаться на этом же перекрёстке.

3. **`_nudgeOutOfObstacle` не нашёл свободной точки**: пешеход остаётся внутри, но `_avoidStatic` через `_stuckT` за 1.5 с перерасчитает маршрут/развернёт. Хуже чем сдвинуть, лучше чем вечный фриз.

4. **`targetIsec = 192` на границе** (текст исправлен по grill-plan G8 — исходная
   формулировка описывала поведение, которого нет в коде): пешеход доходит до ~192 при
   `dir=+1`, `_decide` срабатывает на перекрёстке 192, `_assignNewTarget` считает
   `targetIsec = round((192 + 1*rand(96,224))/64)*64` — это диапазон `round(288..416 /
   64)*64` = `320..448`, всё за пределами `maxReachable=192`, значит `reachableTarget`
   обрезает результат до `192` — той же точки, где пешеход уже стоит. Цель в направлении
   `+dir` не «уезжает» дальше — пешеход продолжает идти в `dir=+1`, пока не упрётся в
   саму границу `PED_TURN_LIMIT` (232) в `_updateWalk`; разворот делает именно она, не
   `reachableTarget`. Норм: `reachableTarget` не даёт цели убежать за пределы карты, а
   физический разворот на краю по-прежнему обеспечивает существующая проверка в
   `_updateWalk`.
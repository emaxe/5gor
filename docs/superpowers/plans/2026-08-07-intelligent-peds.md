# Интеллектуальные пешеходы — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пешеходы осмысленно ходят «откуда→куда» по графу тротуаров, соблюдают ПДД (с нарушениями у ~20%) и обходят статику/пешеходов/машины. Полный ИИ — только в активной зоне (≤110 м от игрока), ближняя зона (110–150 м) — простое движение + обход статики, дальняя — текущее поведение.

**Architecture:** Новый чистый модуль `src/pedgraph.js` (без THREE/DOM, тестируется в node) строит граф ходьбы из `world.intersections`: 5 узлов на перекрёсток + серединные узлы тротуаров; рёбра walk/cross/turn/jwalk. Dijkstra с фильтром `jwalk` (только для `violator`). `src/peds.js` получает зонную классификацию и следует маршруту поверх текущей модели `axis/coord/pos` (переиспользуются `_startCross`/`_updateCross`/`_updateWait`).

**Tech Stack:** Vanilla JS ES-модули, Three.js (только в peds.js), сборка `python3 build.py`, тесты `node --test`.

**Спека:** `docs/superpowers/specs/2026-08-07-intelligent-peds-design.md`

**Ревизия плана (2026-08-07):** план сверен с кодом (`src/peds.js`,
`src/citygen.js`, `src/traffic.js`, `src/game.js`, `build.py`) и содержал
несколько блокирующих дефектов (телепорт пешехода при активации, пропуск
ребра маршрута после каждой зебры, необратимая заморозка скорости, до 13
полных проходов Dijkstra на одну активацию, недоступность `node --test` из-за
отсутствия `package.json`) и дизайновых пробелов (POI выбираются почти
случайно среди ~300 точек подачи, идентификатор точки прибытия зацикливает
пешехода в вечном `idle`, животные не должны участвовать в полном ИИ, переход
идёт через центр перекрёстка мимо разметки). Все правки внесены ниже по
задачам; выполняй план в текущей редакции, не в исходной.

---

### Task 0: Корневой `package.json` — чтобы работал `node --test`

**Files:**
- Create: `package.json`

`tests/pedgraph.test.mjs` — ES-модуль (`import`), который сам импортирует
`../src/pedgraph.js` → `./config.js`. Без `package.json` с `"type": "module"`
Node трактует `.js`/`.mjs` в проекте по CommonJS-правилам для `.js`, и хотя
`.mjs` всегда ESM независимо от `package.json`, разрешение `import` внутри
`src/*.js` (у них нет расширения `.mjs`) в отсутствие `"type": "module"`
трактуется как CommonJS и падает на `import { CFG } from './config.js'`.
`build.py`/`run.sh` npm не используют — на сборку файл не влияет.

- [ ] **Step 1: Создать `package.json`**

```json
{
  "name": "5gor",
  "private": true,
  "type": "module"
}
```

- [ ] **Step 2: Проверить, что базовый `node --test` не падает на импортах**

Run: `node --test --test-name-pattern nonexistent tests/` (без файлов ещё
ничего не найдёт, но не должно быть `SyntaxError: Cannot use import statement
outside a module` — пока и `tests/` пуст, эта проверка станет содержательной
после Task 2).

- [ ] **Step 3: Коммит**

```bash
git add package.json
git commit -m "chore: package.json для ESM-тестов node --test"
```

---

### Task 1: Константы зон и регистрация модуля в сборке

**Files:**
- Modify: `src/config.js`
- Modify: `build.py`

- [ ] **Step 1: Добавить константы в `src/config.js`**

Добавь в конец секции «Трафик и мир» (после `orderSpawnEverySec`):

```js
  // Пешеходы: зоны ИИ и нарушения ПДД
  pedActiveRadius: 110,      // ≤110 м — полный ИИ (маршрут, ПДД, обход)
  pedNearRadius: 150,        // 110–150 м — простое движение + обход статики
  pedViolatorChance: 0.2,    // ~20% нарушают ПДД (переход на красный/jwalk)
  pedIdleTime: [5, 15],      // пауза пешехода после прибытия, сек
```

- [ ] **Step 2: Зарегистрировать `pedgraph.js` в `src/../build.py`**

В `build.py` в списке `MODULES` добавь `"pedgraph.js"` сразу после `"citygen.js"`:

```python
    "citygen.js",
    "pedgraph.js",
    "player.js",
```

Порядок важен: сборка склеивает файлы по порядку, `import` удаляются — `pedgraph.js`
должен идти до `peds.js` (там его `import { PedGraph }`).

- [ ] **Step 3: Проверить сборку**

Run: `python3 build.py`
Expected: `OK: index.html (... KB)` без ошибок.

- [ ] **Step 4: Коммит**

```bash
git add src/config.js build.py
git commit -m "feat: константы зон пешеходов и регистрация pedgraph в сборке"
```

---

### Task 2: `src/pedgraph.js` — построение графа (TDD)

**Files:**
- Create: `src/pedgraph.js`
- Test: `tests/pedgraph.test.mjs`

- [ ] **Step 1: Написать тесты построения графа**

Create `tests/pedgraph.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PedGraph } from '../src/pedgraph.js';

function makeIntersections() {
  const arr = [];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) arr.push({ x: -256 + i * 64, z: -256 + j * 64 });
  return arr;
}

test('graph builds nodes: 81 intersections x5 + 288 midpoints', () => {
  const g = new PedGraph();
  g.build(makeIntersections());
  assert.equal(g.nodes.length, 81 * 5 + 288);
});

test('every center node has exactly 4 cross edges', () => {
  const g = new PedGraph();
  g.build(makeIntersections());
  for (const n of g.nodes) {
    if (n.kind !== 'center') continue;
    const crosses = g.adj[n.id].filter(e => e.kind === 'cross');
    assert.equal(crosses.length, 4);
  }
});

test('graph is connected', () => {
  const g = new PedGraph();
  g.build(makeIntersections());
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    const u = stack.pop();
    for (const e of g.adj[u]) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
  }
  assert.equal(seen.size, g.nodes.length);
});

test('jwalk edges exist and are deterministic', () => {
  const count = (g) => {
    let c = 0;
    for (let u = 0; u < g.nodes.length; u++) c += g.adj[u].filter(e => e.kind === 'jwalk').length;
    return c / 2;
  };
  const a = new PedGraph(); a.build(makeIntersections());
  const b = new PedGraph(); b.build(makeIntersections());
  assert.ok(count(a) > 0 && count(a) < 288);
  assert.equal(count(a), count(b));
});

test('lane nodes carry axis/road/side', () => {
  const g = new PedGraph();
  g.build(makeIntersections());
  const n = g.nearestNode(-200, -256);
  const node = g.nodes[n];
  assert.equal(node.kind, 'lane');
  assert.equal(node.axis, 'z');
  assert.equal(node.road, -192);
  assert.equal(node.side, -1);
});

test('nodeOnLane находит узел строго на своей ленте, а не геометрически ближайший', () => {
  const g = new PedGraph();
  g.build(makeIntersections());
  // пешеход на ленте x=-192-8, где-то между перекрёстками (z=-220), а не в -256
  const id = g.nodeOnLane('z', -192, -1, -220);
  assert.ok(id != null);
  const node = g.nodes[id];
  assert.equal(node.axis, 'z');
  assert.equal(node.road, -192);
  assert.equal(node.side, -1);
  // ближайший ГЕОМЕТРИЧЕСКИ узел к (-200,-220) может лежать на другой оси —
  // nodeOnLane обязан игнорировать его и остаться на заданной ленте
  assert.ok(['lane', 'mid'].includes(node.kind));
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `node --test tests/pedgraph.test.mjs`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module ... src/pedgraph.js`

- [ ] **Step 3: Реализовать `src/pedgraph.js`**

Create `src/pedgraph.js`:

```js
import { CFG } from './config.js';

const PED_SIDE = CFG.HALF + CFG.SIDE / 2; // 8 — центр тротуара от оси дороги
const EDGE = CFG.CELL;
const POI_MAX_DIST = 40; // POI дальше этого от ближайшего узла — вне сетки (напр. Машук), отбрасываем

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Координата узла вдоль его собственной оси ходьбы (для lane/mid узлов). */
function posOf(node) {
  return node.axis === 'z' ? node.z : node.x;
}

/**
 * Статический граф ходьбы города.
 * Узлы: 4 «тротуарных» (+ серединные) на лентах дорог и 1 центр перехода на
 * перекрёстке. Рёбра: walk (тротуар), cross (зебра через дорогу, пара через
 * центр), turn (срез угла на перекрёстке), jwalk (середина квартала, только
 * для нарушителей). Без зависимостей (no THREE/DOM) — тестируется в node.
 *
 * Единицы стоимости — не рёбра: walk-сегмент 0.5, поворот 1.5, cross-ребро 1
 * (переход через дорогу = 2 таких ребра подряд через центр), jwalk 3. Когда в
 * коде/тестах говорится «дистанция N рёбер» — это длина итогового `path` из
 * `pathTo()`/`route()` минус 1, а не значение `dist[]` (см. `_pickRandomNode`
 * в `peds.js`, где `dist[]` используется лишь как дешёвая аппроксимация).
 */
export class PedGraph {
  constructor() {
    this.nodes = [];            // { id, x, z, kind, axis?, road?, side?, edges: [] }
    this.adj = [];              // adj[id] = [{ to, cost, kind }]
    this._byKey = new Map();    // "x,z" -> node
    this._intersections = [];
    this.poiList = [];          // [{ node: nodeId, tag: string|null }]
    this.poiNodes = [];         // [nodeId]
  }

  _addNode(x, z, kind, extra) {
    const key = Math.round(x) + ',' + Math.round(z);
    let n = this._byKey.get(key);
    if (n) return n;
    const id = this.nodes.length;
    n = Object.assign({ id, x, z, kind, edges: [] }, extra);
    this._byKey.set(key, n);
    this.nodes.push(n);
    this.adj.push([]);
    return n;
  }

  _addEdge(a, b, kind, cost) {
    a.edges.push(b.id);
    b.edges.push(a.id);
    this.adj[a.id].push({ to: b.id, cost, kind });
    this.adj[b.id].push({ to: a.id, cost, kind });
  }

  build(intersections) {
    this._intersections = intersections;
    const rng = mulberry32(20260807);
    const roadsX = [...new Set(intersections.map(i => i.x))].sort((a, b) => a - b); // вертикальные дороги
    const roadsZ = [...new Set(intersections.map(i => i.z))].sort((a, b) => a - b); // горизонтальные

    // --- тротуарные ленты + серединные узлы (walk) ---
    for (const r of roadsX) {
      for (let i = 0; i + 1 < roadsZ.length; i++) {
        const za = roadsZ[i], zb = roadsZ[i + 1], zm = (za + zb) / 2;
        for (const side of [-1, 1]) {
          const x = r + side * PED_SIDE;
          const na = this._addNode(x, za, 'lane', { axis: 'z', road: r, side });
          const nm = this._addNode(x, zm, 'mid', { axis: 'z', road: r, side });
          const nb = this._addNode(x, zb, 'lane', { axis: 'z', road: r, side });
          this._addEdge(na, nm, 'walk', 0.5);
          this._addEdge(nm, nb, 'walk', 0.5);
        }
      }
    }
    for (const r of roadsZ) {
      for (let i = 0; i + 1 < roadsX.length; i++) {
        const xa = roadsX[i], xb = roadsX[i + 1], xm = (xa + xb) / 2;
        for (const side of [-1, 1]) {
          const z = r + side * PED_SIDE;
          const na = this._addNode(xa, z, 'lane', { axis: 'x', road: r, side });
          const nm = this._addNode(xm, z, 'mid', { axis: 'x', road: r, side });
          const nb = this._addNode(xb, z, 'lane', { axis: 'x', road: r, side });
          this._addEdge(na, nm, 'walk', 0.5);
          this._addEdge(nm, nb, 'walk', 0.5);
        }
      }
    }

    // --- перекрёстки: центр + зебры (cross) + повороты (turn) ---
    for (const isec of intersections) {
      const center = this._addNode(isec.x, isec.z, 'center');
      const nW = this._byKey.get((isec.x - PED_SIDE) + ',' + isec.z);
      const nE = this._byKey.get((isec.x + PED_SIDE) + ',' + isec.z);
      const nN = this._byKey.get(isec.x + ',' + (isec.z - PED_SIDE));
      const nS = this._byKey.get(isec.x + ',' + (isec.z + PED_SIDE));
      if (nW && nE) { this._addEdge(nW, center, 'cross', 1); this._addEdge(center, nE, 'cross', 1); }
      if (nN && nS) { this._addEdge(nN, center, 'cross', 1); this._addEdge(center, nS, 'cross', 1); }
      for (const [a, b] of [[nW, nN], [nW, nS], [nE, nN], [nE, nS]]) {
        if (a && b) this._addEdge(a, b, 'turn', 1.5);
      }
    }

    // --- jwalk через середины кварталов (~30% блоков, детерминированный сид) ---
    for (const r of roadsX) {
      for (let i = 0; i + 1 < roadsZ.length; i++) {
        if (rng() >= 0.3) continue;
        const zm = (roadsZ[i] + roadsZ[i + 1]) / 2;
        const a = this._byKey.get((r - PED_SIDE) + ',' + zm);
        const b = this._byKey.get((r + PED_SIDE) + ',' + zm);
        if (a && b) this._addEdge(a, b, 'jwalk', 3);
      }
    }
    for (const r of roadsZ) {
      for (let i = 0; i + 1 < roadsX.length; i++) {
        if (rng() >= 0.3) continue;
        const xm = (roadsX[i] + roadsX[i + 1]) / 2;
        const a = this._byKey.get(xm + ',' + (r - PED_SIDE));
        const b = this._byKey.get(xm + ',' + (r + PED_SIDE));
        if (a && b) this._addEdge(a, b, 'jwalk', 3);
      }
    }
  }

  /** Ближайший узел указанных видов. kinds: ['lane','mid','center'] */
  nearestNode(x, z, kinds = ['lane', 'mid']) {
    let best = null, bd = Infinity;
    for (const n of this.nodes) {
      if (!kinds.includes(n.kind)) continue;
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best ? best.id : null;
  }

  /**
   * Ближайший узел (lane/mid) СТРОГО на заданной ленте (axis, road-координата,
   * сторона). В отличие от nearestNode — не притянет к геометрически близкому
   * узлу на другой (например перпендикулярной) дороге. Используется при
   * активации пешехода: узел входа должен лежать на его текущей ленте, иначе
   * пешеход телепортируется при первом же шаге маршрута.
   */
  nodeOnLane(axis, coord, side, pos) {
    let best = null, bd = Infinity;
    for (const n of this.nodes) {
      if ((n.kind !== 'lane' && n.kind !== 'mid')) continue;
      if (n.axis !== axis || n.road !== coord || n.side !== side) continue;
      const d = Math.abs(posOf(n) - pos);
      if (d < bd) { bd = d; best = n; }
    }
    return best ? best.id : null;
  }

  /**
   * Маппинг POI-точек на ближайшие тротуарные узлы. list: [{x, z, tag?}].
   * Точки дальше POI_MAX_DIST от найденного узла отбрасываются — иначе
   * ориентиры вне сетки (Машук: канатка/беседка/башня, z < -256) намертво
   * притягиваются к южному краю города и искажают выбор цели.
   */
  setPOIs(list) {
    this.poiList = list
      .map(p => ({ node: this.nearestNode(p.x, p.z), tag: p.tag || null, x: p.x, z: p.z }))
      .filter(p => p.node != null)
      .filter(p => {
        const n = this.nodes[p.node];
        return Math.hypot(n.x - p.x, n.z - p.z) <= POI_MAX_DIST;
      });
    this.poiNodes = this.poiList.map(p => p.node);
  }

  /**
   * Один полный проход Dijkstra от fromId. allowJwalk=false запрещает
   * jwalk-рёбра. Возвращает { dist, prev } для последующего построения ЛЮБОГО
   * числа путей без повторного прохода — критично для выбора случайной цели
   * (см. `_pickRandomNode` в peds.js): полный проход по 693 узлам без кучи
   * стоит ~1-3 мс, повторять его на каждого кандидата цели нельзя.
   */
  routesFrom(fromId, allowJwalk) {
    const n = this.nodes.length;
    const dist = new Array(n).fill(Infinity);
    const prev = new Array(n).fill(-1);
    const done = new Array(n).fill(false);
    dist[fromId] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      }
      if (u === -1) break;
      done[u] = true;
      for (const e of this.adj[u]) {
        if (e.kind === 'jwalk' && !allowJwalk) continue;
        const nd = dist[u] + e.cost;
        if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; }
      }
    }
    return { dist, prev };
  }

  /** Восстановление пути к toId из {prev}, полученного в routesFrom(). Без пересчёта. */
  pathTo(prev, fromId, toId) {
    if (fromId !== toId && prev[toId] === -1) return null;
    const path = [];
    for (let c = toId; c !== -1; c = prev[c]) path.push(c);
    path.reverse();
    if (path[0] !== fromId) return null;
    return path;
  }

  /** Dijkstra "в один вызов" — для единичных запросов и тестов. Для выбора
   *  цели среди множества кандидатов используй routesFrom()+pathTo() напрямую,
   *  не зови route() в цикле (см. комментарий у routesFrom). */
  route(fromId, toId, allowJwalk) {
    const { prev } = this.routesFrom(fromId, allowJwalk);
    return this.pathTo(prev, fromId, toId);
  }

  /**
   * Дескриптор ребра для движения пешехода (from=id a, to=id b).
   * Возвращает { kind, ... } или null.
   */
  edgeInfo(aId, bId) {
    const a = this.nodes[aId], b = this.nodes[bId];
    let kind = null;
    for (const e of this.adj[aId]) if (e.to === bId) kind = e.kind;
    if (!kind) return null;
    const d = { kind };
    if (kind === 'walk') {
      d.axis = a.axis; d.coord = a.road; d.side = a.side;
      d.posStart = posOf(a); d.posEnd = posOf(b);
    } else if (kind === 'cross' || kind === 'jwalk') {
      // один из концов — центр перекрёстка (без axis/road/side) для 'cross',
      // либо оба конца — тротуарные узлы для 'jwalk'; берём тротуарный узел
      // (не center) как источник ориентации — sideOf по координатам центра
      // давал мусор (у center нет .road), тогда как у lane/mid узлов side уже
      // готов при построении графа.
      const lane = a.kind === 'center' ? b : a;
      d.axis = lane.axis; d.coord = lane.road; d.side = lane.side;
      d.pos = posOf(lane);
    } else if (kind === 'turn') {
      d.x0 = a.x; d.z0 = a.z; d.x1 = b.x; d.z1 = b.z;
      d.newAxis = b.axis; d.newCoord = b.road; d.newSide = b.side; d.newPos = posOf(b);
    }
    return d;
  }
}
```

- [ ] **Step 4: Запустить тесты — должны пройти**

Run: `node --test tests/pedgraph.test.mjs`
Expected: 6 tests PASS.

- [ ] **Step 5: Проверить сборку и закоммитить**

Run: `python3 build.py` → `OK: index.html`
```bash
git add src/pedgraph.js tests/pedgraph.test.mjs
git commit -m "feat: граф ходьбы пешеходов (узлы, рёбра walk/cross/turn/jwalk) с тестами"
```

---

### Task 3: `src/pedgraph.js` — маршрутизация, POI, детерминизм (TDD)

**Files:**
- Modify: `src/pedgraph.js` (уже реализовано в Task 2)
- Test: `tests/pedgraph.test.mjs`

- [ ] **Step 1: Добавить тесты маршрутизации**

Добавь в конец `tests/pedgraph.test.mjs`:

```js
test('dijkstra вдоль одной дороги использует только walk-рёбра', () => {
  const g = new PedGraph();
  g.build(makeIntersections());
  const fromId = g.nearestNode(-192 - 8, -256);
  const toId = g.nearestNode(-192 - 8, -128);
  const path = g.route(fromId, toId, false);
  assert.ok(path && path.length >= 1);
  for (let i = 0; i + 1 < path.length; i++) {
    assert.equal(g.edgeInfo(path[i], path[i + 1]).kind, 'walk');
  }
});

test('jwalk-ребро недоступно без violator и доступно с ним', () => {
  const g = new PedGraph();
  g.build(makeIntersections());
  let jw = null;
  for (let u = 0; u < g.nodes.length && !jw; u++) {
    for (const e of g.adj[u]) if (e.kind === 'jwalk') { jw = { a: u, b: e.to }; break; }
  }
  assert.ok(jw);
  const p1 = g.route(jw.a, jw.b, false);
  assert.ok(p1 && !(p1.length === 2 && g.edgeInfo(p1[0], p1[1]).kind === 'jwalk'));
  const p2 = g.route(jw.a, jw.b, true);
  assert.equal(p2.length, 2);
  assert.equal(g.edgeInfo(p2[0], p2[1]).kind, 'jwalk');
});

test('переход через дорогу на зебре — пара cross-рёбер через центр', () => {
  const g = new PedGraph();
  g.build(makeIntersections());
  // перекрёсток (-192, -192), вертикальная дорога x=-192
  const fromId = g.nearestNode(-192 - 8, -192);
  const toId = g.nearestNode(-192 + 8, -192);
  const path = g.route(fromId, toId, false);
  assert.ok(path && path.length === 3);
  assert.equal(path[1], g.nearestNode(-192, -192, ['center']));
  assert.equal(g.edgeInfo(path[0], path[1]).kind, 'cross');
  assert.equal(g.edgeInfo(path[1], path[2]).kind, 'cross');
});

test('nearestNode выбирает ближайший тротуарный узел', () => {
  const g = new PedGraph();
  g.build(makeIntersections());
  const id = g.nearestNode(-200, -200);
  const n = g.nodes[id];
  assert.ok(Math.abs(n.x + 192) <= 8.5 && Math.abs(n.z + 192) <= 8.5);
});

test('POI маппинг', () => {
  const g = new PedGraph();
  g.build(makeIntersections());
  g.setPOIs([{ x: -32, z: 18, tag: 'cvetnik' }]);
  assert.equal(g.poiList.length, 1);
  assert.equal(g.poiList[0].tag, 'cvetnik');
  assert.equal(g.poiNodes.length, 1);
});

test('setPOIs отбрасывает точки вне сетки (ориентиры Машука южнее z=-256)', () => {
  const g = new PedGraph();
  g.build(makeIntersections());
  g.setPOIs([
    { x: -32, z: 18, tag: 'cvetnik' },  // внутри сетки — остаётся
    { x: 0, z: -448, tag: 'tower' },    // вершина Машука, далеко за границей — отбрасывается
  ]);
  assert.equal(g.poiList.length, 1);
  assert.equal(g.poiList[0].tag, 'cvetnik');
});

test('routesFrom+pathTo дают тот же путь, что и route() (регресс на рефакторинг)', () => {
  const g = new PedGraph();
  g.build(makeIntersections());
  const fromId = g.nearestNode(-192 - 8, -256);
  const toId = g.nearestNode(64, 64);
  const direct = g.route(fromId, toId, false);
  const { prev } = g.routesFrom(fromId, false);
  const viaSplit = g.pathTo(prev, fromId, toId);
  assert.deepEqual(viaSplit, direct);
});

test('routesFrom даёт непустой набор узлов с dist в [1,3] (примерно 2-6 walk-рёбер)', () => {
  const g = new PedGraph();
  g.build(makeIntersections());
  const fromId = g.nearestNode(0, 0);
  const { dist } = g.routesFrom(fromId, false);
  const candidates = dist.filter((d) => d >= 1 && d <= 3);
  assert.ok(candidates.length > 0);
});
```

- [ ] **Step 2: Запустить тесты — должны пройти сразу (реализация в Task 2)**

Run: `node --test tests/pedgraph.test.mjs`
Expected: 14 tests PASS (6 из Task 2 + 8 из Task 3). Если какой-то падает — исправь `src/pedgraph.js`.

- [ ] **Step 3: Коммит**

```bash
git add tests/pedgraph.test.mjs
git commit -m "test: маршрутизация графа пешеходов (зебры, jwalk, POI)"
```

---

### Task 4: `src/peds.js` — граф, зонная классификация, активация

**Files:**
- Modify: `src/peds.js`

- [ ] **Step 1: Импорт и новые поля пешехода**

В `src/peds.js` добавь импорт после `import { Events } ...`:

```js
import { PedGraph } from './pedgraph.js';
```

В `spawn()` объект `ped` (строки с `speechT: 0, chatCd: rand(10, 30)`) добавь после `chatCd`:

```js
        violator: Math.random() < CFG.pedViolatorChance,
        active: false, nearZone: false, laneOff: 0,
        route: null, routeIdx: 0, _edgeKind: null, edgeEnd: 0,
        idleT: 0, _blockedT: 0, _stuckT: 0, _reroute: 0,
```

Полей `_edgeAdvance` **нет** — маршрутизация не пропускает рёбра при движении
(см. Step 2, `_finishEdge` всегда `routeIdx += 1`; см. также `pedgraph.js`,
`edgeInfo` не возвращает поле `advance`). `_stuckT` — отдельный от `_blockedT`
счётчик: `_blockedT` копится при упоре в другого пешехода (кар-фолловинг,
Task 6), `_stuckT` — при упоре в статику (Task 6); разные таймауты и разная
реакция, поэтому не переиспользуем одно поле. `_reroute` — кулдаун (сек) до
следующей попытки `_activate`/пересчёта маршрута для этого пешехода.

В `adoptPedestrian()` объект `ped` (строка `angerT: 0, kickT: 0, kickCd: 0, speechT: 0, chatCd: rand(10, 30), walk: 0,`) добавь после `walk: 0`:

```js
      violator: Math.random() < CFG.pedViolatorChance,
      active: false, nearZone: false, laneOff: 0,
      route: null, routeIdx: 0, _edgeKind: null, edgeEnd: 0,
      idleT: 0, _blockedT: 0, _stuckT: 0, _reroute: 0,
```

В том же методе `adoptPedestrian`, перед `return ped;`, добавь немедленную
попытку активации — высаженный/подобранный пассажир обычно оказывается прямо
рядом с игроком (внутри активного радиуса), и без этой строки он до 0.5 с
ждёт очередного тика `_classify` пассивным пешеходом (`nearZone`/`active`
ещё `false`, обход статики для него в эти доли секунды не работает). `_activate`
уже безопасен к вызову раньше готовности графа (ранний выход на `!this.graph`),
поэтому проверка не нужна:

```js
    if (this._playerRef && Math.hypot(ped.x - this._playerRef.x, ped.z - this._playerRef.z) <= CFG.pedActiveRadius) {
      this._activate(ped);
    }
```

- [ ] **Step 2: Добавить методы графа и классификации**

В `constructor` после `this._count = 0;` добавь:

```js
    this.graph = null;
    this._classifyTimer = 0;
```

Добавь в класс (после метода `_heading`) новые методы:

```js
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

  /* Активировать: узел входа на СВОЕЙ ленте -> цель -> маршрут.
     Ранний выход при отлёте/убегании/пинке — не обрывает их сменой mode.
     Ровно один проход Dijkstra (routesFrom) на активацию — дальше выбор
     цели и восстановление пути работают по готовым dist/prev без повторных
     проходов (см. pedgraph.js, комментарий у routesFrom). */
  _activate(p) {
    if (!this.graph || p.isAnimal) return;
    if (p.knockT > 0 || p.mode === 'flee' || p.mode === 'kick') return;
    p.route = null; p.routeIdx = 0; p.laneOff = 0;

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

  _deactivate(p) {
    p.active = false;
    p.route = null; p.routeIdx = 0;
    p.laneOff = 0;
    if (p.mode === 'idle') p.mode = (p.archetype === 'runner' || p.archetype === 'dog') ? 'run' : 'walk';
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
      p.turn = {
        x0: e.x0, z0: e.z0, x1: e.x1, z1: e.z1, t: 0,
        dur: Math.hypot(e.x1 - e.x0, e.z1 - e.z0) / Math.max(p.speed, 0.5),
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
```

- [ ] **Step 3: Подключить классификацию и ленивую инициализацию графа в `update`**

В `update(dt, player, traffic, world)` после `if (world) this.world = world;` добавь:

```js
    if (world && !this.graph) this.initGraph(world);
```

И сразу после `if (traffic && traffic.lightsRef) this.lightsRef = traffic.lightsRef;` добавь:

```js
    this._classify(dt);
```

- [ ] **Step 4: Добавить `debugSummary` для проверки**

В конец класса (после `_sync`) добавь:

```js
  debugSummary() {
    if (!this.graph) return 'graph: none';
    const active = this.cars.filter(p => p.active).length;
    const near = this.cars.filter(p => p.nearZone).length;
    const routes = this.cars.filter(p => p.route).length;
    return `nodes:${this.graph.nodes.length} active:${active} near:${near} routed:${routes}`;
  }
```

- [ ] **Step 5: Проверить сборку**

Run: `python3 build.py`
Expected: `OK: index.html` без синтаксических ошибок.

- [ ] **Step 6: Проверить зонную активацию в браузере**

`main.js` экспонирует игру как `window.game = new Game()`. Открой
`http://localhost:8000` (сервер уже запущен) и в консоли:
```js
setInterval(() => { console.log(window.game && window.game.peds && window.game.peds.debugSummary()); }, 2000);
```
Expected: `nodes:693 active:<число> near:<число> routed:<число>`; `active` ≈ 4–10 и `routed` ≥ `active`−1 (пешеходы в idle — без route).

- [ ] **Step 7: Поправить порядок инициализации `world` в `game.js` (`_initManagers`)**

Сейчас `peds.spawn()` вызывается **до** присвоения `peds.world`/`peds.lightsRef`
— первичная валидация позиции спавна (`_spotBlocked`, добавляется в Task 6)
останется без доступа к `world` на первом спавне и молча пропустит проверку.

В `src/game.js`, метод `_initManagers`, найди:

```js
    this.peds = new PedestrianManager(this.scene);
    this.peds.spawn(CFG.pedCount, this.player);
    this.peds.lightsRef = this.world.lights;
    this.peds.world = this.world;
```

и замени порядок строк на:

```js
    this.peds = new PedestrianManager(this.scene);
    this.peds.lightsRef = this.world.lights;
    this.peds.world = this.world;
    this.peds.spawn(CFG.pedCount, this.player);
```

- [ ] **Step 8: Коммит**

```bash
git add src/peds.js src/game.js
git commit -m "feat: зонная классификация пешеходов, активация и маршруты по графу"
```

---

### Task 5: `src/peds.js` — активное движение по маршруту, прибытие, idle

**Files:**
- Modify: `src/peds.js`

- [ ] **Step 1: Добавить `_updateActive` и `_updateActiveWalk`**

Добавь методы после `_updateTurn`:

```js
  /* Активное движение по маршруту (активная зона) */
  _updateActive(p, dt) {
    if (p.mode === 'kick') return;
    if (p.mode === 'idle') {
      p.idleT -= dt;
      if (p.idleT <= 0) this._activate(p);
      return;
    }
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
```

- [ ] **Step 2: Направить активных пешеходов в `_updateActive`**

В `update()` замени блок диспетчера режимов:

```js
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
```

на:

```js
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
```

- [ ] **Step 3: Восстанавливать маршрут после убегания**

В `_snapToSidewalk` после `this._assignNewTarget(p);` добавь:

```js
    if (this.graph && p.active) this._activate(p);
```

- [ ] **Step 4: Исправить `_cancelCross` — не притворяться, что переход завершён**

Сейчас `_cancelCross` (слишком долгий красный / машины не пропускают) просто
возвращает `p.mode` в `walk`/`run`, оставляя `p._edgeKind === 'cross'` — на
следующем кадре активный пешеход попадает в walk-ветку `_updateActive` (Step 1
этой задачи), где убрана проверка `_edgeKind === 'cross'`, поэтому раньше это
приводило к ложному `_finishEdge` (маршрут думал, что дорога перейдена, хотя
пешеход остался на своей стороне). Теперь вместо этого — честный отказ от
попытки перейти: маршрут сбрасывается, пешеход пере-активируется заново
(получит новую цель на следующей классификации).

В `src/peds.js` найди:

```js
  _cancelCross(p) {
    p.mode = (p.archetype === 'runner' || p.archetype === 'dog') ? 'run' : 'walk';
    p.cross = null;
    p.turnT = 1.5;
  }
```

и замени на:

```js
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
```

- [ ] **Step 5: Проверить сборку**

Run: `python3 build.py`
Expected: `OK: index.html`.

- [ ] **Step 6: Проверить в браузере**

В консоли браузера убедись, что пешеходы в `debugSummary()` имеют `routed` близкое к `active`. Понаблюдай 1–2 минуты: активные пешеходы идут по тротуарам, на перекрёстках поворачивают/переходят по зебре, ждут зелёный у светофора, доходят до цели, стоят (`idle`), потом снова идут. Не должны «застревать» или дёргаться, ни один не должен зависнуть в `idle` навсегда (проверка B4 — дойди до Цветника/рынка и понаблюдай несколько циклов idle→маршрут подряд у одного и того же пешехода архетипа `tourist`/`grandma`).

- [ ] **Step 7: Коммит**

```bash
git add src/peds.js
git commit -m "feat: движение активных пешеходов по маршруту с прибытием и idle"
```

---

### Task 6: `src/peds.js` — обход препятствий (статика, пешеходы, машины)

**Files:**
- Modify: `src/peds.js`

- [ ] **Step 1: Учесть `laneOff` в `_worldPos` и завести отдельный temp-объект**

В `_worldPos`, ветку по умолчанию (после `if (p.mode === 'turn' && p.turn)`), замени:

```js
    const off = p.side * PED_SIDE;
```

на:

```js
    const off = p.side * PED_SIDE + (p.laneOff || 0);
```

В начале файла, рядом с `_tempPedWp`/`_tempPedWpSync`/`_tempPedWpTurn`, добавь
ещё один переиспользуемый временный объект — `_avoidStatic` (Step 3) вызывает
`_lanePoint` до 5 раз за кадр на одного пешехода (проба текущего смещения + до
4 кандидатов), и если использовать общий `_tempPedWp`, результат одного вызова
затирается следующим до того, как вызывающий код успевает с ним поработать
(сейчас безопасно только потому, что каждый вызов используется немедленно, но
это хрупко и легко сломать будущей правкой):

```js
const _tempPedProbe = { x: 0, z: 0 };
```

- [ ] **Step 2: Исправить `_startCross` — jwalk не должен телепортировать на пол-квартала**

Сейчас `_startCross(p)` всегда округляет `p.pos` до ближайшего перекрёстка
(`Math.round(p.pos / CFG.CELL) * CFG.CELL`) — корректно для настоящей зебры
(узел `cross` и так стоит на координате перекрёстка), но для `jwalk`-перехода
`p.pos` уже стоит на серединном узле квартала (`pos ≡ 32 (mod 64)`), и такое
округление прыгает на ближайший перекрёсток — до 32 м в сторону — вместо
честного перехода прямо на месте. Нужен параметр, отключающий округление для
jwalk, и пометка на `p.cross`, которую уже использует «Task 6 Step 6»
(разрешение перехода на красный) и `_getLightForPed` (jwalk не ждёт светофор).

В `src/peds.js` найди:

```js
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
```

и замени на:

```js
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
```

Существующие вызовы `this._startCross(p)` без второго аргумента (из `_decide`,
для животных и обычного «перейти дорогу») продолжают работать как раньше —
`jwalk` по умолчанию `false`. Новый вызов из `_startEdge` (Task 4, Step 2) уже
передаёт `e.kind === 'jwalk'` вторым аргументом.

- [ ] **Step 3: Добавить методы обхода статики/пешеходов**

Добавь после `_updateTurn`:

```js
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

  /* Боковое смещение вокруг статики (активная и ближняя зоны). laneOff
     ограничен ±1.5 (полуширина тротуара 2 м минус запас на корпус пешехода —
     значение согласовано со спекой, было ±1.9 у пешехода при ширине тротуара
     2 м, что вылезало на проезжую часть). Полная блокировка дольше 1.5 с —
     явная реакция (не бесконечная заморозка speed=0): активный пересчитывает
     маршрут, пассивный разворачивается — см. спеку, «Обход препятствий». */
  _avoidStatic(p, dt) {
    if (!this.world || (!p.nearZone && !p.active)) return;
    const look = 2.2;
    const dirX = p.axis === 'z' ? 0 : p.dir;
    const dirZ = p.axis === 'z' ? p.dir : 0;
    const probe = this._lanePoint(p, p.laneOff || 0);
    probe.x += dirX * look;
    probe.z += dirZ * look;
    if (!this._obstacleAt(probe.x, probe.z)) {
      p.laneOff *= Math.max(0, 1 - 4 * dt);
      if (Math.abs(p.laneOff) < 0.02) p.laneOff = 0;
      p._stuckT = 0;
      return;
    }
    for (const o of [1.4, -1.4, 2.4, -2.4]) {
      const cand = clamp((p.laneOff || 0) + o, -1.5, 1.5);
      const pr = this._lanePoint(p, cand);
      pr.x += dirX * look;
      pr.z += dirZ * look;
      if (!this._obstacleAt(pr.x, pr.z)) { p.laneOff = cand; p._stuckT = 0; return; }
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
```

- [ ] **Step 4: Вызывать обход статики и у пассивных (ближняя зона), восстанавливать скорость**

В `_updateWalk`, в самом начале метода (перед `p.pos += p.speed * dt * p.dir;`) добавь:

```js
    if (p.nearZone && !p.active) {
      p.speed = p.baseSpeed; // восстановление после предыдущей блокировки — см. _avoidStatic
      this._avoidStatic(p, dt);
    }
```

- [ ] **Step 5: Валидация позиции спавна от коллизий**

Добавь методы (после `_obstacleAt`):

```js
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
```

В `_randPlace`, после вычисления `wx`/`wz` и перед проверкой `d < 50` вставь проверку коллизии:

```js
      if (this._spotBlocked(wx, wz)) continue;
```

- [ ] **Step 6: Разрешить нарушителям переход на красный при зазоре**

В `_updateWait` замени блок со светофором:

```js
    const light = this._getLightForPed(p);
    if (light) {
      if (light.state !== 2) {
        if (p.waitT > 22.0) this._cancelCross(p);
        return;
      }
      if (this._carOnRoad(p, 25)) return;
      p.mode = 'cross';
    } else {
```

на:

```js
    const light = this._getLightForPed(p);
    if (light) {
      if (light.state !== 2 && !p.violator) {
        if (p.waitT > 22.0) this._cancelCross(p);
        return;
      }
      if (this._carOnRoad(p, 25)) return;
      p.mode = 'cross';
    } else {
```

А в `_getLightForPed` в самом начале добавь (jwalk-переходы не ждут светофор):

```js
    if (p.cross && p.cross.jwalk) return null; // незаконный переход светофором не управляется
```

- [ ] **Step 7: Проверить сборку**

Run: `python3 build.py`
Expected: `OK: index.html`.

- [ ] **Step 8: Проверить в браузере**

1. Подъезжай к пешеходам: они обходят фонари/лавки/деревья (боковое смещение), не застревают в них навсегда (проверка A5 — постой рядом с заблокированным пешеходом 2-3 с, он должен либо обойти, либо развернуться/пересчитать маршрут, а не замереть).
2. На одной ленте пешеходы не слипаются: догоняющий замедляется или обходит и **возвращается** в исходную полосу после обгона (проверка A9 — обгон должен завершаться, не залипать).
3. У зебры ждут зелёный/зазор; ~20% (нарушители) идут на красный при пустой дороге и иногда перебегают середину квартала (jwalk) — без прыжка на соседний перекрёсток (проверка A4).
4. Спавн пешеходов рядом с тобой — не внутри машин/лавок (проверь поворотом камеры на 360°).

- [ ] **Step 9: Коммит**

```bash
git add src/peds.js
git commit -m "feat: обход пешеходами препятствий (статика, пешеходы, машины) и нарушения ПДД"
```

---

### Task 6b: Разметка переходов по фактической траектории пешехода

**Files:**
- Modify: `src/citygen.js`

**Контекст:** см. спеку, подраздел «Разметка переходов». `_startCross`
(Task 6, Step 2) уже кладёт пешехода ровно на координату перекрёстка вдоль его
оси движения (`Math.round(p.pos / CFG.CELL) * CFG.CELL` — `CFG.CELL=64` это
шаг сетки перекрёстков, значит снап уже точный, никакого дрейфа в логике
движения нет) — но нарисованная зебра в `_crosswalks` стоит на ±6.2 м от
центра и узкая (~5 м из 12 м ширины проезжей части). Правим **разметку**, а не
логику: не трогаем `_startCross`/`_decide`/тайминг принятия решения — это
рискованная зона (геометрия поворотов/ожидания), которую нельзя надёжно
скорректировать без визуальной проверки в браузере.

- [ ] **Step 1: Отцентровать и расширить полосы зебры**

В `src/citygen.js`, метод `_crosswalks`, найди блок формирования `mNorth`/`mSouth`/`mWest`/`mEast`:

```js
    for (const isec of this.intersections) {
      const sx = isec.x, sz = isec.z;
      // 4 зебры вокруг каждого перекрёстка
      for (let k = -2; k <= 2; k++) {
        const off = k * 1.1;
        // Верхний и нижний подходы к перекрёстку (полосы вдоль X)
        const mNorth = new THREE.Matrix4().makeTranslation(sx + off, 0.11, sz - 6.2);
        const mSouth = new THREE.Matrix4().makeTranslation(sx + off, 0.11, sz + 6.2);
        listV.push(mNorth, mSouth);

        // Левый и правый подходы к перекрёстку (полосы вдоль Z)
        const mWest = new THREE.Matrix4().makeTranslation(sx - 6.2, 0.11, sz + off);
        const mEast = new THREE.Matrix4().makeTranslation(sx + 6.2, 0.11, sz + off);
        listH.push(mWest, mEast);
      }
    }
```

и замени смещение `±6.2` на `0` (центрируем на перекрёстке — там же, где
`_startCross` уже кладёт пешехода) и диапазон `k` с `[-2,2]` (±2.2 м) на
`[-5,5]` (±5.5 м, покрывает фактическую ширину пешеходной зоны перехода):

```js
    for (const isec of this.intersections) {
      const sx = isec.x, sz = isec.z;
      // 4 зебры вокруг каждого перекрёстка, центрированные на нём — там же,
      // где _startCross кладёт пешехода при переходе (см. Task 6, Step 2)
      for (let k = -5; k <= 5; k++) {
        const off = k * 1.1;
        const mNorth = new THREE.Matrix4().makeTranslation(sx + off, 0.11, sz);
        listV.push(mNorth);

        const mWest = new THREE.Matrix4().makeTranslation(sx, 0.11, sz + off);
        listH.push(mWest);
      }
    }
```

Полос теперь вдвое меньше на перекрёсток (по одной ленте на ориентацию вместо
северной+южной/западной+восточной пар), но каждая шире (`k∈[-5,5]` вместо
`[-2,2]`) и стоит там, где пешеход реально идёт, а не сдвинута в сторону —
итоговое число инстансов `InstancedMesh` даже меньше прежнего, на
производительность влиять не может.

- [ ] **Step 2: Проверить сборку**

Run: `python3 build.py`
Expected: `OK: index.html`.

- [ ] **Step 3: Визуально сверить в браузере (обязательно — не только по коду)**

Подойди/подъезжай к нескольким перекрёсткам (со светофором и без) и понаблюдай
переход пешехода: он должен идти по нарисованным полосам, а не рядом с ними.
Если расхождение осталось (например, полосы недостаточно широкие или чуть
смещены из-за визуальной толщины самих полос/скруглений камеры) — подправь
диапазон `k` или добавь небольшой финальный оффсет в этом же методе
(`_crosswalks`), не трогая `peds.js`.

- [ ] **Step 4: Коммит**

```bash
git add src/citygen.js
git commit -m "fix: разметка переходов centрирована на перекрёстке под фактическую траекторию пешехода"
```

---

### Task 7: Финальная проверка и чистка

**Files:**
- (нет изменений кода, кроме фиксов при необходимости)

- [ ] **Step 1: Полная сборка**

Run: `python3 build.py && node --test tests/`
Expected: `OK: index.html` и `# tests 14` pass (Task 0 делает `node --test`
вообще запускаемым — без `package.json` тут была бы `SyntaxError`).

- [ ] **Step 2: Регрессионная проверка в браузере**

1. Старт смены, езда по городу 3–5 минут: пешеходы дальше 150 м ведут себя как раньше (простая ходьба), активные — по маршрутам.
2. Поворот камеры на 360° при стоянке: нет пешеходов, стоящих внутри лавок/фонарей/машин.
3. Сбивание пешехода: отлёт/убегание работают, после восстановления маршрут пересчитывается (не «телепортирует» на старую цель).
4. Заказы/пассажиры (`adoptPedestrian`): ушедший пассажир ведёт себя как горожанин.
5. `debugSummary()`: `nodes:693`, `active`+`near` в разумных пределах, нет NaN/undefined в `p.x/p.z` (консоль чистая).
6. Собаки/коты не участвуют в маршрутах (не ждут светофор, перебегают как раньше — B3), но не застревают в лавках/деревьях в ближней/активной зоне.
7. Пешеход-турист/бабушка после прибытия к POI не зависает в `idle` навечно — понаблюдай 2-3 полных цикла `idle → маршрут` у одного и того же пешехода (проверка B4).
8. Достопримечательности иногда реально выбираются целью (не только точки подачи такси) — понаблюдай маршруты нескольких активных пешеходов подряд (проверка B1).
9. Резкий разворот камеры/машины, вводящий сразу несколько пешеходов в активную зону, не даёт заметного фриза кадра (лимит 2 активации за тик, Task 4).
10. Переход выполняется по нарисованной зебре (Task 6b), а не рядом с ней.
11. Активный пешеход, срезающий угол на перекрёстке (`turn`), не телепортируется назад, если в этот момент выехал за пределы активного радиуса — понаблюдай за поворотом на границе зоны (проверка B/`_classify` turn-guard).
12. Два активных пешехода, идущих навстречу друг другу по одному тротуару, расходятся в разные стороны, а не толкаются на месте (проверка `_avoidPeds` head-on).

- [ ] **Step 3: Убрать временный отладочный вывод (если добавлялся) и пересобрать**

Если в консоли была временная отладка — удали, `python3 build.py`.

- [ ] **Step 4: Финальный коммит (если были фиксы)**

```bash
git add src/
git commit -m "fix: финальные правки пешеходов по результатам проверки"
```
Если правок не было — ничего не коммить.

---

## Self-Review (ревизия 2026-08-07)

- **Покрытие спеки:** зоны (Task 1, 4), тесты запускаемы (Task 0), граф+рёбра
  (Task 2), Dijkstra без повторных проходов/jwalk/POI с фильтром по дистанции
  (Task 2-3), маршрут без телепорта на входе, взвешенные POI, кулдаун
  ре-активации, лимит активаций за тик (Task 4-5), ПДД включая нарушения и
  корректный jwalk (Task 6), обход статики/пешеходов/машин без необратимой
  заморозки скорости (Task 6), спавн без коллизий (Task 6), разметка под
  фактическую траекторию (Task 6b), интеграция `adoptPedestrian` и животных
  (Task 4 — общие поля/обновление, пропуск `isAnimal`), константы (Task 1).
- **Плейсхолдеров нет** — все шаги содержат полный код.
- **Консистентность типов:** `_startEdge`/`_finishEdge`/`_arrive`/`_activate`/
  `_deactivate`/`_pickDestination`/`_pickPoiFor`/`_pickWeightedPoi`/
  `_pickRandomNode`/`_edgesFor`/`_updateActive`/`_avoidStatic`/`_avoidPeds`/
  `_lanePoint`/`_obstacleAt`/`_spotBlocked`/`initGraph`/`_classify`/
  `_cancelCross`/`_startCross`/`debugSummary` определены в плане и
  согласованы; `_edgeAdvance` из плана исключён (был источником бага
  пропуска рёбер — A2). Поля пешехода: `violator`, `active`, `nearZone`,
  `laneOff`, `route`, `routeIdx`, `_edgeKind`, `edgeEnd`, `idleT`,
  `_blockedT`, `_stuckT`, `_reroute`, `_turnTo` инициализируются в
  `spawn`/`adoptPedestrian` (Task 4 Step 1).
- **Известные компромиссы, оставленные сознательно:** `_pickRandomNode`
  перебирает узлы линейно (не через приоритетную очередь) — приемлемо при
  ~2 активациях за тик и уже готовом `dist[]`; при полной блокировке статикой
  активный пешеход деактивируется и ждёт следующего тика классификации
  (~0.5 с), а не пересчитывает маршрут мгновенно в том же кадре — небольшая
  задержка ради простоты кода; разметка переходов (Task 6b) подбирается
  полу-эмпирически с явным шагом визуальной проверки в браузере, так как
  точная геометрия зависит от рендера, который нельзя проверить только чтением
  кода.
- **Учтён независимый повторный анализ** (`docs/plans/2026-08-07-intelligent-peds-analysis.md`,
  написан отдельно от этой ревизии) — из его 5 замечаний 3 применимы к текущей
  редакции плана и внесены: (1) `_classify` не деактивирует посреди `turn` —
  иначе `axis`/`coord`/`pos` для активного графового поворота остаются от
  точки ДО поворота (обновляются только по завершении, в `_updateActive`), и
  пешеход визуально откатывается назад; (2) `_avoidPeds` для встречных
  (`o.dir !== p.dir`) выбирает сторону обхода детерминированно от
  собственного `p.dir`, а не от `laneOff` оппонента — иначе оба, стартуя с
  `laneOff=0`, синхронно уходят в одну и ту же сторону и не расходятся; (3)
  `adoptPedestrian` пытается активироваться сразу, а не ждёт до 0.5 с
  следующего тика `_classify`, — высаженный пассажир обычно стоит прямо в
  активном радиусе игрока. Два замечания того анализа (A и C) касались
  формулировок исходного, дореформенного плана и уже покрыты этой ревизией
  иначе — без поглощения ребра в `advance` (A2 выше) и хешем зданий вместо
  линейного перебора (A11 выше).

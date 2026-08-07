# Интеллектуальные пешеходы — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пешеходы осмысленно ходят «откуда→куда» по графу тротуаров, соблюдают ПДД (с нарушениями у ~20%) и обходят статику/пешеходов/машины. Полный ИИ — только в активной зоне (≤110 м от игрока), ближняя зона (110–150 м) — простое движение + обход статики, дальняя — текущее поведение.

**Architecture:** Новый чистый модуль `src/pedgraph.js` (без THREE/DOM, тестируется в node) строит граф ходьбы из `world.intersections`: 5 узлов на перекрёсток + серединные узлы тротуаров; рёбра walk/cross/turn/jwalk. Dijkstra с фильтром `jwalk` (только для `violator`). `src/peds.js` получает зонную классификацию и следует маршруту поверх текущей модели `axis/coord/pos` (переиспользуются `_startCross`/`_updateCross`/`_updateWait`).

**Tech Stack:** Vanilla JS ES-модули, Three.js (только в peds.js), сборка `python3 build.py`, тесты `node --test`.

**Спека:** `docs/superpowers/specs/2026-08-07-intelligent-peds-design.md`

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

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Статический граф ходьбы города.
 * Узлы: 4 «тротуарных» (+ серединные) на лентах дорог и 1 центр перехода на
 * перекрёстке. Рёбра: walk (тротуар), cross (зебра через дорогу, пара через
 * центр), turn (срез угла на перекрёстке), jwalk (середина квартала, только
 * для нарушителей). Без зависимостей (no THREE/DOM) — тестируется в node.
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

  /** Маппинг POI-точек на ближайшие тротуарные узлы. list: [{x, z, tag?}] */
  setPOIs(list) {
    this.poiList = list
      .map(p => ({ node: this.nearestNode(p.x, p.z), tag: p.tag || null }))
      .filter(p => p.node != null);
    this.poiNodes = this.poiList.map(p => p.node);
  }

  /** Dijkstra. allowJwalk=false запрещает jwalk-рёбра. Возвращает массив node id или null. */
  route(fromId, toId, allowJwalk) {
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
      if (u === toId) break;
      for (const e of this.adj[u]) {
        if (e.kind === 'jwalk' && !allowJwalk) continue;
        const nd = dist[u] + e.cost;
        if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; }
      }
    }
    if (fromId !== toId && prev[toId] === -1) return null;
    const path = [];
    for (let c = toId; c !== -1; c = prev[c]) path.push(c);
    path.reverse();
    return path;
  }

  /**
   * Дескриптор ребра для движения пешехода (from=id a, to=id b).
   * Возвращает { kind, advance, ... } или null.
   */
  edgeInfo(aId, bId) {
    const a = this.nodes[aId], b = this.nodes[bId];
    let kind = null;
    for (const e of this.adj[aId]) if (e.to === bId) kind = e.kind;
    if (!kind) return null;
    const sideOf = (node) => (node.axis === 'z' ? (node.x > node.road ? 1 : -1) : (node.z > node.road ? 1 : -1));
    const posOf = (node) => (node.axis === 'z' ? node.z : node.x);
    const d = { kind, advance: 1 };
    if (kind === 'walk') {
      d.axis = a.axis; d.coord = a.road; d.side = sideOf(a);
      d.posStart = posOf(a); d.posEnd = posOf(b);
    } else if (kind === 'cross') {
      d.axis = a.axis; d.coord = a.road; d.side = sideOf(a);
      d.pos = posOf(a);
      d.advance = 2; // зебра = пара рёбер через центр
    } else if (kind === 'jwalk') {
      d.axis = a.axis; d.coord = a.road; d.side = sideOf(a);
      d.pos = posOf(a);
    } else if (kind === 'turn') {
      d.x0 = a.x; d.z0 = a.z; d.x1 = b.x; d.z1 = b.z;
      d.newAxis = b.axis; d.newCoord = b.road; d.newSide = sideOf(b); d.newPos = posOf(b);
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
```

- [ ] **Step 2: Запустить тесты — должны пройти сразу (реализация в Task 2)**

Run: `node --test tests/pedgraph.test.mjs`
Expected: 11 tests PASS. Если какой-то падает — исправь `src/pedgraph.js`.

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
        route: null, routeIdx: 0, _edgeKind: null, _edgeAdvance: 1, edgeEnd: 0,
        idleT: 0, _blockedT: 0,
```

В `adoptPedestrian()` объект `ped` (строка `angerT: 0, kickT: 0, kickCd: 0, speechT: 0, chatCd: rand(10, 30), walk: 0,`) добавь после `walk: 0`:

```js
      violator: Math.random() < CFG.pedViolatorChance,
      active: false, nearZone: false, laneOff: 0,
      route: null, routeIdx: 0, _edgeKind: null, _edgeAdvance: 1, edgeEnd: 0,
      idleT: 0, _blockedT: 0,
```

- [ ] **Step 2: Добавить методы графа и классификации**

В `constructor` после `this._count = 0;` добавь:

```js
    this.graph = null;
    this._classifyTimer = 0;
```

Добавь в класс (после метода `_heading`) новые методы:

```js
  /* Построить граф ходьбы из мира + POI (достопримечательности, точки подачи, заправки) */
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
  }

  /* Классификация зон (0.5 с, гистерезис) — активная/ближняя/дальняя */
  _classify(dt) {
    this._classifyTimer -= dt;
    if (this._classifyTimer > 0) return;
    this._classifyTimer = 0.5;
    if (!this.graph) return;
    const pl = this._playerRef;
    const px = pl && pl.x !== undefined ? pl.x : 0;
    const pz = pl && pl.z !== undefined ? pl.z : 0;
    for (const p of this.cars) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - px, p.z - pz);
      p.nearZone = d <= CFG.pedNearRadius;
      if (!p.active && d <= CFG.pedActiveRadius) this._activate(p);
      else if (p.active && d > CFG.pedActiveRadius + 5 && p.mode !== 'cross' && p.mode !== 'wait') this._deactivate(p);
    }
  }

  /* Активировать: ближайший узел -> цель -> маршрут */
  _activate(p) {
    if (!this.graph) return;
    const fromId = this.graph.nearestNode(p.x, p.z);
    if (fromId == null) return;
    const toId = this._pickDestination(p, fromId);
    if (toId == null || toId === fromId) return;
    const path = this.graph.route(fromId, toId, p.violator);
    if (!path || path.length < 2) return;
    p.route = this._edgesFor(path);
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

  /* Выбор цели: гибрид POI (по архетипу) + случайная на дистанции 2-6 */
  _pickDestination(p, fromId) {
    const g = this.graph;
    const from = g.nodes[fromId];
    if (p.archetype === 'tourist') {
      const id = this._pickPoiFor(from, 'cvetnik', 'proval');
      if (id != null) return id;
    }
    if (p.archetype === 'grandma') {
      const id = this._pickPoiFor(from, 'rynok', 'pickup', 'fuel');
      if (id != null) return id;
    }
    if (g.poiNodes.length && Math.random() < 0.5) {
      return g.poiNodes[Math.floor(Math.random() * g.poiNodes.length)];
    }
    return this._pickRandomNode(fromId, p.violator);
  }

  _pickPoiFor(from, ...tags) {
    const g = this.graph;
    const pool = g.poiList.filter(po => tags.some(t => po.tag && po.tag.includes(t)));
    const list = pool.length ? pool : g.poiList;
    if (!list.length) return null;
    let best = null, bd = Infinity;
    for (const po of list) {
      const n = g.nodes[po.node];
      if (!n) continue;
      const d = (n.x - from.x) ** 2 + (n.z - from.z) ** 2;
      if (d < bd) { bd = d; best = po.node; }
    }
    return best;
  }

  _pickRandomNode(fromId, violator) {
    const g = this.graph;
    const lanes = g.nodes.filter(n => n.kind === 'lane' || n.kind === 'mid');
    for (let i = 0; i < 12; i++) {
      const cand = lanes[Math.floor(Math.random() * lanes.length)];
      if (cand.id === fromId) continue;
      const path = g.route(fromId, cand.id, violator);
      if (path && path.length - 1 >= 2 && path.length - 1 <= 6) return cand.id;
    }
    for (const n of lanes) {
      const path = g.route(fromId, n.id, violator);
      if (path) return n.id;
    }
    return null;
  }

  /* Маршрут -> массив дескрипторов рёбер (сливаем пару cross через центр) */
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
    p._edgeAdvance = e.advance || 1;
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

  _finishEdge(p, advance) {
    p.routeIdx += advance;
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

Открой `http://localhost:8000` (сервер уже запущен) и в консоли:
```js
window.__peds = null; // после первого кадра:
setInterval(() => { console.log(gameRef && gameRef.peds && gameRef.peds.debugSummary()); }, 2000);
```
Если `gameRef` недоступен глобально — проверь в коде `game.js`/`main.js`, как экспонируется игра, и используй доступный идентификатор.
Expected: `nodes:693 active:<число> near:<число> routed:<число>`; `active` ≈ 4–10 и `routed` ≥ `active`−1 (пешеходы в idle — без route).

- [ ] **Step 7: Коммит**

```bash
git add src/peds.js
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
        this._finishEdge(p, p._edgeAdvance);
      }
      return;
    }
    if (p.mode === 'turn') {
      this._updateTurn(p, dt);
      if (p.turn === null && p._edgeKind === 'turn') {
        const t = p._turnTo;
        p.axis = t.newAxis; p.coord = t.newCoord; p.side = t.newSide; p.pos = t.newPos;
        this._finishEdge(p, 1);
      }
      return;
    }
    // walk/run по ленте
    this._avoidStatic(p, dt);
    this._avoidPeds(p);
    p.pos += p.speed * dt * p.dir;
    if (p._edgeKind === 'walk' && Math.abs(p.pos - p.edgeEnd) < 0.7) {
      this._finishEdge(p, p._edgeAdvance);
      return;
    }
    if (p._edgeKind === 'cross' || p._edgeKind === 'jwalk') {
      this._finishEdge(p, p._edgeAdvance);
      return;
    }
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

- [ ] **Step 4: Проверить сборку**

Run: `python3 build.py`
Expected: `OK: index.html`.

- [ ] **Step 5: Проверить в браузере**

В консоли браузера убедись, что пешеходы в `debugSummary()` имеют `routed` близкое к `active`. Понаблюдай 1–2 минуты: активные пешеходы идут по тротуарам, на перекрёстках поворачивают/переходят по зебре, ждут зелёный у светофора, доходят до цели, стоят (`idle`), потом снова идут. Не должны «застревать» или дёргаться.

- [ ] **Step 6: Коммит**

```bash
git add src/peds.js
git commit -m "feat: движение активных пешеходов по маршруту с прибытием и idle"
```

---

### Task 6: `src/peds.js` — обход препятствий (статика, пешеходы, машины)

**Files:**
- Modify: `src/peds.js`

- [ ] **Step 1: Учесть `laneOff` в `_worldPos`**

В `_worldPos`, ветку по умолчанию (после `if (p.mode === 'turn' && p.turn)`), замени:

```js
    const off = p.side * PED_SIDE;
```

на:

```js
    const off = p.side * PED_SIDE + (p.laneOff || 0);
```

- [ ] **Step 2: Добавить методы обхода статики/пешеходов**

Добавь после `_updateTurn`:

```js
  /* Точка на ленте с заданным боковым смещением (для проверки препятствий) */
  _lanePoint(p, off, out = _tempPedWp) {
    const o = p.side * PED_SIDE + off;
    if (p.axis === 'z') { out.x = p.coord + o; out.z = p.pos; }
    else { out.x = p.pos; out.z = p.coord + o; }
    return out;
  }

  /* Есть ли статическое препятствие (пропс/здание/круглый коллайдер) в точке */
  _obstacleAt(x, z) {
    const w = this.world;
    if (!w) return false;
    if (w._checkPropCollision(x, z, 0.4)) return true;
    for (const b of w.buildings) {
      if (x > b.x0 - 0.3 && x < b.x1 + 0.3 && z > b.z0 - 0.3 && z < b.z1 + 0.3) return true;
    }
    for (const c of w.circleColliders) {
      if (Math.hypot(x - c.x, z - c.z) < c.r + 0.3) return true;
    }
    return false;
  }

  /* Боковое смещение вокруг статики (активная и ближняя зоны) */
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
      return;
    }
    for (const o of [1.4, -1.4, 2.4, -2.4]) {
      const cand = clamp((p.laneOff || 0) + o, -1.9, 1.9);
      const pr = this._lanePoint(p, cand);
      pr.x += dirX * look;
      pr.z += dirZ * look;
      if (!this._obstacleAt(pr.x, pr.z)) { p.laneOff = cand; return; }
    }
    p.speed = 0; // полностью заблокировано — короткая остановка
  }

  /* Разъезд активных пешеходов на одной ленте (кар-фолловинг + обгон) */
  _avoidPeds(p) {
    for (const o of this.cars) {
      if (o === p || !o.alive || !o.active) continue;
      if (o.mode !== 'walk' && o.mode !== 'run' && o.mode !== 'idle' && o.mode !== 'wait') continue;
      if (o.axis !== p.axis || o.coord !== p.coord || o.side !== p.side) continue;
      const d = (o.pos - p.pos) * p.dir;
      if (d <= 0 || d > 2.2) continue;
      const leaderSpeed = (o.mode === 'idle' || o.mode === 'wait') ? 0 : o.speed;
      if (p.speed > leaderSpeed) p.speed = Math.max(0.3, leaderSpeed);
      if (leaderSpeed < p.baseSpeed * 0.6) {
        p._blockedT += 1 / 60;
        if (p._blockedT > 1.0 && p.laneOff === 0) {
          p.laneOff = (o.laneOff || 0) >= 0 ? -1.4 : 1.4;
          p.speed = Math.min(p.baseSpeed * 1.25, p.speed + 0.5);
        }
      } else {
        p._blockedT = 0;
      }
    }
    if (p._blockedT > 2.0) p._blockedT = 0; // не копим вечно
  }
```

- [ ] **Step 3: Вызывать обход статики и у пассивных (ближняя зона)**

В `_updateWalk`, в самом начале метода (перед `p.pos += p.speed * dt * p.dir;`) добавь:

```js
    if (p.nearZone && !p.active) this._avoidStatic(p, dt);
```

- [ ] **Step 4: Валидация позиции спавна от коллизий**

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

- [ ] **Step 5: Разрешить нарушителям переход на красный при зазоре**

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

- [ ] **Step 6: Проверить сборку**

Run: `python3 build.py`
Expected: `OK: index.html`.

- [ ] **Step 7: Проверить в браузере**

1. Подъезжай к пешеходам: они обходят фонари/лавки/деревья (боковое смещение), не застревают в них.
2. На одной ленте пешеходы не слипаются: догоняющий замедляется или обходит.
3. У зебры ждут зелёный/зазор; ~20% (нарушители) идут на красный при пустой дороге и иногда перебегают середину квартала.
4. Спавн пешеходов рядом с тобой — не внутри машин/лавок (проверь поворотом камеры на 360°).

- [ ] **Step 8: Коммит**

```bash
git add src/peds.js
git commit -m "feat: обход пешеходами препятствий (статика, пешеходы, машины) и нарушения ПДД"
```

---

### Task 7: Финальная проверка и чистка

**Files:**
- (нет изменений кода, кроме фиксов при необходимости)

- [ ] **Step 1: Полная сборка**

Run: `python3 build.py && node --test tests/`
Expected: `OK: index.html` и `# tests 11` pass.

- [ ] **Step 2: Регрессионная проверка в браузере**

1. Старт смены, езда по городу 3–5 минут: пешеходы дальше 150 м ведут себя как раньше (простая ходьба), активные — по маршрутам.
2. Поворот камеры на 360° при стоянке: нет пешеходов, стоящих внутри лавок/фонарей/машин.
3. Сбивание пешехода: отлёт/убегание работают, после восстановления маршрут пересчитывается.
4. Заказы/пассажиры (`adoptPedestrian`): ушедший пассажир ведёт себя как горожанин.
5. `debugSummary()`: `nodes:693`, `active`+`near` в разумных пределах, нет NaN/undefined в `p.x/p.z` (консоль чистая).

- [ ] **Step 3: Убрать временный отладочный вывод (если добавлялся) и пересобрать**

Если в консоли была временная отладка — удали, `python3 build.py`.

- [ ] **Step 4: Финальный коммит (если были фиксы)**

```bash
git add src/
git commit -m "fix: финальные правки пешеходов по результатам проверки"
```
Если правок не было — ничего не коммить.

---

## Self-Review (выполнено при написании)

- **Покрытие спеки:** зоны (Task 1, 4), граф+рёбра (Task 2), Dijkstra/jwalk/POI (Task 2-3), маршрут и idle (Task 4-5), ПДД включая нарушения (Task 6), обход статики/пешеходов/машин (Task 6), спавн без коллизий (Task 6), интеграция `adoptPedestrian` (Task 4 — общие поля/обновление), константы (Task 1).
- **Плейсхолдеров нет** — все шаги содержат полный код.
- **Консистентность типов:** `_startEdge`/`_finishEdge`/`_arrive`/`_activate`/`_deactivate`/`_pickDestination`/`_pickPoiFor`/`_pickRandomNode`/`_edgesFor`/`_updateActive`/`_avoidStatic`/`_avoidPeds`/`_lanePoint`/`_obstacleAt`/`_spotBlocked`/`initGraph`/`_classify`/`debugSummary` определены в плане и согласованы. Поля пешехода: `violator`, `active`, `nearZone`, `laneOff`, `route`, `routeIdx`, `_edgeKind`, `_edgeAdvance`, `edgeEnd`, `idleT`, `_blockedT`, `_turnTo` инициализируются в `spawn`/`adoptPedestrian` (Task 4 Step 1).

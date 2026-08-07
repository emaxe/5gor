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

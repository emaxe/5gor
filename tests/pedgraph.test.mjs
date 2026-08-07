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

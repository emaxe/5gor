import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCarRoadGraph, findCarRoute, findNearestNode, routeLength } from '../src/gps.js';

function makeIntersections() {
  const arr = [];
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      arr.push({ x: -256 + i * 64, z: -256 + j * 64 });
    }
  }
  return arr;
}

test('buildCarRoadGraph: builds 81 nodes with 2, 3, or 4 neighbors and caches', () => {
  const isecs = makeIntersections();
  const graph = buildCarRoadGraph(isecs);
  assert.equal(graph.size, 81);

  // Угловой узел (-256, -256) -> 2 соседа
  const corner = graph.get('-256,-256');
  assert.equal(corner.length, 2);

  // Граничный узел (-256, 0) -> 3 соседа
  const border = graph.get('-256,0');
  assert.equal(border.length, 3);

  // Внутренний узел (0, 0) -> 4 соседа
  const center = graph.get('0,0');
  assert.equal(center.length, 4);

  // Проверка кэширования по ссылке
  const graphCached = buildCarRoadGraph(isecs);
  assert.equal(graph, graphCached);
});

test('findNearestNode: snaps to closest intersection', () => {
  const isecs = makeIntersections();
  const n1 = findNearestNode(isecs, 0, 0);
  assert.deepEqual(n1, { x: 0, z: 0 });

  const n2 = findNearestNode(isecs, 20, 15);
  assert.deepEqual(n2, { x: 0, z: 0 });

  const n3 = findNearestNode(isecs, 45, 0);
  assert.deepEqual(n3, { x: 64, z: 0 });

  const n4 = findNearestNode(isecs, -300, -300);
  assert.deepEqual(n4, { x: -256, z: -256 });
});

test('routeLength: calculates exact polyline distance', () => {
  assert.equal(routeLength(null), 0);
  assert.equal(routeLength([]), 0);
  assert.equal(routeLength([{ x: 0, z: 0 }]), 0);
  assert.equal(routeLength([{ x: 0, z: 0 }, { x: 100, z: 0 }]), 100);
  assert.equal(routeLength([{ x: 0, z: 0 }, { x: 3, z: 4 }]), 5);
  assert.equal(routeLength([{ x: 0, z: 0 }, { x: 0, z: 64 }, { x: 64, z: 64 }]), 128);
});

test('findCarRoute: direct route to adjacent intersection is 1 segment', () => {
  const isecs = makeIntersections();
  const graph = buildCarRoadGraph(isecs);
  const route = findCarRoute(isecs, graph, 0, 0, 64, 0);
  assert.ok(route);
  assert.equal(route.length, 2);
  assert.deepEqual(route[0], { x: 0, z: 0 });
  assert.deepEqual(route[1], { x: 64, z: 0 });
  assert.equal(routeLength(route), 64);
});

test('findCarRoute: first segment goes to nearest road from off-grid position', () => {
  const isecs = makeIntersections();
  const graph = buildCarRoadGraph(isecs);
  const route = findCarRoute(isecs, graph, 10, 10, 150, 50);
  assert.ok(route);
  // Точка старта игрока (10, 10), первый сегмент идёт к ближайшему перекрёстку (0, 0)
  assert.deepEqual(route[0], { x: 10, z: 10 });
  assert.deepEqual(route[1], { x: 0, z: 0 });
  // Конечная точка — точные координаты цели (150, 50)
  assert.deepEqual(route[route.length - 1], { x: 150, z: 50 });
  // Дистанция маршрута не меньше евклидова расстояния
  const directDist = Math.hypot(150 - 10, 50 - 10);
  assert.ok(routeLength(route) >= directDist);
});

test('findCarRoute: route to far intersection exists across city grid', () => {
  const isecs = makeIntersections();
  const graph = buildCarRoadGraph(isecs);
  const route = findCarRoute(isecs, graph, -256, -256, 256, 256);
  assert.ok(route);
  // Манхэттенское расстояние по сетке 8x8 кварталов: (8+8)*64 = 1024
  assert.equal(routeLength(route), 1024);
  assert.equal(route.length, 17); // 1 старт + 15 промежуточных + 1 финиш
});

test('findCarRoute: routeLength is monotonic with added points', () => {
  const p1 = { x: 0, z: 0 };
  const p2 = { x: 64, z: 0 };
  const p3 = { x: 64, z: 64 };
  const p4 = { x: 128, z: 64 };
  const len2 = routeLength([p1, p2]);
  const len3 = routeLength([p1, p2, p3]);
  const len4 = routeLength([p1, p2, p3, p4]);
  assert.ok(len2 < len3);
  assert.ok(len3 < len4);
});

test('findCarRoute: handles same-intersection start and end', () => {
  const isecs = makeIntersections();
  const graph = buildCarRoadGraph(isecs);
  const route = findCarRoute(isecs, graph, 5, 5, 15, 15);
  assert.ok(route);
  assert.deepEqual(route[0], { x: 5, z: 5 });
  assert.deepEqual(route[1], { x: 0, z: 0 });
  assert.deepEqual(route[2], { x: 15, z: 15 });
});

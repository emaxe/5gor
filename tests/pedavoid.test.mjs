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
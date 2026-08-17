import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerPed } from '../src/playerped.js';

function makeScene() {
  const removed = [];
  return {
    added: [],
    removed,
    add(mesh) { this.added.push(mesh); },
    remove(mesh) { removed.push(mesh); },
  };
}

function makeWorld(overrides) {
  return {
    heightAt: () => 0,
    buildings: [],
    circleColliders: [],
    propsAABB: [],
    ...(overrides || {}),
  };
}

const peds = { cars: [] };
const playerCar = { x: 10, z: 10, heading: 0, stats: { carType: 'taxi' } };

test('конструктор создаёт mesh и инициализирует поля', () => {
  const scene = makeScene();
  const ped = new PlayerPed(scene);
  assert.ok(ped.mesh, 'mesh создан');
  assert.equal(ped.x, 0);
  assert.equal(ped.z, 0);
  assert.equal(ped.heading, 0);
  assert.equal(ped.speed, 0);
  assert.equal(ped.walkPhase, 0);
  assert.equal(ped.isRunning, false);
  assert.ok(scene.added.includes(ped.mesh), 'mesh добавлен в scene');
});

test('setPos устанавливает x/z/heading и сбрасывает speed', () => {
  const scene = makeScene();
  const ped = new PlayerPed(scene);
  ped.speed = 5;
  ped.walkPhase = 3;
  ped.setPos(10, 20, Math.PI / 4);
  assert.equal(ped.x, 10);
  assert.equal(ped.z, 20);
  assert.equal(ped.heading, Math.PI / 4);
  assert.equal(ped.speed, 0);
  assert.equal(ped.walkPhase, 0);
  assert.equal(ped.mesh.position.x, 10);
  assert.equal(ped.mesh.position.z, 20);
  assert.equal(ped.mesh.rotation.y, Math.PI / 4);
});

test('движение вперёд при walkForward=1 меняет позицию', () => {
  const scene = makeScene();
  const ped = new PlayerPed(scene);
  const input = { keys: new Set(), walkForward: 1, walkRight: 0, camYaw: 0, isRunning: false };
  ped.update(1, input, makeWorld(), peds, playerCar);
  assert.ok(ped.z > 0, `z > 0, получено ${ped.z}`);
  assert.equal(ped.x, 0);
});

test('движение с camYaw=Math.PI/2 идёт по +X', () => {
  const scene = makeScene();
  const ped = new PlayerPed(scene);
  const input = { keys: new Set(['KeyW']), camYaw: Math.PI / 2, isRunning: false };
  ped.update(1, input, makeWorld(), peds, playerCar);
  assert.ok(ped.x > 0, `x > 0, получено ${ped.x}`);
  assert.ok(Math.abs(ped.z) < 0.01, `z ≈ 0, получено ${ped.z}`);
});

test('коллизия со зданием выталкивает пешехода', () => {
  const scene = makeScene();
  const ped = new PlayerPed(scene);
  ped.setPos(0, 0, 0);
  const world = makeWorld({ buildings: [{ x0: -5, x1: 5, z0: 0.8, z1: 5 }] });
  const input = { keys: new Set(), walkForward: 1, walkRight: 0, camYaw: 0, isRunning: false };
  ped.update(0.5, input, world, peds, playerCar);
  assert.ok(ped.z < 1.2, `z < 1.2, получено ${ped.z}`);
  assert.ok(ped.z >= 0, `z >= 0, получено ${ped.z}`);
});

test('коллизия с пропсом блокирует движение', () => {
  const scene = makeScene();
  const ped = new PlayerPed(scene);
  ped.setPos(0, 0, 0);
  const world = makeWorld({ propsAABB: [{ x0: -5, x1: 5, z0: 0.8, z1: 5 }] });
  const input = { keys: new Set(), walkForward: 1, walkRight: 0, camYaw: 0, isRunning: false };
  ped.update(0.5, input, world, peds, playerCar);
  assert.ok(ped.z < 1.2, `z < 1.2, получено ${ped.z}`);
  assert.ok(ped.z >= 0, `z >= 0, получено ${ped.z}`);
});

test('границы карты clamp до ±308', () => {
  const scene = makeScene();
  const ped = new PlayerPed(scene);
  ped.setPos(307, 307, 0);
  const world = makeWorld();
  const input = { keys: new Set(), walkForward: 1, walkRight: 1, camYaw: 0, isRunning: false };
  for (let i = 0; i < 200; i++) {
    ped.update(0.1, input, world, peds, playerCar);
  }
  assert.ok(ped.x <= 308, `x <= 308, получено ${ped.x}`);
  assert.ok(ped.z <= 308, `z <= 308, получено ${ped.z}`);
});

test('dispose удаляет mesh из scene', () => {
  const scene = makeScene();
  const ped = new PlayerPed(scene);
  ped.dispose();
  assert.ok(scene.removed.includes(ped.mesh), 'mesh удалён из scene');
});

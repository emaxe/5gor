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
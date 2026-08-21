/**
 * Граф автомобильных дорог и поиск маршрутов (GPS-навигатор).
 * Чистая логика без THREE/DOM — тестируется в Node.js.
 * Дорожная сеть Пятигорска представляет собой регулярную сетку перекрёстков 9x9
 * с шагом 64 м (координаты от -256 до +256).
 */

// Кэш графа смежности по ссылке на массив перекрёстков
let _cachedIntersections = null;
let _cachedGraph = null;

// Переиспользуемые структуры для BFS — zero-alloc в цикле маршрутизации
const _bfsQueue = [];
const _bfsParent = new Map();

/**
 * Находит геометрически ближайший узел (перекрёсток) к заданной точке (x, z).
 * @param {Array<{x: number, z: number}>} intersections
 * @param {number} x
 * @param {number} z
 * @returns {{x: number, z: number}|null}
 */
export function findNearestNode(intersections, x, z) {
  if (!intersections || intersections.length === 0) return null;
  let best = null;
  let minDstSq = Infinity;
  for (let i = 0; i < intersections.length; i++) {
    const node = intersections[i];
    const dx = node.x - x;
    const dz = node.z - z;
    const dstSq = dx * dx + dz * dz;
    if (dstSq < minDstSq) {
      minDstSq = dstSq;
      best = node;
    }
  }
  return best;
}

/**
 * Строит граф смежности перекрёстков (карта "x,z" -> массив соседних узлов).
 * Узлы считаются соединёнными дорогой, если расстояние Манхэттена |dx| + |dz| === 64.
 * Кэширует результат по ссылке на массив intersections.
 * @param {Array<{x: number, z: number}>} intersections
 * @returns {Map<string, Array<{x: number, z: number}>>}
 */
export function buildCarRoadGraph(intersections) {
  if (!intersections || intersections.length === 0) return new Map();
  if (intersections === _cachedIntersections && _cachedGraph) {
    return _cachedGraph;
  }

  const nodeMap = new Map();
  const adj = new Map();

  for (let i = 0; i < intersections.length; i++) {
    const isec = intersections[i];
    const key = isec.x + ',' + isec.z;
    nodeMap.set(key, isec);
    adj.set(key, []);
  }

  const offsets = [
    { dx: 64, dz: 0 },
    { dx: -64, dz: 0 },
    { dx: 0, dz: 64 },
    { dx: 0, dz: -64 },
  ];

  for (let i = 0; i < intersections.length; i++) {
    const isec = intersections[i];
    const key = isec.x + ',' + isec.z;
    const neighbors = adj.get(key);
    for (let o = 0; o < offsets.length; o++) {
      const neighborKey = (isec.x + offsets[o].dx) + ',' + (isec.z + offsets[o].dz);
      const neighbor = nodeMap.get(neighborKey);
      if (neighbor) {
        neighbors.push(neighbor);
      }
    }
  }

  _cachedIntersections = intersections;
  _cachedGraph = adj;
  return adj;
}

/**
 * Вычисляет общую длину ломаной маршрута.
 * @param {Array<{x: number, z: number}>} pts
 * @returns {number}
 */
export function routeLength(pts) {
  if (!pts || pts.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const dx = p2.x - p1.x;
    const dz = p2.z - p1.z;
    total += Math.hypot(dx, dz);
  }
  return total;
}

/**
 * Выполняет BFS-поиск кратчайшего пути между перекрёстками по графу дорог.
 * @private
 * @param {Map<string, Array<{x: number, z: number}>>} graph
 * @param {{x: number, z: number}} startNode
 * @param {{x: number, z: number}} endNode
 * @returns {Array<{x: number, z: number}>|null}
 */
function _bfsCarPath(graph, startNode, endNode) {
  const startKey = startNode.x + ',' + startNode.z;
  const endKey = endNode.x + ',' + endNode.z;
  if (startKey === endKey) {
    return [startNode];
  }

  _bfsQueue.length = 0;
  _bfsParent.clear();

  _bfsQueue.push(startNode);
  _bfsParent.set(startKey, null);

  let head = 0;
  let found = false;

  while (head < _bfsQueue.length) {
    const curr = _bfsQueue[head++];
    const currKey = curr.x + ',' + curr.z;
    if (currKey === endKey) {
      found = true;
      break;
    }

    const neighbors = graph.get(currKey);
    if (neighbors) {
      for (let i = 0; i < neighbors.length; i++) {
        const next = neighbors[i];
        const nextKey = next.x + ',' + next.z;
        if (!_bfsParent.has(nextKey)) {
          _bfsParent.set(nextKey, curr);
          _bfsQueue.push(next);
        }
      }
    }
  }

  if (!found) return null;

  const path = [];
  let curr = endNode;
  while (curr) {
    path.push(curr);
    const key = curr.x + ',' + curr.z;
    curr = _bfsParent.get(key);
  }
  path.reverse();
  return path;
}

/**
 * Ищет автомобильный маршрут от (fromX, fromZ) до (toX, toZ) по дорожной сети.
 * Включает точную начальную точку, путь по перекрёсткам и точную конечную точку.
 * @param {Array<{x: number, z: number}>} intersections
 * @param {Map<string, Array<{x: number, z: number}>>} graph
 * @param {number} fromX
 * @param {number} fromZ
 * @param {number} toX
 * @param {number} toZ
 * @returns {Array<{x: number, z: number}>|null}
 */
export function findCarRoute(intersections, graph, fromX, fromZ, toX, toZ) {
  if (!intersections || intersections.length === 0 || !graph) return null;
  const startNode = findNearestNode(intersections, fromX, fromZ);
  const endNode = findNearestNode(intersections, toX, toZ);
  if (!startNode || !endNode) return null;

  const nodePath = _bfsCarPath(graph, startNode, endNode);
  if (!nodePath) return null;

  const pts = [{ x: fromX, z: fromZ }];
  for (let i = 0; i < nodePath.length; i++) {
    const n = nodePath[i];
    const last = pts[pts.length - 1];
    if (Math.abs(last.x - n.x) > 0.01 || Math.abs(last.z - n.z) > 0.01) {
      pts.push({ x: n.x, z: n.z });
    }
  }
  const last = pts[pts.length - 1];
  if (Math.abs(last.x - toX) > 0.01 || Math.abs(last.z - toZ) > 0.01) {
    pts.push({ x: toX, z: toZ });
  }

  return pts;
}

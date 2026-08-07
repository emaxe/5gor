import { CFG } from './config.js';

const PG_PED_SIDE = CFG.HALF + CFG.SIDE / 2; // 8 — центр тротуара от оси дороги
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
          const x = r + side * PG_PED_SIDE;
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
          const z = r + side * PG_PED_SIDE;
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
      const nW = this._byKey.get((isec.x - PG_PED_SIDE) + ',' + isec.z);
      const nE = this._byKey.get((isec.x + PG_PED_SIDE) + ',' + isec.z);
      const nN = this._byKey.get(isec.x + ',' + (isec.z - PG_PED_SIDE));
      const nS = this._byKey.get(isec.x + ',' + (isec.z + PG_PED_SIDE));
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
        const a = this._byKey.get((r - PG_PED_SIDE) + ',' + zm);
        const b = this._byKey.get((r + PG_PED_SIDE) + ',' + zm);
        if (a && b) this._addEdge(a, b, 'jwalk', 3);
      }
    }
    for (const r of roadsZ) {
      for (let i = 0; i + 1 < roadsX.length; i++) {
        if (rng() >= 0.3) continue;
        const xm = (roadsX[i] + roadsX[i + 1]) / 2;
        const a = this._byKey.get(xm + ',' + (r - PG_PED_SIDE));
        const b = this._byKey.get(xm + ',' + (r + PG_PED_SIDE));
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

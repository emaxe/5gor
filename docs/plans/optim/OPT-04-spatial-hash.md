# OPT-04 — Ускорение `distToRoad()` и `isPositionValid()` на этапе генерации города

**Приоритет:** 🟢 Лёгкое (только build-time; в установившемся режиме эти функции не вызываются)
**Сложность:** Низкая–средняя
**Файлы:** `src/citygen.js`
**Ожидаемый прирост:** -60-80% времени `world.build()`. FPS во время вождения эта правка не трогает —
`distToRoad()`/`isPositionValid()` вызываются только при расстановке пропсов на старте, не в игровом цикле.

---

## Описание проблем

### Проблема A: `distToRoad()` — лишняя работа, но НЕ по вине алгоритма O(N)

```js
// citygen.js:82 — 18 итераций на каждый вызов
distToRoad(x, z) {
  let best = 1e9;
  for (const r of this.roadsV) {
    const dz = Math.max(0, Math.abs(z) - (256 + CFG.GRID_EXT)); // не зависит от r!
    best = Math.min(best, Math.hypot(x - r.c, dz));
  }
  for (const r of this.roadsH) {
    const dx = Math.max(0, Math.abs(x) - (256 + CFG.GRID_EXT)); // не зависит от r!
    best = Math.min(best, Math.hypot(z - r.c, dx));
  }
  return best;
}
```

`dz`/`dx` — инварианты циклов, но пересчитываются на каждой итерации. С сеткой в 9 дорог на ось
(`CFG.CELL=64`, `CFG.N=4`) это 18 вызовов `Math.hypot()` там, где на самом деле нужен один линейный
проход по константам. Вызывается для каждого дерева/фонаря/скамейки/знака — то есть ~500-800 раз
за один `build()`.

### Проблема B: `isPositionValid()` — O(N) по `propsAABB`, O(N²) суммарно

```js
// citygen.js:118 — propsAABB растёт до ~500 элементов
for (const p of this.propsAABB) {
  if (x > p.x0 - r && ...) return false;
}
```

Каждый новый объект проверяется против ВСЕХ предыдущих → O(N²) суммарно при генерации.
Это настоящая узкая часть — переходить на spatial hash здесь оправдано.

---

## Решение

### Шаг 1: Устранить инвариант цикла в `distToRoad()` — НЕ строить сетку

Первая редакция этого документа предлагала `Uint8Array`-сетку 150×150 с ячейкой 4 м и
полушириной запрета ±10 м (`dx ∈ [-2,2]` при `CELL=4`). От этого варианта отказались:
он **меняет геометрию расстановки** (сейчас порог 6.3 м, сетка дала бы ~10 м — деревья и
фонари встанут по-другому), а `isOnRoad()` без проверки границ индекса (`xi*N+zi` при `zi`
вне `[0,N)` попадает в соседнюю строку массива) даёт ложные "на дороге" на краях карты.

Правильное решение проще: `dz`/`dx` не зависят от `r`, их достаточно вычислить один раз
вне цикла — итог O(1) без изменения семантики и без риска несовпадения с прежним поведением:

```js
distToRoad(x, z) {
  let best = 1e9;
  const dzOuter = Math.max(0, Math.abs(z) - (256 + CFG.GRID_EXT)); // было внутри цикла — инвариант
  for (const r of this.roadsV) {
    best = Math.min(best, Math.hypot(x - r.c, dzOuter));
  }
  const dxOuter = Math.max(0, Math.abs(x) - (256 + CFG.GRID_EXT)); // было внутри цикла — инвариант
  for (const r of this.roadsH) {
    best = Math.min(best, Math.hypot(z - r.c, dxOuter));
  }
  return best;
}
```

Дороги регулярны (`roadsV`/`roadsH` — координаты кратны `CFG.CELL`), так что при желании можно
пойти дальше и найти ближайшую линию сетки аналитически (`Math.round((x - offset) / CFG.CELL)`)
без перебора вообще — но это уже не обязательно: 9+9 итераций без лишних `hypot`-вычислений
достаточно быстры, а риск отклониться от текущего поведения (полуширина 6.3 м, край сетки
±(256+36)) выше выигрыша.

### Шаг 2: Spatial hash для `propsAABB` (единственная часть, где алгоритм меняется)

```js
// В constructor:
this._propHash = new Map(); // ключ: `${cellX},${cellZ}` → [{aabb}]
this._propHashCell = 10;    // 10м ячейки

addPropAABB(aabb) {
  this.propsAABB.push(aabb);
  const cx0 = Math.floor(aabb.x0 / this._propHashCell);
  const cx1 = Math.floor(aabb.x1 / this._propHashCell);
  const cz0 = Math.floor(aabb.z0 / this._propHashCell);
  const cz1 = Math.floor(aabb.z1 / this._propHashCell);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const key = cx + ',' + cz;
      if (!this._propHash.has(key)) this._propHash.set(key, []);
      this._propHash.get(key).push(aabb);
    }
  }
}

_checkPropCollision(x, z, radius) {
  const cx = Math.floor(x / this._propHashCell);
  const cz = Math.floor(z / this._propHashCell);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const bucket = this._propHash.get((cx+dx) + ',' + (cz+dz));
      if (!bucket) continue;
      for (const p of bucket) {
        if (x > p.x0 - radius && x < p.x1 + radius &&
            z > p.z0 - radius && z < p.z1 + radius) return true;
      }
    }
  }
  return false;
}
```

### Шаг 3: Заменить перебор в `isPositionValid()`

```js
isPositionValid(x, z, radius = 0.8) {
  if (this.distToRoad(x, z) < 6.3) return false; // теперь без лишних hypot() — шаг 1

  for (const b of this.buildings) { /* без изменений */ }
  for (const c of this.circleColliders) { /* без изменений */ }

  // Было: for (const p of this.propsAABB) { ... }
  if (this._checkPropCollision(x, z, radius)) return false;

  return true;
}
```

---

## Чеклист

- [ ] В `distToRoad()` вынести `dz`/`dx` из циклов (инвариант не зависит от `r`) — без изменения семантики
- [ ] Убедиться, что новый `distToRoad()` даёт те же значения, что старый, на 1000 случайных точек (сравнение старого/нового результата)
- [ ] Добавить `_propHash: Map` и `_propHashCell = 10` в constructor
- [ ] Написать метод `addPropAABB(aabb)` с хешированием по ячейкам
- [ ] Заменить `this.propsAABB.push(...)` на `this.addPropAABB(...)` во всём `citygen.js`
- [ ] Написать `_checkPropCollision(x, z, r)` с lookup только по 9 соседним ячейкам
- [ ] Заменить O(N) перебор `propsAABB` в `isPositionValid()` на `_checkPropCollision()`
- [ ] Убедиться, что `distToRoad()` не переименован/не удалён — используется в других местах помимо `isPositionValid()` (проверить все вызовы в `citygen.js`)
- [ ] Замерить время `world.build()` до и после — это единственная метрика для этой правки, FPS в вождении она не меняет
- [ ] После правки выполнить `python3 build.py` — иначе изменения не попадут в `index.html`

---

## Связанные задачи
- OPT-00 — без измерения времени `build()` эту правку нечем подтвердить

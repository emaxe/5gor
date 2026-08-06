# OPT-09 — Здания: дедупликация материалов и сокращение draw calls

**Приоритет:** 🔴 Критично — вероятно наибольший одиночный эффект во всём плане
**Сложность:** Средняя
**Файлы:** `src/citygen.js`, `src/utils.js`
**Ожидаемый прирост:** сотни draw calls и сотни материалов убираются из сцены; после OPT-00 замерить `renderer.info.render.calls` до/после для точной цифры

---

## Описание проблемы

`_building()` (`citygen.js:495-528`) вызывается для каждого здания и на каждый вызов создаёт:

```js
// citygen.js:495-509 (упрощённо)
const winTex = makeWindowTexture(palette, cols, rows, lit); // ← ЭТА функция кеширует текстуру
const sideMat = new THREE.MeshLambertMaterial({ map: winTex });   // ← а материал вокруг неё — НЕТ
sideMat.emissiveMap = winTex;
sideMat.emissive = new THREE.Color(0xffffff);
sideMat.emissiveIntensity = 0.04;
this.windowMats.push(sideMat);
const roofC = new THREE.Color(choice(PALETTES[palette])).multiplyScalar(0.62);
const roofMat = new THREE.MeshLambertMaterial({ color: roofC });   // ← новый материал каждый раз
const bottomMat = new THREE.MeshLambertMaterial({ color: 0x555550 }); // ← новый материал каждый раз, хотя цвет всегда одинаковый
const mats = [sideMat, sideMat, roofMat, bottomMat, sideMat, sideMat];
const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, dep), mats); // ← multi-material Box = до 6 draw calls
```

`makeWindowTexture()` (`utils.js:70-88`) уже кеширует текстуру по ключу
`win_${palette}_${wIn}_${hIn}_${lit}` (`_texCache`, `utils.js:71`) — но материал, построенный
вокруг неё, кешу не подлежит и создаётся заново при каждом вызове, даже если ключ совпал.

### Масштаб

`_buildings()` (`citygen.js:465-489`): 8×8 = 64 блока, минус 4 спец-квартала (`blockSpecial()`)
→ 60 обычных блоков; на каждый — `d.dens + 1` зданий (`dens` от 2 до 4 в зависимости от района,
`config.js:134-141`). Итого **~150-230 зданий**. Каждое здание:
- 1 уникальный `sideMat` (даже если текстура под ним переиспользуется из кеша);
- 1 уникальный `roofMat`;
- 1 уникальный `bottomMat` (цвет константный — `0x555550` — но материал новый каждый раз);
- `Mesh` с 6-элементным массивом материалов → BoxGeometry рисуется группами по face-материалу,
  до 6 draw calls на здание вместо 1.

Итог: **до ~1500 draw calls и ~700 уникальных материалов** только на здания. Это почти наверняка
самая дорогая часть кадра в сцене — дороже, чем всё остальное содержимое плана вместе взятое.

---

## Решение (по возрастанию риска — можно остановиться после любого шага)

### Шаг 1: Кешировать материалы, а не только текстуры

```js
// utils.js или citygen.js — рядом с _texCache:
const _matCache = new Map();

function getWindowMaterial(palette, cols, rows, lit) {
  const key = `win_${palette}_${cols}_${rows}_${lit}`;
  if (_matCache.has(key)) return _matCache.get(key);
  const winTex = makeWindowTexture(palette, cols, rows, lit); // уже кешируется внутри
  const mat = new THREE.MeshLambertMaterial({ map: winTex });
  mat.emissiveMap = winTex;
  mat.emissive = new THREE.Color(0xffffff);
  mat.emissiveIntensity = 0.04;
  _matCache.set(key, mat);
  return mat;
}
```

`bottomMat` — константный цвет, вынести в один общий материал на весь мир (создать один раз в
`build()`, передавать во все вызовы `_building()`). `roofMat` — цвет зависит от `choice(PALETTES[palette])`,
но набор палитр конечен (`config.js:145`, `PALETTES`) — кешировать по ключу `roof_${palette}_${roofColorHex}`
аналогично `getWindowMaterial()`.

Побочный эффект: `windowMats` (используется в OPT-06 для ночной подсветки) схлопнется с
~230 записей до количества уникальных `(palette, cols, rows, lit)`-комбинаций — вероятно ~30-50.
Цикл `for (const m of this.windowMats)` в `update()` станет короче сам по себе.

### Шаг 2: Квантовать `cols`/`rows` для роста hit rate кеша

```js
// _building(): cols/rows сейчас непрерывны от размера здания —
// clamp(Math.round(w / 4.2), 2, 9) даёт уже дискретный диапазон 2-9, этого достаточно.
// Дополнительно можно квантовать rows с шагом 2 (round к чётному), чтобы сократить
// число уникальных текстурных/материальных вариантов ещё сильнее:
const rows = clamp(Math.round(h / 3.2 / 2) * 2, 2, 14);
```

Это не обязательно, но снижает число уникальных ключей в `_texCache`/`_matCache` и, как следствие,
число уникальных материалов после Шага 1.

### Шаг 3 (больший риск, делать после Шага 1-2 и с визуальной проверкой): слияние геометрии по блокам

`buildings[].mesh` — проверено, что снаружи `citygen.js` не читается: единственные внешние
потребители `world.buildings` — `player.js:317` и `ui.js:291` (оба используют только
`x0/z0/x1/z1/h`, не `.mesh`). Значит меши можно сливать без риска сломать логику коллизий/HUD.

Слить статичные здания **по блокам** (8×8=64 группы), а не глобально — чтобы не потерять
frustum culling для игрока, находящегося в одном районе города, пока рендерятся другие. В проекте
уже есть готовая утилита для слияния геометрии с разными материалами — `mergeColored()`
(`utils.js`, уже используется для деревьев и трамвая, `citygen.js:1017, 1063, 1068`). Использовать
тот же подход: собрать все `BoxGeometry` здания одного блока с одним материалом (после Шага 1
таких материалов немного) в одну геометрию через `mergeColored`/`BufferGeometryUtils.mergeGeometries`.

⚠️ Этот шаг ломает индивидуальный `castShadow`/анимацию отдельных зданий, если такая появится в
будущем — проверить, что сейчас у зданий нет per-mesh анимации (на момент проверки — нет,
`mesh.castShadow = true` ставится один раз при постройке и не меняется).

---

## Чеклист

- [ ] Добавить `_matCache: Map` (или переиспользовать подход `_texCache` из `utils.js`)
- [ ] Написать `getWindowMaterial(palette, cols, rows, lit)` с кешированием по составному ключу
- [ ] Вынести `bottomMat` в один общий материал на весь мир (создаётся один раз в `build()`)
- [ ] Кешировать `roofMat` по ключу `(palette, roofColorHex)`
- [ ] Заменить прямое создание `sideMat`/`roofMat`/`bottomMat` в `_building()` на вызовы кешей
- [ ] Проверить: `windowMats` не дублирует одну и ту же ссылку на материал много раз (использовать `Set` при пуше, если нужно), иначе OPT-06 всё равно будет проходить по длинному списку
- [ ] Замерить `renderer.info.memory.textures`/`.geometries` и `render.calls` до/после (через OPT-00)
- [ ] Опционально: квантовать `rows` с шагом 2 для роста hit rate кеша
- [ ] Опционально (Шаг 3): слить геометрию зданий по блокам через `mergeColored`, сохраняя per-block frustum culling
- [ ] Проверить визуально: здания выглядят так же (текстуры окон, цвет крыш, ночная подсветка) — дедупликация материалов не должна поменять внешний вид, только количество объектов
- [ ] Проверить: `castShadow` у зданий сохраняется после любых слияний геометрии
- [ ] После правки выполнить `python3 build.py` — иначе изменения не попадут в `index.html`

---

## Связанные задачи
- OPT-06 — эффект dirty-flag для `windowMats` уменьшится после дедупликации здесь; рекомендуемый порядок — сначала этот документ
- OPT-00 — без `renderer.info` нечем подтвердить масштаб выигрыша

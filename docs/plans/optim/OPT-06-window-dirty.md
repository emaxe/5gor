# OPT-06 — Окна зданий: dirty-flag вместо постоянного обновления

**Приоритет:** 🟢 Лёгкое (эффект сократится ещё сильнее после OPT-09, см. примечание в конце)
**Сложность:** Низкая
**Файлы:** `src/citygen.js`
**Ожидаемый прирост:** +1-2% CPU (постоянно, при текущем ~230 материалах в `windowMats`)

---

## Описание проблемы

Каждый кадр `world.update(dt, hour, weather)` обновляет `emissiveIntensity` у **всех** оконных
материалов:

```js
// citygen.js:1503
update(dt, hour, weather) {
  // ...
  const winTarget = night ? 0.85 : 0.04;
  this._winI = lerp(this._winI, winTarget, 0.03);
  for (const m of this.windowMats) m.emissiveIntensity = this._winI; // ← каждый кадр
}
```

При ~230 зданиях (`_buildings()` — 8×8 блоков минус спец-кварталы, `dens+1` зданий на блок) —
до 230 итераций записи в материал каждый кадр, даже когда `_winI` уже практически сошёлся к цели
и изменение неразличимо на глаз.

---

## Решение: пропускать обновление, когда цель уже достигнута

```js
// citygen.js, update():
const winTarget = night ? 0.85 : 0.04;
this._winI = this._winI === undefined ? 0.04 : this._winI;

// Обновляем GPU только если мы ещё не рядом с целевым значением.
// Порог применяется к РАССТОЯНИЮ ДО ЦЕЛИ, а не к величине шага lerp — это принципиально:
const atTarget = Math.abs(this._winI - winTarget) < 0.005;
if (!atTarget) {
  this._winI += (winTarget - this._winI) * 0.03;
  for (const m of this.windowMats) m.emissiveIntensity = this._winI;
}
```

⚠️ Первая редакция этого документа предлагала также альтернативный "шаг 1" с порогом,
применённым к разнице между *новым и старым* значением (`|newWinI - winI| > 0.005`), а не к
расстоянию до цели. Этот вариант убран — он ломает анимацию:

```js
// НЕ ДЕЛАТЬ ТАК:
if (Math.abs(newWinI - this._winI) > 0.005) { this._winI = newWinI; ... }
```

Шаг lerp равен `0.03 * (winTarget - this._winI)`. Как только `|winTarget - this._winI| < 0.167`,
сам шаг падает ниже порога `0.005` — и `_winI` **перестаёт обновляться навсегда**, застревая на
~68% пути к цели (например, 0.68 вместо 0.85 ночью). Единственный корректный вариант — сравнивать
с целью целиком, как в блоке выше.

### Аналогично для `roadMats` (мокрый асфальт)

```js
// citygen.js:1516
const wetTarget = weather === 'rain' ? 1.0 : 0.0;
const atWetTarget = Math.abs((this.wetness || 0) - wetTarget) < 0.002;
if (!atWetTarget) {
  this.wetness = lerp(this.wetness || 0, wetTarget, dt * 0.7);
  const roughness = lerp(0.82, 0.22, this.wetness);
  const metalness = lerp(0.05, 0.42, this.wetness);
  for (const m of this.roadMats) {
    m.roughness = roughness;
    m.metalness = metalness;
  }
}
```

### Паттерн, которому стоит следовать — он уже есть в этом же методе

Обновление светофоров в том же `update()` (`citygen.js:1524-1548`) уже реализует ровно такой
dirty-flag правильно: `lampsUpdated` выставляется только при `oldState !== l.state`, и
`instanceColor.needsUpdate` вызывается лишь тогда. Новый код для `windowMats`/`roadMats` должен
следовать этому же паттерну "порог до цели / реальное изменение", а не изобретать свой.

---

## Чеклист

- [ ] Добавить `atTarget`-флаг для `windowMats`: сравнивать `|_winI - winTarget|` с порогом 0.005, НЕ величину шага lerp
- [ ] Прекращать обновления, когда `atTarget === true`
- [ ] Аналогичный dirty-check для `roadMats` (roughness/metalness), порог 0.002 к цели
- [ ] Проверить: смена дня/ночи корректно анимирует яркость окон **до конца**, без застревания на промежуточном значении
- [ ] Проверить: мокрый асфальт корректно появляется/исчезает полностью, а не наполовину
- [ ] Убедиться что `m.needsUpdate` не нужен для `MeshLambertMaterial`/`MeshStandardMaterial` при изменении `emissiveIntensity`/`roughness`/`metalness` (в THREE.js ≥r150 — не нужен для этих числовых полей)
- [ ] Замерить кол-во draw calls до/после в Stats.js или DevTools
- [ ] После правки выполнить `python3 build.py` — иначе изменения не попадут в `index.html`

---

## Примечание: эффект этой оптимизации сократится после OPT-09

OPT-09 (дедупликация материалов зданий) схлопывает `windowMats` с текущих ~230 записей до
ожидаемых ~50 (материал стен сейчас создаётся заново на каждое здание, хотя текстура под ним уже
кешируется). Если OPT-09 будет сделан раньше — цикл `for (const m of this.windowMats)` станет
короче сам по себе, и выигрыш от dirty-flag здесь станет ещё менее заметным. Рекомендуемый
порядок: сначала OPT-09, потом (опционально) эта правка.

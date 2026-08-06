# OPT-00 — Измерительная обвязка (делать первым)

**Приоритет:** 🔴 Критично — без этого остальные пункты плана нечем подтвердить
**Сложность:** Низкая
**Файлы:** `src/game.js`, `src/ui.js` (или новый `src/debug.js`)
**Ожидаемый прирост:** нет (это инструмент измерения, не оптимизация)

---

## Описание проблемы

README плана приводит точные цифры "до": ~35-45 FPS, ~8мс CPU/кадр, ~15 GC-пауз за 5 минут,
~200мс `world.build()`. В текущем коде **нет ничего**, что эти величины измеряет — единственный
вызов `performance.now()` в проекте (`orders.js:362`) считает время выполнения заказа, а не
производительность рендера. Все проценты и оценки в плане (`+5% FPS`, `-70% времени генерации`
и т.п.) — оценки на глаз, и без измерения их нельзя ни подтвердить, ни опровергнуть после правок.

---

## Решение: dev-оверлей по флагу

### Шаг 1: Query-параметр или клавиша для включения

```js
// game.js, конструктор или _initScene():
this._debugOverlay = new URLSearchParams(location.search).has('debug');
```

### Шаг 2: Счётчик FPS и CPU-времени кадра

```js
// _loop():
_loop() {
  requestAnimationFrame(() => this._loop());
  const dt = Math.min(this.clock ? this.clock.getDelta() : 0.016, 0.05);
  if (!this.clock) { this.clock = new THREE.Clock(); return; }

  const t0 = this._debugOverlay ? performance.now() : 0;
  try { this._update(dt); } catch (e) { showError(e); }
  this.renderer.render(this.scene, this.camera);
  if (this._debugOverlay) this._updateDebugOverlay(dt, performance.now() - t0);
}

_updateDebugOverlay(dt, cpuMs) {
  this._dbgAccum = (this._dbgAccum || 0) + dt;
  this._dbgFrames = (this._dbgFrames || 0) + 1;
  if (this._dbgAccum < 0.5) return; // обновляем раз в полсекунды, а не каждый кадр
  const fps = Math.round(this._dbgFrames / this._dbgAccum);
  const info = this.renderer.info;
  if (!this._dbgEl) {
    this._dbgEl = document.createElement('div');
    this._dbgEl.style.cssText = 'position:fixed;top:4px;left:4px;z-index:9999;background:#000a;color:#7ee787;font:12px monospace;padding:6px 8px;pointer-events:none;white-space:pre;';
    document.body.appendChild(this._dbgEl);
  }
  this._dbgEl.textContent =
    `FPS: ${fps}  CPU: ${cpuMs.toFixed(1)}ms\n` +
    `calls: ${info.render.calls}  tris: ${info.render.triangles}\n` +
    `tex: ${info.memory.textures}  geo: ${info.memory.geometries}`;
  this._dbgAccum = 0; this._dbgFrames = 0;
}
```

### Шаг 3: Замер `world.build()`

```js
// game.js, при создании мира:
const t0 = performance.now();
this.world.build();
if (this._debugOverlay) console.log(`world.build(): ${(performance.now() - t0).toFixed(1)}ms`);
```

### Шаг 4 (опционально): GC-паузы

Точные GC-паузы недоступны из обычного JS API без Chrome DevTools Protocol — для этого пункта
README достаточно вручную открыть вкладку Performance/Memory в DevTools и посчитать `Minor GC`/
`Major GC` события за фиксированный отрезок игры (например, 2 минуты активных диалогов), не
пытаться автоматизировать в коде игры.

---

## Чеклист

- [ ] Добавить флаг `_debugOverlay` (query-параметр `?debug` или клавиша в `InputManager`)
- [ ] Вывести FPS (усреднённый за 0.5с, не мгновенный per-frame) и CPU время кадра
- [ ] Вывести `renderer.info.render.calls` / `.triangles` и `renderer.info.memory.textures` / `.geometries`
- [ ] Замерить и залогировать время `world.build()`
- [ ] Использовать вкладку Performance/Memory DevTools для GC-пауз (не автоматизировать в коде)
- [ ] Снять baseline **до** любых других правок из этого плана — на том же сценарии (одна и та же карта, погода `rain`, одна и та же камера) для честного сравнения "до/после"
- [ ] Зафиксировать baseline в README вместо текущих оценочных цифр
- [ ] После правки выполнить `python3 build.py` — иначе изменения не попадут в `index.html`

---

## Связанные задачи
- Все остальные OPT-* пункты плана — их "Ожидаемый прирост" нужно пересчитать по факту после снятия baseline здесь

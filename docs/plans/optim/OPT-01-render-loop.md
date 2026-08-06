# OPT-01 — Рендер-цикл: двойной render() и лишние вызовы

**Приоритет:** 🔴 Критично  
**Сложность:** Низкая  
**Файлы:** `src/game.js`  
**Ожидаемый прирост:** +5% FPS (постоянно)

---

## Описание проблемы

В `game.js` сцена рендерится **дважды** в одном кадре при состояниях `pause`, `map`, `settings`, `shiftend`:

```js
// _update() — ветка для паузы/карты/настроек (game.js ~642)
if (st === 'pause' || ...) {
  this.renderer.render(this.scene, this.camera); // ← ЛИШНИЙ
}
// ...
// _loop() — вызывается всегда после _update()
this.renderer.render(this.scene, this.camera); // ← ОСНОВНОЙ
```

Итого в состоянии паузы: **2× draw calls, 2× GPU flush**, FPS/2 у рендера.

---

## Решение

### Шаг 1: Убрать дублирующий render() из _update()

```js
// БЫЛО:
if (st === 'pause' || st === 'map' || st === 'settings' || st === 'shiftend') {
  this.renderer.render(this.scene, this.camera); // удалить эту строку
  return;
}

// СТАЛО:
if (st === 'pause' || st === 'map' || st === 'settings' || st === 'shiftend') {
  return; // render вызовется один раз в _loop()
}
```

### Шаг 2: Троттлинг рендера на статичных экранах (не полный skip)

⚠️ Ранее здесь предлагался полный пропуск `render()` через `input.hasAnyInput()`. От этого варианта отказались:
`this.renderer` создан без `preserveDrawingBuffer` (`_initRenderer()`), и на части браузеров/композиторов
пропущенный кадр покажет очищенный или "грязный" буфер под DOM-оверлеем паузы. Кроме того,
`input.hasAnyInput()` не существует, а `this.keys` в `InputManager` — это `Set` с клавишами клавиатуры,
не покрывающий мышь/тач-джойстик (ложные "нет ввода" на мобильных).

Вместо skip — троттлинг: рендерим и на паузе/карте/настройках, но не 60, а ~15 раз в секунду.
Экономия GPU почти та же, а риска чёрного/мусорного кадра нет:

```js
// _loop():
_loop() {
  requestAnimationFrame(() => this._loop());
  const dt = Math.min(this.clock ? this.clock.getDelta() : 0.016, 0.05);
  if (!this.clock) { this.clock = new THREE.Clock(); return; }
  try { this._update(dt); } catch (e) { showError(e); }

  const throttled = this._renderThrottle && this._renderThrottle > 0;
  if (throttled) {
    this._renderAccum = (this._renderAccum || 0) + dt;
    if (this._renderAccum < 1 / 15) return; // ждём следующего "тика" на статичных экранах
    this._renderAccum = 0;
  }
  this.renderer.render(this.scene, this.camera);
}

// _update(), в ветке пауза/карта/настройки/итоги:
if (st === 'pause' || st === 'map' || st === 'settings' || st === 'shiftend') {
  this._renderThrottle = 1;
  return; // render теперь вызывается один раз в _loop(), с троттлингом
}
this._renderThrottle = 0;
```

---

## Чеклист

- [ ] Найти дублирующий `this.renderer.render()` в `_update()` (~строка 642)
- [ ] Удалить лишний вызов render в ветках паузы/карты/настроек
- [ ] Добавить троттлинг (~15 Гц) через `_renderThrottle`/`_renderAccum` в `_loop()` — НЕ полный skip
- [ ] Проверить: на `driving` всегда рендерим каждый кадр (`_renderThrottle = 0`)
- [ ] Протестировать переходы между состояниями (menu → driving → pause) — не должно быть чёрных/мусорных кадров при входе в паузу
- [ ] Замерить FPS в Chrome DevTools до и после
- [ ] После правки выполнить `python3 build.py` — иначе изменения не попадут в `index.html`

---

## Связанные задачи
- OPT-02 (тени) — shadow map тоже тратится на паузе

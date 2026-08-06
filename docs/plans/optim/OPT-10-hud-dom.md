# OPT-10 — HUD: кеш DOM-ссылок и троттлинг обновления

**Приоритет:** 🟡 Умеренно — эффект больше, чем у OPT-05 и OPT-06 вместе
**Сложность:** Низкая
**Файлы:** `src/ui.js`, `src/game.js`
**Ожидаемый прирост:** устраняет ~20 `getElementById` + ~15 записей в DOM каждый кадр (60 Гц → большинство значений не менялось)

---

## Описание проблемы

```js
// ui.js:14
this.$ = (id) => document.getElementById(id); // без кеша — каждый вызов ищет элемент в DOM заново
```

`updateHud()` (`ui.js:146-196`) вызывается из `_drive()` (`game.js:711`) **каждый кадр** и делает
порядка 20 обращений к `this.$(...)` плюс ~15 записей в `textContent`/`style.width`/
`style.transform`/`classList`. Подавляющее большинство этих значений не меняется от кадра к
кадру: `money` меняется при завершении заказа, `rating`/`day`/`clock` — раз в игровые секунды,
`fuel-bar` и `dmg-bar` — плавно, но с шагом, неразличимым 60 раз в секунду.

`renderMinimap()` (`ui.js:201-263`), вызываемый оттуда же (`game.js:712`), рассмотрен отдельно
в OPT-11 — это canvas-перерисовка, а не DOM, у неё своя стоимость.

---

## Решение

### Шаг 1: Закешировать ссылки на DOM-элементы один раз

```js
// ui.js, конструктор UIManager:
constructor(...) {
  // ...
  this._els = {};
  for (const id of [
    'money', 'rating', 'clock', 'day', 'speed-val', 'fuel-bar', 'dmg-bar', 'dirt-tip',
    'order-card', 'order-title', 'order-desc', 'order-timer', 'order-pay',
    'nav-arrow-wrap', 'nav-arrow', 'nav-dist',
  ]) this._els[id] = document.getElementById(id);
}

// Заменить this.$(id) на this._els[id] внутри updateHud() —
// этот метод уже используется и в других местах (showScreen, showHud), их не трогать,
// либо расширить кеш на все используемые id.
```

### Шаг 2: Не писать в DOM, если значение не изменилось

```js
// updateHud(), пример для 'money' — повторить для остальных полей:
_setText(el, text) {
  if (el.textContent !== text) el.textContent = text; // сравнение строк дешевле лишней DOM-записи
}

// использование:
this._setText(this._els.money, fmtMoney(gameState.money));
```

Браузер всё равно перерисует layout только при реальном изменении текста, но избегание записи
в DOM когда строка идентична убирает invalidation в Style/Layout recalculation.

### Шаг 3: Троттлинг всего `updateHud()` до ~12-15 Гц

Более простая альтернатива шагу 2 (можно сделать вместо него или вместе):

```js
// game.js, _drive():
this._hudAccum = (this._hudAccum || 0) + dt;
if (this._hudAccum >= 1 / 15) {
  this._hudAccum = 0;
  this.ui.updateHud(this.player, this, this.orders, this.hour, this.chaseCam, this.world);
}
```

⚠️ Таймер заказа (`order-timer`, отсчёт в секундах) и стрелка-навигатор всё ещё будут визуально
плавными на 15 Гц — глазу этого достаточно для текста и цифр. Не троттлить сам игровой цикл
(`_drive()`), только вызов `updateHud()`.

---

## Чеклист

- [ ] Закешировать все id, используемые в `updateHud()`, в `this._els` в конструкторе `UIManager`
- [ ] Заменить `this.$(id)` на `this._els[id]` внутри `updateHud()`
- [ ] Добавить guard "не писать, если значение не изменилось" хотя бы для `money`/`rating`/`clock`/`day` (меняются реже остальных)
- [ ] Троттлинг вызова `updateHud()` до ~15 Гц в `_drive()`
- [ ] Проверить: таймер заказа (`order-timer`) визуально не "заикается" при троттлинге
- [ ] Проверить: стрелка-навигатор (`nav-arrow`) поворачивается плавно на глаз при 15 Гц
- [ ] Проверить: полосы топлива/повреждений (`fuel-bar`, `dmg-bar`) обновляются без видимого лага
- [ ] Замерить (через OPT-00) CPU время кадра до/после
- [ ] После правки выполнить `python3 build.py` — иначе изменения не попадут в `index.html`

---

## Связанные задачи
- OPT-11 — тот же вызывающий код (`game.js:711-712`), но для canvas-миникарты, а не DOM
- OPT-00 — нужен для честного замера "до/после"

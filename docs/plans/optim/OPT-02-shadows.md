# OPT-02 — Shadow Map: обновлять по требованию, не каждый кадр

**Приоритет:** 🔴 Критично  
**Сложность:** Низкая  
**Файлы:** `src/game.js`  
**Ожидаемый прирост:** +5-10% FPS при `quality=high`

---

## Описание проблемы

THREE.js по умолчанию рендерит shadow map **каждый кадр**. В 5gor солнце (`DirectionalLight`) двигается очень медленно — раз в несколько секунд игрового времени. Тем не менее тень пересчитывается 60 раз в секунду:

```js
// game.js:95-96, 114-118
this.sun.castShadow = CFG.quality === 'high';
this.sun.shadow.mapSize.set(1024, 1024);
// ... каждый кадр shadow map рендерится заново
```

Shadow map 1024×1024 = 4MB текстура, перезаписывается 60 раз в секунду.

---

## Решение

### Шаг 1: Отключить автоматическое обновление теней

```js
// src/game.js, _initRenderer():
this.renderer.shadowMap.enabled = CFG.quality === 'high';
this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
this.renderer.shadowMap.autoUpdate = false; // ← добавить
```

### Шаг 2: Принудительно обновлять тени при изменении позиции солнца

```js
// src/game.js, _updateTime():
const newSunY = Math.max(6, 90 * dayF + 12);
const sunMoved = Math.abs(newSunY - (this._lastSunY || 0)) > 0.5;
if (sunMoved) {
  this._lastSunY = newSunY;
  if (this.renderer.shadowMap.enabled) {
    this.renderer.shadowMap.needsUpdate = true;
  }
}
```

### Шаг 3: Обновлять при смене погоды

```js
setWeather(w) {
  this.weather = w;
  if (this.renderer.shadowMap.enabled) {
    this.renderer.shadowMap.needsUpdate = true;
  }
}
```

### Шаг 4: Уменьшить разрешение shadow map для medium quality

```js
// _initScene():
const shadowRes = CFG.quality === 'high' ? 1024 : 512;
this.sun.shadow.mapSize.set(shadowRes, shadowRes);
```

### Шаг 5: Не потерять первый кадр

С `autoUpdate = false` карта теней рендерится только когда явно выставлен `needsUpdate = true`.
Если этого не сделать сразу после старта — после `world.build()` и после каждого включения
`shadowMap.enabled` — тени останутся пустыми до первого движения солнца:

```js
// после world.build() и в setQuality() при переходе enabled: false → true:
if (this.renderer.shadowMap.enabled) this.renderer.shadowMap.needsUpdate = true;
```

### Шаг 6: Учесть `setQuality()` — тени переключаются не только в `_initScene()`

`game.js` (`setQuality(q)`) уже переключает `shadowMap.enabled` и `sun.castShadow` в рантайме
(смена качества в настройках), но не трогает `mapSize`. Если оставить это без внимания —
после смены качества на лету разрешение карты теней останется от предыдущего запуска:

```js
setQuality(q) {
  CFG.quality = q;
  this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q === 'high' ? 1.75 : 1.25));
  this.renderer.shadowMap.enabled = q === 'high';
  this.sun.castShadow = q === 'high';
  const shadowRes = q === 'high' ? 1024 : 512;
  this.sun.shadow.mapSize.set(shadowRes, shadowRes);
  this.sun.shadow.map?.dispose(); // старая RT-текстура должна быть освобождена при смене размера
  this.sun.shadow.map = null;
  if (this.renderer.shadowMap.enabled) this.renderer.shadowMap.needsUpdate = true;
  this.ui.toast('Качество: ' + (q === 'high' ? 'высокое' : 'низкое'), '#7ee787');
}
```

### Шаг 7: Солнце движется не только по Y

`_updateTime()` также двигает солнце по Z: `this.sun.position.set(60, sunY, 40 - 60 * (1 - dayF))`.
Отслеживать только `sunY` (как в шаге 2) недостаточно — Z за цикл суток меняется на 60 единиц, и
если `sunY` в какой-то момент почти не меняется, а `dayF` продолжает идти, тень не обновится.
Проще и надёжнее сравнивать `dayF` целиком, а не только производную от него `sunY`:

```js
const sunMoved = Math.abs(dayF - (this._lastSunDayF ?? -1)) > 0.01;
if (sunMoved) {
  this._lastSunDayF = dayF;
  if (this.renderer.shadowMap.enabled) this.renderer.shadowMap.needsUpdate = true;
}
```

---

## Чеклист

- [ ] Добавить `renderer.shadowMap.autoUpdate = false` в `_initRenderer()`
- [ ] Добавить трекинг `this._lastSunDayF` в `_updateTime()` (не только Y — сверять `dayF`, т.к. солнце движется и по Z)
- [ ] Реализовать логику `needsUpdate = true` при изменении `dayF` >0.01
- [ ] Добавить `needsUpdate = true` при смене погоды
- [ ] Добавить `needsUpdate = true` сразу после `world.build()` — иначе первый кадр без теней
- [ ] Обновить `setQuality()`: пересчитать `mapSize`, `dispose()` старого `shadow.map`, выставить `needsUpdate = true` при включении теней на лету
- [ ] Настроить shadow map resolution: 1024 (high), 512 (medium)
- [ ] Протестировать: тени корректно обновляются при рассвете/закате
- [ ] Протестировать: тени корректно обновляются при дожде (wetness меняет reflections)
- [ ] Протестировать: смена качества high↔medium в настройках во время игры не оставляет тени пустыми/некорректного размера
- [ ] Замерить FPS до/после на `quality=high`
- [ ] После правки выполнить `python3 build.py` — иначе изменения не попадут в `index.html`

---

## Связанные задачи
- OPT-01 — при паузе shadow map вообще не нужно обновлять
- OPT-07 — уменьшение far plane сократит shadow cascade объём

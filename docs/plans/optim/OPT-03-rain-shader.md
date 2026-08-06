# OPT-03 — Дождь: перенос анимации частиц в GPU (ShaderMaterial)

**Приоритет:** 🔴 Критично при дожде  
**Сложность:** Средняя  
**Файлы:** `src/game.js`  
**Ожидаемый прирост:** +4-6% FPS при активном дожде; CPU time частиц → ~0

---

## Описание проблемы

Каждый кадр JS пересчитывает позиции 1200 капель дождя и отправляет Float32Array (14.4 KB) на GPU:

```js
// game.js:562-577 — выполняется ~60 раз/сек
const arr = this.rain.geometry.attributes.position.array;
const fallSpeed = 38 * dt;
for (let i = 0; i < 1200; i++) {
  arr[i * 3] += windX;
  arr[i * 3 + 1] -= fallSpeed;  // гравитация
  arr[i * 3 + 2] += windZ;
  if (arr[i * 3 + 1] < 0) { /* reset */ }
}
this.rain.geometry.attributes.position.needsUpdate = true; // GPU upload
```

Проблемы:
1. CPU цикл 1200 итераций каждый кадр
2. `needsUpdate = true` → `gl.bufferData()` — 14.4 KB передача GPU
3. При дожде эффект не зависит от камеры (фиксированный bbox 220×55×220)

---

## Решение: ShaderMaterial + uTime uniform

### Шаг 1: Создать статичный буфер с "seed" данными

```js
// game.js, _initScene():
const RAIN_COUNT = 1200;
const rainGeo = new THREE.BufferGeometry();

// Храним начальные случайные позиции (константа, не меняется)
const rainSeeds = new Float32Array(RAIN_COUNT * 3);
for (let i = 0; i < RAIN_COUNT; i++) {
  rainSeeds[i * 3]     = (Math.random() - 0.5) * 220;  // base X
  rainSeeds[i * 3 + 1] = Math.random();                  // phase [0..1]
  rainSeeds[i * 3 + 2] = (Math.random() - 0.5) * 220;  // base Z
}
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainSeeds, 3));
```

### Шаг 2: Написать вершинный шейдер

⚠️ Ниже — исправленная версия. У первой редакции этого шейдера было четыре дефекта, каждый
достаточен чтобы сломать эффект при буквальном исполнении — см. разбор после сниппета.

```glsl
// RAIN_VERT — вставить в game.js как строку:
uniform float uTime;
uniform float uFallSpeed;   // м/с, ЕДИНИЦЫ КАК В СТАРОМ КОДЕ: 38.0, а не 38/uHeight
uniform float uWindX;
uniform float uWindZ;
uniform float uHeight;
uniform float uSize;        // мировой радиус капли (был 0.3 у PointsMaterial)
uniform float uScale;       // калибровочный коэффициент перспективного attenuation

// НЕ объявлять `attribute vec3 position` — Three.js уже инжектит его в ShaderMaterial;
// повторное объявление ловит ошибку компиляции GLSL "redefinition".
// position.x = baseX, position.y = phase[0..1], position.z = baseZ (тот же смысл, что в seed-буфере)

void main() {
  float t = mod(uTime * uFallSpeed + position.y * uHeight, uHeight);
  float y = uHeight - t;                    // падение сверху вниз, y ∈ [0, uHeight)
  // Снос ветром считаем от прогресса падения ЭТОЙ капли (t), а не от глобального uTime —
  // иначе все капли сносятся синхронно и разом телепортируются на 220 при переполнении mod().
  float fallProgress = t / uFallSpeed;      // время с момента последнего "сброса" этой капли, сек
  float x = position.x + fallProgress * uWindX;
  float z = position.z + fallProgress * uWindZ;

  vec4 mvPosition = modelViewMatrix * vec4(x, y, z, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // Мировой размер точки с перспективным attenuation — как у THREE.PointsMaterial({size, sizeAttenuation: true}),
  // который эффект заменяет. gl_PointSize = const в пикселях (как было в первой редакции) даст
  // капли одинакового размера независимо от расстояния — визуальная регрессия.
  gl_PointSize = uSize * (uScale / -mvPosition.z);
}
```

### Шаг 3: Создать ShaderMaterial

```js
this.rainUniforms = {
  uTime:      { value: 0 },
  uFallSpeed: { value: 38.0 },  // м/с — как в исходном CPU-цикле (game.js:584), НЕ 38/55
  uWindX:     { value: -4.0 },
  uWindZ:     { value: -2.0 },
  uHeight:    { value: 55.0 },
  uSize:      { value: 0.3 },   // мировой размер, как у текущего PointsMaterial({ size: 0.3 })
  uScale:     { value: window.innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(62) / 2)) },
  uOpacity:   { value: 0.65 },
};
const rainMat = new THREE.ShaderMaterial({
  uniforms: this.rainUniforms,
  vertexShader: RAIN_VERT,
  fragmentShader: `
    uniform float uOpacity;
    void main() {
      gl_FragColor = vec4(0.58, 0.72, 0.88, uOpacity);
    }
  `,
  transparent: true,
  depthWrite: false,
});
this.rain = new THREE.Points(rainGeo, rainMat);
```

`uScale` привязан к текущему FOV камеры (62°, `game.js:107`) и высоте канваса — пересчитать
в обработчике `resize`, иначе капли будут неверного размера после ресайза окна.

### Шаг 4: Обновлять только uTime — но сохранить привязку к камере

```js
// game.js, _drive() / _updateTime():
// БЫЛО: цикл 1200 итераций + needsUpdate
// СТАЛО:
if (this.rain.visible) {
  this.rainUniforms.uTime.value += dt;
  this.rainUniforms.uOpacity.value = 0.65 * this._rainFactor;
  // ВАЖНО: эта строка была внутри удаляемого CPU-блока (game.js:598) и легко теряется
  // при переносе — без неё дождь перестанет следовать за камерой и останется в точке спавна:
  this.rain.position.set(this.chaseCam.position.x, 0, this.chaseCam.position.z);
}
```

---

## Чеклист

- [ ] Написать константы `RAIN_VERT` и `RAIN_FRAG` (строки шейдеров) в `game.js` — без повторного `attribute vec3 position`
- [ ] Заменить `BufferAttribute` с динамическими позициями на статичный seed-буфер
- [ ] Создать `ShaderMaterial` с uniforms `uTime, uFallSpeed(=38.0), uWindX, uWindZ, uHeight, uSize, uScale, uOpacity`
- [ ] Проверить снос ветром привязан к `fallProgress` капли, а не к глобальному `uTime` (иначе синхронный снос + телепорт всего поля)
- [ ] Реализовать `gl_PointSize` с перспективным attenuation (`uSize * uScale / -mvPosition.z`), не константу
- [ ] Пересчитывать `uScale` в обработчике `resize` (зависит от `window.innerHeight` и FOV камеры)
- [ ] Удалить CPU-цикл обновления позиций в `_drive()` / `_updateTime()`
- [ ] Заменить на `this.rainUniforms.uTime.value += dt`
- [ ] Сохранить `this.rain.position.set(this.chaseCam.position.x, 0, this.chaseCam.position.z)` — она была внутри удаляемого блока
- [ ] Убедиться что `this.rain.frustumCulled = false` сохранён
- [ ] Проверить: дождь виден при `weather='rain'`, невидим при clear/fog
- [ ] Проверить: дождь движется правильно (сверху вниз, с ветром влево), капли того же визуального размера, что до правки
- [ ] Протестировать на мобильных браузерах (WebGL 1 совместимость)
- [ ] Замерить CPU time до/после в Performance вкладке DevTools
- [ ] После правки выполнить `python3 build.py` — иначе изменения не попадут в `index.html`

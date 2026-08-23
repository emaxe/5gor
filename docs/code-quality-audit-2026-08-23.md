# Аудит качества кода 5GOR

## Критично (баги)

1. **game.js:372 + orders.js:723-737 — штраф VIP −100 ₽ не списывается.** `orders.onCrash(d.impact)` возвращает `-100`, но вызывающий код игнорирует возвращаемое значение. Игроку показывается тост «VIP-клиент в шоке и ушёл. -100 ₽», деньги не списываются. Фикс: `const penalty = this.orders.onCrash(d.impact); if (penalty) this.addMoney(penalty);`

2. **orders.js:661 — высаженный пешеход ставится на y=0.** `pas.mesh.position.set(drop.x + offsetSide, 0, ...)` — на рельефе Машука (туры к башне z=-448, Эолова арфа) пешеход тонет в горке/висит в воздухе; апдейт `_walkers` правит только x/z. Сравни с `_placePassenger` (строка 346), где используется `heightAt`. Фикс: ставить y из `world.heightAt`.

3. **skidmarks.js — файл без единого импорта, но использует `CFG.*` (строки 25, 73, 77, 103, 105).** Работает только потому, что build.py склеивает всё в global scope. Аналогично **orders.js:581** использует `clamp` без импорта, **game.js:333** использует `SkidMarks` без импорта. Любой переход на нативные ESM/строгий бандлер — ReferenceError. Фикс: добавить импорты.

4. **game.js:312 — присваивание импортированной константе**: `WORLD_INTERSECTIONS = this.world.intersections` (объявлена как `export let` в traffic.js:718). В ESM — SyntaxError; живёт только за счёт regex-бандлера. Фикс: сеттер `traffic.setWorldIntersections(list)` или чтение `world.intersections` напрямую.

5. **peds.js:2099 / orders.js — утечка GPU-памяти.** `buildPedMesh()` строит уникальные геометрии на каждого пешехода (utils.js:554+), но `orders._removePassenger/reset/fail` и `playerped.dispose()` (playerped.js:495) удаляют меш из сцены **без `geometry.dispose()`**. Каждый проваленный заказ и каждый цикл выйти/сесть из машины утекает ~4-8 BufferGeometry. Фикс: traverse + dispose по образцу `player._disposeGroup` (player.js:180).

## Производительность (hot-path)

1. **traffic.js:update (315-576) — O(n²)+O(n×m) каждый кадр**: вложенные переборы машин-в-полосе (380), спецтранспорта сзади (367), все пешеходы на каждую машину (390-436, 441-449), плюс линейный `_nearestIntersection` (579, ~81 перекрёстков × 2 вызова на машину) и `_lightAhead` (675) по всем светофорам. При CFG.trafficCount=14 сейчас терпимо, но это главный тормоз при росте плотности (gfx-пресеты дают ×1). Рекомендация: бакетизация по `(axis, coord)` для машин/пешеходов (они уже имеют эти поля!), перекрёстки — индексом `round(pos/CELL)` вместо перебора.

2. **peds.js:1603-1605 (`_avoidStatic`) — аллокация массива `ordered` каждый кадр на каждого ближнего/активного пешехода.** Явное нарушение собственного zero-alloc-правила (см. эталон pedavoid.js:7). Фикс: два константных массива уровня модуля.

3. **game.js:_updateInteract/_updateWalkInteract (1806-1858, 1753-1804) — новые `{label, cb: () => ...}` и строки каждые 60 FPS.** Это ещё и ломает dirty-check в `ui.setInteract` (ui.js:714): `cb` никогда не равен прошлому → `btn.textContent` пишется в DOM 60 раз/сек пока подсказка висит. Фикс: пересобирать interact только при смене состояния, кэшировать пары label/cb.

4. **game.js — покадровые аллокации**: `_updateTime` возвращает `{nf, dayF, w}` каждый кадр (1163), используется только `.w`; литерал-объект в `audio.updateVehicle({...})` (1348-1358); замыкание в `requestAnimationFrame(() => ...)` (1168). Фикс: скалярные поля/переиспользуемый объект.

5. **citygen.js:update (2944-3049)**: `new THREE.Color()` (2975) и три `new THREE.Vector3` + массив `segLens` в `_cablePointAt` (3015, 3034, 3052-3072) — каждый кадр, всегда. Фикс: модульные temps, предрасчитать сегменты троса один раз.

6. **input.js:114 — `document.getElementById('btn-hb')` каждый кадр** в `update()`. Кэшировать в конструкторе (на десктопе элемент скрыт, но поиск всё равно идёт).

7. **Мелочи**: `ui.getTouchInput()` создаёт объект на вызов (ui.js:230, вызов 2×/кадр); строковые ключи spatial hash `cx + ',' + cz` в циклах коллизий (player.js:346/366, peds.js:1546, police.js:87 — 50+ конкатенаций/кадр; числовой ключ `(cx+512)*1024+(cz+512)` дешевле); двойная интеграция скорости у поворачивающих машин трафика (traffic.js:529-531 и повторно 554-556); eventbus.js:45 — `list.slice()` на каждый emit.

## Мёртвый код (подтверждено grep'ом)

| Где | Что |
|---|---|
| config.js:119-122 | `urgentMult, vipMult, groupMult, touristMult` — дублируют `ORDER_META.mult`, не читаются |
| config.js:134 | `ratingFail.crash`, `.vipLeave`, `.pedPunch` — используются только `hitPed`, `failOrder` |
| config.js:103,165 | `CFG.N`, `CFG.pedPunchKnockSpeed` — не читаются |
| config.js:332 | `TUNING.spoiler` — ключ не используется |
| config.js:347-357, 366-370 | поля `desc` у LANDMARKS, `name`/`rain` у WEATHER_DEFS — не читаются |
| main.js:2 | импорт `utilShowError` не используется |
| game.js:18 | импорты `DISPATCHER_BRIEFS`, `DRIVER_DAY_NOTES` не используются (только геттеры) |
| game.js:452-455 | пустой слушатель `achievement:unlocked` |
| upgrades.js:53-56 | метод `colorHex()` не вызывается |
| upgrades.js:115-124 | `newGameState()`: поля `stats/playerPos/fuel/damage` не потребляются |
| orders.js:739-741 | метод `markerPositions()` не вызывается |
| orders.js:763-765 | тройной алиас класса: `Orders`/`OrdersManager`/`PassengerManager`; экспорт `MISSION_TEMPLATES` никем не импортируется |
| utils.js:10,48 | `randInt`, `lerpAngle` не используются |
| utils.js:120 | `makeTaxiTexture` — citygen импортирует, но не вызывает |
| skidmarks.js:147 | `resetTrail()` не вызывается |
| peds.js:2091 | `debugSummary()` не вызывается |
| player.js:215, playerped.js:54 | геттеры `position` не используются |
| police.js:38 | поле `_cooldowns` не используется (живой механизм — `_cdTimers`) |
| audio.js:208,213-216,313-314 | делегаты `speak/error/pauseRadio/resumeRadio/bird/raceGo` не вызываются извне |

**Документация устарела**: architecture.md:143-150 называет `PEDESTRIAN_SHOUTS/DRIVER_SHOUTS` мёртвыми — они уже подключены (traffic.js:175, peds.js:1782). Обновить раздел.

## Дублирование / читаемость

1. **Таблица габаритов машин скопирована трижды** и должна синхронизироваться вручную: `CAR_TYPE_SHAPE` (player.js:19), `SKID_SHAPE` (skidmarks.js:9), `PED_CAR_SHAPES` (playerped.js:6). Вынести в config.js.
2. **GPS-блок продублирован** между `_drive` (game.js:1361-1414) и `_walk` (1708-1728) — выделить `_updateGps(dt, targetEntity)`. Там же продублирован блок night/density/`CFG.pedViolatorChance` save-mutate-restore (1270-1277 vs 1660-1666).
3. **Логика облачков речи** повторена в traffic.update (326-335) и peds.update (1831-1853).
4. **Пассажирский менеджер назван `cars`**: `this.peds.cars` — пешеходы; сбивает с толку в каждом месте (`_setActorShadow`, near-miss, полиция).
5. Магические числа без комментариев: traffic.js 2.5 (полоса), 75/80/140 (спавн), 24/16/7.5 (зоны ругани), 20 в `speed*speed/20` (замедление, стр. 499); player.js:461 хардкод урона 6; peds.js:210 порог 210.

## Стиль

- game.js смешивает `events.emit` и `Events.emit` (алиасы одного объекта) — выбрать одно.
- `events.on('order:timer', ...)` эмитится из orders.js:527, слушается только аудио — ок, но имя события не в списке архитектуры.
- `achievements.onPunchPed()` (achievements.js:202) корректен только при порядке «сначала event-слушатель, потом вызов» — хрупкая связность через `_lastPunchEventTime`; стоит оставить один путь учёта.
- Пеший километраж идёт в `shiftStats.km` (game.js:1704), но не в lifetime `totalKm` (updateLiveStats зовётся только в `_drive`) — ачивка km_500 пешие км не считает.
- `_edgeCd`, `_targetRoll`, `_steerIn` и др. поля не объявлены в конструкторах (player.js) — работают за счёт `undefined > 0 === false`.
- `spawn()` трафика: `hasPolice` через `.some()` внутри while — O(n²) на старте (не критично).

## Итог

Кодовая база выше среднего для игрового прототипа: сильная дисциплина комментирования «почему», последовательный zero-alloc в самых горячих местах (камера, скиды, коллизии капсулой, BFS в gps), разумный троттлинг HUD/миникарты, аккуратная шина событий. Главные системные риски — трёхместный: (1) **связанность с regex-бандлером** (мутация импорта, отсутствующие импорты в 3 файлах) — стоит запретить линтером; (2) **квадратичные переборы в traffic/peds** без бакетизации по уже существующим ключам `(axis, coord)`; (3) **утечки геометрий** пешеходов при fail/reset/dispose. Топ-3 приоритета: применить проигнорированный штраф VIP (orders/game, 2 строки), добавить dispose геометрий пешеходов, вынести отсутствие импортов и продублированные таблицы габаритов. После этого — бакетизация трафика как задел под рост плотности.

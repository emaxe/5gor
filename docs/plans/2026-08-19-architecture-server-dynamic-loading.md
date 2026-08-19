# 5GOR — Архитектурная модернизация: сервер + динамическая подгрузка — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `5gor-game-development` (см. также `antigravity-cli` для делегации). Шаги используют checkbox (`- [ ]`) синтаксис для трекинга.

**Goal:** Разгрузить стартовую загрузку, убрать зависимость от CDN, снизить draw-calls/CPU-нагрузку, добавить серверный слой (лидерборд / cloud-save / daily-сид) и перейти на современный сборщик с динамической подгрузкой чанков.

**Architecture:** Сейчас — монолитный `index.html` (~810КБ), собираемый regex-бандлером `build.py` из 26 модулей (`src/*.js`, ~16k строк) в общий global scope; THREE (r152.2) и Tone.js грузятся с CDN unpkg; сохранения — только `localStorage`; деплой — `cp index.html /var/www/5gor/`. Никакого сервера, Docker, CI, TypeScript.

**Tech Stack:** vanilla JS (ESM) + THREE r152.2, сборка `python3 build.py`, тесты `node --test tests/*.test.mjs` (38). Новое: GitHub Actions, Node.js + Fastify + SQLite (WAL) + `ws` в Docker (`node:22-alpine`), esbuild. Ограничения хоста: **2 CPU / 3GB RAM / Docker**, экономия ресурсов.

---

## Контекст — как устроено сейчас

- 26 модулей `src/*.js`, все ассеты — процедурный код (без внешних текстур).
- `build.py` — regex-бандлер (срезает однострочные `import`/`export`), порядок `MODULES` = порядок зависимостей (`config → utils → … → game → main`).
- Игровой цикл: `game._loop()` → `game._update(dt)` → switch по состояниям (menu/driving/walking/pause/garage/settings/map/shiftend).
- Шина событий `EventBus` (`Events`/`events`).
- `index.html` — сгенерированный артефакт, коммитится; после правки `src/` → `python3 build.py` → `cp index.html /var/www/5gor/index.html`.

### Подтверждённые узкие места (верифицировано по коду)
- **Монолитная блокирующая загрузка**: `world.build()` (citygen.js) синхронно блокирует главный поток на 100–300 мс до первого кадра; ~1.8МБ всего (810КБ бандл + ~950КБ CDN).
- **SPOF на CDN**: `index.html` подключает `https://unpkg.com/three@0.152.2/...` и `.../tone@14.7.77/...` (Tone с `onerror="window.__toneFailed=1"`). При падении unpkg игра не стартует (THREE критичен).
- **Draw-call explosion зданий**: `citygen.js:935-954` на каждое здание отдельный `wallMesh` + `roofMesh` → ~240–300 draw calls за кадр (геометрии не объединены, материалы переиспользуются).
- **Миникарта перерисовывается каждый кадр**: `ui.js renderMinimap()` вызывается из `game.js:1265` / `1359` на 60 FPS.
- **Мёртвый код**: `dialogues.js` экспортирует `PEDESTRIAN_SHOUTS`/`DRIVER_SHOUTS` — нигде не импортируются (реальные пулы фраз инлайн в `traffic.js`/`peds.js`).
- **Аудио**: `installUnlockHandlers()` (`audio.js:143`, вызывается в `game.js:157`) блокирует Tone до первого жеста — Tone.js (350КБ) не нужен до клика.
- **Нет CI**: `.github/` содержит только `instructions/project-rules.instructions.md`, воркфлоу нет.

---

## 📋 План (3 фазы)

## 🔥 Фаза 1 — Быстрые победы (low-risk, ~2–4 дня)

### 1.1. Ленивая загрузка Tone.js (по первому жесту)
- [ ] Убрать `<script src=".../tone@14.7.77/...">` из `<head>` в `build.py` (строки с Tone).
- [ ] В `AudioManager.installUnlockHandlers()` (`src/audio.js`) добавлять `<script>` динамически через `document.createElement('script')` только при первом клике/жесте.
- [ ] Сохранить fallback-плеер: guard `if (window.__toneFailed || !window.Tone)` (есть в `audiomusic.js:408`).
- **Риск:** низкий. **Эффект:** −350КБ блокирующего кода на старте.

### 1.2. Self-host three.min.js (убрать CDN-зависимость для THREE)
- [ ] Скачать `three.min.js` (r152.2) в репозиторий (напр. `vendor/three.min.js`) или в `/var/www/5gor/` и подключить локально.
- [ ] Обновить ссылку в `build.py`.
- **Риск:** низкий (файл статический). **Эффект:** игра стартует без интернета/при сбое CDN.

### 1.3. Асинхронный `world.build()` с прогресс-баром
- [ ] Разбить `World.build()` (citygen.js) на микро-задачи (`requestAnimationFrame` / `setTimeout(0)`) по стадиям: (1) дороги+земля, (2) серпантин+Машук, (3) здания+кварталы, (4) пропсы+фонари+светофоры.
- [ ] Показывать прогресс загрузки в `ui.js` (loading-экран до входа в мир).
- **Риск:** низкий-средний (логика генерации не меняется, только разбиение по времени). **Эффект:** нет фриза 100–300мс на старте.

### 1.4. Троттлинг миникарты (~20 FPS)
- [ ] В `game.js` / `ui.js` рендерить `renderMinimap()` каждые 3 кадра (15–20 FPS) вместо каждого кадра.
- [ ] Стрелку/поворот навигатора — CSS-трансформацией (не перерисовкой canvas).
- **Риск:** низкий. **Эффект:** разгрузка CPU.

### 1.5. Убрать/вынести мёртвый код dialogues.js
- [ ] `grep -rn "PEDESTRIAN_SHOUTS\|DRIVER_SHOUTS" src/` — подтвердить неиспользуемость.
- [ ] Либо удалить из `dialogues.js` эти массивы, либо (предпочтительно) централизовать все пулы фраз (traffic/peds) в единый реестр `src/data/dialogues.json` для дальнейшего расширения.
- **Риск:** низкий. **Эффект:** −40КБ, чистота.

### 1.6. GitHub Actions CI
- [ ] Создать `.github/workflows/ci.yml`: lint (`npm run lint`), `node --test tests/*.test.mjs`, `python3 build.py` + чек, что все модули в `index.html` (`grep -c "/* ===== "`), размер-чек (alert при > 1МБ), опционально `npx tsc --noEmit` (JSDoc).
- **Риск:** низкий. **Эффект:** авто-контроль регрессий.

## ⚙️ Фаза 2 — Сервер + динамическая подгрузка (1–2 недели)

### 2.1. Бэкенд: Fastify + SQLite + ws (offline-first)
- [ ] Новый каталог `server/` (Node.js + Fastify + `better-sqlite3` (WAL) + `ws`).
- [ ] `docker-compose.yml` (образ `node:22-alpine`, non-root, лимиты `cpus: '1.0'`, `memory: 256M`), volume `./data:/app/data` для SQLite.
- [ ] Клиент остаётся 100% автономным: `localStorage` — primary, сервер — синхронизация/мета. При offline — игра работает, `sync` при reconnect.

Эндпоинты (REST + WS):
```
POST /api/v1/auth/guest          -> { playerId, token, pinCode }
POST /api/v1/sync/save           -> облачный сейв
GET  /api/v1/sync/load           -> загрузка облачного сейва
POST /api/v1/leaderboard/submit  -> результат смены (с валидацией дельты денег/км)
GET  /api/v1/leaderboard/daily   -> топ-50 за сегодня
GET  /api/v1/ghost/:trackId/best -> рекордная траектория (если включено)
WS   /ws/multiplayer             -> (ОТЛОЖЕНО, см. ниже)
```
- [ ] Nginx: прокси `/api/*` и `/ws` в Docker-контейнер; Brotli/gzip (index.html 810КБ → ~175КБ); кэш-заголовки.

> **Стек:** выбрал **Node.js (Fastify + better-sqlite3 + ws)**, не Go/Python. Обоснование: на сервере уже работают 3 Node-проекта (eApi, notAntey, panel) — консистентность стека; ~40–60МБ RAM в Docker на 2CPU/3GB хватает; общие типы/формулы с клиентом. Go легче (~18МБ) и быстрее, но дублирование логики; Python (FastAPI) — оверхед ~140–200МБ. Отдельный PostgreSQL — не нужен (250МБ в простое), SQLite WAL в том же процессе (< 5МБ).

### 2.2. Фичи бэкенда по окупаемости (все offline-first)
- [ ] **Лидерборд** (топ КМВ за смену/день) — REST, мотивация переиграть.
- [ ] **Cloud-save** — анонимный PIN-код/токен, перенос прогресса между устройствами; merge по timestamp.
- [ ] **Daily-сид** — `GET /daily` (дата + seed), единый «заказ дня».
- [ ] **Ghost-runs** — запись позиций рекордных заездов на Машук (~2КБ/run, sqlite), replay на клиенте. (средний приоритет)
- [ ] **Мультиплеер (WS-присутствие)** — ❌ ОТЛОЖЕНО: на 2CPU/3GB WebSocket-арена не окупается (~500МБ+ RAM). Только после выделенного сервера. Оба агента согласны.

### 2.3. Переход на esbuild (поэтапно)
- [ ] **Шаг A (низкий риск):** esbuild как post-minifier поверх `build.py` (concat → `esbuild --minify`), сохраняя общий global scope.
- [ ] **Шаг B:** миграция на настоящие ESM `import`/`export` + `dynamic import()` чанков: Tone/radio → citygen → dialogues/peds (прогрессивная загрузка). Из-за общего global scope — модуль за модулем, через shared `globals.js`.
- **Риск:** средний (26 модулей делят имена `CFG`, `Events`, `World`; при ESM нужно явно импортировать ~120+ символов). Проверить `grep -rn "export default" src/` (regex-бандлер ломает многострочные импорты).

## 🚀 Фаза 3 — Долгосрочно (1–2 месяца)

- [ ] **InstancedMesh / BatchedMesh для зданий и NPC**: объединить `wallMesh`/`roofMesh` по материалам (300 → ~20 draw calls); для пешеходов — shared `PedestrianGeometry` + InstancedMesh. В проекте уже есть `mergeColored`/`mergeGeoms` — расширить.
- [ ] **Data-driven квесты/диалоги** — вынести миссии из `orders.js` и диалоги из `dialogues.js`/инлайн-пулов в `src/data/*.json`.
- [ ] **`@ts-check`/JSDoc** в ключевых модулях (не полный TS — 16k строк рефакторить нецелесообразно).
- [ ] **PWA + Service Worker** — offline-first (манифест + SW для кэша `index.html` и ассетов).
- [ ] **In-game DevTools (F1)** — визуализация `pedgraph`, AABB-коллайдеров, телепорт к точкам, слайдеры времени/погоды.

---

## Открытые вопросы (требуют решения перед стартом)
1. **Сервер реально нужен?** Лидерборд + cloud-save + daily-сид — или пока только клиентские оптимизации (Фаза 1)?
2. **Автономность**: критично ли сохранять игру как **один файл** `index.html` для локального открытия двойным кликом? (Влияет на выбор сборщика: split-ассеты в проде + single-file локально, или только single-file.)
3. **Мультиплеер** — вообще в планах, или вычёркиваем окончательно?
4. **Домен/SSL** для бэкенда уже есть, или разворачивать только по IP/локально?

---

## Проверка перед деплоем (gate)
- [ ] `node --check` на каждый изменённый файл `src/*.js`.
- [ ] `python3 build.py` (успешно).
- [ ] `node --test tests/*.test.mjs` (38 проходят).
- [ ] `git status -s` — только разрешённые файлы.
- [ ] `cp index.html /var/www/5gor/index.html` (если деплой).
- [ ] Conventional Commit: `type(scope): описание на русском`.

/* ============================================================
 * 5GOR — Симулятор таксиста в Пятигорске
 * config.js — константы баланса, районы, апгрейды, автомобили
 * ============================================================ */

/**
 * @typedef {Object} District
 * @property {string} id - Уникальный идентификатор района
 * @property {string} name - Название района
 * @property {number} unlock - Требуемый рейтинг для разблокировки
 * @property {number} weight - Вес генерации заказов/зданий
 * @property {string} palette - Название цветовой палитры
 * @property {[number, number]} height - Диапазон высоты зданий [min, max]
 * @property {number} dens - Плотность застройки
 * @property {number} color - Цвет района на карте в формате HEX (number)
 */

/**
 * @typedef {Object} CarStats
 * @property {number} maxSpeed - Максимальная скорость
 * @property {number} accel - Скорость разгона
 * @property {number} brake - Сила торможения
 * @property {number} grip - Сцепление с дорогой
 * @property {number} armor - Прочность кузова
 * @property {number} tank - Емкость топливного бака
 * @property {number} capacity - Вместимость пассажиров
 * @property {number} steer - Манёвренность / Скорость поворота
 */

/**
 * @typedef {Object} CarDef
 * @property {string} id - Уникальный ID автомобиля
 * @property {string} name - Название модели автомобиля
 * @property {number} price - Стоимость покупки автомобиля в ₽
 * @property {number} unlockRating - Требуемый рейтинг для покупки
 * @property {CarStats} base - Базовые характеристики автомобиля
 * @property {string} bodyColor - Основной цвет кузова в HEX
 * @property {string} desc - Краткое описание автомобиля
 */

/**
 * @typedef {Object} TuningColor
 * @property {string} name - Название цвета
 * @property {string} c - HEX-код цвета
 */

/**
 * @typedef {Object} TuningRim
 * @property {string} name - Название дисков
 * @property {string} c - HEX-код цвета дисков (для style==='chrome' влияет только на превью свотча в UI — материал берётся из matChrome)
 * @property {'disc'|'spoke'|'chrome'} style - геометрия диска (см. carmodel.js buildCarModel spec.rimStyle)
 */

/**
 * @typedef {Object} TuningBodyKit
 * @property {string} name - Название боди-кита
 * @property {string} id - 'stock'|'sport' — см. carmodel.js buildCarModel spec.bodyKit
 */

/**
 * @typedef {Object} TuningDecal
 * @property {string} name - Название декали
 * @property {'none'|'stripe'|'checker'|'racing'} id - см. player.js DECAL_TEXTURE
 */

/**
 * @typedef {Object} Tuning
 * @property {TuningColor[]} colors - Доступные цвета кузова
 * @property {TuningRim[]} rims - Доступные варианты дисков
 * @property {boolean} spoiler - Установлен ли спойлер
 * @property {TuningBodyKit[]} bodyKits - Доступные боди-киты
 * @property {TuningDecal[]} decals - Доступные декали (текстура на built.refs.decal)
 */

/**
 * @typedef {Object} WeatherDef
 * @property {string} name - Название погодных условий
 * @property {number} rain - Флаг/интенсивность дождя (0 или 1)
 * @property {number} fogNear - Ближняя граница тумана
 * @property {number} fogFar - Дальняя граница тумана
 * @property {number} grip - Коэффициент сцепления с дорогой
 * @property {number} traffic - Коэффициент скорости/плотности трафика
 */

/**
 * @typedef {Object} ShiftStats
 * @property {number} earned - Заработанные деньги за смену
 * @property {number} orders - Выполнено обычных заказов
 * @property {number} tips - Сумма полученных чаевых
 * @property {number} crashes - Количество столкновений
 * @property {number} peds - Количество сбитых пешеходов
 * @property {number} km - Пройдено километров
 * @property {number} failed - Проваленные заказы
 * @property {number} missions - Выполнено уникальных миссий
 */

export const CFG = {
  // Базовые параметры мира
  CELL: 64,          // размер квартала
  ROAD_W: 12,        // ширина дороги (4 полосы)
  HALF: 6,           // половина дороги
  SIDE: 4,           // ширина тротуара
  N: 4,              // дороги от -N*CELL до N*CELL
  GRID_EXT: 36,      // дороги выступают за сетку
  SHADOW_HALF: 90,   // половина бокса shadow-камеры солнца (game.js), фиксирован
                      // вокруг центра карты (0,0) — geometry.js использует то же
                      // значение, чтобы не включать castShadow на чанках, которые
                      // частично выходят за границу (иначе тень обрезается посреди
                      // объекта и выглядит «оторванной» от него)

  // Экономика
  startMoney: 800,
  startFuel: 70,
  fuelPrice: 0.9,        // ₽ за 1 ед. топлива
  baseFare: 120,         // базовая ставка заказа
  farePerUnit: 1.35,     // ₽ за 1 метр пути (город ~500 м)
  timeBonusMax: 0.35,    // до +35% за быстрое выполнение
  tipsMax: 90,           // максимум чаевых
  urgentMult: 1.6,
  vipMult: 1.5,
  groupMult: 0.9,
  touristMult: 2.0,
  nightMult: 2.0,        // ночью тариф x2
  repairCostPerDmg: 22,  // ₽ за 1% урона
  washCost: 60,
  towCost: 400,          // эвакуатор
  towRepair: 35,         // % урона чинит эвакуатор
  towFuel: 15,           // +топлива
  refuelDist: 8,
  lowFuelRatio: 0.25,   // ниже этой доли бака GPS ведёт к ближайшей заправке

  // Рейтинг и прокачка
  ratingPerOrder: { normal: 4, urgent: 6, vip: 7, group: 9, tourist: 10, package: 5, drunk: 6, race: 12 },
  ratingFail: { crash: 2, hitPed: 15, failOrder: 5, vipLeave: 8, pedPunch: 3 },

  // Смена: 12 реальных минут = 24 игровых часа
  shiftStartHour: 9,
  dayLengthSec: 720,
  nightStartHour: 22,
  nightEndHour: 6,

  // Трафик и мир
  trafficCount: 14,
  pedCount: 34,
  maxOpenOrders: 4,
  orderExpireSec: 110,
  orderSpawnEverySec: 9,

  // Пешеходы: зоны ИИ и нарушения ПДД
  pedActiveRadius: 110,      // ≤110 м — полный ИИ (маршрут, ПДД, обход)
  pedNearRadius: 150,        // 110–150 м — простое движение + обход статики
  pedViolatorChance: 0.08,   // ~8% нарушают ПДД (переход на красный/jwalk)
  pedIdleTime: [5, 15],      // пауза пешехода после прибытия, сек

  // Пешеход-игрок (выход из машины)
  pedWalkSpeed: 3.1,       // базовая скорость ходьбы водителя (м/с)
  pedRunSpeed: 5.8,        // скорость спринта при зажатом Shift (м/с)
  carEnterDist: 3.0,       // максимальная дистанция посадки в авто (м)
  carExitMaxSpeed: 1.5,    // максимальная скорость авто для разрешения выхода (м/с)

  // Удар / драка пешехода-игрока
  pedPunchRadius: 2.0,       // дистанция удара (м)
  pedPunchArc: Math.PI / 3,  // половина конуса поражения (60° = π/3)
  pedPunchCooldown: 0.8,     // кулдаун между ударами (сек)
  pedPunchKnockSpeed: 5.0,   // скорость отлёта цели (м/с)
  pedPunchPanicRadius: 8.0,  // радиус паники свидетелей (м)
  pedPunchFine: 150,         // штраф за нападение (₽)
  pedPunchRatingLoss: 5,     // потеря рейтинга за нападение
  pedPlayerMaxHp: 3,         // максимальное здоровье пешехода-игрока
  pedPlayerStunDuration: 0.6,// длительность оглушения игрока при ударе в ответ (сек)
  pedPlayerDownDuration: 2.0,// длительность нокаута при потере всего HP (сек)
  pedJumpSpeed: 6.5,         // начальная вертикальная скорость прыжка (м/с)
  pedGravity: 20.0,          // гравитация для пешехода-игрока (м/с²)
  pedJumpCooldown: 0.25,     // кулдаун между прыжками (сек)

  // Следы шин при заносе (skidmarks.js) — пороги совпадают с аудио-скидом
  skidMinSlip: 0.45,     // slip = |latSpeed|/8 + ручник; 0.45 ↔ лат. скорость 3.6 м/с
  skidMinSpeed: 6,       // м/с — ниже следы не рисуем (пятнистость на месте)
  skidSegLen: 0.4,       // мин. шаг сегмента ленты, м (иначе needsUpdate каждый кадр)
  skidMaxSegments: 256,  // кольцевой буфер: 256 шагов × 2 квада ≈ 100 м непрерывного дрифта
  skidWidth: 0.3,        // ширина следа одного колеса, м

  // Дрифт-бонус: ручник + боковой снос (механика поверх физики, на неё не влияет)
  driftMinSlip: 0.5,       // порог slip для фиксации заноса (skidMarks использует 0.45)
  driftMinSpeed: 7.0,      // минимальная скорость машины (м/с, ~25 км/ч)
  driftMinDuration: 0.8,   // минимальная длительность непрерывного заноса (сек)
  driftBaseReward: 40,     // базовая выплата за завершённый занос (₽)
  driftRewardPerSec: 50,   // доплата за каждую секунду удержания свыше минимума (₽/сек)
  driftMaxReward: 200,     // потолок награды за один непрерывный дрифт (₽)
  driftStyleBonus: 0.05,   // лёгкая компенсация штрафа стиля пассажира (+5% к style)
  // Идеальная остановка: награда за плавное торможение перед высадкой
  perfectStopMinSpeed: 7.0,     // мин. скорость начала торможения (м/с, ~25 км/ч) — не награждать за остановку с места
  perfectStopMaxDecel: 9.5,     // макс. пиковое замедление для «плавности» (м/с²); полный тормоз даёт 22-34, накат 3.5
  perfectStopBaseReward: 50,    // базовая выплата за идеальную остановку (₽)
  perfectStopStyleBonus: 0.08,  // бонус к стилю вождения пассажира (+8% к style)

  // Качество (устаревший алиас, держится ради обратной совместимости старых
  // сохранений — реальные настройки теперь в CFG.gfx)
  quality: 'high', // high | low (вкл/выкл тени, pixelRatio)
};

/* Настройки графики: реальные поля, применяемые applyGfx() (game.js). Дефолты
   соответствуют текущему поведению quality:'high'. */
// pixelBudget — потолок пикселей буфера рендера (ширина×высота×pixelRatio²).
// На fullscreen retina-окне один pixelRatio из пресета не спасает: экран сам
// по себе может быть 2560×1440, и 1.75 там даёт ~16 млн фрагментов. game.js
// (_effectivePixelRatio) урезает pixelRatio так, чтобы уложиться в бюджет,
// не трогая сам пресет для маленьких окон.
export const CFG_GFX_PRESETS = {
  low:    { shadows: 'off',  shadowActors: false, pixelRatio: 1.25, pixelBudget: 1600000, drawDistance: 600,  trafficDensity: 0.5, pedDensity: 0.5, rain: false },
  medium: { shadows: 'low',  shadowActors: false, pixelRatio: 1.25, pixelBudget: 2400000, drawDistance: 1000, trafficDensity: 1.0, pedDensity: 1.0, rain: true },
  high:   { shadows: 'high', shadowActors: false, pixelRatio: 1.75, pixelBudget: 3200000, drawDistance: 1400, trafficDensity: 1.0, pedDensity: 1.0, rain: true },
};

CFG.gfx = { ...CFG_GFX_PRESETS.high, preset: 'high' };

/* Районы города. unlock — рейтинг для появления заказов */
export const DISTRICTS = [
  { id: 'center',   name: 'Центр',          unlock: 0,   weight: 22, palette: 'center',   height: [20, 55], dens: 4,  color: 0x7a4a2b },
  { id: 'kurort',   name: 'Курортный',      unlock: 0,   weight: 18, palette: 'kurort',   height: [9, 22],  dens: 3,  color: 0x6d8f5f },
  { id: 'prigorod', name: 'Привокзальный',  unlock: 0,   weight: 16, palette: 'prigorod', height: [8, 18],  dens: 3,  color: 0x7d8a99 },
  { id: 'proval',   name: 'Провал',         unlock: 15,  weight: 10, palette: 'proval',   height: [8, 16],  dens: 2,  color: 0x4a7a99 },
  { id: 'rynok',    name: 'Рынок «Лира»',   unlock: 30,  weight: 12, palette: 'rynok',    height: [8, 14],  dens: 3,  color: 0x9a7a4a },
  { id: 'sanatorii',name: 'Санатории',      unlock: 45,  weight: 11, palette: 'sanatorii',height: [12, 26], dens: 2,  color: 0xb8a888 },
  { id: 'mashuk',   name: 'Машук',          unlock: 60,  weight: 8,  palette: 'mashuk',   height: [6, 12],  dens: 2,  color: 0x5f8a5f },
  { id: 'vokzal',   name: 'Вокзал',         unlock: 75,  weight: 9,  palette: 'vokzal',   height: [10, 20], dens: 3,  color: 0x8a7a5f },
];

/* Палитры фасадов (цвета стен) */
export const PALETTES = {
  center:    ['#e8c98a', '#e0b060', '#d8a050', '#f0d8a0', '#d09060'],
  kurort:    ['#c8d8b0', '#a8c090', '#e0d8b8', '#b8c8a0', '#d0c8a8'],
  prigorod:  ['#b0b8c0', '#989ea8', '#c0c0c8', '#a8b0b8', '#d0d0d8'],
  proval:    ['#90b0c8', '#80a8c0', '#a8c0d0', '#98b8c8', '#88a8b8'],
  rynok:     ['#d8b080', '#c8a070', '#e0c090', '#d0a878', '#c89868'],
  sanatorii: ['#f0ece0', '#e8e0d0', '#f8f4e8', '#e0d8c8', '#ece4d4'],
  mashuk:    ['#c0b090', '#b0a080', '#d0c0a0', '#a89878', '#c8b898'],
  vokzal:    ['#c8b898', '#b8a888', '#d8c8a8', '#a89878', '#c0b090'],
};

/* Апгрейды. base — цена 1 уровня, mult — рост цены */
export const UPGRADES = {
  engine:      { name: 'Двигатель',   max: 4, base: 600, mult: 1.7, icon: '⚙️', desc: 'Чип-тюнинг от мастеров с Бештаугорского — турбина свистит, Приоры плачут' },
  suspension:  { name: 'Подвеска',    max: 4, base: 500, mult: 1.7, icon: '🛞', desc: 'Горная подвеска — шпильки серпантина Машука проходим без крена' },
  brakes:      { name: 'Тормоза',     max: 4, base: 400, mult: 1.7, icon: '🛑', desc: 'Керамика Brembo — встаёт как вкопанная перед любой внезапной коровой' },
  armor:       { name: 'Прочность',   max: 4, base: 700, mult: 1.7, icon: '🛡️', desc: 'Бронированный как сейф банка на Кирова — тарань смело' },
  tank:        { name: 'Бак',         max: 4, base: 500, mult: 1.7, icon: '⛽', desc: 'Бак размером с нарзанную цистерну — до Минвод без остановки' },
  capacity:    { name: 'Вместимость', max: 3, base: 900, mult: 1.8, icon: '👥', desc: 'Весь двор помещается — бабушки, коляски и горы курортных чемоданов' },
};

/* Автомобили */
export const CARS = {
  taxi: {
    id: 'taxi', name: '«Пятёрочка»', price: 0, unlockRating: 0,
    base: { maxSpeed: 34, accel: 13, brake: 26, grip: 1.0, armor: 1.0, tank: 100, capacity: 1, steer: 2.1, carType: 'taxi' },
    bodyColor: '#f2c12e', desc: 'Надежный жёлтый седан для повседневных поездок',
  },
  classic: {
    id: 'classic', name: '«Классика» (2107)', price: 3500, unlockRating: 10,
    base: { maxSpeed: 32, accel: 11, brake: 22, grip: 0.9, armor: 0.85, tank: 85, capacity: 1, steer: 2.0, carType: 'classic' },
    bodyColor: '#c0392b', desc: 'Отечественная классика с душой Пятигорска. Проста и душевна!',
  },
  comfort: {
    id: 'comfort', name: '«Комфорт»', price: 12000, unlockRating: 25,
    base: { maxSpeed: 38, accel: 15, brake: 28, grip: 1.08, armor: 1.1, tank: 115, capacity: 2, steer: 2.3, carType: 'comfort' },
    bodyColor: '#2e6fb5', desc: 'Удобный и резвый седан повышенной комфортности',
  },
  minivan: {
    id: 'minivan', name: '«Микроавтобус»', price: 18000, unlockRating: 35,
    base: { maxSpeed: 35, accel: 12, brake: 25, grip: 1.02, armor: 1.4, tank: 140, capacity: 3, steer: 1.9, carType: 'minivan' },
    bodyColor: '#f0f0ee', desc: 'Вместительный бусик для групп, экскурсий и семейных вылазок',
  },
  business: {
    id: 'business', name: '«Бизнес»', price: 25000, unlockRating: 50,
    base: { maxSpeed: 43, accel: 17, brake: 32, grip: 1.15, armor: 1.3, tank: 130, capacity: 2, steer: 2.5, carType: 'business' },
    bodyColor: '#20242c', desc: 'Чёрный премиум-седан для VIP-клиентов и быстрой езды',
  },
  sport: {
    id: 'sport', name: '«Спорт-купе»', price: 34000, unlockRating: 65,
    base: { maxSpeed: 48, accel: 20, brake: 34, grip: 1.2, armor: 1.05, tank: 90, capacity: 1, steer: 2.7, carType: 'sport' },
    bodyColor: '#c0392b', desc: 'Быстрое двухдверное купе для лихой езды по серпантину',
  },
  offroad: {
    id: 'offroad', name: '«Внедорожник»', price: 42000, unlockRating: 80,
    base: { maxSpeed: 41, accel: 15, brake: 30, grip: 1.1, armor: 1.6, tank: 150, capacity: 3, steer: 2.1, carType: 'offroad' },
    bodyColor: '#3e8e4e', desc: 'Мощный внедорожник — не боится бездорожья и любых пассажиров',
  },
};

/* Тюнинг: цвета кузова, диски, спойлер */
export const TUNING = {
  colors: [
    { name: 'Такси жёлтый', c: '#f2c12e' },
    { name: 'Красный',      c: '#c0392b' },
    { name: 'Синий',        c: '#2e6fb5' },
    { name: 'Белый',        c: '#f0f0ee' },
    { name: 'Чёрный',       c: '#20242c' },
    { name: 'Зелёный',      c: '#3e8e4e' },
    { name: 'Оранжевый',    c: '#e67e22' },
  ],
  rims: [
    { name: 'Стандарт', c: '#b8b8b8', style: 'disc' },
    { name: 'Спицы',    c: '#2a2a2a', style: 'spoke' },
    { name: 'Хром',     c: '#e8ecf0', style: 'chrome' },
  ],
  spoiler: false,
  bodyKits: [
    { name: 'Стандарт', id: 'stock' },
    { name: 'Спорт',    id: 'sport' },
  ],
  // дефолт по типу машины считает upgrades.js (taxi -> 'checker', остальные -> 'none')
  decals: [
    { name: 'Нет',       id: 'none' },
    { name: 'Полоса',    id: 'stripe' },
    { name: 'Шашечки',   id: 'checker' },
    { name: 'Гоночная',  id: 'racing' },
  ],
};

/* Достопримечательности (экскурсионные заказы) */
export const LANDMARKS = [
  { id: 'proval',    name: 'Озеро Провал',       x: -72, z: -160, desc: 'Голубое озеро в кратере' },
  { id: 'cvetnik',   name: 'Цветник',            x: -32, z: 18,   desc: 'Парк с фонтаном и гротом' },
  { id: 'grot',      name: 'Грот Лермонтова',    x: -52, z: 8,    desc: 'Каменный грот в парке' },
  { id: 'narzan',    name: 'Нарзанные ванны',    x: -32, z: -15,  desc: 'Купол галереи с нарзаном' },
  { id: 'rynok',     name: 'Рынок «Лира»',       x: 96,  z: -8,   desc: 'Главный рынок города' },
  { id: 'vokzal',    name: 'Ж/д вокзал',         x: 160, z: 96,   desc: 'Вокзал с часами на башне' },
  { id: 'cable',     name: 'Канатная дорога',    x: 20,  z: -288, desc: 'Подъёмник на Машук' },
  { id: 'gazebo',    name: 'Эолова арфа',        x: 12,  z: -350, desc: 'Беседка на склоне Машука' },
  { id: 'tower',     name: 'Смотровая башня',    x: 0,   z: -448, desc: 'Вершина Машука' },
];

/* Заправки */
export const FUEL_STATIONS = [
  { x: 0,   z: 128 }, { x: -192, z: -64 },
  { x: 128, z: -192 }, { x: 64, z: 192 },
];

/* Погода */
export const WEATHER_DEFS = {
  clear: { name: 'Ясно',   rain: 0,  fogNear: 500, fogFar: 1600, grip: 1.0, traffic: 1.0 },
  rain:  { name: 'Дождь',  rain: 1,  fogNear: 120, fogFar: 420,  grip: 0.78, traffic: 0.7 },
  fog:   { name: 'Туман',  rain: 0,  fogNear: 60,  fogFar: 220,  grip: 0.95, traffic: 0.9 },
};

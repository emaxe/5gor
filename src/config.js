/* ============================================================
 * 5GOR — Симулятор таксиста в Пятигорске
 * config.js — константы баланса, районы, апгрейды, автомобили
 * ============================================================ */

const CFG = {
  // Базовые параметры мира
  CELL: 64,          // размер квартала
  ROAD_W: 12,        // ширина дороги (4 полосы)
  HALF: 6,           // половина дороги
  SIDE: 4,           // ширина тротуара
  N: 4,              // дороги от -N*CELL до N*CELL
  GRID_EXT: 36,      // дороги выступают за сетку

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

  // Рейтинг и прокачка
  ratingPerOrder: { normal: 4, urgent: 6, vip: 7, group: 9, tourist: 10, package: 5, drunk: 6, race: 12 },
  ratingFail: { crash: 2, hitPed: 15, failOrder: 5, vipLeave: 8 },

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

  // Качество
  quality: 'high', // high | low (вкл/выкл тени, pixelRatio)
};

/* Районы города. unlock — рейтинг для появления заказов */
const DISTRICTS = [
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
const PALETTES = {
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
const UPGRADES = {
  engine:      { name: 'Двигатель',   max: 4, base: 600, mult: 1.7, icon: '⚙️', desc: 'Макс. скорость и разгон' },
  suspension:  { name: 'Подвеска',    max: 4, base: 500, mult: 1.7, icon: '🛞', desc: 'Управляемость на серпантине' },
  brakes:      { name: 'Тормоза',     max: 4, base: 400, mult: 1.7, icon: '🛑', desc: 'Тормозной путь' },
  armor:       { name: 'Прочность',   max: 4, base: 700, mult: 1.7, icon: '🛡️', desc: 'Меньше урон от ударов' },
  tank:        { name: 'Бак',         max: 4, base: 500, mult: 1.7, icon: '⛽', desc: 'Запас хода' },
  capacity:    { name: 'Вместимость', max: 3, base: 900, mult: 1.8, icon: '👥', desc: 'Типы заказов: группы, экскурсии' },
};

/* Автомобили */
const CARS = {
  taxi: {
    id: 'taxi', name: '«Пятёрочка»', price: 0, unlockRating: 0,
    base: { maxSpeed: 34, accel: 13, brake: 26, grip: 1.0, armor: 1.0, tank: 100, capacity: 1, steer: 2.1 },
    bodyColor: '#f2c12e', desc: 'Легендарный жёлтый трудяга',
  },
  business: {
    id: 'business', name: '«Бизнес»', price: 25000, unlockRating: 40,
    base: { maxSpeed: 41, accel: 16, brake: 30, grip: 1.12, armor: 1.25, tank: 130, capacity: 1, steer: 2.4 },
    bodyColor: '#20242c', desc: 'Чёрный седан для VIP-клиентов',
  },
};

/* Тюнинг: цвета кузова, диски, спойлер */
const TUNING = {
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
    { name: 'Стандарт', c: '#b8b8b8' },
    { name: 'Чёрные',   c: '#2a2a2a' },
    { name: 'Золотые',  c: '#d4af37' },
  ],
  spoiler: false,
};

/* Достопримечательности (экскурсионные заказы) */
const LANDMARKS = [
  { id: 'proval',    name: 'Озеро Провал',       x: -96, z: -160, desc: 'Голубое озеро в кратере' },
  { id: 'cvetnik',   name: 'Цветник',            x: -32, z: 32,   desc: 'Парк с фонтаном и гротом' },
  { id: 'grot',      name: 'Грот Лермонтова',    x: -52, z: 8,    desc: 'Каменный грот в парке' },
  { id: 'narzan',    name: 'Нарзанные ванны',    x: -32, z: -32,  desc: 'Купол галереи с нарзаном' },
  { id: 'rynok',     name: 'Рынок «Лира»',       x: 96,  z: -32,  desc: 'Главный рынок города' },
  { id: 'vokzal',    name: 'Ж/д вокзал',         x: 160, z: 96,   desc: 'Вокзал с часами на башне' },
  { id: 'cable',     name: 'Канатная дорога',    x: 20,  z: -288, desc: 'Подъёмник на Машук' },
  { id: 'gazebo',    name: 'Эолова арфа',        x: 10,  z: -357, desc: 'Беседка на склоне Машука' },
  { id: 'tower',     name: 'Смотровая башня',    x: 0,   z: -448, desc: 'Вершина Машука' },
];

/* Заправки */
const FUEL_STATIONS = [
  { x: 0,   z: 128 }, { x: -192, z: -64 },
  { x: 128, z: -192 }, { x: 64, z: 192 },
];

/* Погода */
const WEATHER_DEFS = {
  clear: { name: 'Ясно',   rain: 0,  fogNear: 500, fogFar: 1600, grip: 1.0, traffic: 1.0 },
  rain:  { name: 'Дождь',  rain: 1,  fogNear: 120, fogFar: 420,  grip: 0.78, traffic: 0.7 },
  fog:   { name: 'Туман',  rain: 0,  fogNear: 60,  fogFar: 220,  grip: 0.95, traffic: 0.9 },
};

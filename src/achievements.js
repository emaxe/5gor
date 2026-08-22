/* ============================================================
 * 5GOR — Достижения
 * achievements.js — отслеживание и начисление ачивок, сохранение в localStorage
 * ============================================================ */

import { Events } from './eventbus.js';

/**
 * @typedef {Object} Achievement
 * @property {string} id - Уникальный идентификатор
 * @property {string} name - Название (для отображения)
 * @property {string} desc - Описание
 * @property {string} [toast] - Текст тоста-поздравления
 * @property {string} icon - Emoji-иконка
 * @property {function(Object): boolean} check - Функция проверки: true = достижение получено
 */

const ACHIEVEMENTS = [
  // --- Заказы ---
  { id: 'first_order',   name: 'Первый заработок',     desc: 'Выполните первый заказ',                toast: 'Первая копейка — и та в кассу',        icon: '🚕', check: s => s.totalOrders >= 1 },
  { id: 'orders_50',     name: 'Опытный таксист',      desc: 'Выполните 50 заказов',                  toast: 'Полсотни клиентов, ни одного провала',  icon: '🚖', check: s => s.totalOrders >= 50 },
  { id: 'orders_100',    name: 'Ветеран дорог',        desc: 'Выполните 100 заказов',                 toast: 'Сотня за плечами — асфальт дрожит',     icon: '🏆', check: s => s.totalOrders >= 100 },
  { id: 'orders_250',    name: 'Легенда Пятигорска',   desc: 'Выполните 250 заказов',                 toast: 'Живая легенда пятигорских дорог',       icon: '👑', check: s => s.totalOrders >= 250 },
  // --- Деньги ---
  { id: 'earn_10k',      name: 'Первая тыща',          desc: 'Заработайте 10 000 ₽ за все время',     toast: 'Десятка в кармане — на шашлык хватит',  icon: '💰', check: s => s.totalEarned >= 10000 },
  { id: 'earn_50k',      name: 'Состоятельный водитель', desc: 'Заработайте 50 000 ₽ за все время',   toast: 'Кошелёк трещит от курортных купюр',    icon: '💎', check: s => s.totalEarned >= 50000 },
  { id: 'earn_100k',     name: 'Магнат такси',         desc: 'Заработайте 100 000 ₽ за все время',    toast: 'Настоящий магнат такси на КМВ',         icon: '🏛️', check: s => s.totalEarned >= 100000 },
  // --- Стиль ---
  { id: 'clean_shift',   name: 'Идеальная смена',      desc: 'Смена без аварий и сбитых пешеходов',   toast: 'Ни единой царапинки за всю смену',      icon: '✨', check: s => s.shiftOrders >= 5 && s.shiftCrashes === 0 && s.shiftPeds === 0 },
  { id: 'max_speed',     name: 'Шумахер',              desc: 'Разгонитесь до 150 км/ч',               toast: 'Шумахер нервно курит на обочине',      icon: '⚡', check: s => s.maxSpeedKmh >= 150 },
  { id: 'max_rating',    name: 'Звезда Пятигорска',    desc: 'Достигните максимального рейтинга',     toast: 'Пятигорск ваш! Что дальше — Машук',     icon: '⭐', check: s => s.maxRating >= 100 },
  // --- Особые ---
  { id: 'missions_5',    name: 'Герой города',         desc: 'Выполните 5 уникальных миссий',         toast: 'Пять особых поручений выполнены',       icon: '🎖️', check: s => s.totalMissions >= 5 },
  { id: 'night_owl',     name: 'Ночная сова',          desc: 'Выполните 10 ночных заказов',           toast: 'Ночной хозяин спящего курорта',         icon: '🦉', check: s => s.nightOrders >= 10 },
  { id: 'km_500',        name: 'Путешественник',       desc: 'Проедьте 500 км за все время',          toast: 'Пятьсот километров по серпантинам',     icon: '🛣️', check: s => s.totalKm >= 500 },
  { id: 'police_fined',  name: 'Враг народа',          desc: 'Получите 5 штрафов от полиции',         toast: 'С ГИБДД лучше дружить, а не дружиться', icon: '🚨', check: s => s.policeFines >= 5 },
  { id: 'tips_5k',       name: 'Любимец клиентов',     desc: 'Заработайте 5 000 ₽ чаевых',            toast: 'Курортники не скупятся на чай',         icon: '🎁', check: s => s.totalTips >= 5000 },
  // --- Бойцовские ---
  { id: 'hot_head',      name: 'Горячая голова',       desc: 'Нападите на 10 прохожих за смену',      toast: 'Кулаки — вторая профессия таксиста',    icon: '👊', check: s => s.shiftPunches >= 10 },
  { id: 'brawler',       name: 'Дерущийся таксист',    desc: 'Нападите на 50 прохожих за все время',  toast: 'Гроза пешеходов проспекта Кирова',      icon: '🥊', check: s => s.totalPunches >= 50 },
  // --- Вождение ---
  { id: 'near_miss_50',  name: 'Скользкий тип',         desc: 'Совершите 50 опасных сближений',       toast: 'Прошёл в миллиметре — и не поцарапал',   icon: '💨', check: s => s.totalNearMisses >= 50 },
  { id: 'near_miss_200', name: 'Призрак дорог',         desc: 'Совершите 200 опасных сближений',      toast: 'Ты невидимка на пятигорских трассах',    icon: '👻', check: s => s.totalNearMisses >= 200 },
];

const STORAGE_KEY = '5gor_achievements_v1';

/**
 * Менеджер достижений: отслеживает статистику, проверяет условия, сохраняет в localStorage.
 */
export class AchievementManager {
  constructor() {
    /** @type {string[]} ID полученных достижений */
    this.unlocked = [];
    this._load();

    // Накапливаемая статистика
    this._initStats();

    // Подписки на события
    Events.on('order:completed', (r) => {
      this.stats.totalOrders++;
      this.stats.shiftOrders++;
      this.stats.totalEarned += r.pay + r.tips;
      this.stats.totalTips += r.tips;
      if (r.missionId) this.stats.totalMissions++;
    });
    Events.on('order:failed', () => {
      // просто триггер — проверка в checkAll
    });
    Events.on('crash', () => {
      this.stats.shiftCrashes++;
    });
    Events.on('hitPed', () => {
      this.stats.shiftPeds++;
    });
    Events.on('ped:punch', () => {
      this._lastPunchEventTime = Date.now();
      this.stats.shiftPunches++;
      this.stats.totalPunches++;
    });
    Events.on('police:fine', () => {
      this.stats.policeFines++;
      this.checkAll();
    });
    Events.on('shift:started', () => {
      this.stats.shiftOrders = 0;
      this.stats.shiftCrashes = 0;
      this.stats.shiftPeds = 0;
      this.stats.shiftPunches = 0;
    });
    Events.on('night:order', () => {
      this.stats.nightOrders++;
    });
  }

  _initStats() {
    this.stats = {
      totalOrders: 0,
      shiftOrders: 0,
      totalEarned: 0,
      totalTips: 0,
      totalMissions: 0,
      totalKm: 0,
      maxSpeedKmh: 0,
      maxRating: 0,
      nightOrders: 0,
      policeFines: 0,
      shiftCrashes: 0,
      shiftPeds: 0,
      shiftPunches: 0,
      totalPunches: 0,
      totalNearMisses: 0,
    };
  }

  /**
   * Обновить живую статистику (вызывается из game._drive).
   * @param {import('./player.js').PlayerCar} player
   * @param {number} rating
   * @param {number} dt
   */
  updateLiveStats(player, rating, dt) {
    const kmh = Math.abs(player.speed) * 3.6;
    if (kmh > this.stats.maxSpeedKmh) this.stats.maxSpeedKmh = kmh;
    if (rating > this.stats.maxRating) this.stats.maxRating = rating;
    this.stats.totalKm += player.speed * dt / 1000;
  }

  /**
   * Проверить все достижения. Вызывается после значимых событий.
   * @returns {Array<string>} ID новых открытых достижений
   */
  checkAll() {
    const newly = [];
    for (const ach of ACHIEVEMENTS) {
      if (this.unlocked.includes(ach.id)) continue;
      if (ach.check(this.stats)) {
        this.unlocked.push(ach.id);
        newly.push(ach.id);
        Events.emit('achievement:unlocked', ach);
        Events.emit('toast', { text: `${ach.icon} ` + (ach.toast || ('Достижение: ' + ach.name)) + '!', color: '#ffd75e' });
      }
    }
    if (newly.length) this._save();
    return newly;
  }

  /**
   * Получить список всех достижений с флагом открытости.
   * @returns {Array<{id, name, desc, icon, unlocked: boolean}>}
   */
  list() {
    return ACHIEVEMENTS.map(a => ({
      id: a.id, name: a.name, desc: a.desc, icon: a.icon,
      unlocked: this.unlocked.includes(a.id),
    }));
  }

  /**
   * Количество открытых / всего.
   */
  count() {
    return { unlocked: this.unlocked.length, total: ACHIEVEMENTS.length };
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.unlocked = JSON.parse(raw) || [];
    } catch (e) { this.unlocked = []; }
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.unlocked));
    } catch (e) { /* localStorage может быть недоступен */ }
  }

  /**
   * Зафиксировать удар по пешеходу.
   */
  onPunchPed() {
    const now = Date.now();
    if (!this._lastPunchEventTime || now - this._lastPunchEventTime > 50) {
      this.stats.shiftPunches++;
      this.stats.totalPunches++;
    }
    this._lastPunchEventTime = 0;
    this.checkAll();
  }

  /**
   * Загрузить накопленную статистику из сохранения игры.
   * @param {Object} stats - Статистика из save
   */
  loadStats(stats) {
    if (!stats) return;
    this.stats.totalOrders = stats.orders || 0;
    this.stats.totalEarned = stats.earned || 0;
    this.stats.totalTips = stats.tips || 0;
    this.stats.totalMissions = stats.missions || 0;
    this.stats.totalKm = stats.km || 0;
    this.stats.totalPunches = stats.punches || stats.totalPunches || 0;
    this.stats.totalNearMisses = stats.nearMisses || 0;
  }

  /**
   * Экспортировать статистику для сохранения в game.save().
   * @returns {Object}
   */
  exportStats() {
    return {
      orders: this.stats.totalOrders,
      earned: this.stats.totalEarned,
      tips: this.stats.totalTips,
      missions: this.stats.totalMissions,
      km: this.stats.totalKm,
      maxSpeed: this.stats.maxSpeedKmh,
      maxRating: this.stats.maxRating,
      nightOrders: this.stats.nightOrders,
      policeFines: this.stats.policeFines,
      punches: this.stats.totalPunches,
      totalPunches: this.stats.totalPunches,
      nearMisses: this.stats.totalNearMisses,
    };
  }
}
/* ============================================================
 * eventbus.js — EventBus (Event-Driven архитектура)
 * ============================================================ */

export class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  /**
   * Подписка на событие
   * @param {string} event
   * @param {Function} fn
   * @returns {Function} Функция отписки
   */
  on(event, fn) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(fn);
    return () => this.off(event, fn);
  }

  /**
   * Отписка от события
   * @param {string} event
   * @param {Function} fn
   */
  off(event, fn) {
    const list = this._listeners.get(event);
    if (list) {
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  /**
   * Генерация события
   * @param {string} event
   * @param {*} [data]
   */
  emit(event, data) {
    const list = this._listeners.get(event);
    if (list) {
      for (const fn of list.slice()) {
        try {
          fn(data);
        } catch (err) {
          console.error('[EventBus]', event, err);
        }
      }
    }
  }

  /**
   * Одноразовая подписка на событие
   * @param {string} event
   * @param {Function} fn
   * @returns {Function} Функция отписки
   */
  once(event, fn) {
    const wrapper = (data) => {
      this.off(event, wrapper);
      fn(data);
    };
    return this.on(event, wrapper);
  }
}

// Глобальный экземпляр EventBus
export const events = new EventBus();
export const Events = events;
window.events = events;
window.Events = events;

/* ============================================================
 * input.js — клавиатура, мышь (камера), сенсорное управление
 * ============================================================ */

export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

    // оси
    this.steer = 0;          // -1..1
    this.throttle = 0;       // 0..1
    this.brake = 0;          // 0..1
    this.handbrake = false;

    // очереди одноразовых действий
    this.queues = { interact: [], horn: [], lights: [], radio: [], map: [], pause: [], garage: [], punch: [] };

    // камера
    this.camYawDelta = 0;
    this.camPitchDelta = 0;
    this.camZoomDelta = 0;

    // пешеход
    this.walkForward = undefined;
    this.walkRight = undefined;
    this.camYaw = 0;
    this.isRunning = false;

    // сенсорный руль
    this.steerTouch = null;   // pointerId активного руля
    this.steerOrigin = 0;
    this.steerValue = 0;

    this._bindKeys();
    this._bindMouse();
    this._bindVisibility();
  }

  _bindKeys() {
    const down = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      const k = e.code;
      if (k === 'KeyE') this.queues.interact.push(1);
      if (k === 'KeyH') this.queues.horn.push(1);
      if (k === 'KeyL') this.queues.lights.push(1);
      if (k === 'KeyR') this.queues.radio.push(1);
      if (k === 'KeyM') this.queues.map.push(1);
      if (k === 'Escape' || k === 'KeyP') this.queues.pause.push(1);
      if (k === 'KeyG') this.queues.garage.push(1);
      if (k === 'KeyF') this.queues.punch.push(1);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyH', 'KeyL', 'KeyR', 'KeyM', 'KeyF', 'ShiftLeft', 'ShiftRight'].includes(k)) e.preventDefault();
    };
    const up = (e) => this.keys.delete(e.code);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
  }

  _bindMouse() {
    let dragging = false, lastX = 0, lastY = 0, startX = 0, startY = 0, startBtn = -1;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0 || e.button === 2) {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        startX = e.clientX;
        startY = e.clientY;
        startBtn = e.button;
      }
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.camYawDelta -= dx * 0.005;
      this.camPitchDelta += dy * 0.005;
    });
    window.addEventListener('pointerup', (e) => {
      if (dragging && startBtn === 0 && e.button === 0) {
        const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
        if (dist < 4) {
          this.queues.punch.push(1);
        }
      }
      dragging = false;
      startBtn = -1;
    });
    window.addEventListener('wheel', (e) => {
      // Не перехватывать скролл внутри меню/экранов — пусть карточки скроллятся
      if (e.target.closest('.screen, .card, #ach-list, #garage-list, #se-stats, #err-text')) return;
      e.preventDefault();
      this.camZoomDelta += e.deltaY > 0 ? 0.7 : -0.7;
    }, { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _bindVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) Events.emit('visibilityHidden');
    });
  }

  /* Обработка клавиш в оси (вызывается каждый кадр) */
  update(dt) {
    const k = this.keys;
    // клавиши педалей; на тач-устройствах газ/тормоз приходят из джойстика (UI)
    let gas = 0, brk = 0;
    if (k.has('ArrowUp') || k.has('KeyW')) gas = 1;
    if (k.has('ArrowDown') || k.has('KeyS')) brk = 1;
    const hbBtn = document.getElementById('btn-hb');
    this.throttle = gas;
    this.brake = brk;
    this.handbrake = (k.has('Space') && !this.isTouch) || (hbBtn && hbBtn._pressed);

    // руль: клавиатура + сенсорный слайдер (из UI)
    let steer = 0;
    if (k.has('ArrowLeft') || k.has('KeyA')) steer -= 1;
    if (k.has('ArrowRight') || k.has('KeyD')) steer += 1;
    steer += this.steerValue;
    this.steer = clamp(steer, -1, 1);

    // дельты камеры — обнуляются после применения в ChaseCamera
  }

  /* Снять одноразовые действия */
  take(action) {
    return this.queues[action].length > 0;
  }
  flush(action) {
    if (action) this.queues[action].length = 0;
    else for (const q in this.queues) this.queues[q].length = 0;
  }
}

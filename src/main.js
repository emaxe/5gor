import { Game } from './game.js';
import { showError as utilShowError } from './utils.js';

/* Глобальный оверлей ошибок: показываем любую непойманную ошибку */
let _errors = [];
window.addEventListener('error', (e) => {
  const msg = (e.message || '') + (e.filename ? '\n' + e.filename + ':' + e.lineno : '');
  showError(new Error(msg));
});
window.addEventListener('unhandledrejection', (e) => showError(e.reason || new Error('Unhandled rejection')));

function showError(err) {
  console.error(err);
  if (!document.getElementById('error-overlay')) return;
  _errors.push(String((err && err.stack) || err));
  if (_errors.length > 5) _errors.shift();
  document.getElementById('err-text').textContent = _errors.join('\n\n---\n\n');
  document.getElementById('error-overlay').classList.remove('hidden');
}

function boot() {
  try {
    const g = new Game();
    window.game = g;
  } catch (e) {
    showError(e);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

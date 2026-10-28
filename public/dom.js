import { state, VIEWS } from './state.js';

export const $ = (id) => document.getElementById(id);
let toastTimer = null;
let focusBeforeModal = null;

export function showView(name) {
  state.view = name;
  for (const view of VIEWS) $(`view-${view}`).classList.toggle('hidden', view !== name);
  $('header-user').textContent = ['menu', 'room', 'game', 'history'].includes(name) && state.username
    ? `玩家：${state.username}`
    : '';
  window.scrollTo(0, 0);
}

export function showMenu() {
  $('menu-welcome').textContent = `欢迎，${state.username}`;
  $('panel-create').classList.add('hidden');
  $('panel-join').classList.add('hidden');
  showView('menu');
}

export function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

export function connectionStatus(message = '') {
  const el = $('connection-status');
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

export function showModal(html, okLabel = '知道了', onOk = null) {
  focusBeforeModal = document.activeElement;
  $('modal-content').innerHTML = html;
  const ok = $('modal-ok');
  ok.textContent = okLabel || '';
  ok.classList.toggle('hidden', okLabel == null);
  ok.onclick = () => {
    hideModal();
    if (onOk) onOk();
  };
  $('modal-mask').classList.remove('hidden');
  if (okLabel != null) ok.focus();
}

export function hideModal() {
  $('modal-mask').classList.add('hidden');
  $('modal-content').innerHTML = '';
  $('modal-ok').onclick = null;
  if (focusBeforeModal && focusBeforeModal.isConnected) focusBeforeModal.focus();
  focusBeforeModal = null;
}

export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

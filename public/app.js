import { state, clearSelection } from './state.js';
import { $, hideModal, showMenu, showModal, showView, toast } from './dom.js';
import { act, connect, connected, logout, setWsHandlers } from './ws.js';
import { renderRoom } from './room.js';
import { playSelected, renderDice, renderGame, showResultModal } from './game.js';
import { openHistory } from './history.js';

let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  $('tab-login').classList.toggle('active', mode === 'login');
  $('tab-register').classList.toggle('active', mode === 'register');
  $('auth-submit').textContent = mode === 'login' ? '登录' : '注册';
  $('auth-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
}

function showAuth() {
  state.room = null;
  state.game = null;
  clearSelection();
  $('auth-error').textContent = '';
  setAuthMode(authMode);
  showView('auth');
}

async function submitAuth(event) {
  event.preventDefault();
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  $('auth-error').textContent = '';
  $('auth-submit').disabled = true;
  try {
    const res = await fetch(`/api/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
      $('auth-error').textContent = data.error || '操作失败';
      return;
    }
    state.username = data.username;
    $('auth-password').value = '';
    connect();
  } catch {
    $('auth-error').textContent = '无法连接服务器，请确认服务器已启动';
  } finally {
    $('auth-submit').disabled = false;
  }
}

function handleServer(msg) {
  if (msg.t === 'hello') {
    connected();
    state.username = msg.username;
    if (msg.hasRoom) {
      state.pendingRoom = '';
      history.replaceState(null, '', location.pathname);
    } else {
      showMenu();
      if (state.pendingRoom) {
        act({ t: 'joinRoom', code: state.pendingRoom });
        state.pendingRoom = '';
        history.replaceState(null, '', location.pathname);
      }
    }
    return;
  }
  if (msg.t === 'room') {
    state.room = msg;
    state.game = null;
    hideModal();
    showView('room');
    renderRoom(msg);
    return;
  }
  if (msg.t === 'game') {
    state.room = null;
    state.game = msg;
    if (msg.phase === 'dice') renderDice(msg);
    else {
      hideModal();
      state.shownDiceRoom = null;
    }
    showView('game');
    renderGame(msg);
    if (msg.phase === 'gameover' && state.shownResultRoom !== msg.roomCode) {
      state.shownResultRoom = msg.roomCode;
      showResultModal(msg);
    }
    return;
  }
  if (msg.t === 'aborted') {
    state.game = null;
    state.room = null;
    hideModal();
    showModal(`<h3>对局已终止</h3><p>${escMessage(msg.reason)}</p>`, '返回主界面', showMenu);
    return;
  }
  if (msg.t === 'roomClosed') {
    state.room = null;
    state.game = null;
    hideModal();
    toast(msg.reason || '房间已解散');
    showMenu();
    return;
  }
  if (msg.t === 'left') {
    state.room = null;
    state.game = null;
    hideModal();
    showMenu();
    return;
  }
  if (msg.t === 'sessionKick') {
    toast('你的账号已在其他设备登录');
    logout(false).then(showAuth);
    return;
  }
  if (msg.t === 'error') toast(msg.message);
}

function escMessage(message) {
  const span = document.createElement('span');
  span.textContent = message || '';
  return span.innerHTML;
}

async function logoutAndShowAuth() {
  await logout(true);
  showAuth();
}

function init() {
  localStorage.removeItem('ma_token');
  localStorage.removeItem('ma_username');
  setWsHandlers({ onMessage: handleServer, onAuthExpired: showAuth });
  $('tab-login').onclick = () => setAuthMode('login');
  $('tab-register').onclick = () => setAuthMode('register');
  $('auth-form').onsubmit = submitAuth;
  document.querySelectorAll('[data-nav="rules"]').forEach((button) => {
    button.onclick = () => showView('rules');
  });
  document.querySelectorAll('[data-nav="history"]').forEach((button) => {
    button.onclick = openHistory;
  });
  document.querySelectorAll('.back-to-menu').forEach((button) => {
    button.onclick = showMenu;
  });
  $('view-menu').querySelector('[data-nav="create"]').onclick = () => {
    $('panel-join').classList.add('hidden');
    $('panel-create').classList.toggle('hidden');
  };
  $('view-menu').querySelector('[data-nav="join"]').onclick = () => {
    $('panel-create').classList.add('hidden');
    $('panel-join').classList.toggle('hidden');
  };
  $('view-menu').querySelector('[data-nav="logout"]').onclick = logoutAndShowAuth;
  document.querySelectorAll('.cap-btn').forEach((button) => {
    button.onclick = () => {
      act({ t: 'createRoom', capacity: Number(button.dataset.cap) });
      $('panel-create').classList.add('hidden');
    };
  });
  $('cancel-create').onclick = () => $('panel-create').classList.add('hidden');
  $('join-submit').onclick = () => {
    const code = $('join-code').value.trim();
    if (!/^\d{4}$/.test(code)) return toast('请输入四位数字房间码');
    act({ t: 'joinRoom', code });
  };
  $('cancel-join').onclick = () => $('panel-join').classList.add('hidden');
  $('join-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('join-submit').click();
  });
  $('copy-link').onclick = () => {
    const text = state.room ? `${location.origin}/?room=${state.room.roomCode}` : '';
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('邀请链接已复制'), () => toast(text));
    else toast(text);
  };
  $('leave-room').onclick = () => act({ t: 'leaveRoom' });
  $('quit-game').onclick = () => {
    const phase = state.game && state.game.phase;
    if (phase === 'gameover') {
      act({ t: 'returnMenu' });
      showMenu();
      return;
    }
    if (phase === 'dice' || phase === 'play') {
      if (window.confirm('退出将立即终止本局并记录“主动退出”异常，确定退出吗？')) act({ t: 'quitGame' });
    }
  };
  $('play-selected').onclick = playSelected;
  fetch('/api/session').then(async (res) => {
    if (!res.ok) {
      showAuth();
      return;
    }
    const data = await res.json();
    state.username = data.username;
    connect();
  }).catch(showAuth);
}

document.addEventListener('DOMContentLoaded', init);

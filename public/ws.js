import { state } from './state.js';
import { connectionStatus, showModal, toast } from './dom.js';

let messageHandler = () => {};
let authExpiredHandler = () => {};

export function setWsHandlers({ onMessage, onAuthExpired }) {
  messageHandler = onMessage;
  authExpiredHandler = onAuthExpired;
}

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${location.host}/ws`;
}

export function act(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  toast('连接已断开，正在等待重连');
  return false;
}

export function connect() {
  if (state.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.ws.readyState)) return;
  clearTimeout(state.reconnectTimer);
  state.wsIntentional = false;
  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  connectionStatus(state.reconnectTries ? '正在重新连接服务器…' : '正在连接服务器…');
  ws.onmessage = (event) => {
    try {
      messageHandler(JSON.parse(event.data));
    } catch {
      toast('收到无法识别的服务器消息');
    }
  };
  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
    if (state.wsIntentional) {
      connectionStatus();
      return;
    }
    state.reconnectTries++;
    if (state.reconnectTries <= 5) {
      connectionStatus(`连接断开，正在重连（${state.reconnectTries}/5）…`);
      state.reconnectTimer = setTimeout(connect, 1200 * state.reconnectTries);
    } else {
      connectionStatus('无法连接服务器');
      showModal('与服务器的连接已断开，请重新登录。', '重新登录', authExpiredHandler);
    }
  };
  ws.onerror = () => {
    if (state.ws === ws) state.ws = null;
  };
}

export function connected() {
  state.reconnectTries = 0;
  clearTimeout(state.reconnectTimer);
  connectionStatus();
}

export async function logout(notifyServer = true) {
  state.wsIntentional = true;
  clearTimeout(state.reconnectTimer);
  if (state.ws) {
    try { state.ws.close(); } catch { /* already closed */ }
  }
  state.ws = null;
  state.username = '';
  state.room = null;
  state.game = null;
  connectionStatus();
  if (notifyServer) {
    try { await fetch('/api/logout', { method: 'POST' }); } catch { /* local logout still applies */ }
  }
}

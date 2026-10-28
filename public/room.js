import { state } from './state.js';
import { $, esc } from './dom.js';
import { act } from './ws.js';

export function renderRoom(room) {
  $('room-code').textContent = room.roomCode;
  const share = `${location.origin}/?room=${room.roomCode}`;
  $('room-share').innerHTML = `分享链接（可直接打开加入）：<input class="link-text" readonly value="${esc(share)}">`;
  $('room-count').textContent = `玩家 ${room.players.length}/${room.capacity}`;
  const list = $('lobby-players');
  list.innerHTML = '';
  for (const player of room.players) {
    const item = document.createElement('li');
    const left = document.createElement('span');
    left.innerHTML = `${esc(player.username)} ${player.isHost ? '<span class="badge-host">房主</span>' : ''} ${player.username === state.username ? '<span class="you-tag">你</span>' : ''} ${player.connected === false ? '<span class="offline-tag">离线</span>' : ''}`;
    item.appendChild(left);
    if (player.isHost) {
      item.appendChild(document.createElement('span'));
    } else if (state.username === room.host) {
      const button = document.createElement('button');
      button.className = 'danger small';
      button.textContent = '移出';
      button.onclick = () => act({ t: 'kick', username: player.username });
      item.appendChild(button);
    }
    list.appendChild(item);
  }
  const isHost = state.username === room.host;
  const start = $('start-game');
  start.disabled = !(isHost && room.canStart);
  start.onclick = () => act({ t: 'startGame' });
  start.textContent = isHost
    ? (room.canStart ? '开始游戏' : `等待玩家加入（${room.players.length}/${room.capacity}）`)
    : '等待房主开始…';
}

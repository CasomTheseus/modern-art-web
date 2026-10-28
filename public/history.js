import { ABNORMAL_ZH } from './state.js';
import { $, esc, showView } from './dom.js';

export async function openHistory() {
  showView('history');
  const list = $('history-list');
  list.innerHTML = '<p class="hint">加载中…</p>';
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载失败');
    if (!data.matches.length) {
      list.innerHTML = '<p class="hint">还没有对局记录，去创建或加入房间吧。</p>';
      return;
    }
    list.innerHTML = '';
    for (const match of data.matches) {
      const item = document.createElement('div');
      item.className = 'match-item';
      const when = new Date(match.time).toLocaleString('zh-CN', { hour12: false });
      if (match.kind === 'normal') {
        const rows = match.players.slice().sort((a, b) => a.rank - b.rank)
          .map((player) => `<div>第 ${player.rank} 名　${esc(player.username)}　资产 ¥${player.cash}</div>`).join('');
        item.innerHTML = `<div class="m-head"><span class="m-type-normal">正常对局</span><span>房间 ${esc(match.roomCode)}</span><span>${esc(when)}</span></div>${rows}`;
      } else {
        item.innerHTML = `<div class="m-head"><span class="m-type-abnormal">异常对局 · ${esc(ABNORMAL_ZH[match.type] || match.type)}</span><span>房间 ${esc(match.roomCode)}</span><span>${esc(when)}</span></div>
          <div>触发玩家：${esc(match.trigger)}</div><div>当局玩家：${match.players.map(esc).join('、')}</div>`;
      }
      list.appendChild(item);
    }
  } catch (err) {
    list.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

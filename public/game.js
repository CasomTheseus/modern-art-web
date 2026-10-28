import { state, clearSelection } from './state.js';
import { $, esc, hideModal, showMenu, showModal } from './dom.js';
import { act } from './ws.js';

const AUCTION_ZH = { open: '公开拍卖', once: '一轮拍卖', sealed: '暗标拍卖', fixed: '定价拍卖' };

function syncAuctionDraft(game) {
  const key = game.auction
    ? `${game.roomCode}:${game.round}:${game.auction.auctioneerSeat}:${game.auction.lot.map((card) => card.id).join(',')}`
    : null;
  if (key !== state.draftAuctionKey) {
    state.draftAuctionKey = key;
    state.drafts = { bid: '', sealed: '', fixed: '' };
  }
}

export function renderGame(game) {
  syncAuctionDraft(game);
  $('game-room-code').textContent = game.roomCode;
  $('game-round').textContent = `第 ${Math.min(game.round, 4)} 轮 / 共 4 轮`;
  $('game-dir').textContent = game.phase === 'play' ? `方向：${game.direction}` : '';
  $('game-status').textContent = statusText(game);
  $('quit-game').textContent = game.phase === 'gameover' ? '返回主界面' : '退出对局';
  renderPlayers(game);
  renderBoard(game);
  renderAuction(game);
  renderLog(game);
  renderHand(game);
}

function statusText(game) {
  if (game.phase === 'dice') return '开局随机先手中…';
  if (game.phase === 'gameover') return '对局结束';
  if (game.auction) {
    const auction = game.auction;
    if (auction.kind === 'open') return `公开拍卖自由出价 · ${auction.activeSeats.length} 人未弃权`;
    if (auction.kind === 'sealed') {
      if (auction.stage === 'sealed') return '暗标出价中（等待全员确认）';
      if (auction.stage === 'countdown') return '全员已确认，3 秒后揭晓';
      return '暗标已揭晓，即将结算';
    }
    if (auction.nextSpeakerSeat != null) return `${auction.nextSpeakerName} 正在出价`;
    if (auction.kind === 'fixed' && auction.stage === 'price') return `${auction.auctioneerName} 正在定价`;
    if (auction.kind === 'fixed' && auction.nextBuyerSeat != null) return `${auction.nextBuyerName} 正在决定是否购买`;
    return '拍卖进行中';
  }
  const turn = game.players[game.turnSeat];
  return turn && turn.seat === game.mySeat ? '轮到你出牌' : `等待 ${turn ? turn.username : '?'} 出牌`;
}

function renderPlayers(game) {
  const strip = $('players-strip');
  strip.innerHTML = '';
  for (const player of game.players) {
    const div = document.createElement('div');
    div.className = 'player-card'
      + (player.isTurn || (game.auction && game.auction.auctioneerSeat === player.seat) ? ' active' : '')
      + (player.connected === false ? ' offline' : '');
    const head = document.createElement('div');
    head.className = 'p-head';
    const cash = player.seat === game.mySeat
      ? `<span class="p-cash">¥${player.cash}</span>`
      : '<span class="cash-hidden">现金保密</span>';
    head.innerHTML = `<span class="p-name">${esc(player.username)}${player.seat === game.mySeat ? ' <span class="you-tag">你</span>' : ''}</span>${cash}`;
    const meta = document.createElement('div');
    meta.className = 'p-meta';
    meta.innerHTML = `座位 ${player.seat}${player.isTurn ? ' · <span class="turn-tag">出牌中</span>' : ''} · 手牌 ${player.handCount} 张${player.connected === false ? ' · <span class="offline-tag">离线，等待重连</span>' : ''}`;
    const lots = document.createElement('div');
    lots.className = 'p-lots';
    if (!player.lots.length) {
      lots.innerHTML = '<span class="hint">（公开区为空）</span>';
    } else {
      for (const lot of player.lots) {
        const lotCards = document.createElement('div');
        lotCards.className = 'lot-cards';
        for (const card of lot.cards) {
          const el = document.createElement('div');
          el.className = 'card small' + (lot.cards.length === 2 ? ' lot-double' : '');
          el.style.setProperty('--c', card.color);
          el.innerHTML = `<span class="card-artist">${esc(card.colorName)}·${esc(card.artistKey.toUpperCase())}</span><span class="card-type">${esc(card.typeShort)}</span>`;
          el.title = `${card.typeLabel} · 成交 ${lot.price} 元`;
          lotCards.appendChild(el);
        }
        lots.appendChild(lotCards);
      }
    }
    div.append(head, meta, lots);
    strip.appendChild(div);
  }
}

function renderBoard(game) {
  const board = $('board');
  board.innerHTML = '';
  const roundCells = ['第 1 轮', '第 2 轮', '第 3 轮', '第 4 轮'];
  for (const artist of game.artists) {
    const col = document.createElement('div');
    col.className = 'col';
    const head = document.createElement('div');
    head.className = 'col-head';
    head.style.background = `linear-gradient(180deg, ${artist.color}, ${artist.color}cc)`;
    head.innerHTML = `<div class="artist-name">${esc(artist.colorName)}·${esc(artist.key.toUpperCase())}</div><div class="artist-key">${esc(artist.colorName)}色艺术家</div>`;
    const count = document.createElement('div');
    count.className = 'col-count';
    count.textContent = `本轮公开 ${artist.publicCount} / 5`;
    col.append(head, count);
    for (let round = 0; round < 4; round++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const value = artist.roundValues[round];
      if (round >= game.round - 1) {
        cell.classList.add('empty');
        cell.textContent = roundCells[round];
      } else if (value > 0) {
        cell.classList.add('plus');
        cell.textContent = `+${value} 元`;
      } else {
        cell.textContent = '0';
      }
      col.appendChild(cell);
    }
    const total = document.createElement('div');
    total.className = 'cell total';
    total.textContent = `总价值 ${artist.total || 0}`;
    col.appendChild(total);
    board.appendChild(col);
  }
}

function bidControls(game, auction) {
  const min = (auction.highBid == null ? 0 : auction.highBid) + 1;
  const max = game.players[game.mySeat].cash;
  const canBid = min <= max;
  const draft = state.drafts.bid === '' ? String(canBid ? min : 0) : state.drafts.bid;
  return `<div class="act-row">
    <input id="bid-input" aria-label="叫价" type="number" min="${min}" max="${max}" step="1" value="${esc(draft)}" ${canBid ? '' : 'disabled'}>
    <button id="btn-bid" class="primary" ${canBid ? '' : 'disabled'}>出价</button>
    <button id="btn-pass" class="ghost">弃权</button></div>
    <div class="sealed-status">你的现金 ¥${max}${canBid ? '' : '（现金不足，只能弃权）'}</div>`;
}

function renderAuction(game) {
  const panel = $('auction-panel');
  if (!game.auction) {
    if (game.phase === 'play') {
      const mine = game.turnSeat === game.mySeat;
      panel.innerHTML = `<div class="auction-title">当前回合</div><div class="auction-info">${mine
        ? '<b>轮到你出牌</b>：从下方手牌选择一张画打出（联合画需要再选一张同色画绑定）。'
        : `等待 <b>${esc(game.players[game.turnSeat]?.username || '?')}</b> 打出画作。`}</div>`;
    } else if (game.phase === 'gameover') {
      panel.innerHTML = '<div class="auction-wait">对局已结束，查看下方结算结果。</div>';
    } else {
      panel.innerHTML = '<div class="auction-wait">对局尚未开始…</div>';
    }
    return;
  }
  const auction = game.auction;
  let html = `<div class="auction-title">${AUCTION_ZH[auction.kind]}${auction.double ? '（联合 lot，价格按两张合计）' : ''}</div>`;
  html += `<div class="auction-info">拍卖者：<b>${esc(auction.auctioneerName)}</b> · 当前拍品：</div><div class="auction-lot">`;
  for (const card of auction.lot) {
    html += `<div class="card ${auction.double ? 'lot-double' : ''}" style="--c:${esc(card.color)};cursor:default">
      <span class="card-artist">${esc(card.colorName)}·${esc(card.artistKey.toUpperCase())}</span><span class="card-type">${esc(card.typeLabel)}</span></div>`;
  }
  html += '</div>';

  if (auction.kind === 'open' || auction.kind === 'once') {
    html += `<div class="auction-info">最高叫价：${auction.highBid == null ? '尚无' : `<b>¥${auction.highBid}</b>（${esc(auction.highBidderName)}）`}</div>`;
    if (auction.kind === 'open') {
      const active = auction.activeSeats.includes(game.mySeat);
      const highest = auction.highBidderSeat === game.mySeat;
      html += `<div class="sealed-status">自由加价，${auction.activeSeats.length} 人尚未弃权</div>`;
      if (active && !highest) html += bidControls(game, auction);
      else if (highest) html += '<div class="auction-wait">你是当前最高价者，等待其他玩家加价或弃权。</div>';
      else html += '<div class="auction-wait">你已弃权，等待拍卖结束。</div>';
    } else if (auction.nextSpeakerSeat == null) {
      html += '<div class="auction-wait">拍卖结算中…</div>';
    } else if (auction.nextSpeakerSeat === game.mySeat) {
      html += bidControls(game, auction);
      html += '<div class="sealed-status">一轮拍卖每人只有一次叫价或弃权机会</div>';
    } else {
      html += `<div class="auction-wait">等待 <b>${esc(auction.nextSpeakerName)}</b> 叫价或弃权…</div>`;
    }
  }

  if (auction.kind === 'sealed') {
    const confirmedCount = auction.confirmed.filter(Boolean).length;
    if (auction.stage === 'sealed') {
      const mine = auction.confirmed[game.mySeat];
      const cash = game.players[game.mySeat].cash;
      html += `<div class="auction-info">所有玩家秘密出价 0～自己的现金，全部确认后 3 秒同时揭晓。</div>`;
      html += `<div class="sealed-status">已确认 ${confirmedCount}/${game.players.length}</div>`;
      if (!mine) {
        const draft = state.drafts.sealed === '' ? '0' : state.drafts.sealed;
        html += `<div class="act-row"><input id="sealed-input" aria-label="暗标出价" type="number" min="0" max="${cash}" step="1" value="${esc(draft)}">
          <button id="btn-sealed-confirm" class="primary">确认暗标</button></div>`;
      } else {
        html += `<div class="auction-wait">你已确认出价 ¥${auction.myAmount}，等待其他玩家确认…</div>`;
      }
    } else if (auction.stage === 'countdown') {
      html += '<div class="auction-wait">所有玩家已确认，<b>3 秒后同时揭晓！</b></div>';
    } else if (auction.stage === 'revealed') {
      html += '<div class="auction-info">揭晓结果：</div><ul class="results-list">';
      for (const item of auction.amounts) {
        const winner = item.seat === auction.winnerSeat;
        html += `<li class="${winner ? 'result-rank-1' : ''}"><span>${esc(item.username)}${item.seat === game.mySeat ? '（你）' : ''}</span><span>¥${item.amount}${winner ? ' ← 得主' : ''}</span></li>`;
      }
      html += `</ul><div class="auction-wait">${auction.winnerSeat == null ? '全部为 0，画作归拍卖者' : '3 秒后结算…'}</div>`;
    }
  }

  if (auction.kind === 'fixed') {
    if (auction.stage === 'price') {
      if (auction.auctioneerSeat === game.mySeat) {
        const cash = game.players[game.mySeat].cash;
        const draft = state.drafts.fixed === '' ? '0' : state.drafts.fixed;
        html += `<div class="act-row"><input id="fixed-input" aria-label="定价" type="number" min="0" max="${cash}" step="1" value="${esc(draft)}">
          <button id="btn-fixed-price" class="primary">确定定价</button></div><div class="sealed-status">无人购买时你将按此价自购。</div>`;
      } else {
        html += `<div class="auction-wait">等待 <b>${esc(auction.auctioneerName)}</b> 设定价格…</div>`;
      }
    } else {
      html += `<div class="auction-info">定价：<b>¥${auction.price}</b></div>`;
      if (auction.nextBuyerSeat === game.mySeat) {
        const cash = game.players[game.mySeat].cash;
        if (cash < auction.price) {
          html += `<div class="auction-wait">你的现金 ¥${cash} 不足以购买，请放弃。</div><div class="act-row"><button id="btn-fixed-pass" class="ghost">放弃</button></div>`;
        } else {
          html += `<div class="act-row"><button id="btn-fixed-buy" class="primary">以 ¥${auction.price} 购买</button><button id="btn-fixed-pass" class="ghost">放弃</button></div>`;
        }
      } else {
        html += `<div class="auction-wait">等待 <b>${esc(auction.nextBuyerName || '其他玩家')}</b> 决定是否购买…</div>`;
      }
    }
  }
  panel.innerHTML = html;
  bindAuctionActions();
}

function inputVal(id) {
  const el = $(id);
  if (!el || el.value.trim() === '') return null;
  const value = Number(el.value);
  return Number.isInteger(value) ? value : null;
}

function bindAuctionActions() {
  const bind = (id, fn) => {
    const el = $(id);
    if (el) el.onclick = fn;
  };
  const draft = (id, key) => {
    const el = $(id);
    if (el) el.oninput = () => { state.drafts[key] = el.value; };
  };
  draft('bid-input', 'bid');
  draft('sealed-input', 'sealed');
  draft('fixed-input', 'fixed');
  bind('btn-bid', () => {
    const value = inputVal('bid-input');
    if (value == null) return;
    if (act({ t: 'bid', amount: value })) state.drafts.bid = '';
  });
  bind('btn-pass', () => act({ t: 'pass' }));
  bind('btn-sealed-confirm', () => {
    const value = inputVal('sealed-input');
    if (value == null) return;
    if (act({ t: 'sealedBid', amount: value })) act({ t: 'sealedConfirm' });
  });
  bind('btn-fixed-price', () => {
    const value = inputVal('fixed-input');
    if (value != null) act({ t: 'fixedPrice', amount: value });
  });
  bind('btn-fixed-buy', () => act({ t: 'fixedDecision', buy: true }));
  bind('btn-fixed-pass', () => act({ t: 'fixedDecision', buy: false }));
}

function renderLog(game) {
  const list = $('log-list');
  list.innerHTML = '';
  for (const item of game.log.slice(-30)) {
    const div = document.createElement('div');
    div.textContent = `[第${item.round}轮] ${item.text}`;
    list.appendChild(div);
  }
  list.scrollTop = list.scrollHeight;
}

function renderHand(game) {
  const mine = game.players[game.mySeat];
  const canPick = game.phase === 'play' && !game.auction && game.turnSeat === game.mySeat;
  $('hand-count').textContent = mine ? mine.handCount : 0;
  const handEl = $('hand');
  handEl.innerHTML = '';
  if (!game.hand.length) handEl.innerHTML = '<div class="auction-wait">手牌为空</div>';
  for (const card of game.hand) {
    const selected = state.selMain === card.id;
    let cls = selected ? 'selected' : '';
    let canPartner = false;
    if (state.selMain && canPick) {
      const main = game.hand.find((item) => item.id === state.selMain);
      if (main && main.double && card.id !== main.id && !card.double && card.artist === main.artist) {
        canPartner = true;
        if (state.selPartner === card.id) cls += ' partner-ok';
      }
    }
    const button = document.createElement('button');
    button.className = `card ${cls}`.trim();
    button.style.setProperty('--c', card.color);
    button.innerHTML = `<span class="card-artist">${esc(card.colorName)}·${esc(card.artistKey.toUpperCase())}</span><span class="card-type">${esc(card.typeLabel)}</span>`;
    button.disabled = !canPick;
    button.onclick = () => pickCard(game, card, canPartner);
    handEl.appendChild(button);
  }
  const hint = $('hand-hint');
  const playButton = $('play-selected');
  if (state.selMain) {
    const main = game.hand.find((card) => card.id === state.selMain);
    if (main && main.double) {
      hint.textContent = state.selPartner ? '已选择联合 lot，可打出' : '联合画需再选一张同色非联合画';
      playButton.classList.toggle('hidden', !state.selPartner);
    } else {
      hint.textContent = '已选中画作，可打出';
      playButton.classList.remove('hidden');
    }
  } else {
    hint.textContent = canPick ? '点击手牌选择要拍卖的画' : '';
    playButton.classList.add('hidden');
  }
  playButton.onclick = playSelected;
}

function pickCard(game, card, canPartner) {
  if (state.selMain && canPartner && card.id !== state.selMain) {
    state.selPartner = state.selPartner === card.id ? null : card.id;
  } else if (state.selMain === card.id) {
    clearSelection();
  } else {
    state.selMain = card.id;
    state.selPartner = null;
  }
  renderHand(game);
}

export function playSelected() {
  if (!state.selMain) return;
  const action = { t: 'playLot', cardId: state.selMain, partnerId: state.selPartner };
  if (act(action)) clearSelection();
}

export function renderDice(game) {
  if (state.shownDiceRoom === game.roomCode) return;
  state.shownDiceRoom = game.roomCode;
  const starter = game.players[game.starterSeat];
  let frame = 0;
  showModal('<div class="dice-overlay"><h3>开局随机先手</h3><div class="dice rolling" id="dice-face">6</div><p class="hint">随机结果对人数取余，决定第 1 轮先手</p></div>', null, null);
  const timer = setInterval(() => {
    frame++;
    const face = $('dice-face');
    if (!face) {
      clearInterval(timer);
      return;
    }
    if (frame <= 28) face.textContent = String(1 + Math.floor(Math.random() * 6));
    else if (frame === 30) {
      face.classList.remove('rolling');
      face.textContent = String(game.diceRoll);
    } else if (frame === 45) {
      clearInterval(timer);
      if (state.game && state.game.phase === 'dice') {
        showModal(`<div class="dice-overlay"><h3>随机点数 ${game.diceRoll}</h3><p>第 1 轮先手：<b>${esc(starter ? starter.username : '?')}</b>（座位 ${game.starterSeat}）</p><p class="hint">本局按顺时针行动</p></div>`, null, null);
      }
    }
  }, 100);
}

export function showResultModal(game) {
  let html = '<h3>游戏结束</h3><ol class="results-list">';
  for (const rank of game.result.ranks) {
    html += `<li><span class="result-rank-1">第 ${rank.rank} 名</span><span>${esc(rank.username)} · 资产 ¥${rank.cash}</span></li>`;
  }
  html += '</ol><p class="hint">本局战绩已保存到服务器</p>';
  showModal(html, '返回主界面', () => {
    act({ t: 'returnMenu' });
    showMenu();
  });
}

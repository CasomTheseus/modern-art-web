// 《现代艺术》核心规则引擎（纯逻辑，服务端权威，无 IO/计时器）

import { buildDeck, ARTISTS, AUCTION_TYPES } from './cards.js';

export class EngineError extends Error {
  constructor(message, code = 'INVALID_ACTION') {
    super(message);
    this.code = code;
  }
}

const ROUND_AWARDS = [30, 20, 10];
const START_CASH = 100;
const CARDS_PER_ROUND = {
  3: [10, 6, 6, 0],
  4: [9, 4, 4, 0],
  5: [8, 3, 3, 0]
};

export function mod(x, n) {
  return ((x % n) + n) % n;
}

export function nextSeat(game, seat, step = 1) {
  return mod(seat + game.direction * step, game.players.length);
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function playerName(game, seat) {
  return `${game.players[seat].username}`;
}

function addLog(game, text) {
  game.log.push({ round: game.round, text });
  if (game.log.length > 200) game.log = game.log.slice(-200);
}

function drawCards(game, count) {
  if (count > game.deck.length) throw new EngineError('牌堆剩余卡牌不足', 'DECK_EXHAUSTED');
  return game.deck.splice(game.deck.length - count, count);
}

function cardById(game, id) {
  const c = game.cardsById[id];
  if (!c) throw new EngineError('无效的画作 ID');
  return c;
}

export function artistLabel(i) {
  return `${ARTISTS[i].colorName}·${ARTISTS[i].key.toUpperCase()}`;
}

/** 当前轮某艺术家在公开区的画作数量（跨所有玩家） */
export function publicCountOfArtist(game, artist) {
  let n = 0;
  for (const p of game.players) {
    for (const lot of p.publicLots) {
      if (lot.round !== game.round) continue;
      for (const id of lot.cardIds) {
        if (game.cardsById[id].artist === artist) n++;
      }
    }
  }
  return n;
}

function hasPlayableCards(game, seat) {
  const p = game.players[seat];
  if (!p || p.hand.length === 0) return false;
  for (const id of p.hand) {
    const c = cardById(game, id);
    if (c.type !== 'double') return true;
  }
  // 只剩联合牌：需存在同色非联合牌可配对
  for (const id of p.hand) {
    const c = cardById(game, id);
    if (c.type !== 'double') continue;
    for (const otherId of p.hand) {
      if (otherId === id) continue;
      const o = cardById(game, otherId);
      if (o.artist === c.artist && o.type !== 'double') return true;
    }
  }
  return false;
}

/** 从 turnSeat 起沿固定方向找到第一个能出牌的玩家；全都不能出则返回 false */
export function ensureTurn(game) {
  const n = game.players.length;
  const start = game.turnSeat == null ? game.starterSeat : game.turnSeat;
  for (let step = 0; step < n; step++) {
    const seat = mod(start + game.direction * step, n);
    if (hasPlayableCards(game, seat)) {
      game.turnSeat = seat;
      return true;
    }
  }
  return false;
}

/**
 * 创建一局游戏。
 * users: [{userId, username}]，按加入房间顺序，长度 3..5。
 */
export function createGame({ code, users, rng = Math.random }) {
  const n = users.length;
  if (n < 3 || n > 5) throw new EngineError('玩家人数必须为 3-5 人');
  const cards = buildDeck();
  const cardsById = {};
  for (const c of cards) cardsById[c.id] = c;
  const deck = shuffle(cards.map((c) => c.id), rng);
  const diceRoll = 1 + Math.floor(rng() * 6);
  const starterSeat = diceRoll % n;
  const game = {
    code,
    phase: 'dice',
    round: 1,
    direction: 1,
    diceRoll,
    starterSeat,
    turnSeat: null,
    deck,
    discard: [],
    cardsById,
    players: users.map((u, i) => ({
      userId: u.userId,
      username: u.username,
      seat: i,
      cash: START_CASH,
      hand: [],
      publicLots: []
    })),
    artistValues: Array.from({ length: 5 }, () => ({ total: 0, rounds: [0, 0, 0, 0] })),
    auction: null,
    log: [],
    result: null,
    abort: null
  };
  for (const p of game.players) {
    p.hand = drawCards(game, CARDS_PER_ROUND[n][0]);
  }
  return game;
}

/** 骰子动画结束（由服务端计时器调用），进入第 1 轮出牌 */
export function afterDice(game) {
  if (game.phase !== 'dice') throw new EngineError('当前不在开局动画阶段');
  game.phase = 'play';
  game.turnSeat = game.starterSeat;
  addLog(game, `开局：骰子点数 ${game.diceRoll}，玩家 ${playerName(game, game.starterSeat)} 获得第 1 轮先手`);
  if (!ensureTurn(game)) settleRound(game, '开局无牌可打');
}

// ---------------- 出牌与拍卖 ----------------

/**
 * 出牌（一轮一次 / 联合一次两张）。
 * cardId：要打出的画；partnerId：联合拍卖时绑定的同色非联合画。
 * 返回 { ok, trigger?: boolean, kind?: string }
 */
export function playLot(game, seat, cardId, partnerId = null) {
  if (game.phase !== 'play') throw new EngineError('当前不能出牌');
  if (game.auction) throw new EngineError('当前拍卖尚未结束');
  if (game.turnSeat !== seat) throw new EngineError('还没轮到你出牌');
  const p = game.players[seat];
  if (!p.hand.includes(cardId)) throw new EngineError('手牌中没有这张画');
  const card = cardById(game, cardId);

  let lotIds = [cardId];
  if (card.type === 'double') {
    if (!partnerId) throw new EngineError('联合拍卖必须绑定一张同色非联合画');
    if (partnerId === cardId || !p.hand.includes(partnerId)) throw new EngineError('绑定画不在手牌中');
    const partner = cardById(game, partnerId);
    if (partner.artist !== card.artist) throw new EngineError('绑定画必须与联合画同属一名艺术家');
    if (partner.type === 'double') throw new EngineError('不能绑定另一张联合拍卖的画');
    lotIds = [cardId, partnerId];
  } else if (partnerId) {
    throw new EngineError('只有联合拍卖需要绑定其他画');
  }

  // 从手牌移除本 lot
  for (const id of lotIds) {
    p.hand.splice(p.hand.indexOf(id), 1);
  }

  // 第 5 张同色画被提出拍卖时，整 lot 弃置并立即结算。
  const lotByArtist = {};
  for (const id of lotIds) {
    const c = cardById(game, id);
    lotByArtist[c.artist] = (lotByArtist[c.artist] || 0) + 1;
  }
  for (const artist of Object.keys(lotByArtist).map(Number)) {
    if (publicCountOfArtist(game, artist) + lotByArtist[artist] >= 5) {
      game.discard.push(...lotIds);
      addLog(game, `${playerName(game, seat)} 准备拍卖 ${artistLabel(artist)} 画作，但该色公开画已达上限，本 lot 弃置并结算当轮`);
      settleRound(game, `触发结算：${artistLabel(artist)} 公开画达到上限`);
      return { ok: true, trigger: true };
    }
  }

  // 拍卖方式：联合 lot 取被绑定画的方式；单张取其自身方式
  const kind = card.type === 'double' ? cardById(game, partnerId).type : card.type;
  const n = game.players.length;
  const auction = {
    kind,
    lotIds,
    round: game.round,
    auctioneer: seat,
    stage: 'bid',
    bid: null,
    bidderSeat: null,
    activeSeats: Array.from({ length: n }, (_, i) => i),
    spokenSeats: [],
    lastSpeakerSeat: null,
    passedSeats: [],
    amounts: Array.from({ length: n }, () => null),
    confirmedSeats: Array.from({ length: n }, () => false),
    price: null,
    winnerSeat: null,
    winnerAmount: null
  };

  if (kind === 'sealed') auction.stage = 'sealed';
  else if (kind === 'fixed') auction.stage = 'price';
  game.auction = auction;

  const lotText = lotIds.map((id) => artistLabel(cardById(game, id).artist)).join(' + ');
  addLog(game, `${playerName(game, seat)} 打出 ${lotText}，开始${AUCTION_TYPES[kind].label}`);
  return { ok: true, kind };
}

function checkAuctionKind(game, allowed) {
  const a = game.auction;
  if (!a || !allowed.includes(a.kind)) throw new EngineError('当前没有进行中的该类型拍卖');
  return a;
}

function validateBidAmount(game, seat, amount, a) {
  if (!Number.isInteger(amount)) throw new EngineError('叫价必须是整数');
  const p = game.players[seat];
  if (amount > p.cash) throw new EngineError(`叫价不能超过你的现金（${p.cash} 元）`);
  if (a.bid == null) {
    if (amount < 1) throw new EngineError('首次叫价至少为 1 元');
  } else if (amount <= a.bid) {
    throw new EngineError(`叫价必须高于当前最高价 ${a.bid} 元`);
  }
}

function onceNextSpeaker(game) {
  const a = game.auction;
  const n = game.players.length;
  for (let step = 1; step <= n; step++) {
    const cand = mod(a.auctioneer + game.direction * step, n);
    if (!a.spokenSeats.includes(cand)) return cand;
  }
  return null;
}

function openShouldResolve(game) {
  const a = game.auction;
  if (a.bid != null) {
    return a.activeSeats.length === 1 && a.activeSeats[0] === a.bidderSeat;
  }
  return a.activeSeats.length === 0;
}

/** 一轮拍卖中当前轮到谁叫价（无则 null） */
export function auctionNextSpeaker(game) {
  const a = game.auction;
  if (!a || a.kind !== 'once') return null;
  return onceNextSpeaker(game);
}

/** 定价拍卖中当前轮到谁决定是否购买（无则 null） */
export function fixedBuyerToAct(game) {
  const a = game.auction;
  if (!a || a.kind !== 'fixed') return null;
  return fixedNextBuyer(game);
}

function resolveOpenOrOnce(game) {
  const a = game.auction;
  if (a.bid != null) resolveAuction(game, a.bidderSeat, a.bid);
  else resolveAuction(game, a.auctioneer, 0);
}

/** 公开拍卖自由加价；一轮拍卖按顺序各有一次机会。 */
export function auctionBid(game, seat, amount) {
  const a = checkAuctionKind(game, ['open', 'once']);
  if (a.kind === 'open') {
    if (!a.activeSeats.includes(seat)) throw new EngineError('你已弃权，不能再次叫价', 'ALREADY_PASSED');
    if (a.bidderSeat === seat) throw new EngineError('你已是当前最高价者', 'ALREADY_HIGH_BIDDER');
  } else if (onceNextSpeaker(game) !== seat) {
    throw new EngineError('还没轮到你叫价', 'OUT_OF_TURN');
  }
  validateBidAmount(game, seat, amount, a);
  a.bid = amount;
  a.bidderSeat = seat;
  a.lastSpeakerSeat = seat;
  if (a.kind === 'once') a.spokenSeats.push(seat);
  addLog(game, `${playerName(game, seat)} 叫价 ${amount} 元`);
  if (a.kind === 'once') {
    if (onceNextSpeaker(game) == null) resolveOpenOrOnce(game);
  } else if (openShouldResolve(game)) {
    resolveOpenOrOnce(game);
  }
}

/** 公开拍卖可随时弃权；一轮拍卖按顺序弃权。 */
export function auctionPass(game, seat) {
  const a = checkAuctionKind(game, ['open', 'once']);
  if (a.kind === 'open') {
    if (!a.activeSeats.includes(seat)) throw new EngineError('你已经弃权', 'ALREADY_PASSED');
    if (a.bidderSeat === seat) throw new EngineError('当前最高价者不能撤回出价', 'HIGH_BIDDER_CANNOT_PASS');
    a.activeSeats = a.activeSeats.filter((s) => s !== seat);
  } else {
    if (onceNextSpeaker(game) !== seat) throw new EngineError('还没轮到你叫价', 'OUT_OF_TURN');
    a.spokenSeats.push(seat);
  }
  a.lastSpeakerSeat = seat;
  addLog(game, `${playerName(game, seat)} 弃权`);
  if (a.kind === 'once') {
    if (onceNextSpeaker(game) == null) resolveOpenOrOnce(game);
  } else if (openShouldResolve(game)) {
    resolveOpenOrOnce(game);
  }
}

/** 暗标：填写出价（确认前可修改） */
export function sealedSetBid(game, seat, amount) {
  const a = checkAuctionKind(game, ['sealed']);
  if (a.stage !== 'sealed') throw new EngineError('当前不在暗标出价阶段');
  if (a.confirmedSeats[seat]) throw new EngineError('你已确认出价，无法修改');
  if (!Number.isInteger(amount) || amount < 0) throw new EngineError('暗标必须是 0 及以上的整数');
  if (amount > game.players[seat].cash) throw new EngineError(`出价不能超过你的现金（${game.players[seat].cash} 元）`);
  a.amounts[seat] = amount;
}

/** 暗标：确认出价（全员确认后进入 3 秒倒计时） */
export function sealedConfirm(game, seat) {
  const a = checkAuctionKind(game, ['sealed']);
  if (a.stage !== 'sealed') throw new EngineError('当前不在暗标出价阶段');
  if (a.amounts[seat] == null) throw new EngineError('请先填写出价再确认');
  a.confirmedSeats[seat] = true;
  addLog(game, `${playerName(game, seat)} 已确认暗标`);
  if (a.confirmedSeats.every(Boolean)) {
    a.stage = 'countdown';
    addLog(game, '所有玩家均已确认暗标，3 秒后揭晓');
  }
}

function sealedWinner(game) {
  const a = game.auction;
  const n = game.players.length;
  const maxAmount = Math.max(...a.amounts);
  if (maxAmount === 0) return { seat: null, amount: 0 };
  for (let step = 1; step <= n; step++) {
    const cand = mod(a.auctioneer + game.direction * step, n);
    if (a.amounts[cand] === maxAmount) return { seat: cand, amount: maxAmount };
  }
  return { seat: null, amount: 0 };
}

/** 倒计时结束揭晓（3 秒后由服务端调用） */
export function sealedReveal(game) {
  const a = checkAuctionKind(game, ['sealed']);
  if (a.stage !== 'countdown') throw new EngineError('暗标尚未进入揭晓阶段');
  const { seat, amount } = sealedWinner(game);
  a.stage = 'revealed';
  a.winnerSeat = seat;
  a.winnerAmount = amount;
  addLog(game, seat == null
    ? '所有玩家出价均为 0，画作归当前玩家'
    : `暗标揭晓：${playerName(game, seat)} 以 ${amount} 元出价最高`);
}

/** 揭晓后再展示 3 秒后结算 */
export function sealedSettle(game) {
  const a = checkAuctionKind(game, ['sealed']);
  if (a.stage !== 'revealed') throw new EngineError('暗标尚未揭晓');
  resolveAuction(game, a.winnerSeat == null ? a.auctioneer : a.winnerSeat, a.winnerAmount);
}

function fixedNextBuyer(game) {
  const a = game.auction;
  const n = game.players.length;
  for (let step = 1; step < n; step++) {
    const cand = mod(a.auctioneer + game.direction * step, n);
    if (!a.passedSeats.includes(cand)) return cand;
  }
  return null;
}

/** 定价拍卖：拍卖者设定价格 */
export function fixedSetPrice(game, seat, price) {
  const a = checkAuctionKind(game, ['fixed']);
  if (seat !== a.auctioneer) throw new EngineError('只有当前玩家能设定价格');
  if (a.stage !== 'price') throw new EngineError('价格已设定');
  if (!Number.isInteger(price) || price < 0) throw new EngineError('定价必须是 0 及以上的整数');
  if (price > game.players[seat].cash) throw new EngineError(`定价不能超过你的现金（${game.players[seat].cash} 元）`);
  a.price = price;
  a.stage = 'offer';
  addLog(game, `${playerName(game, seat)} 将画作定价为 ${price} 元`);
}

/** 定价拍卖：其他玩家依次决定是否购买 */
export function fixedDecision(game, seat, buy) {
  const a = checkAuctionKind(game, ['fixed']);
  if (a.stage !== 'offer') throw new EngineError('当前不在购买阶段');
  const buyer = fixedNextBuyer(game);
  if (buyer !== seat) throw new EngineError('还没轮到你决定是否购买');
  if (buy) {
    if (game.players[seat].cash < a.price) {
      addLog(game, `${playerName(game, seat)} 现金不足 ${a.price} 元，无法购买`);
      a.passedSeats.push(seat);
      if (fixedNextBuyer(game) == null) resolveAuction(game, a.auctioneer, a.price);
    } else {
      addLog(game, `${playerName(game, seat)} 以 ${a.price} 元购得`);
      resolveAuction(game, seat, a.price);
    }
  } else {
    a.passedSeats.push(seat);
    addLog(game, `${playerName(game, seat)} 放弃购买`);
    if (fixedNextBuyer(game) == null) {
      addLog(game, `${playerName(game, a.auctioneer)} 无人购买，按定价 ${a.price} 元自行购得`);
      resolveAuction(game, a.auctioneer, a.price);
    }
  }
}

/** 拍卖成交：付款、入公开区、轮到下家 */
export function resolveAuction(game, winnerSeat, price) {
  const a = game.auction;
  if (!a) throw new EngineError('没有进行中的拍卖');
  const n = game.players.length;
  if (winnerSeat < 0 || winnerSeat >= n) throw new EngineError('无效的得主');
  const winner = game.players[winnerSeat];
  const auctioneerSeat = a.auctioneer;
  const seller = game.players[auctioneerSeat];
  const lotText = a.lotIds.map((id) => artistLabel(cardById(game, id).artist)).join(' + ');
  if (price > 0) {
    if (price > winner.cash) throw new EngineError('得主现金不足，无法成交');
    winner.cash -= price;
    if (winnerSeat === auctioneerSeat) {
      // 自购：成交款交给系统（画作本就属于当前玩家）
      addLog(game, `${playerName(game, winnerSeat)} 以 ${price} 元自购 ${lotText}（款项交给系统）`);
    } else {
      // 其他玩家购得：成交款支付给卖出画作的当前玩家
      seller.cash += price;
      addLog(game, `${playerName(game, winnerSeat)} 以 ${price} 元购得 ${lotText}，款项支付给 ${playerName(game, auctioneerSeat)}`);
    }
  }
  winner.publicLots.push({ round: a.round, cardIds: a.lotIds.slice(), price });
  if (price === 0) addLog(game, `${playerName(game, winnerSeat)} 免费获得 ${lotText}`);
  game.auction = null;
  // 轮到当前拍卖者的下家出牌
  game.turnSeat = nextSeat(game, auctioneerSeat);
  if (!ensureTurn(game)) {
    settleRound(game, '所有玩家均已无牌可打');
  }
}

// ---------------- 轮末结算 ----------------

export function settleRound(game, reasonText = '') {
  const r = game.round;
  const n = game.players.length;
  const counts = [0, 0, 0, 0, 0];
  const perPlayer = Array.from({ length: n }, () => [0, 0, 0, 0, 0]);

  for (const p of game.players) {
    for (const lot of p.publicLots) {
      if (lot.round !== r) continue;
      for (const id of lot.cardIds) {
        const artist = cardById(game, id).artist;
        counts[artist]++;
        perPlayer[p.seat][artist]++;
      }
    }
  }

  if (reasonText) addLog(game, reasonText);
  const participating = counts
    .map((count, artist) => ({ artist, count }))
    .filter((x) => x.count > 0)
    .sort((x, y) => y.count - x.count || x.artist - y.artist);

  const awarded = {};
  for (let i = 0; i < participating.length && i < 3; i++) {
    awarded[participating[i].artist] = ROUND_AWARDS[i];
  }
  for (const artist of [0, 1, 2, 3, 4]) {
    const gain = awarded[artist] || 0;
    game.artistValues[artist].total += gain;
    game.artistValues[artist].rounds[r - 1] = gain;
  }

  const rankText = participating
    .slice(0, 3)
    .map((x, i) => `${artistLabel(x.artist)} ${x.count} 张 +${ROUND_AWARDS[i]}`)
    .join('，');
  if (participating.length) addLog(game, `第 ${r} 轮结算：${rankText}`);
  else addLog(game, `第 ${r} 轮结算：本轮没有画作成交`);

  for (const p of game.players) {
    let gain = 0;
    for (const artist of [0, 1, 2, 3, 4]) {
      gain += perPlayer[p.seat][artist] * game.artistValues[artist].total;
    }
    p.cash += gain;
    if (gain > 0) addLog(game, `${playerName(game, p.seat)} 的画作结算收益 ${gain} 元`);
    // 公开画全部进入弃牌堆
    for (const lot of p.publicLots) {
      if (lot.round === r) game.discard.push(...lot.cardIds);
    }
    p.publicLots = [];
  }

  game.round++;
  if (game.round > 4) {
    finishGame(game);
    return;
  }

  game.starterSeat = nextSeat(game, game.starterSeat);
  const dealCount = CARDS_PER_ROUND[n][game.round - 1];
  if (dealCount > 0) {
    for (const p of game.players) {
      p.hand.push(...drawCards(game, dealCount));
    }
    addLog(game, `第 ${game.round} 轮开始，每位玩家补发 ${dealCount} 张手牌`);
  } else {
    addLog(game, `第 ${game.round} 轮开始，本轮不补牌`);
  }
  game.phase = 'play';
  game.turnSeat = game.starterSeat;
  if (!ensureTurn(game)) settleRound(game, '所有玩家均已无牌可打');
}

function finishGame(game) {
  const sorted = game.players.slice().sort((x, y) => y.cash - x.cash);
  game.result = {
    ranks: sorted.map((p) => ({
      username: p.username,
      cash: p.cash,
      rank: 1 + game.players.filter((q) => q.cash > p.cash).length
    }))
  };
  game.phase = 'gameover';
  addLog(game, '游戏结束，按总资产结算名次');
}

/** 异常终止一局（掉线/主动退出/超时） */
export function abortGame(game, type, triggerUsername) {
  game.phase = 'aborted';
  game.abort = { type, triggerUsername };
  const text = {
    disconnect: '玩家掉线',
    quit: '玩家主动退出',
    timeout: '房间无操作超时'
  }[type] || '对局异常';
  addLog(game, `${text}（${triggerUsername}），对局终止`);
}

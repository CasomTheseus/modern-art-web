// 把权威状态转换为发送给某个玩家的安全视图

import { ARTISTS } from './cards.js';
import { cardSummary } from './cards.js';
import { auctionNextSpeaker, fixedBuyerToAct, publicCountOfArtist } from './engine.js';

export function roomView(room) {
  return {
    t: 'room',
    roomCode: room.code,
    capacity: room.capacity,
    host: room.hostUsername,
    players: room.players.map((u) => ({
      username: u.username,
      isHost: u.username === room.hostUsername,
      connected: u.connected !== false,
      reconnectDeadline: u.reconnectDeadline || null
    })),
    canStart: room.players.length === room.capacity
  };
}

function lotView(game, lot) {
  return {
    price: lot.price,
    cards: lot.cardIds.map((id) => cardSummary(game.cardsById[id]))
  };
}

function auctionView(game, seat) {
  const a = game.auction;
  const view = {
    kind: a.kind,
    stage: a.stage,
    round: a.round,
    auctioneerSeat: a.auctioneer,
    auctioneerName: game.players[a.auctioneer].username,
    lot: a.lotIds.map((id) => cardSummary(game.cardsById[id])),
    double: a.lotIds.length === 2
  };
  if (a.kind === 'open' || a.kind === 'once') {
    view.highBid = a.bid;
    view.highBidderSeat = a.bidderSeat;
    view.highBidderName = a.bidderSeat == null ? null : game.players[a.bidderSeat].username;
    if (a.kind === 'once') {
      view.nextSpeakerSeat = auctionNextSpeaker(game);
      view.nextSpeakerName = view.nextSpeakerSeat == null ? null : game.players[view.nextSpeakerSeat].username;
    } else {
      view.activeSeats = a.activeSeats.slice();
    }
  }
  if (a.kind === 'sealed') {
    view.confirmed = a.confirmedSeats.map((x) => !!x);
    view.revealed = a.stage === 'revealed';
    view.myAmount = a.amounts[seat];
    if (a.stage === 'revealed') {
      view.amounts = a.amounts.map((amt, i) => ({
        seat: i,
        username: game.players[i].username,
        amount: amt
      }));
      view.winnerSeat = a.winnerSeat;
      view.winnerAmount = a.winnerAmount;
    }
  }
  if (a.kind === 'fixed') {
    view.price = a.price;
    view.stage = a.stage;
    if (a.stage === 'offer') {
      view.nextBuyerSeat = fixedBuyerToAct(game);
      view.nextBuyerName = view.nextBuyerSeat == null ? null : game.players[view.nextBuyerSeat].username;
    }
  }
  return view;
}

export function gameView(game, seat) {
  const p = game.players[seat];
  const playing = game.phase === 'play';
  return {
    t: 'game',
    roomCode: game.code,
    phase: game.phase,
    round: game.round,
    direction: game.direction === 1 ? '顺时针' : '逆时针',
    diceRoll: game.diceRoll,
    starterSeat: game.starterSeat,
    turnSeat: game.turnSeat,
    mySeat: seat,
    players: game.players.map((q) => ({
      seat: q.seat,
      username: q.username,
      cash: q.seat === seat ? q.cash : null,
      connected: q.connected !== false,
      reconnectDeadline: q.reconnectDeadline || null,
      handCount: q.hand.length,
      isTurn: playing && game.auction == null && game.turnSeat === q.seat,
      lots: q.publicLots.map((lot) => lotView(game, lot))
    })),
    artists: game.artistValues.map((v, i) => ({
      index: i,
      key: ARTISTS[i].key,
      colorName: ARTISTS[i].colorName,
      color: ARTISTS[i].color,
      total: v.total,
      roundValues: v.rounds.slice(),
      publicCount: publicCountOfArtist(game, i)
    })),
    auction: game.auction ? auctionView(game, seat) : null,
    hand: p.hand.map((id) => cardSummary(game.cardsById[id])),
    log: game.log.slice(-40),
    result: game.result
  };
}

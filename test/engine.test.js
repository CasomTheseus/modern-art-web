import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../server/engine.js';
import { gameView } from '../server/view.js';

function makeGame(names, rng = () => 0.4) {
  return E.createGame({
    code: '1234',
    users: names.map((username, i) => ({ userId: `u${i}`, username })),
    rng
  });
}

function pickIds(game, artist, type, count) {
  const out = [];
  for (const card of Object.values(game.cardsById)) {
    if (card.artist === artist && card.type === type) out.push(card.id);
    if (out.length >= count) break;
  }
  return out;
}

function takeFromPool(game, ids) {
  game.deck = game.deck.filter((id) => !ids.includes(id));
  game.discard = game.discard.filter((id) => !ids.includes(id));
}

function setHand(game, seat, ids) {
  takeFromPool(game, ids);
  game.players[seat].hand = ids.slice();
}

function setPublic(game, seat, ids) {
  takeFromPool(game, ids);
  game.players[seat].publicLots.push({ round: game.round, cardIds: ids.slice(), price: 0 });
}

function startRound(game) {
  game.phase = 'play';
  game.round = 1;
  game.turnSeat = 0;
  game.direction = 1;
}

function prepareAuction(game, type) {
  startRound(game);
  const id = pickIds(game, 1, type, 1)[0];
  setHand(game, 0, [id]);
  setHand(game, 1, pickIds(game, 2, 'open', 1));
  setHand(game, 2, pickIds(game, 3, 'open', 1));
  E.playLot(game, 0, id);
  return id;
}

test('三种人数按实体版发牌，保留用户 ID 和顺时针方向', () => {
  for (const [n, initial] of [[3, 10], [4, 9], [5, 8]]) {
    const names = Array.from({ length: n }, (_, i) => `玩家${i}`);
    const game = makeGame(names);
    assert.equal(game.direction, 1);
    assert.equal(game.deck.length, 70 - n * initial);
    game.players.forEach((player, i) => {
      assert.equal(player.hand.length, initial);
      assert.equal(player.userId, `u${i}`);
    });
    assert.equal(game.deck.length + game.players.reduce((sum, p) => sum + p.hand.length, 0), 70);
  }
});

test('开局随机先手动画后进入第 1 轮', () => {
  const game = makeGame(['甲', '乙', '丙']);
  E.afterDice(game);
  assert.equal(game.phase, 'play');
  assert.equal(game.turnSeat, game.starterSeat);
});

test('结算按 30/20/10 和累计价值付款', () => {
  const game = makeGame(['甲', '乙', '丙']);
  startRound(game);
  setPublic(game, 0, pickIds(game, 0, 'open', 3));
  setPublic(game, 1, pickIds(game, 1, 'open', 2));
  setPublic(game, 2, pickIds(game, 2, 'open', 1));
  E.settleRound(game, '测试结算');
  assert.deepEqual(game.artistValues.slice(0, 3).map((v) => v.total), [30, 20, 10]);
  assert.equal(game.players[0].cash, 190);
  assert.equal(game.players[1].cash, 140);
  assert.equal(game.players[2].cash, 110);
  assert.ok(game.players.every((p) => p.publicLots.length === 0));
});

test('艺术家同数按 A-E 优先，空缺名次不发价值', () => {
  const game = makeGame(['甲', '乙', '丙']);
  startRound(game);
  setPublic(game, 0, pickIds(game, 0, 'open', 2));
  setPublic(game, 1, pickIds(game, 1, 'open', 2));
  E.settleRound(game, '');
  assert.deepEqual(game.artistValues.map((v) => v.total), [30, 20, 0, 0, 0]);
});

test('第 5 张同色画不拍卖并立即结算', () => {
  const game = makeGame(['甲', '乙', '丙']);
  startRound(game);
  setPublic(game, 0, pickIds(game, 0, 'open', 4));
  const fifth = pickIds(game, 0, 'once', 1)[0];
  setHand(game, 1, [fifth]);
  game.turnSeat = 1;
  const result = E.playLot(game, 1, fifth);
  assert.equal(result.trigger, true);
  assert.equal(game.auction, null);
  assert.ok(game.discard.includes(fifth));
  assert.equal(game.artistValues[0].total, 30);
  assert.equal(game.players[0].cash, 220);
});

test('联合 lot 达到第 5 张时整体弃置', () => {
  const game = makeGame(['甲', '乙', '丙']);
  startRound(game);
  setPublic(game, 0, pickIds(game, 0, 'open', 3));
  const doubleId = pickIds(game, 0, 'double', 1)[0];
  const partnerId = pickIds(game, 0, 'fixed', 1)[0];
  setHand(game, 1, [doubleId, partnerId]);
  game.turnSeat = 1;
  E.playLot(game, 1, doubleId, partnerId);
  assert.ok(game.discard.includes(doubleId) && game.discard.includes(partnerId));
  assert.equal(game.artistValues[0].total, 30);
});

test('一轮拍卖全员弃权时拍卖者免费获得', () => {
  const game = makeGame(['甲', '乙', '丙']);
  prepareAuction(game, 'once');
  E.auctionPass(game, 1);
  E.auctionPass(game, 2);
  E.auctionPass(game, 0);
  assert.equal(game.auction, null);
  assert.equal(game.players[0].cash, 100);
  assert.equal(game.players[0].publicLots[0].price, 0);
});

test('一轮拍卖由拍卖者最后行动', () => {
  const game = makeGame(['甲', '乙', '丙']);
  prepareAuction(game, 'once');
  E.auctionBid(game, 1, 10);
  E.auctionPass(game, 2);
  E.auctionBid(game, 0, 12);
  assert.equal(game.players[0].cash, 88);
  assert.equal(game.players[0].publicLots[0].price, 12);
});

test('公开拍卖允许任意顺序自由加价并正确付款', () => {
  const game = makeGame(['甲', '乙', '丙']);
  prepareAuction(game, 'open');
  E.auctionBid(game, 2, 5);
  E.auctionBid(game, 1, 8);
  assert.equal(game.auction.bidderSeat, 1);
  assert.throws(() => E.auctionBid(game, 1, 9), /当前最高价者/);
  assert.throws(() => E.auctionPass(game, 1), /不能撤回/);
  E.auctionPass(game, 0);
  assert.ok(game.auction);
  E.auctionPass(game, 2);
  assert.equal(game.auction, null);
  assert.equal(game.players[1].cash, 92);
  assert.equal(game.players[0].cash, 108);
});

test('公开拍卖无人出价且全员弃权时拍卖者免费获得', () => {
  const game = makeGame(['甲', '乙', '丙']);
  prepareAuction(game, 'open');
  E.auctionPass(game, 2);
  E.auctionPass(game, 0);
  E.auctionPass(game, 1);
  assert.equal(game.auction, null);
  assert.equal(game.players[0].publicLots[0].price, 0);
});

test('叫价必须为整数、高于当前价且不超过现金', () => {
  const game = makeGame(['甲', '乙', '丙']);
  prepareAuction(game, 'open');
  assert.throws(() => E.auctionBid(game, 1, 101), /超过你的现金/);
  assert.throws(() => E.auctionBid(game, 1, 1.5), /整数/);
  E.auctionBid(game, 1, 10);
  assert.throws(() => E.auctionBid(game, 2, 10), /高于当前最高价/);
});

test('暗标平局从拍卖者下家起决定得主', () => {
  const game = makeGame(['甲', '乙', '丙']);
  prepareAuction(game, 'sealed');
  for (const [seat, amount] of [[0, 8], [1, 10], [2, 10]]) E.sealedSetBid(game, seat, amount);
  for (let seat = 0; seat < 3; seat++) E.sealedConfirm(game, seat);
  E.sealedReveal(game);
  assert.equal(game.auction.winnerSeat, 1);
  E.sealedSettle(game);
  assert.equal(game.players[1].cash, 90);
  assert.equal(game.players[0].cash, 110);
});

test('暗标全部为 0 时拍卖者免费获得', () => {
  const game = makeGame(['甲', '乙', '丙']);
  prepareAuction(game, 'sealed');
  for (let seat = 0; seat < 3; seat++) {
    E.sealedSetBid(game, seat, 0);
    E.sealedConfirm(game, seat);
  }
  E.sealedReveal(game);
  E.sealedSettle(game);
  assert.equal(game.players[0].publicLots[0].price, 0);
});

test('定价拍卖支持他人购买和拍卖者自购', () => {
  const game = makeGame(['甲', '乙', '丙']);
  prepareAuction(game, 'fixed');
  E.fixedSetPrice(game, 0, 30);
  E.fixedDecision(game, 1, false);
  E.fixedDecision(game, 2, true);
  assert.equal(game.players[2].cash, 70);
  assert.equal(game.players[0].cash, 130);

  const second = makeGame(['甲', '乙', '丙']);
  prepareAuction(second, 'fixed');
  E.fixedSetPrice(second, 0, 25);
  E.fixedDecision(second, 1, false);
  E.fixedDecision(second, 2, false);
  assert.equal(second.players[0].cash, 75);
});

test('联合拍卖按绑定画类型成交且两张同归买家', () => {
  const game = makeGame(['甲', '乙', '丙']);
  startRound(game);
  const doubleId = pickIds(game, 0, 'double', 1)[0];
  const partnerId = pickIds(game, 0, 'fixed', 1)[0];
  setHand(game, 0, [doubleId, partnerId]);
  E.playLot(game, 0, doubleId, partnerId);
  assert.equal(game.auction.kind, 'fixed');
  E.fixedSetPrice(game, 0, 40);
  E.fixedDecision(game, 1, true);
  assert.equal(game.players[1].publicLots[0].cardIds.length, 2);
  assert.equal(game.players[0].cash, 140);
});

test('第二三轮按人数补牌，第四轮不补且不回收弃牌', () => {
  for (const [n, deals] of [[3, [10, 6, 6, 0]], [4, [9, 4, 4, 0]], [5, [8, 3, 3, 0]]]) {
    const game = makeGame(Array.from({ length: n }, (_, i) => `玩家${i}`));
    startRound(game);
    for (let round = 2; round <= 4; round++) {
      const before = game.players.map((p) => p.hand.length);
      E.settleRound(game, '');
      assert.equal(game.round, round);
      game.players.forEach((player, i) => assert.equal(player.hand.length, before[i] + deals[round - 1]));
    }
    E.settleRound(game, '第四轮结算');
    assert.equal(game.phase, 'gameover');
  }
});

test('牌堆不足时明确报错，不洗入弃牌堆', () => {
  const game = makeGame(['甲', '乙', '丙']);
  startRound(game);
  game.deck = [];
  game.discard = pickIds(game, 0, 'open', 4);
  assert.throws(() => E.settleRound(game, ''), /牌堆剩余卡牌不足/);
  assert.equal(game.discard.length, 4);
});

test('所有玩家无牌可打时结算当轮', () => {
  const game = makeGame(['甲', '乙', '丙']);
  startRound(game);
  for (const player of game.players) player.hand = [];
  assert.equal(E.ensureTurn(game), false);
  E.settleRound(game, '兜底');
  assert.equal(game.round, 2);
});

test('最终现金相同者并列', () => {
  const game = makeGame(['甲', '乙', '丙']);
  startRound(game);
  game.round = 4;
  game.players[0].cash = 100;
  game.players[1].cash = 90;
  game.players[2].cash = 90;
  E.settleRound(game, '最终结算');
  assert.deepEqual(game.result.ranks.map((r) => [r.username, r.rank]), [['甲', 1], ['乙', 2], ['丙', 2]]);
});

test('视图隐藏他人现金并公开自由拍卖参与状态', () => {
  const game = makeGame(['甲', '乙', '丙']);
  prepareAuction(game, 'open');
  const view = gameView(game, 0);
  assert.equal(view.players[0].cash, 100);
  assert.equal(view.players[1].cash, null);
  assert.equal(view.players[2].cash, null);
  assert.deepEqual(view.auction.activeSeats, [0, 1, 2]);
  assert.equal(view.auction.nextSpeakerSeat, undefined);
});

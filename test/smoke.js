import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3210 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-smoke-'));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${detail ? ` | ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(pathname, { method, body, cookie } = {}) {
  const res = await fetch(BASE + pathname, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie') || '';
  return {
    status: res.status,
    data: await res.json(),
    cookie: setCookie ? setCookie.split(';')[0] : cookie,
    setCookie
  };
}

function client(account, tag) {
  const ws = new WebSocket(WS_URL, { headers: { Cookie: account.cookie } });
  const box = { ws, tag, account, messages: [], lastGame: null, open: false };
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    box.messages.push(msg);
    if (msg.t === 'game') box.lastGame = msg;
  });
  ws.on('open', () => { box.open = true; });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(box));
    ws.on('error', reject);
  });
}

function act(box, obj) {
  box.ws.send(JSON.stringify(obj));
}

function waitMsg(box, predicate, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = box.messages.length;
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`${box.tag} 等待消息超时`));
    }, timeout);
    const poll = setInterval(() => {
      for (let i = start; i < box.messages.length; i++) {
        if (predicate(box.messages[i])) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve(box.messages[i]);
          return;
        }
      }
    }, 30);
  });
}

function resolvedCount(box) {
  return (box.lastGame?.log || []).filter((line) => /购得|免费获得/.test(line.text)).length;
}

function drive(box) {
  const game = box.lastGame;
  if (!game || game.phase !== 'play') return;
  const my = game.mySeat;
  const auction = game.auction;
  if (!auction) {
    box._auctionKey = null;
    if (game.turnSeat === my && !box._played) {
      box._played = true;
      const normal = game.hand.find((card) => !card.double);
      if (normal) act(box, { t: 'playLot', cardId: normal.id });
      else {
        const double = game.hand[0];
        const partner = game.hand.find((card) => card.id !== double?.id && !card.double && card.artist === double?.artist);
        if (double && partner) act(box, { t: 'playLot', cardId: double.id, partnerId: partner.id });
      }
    }
    return;
  }
  box._played = false;
  const key = auction.lot.map((card) => card.id).join(',');
  if (box._auctionKey !== key) {
    box._auctionKey = key;
    box._passSent = false;
    box._bidSent = false;
    box._confirmSent = false;
    box._priceSent = false;
    box._decisionSent = false;
  }
  if (auction.kind === 'sealed') {
    if (auction.stage === 'sealed' && !auction.confirmed[my]) {
      if (!box._bidSent) {
        box._bidSent = true;
        act(box, { t: 'sealedBid', amount: 0 });
      } else if (!box._confirmSent) {
        box._confirmSent = true;
        act(box, { t: 'sealedConfirm' });
      }
    }
    return;
  }
  if (auction.kind === 'open' || auction.kind === 'once') {
    const canPass = auction.kind === 'open' || auction.nextSpeakerSeat === my;
    if (canPass && !box._passSent) {
      box._passSent = true;
      act(box, { t: 'pass' });
    }
    return;
  }
  if (auction.kind === 'fixed') {
    if (auction.stage === 'price' && auction.auctioneerSeat === my && !box._priceSent) {
      box._priceSent = true;
      act(box, { t: 'fixedPrice', amount: 0 });
    } else if (auction.stage === 'offer' && auction.nextBuyerSeat === my && !box._decisionSent) {
      box._decisionSent = true;
      act(box, { t: 'fixedDecision', buy: false });
    }
  }
}

const stamp = Date.now().toString(36);
const users = [{ name: `甲${stamp}` }, { name: `乙${stamp}` }, { name: `丙${stamp}` }];
const server = spawn('node', [path.join(__dirname, '../server/index.js')], {
  env: { ...process.env, PORT: String(PORT), MA_DATA_DIR: DATA_DIR, MA_RECONNECT_MS: '1500' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let A, B, C;

function killServer() {
  try { server.kill(); } catch { /* already stopped */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

server.stdout.on('data', () => {});
server.stderr.on('data', (data) => process.stderr.write(String(data)));

try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/');
      if (res.status === 200) { ready = true; break; }
    } catch { /* retry */ }
    await sleep(150);
  }
  check('服务器可访问', ready);

  const accounts = [];
  for (const user of users) {
    const res = await api('/api/register', { body: { username: user.name, password: 'pass1234' } });
    if (!res.data.ok) throw new Error(`注册失败: ${JSON.stringify(res.data)}`);
    accounts.push({ ...user, cookie: res.cookie, setCookie: res.setCookie });
  }
  check('注册 3 个账号并设置 Cookie', accounts.every((account) => account.cookie?.startsWith('ma_session=')));
  check('会话 Cookie 为 HttpOnly', accounts.every((account) => /HttpOnly/i.test(account.setCookie)));
  const session = await api('/api/session', { cookie: accounts[0].cookie });
  check('Cookie 可恢复当前会话', session.status === 200 && session.data.username === users[0].name);

  [A, B, C] = await Promise.all(accounts.map((account, i) => client(account, ['A', 'B', 'C'][i])));
  await sleep(100);
  check('3 个 Cookie 鉴权的 WebSocket 已连接', A.open && B.open && C.open);

  act(A, { t: 'createRoom', capacity: 3 });
  const roomA = await waitMsg(A, (msg) => msg.t === 'room');
  const code = roomA.roomCode;
  check('创建房间得到四位码', /^\d{4}$/.test(code));
  act(B, { t: 'joinRoom', code });
  act(C, { t: 'joinRoom', code });
  const full = await waitMsg(B, (msg) => msg.t === 'room' && msg.players.length === 3);
  check('三人满员', full.players.length === 3);

  act(A, { t: 'startGame' });
  const dice = await waitMsg(A, (msg) => msg.t === 'game' && msg.phase === 'dice');
  check('开局发牌符合三人 10 张规则', dice.hand.length === 10);
  check('他人现金在视图中保密', dice.players.filter((p) => p.seat !== dice.mySeat).every((p) => p.cash === null));
  const play = await waitMsg(A, (msg) => msg.t === 'game' && msg.phase === 'play', 12000);
  check('开局进入出牌阶段', play.phase === 'play');

  const started = Date.now();
  while (resolvedCount(A) < 1 && Date.now() - started < 18000) {
    for (const box of [A, B, C]) drive(box);
    await sleep(120);
  }
  check('服务端完成至少一次拍卖', resolvedCount(A) >= 1);

  act(A, { t: 'bid', amount: 999999 });
  const rejected = await waitMsg(A, (msg) => msg.t === 'error');
  check('非法操作仅被拒绝', Boolean(rejected.code));
  check('非法操作未立即终止对局', !A.messages.some((msg) => msg.t === 'aborted'));

  const oldSeat = C.lastGame.mySeat;
  C.ws.close();
  const offline = await waitMsg(B, (msg) => msg.t === 'game'
    && msg.players.some((p) => p.username === users[2].name && p.connected === false));
  check('断线保留座位并广播离线状态', Boolean(offline));
  check('断线未立即终止对局', !B.messages.some((msg) => msg.t === 'aborted'));

  const reconnected = await client(accounts[2], 'C2');
  const hello = await waitMsg(reconnected, (msg) => msg.t === 'hello');
  check('重连返回原房间', hello.hasRoom === true);
  const restored = reconnected.messages.find((msg) => msg.t === 'game' && msg.phase === 'play')
    || await waitMsg(reconnected, (msg) => msg.t === 'game' && msg.phase === 'play');
  check('重连恢复座位与权威视图', restored.mySeat === oldSeat
    && restored.players[oldSeat].connected === true);
  C = reconnected;

  C.ws.close();
  const aborted = await waitMsg(B, (msg) => msg.t === 'aborted', 7000);
  check('超过重连期限才终止对局', /重连期限/.test(aborted.reason));

  const history = await api('/api/history', { cookie: accounts[2].cookie });
  const abnormal = (history.data.matches || []).find((match) => match.kind === 'abnormal');
  check('超时掉线写入异常战绩', abnormal && abnormal.type === 'disconnect');
  check('异常记录包含玩家名单', abnormal && abnormal.players.length === 3);

  const logout = await api('/api/logout', { method: 'POST', cookie: accounts[0].cookie });
  check('登出成功', logout.status === 200);
  const expired = await api('/api/session', { cookie: accounts[0].cookie });
  check('登出后会话已撤销', expired.status === 401);

  for (const box of [A, B, C]) {
    try { box.ws.close(); } catch { /* already closed */ }
  }
} catch (err) {
  check('冒烟测试执行', false, err.message);
  console.error(err);
  for (const box of [A, B, C]) {
    if (box) console.log(`--- ${box.tag} 最近消息 ---\n${box.messages.slice(-6).map((m) => JSON.stringify(m).slice(0, 220)).join('\n')}`);
  }
} finally {
  killServer();
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} 项冒烟检查通过`);
if (failed) process.exit(1);

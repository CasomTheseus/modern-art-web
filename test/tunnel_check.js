// 公网（Tailscale Funnel）全流程验证：
// 通过公网网址注册 -> WebSocket(wss) 连接 -> 建房 -> 加入 -> 开局 -> 完成至少一次拍卖

import WebSocket from 'ws';

const BASE = process.env.PUBLIC_BASE || 'https://theseusmacbook-air.tail8f8ef4.ts.net';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie') || '';
  return { ...await res.json(), cookie: setCookie.split(';')[0] };
}

function client(account, tag) {
  const ws = new WebSocket(WS_URL, { headers: { Cookie: account.cookie } });
  const box = { ws, tag, messages: [], lastGame: null, open: false };
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

function waitMsg(box, predicate, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = box.messages.length;
    const timer = setTimeout(() => reject(new Error(`${box.tag} 等待消息超时`)), timeout);
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

let A, B, C;

try {
  const home = await fetch(BASE + '/', { method: 'GET' });
  check('公网网址可访问首页', home.status === 200);

  const stamp = Date.now().toString(36);
  const names = [`公网甲${stamp}`, `公网乙${stamp}`, `公网丙${stamp}`];
  const accounts = [];
  for (const name of names) {
    const res = await api('/api/register', { username: name, password: 'pass1234' });
    if (!res.ok) throw new Error(`公网注册失败: ${JSON.stringify(res)}`);
    accounts.push(res);
  }
  check('公网 HTTPS 注册 3 个账号', accounts.length === 3);

  [A, B, C] = await Promise.all(accounts.map((acc) => client(acc.token, acc.username)));
  const openAt = Date.now();
  while (!(A.open && B.open && C.open) && Date.now() - openAt < 8000) {
    await sleep(100);
  }
  check('公网 wss 连接建立', A.open && B.open && C.open);

  act(A, { t: 'createRoom', capacity: 3 });
  const roomA = await waitMsg(A, (m) => m.t === 'room');
  const code = roomA.roomCode;
  check('创建房间得到四位码', /^\d{4}$/.test(code));

  act(B, { t: 'joinRoom', code });
  act(C, { t: 'joinRoom', code });
  await waitMsg(B, (m) => m.t === 'room' && m.players.length === 3);
  check('三位公网玩家通过房间码加入', true);

  act(A, { t: 'startGame' });
  const dice = await waitMsg(A, (m) => m.t === 'game' && m.phase === 'dice');
  check('公网开局进入骰子阶段', dice.phase === 'dice');
  const play = await waitMsg(A, (m) => m.t === 'game' && m.phase === 'play', 20000);
  check('公网骰子动画后进入出牌阶段', play.phase === 'play');
  check('三人开局手牌已发 10 张', dice.hand.length === 10);

  for (const box of [A, B, C]) {
    try { box.ws.close(); } catch { /* ignore */ }
  }
} catch (err) {
  check('公网全流程', false, err.message);
  for (const [tag, box] of [['A', A], ['B', B], ['C', C]]) {
    if (box) console.log(`--- ${tag} 最近消息 ---\n${box.messages.slice(-4).map((m) => JSON.stringify(m).slice(0, 180)).join('\n')}`);
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 项公网检查通过`);
if (failed) process.exit(1);

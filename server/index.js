// HTTP（静态页 + 账号接口）+ WebSocket 入口

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { registerUser, loginUser, historyFor } from './store.js';
import { Hub } from './hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const PORT = Number(process.env.PORT || 3000);

const sessions = new Map();
const rateBuckets = new Map();
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const SESSION_COOKIE = 'ma_session';

function createSession(user) {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expires <= now) sessions.delete(token);
  }
  while (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { user, expires: now + SESSION_TTL });
  return token;
}

function userByToken(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session.user;
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Ignore malformed cookies.
    }
  }
  return out;
}

function sessionToken(req) {
  return cookies(req)[SESSION_COOKIE] || '';
}

function userFromRequest(req) {
  return userByToken(sessionToken(req));
}

function secureRequest(req) {
  return Boolean(req.socket.encrypted)
    || process.env.MA_SECURE_COOKIE === '1'
    || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token, maxAge) {
  const secure = secureRequest(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function startSession(req, res, user) {
  const token = createSession(user);
  res.setHeader('Set-Cookie', sessionCookie(req, token, Math.floor(SESSION_TTL / 1000)));
}

function endSession(req, res) {
  sessions.delete(sessionToken(req));
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
}

function allowRequest(key, limit, windowMs) {
  const now = Date.now();
  const recent = (rateBuckets.get(key) || []).filter((time) => now - time < windowMs);
  if (recent.length >= limit) {
    rateBuckets.set(key, recent);
    return false;
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  if (rateBuckets.size > 2000) {
    for (const [bucket, times] of rateBuckets) {
      if (times.every((time) => now - time >= 3600000)) rateBuckets.delete(bucket);
    }
  }
  return true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const hub = new Hub();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(res, url.pathname);
  } catch (err) {
    console.error('http error', err);
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
  }
});

async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (req.method === 'POST' && url.pathname === '/api/register') {
    if (!allowRequest(`register:${ip}`, 5, 3600000)) {
      return json(res, 429, { error: '注册尝试过于频繁，请稍后再试' });
    }
    const body = await readBody(req);
    try {
      const user = await registerUser(body.username, body.password);
      startSession(req, res, user);
      json(res, 200, { ok: true, username: user.username });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readBody(req);
    const name = String(body.username || '').trim().toLowerCase();
    if (!allowRequest(`login:${ip}:${name}`, 10, 600000)) {
      return json(res, 429, { error: '登录尝试过于频繁，请稍后再试' });
    }
    try {
      const user = await loginUser(body.username, body.password);
      startSession(req, res, user);
      json(res, 200, { ok: true, username: user.username });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    endSession(req, res);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/session') {
    const user = userFromRequest(req);
    if (!user) return json(res, 401, { error: '登录已过期，请重新登录' });
    return json(res, 200, { ok: true, username: user.username });
  }
  if (req.method === 'GET' && url.pathname === '/api/history') {
    const user = userFromRequest(req);
    if (!user) return json(res, 401, { error: '登录已过期，请重新登录' });
    return json(res, 200, { ok: true, matches: historyFor(user.username) });
  }
  json(res, 404, { error: '接口不存在' });
}

function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = pathname;
  }
  let filePath;
  if (rel === '/' || rel === '') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else if (path.extname(rel)) {
    filePath = path.join(PUBLIC_DIR, rel);
  } else {
    filePath = path.join(PUBLIC_DIR, 'index.html'); // SPA 回退
  }
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

// ---------------- WebSocket ----------------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const user = userFromRequest(req);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    hub.attach(ws, user);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref();
server.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) lan.push(net.address);
    }
  }
  console.log('《现代艺术》服务器已启动');
  console.log(`本机访问: http://localhost:${PORT}`);
  for (const ip of lan) {
    console.log(`局域网访问: http://${ip}:${PORT}`);
  }
  console.log('同一局域网玩家打开上述网址即可加入；异地联机请配合内网穿透。');
});

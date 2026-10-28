// 账号与战绩的本地 JSON 持久化（10 人规模足够）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MA_DATA_DIR
  ? path.resolve(process.env.MA_DATA_DIR)
  : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_FILE = DATA_FILE + '.bak';
const MAX_MATCHES = 3000;
const scrypt = promisify(crypto.scrypt);

function emptyDb() {
  return { users: [], matches: [] };
}

function load() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyDb();
    throw err;
  }
  let db;
  try {
    db = JSON.parse(raw);
  } catch (err) {
    throw new Error(`数据文件 ${DATA_FILE} 已损坏，请先恢复备份；服务器未写入新数据`, { cause: err });
  }
  if (!db || !Array.isArray(db.users) || !Array.isArray(db.matches)) {
    throw new Error(`数据文件 ${DATA_FILE} 结构无效，请先恢复备份；服务器未写入新数据`);
  }
  return db;
}

function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);
  fs.renameSync(tmp, DATA_FILE);
}

const db = load();

async function hashPassword(password, salt) {
  const derived = await scrypt(password, salt, 64);
  return derived.toString('hex');
}

function sanitizeUser(u) {
  return { userId: u.id, username: u.username };
}

export async function registerUser(username, password) {
  const name = String(username || '').trim();
  if (name.length < 2 || name.length > 16) throw new Error('用户名长度需为 2-16 个字符');
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]+$/.test(name)) throw new Error('用户名只能包含中英文、数字与下划线');
  if (String(password || '').length < 8 || String(password).length > 72) throw new Error('密码长度需为 8-72 个字符');
  const lower = name.toLowerCase();
  if (db.users.some((u) => u.usernameLower === lower)) throw new Error('该用户名已被注册');
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomUUID(),
    username: name,
    usernameLower: lower,
    salt,
    hash: await hashPassword(password, salt),
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  save(db);
  return sanitizeUser(user);
}

export async function loginUser(username, password) {
  const name = String(username || '').trim();
  const lower = name.toLowerCase();
  const user = db.users.find((u) => u.usernameLower === lower);
  if (!user) throw new Error('用户名或密码错误');
  const test = await hashPassword(String(password || ''), user.salt);
  const a = Buffer.from(test, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('用户名或密码错误');
  return sanitizeUser(user);
}

export function findUserByName(username) {
  const lower = String(username || '').trim().toLowerCase();
  const u = db.users.find((x) => x.usernameLower === lower);
  return u ? sanitizeUser(u) : null;
}

export function addMatch(record) {
  db.matches.push({ id: crypto.randomUUID(), time: new Date().toISOString(), ...record });
  if (db.matches.length > MAX_MATCHES) db.matches.splice(0, db.matches.length - MAX_MATCHES);
  save(db);
}

/** 返回某用户名参与过的对局（最新在前），最多 100 条 */
export function historyFor(username) {
  const lower = String(username || '').trim().toLowerCase();
  const out = [];
  for (let i = db.matches.length - 1; i >= 0; i--) {
    const m = db.matches[i];
    const names = m.kind === 'normal'
      ? m.players.map((p) => p.username)
      : m.players;
    if (names.some((n) => String(n).toLowerCase() === lower)) {
      out.push(m);
      if (out.length >= 100) break;
    }
  }
  return out;
}

export function stats() {
  return { users: db.users.length, matches: db.matches.length };
}

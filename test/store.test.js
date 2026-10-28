import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-store-test-'));
process.env.MA_DATA_DIR = dataDir;
const store = await import('../server/store.js');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('注册拒绝短密码并返回稳定的 userId', async () => {
  await assert.rejects(store.registerUser('测试用户', 'short'), /8-72/);
  const user = await store.registerUser('测试用户', 'password123');
  assert.ok(user.userId);
  assert.equal(user.username, '测试用户');
  assert.equal('id' in user, false);
  assert.equal('hash' in user, false);
});

test('登录校验密码且不泄露散列', async () => {
  const user = await store.loginUser('测试用户', 'password123');
  assert.equal(user.username, '测试用户');
  await assert.rejects(store.loginUser('测试用户', 'wrong-password'), /用户名或密码错误/);
});

test('保存战绩并保留上一份有效备份', async () => {
  store.addMatch({ kind: 'abnormal', type: 'quit', roomCode: '1234', trigger: '测试用户', players: ['测试用户'] });
  const history = store.historyFor('测试用户');
  assert.equal(history.length, 1);
  assert.equal(history[0].type, 'quit');
  assert.ok(fs.existsSync(path.join(dataDir, 'db.json')));
  assert.ok(fs.existsSync(path.join(dataDir, 'db.json.bak')));
});

test('损坏数据库在加载时明确失败而不是被清空', async () => {
  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-corrupt-test-'));
  fs.writeFileSync(path.join(corruptDir, 'db.json'), '{broken', 'utf8');
  const previous = process.env.MA_DATA_DIR;
  process.env.MA_DATA_DIR = corruptDir;
  try {
    await assert.rejects(import(`../server/store.js?corrupt=${Date.now()}`), /已损坏/);
    assert.equal(fs.readFileSync(path.join(corruptDir, 'db.json'), 'utf8'), '{broken');
  } finally {
    process.env.MA_DATA_DIR = previous;
    fs.rmSync(corruptDir, { recursive: true, force: true });
  }
});

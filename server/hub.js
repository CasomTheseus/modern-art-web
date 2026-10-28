// 房间中枢：管理在线会话、房间、计时器，并把权威状态广播给玩家

import crypto from 'node:crypto';
import * as engine from './engine.js';
import { addMatch } from './store.js';
import { roomView, gameView } from './view.js';

const MAX_ONLINE = 10;
const DICE_MS = 4200;
const SEALED_MS = 3000;
const LOBBY_IDLE_MS = 30 * 60 * 1000;
const GAME_IDLE_MS = 60 * 60 * 1000;
const GAMEOVER_IDLE_MS = 10 * 60 * 1000;

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // ignore
    }
  }
}

export class Hub {
  constructor({ reconnectMs = Number(process.env.MA_RECONNECT_MS || 120000) } = {}) {
    this.online = new Map();
    this.rooms = new Map();
    this.reconnectMs = reconnectMs;
    this.reconnectTimers = new Map();
    this.idleTimer = setInterval(() => this.cleanupIdleRooms(), 30000);
    this.idleTimer.unref();
  }

  attach(ws, user) {
    const username = user.username;
    const existing = this.online.get(username);
    if (!existing && this.online.size >= MAX_ONLINE) {
      send(ws, { t: 'error', message: `服务器已满（最多 ${MAX_ONLINE} 人在线），请稍后再试` });
      ws.close(1013, 'full');
      return;
    }
    this.online.set(username, { ws, user });
    if (existing && existing.ws !== ws) {
      send(existing.ws, { t: 'sessionKick', message: '你的账号已在其他设备登录' });
      try { existing.ws.terminate(); } catch { /* ignore */ }
    }
    const room = this.findRoom(username);
    this.clearReconnectTimer(username);
    this.setPresence(room, username, true, null);
    send(ws, { t: 'hello', username, hasRoom: Boolean(room) });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        send(ws, { t: 'error', message: '消息格式错误', code: 'INVALID_JSON' });
        return;
      }
      try {
        this.dispatch(username, msg);
      } catch (err) {
        if (err instanceof engine.EngineError) {
          send(ws, { t: 'error', message: err.message, code: err.code });
        } else {
          console.error('dispatch error', err);
          send(ws, { t: 'error', message: '服务器内部错误', code: 'INTERNAL_ERROR' });
        }
      }
    });

    ws.on('close', () => this.handleDisconnect(username, ws));
    ws.on('error', () => { /* handled by close */ });
    if (room) {
      if (room.phase === 'lobby') this.broadcastRoom(room);
      else if (room.game) this.broadcastGame(room);
    }
  }

  handleDisconnect(username, ws) {
    const current = this.online.get(username);
    if (!current || current.ws !== ws) return;
    this.online.delete(username);
    const room = this.findRoom(username);
    if (!room) return;
    if (room.phase === 'lobby') {
      this.removeFromLobby(room, username, false);
      return;
    }
    if (room.game && room.game.phase === 'gameover') {
      this.removeFromGameover(room, username);
      return;
    }
    if (room.game && (room.game.phase === 'dice' || room.game.phase === 'play')) {
      const deadline = Date.now() + this.reconnectMs;
      this.setPresence(room, username, false, deadline);
      this.clearReconnectTimer(username);
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(username);
        if (this.online.has(username)) return;
        const currentRoom = this.findRoom(username);
        if (currentRoom && currentRoom.game
          && (currentRoom.game.phase === 'dice' || currentRoom.game.phase === 'play')) {
          this.abortActiveGame(currentRoom, 'disconnect', username);
        }
      }, this.reconnectMs);
      timer.unref();
      this.reconnectTimers.set(username, timer);
      this.broadcastGame(room);
    }
  }

  clearReconnectTimer(username) {
    const timer = this.reconnectTimers.get(username);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(username);
  }

  clearRoomReconnectTimers(room) {
    for (const player of room.players) this.clearReconnectTimer(player.username);
  }

  setPresence(room, username, connected, reconnectDeadline) {
    if (!room) return;
    for (const player of room.players) {
      if (player.username === username) {
        player.connected = connected;
        player.reconnectDeadline = reconnectDeadline;
      }
    }
    if (room.game) {
      for (const player of room.game.players) {
        if (player.username === username) {
          player.connected = connected;
          player.reconnectDeadline = reconnectDeadline;
        }
      }
    }
  }

  findRoom(username) {
    for (const room of this.rooms.values()) {
      if (room.players.some((u) => u.username === username)) return room;
    }
    return null;
  }

  roomOf(ws) {
    for (const room of this.rooms.values()) {
      for (const u of room.players) {
        if (this.online.get(u.username)?.ws === ws) return room;
      }
    }
    return null;
  }

  broadcast(room, obj) {
    for (const u of room.players) {
      const entry = this.online.get(u.username);
      if (entry) send(entry.ws, obj);
    }
  }

  broadcastRoom(room) {
    room.lastActivity = Date.now();
    this.broadcast(room, roomView(room));
  }

  broadcastGame(room) {
    room.lastActivity = Date.now();
    const game = room.game;
    for (const p of game.players) {
      const entry = this.online.get(p.username);
      if (entry) send(entry.ws, gameView(game, p.seat));
    }
  }

  sendTo(username, obj) {
    const entry = this.online.get(username);
    if (entry) send(entry.ws, obj);
  }

  dispatch(username, msg) {
    if (msg.t === 'ping') {
      this.sendTo(username, { t: 'pong' });
      return;
    }
    const room = this.findRoom(username);
    switch (msg.t) {
      case 'createRoom': return this.createRoom(username, msg.capacity);
      case 'joinRoom': return this.joinRoom(username, String(msg.code || '').trim());
      case 'leaveRoom': return this.leaveRoom(username);
      case 'kick': return this.kick(username, String(msg.username || ''));
      case 'startGame': return this.startGame(username);
      case 'quitGame': return this.quitGame(username);
      case 'returnMenu': return this.returnMenu(username);
      default: break;
    }
    if (!room || !room.game) throw new engine.EngineError('当前不在对局中');
    this.gameMessage(room, username, msg);
  }

  // ---------------- 房间 ----------------

  createRoom(username, capacity) {
    if (!Number.isInteger(capacity) || capacity < 3 || capacity > 5) {
      throw new engine.EngineError('房间人数需为 3-5 人');
    }
    if (this.findRoom(username)) throw new engine.EngineError('你已经在房间中了');
    let code;
    do {
      code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    } while (this.rooms.has(code));
    const user = this.online.get(username)?.user;
    const room = {
      code,
      capacity,
      hostUsername: username,
      phase: 'lobby',
      players: [{ username, userId: user.userId }],
      game: null,
      recorded: false,
      _diceTimer: null,
      _sealedTimersFor: null,
      _revealTimer: null,
      _settleTimer: null
    };
    this.rooms.set(code, room);
    this.broadcastRoom(room);
  }

  joinRoom(username, code) {
    const room = this.rooms.get(code);
    if (!room) throw new engine.EngineError('房间不存在，请检查房间码');
    if (room.phase !== 'lobby') throw new engine.EngineError('对局已开始，无法加入');
    if (this.findRoom(username)) throw new engine.EngineError('你已经在房间中了');
    if (room.players.some((u) => u.username === username)) throw new engine.EngineError('你已在该房间');
    if (room.players.length >= room.capacity) throw new engine.EngineError('房间已满员');
    const user = this.online.get(username)?.user;
    room.players.push({ username, userId: user.userId });
    this.broadcastRoom(room);
  }

  removeFromLobby(room, username, kicked) {
    room.players = room.players.filter((u) => u.username !== username);
    if (room.players.length === 0 || room.hostUsername === username) {
      this.broadcast(room, kicked
        ? { t: 'roomClosed', reason: '房间已解散' }
        : { t: 'roomClosed', reason: '房主已离开，房间已解散' });
      this.clearTimers(room);
      this.rooms.delete(room.code);
      return;
    }
    this.broadcastRoom(room);
  }

  leaveRoom(username) {
    const room = this.findRoom(username);
    if (!room || room.phase !== 'lobby') throw new engine.EngineError('当前不在可离开的房间');
    this.removeFromLobby(room, username, false);
    this.sendTo(username, { t: 'left' });
  }

  kick(hostUsername, target) {
    const room = this.findRoom(hostUsername);
    if (!room || room.phase !== 'lobby') throw new engine.EngineError('当前不在房间等待中');
    if (room.hostUsername !== hostUsername) throw new engine.EngineError('只有房主可以踢人');
    if (target === hostUsername) throw new engine.EngineError('不能移出自己');
    if (!room.players.some((u) => u.username === target)) throw new engine.EngineError('该玩家不在房间中');
    room.players = room.players.filter((u) => u.username !== target);
    this.sendTo(target, { t: 'roomClosed', reason: '你已被房主移出房间' });
    this.broadcastRoom(room);
  }

  startGame(hostUsername) {
    const room = this.findRoom(hostUsername);
    if (!room || room.phase !== 'lobby') throw new engine.EngineError('当前不在房间等待中');
    if (room.hostUsername !== hostUsername) throw new engine.EngineError('只有房主可以开始游戏');
    if (room.players.length !== room.capacity) {
      throw new engine.EngineError(`需要 ${room.capacity} 名玩家才能开始（当前 ${room.players.length} 人）`);
    }
    room.phase = 'game';
    room.game = engine.createGame({
      code: room.code,
      users: room.players.map((u) => ({ userId: u.userId, username: u.username }))
    });
    room.recorded = false;
    this.broadcastGame(room);
    room._diceTimer = setTimeout(() => {
      room._diceTimer = null;
      try {
        engine.afterDice(room.game);
      } catch (err) {
        console.error(err);
      }
      this.broadcastGame(room);
      this.afterGameStateChange(room);
    }, DICE_MS);
  }

  // ---------------- 对局动作 ----------------

  gameMessage(room, username, msg) {
    const game = room.game;
    const seat = game.players.findIndex((p) => p.username === username);
    if (seat < 0) throw new engine.EngineError('你不在本局游戏中', 'NOT_IN_GAME');
    this.applyAction(room, seat, msg);
  }

  applyAction(room, seat, msg) {
    const game = room.game;
    switch (msg.t) {
      case 'playLot':
        engine.playLot(game, seat, msg.cardId, msg.partnerId || null);
        break;
      case 'bid':
        engine.auctionBid(game, seat, msg.amount);
        break;
      case 'pass':
        engine.auctionPass(game, seat);
        break;
      case 'sealedBid':
        engine.sealedSetBid(game, seat, msg.amount);
        break;
      case 'sealedConfirm':
        engine.sealedConfirm(game, seat);
        break;
      case 'fixedPrice':
        engine.fixedSetPrice(game, seat, msg.amount);
        break;
      case 'fixedDecision':
        engine.fixedDecision(game, seat, !!msg.buy);
        break;
      case 'quitGame':
        this.abortActiveGame(room, 'quit', game.players[seat].username);
        return;
      default:
        throw new engine.EngineError('未知的操作类型');
    }
    this.broadcastGame(room);
    this.afterGameStateChange(room);
  }

  afterGameStateChange(room) {
    const game = room.game;
    if (!game) return;
    if (game.phase === 'gameover' && !room.recorded) {
      room.recorded = true;
      addMatch({
        kind: 'normal',
        roomCode: room.code,
        players: game.result.ranks.map((r) => ({
          username: r.username,
          rank: r.rank,
          cash: r.cash
        }))
      });
      this.clearAuctionTimers(room);
      return;
    }
    if (game.phase !== 'play' || !game.auction) {
      this.clearAuctionTimers(room);
      return;
    }
    this.scheduleAuctionTimers(room);
  }

  scheduleAuctionTimers(room) {
    const game = room.game;
    const a = game.auction;
    if (!a || a.kind !== 'sealed') {
      this.clearAuctionTimers(room);
      return;
    }
    if (room._sealedTimersFor !== a) {
      this.clearAuctionTimers(room);
      room._sealedTimersFor = a;
    }
    if (a.stage === 'countdown' && !room._revealTimer) {
      room._revealTimer = setTimeout(() => {
        room._revealTimer = null;
        try { engine.sealedReveal(game); } catch (err) { console.error(err); }
        this.broadcastGame(room);
        this.afterGameStateChange(room);
      }, SEALED_MS);
    } else if (a.stage === 'revealed' && !room._settleTimer) {
      room._settleTimer = setTimeout(() => {
        room._settleTimer = null;
        try { engine.sealedSettle(game); } catch (err) { console.error(err); }
        this.broadcastGame(room);
        this.afterGameStateChange(room);
      }, SEALED_MS);
    }
  }

  clearAuctionTimers(room) {
    if (room._revealTimer) { clearTimeout(room._revealTimer); room._revealTimer = null; }
    if (room._settleTimer) { clearTimeout(room._settleTimer); room._settleTimer = null; }
    room._sealedTimersFor = null;
  }

  clearTimers(room) {
    if (room._diceTimer) { clearTimeout(room._diceTimer); room._diceTimer = null; }
    this.clearAuctionTimers(room);
  }

  // ---------------- 异常与离开 ----------------

  abortActiveGame(room, type, triggerUsername) {
    if (!room.game || (room.game.phase !== 'play' && room.game.phase !== 'dice')) return;
    engine.abortGame(room.game, type, triggerUsername);
    addMatch({
      kind: 'abnormal',
      type,
      roomCode: room.code,
      trigger: triggerUsername,
      players: room.game.players.map((p) => p.username)
    });
    const reason = {
      disconnect: `玩家 ${triggerUsername} 超过重连期限，对局已终止`,
      quit: `玩家 ${triggerUsername} 主动退出，对局已终止`,
      timeout: '房间长时间无操作，对局已终止'
    }[type] || '对局异常终止';
    this.broadcast(room, { t: 'aborted', reason });
    this.clearTimers(room);
    this.clearRoomReconnectTimers(room);
    room.players = [];
    this.rooms.delete(room.code);
  }

  cleanupIdleRooms() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      const active = room.game && (room.game.phase === 'play' || room.game.phase === 'dice');
      const gameover = room.game && room.game.phase === 'gameover';
      const limit = active ? GAME_IDLE_MS : gameover ? GAMEOVER_IDLE_MS : LOBBY_IDLE_MS;
      if (now - (room.lastActivity || 0) < limit) continue;
      if (active) {
        this.abortActiveGame(room, 'timeout', room.hostUsername);
      } else {
        this.broadcast(room, { t: 'roomClosed', reason: '房间长时间无操作，已关闭' });
        this.clearTimers(room);
        this.clearRoomReconnectTimers(room);
        this.rooms.delete(room.code);
      }
    }
  }

  removeFromGameover(room, username) {
    this.clearReconnectTimer(username);
    room.players = room.players.filter((u) => u.username !== username);
    this.clearTimers(room);
    if (room.players.length === 0) {
      this.rooms.delete(room.code);
    }
  }

  quitGame(username) {
    const room = this.findRoom(username);
    if (!room || !room.game) throw new engine.EngineError('当前不在对局中');
    if (room.game.phase === 'gameover') {
      this.removeFromGameover(room, username);
      this.sendTo(username, { t: 'left' });
      return;
    }
    if (room.game.phase === 'dice' || room.game.phase === 'play') {
      const game = room.game;
      const seat = game.players.findIndex((p) => p.username === username);
      this.abortActiveGame(room, 'quit', game.players[seat].username);
      this.sendTo(username, { t: 'left' });
    }
  }

  returnMenu(username) {
    const room = this.findRoom(username);
    if (!room) {
      this.sendTo(username, { t: 'left' });
      return;
    }
    if (room.phase === 'lobby') {
      this.removeFromLobby(room, username, false);
    } else if (room.game && room.game.phase === 'gameover') {
      this.removeFromGameover(room, username);
    } else {
      throw new engine.EngineError('对局进行中无法直接返回主界面');
    }
    this.sendTo(username, { t: 'left' });
  }
}

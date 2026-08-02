import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { GameEngine, PHASE } from './src/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = Number(process.env.PORT || 5173);
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const WAITING_DISCONNECTED_TTL_MS = 10 * 60 * 1000;
const GAME_OVER_TTL_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

export const rooms = new Map();
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function nowIso() { return new Date().toISOString(); }
function randomId(prefix = '') {
  return `${prefix}${crypto.randomBytes(5).toString('hex').toUpperCase()}${Date.now().toString(36).slice(-4).toUpperCase()}`;
}
function newClientToken() { return `C${randomId().slice(0, 18)}`; }
function newRoomId() { return randomId('R').slice(0, 10); }
function sanitizeName(value, fallback, max = 18) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return (text || fallback).slice(0, max);
}
function normalizeRoomId(value) { return String(value || '').trim().toUpperCase(); }
function normalizeToken(value) { return String(value || '').trim().toUpperCase(); }
function isValidToken(value) { return /^C[A-Z0-9]{8,40}$/.test(normalizeToken(value)); }
function isValidRoomId(value) { return /^R[A-Z0-9]{6,16}$/.test(normalizeRoomId(value)); }

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('请求 JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function roomNotice(room, type, message) {
  room.notices.unshift({ id: randomId('N'), type, message, createdAt: nowIso() });
  room.notices = room.notices.slice(0, 30);
}

function roomChat(room, client, message) {
  const text = String(message || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  if (!text) throw new Error('聊天内容不能为空');
  room.chat.push({
    id: randomId('M'),
    sender: client?.playerName || '玩家',
    playerIndex: client?.playerIndex ?? null,
    message: text,
    createdAt: nowIso(),
  });
  room.chat = room.chat.slice(-80);
}

function occupiedSeats(room) { return room.seats.filter(seat => seat.clientToken); }
function allReady(room) {
  return occupiedSeats(room).length === room.playerCount
    && occupiedSeats(room).every(seat => seat.clientToken === room.hostClientToken || Boolean(room.clients.get(seat.clientToken)?.ready));
}

function getClient(room, clientToken) {
  const token = normalizeToken(clientToken);
  return token ? room.clients.get(token) || null : null;
}

function ensureRoom(roomId) {
  const id = normalizeRoomId(roomId);
  if (!isValidRoomId(id) || !rooms.has(id)) throw new Error('房间不存在或已关闭');
  return rooms.get(id);
}

function ensureClient(room, clientToken) {
  const token = normalizeToken(clientToken);
  const client = getClient(room, token);
  if (!client) throw new Error('线上会话已失效，请重新加入房间');
  client.lastSeen = Date.now();
  return client;
}


function hasActiveSubscriber(room, clientToken) {
  const token = normalizeToken(clientToken);
  return [...room.subscribers].some(sub => !sub.closed && sub.clientToken === token);
}

function markClientDisconnectedIfUnused(room, clientToken) {
  const client = getClient(room, clientToken);
  if (!client || hasActiveSubscriber(room, clientToken)) return false;
  const changed = Boolean(client.connected);
  client.connected = false;
  client.lastSeen = Date.now();
  return changed;
}

function publicRoom(room, clientToken = '') {
  const viewer = getClient(room, clientToken);
  const game = room.engine?.state ? JSON.parse(JSON.stringify(room.engine.state)) : null;
  // Randomness is authoritative on the server. Neither the generator state
  // nor the seed is part of the public online snapshot.
  if (game) {
    delete game.randomState;
    delete game.randomSeed;
  }
  return {
    id: room.id,
    name: room.name,
    status: room.status,
    playerCount: room.playerCount,
    turnActionCommitted: Boolean(room.turnActionCommitted),
    secondDieResolved: Boolean(room.secondDieResolved),
    secondDieBaseNodeId: room.secondDieBaseNodeId,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    seats: room.seats.map(seat => {
      const client = seat.clientToken ? room.clients.get(seat.clientToken) : null;
      return {
        index: seat.index,
        name: seat.name,
        occupied: Boolean(seat.clientToken),
        connected: Boolean(client?.connected),
        ready: seat.clientToken === room.hostClientToken || Boolean(client?.ready),
        isHost: seat.clientToken === room.hostClientToken,
        active: true,
      };
    }),
    viewer: viewer ? {
      clientToken: viewer.clientToken,
      playerIndex: viewer.playerIndex,
      playerName: viewer.playerName,
      spectator: Boolean(viewer.spectator),
      ready: Boolean(viewer.ready || viewer.clientToken === room.hostClientToken),
      isHost: viewer.clientToken === room.hostClientToken,
    } : null,
    game,
    chat: room.chat,
    notices: room.notices,
    flash: room.flash,
  };
}

function roomListItem(room) {
  return {
    id: room.id,
    name: room.name,
    status: room.status,
    playerCount: room.playerCount,
    occupied: occupiedSeats(room).length,
    seats: room.seats.map(seat => ({
      index: seat.index,
      name: seat.name,
      occupied: Boolean(seat.clientToken),
      connected: Boolean(seat.clientToken && room.clients.get(seat.clientToken)?.connected),
      ready: seat.clientToken === room.hostClientToken || Boolean(room.clients.get(seat.clientToken)?.ready),
      isHost: seat.clientToken === room.hostClientToken,
    })),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function touch(room) { room.updatedAt = nowIso(); }

function createRoom({ roomName, playerName, playerCount } = {}) {
  const count = Number(playerCount || 2);
  if (![2, 3, 4].includes(count)) throw new Error('房间人数必须为 2~4 人');
  const id = newRoomId();
  const hostToken = newClientToken();
  const hostName = sanitizeName(playerName, '房主');
  const room = {
    id,
    name: sanitizeName(roomName, '城乡基建房间', 24),
    playerCount: count,
    status: 'waiting',
    hostClientToken: hostToken,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    seats: Array.from({ length: count }, (_, index) => ({ index, name: '', clientToken: null })),
    clients: new Map(),
    engine: null,
    chat: [],
    notices: [],
    flash: null,
    turnActionCommitted: false,
    secondDieResolved: false,
    secondDieBaseNodeId: null,
    subscribers: new Set(),
  };
  room.seats[0] = { index: 0, name: hostName, clientToken: hostToken };
  room.clients.set(hostToken, {
    clientToken: hostToken,
    playerIndex: 0,
    playerName: hostName,
    ready: true,
    connected: true,
    spectator: false,
    lastSeen: Date.now(),
  });
  rooms.set(id, room);
  roomNotice(room, 'system', `${hostName} 创建了房间，等待其他玩家加入。`);
  return { room, clientToken: hostToken };
}

function joinRoom(room, { playerName, clientToken, spectator = false } = {}) {
  const incomingToken = normalizeToken(clientToken);
  if (incomingToken && room.clients.has(incomingToken)) {
    const existing = room.clients.get(incomingToken);
    existing.connected = true;
    existing.lastSeen = Date.now();
    if (playerName && !existing.spectator) {
      existing.playerName = sanitizeName(playerName, existing.playerName);
      const seat = room.seats[existing.playerIndex];
      if (seat) seat.name = existing.playerName;
    }
    touch(room);
    broadcast(room);
    return { clientToken: incomingToken, room };
  }

  if (room.status !== 'waiting') {
    if (!spectator) throw new Error('房间已经开始，只能以观战身份进入');
    const token = newClientToken();
    room.clients.set(token, {
      clientToken: token,
      playerIndex: null,
      playerName: sanitizeName(playerName, '观战者'),
      ready: false,
      connected: true,
      spectator: true,
      lastSeen: Date.now(),
    });
    roomNotice(room, 'system', `${room.clients.get(token).playerName} 加入观战。`);
    touch(room);
    broadcast(room);
    return { clientToken: token, room };
  }

  const seat = room.seats.find(item => !item.clientToken);
  if (!seat) throw new Error('房间已满');
  const token = newClientToken();
  const name = sanitizeName(playerName, `玩家${seat.index + 1}`);
  seat.name = name;
  seat.clientToken = token;
  room.clients.set(token, {
    clientToken: token,
    playerIndex: seat.index,
    playerName: name,
    ready: false,
    connected: true,
    spectator: false,
    lastSeen: Date.now(),
  });
  roomNotice(room, 'system', `${name} 加入了房间。`);
  touch(room);
  broadcast(room);
  return { clientToken: token, room };
}

function setReady(room, clientToken, ready) {
  const client = ensureClient(room, clientToken);
  if (room.status !== 'waiting') throw new Error('游戏已经开始，不能修改准备状态');
  if (client.spectator) throw new Error('观战者不能准备');
  if (client.clientToken === room.hostClientToken) client.ready = true;
  else client.ready = Boolean(ready);
  roomNotice(room, 'system', `${client.playerName}${client.ready ? '已准备' : '取消准备'}。`);
  touch(room);
  broadcast(room);
}

function leaveRoom(room, clientToken) {
  const client = ensureClient(room, clientToken);
  const seat = client.playerIndex === null ? null : room.seats[client.playerIndex];
  if (room.status === 'waiting') {
    if (seat?.clientToken === client.clientToken) {
      seat.clientToken = null;
      seat.name = '';
    }
    room.clients.delete(client.clientToken);
    if (client.clientToken === room.hostClientToken) {
      const replacement = occupiedSeats(room)[0];
      room.hostClientToken = replacement?.clientToken || null;
      if (replacement) room.clients.get(replacement.clientToken).ready = true;
    }
    roomNotice(room, 'system', `${client.playerName} 离开了房间。`);
    touch(room);
    broadcast(room);
    if (!occupiedSeats(room).length) rooms.delete(room.id);
    return;
  }
  client.connected = false;
  client.lastSeen = Date.now();
  roomNotice(room, 'system', `${client.playerName} 暂时离开，重新打开房间可恢复连接。`);
  touch(room);
  broadcast(room);
}

function kickPlayer(room, hostToken, playerIndex) {
  const host = ensureClient(room, hostToken);
  if (host.clientToken !== room.hostClientToken) throw new Error('只有房主可以移出玩家');
  if (room.status !== 'waiting') throw new Error('游戏开始后不能移出玩家');
  const index = Number(playerIndex);
  const seat = room.seats[index];
  if (!seat?.clientToken || seat.clientToken === host.clientToken) throw new Error('不能移出该座位');
  const client = room.clients.get(seat.clientToken);
  closeClientSubscribers(room, client.clientToken);
  client.connected = false;
  seat.clientToken = null;
  seat.name = '';
  room.clients.delete(client.clientToken);
  roomNotice(room, 'system', `${client.playerName} 已被房主移出房间。`);
  touch(room);
  broadcast(room);
}

function startRoom(room, clientToken) {
  const host = ensureClient(room, clientToken);
  if (host.clientToken !== room.hostClientToken) throw new Error('只有房主可以开始游戏');
  if (room.status !== 'waiting') throw new Error('房间已经开始或已结束');
  if (occupiedSeats(room).length !== room.playerCount) throw new Error('所有座位坐满后才能开始');
  if (!allReady(room)) throw new Error('还有玩家没有准备');
  const players = room.seats.map(seat => ({ name: seat.name }));
  room.engine = new GameEngine({ players, seed: `${room.id}-${Date.now()}` });
  room.status = 'playing';
  roomNotice(room, 'system', '房主已开始游戏，按座位顺序进行开局预建设。');
  touch(room);
  broadcast(room);
}

function currentExpectedPlayerIndex(engine) {
  if (engine.state.phase === PHASE.PRE_BUILD) return engine.state.preBuildIndex;
  if (engine.state.phase === PHASE.PLAYER_TURN) return engine.state.currentPlayerIndex;
  return null;
}

function assertCanAct(room, client) {
  if (room.status !== 'playing' || !room.engine) throw new Error('当前房间不在游戏中');
  if (client.spectator || client.playerIndex === null) throw new Error('观战者不能操作');
  const expected = currentExpectedPlayerIndex(room.engine);
  if (expected === null || expected !== client.playerIndex) throw new Error('还没有轮到你操作');
}

function handleAction(room, clientToken, body = {}) {
  const client = ensureClient(room, clientToken);
  assertCanAct(room, client);
  const engine = room.engine;
  const type = String(body.type || '').trim();
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
  let result = { type };

  const ensurePlayerTurn = () => {
    if (engine.state.phase !== PHASE.PLAYER_TURN) throw new Error('\u5f53\u524d\u4e0d\u662f\u6b63\u5f0f\u56de\u5408');
  };
  const ensureUnlocked = () => {
    if (room.turnActionCommitted) throw new Error('\u672c\u56de\u5408\u52a8\u4f5c\u5df2\u7ecf\u5b8c\u6210');
  };
  const ensureFirstDie = () => {
    if (engine.state.lastDie1 === null) throw new Error('\u8bf7\u5148\u63b7\u7b2c\u4e00\u9ab0');
  };
  const ensureNoPendingCard = () => {
    if (engine.state.pendingCard) throw new Error('\u8bf7\u5148\u5b8c\u6210\u5f53\u524d\u5efa\u8bbe\u5361');
  };
  const selectCardOptions = source => {
    const selected = {};
    for (const key of ['selectedRoadToRemove', 'selectedBridgeToRoadEdge', 'selectedBridgeEdge']) {
      if (typeof source?.[key] === 'string' && source[key]) selected[key] = source[key];
    }
    return selected;
  };
  const savePendingCardOptions = options => {
    engine.state.pendingCardOptions = {
      ...(engine.state.pendingCardOptions || {}),
      ...selectCardOptions(options),
    };
  };

  if (type === 'preBuildRoad') {
    if (engine.state.phase !== PHASE.PRE_BUILD) throw new Error('\u53ea\u6709\u5f00\u5c40\u9884\u5efa\u8bbe\u9636\u6bb5\u624d\u80fd\u6267\u884c\u8be5\u64cd\u4f5c');
    engine.preBuildRoad(payload.edgeId);
    room.turnActionCommitted = false;
    room.secondDieResolved = false;
    room.secondDieBaseNodeId = null;
  } else if (type === 'startTurn') {
    ensurePlayerTurn();
    ensureUnlocked();
    if (engine.state.lastDie1 !== null) throw new Error('\u672c\u56de\u5408\u5df2\u7ecf\u5f00\u59cb\uff0c\u4e0d\u80fd\u91cd\u590d\u63b7\u7b2c\u4e00\u9ab0');
    if (engine.state.pendingCard) throw new Error('\u8bf7\u5148\u5b8c\u6210\u5f53\u524d\u5efa\u8bbe\u5361');
    engine.startTurn();
    room.turnActionCommitted = false;
    room.secondDieResolved = false;
    room.secondDieBaseNodeId = null;
  } else if (type === 'buildFromBase') {
    ensurePlayerTurn();
    ensureUnlocked();
    ensureFirstDie();
    ensureNoPendingCard();
    if (engine.state.lastDie2 !== null) throw new Error('\u7b2c\u4e8c\u9ab0\u884c\u52a8\u5df2\u7ecf\u5f00\u59cb\uff0c\u4e0d\u80fd\u518d\u8fdb\u884c\u666e\u901a\u5efa\u8bbe');
    engine.buildFromBase(payload.baseNodeId, payload.edgeId);
    room.turnActionCommitted = true;
  } else if (type === 'rollSecondDie') {
    ensurePlayerTurn();
    ensureUnlocked();
    ensureFirstDie();
    ensureNoPendingCard();
    if (engine.state.lastDie2 !== null) throw new Error('\u7b2c\u4e8c\u9ab0\u5df2\u7ecf\u63b7\u51fa\uff0c\u4e0d\u80fd\u91cd\u590d\u63b7\u9ab0');
    const baseNodeId = typeof payload.baseNodeId === 'string' ? payload.baseNodeId : '';
    const availableBases = engine.getBuildableBaseNodesForDie1(engine.currentPlayerId);
    if (!availableBases.includes(baseNodeId)) {
      throw new Error('\u8bf7\u9009\u62e9\u5f53\u524d\u53ef\u5efa\u8bbe\u7684\u57fa\u5730');
    }
    result = engine.rollSecondDieForBase(baseNodeId);
    room.secondDieBaseNodeId = baseNodeId;
    room.secondDieResolved = result.candidates.length === 0;
    if (!result.candidates.length) {
      engine.log(
        'NO_EFFECT',
        result.die2 === engine.state.lastDie1
          ? '\u7b2c\u4e8c\u9ab0\u6ca1\u6709\u7b26\u5408\u6761\u4ef6\u7684\u5efa\u8bbe\u76ee\u6807\uff0c\u672c\u6b21\u5efa\u8bbe\u65e0\u6548\u679c\uff1b\u56e0\u70b9\u6570\u76f8\u540c\uff0c\u4ecd\u53ef\u62bd\u5efa\u8bbe\u5361'
          : '\u7b2c\u4e8c\u9ab0\u6ca1\u6709\u7b26\u5408\u6761\u4ef6\u7684\u5efa\u8bbe\u76ee\u6807\uff0c\u672c\u6b21\u5efa\u8bbe\u884c\u52a8\u65e0\u6548\u679c',
        { baseNodeId: payload.baseNodeId, die2: result.die2 },
      );
      if (result.die2 !== engine.state.lastDie1) room.turnActionCommitted = true;
    }
  } else if (type === 'resolveSecondDieBuild') {
    ensurePlayerTurn();
    ensureUnlocked();
    ensureFirstDie();
    ensureNoPendingCard();
    if (engine.state.lastDie2 === null) throw new Error('\u8bf7\u5148\u63b7\u7b2c\u4e8c\u9ab0');
    if (room.secondDieResolved) throw new Error('\u7b2c\u4e8c\u9ab0\u884c\u52a8\u5df2\u7ecf\u5b8c\u6210');
    if (room.secondDieBaseNodeId && payload.baseNodeId !== room.secondDieBaseNodeId) {
      throw new Error('\u7b2c\u4e8c\u9ab0\u5fc5\u987b\u4f7f\u7528\u521a\u624d\u9009\u62e9\u7684\u57fa\u5730');
    }
    result = { result: engine.resolveSecondDieBuild(payload.baseNodeId, payload.targetNodeId) };
    room.secondDieResolved = true;
    room.turnActionCommitted = engine.state.lastDie2 !== engine.state.lastDie1;
  } else if (type === 'drawCard') {
    ensurePlayerTurn();
    ensureUnlocked();
    ensureFirstDie();
    if (engine.state.pendingCard) throw new Error('\u8bf7\u5148\u5b8c\u6210\u5f53\u524d\u5efa\u8bbe\u5361');
    if (engine.state.lastDie2 !== null) {
      if (!room.secondDieResolved) throw new Error('\u8bf7\u5148\u5b8c\u6210\u7b2c\u4e8c\u9ab0\u884c\u52a8');
      if (engine.state.lastDie2 !== engine.state.lastDie1) throw new Error('\u7b2c\u4e8c\u9ab0\u884c\u52a8\u5df2\u7ecf\u5b8c\u6210\uff0c\u4e0d\u80fd\u62bd\u5efa\u8bbe\u5361');
    }
    const card = engine.drawCard();
    const resolved = engine.resolveCard(card);
    result = { card, ...resolved };
    if (resolved.done) {
      delete engine.state.pendingCard;
      delete engine.state.pendingCardOptions;
      room.turnActionCommitted = true;
    } else {
      engine.state.pendingCard = card;
      engine.state.pendingCardOptions = {};
    }
  } else if (type === 'resolveCard') {
    ensurePlayerTurn();
    ensureUnlocked();
    ensureFirstDie();
    const card = engine.state.pendingCard;
    if (!card) throw new Error('\u6ca1\u6709\u5f85\u7ed3\u7b97\u7684\u5efa\u8bbe\u5361');
    const incomingOptions = payload.options && typeof payload.options === 'object' ? payload.options : {};
    const options = {
      ...(engine.state.pendingCardOptions || {}),
      ...selectCardOptions(incomingOptions),
    };
    const resolved = engine.resolveCard(card, options);
    result = { card, ...resolved };
    if (resolved.done) {
      delete engine.state.pendingCard;
      delete engine.state.pendingCardOptions;
      room.turnActionCommitted = true;
    } else {
      engine.state.pendingCard = card;
      savePendingCardOptions(options);
    }
  } else if (type === 'skipBuildRoad' || type === 'skipAction') {
    ensurePlayerTurn();
    ensureUnlocked();
    ensureFirstDie();
    ensureNoPendingCard();
    if (engine.state.lastDie2 !== null) throw new Error('\u7b2c\u4e8c\u9ab0\u884c\u52a8\u5df2\u7ecf\u5f00\u59cb\uff0c\u4e0d\u80fd\u8df3\u8fc7\u666e\u901a\u5efa\u8bbe');
    const candidates = engine.getBuildableBaseNodesForDie1(engine.currentPlayerId);
    if (candidates.length) throw new Error('\u4ecd\u6709\u7b26\u5408\u6761\u4ef6\u7684\u57fa\u5730\uff0c\u4e0d\u80fd\u8df3\u8fc7\u5efa\u8bbe\u884c\u52a8');
    engine.log('NO_EFFECT', `\u7b2c\u4e00\u9ab0\u4e3a ${engine.state.lastDie1}\uff0c\u6ca1\u6709\u7b26\u5408\u6761\u4ef6\u7684\u57fa\u5730\uff0c\u672c\u6b21\u5efa\u8bbe\u884c\u52a8\u65e0\u6548\u679c`);
    room.turnActionCommitted = true;
    result = { type, skipped: true, reason: 'NO_EFFECT' };
  } else if (type === 'finishTurn') {
    ensurePlayerTurn();
    ensureFirstDie();
    if (engine.state.pendingCard) throw new Error('\u8bf7\u5148\u5b8c\u6210\u5f53\u524d\u5efa\u8bbe\u5361');
    if (engine.state.lastDie2 !== null && !room.secondDieResolved) throw new Error('\u8bf7\u5148\u5b8c\u6210\u7b2c\u4e8c\u9ab0\u884c\u52a8');
    if (!room.turnActionCommitted) throw new Error('\u5f53\u524d\u56de\u5408\u5c1a\u672a\u5b8c\u6210\u884c\u52a8');
    engine.finishActionAndAdvance();
    room.turnActionCommitted = engine.state.phase !== PHASE.PLAYER_TURN;
    room.secondDieResolved = false;
    room.secondDieBaseNodeId = null;
  } else {
    throw new Error('\u672a\u77e5\u52a8\u4f5c\u7c7b\u578b');
  }

  if (engine.state.phase === PHASE.GAME_END) {
    room.status = 'game_over';
    room.turnActionCommitted = true;
    room.secondDieResolved = false;
    room.secondDieBaseNodeId = null;
  }
  room.flash = null;
  touch(room);
  broadcast(room);
  return result;
}
function detachSubscriber(room, sub, { end = false, markDisconnected = true, broadcastOnChange = true } = {}) {
  if (sub.closed) return false;
  sub.closed = true;
  room.subscribers.delete(sub);
  if (sub.heartbeat) {
    clearInterval(sub.heartbeat);
    sub.heartbeat = null;
  }
  if (end && !sub.res.writableEnded) {
    try { sub.res.end(); } catch { /* the socket may already be closed */ }
  }
  if (!markDisconnected) return false;
  const changed = markClientDisconnectedIfUnused(room, sub.clientToken);
  if (changed && broadcastOnChange) {
    touch(room);
    broadcast(room);
  }
  return changed;
}

function closeClientSubscribers(room, clientToken) {
  const token = normalizeToken(clientToken);
  for (const sub of [...room.subscribers]) {
    if (sub.clientToken === token) {
      detachSubscriber(room, sub, { end: true, markDisconnected: false, broadcastOnChange: false });
    }
  }
}

function closeRoomSubscribers(room) {
  for (const sub of [...room.subscribers]) {
    detachSubscriber(room, sub, { end: true, markDisconnected: false, broadcastOnChange: false });
  }
  room.subscribers.clear();
}

function sendSse(sub, room) {
  if (sub.closed) return;
  if (sub.res.destroyed || sub.res.writableEnded) {
    detachSubscriber(room, sub);
    return;
  }
  try {
    sub.res.write(`event: room\ndata: ${JSON.stringify(publicRoom(room, sub.clientToken))}\n\n`);
  } catch {
    detachSubscriber(room, sub);
  }
}

function broadcast(room, excludedSubscriber = null) {
  for (const sub of [...room.subscribers]) {
    if (sub !== excludedSubscriber) sendSse(sub, room);
  }
}

function cleanupRooms() {
  const current = Date.now();
  for (const [id, room] of rooms) {
    const age = current - Date.parse(room.updatedAt);
    if (room.status === 'game_over' && age > GAME_OVER_TTL_MS) {
      closeRoomSubscribers(room);
      rooms.delete(id);
      continue;
    }
    if (room.status === 'waiting') {
      const hasConnected = [...room.clients.values()].some(client => client.connected);
      if (!hasConnected && age > WAITING_DISCONNECTED_TTL_MS) {
        closeRoomSubscribers(room);
        rooms.delete(id);
        continue;
      }
    }
    if (age > ROOM_TTL_MS) {
      closeRoomSubscribers(room);
      rooms.delete(id);
    }
  }
}

function serveStatic(req, res, url) {
  const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const relative = path.normalize(requested).replace(/^([.][.][\\/])+/, '');
  const filePath = path.resolve(__dirname, `.${relative}`);
  if (filePath !== __dirname && !filePath.startsWith(`${__dirname}${path.sep}`)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }
  try {
    cleanupRooms();
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && url.pathname === '/api/rooms') {
      json(res, 200, { rooms: [...rooms.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(roomListItem) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const created = createRoom(await readBody(req));
      json(res, 200, { clientToken: created.clientToken, room: publicRoom(created.room, created.clientToken) });
      return;
    }
    if (parts[0] !== 'api' || parts[1] !== 'rooms' || !parts[2]) {
      json(res, 404, { error: 'API 不存在' });
      return;
    }
    const room = ensureRoom(parts[2]);
    if (req.method === 'GET' && parts.length === 3) {
      const token = url.searchParams.get('clientToken') || '';
      if (token) { const viewer = getClient(room, token); if (viewer) viewer.lastSeen = Date.now(); }
      json(res, 200, { room: publicRoom(room, token) });
      return;
    }
    if (req.method === 'GET' && parts[3] === 'events') {
      const token = normalizeToken(url.searchParams.get('clientToken') || '');
      const client = ensureClient(room, token);
      const wasConnected = Boolean(client.connected);
      client.connected = true;
      client.lastSeen = Date.now();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const sub = { res, clientToken: token, closed: false, heartbeat: null };
      room.subscribers.add(sub);
      try {
        res.write(`event: room\ndata: ${JSON.stringify(publicRoom(room, token))}\n\n`);
      } catch {
        detachSubscriber(room, sub);
        return;
      }
      sub.heartbeat = setInterval(() => {
        if (sub.closed) return;
        try { res.write(': heartbeat\n\n'); }
        catch { detachSubscriber(room, sub); }
      }, 20000);
      const close = () => detachSubscriber(room, sub);
      req.on('close', close);
      res.on('close', close);
      // Notify existing clients when this connection changes the visible
      // online state, without sending a duplicate event to the new stream.
      if (!wasConnected) {
        touch(room);
        broadcast(room, sub);
      }
      return;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: '只支持 GET/POST' });
      return;
    }
    const body = await readBody(req);
    if (parts[3] === 'join') {
      const joined = joinRoom(room, body);
      json(res, 200, { clientToken: joined.clientToken, room: publicRoom(room, joined.clientToken) });
    } else if (parts[3] === 'leave') {
      leaveRoom(room, body.clientToken);
      json(res, 200, { ok: true });
    } else if (parts[3] === 'ready') {
      setReady(room, body.clientToken, body.ready);
      json(res, 200, { room: publicRoom(room, body.clientToken) });
    } else if (parts[3] === 'kick') {
      kickPlayer(room, body.clientToken, body.playerIndex);
      json(res, 200, { room: publicRoom(room, body.clientToken) });
    } else if (parts[3] === 'chat') {
      const client = ensureClient(room, body.clientToken);
      roomChat(room, client, body.message);
      touch(room); broadcast(room);
      json(res, 200, { room: publicRoom(room, body.clientToken) });
    } else if (parts[3] === 'start') {
      startRoom(room, body.clientToken);
      json(res, 200, { room: publicRoom(room, body.clientToken) });
    } else if (parts[3] === 'actions') {
      const result = handleAction(room, body.clientToken, body);
      json(res, 200, { room: publicRoom(room, body.clientToken), result });
    } else {
      json(res, 404, { error: '房间接口不存在' });
    }
  } catch (error) {
    json(res, 400, { error: error?.message || String(error) });
  }
}

export function createAppServer({ port = 0, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  });
  server.on('close', () => {
    for (const room of rooms.values()) closeRoomSubscribers(room);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createAppServer({ port: DEFAULT_PORT, host: '0.0.0.0' });
  console.log(`城乡基建服务器已启动：http://127.0.0.1:${DEFAULT_PORT}/`);
  console.log('支持本地模式、线上房间、SSE 实时同步与断线重连。');
  const cleanupTimer = setInterval(cleanupRooms, 30_000);
  cleanupTimer.unref?.();
  const close = () => { clearInterval(cleanupTimer); server.close(() => process.exit(0)); };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

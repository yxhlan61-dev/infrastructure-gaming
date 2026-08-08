import { GameEngine, PHASE, cardName } from '../src/game.js';

const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const WAITING_DISCONNECTED_TTL_MS = 10 * 60 * 1000;
const PLAYING_DISCONNECTED_TTL_MS = 60 * 1000;
const GAME_OVER_TTL_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

function nowIso() { return new Date().toISOString(); }
function randomId(prefix = '') {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${prefix}${hex}${Date.now().toString(36).slice(-4).toUpperCase()}`;
}
function newClientToken() { return `C${randomId().slice(0, 18)}`; }
function newRoomId() { return randomId('R').slice(0, 10); }
function sanitizeName(value, fallback, max = 18) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return (text || fallback).slice(0, max);
}
function normalizeRoomId(value) { return String(value || '').trim().toUpperCase(); }
function normalizeToken(value) { return String(value || '').trim().toUpperCase(); }
function isValidRoomId(value) { return /^R[A-Z0-9]{6,16}$/.test(normalizeRoomId(value)); }

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    },
  });
}
async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('request body too large');
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new Error('invalid JSON body'); }
}
function roomNotice(room, type, message) {
  room.notices.unshift({ id: randomId('N'), type, message, createdAt: nowIso() });
  room.notices = room.notices.slice(0, 30);
}
function roomChat(room, client, message) {
  const text = String(message || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  if (!text) throw new Error('chat message cannot be empty');
  room.chat.push({
    id: randomId('M'),
    sender: client?.playerName || 'Player',
    playerIndex: client?.playerIndex ?? null,
    message: text,
    createdAt: nowIso(),
  });
  room.chat = room.chat.slice(-80);
}

function setRoomFlash(room, client, type, title, message, payload = {}) {
  room.flash = {
    id: randomId('F'),
    type,
    title,
    message,
    playerIndex: client?.playerIndex ?? null,
    playerName: client?.playerName || '',
    createdAt: nowIso(),
    payload,
  };
}
function setLiveAction(room, client, mode, payload = {}) {
  room.liveAction = {
    id: randomId('A'),
    mode,
    playerIndex: client?.playerIndex ?? null,
    playerName: client?.playerName || '',
    createdAt: nowIso(),
    ...payload,
  };
}
function clearLiveAction(room) { room.liveAction = null; }

function occupiedSeats(room) { return room.seats.filter(seat => seat.clientToken); }
function allReady(room) {
  return occupiedSeats(room).length === room.playerCount
    && occupiedSeats(room).every(seat => seat.clientToken === room.hostClientToken || Boolean(room.clients.get(seat.clientToken)?.ready));
}
function getClient(room, clientToken) {
  const token = normalizeToken(clientToken);
  return token ? room.clients.get(token) || null : null;
}
function ensureRoom(rooms, roomId) {
  const id = normalizeRoomId(roomId);
  if (!isValidRoomId(id) || !rooms.has(id)) throw new Error('room does not exist or was closed');
  return rooms.get(id);
}
function ensureClient(room, clientToken) {
  const token = normalizeToken(clientToken);
  const client = getClient(room, token);
  if (!client) throw new Error('online session expired; please join the room again');
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
    revision: Number(room.revision) || 0,
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
    liveAction: room.liveAction || null,
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
function touch(room) {
  room.updatedAt = nowIso();
  room.revision = (Number(room.revision) || 0) + 1;
}

function hydrateRoom(data) {
  const room = {
    ...data,
    revision: Number(data.revision) || 0,
    liveAction: data.liveAction || null,
    clients: new Map((data.clients || []).map(client => [client.clientToken, { ...client, connected: false }])),
    engine: data.engineState ? GameEngine.fromState(data.engineState) : null,
    subscribers: new Set(),
  };
  delete room.engineState;
  return room;
}
function serializeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    playerCount: room.playerCount,
    status: room.status,
    hostClientToken: room.hostClientToken,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    revision: Number(room.revision) || 0,
    seats: room.seats,
    clients: [...room.clients.values()].map(client => ({ ...client, connected: false })),
    engineState: room.engine?.state || null,
    chat: room.chat,
    notices: room.notices,
    flash: room.flash,
    liveAction: room.liveAction || null,
    turnActionCommitted: Boolean(room.turnActionCommitted),
    secondDieResolved: Boolean(room.secondDieResolved),
    secondDieBaseNodeId: room.secondDieBaseNodeId || null,
  };
}

export class GameLobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = null;
  }

  async ensureLoaded() {
    if (this.rooms) return;
    const saved = await this.state.storage.get('rooms');
    this.rooms = new Map(Array.isArray(saved) ? saved.map(item => [item.id, hydrateRoom(item)]) : []);
  }
  async persist() {
    await this.state.storage.put('rooms', [...this.rooms.values()].map(serializeRoom));
  }
  async mutate(room = null) {
    if (room) touch(room);
    await this.persist();
    if (room) this.broadcast(room);
  }

  createRoom({ roomName, playerName, playerCount } = {}) {
    const count = Number(playerCount || 2);
    if (![2, 3, 4].includes(count)) throw new Error('room size must be 2 to 4 players');
    const id = newRoomId();
    const hostToken = newClientToken();
    const hostName = sanitizeName(playerName, 'Host');
    const room = {
      id,
      name: sanitizeName(roomName, '城乡基建房间', 24),
      playerCount: count,
      status: 'waiting',
      hostClientToken: hostToken,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      revision: 0,
      seats: Array.from({ length: count }, (_, index) => ({ index, name: '', clientToken: null })),
      clients: new Map(),
      engine: null,
      chat: [],
      notices: [],
      flash: null,
      liveAction: null,
      turnActionCommitted: false,
      secondDieResolved: false,
      secondDieBaseNodeId: null,
      subscribers: new Set(),
    };
    room.seats[0] = { index: 0, name: hostName, clientToken: hostToken };
    room.clients.set(hostToken, { clientToken: hostToken, playerIndex: 0, playerName: hostName, ready: true, connected: true, spectator: false, lastSeen: Date.now() });
    this.rooms.set(id, room);
    roomNotice(room, 'system', `${hostName} created the room.`);
    return { room, clientToken: hostToken };
  }

  joinRoom(room, { playerName, clientToken, spectator = false } = {}) {
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
      return { clientToken: incomingToken, room };
    }
    if (room.status !== 'waiting') {
      if (!spectator) throw new Error('game already started; join as spectator');
      const token = newClientToken();
      const name = sanitizeName(playerName, 'Spectator');
      room.clients.set(token, { clientToken: token, playerIndex: null, playerName: name, ready: false, connected: true, spectator: true, lastSeen: Date.now() });
      roomNotice(room, 'system', `${name} joined as spectator.`);
      return { clientToken: token, room };
    }
    const seat = room.seats.find(item => !item.clientToken);
    if (!seat) throw new Error('room is full');
    const token = newClientToken();
    const name = sanitizeName(playerName, `Player ${seat.index + 1}`);
    seat.name = name;
    seat.clientToken = token;
    room.clients.set(token, { clientToken: token, playerIndex: seat.index, playerName: name, ready: false, connected: true, spectator: false, lastSeen: Date.now() });
    roomNotice(room, 'system', `${name} joined the room.`);
    return { clientToken: token, room };
  }

  setReady(room, clientToken, ready) {
    const client = ensureClient(room, clientToken);
    if (room.status !== 'waiting') throw new Error('game already started');
    if (client.spectator) throw new Error('spectators cannot ready');
    client.ready = client.clientToken === room.hostClientToken ? true : Boolean(ready);
    roomNotice(room, 'system', `${client.playerName} ${client.ready ? 'is ready' : 'cancelled ready'}.`);
  }

  leaveRoom(room, clientToken) {
    const client = ensureClient(room, clientToken);
    const seat = client.playerIndex === null ? null : room.seats[client.playerIndex];
    if (room.status === 'waiting') {
      if (seat?.clientToken === client.clientToken) { seat.clientToken = null; seat.name = ''; }
      room.clients.delete(client.clientToken);
      if (client.clientToken === room.hostClientToken) {
        const replacement = occupiedSeats(room)[0];
        room.hostClientToken = replacement?.clientToken || null;
        if (replacement) room.clients.get(replacement.clientToken).ready = true;
      }
      roomNotice(room, 'system', `${client.playerName} left the room.`);
      if (!occupiedSeats(room).length && ![...room.clients.values()].some(item => item.spectator)) {
        this.closeRoomSubscribers(room);
        this.rooms.delete(room.id);
        return { closed: true };
      }
      return { closed: false };
    }
    if (client.spectator) {
      room.clients.delete(client.clientToken);
      roomNotice(room, 'system', `${client.playerName} left spectator mode.`);
      return { closed: false };
    }
    client.connected = false;
    roomNotice(room, 'system', `${client.playerName} left the game; the room is now closed.`);
    this.broadcast(room);
    this.closeRoomSubscribers(room);
    this.rooms.delete(room.id);
    return { closed: true };
  }


  kickPlayer(room, hostToken, playerIndex) {
    const host = ensureClient(room, hostToken);
    if (host.clientToken !== room.hostClientToken) throw new Error('only host can kick players');
    if (room.status !== 'waiting') throw new Error('cannot kick after game start');
    const index = Number(playerIndex);
    const seat = room.seats[index];
    if (!seat?.clientToken || seat.clientToken === host.clientToken) throw new Error('cannot kick that seat');
    const client = room.clients.get(seat.clientToken);
    this.closeClientSubscribers(room, client.clientToken);
    client.connected = false;
    seat.clientToken = null;
    seat.name = '';
    room.clients.delete(client.clientToken);
    roomNotice(room, 'system', `${client.playerName} was kicked by host.`);
  }

  startRoom(room, clientToken) {
    const host = ensureClient(room, clientToken);
    if (host.clientToken !== room.hostClientToken) throw new Error('only host can start the game');
    if (room.status !== 'waiting') throw new Error('room already started or finished');
    if (occupiedSeats(room).length !== room.playerCount) throw new Error('all seats must be occupied');
    if (!allReady(room)) throw new Error('some players are not ready');
    const players = room.seats.map(seat => ({ name: seat.name }));
    room.engine = new GameEngine({ players, seed: `${room.id}-${Date.now()}` });
    room.status = 'playing';
    roomNotice(room, 'system', 'Game started. Pre-build begins by seat order.');
  }

  currentExpectedPlayerIndex(engine) {
    if (engine.state.phase === PHASE.PRE_BUILD) return engine.state.preBuildIndex;
    if (engine.state.phase === PHASE.PLAYER_TURN) return engine.state.currentPlayerIndex;
    return null;
  }
  assertCanAct(room, client) {
    if (room.status !== 'playing' || !room.engine) throw new Error('room is not currently playing');
    if (client.spectator || client.playerIndex === null) throw new Error('spectators cannot act');
    const expected = this.currentExpectedPlayerIndex(room.engine);
    if (expected === null || expected !== client.playerIndex) throw new Error('not your turn');
  }

  handleAction(room, clientToken, body = {}) {
    const client = ensureClient(room, clientToken);
    this.assertCanAct(room, client);
    const engine = room.engine;
    const type = String(body.type || '').trim();
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    let result = { type };

    const ensurePlayerTurn = () => {
      if (engine.state.phase !== PHASE.PLAYER_TURN) throw new Error('current phase is not a player turn');
    };
    const ensureUnlocked = () => {
      if (room.turnActionCommitted) throw new Error('this turn action is already complete');
    };
    const ensureFirstDie = () => {
      if (engine.state.lastDie1 === null) throw new Error('roll the first die first');
    };
    const ensureNoPendingCard = () => {
      if (engine.state.pendingCard) throw new Error('resolve the current card first');
    };
    const selectCardOptions = source => {
      const selected = {};
      for (const key of ['selectedRoadToRemove', 'selectedBridgeToRoadEdge', 'selectedBridgeEdge']) {
        if (typeof source?.[key] === 'string' && source[key]) selected[key] = source[key];
      }
      return selected;
    };
    const savePendingCardOptions = options => {
      engine.state.pendingCardOptions = { ...(engine.state.pendingCardOptions || {}), ...selectCardOptions(options) };
    };
    const latestLogMessage = (fallback, types = []) => {
      const wanted = new Set(Array.isArray(types) ? types : [types]);
      const entry = wanted.size
        ? engine.state.log?.find(log => wanted.has(log.type))
        : engine.state.log?.at(-1);
      return entry?.message || fallback;
    };
    const stepLabel = mode => ({
      CHOOSE_ACTION: 'choosing the action for this turn',
      SELECT_BASE_ROAD: 'choosing the base for action 2',
      SELECT_EDGE_ROAD: 'choosing the road for action 2',
      SELECT_BASE_SECOND: 'choosing the base for action 3',
      SELECT_EDGE_SECOND: 'choosing the second-die build target',
      CARD_SELECT_BRIDGE_TO_ROAD: 'choosing the bridge-to-road card target',
      CARD_SELECT_ROAD_TO_REMOVE: 'choosing the road to remove',
      CARD_SELECT_BRIDGE_EDGE: 'choosing the bridge to build',
    }[mode] || mode);
    const setPendingCardLiveAction = (card, resolved, options = {}) => {
      if (resolved.done) { clearLiveAction(room); return; }
      const common = { card, ...resolved, ...options };
      setLiveAction(room, client, resolved.needs, common);
    };

    if (type === 'preBuildRoad') {
      if (engine.state.phase !== PHASE.PRE_BUILD) throw new Error('only the pre-build phase accepts this action');
      engine.preBuildRoad(payload.edgeId);
      room.turnActionCommitted = false;
      room.secondDieResolved = false;
      room.secondDieBaseNodeId = null;
      clearLiveAction(room);
      setRoomFlash(room, client, 'ROAD_BUILT', `${client.playerName} \u5b8c\u6210\u521d\u59cb\u5efa\u8bbe`, latestLogMessage('\u521d\u59cb\u9053\u8def\u5df2\u5efa\u8bbe', ['ROAD_BUILT']), { edgeId: payload.edgeId });
    } else if (type === 'startTurn') {
      ensurePlayerTurn(); ensureUnlocked();
      if (engine.state.lastDie1 !== null) throw new Error('the first die has already been rolled');
      if (engine.state.pendingCard) throw new Error('resolve the current card first');
      engine.startTurn();
      room.turnActionCommitted = false;
      room.secondDieResolved = false;
      room.secondDieBaseNodeId = null;
      setLiveAction(room, client, 'CHOOSE_ACTION', { die1: engine.state.lastDie1 });
      setRoomFlash(room, client, 'DICE_ROLLED', `${client.playerName} \u63b7\u51fa\u7b2c\u4e00\u9ab0`, latestLogMessage(`\u7b2c\u4e00\u9ab0\uff1a${engine.state.lastDie1}`, ['DICE_ROLLED']), { die1: engine.state.lastDie1 });
    } else if (type === 'syncActionStep') {
      ensurePlayerTurn(); ensureUnlocked(); ensureFirstDie(); ensureNoPendingCard();
      if (engine.state.lastDie2 !== null) throw new Error('the second-die action has already started');
      const mode = String(payload.mode || '').trim();
      const availableBases = engine.getBuildableBaseNodesForDie1(engine.currentPlayerId);
      if (!['CHOOSE_ACTION', 'SELECT_BASE_ROAD', 'SELECT_EDGE_ROAD', 'SELECT_BASE_SECOND'].includes(mode)) throw new Error('invalid action step');
      if (mode === 'SELECT_EDGE_ROAD') {
        if (!availableBases.includes(payload.baseNodeId)) throw new Error('choose an available base');
        const candidates = engine.getBuildableRoadEdgesFromBase(engine.currentPlayerId, payload.baseNodeId).map(edge => edge.id);
        if (!candidates.length) throw new Error('that base has no buildable road');
        setLiveAction(room, client, mode, { baseNodeId: payload.baseNodeId, candidateEdgeIds: candidates });
      } else {
        if (['SELECT_BASE_ROAD', 'SELECT_BASE_SECOND'].includes(mode) && !availableBases.length) throw new Error('there are no available bases');
        setLiveAction(room, client, mode, { availableBaseIds: availableBases });
      }
      result = { type, mode, ...room.liveAction };
      setRoomFlash(room, client, 'ACTION_STEP', `${client.playerName} is acting`, stepLabel(mode), { mode, ...room.liveAction });
    } else if (type === 'buildFromBase') {
      ensurePlayerTurn(); ensureUnlocked(); ensureFirstDie(); ensureNoPendingCard();
      if (engine.state.lastDie2 !== null) throw new Error('the second-die action has already started');
      engine.buildFromBase(payload.baseNodeId, payload.edgeId);
      room.turnActionCommitted = true;
      clearLiveAction(room);
      setRoomFlash(room, client, 'ROAD_BUILT', `${client.playerName} \u5b8c\u6210\u884c\u52a82\u5efa\u8bbe`, latestLogMessage('\u9053\u8def\u5df2\u5efa\u8bbe', ['ROAD_BUILT']), { baseNodeId: payload.baseNodeId, edgeId: payload.edgeId });
    } else if (type === 'rollSecondDie' || type === 'rollSecondDieForBase') {
      ensurePlayerTurn(); ensureUnlocked(); ensureFirstDie(); ensureNoPendingCard();
      if (engine.state.lastDie2 !== null) throw new Error('the second die has already been rolled');
      const baseNodeId = typeof payload.baseNodeId === 'string' ? payload.baseNodeId : '';
      const availableBases = engine.getBuildableBaseNodesForDie1(engine.currentPlayerId);
      if (!availableBases.includes(baseNodeId)) throw new Error('choose an available base');
      result = engine.rollSecondDieForBase(baseNodeId);
      room.secondDieBaseNodeId = baseNodeId;
      room.secondDieResolved = result.candidates.length === 0;
      if (!result.candidates.length) {
        engine.log('NO_EFFECT', result.die2 === engine.state.lastDie1 ? 'Second die has no build target; pair still grants a card.' : 'Second die has no build target.', { baseNodeId, die2: result.die2 });
        if (result.die2 !== engine.state.lastDie1) room.turnActionCommitted = true;
      }
      if (result.candidates.length) setLiveAction(room, client, 'SELECT_EDGE_SECOND', { baseNodeId, candidateNodeIds: result.candidates });
      else if (result.die2 === engine.state.lastDie1) setLiveAction(room, client, 'CHOOSE_ACTION', { die1: engine.state.lastDie1, die2: result.die2, cardAvailable: true });
      else clearLiveAction(room);
      setRoomFlash(room, client, 'DICE_ROLLED', `${client.playerName} \u63b7\u51fa\u7b2c\u4e8c\u9ab0`, latestLogMessage(`\u7b2c\u4e8c\u9ab0\uff1a${result.die2}`, ['DICE_ROLLED', 'NO_EFFECT']), { baseNodeId, die2: result.die2, candidates: result.candidates });
    } else if (type === 'resolveSecondDieBuild') {
      ensurePlayerTurn(); ensureUnlocked(); ensureFirstDie(); ensureNoPendingCard();
      if (engine.state.lastDie2 === null) throw new Error('roll the second die first');
      if (room.secondDieResolved) throw new Error('the second-die action is already resolved');
      if (room.secondDieBaseNodeId && payload.baseNodeId !== room.secondDieBaseNodeId) throw new Error('use the selected second-die base');
      const buildResult = engine.resolveSecondDieBuild(payload.baseNodeId, payload.targetNodeId);
      result = { result: buildResult };
      room.secondDieResolved = true;
      room.turnActionCommitted = engine.state.lastDie2 !== engine.state.lastDie1;
      if (engine.state.lastDie2 === engine.state.lastDie1 && !room.turnActionCommitted) setLiveAction(room, client, 'CHOOSE_ACTION', { die1: engine.state.lastDie1, die2: engine.state.lastDie2, cardAvailable: true });
      else clearLiveAction(room);
      setRoomFlash(room, client, buildResult === 'BRIDGE' ? 'BRIDGE_BUILT' : buildResult === 'ROAD' ? 'ROAD_BUILT' : 'NO_EFFECT', `${client.playerName} \u5b8c\u6210\u7b2c\u4e8c\u9ab0\u5efa\u8bbe`, latestLogMessage(`\u7b2c\u4e8c\u9ab0\u5efa\u8bbe\u7ed3\u679c\uff1a${buildResult}`, ['ROAD_BUILT', 'BRIDGE_BUILT', 'NO_EFFECT']), { baseNodeId: payload.baseNodeId, targetNodeId: payload.targetNodeId, result: buildResult });
    } else if (type === 'drawCard') {
      ensurePlayerTurn(); ensureUnlocked(); ensureFirstDie();
      if (engine.state.pendingCard) throw new Error('resolve the current card first');
      if (engine.state.lastDie2 !== null) {
        if (!room.secondDieResolved) throw new Error('resolve the second-die action first');
        if (engine.state.lastDie2 !== engine.state.lastDie1) throw new Error('there is no card opportunity now');
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
      setPendingCardLiveAction(card, resolved);
      setRoomFlash(room, client, 'CARD_DRAWN', `${client.playerName} \u62bd\u5230\u5efa\u8bbe\u5361\uff1a${cardName(card)}`, resolved.done ? (resolved.announcement || `\u5efa\u8bbe\u5361\u5df2\u7ed3\u7b97\uff1a${cardName(card)}`) : `\u7b49\u5f85\u9009\u62e9\u76ee\u6807\uff1a${stepLabel(resolved.needs)}`, { card, ...resolved });
    } else if (type === 'resolveCard') {
      ensurePlayerTurn(); ensureUnlocked(); ensureFirstDie();
      const card = engine.state.pendingCard;
      if (!card) throw new Error('no pending card');
      const incomingOptions = payload.options && typeof payload.options === 'object' ? payload.options : {};
      const options = { ...(engine.state.pendingCardOptions || {}), ...selectCardOptions(incomingOptions) };
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
      setPendingCardLiveAction(card, resolved, options);
      setRoomFlash(room, client, resolved.done ? 'CARD_RESOLVED' : 'ACTION_STEP', resolved.done ? `${client.playerName} \u7ed3\u7b97\u5efa\u8bbe\u5361\uff1a${cardName(card)}` : `${client.playerName} \u6b63\u5728\u7ed3\u7b97\u5efa\u8bbe\u5361\uff1a${cardName(card)}`, resolved.done ? (resolved.announcement || '\u5efa\u8bbe\u5361\u5df2\u7ed3\u7b97') : stepLabel(resolved.needs), { card, options, ...resolved });
    } else if (type === 'skipBuildRoad' || type === 'skipAction') {
      ensurePlayerTurn(); ensureUnlocked(); ensureFirstDie(); ensureNoPendingCard();
      if (engine.state.lastDie2 !== null) throw new Error('the second-die action has already started');
      const candidates = engine.getBuildableBaseNodesForDie1(engine.currentPlayerId);
      if (candidates.length) throw new Error('there are available bases; cannot skip');
      engine.log('NO_EFFECT', `First die ${engine.state.lastDie1} has no available base; action skipped.`);
      room.turnActionCommitted = true;
      result = { type, skipped: true, reason: 'NO_EFFECT' };
      clearLiveAction(room);
      setRoomFlash(room, client, 'NO_EFFECT', `${client.playerName} \u8df3\u8fc7\u884c\u52a8`, latestLogMessage('\u884c\u52a8\u65e0\u6548', ['NO_EFFECT']));
    } else if (type === 'finishTurn') {
      ensurePlayerTurn(); ensureFirstDie();
      if (engine.state.pendingCard) throw new Error('resolve the current card first');
      if (engine.state.lastDie2 !== null && !room.secondDieResolved) throw new Error('resolve the second-die action first');
      if (!room.turnActionCommitted) throw new Error('the turn action is not complete');
      engine.finishActionAndAdvance();
      room.turnActionCommitted = engine.state.phase !== PHASE.PLAYER_TURN;
      room.secondDieResolved = false;
      room.secondDieBaseNodeId = null;
      clearLiveAction(room);
    } else {
      throw new Error('unknown action type');
    }

    if (engine.state.phase === PHASE.GAME_END) {
      room.status = 'game_over';
      room.turnActionCommitted = true;
      room.secondDieResolved = false;
      room.secondDieBaseNodeId = null;
      clearLiveAction(room);
    }
    return result;
  }

  detachSubscriber(room, sub, { close = false, markDisconnected = true, broadcastOnChange = true } = {}) {
    if (sub.closed) return false;
    sub.closed = true;
    room.subscribers.delete(sub);
    if (sub.heartbeat) clearInterval(sub.heartbeat);
    if (close) {
      try { sub.controller.close(); } catch {}
    }
    if (!markDisconnected) return false;
    const changed = markClientDisconnectedIfUnused(room, sub.clientToken);
    if (changed && broadcastOnChange) {
      touch(room);
      this.persist().then(() => this.broadcast(room));
    }
    return changed;
  }
  closeClientSubscribers(room, clientToken) {
    const token = normalizeToken(clientToken);
    for (const sub of [...room.subscribers]) {
      if (sub.clientToken === token) this.detachSubscriber(room, sub, { close: true, markDisconnected: false, broadcastOnChange: false });
    }
  }
  closeRoomSubscribers(room) {
    for (const sub of [...room.subscribers]) this.detachSubscriber(room, sub, { close: true, markDisconnected: false, broadcastOnChange: false });
    room.subscribers.clear();
  }
  sendSse(sub, room) {
    if (sub.closed) return;
    try { sub.controller.enqueue(encoder.encode(`event: room\ndata: ${JSON.stringify(publicRoom(room, sub.clientToken))}\n\n`)); }
    catch { this.detachSubscriber(room, sub); }
  }
  broadcast(room, excludedSubscriber = null) {
    for (const sub of [...room.subscribers]) if (sub !== excludedSubscriber) this.sendSse(sub, room);
  }
  async cleanupRooms() {
    const current = Date.now();
    let changed = false;
    for (const [id, room] of this.rooms) {
      const age = current - Date.parse(room.updatedAt);
      const hasConnected = [...room.clients.values()].some(client => client.connected);
      const staleGameOver = room.status === 'game_over' && age > GAME_OVER_TTL_MS;
      const staleWaiting = room.status === 'waiting' && !hasConnected && age > WAITING_DISCONNECTED_TTL_MS;
      const stalePlaying = room.status === 'playing' && !hasConnected && age > PLAYING_DISCONNECTED_TTL_MS;
      if (staleGameOver || staleWaiting || stalePlaying || age > ROOM_TTL_MS) {
        this.closeRoomSubscribers(room);
        this.rooms.delete(id);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async sseResponse(request, room, token) {
    const client = ensureClient(room, token);
    const wasConnected = Boolean(client.connected);
    client.connected = true;
    client.lastSeen = Date.now();
    let sub;
    const close = () => {
      if (sub) this.detachSubscriber(room, sub);
    };
    if (!wasConnected) {
      // Presence changed, so persist one new revision before the first
      // snapshot. Reconnects for an already-online client do not invalidate
      // every player's render tree.
      touch(room);
      await this.persist();
    }
    const stream = new ReadableStream({
      start: controller => {
        sub = { controller, clientToken: token, closed: false, heartbeat: null };
        room.subscribers.add(sub);
        this.sendSse(sub, room);
        sub.heartbeat = setInterval(() => {
          if (sub.closed) return;
          try { sub.controller.enqueue(encoder.encode(': heartbeat\n\n')); }
          catch { this.detachSubscriber(room, sub); }
        }, 20000);
        request.signal?.addEventListener('abort', close, { once: true });
      },
      cancel: close,
    });
    if (!wasConnected && sub) this.broadcast(room, sub);
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'connection': 'keep-alive',
        'access-control-allow-origin': '*',
      },
    });
  }

  async fetch(request) {
    await this.ensureLoaded();
    if (request.method === 'OPTIONS') return json(204, {});
    await this.cleanupRooms();
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (request.method === 'GET' && url.pathname === '/api/rooms') {
        const list = [...this.rooms.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(roomListItem);
        return json(200, { rooms: list });
      }
      if (request.method === 'POST' && url.pathname === '/api/rooms') {
        const created = this.createRoom(await readBody(request));
        await this.mutate(created.room);
        return json(200, { clientToken: created.clientToken, room: publicRoom(created.room, created.clientToken) });
      }
      if (parts[0] !== 'api' || parts[1] !== 'rooms' || !parts[2]) return json(404, { error: 'API not found' });
      const room = ensureRoom(this.rooms, parts[2]);
      if (request.method === 'GET' && parts.length === 3) {
        const token = url.searchParams.get('clientToken') || '';
        if (token) { const viewer = getClient(room, token); if (viewer) viewer.lastSeen = Date.now(); }
        return json(200, { room: publicRoom(room, token) });
      }
      if (request.method === 'GET' && parts[3] === 'events') {
        const token = normalizeToken(url.searchParams.get('clientToken') || '');
        return await this.sseResponse(request, room, token);
      }
      if (request.method !== 'POST') return json(405, { error: 'only GET/POST supported' });
      const body = await readBody(request);
      if (parts[3] === 'join') {
        const joined = this.joinRoom(room, body);
        await this.mutate(room);
        return json(200, { clientToken: joined.clientToken, room: publicRoom(room, joined.clientToken) });
      }
      if (parts[3] === 'leave') {
        const result = this.leaveRoom(room, body.clientToken);
        if (!result?.closed) await this.mutate(room);
        else await this.persist();
        return json(200, { ok: true });
      }
      if (parts[3] === 'ready') {
        this.setReady(room, body.clientToken, body.ready);
        await this.mutate(room);
        return json(200, { room: publicRoom(room, body.clientToken) });
      }
      if (parts[3] === 'kick') {
        this.kickPlayer(room, body.clientToken, body.playerIndex);
        await this.mutate(room);
        return json(200, { room: publicRoom(room, body.clientToken) });
      }
      if (parts[3] === 'chat') {
        const client = ensureClient(room, body.clientToken);
        roomChat(room, client, body.message);
        await this.mutate(room);
        return json(200, { room: publicRoom(room, body.clientToken) });
      }
      if (parts[3] === 'start') {
        this.startRoom(room, body.clientToken);
        await this.mutate(room);
        return json(200, { room: publicRoom(room, body.clientToken) });
      }
      if (parts[3] === 'actions') {
        const result = this.handleAction(room, body.clientToken, body);
        await this.mutate(room);
        return json(200, { room: publicRoom(room, body.clientToken), result });
      }
      return json(404, { error: 'room endpoint not found' });
    } catch (error) {
      return json(400, { error: error?.message || String(error) });
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const id = env.GAME_LOBBY.idFromName('main-lobby-v4');
      return env.GAME_LOBBY.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { GameLobby } from '../worker/index.js';

function createMemoryStorage() {
  const values = new Map();
  return {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
  };
}

function createTestEnv() {
  const lobby = new GameLobby({ storage: createMemoryStorage() }, {});
  return {
    GAME_LOBBY: {
      idFromName(name) { return name; },
      get() { return lobby; },
    },
    ASSETS: {
      fetch() { return new Response('asset fallback', { status: 200 }); },
    },
  };
}

async function api(env, path, { method = 'GET', body } = {}) {
  const response = await worker.fetch(new Request(`https://worker.test${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data };
}

function assertSuccess(result, message = '') {
  assert.equal(result.status, 200, message || `expected HTTP 200, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert.ok(result.data, message || 'expected a response body');
}

function findFreeNonRiverEdge(game) {
  return Object.values(game.edges).find(edge => !edge.isRiverCrossing && edge.roadOwnerId === null);
}

async function testWorkerPreBuildRoadAction() {
  const env = createTestEnv();
  const created = await api(env, '/api/rooms', {
    method: 'POST',
    body: { roomName: 'Worker prebuild', playerName: 'Alice', playerCount: 2 },
  });
  assertSuccess(created, 'creating a worker room should succeed');
  assert.ok(Number.isInteger(created.data.room.revision) && created.data.room.revision >= 1, 'a newly published room should include a positive revision');
  const roomId = created.data.room.id;
  const aliceToken = created.data.clientToken;

  const joined = await api(env, `/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: { playerName: 'Bob' },
  });
  assertSuccess(joined, 'joining a worker room should succeed');
  assert.ok(joined.data.room.revision > created.data.room.revision, 'joining should publish a newer room revision');
  const bobToken = joined.data.clientToken;

  const ready = await api(env, `/api/rooms/${roomId}/ready`, {
    method: 'POST',
    body: { clientToken: bobToken, ready: true },
  });
  assertSuccess(ready, 'readying in a worker room should succeed');

  const started = await api(env, `/api/rooms/${roomId}/start`, {
    method: 'POST',
    body: { clientToken: aliceToken },
  });
  assertSuccess(started, 'starting a worker room should succeed');
  assert.ok(started.data.room.revision > ready.data.room.revision, 'starting should publish a newer room revision');
  assert.equal(started.data.room.game.phase, 'PRE_BUILD');
  assert.equal(started.data.room.game.preBuildIndex, 0);

  const edge = findFreeNonRiverEdge(started.data.room.game);
  assert.ok(edge, 'test fixture needs an initial road edge');
  const built = await api(env, `/api/rooms/${roomId}/actions`, {
    method: 'POST',
    body: { clientToken: aliceToken, type: 'preBuildRoad', payload: { edgeId: edge.id } },
  });
  assertSuccess(built, `worker preBuildRoad should not fail: ${JSON.stringify(built.data)}`);
  assert.ok(built.data.room.revision > started.data.room.revision, 'a pre-build road should publish a newer room revision');
  assert.equal(built.data.room.flash.type, 'ROAD_BUILT', 'a pre-build road should be shared as a road-build flash');
  assert.equal(built.data.room.game.preBuildIndex, 1, 'the successful road build should advance pre-build to the next player');
  assert.equal(built.data.room.game.edges[edge.id].roadOwnerId, 'P1', 'the selected road should belong to the first player');

  const bobEdge = findFreeNonRiverEdge(built.data.room.game);
  const bobBuilt = await api(env, `/api/rooms/${roomId}/actions`, {
    method: 'POST',
    body: { clientToken: bobToken, type: 'preBuildRoad', payload: { edgeId: bobEdge.id } },
  });
  assertSuccess(bobBuilt, 'the second player should be able to finish pre-build');
  assert.ok(bobBuilt.data.room.revision > built.data.room.revision, 'each pre-build road should advance the room revision');
  assert.equal(bobBuilt.data.room.game.phase, 'PLAYER_TURN', 'pre-build should end after every player built once');
  assert.equal(bobBuilt.data.room.game.edges[bobEdge.id].roadOwnerId, 'P2');
}

async function run() {
  await testWorkerPreBuildRoadAction();
  console.log('worker integration tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

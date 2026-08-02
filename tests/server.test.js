import assert from 'node:assert/strict';
import { createAppServer, rooms } from '../server.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

let server;
let baseUrl;

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, data };
}

function assertSuccess(result, message = '') {
  assert.equal(result.status, 200, message || `expected HTTP 200, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert.ok(result.data, message || 'expected a response body');
}

function assertFailure(result, message = '') {
  assert.equal(result.status, 400, message || `expected HTTP 400, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert.equal(typeof result.data?.error, 'string', message || 'expected an error response');
}

function findFreeNonRiverEdge(game) {
  return Object.values(game.edges).find(edge => !edge.isRiverCrossing && edge.roadOwnerId === null);
}

async function readInitialSse(path) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200, `SSE request failed with ${response.status}`);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  assert.ok(response.body, 'SSE response should have a readable body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes('\n\n')) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    controller.abort();
  }

  const event = text.split('\n\n')[0];
  assert.match(event, /^event: room$/m, `unexpected SSE event: ${text}`);
  const dataLine = event.split('\n').find(line => line.startsWith('data: '));
  assert.ok(dataLine, `SSE event should include data: ${text}`);
  return JSON.parse(dataLine.slice('data: '.length));
}


async function openSseStream(path) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200, `SSE request failed with ${response.status}`);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  assert.ok(response.body, 'SSE response should have a readable body');
  const stream = {
    controller,
    reader: response.body.getReader(),
    decoder: new TextDecoder(),
    buffer: '',
    closed: false,
  };
  stream.initial = await readNextSseEvent(stream);
  return stream;
}

async function readNextSseEvent(stream, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const separator = stream.buffer.indexOf('\n\n');
    if (separator >= 0) {
      const frame = stream.buffer.slice(0, separator);
      stream.buffer = stream.buffer.slice(separator + 2);
      if (!frame.trim() || frame.trim().startsWith(':')) continue;
      const eventLine = frame.split('\n').find(line => line.startsWith('event: '));
      const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      assert.equal(eventLine, 'event: room');
      return JSON.parse(dataLine.slice('data: '.length));
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('?? SSE ??????');
    const readResult = await Promise.race([
      stream.reader.read(),
      wait(remaining).then(() => ({ timeout: true })),
    ]);
    if (readResult.timeout) {
      stream.controller.abort();
      throw new Error('?? SSE ??????');
    }
    if (readResult.done) {
      stream.closed = true;
      throw new Error('SSE ?????');
    }
    stream.buffer += stream.decoder.decode(readResult.value, { stream: true });
  }
}

async function waitForSseEnd(stream, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!stream.closed) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('?? SSE ??????');
    const readResult = await Promise.race([
      stream.reader.read(),
      wait(remaining).then(() => ({ timeout: true })),
    ]);
    if (readResult.timeout) throw new Error('?? SSE ??????');
    if (readResult.done) {
      stream.closed = true;
      return;
    }
  }
}

async function closeSseStream(stream) {
  if (stream.closed) return;
  await stream.reader.cancel().catch(() => {});
  stream.controller.abort();
  stream.closed = true;
}

async function waitUntil(predicate, message, attempts = 50, interval = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await wait(interval);
  }
  assert.fail(message);
}

async function waitForRoom(roomId, clientToken, predicate, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await request(`/api/rooms/${roomId}?clientToken=${encodeURIComponent(clientToken)}`);
    assertSuccess(result);
    if (predicate(result.data.room)) return result.data.room;
    await wait(20);
  }
  const finalResult = await request(`/api/rooms/${roomId}?clientToken=${encodeURIComponent(clientToken)}`);
  assertSuccess(finalResult);
  assert.ok(predicate(finalResult.data.room), 'room did not reach the expected state in time');
  return finalResult.data.room;
}

async function run() {
  rooms.clear();
  server = await createAppServer({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const created = await request('/api/rooms', {
      method: 'POST',
      body: { roomName: '测试大厅', playerName: 'Alice', playerCount: 2 },
    });
    assertSuccess(created, 'creating a room should succeed');
    const roomId = created.data.room.id;
    const hostToken = created.data.clientToken;
    assert.match(roomId, /^R[A-Z0-9]+$/);
    assert.match(hostToken, /^C[A-Z0-9]+$/);
    assert.equal(created.data.room.status, 'waiting');
    assert.equal(created.data.room.playerCount, 2);
    assert.equal(created.data.room.seats.filter(seat => seat.occupied).length, 1);
    assert.equal(created.data.room.viewer.isHost, true);
    assert.equal(created.data.room.secondDieResolved, false);
    assert.equal(created.data.room.secondDieBaseNodeId, null);

    const listAfterCreate = await request('/api/rooms');
    assertSuccess(listAfterCreate, 'room list should be available');
    const listedRoom = listAfterCreate.data.rooms.find(room => room.id === roomId);
    assert.ok(listedRoom, 'new room should appear in the room list');
    assert.equal(listedRoom.occupied, 1);
    assert.equal(listedRoom.playerCount, 2);

    const notFullStart = await request(`/api/rooms/${roomId}/start`, {
      method: 'POST',
      body: { clientToken: hostToken },
    });
    assertFailure(notFullStart, 'a room that is not full must not start');

    const initialSseRoom = await readInitialSse(
      `/api/rooms/${roomId}/events?clientToken=${encodeURIComponent(hostToken)}`,
    );
    assert.equal(initialSseRoom.id, roomId);
    assert.equal(initialSseRoom.status, 'waiting');

    const disconnectedHostRoom = await waitForRoom(
      roomId,
      hostToken,
      room => room.seats[0].connected === false,
    );
    assert.equal(disconnectedHostRoom.seats[0].connected, false, 'closing SSE should mark the client disconnected');

    const reconnected = await request(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: { clientToken: hostToken, playerName: 'Alice' },
    });
    assertSuccess(reconnected, 'joining with an existing token should reconnect the client');
    assert.equal(reconnected.data.clientToken, hostToken);
    assert.equal(reconnected.data.room.viewer.playerIndex, 0);
    assert.equal(reconnected.data.room.seats[0].connected, true);

    const joined = await request(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: { playerName: 'Bob' },
    });
    assertSuccess(joined, 'a second player should be able to join');
    const playerToken = joined.data.clientToken;
    assert.notEqual(playerToken, hostToken);
    assert.equal(joined.data.room.seats.filter(seat => seat.occupied).length, 2);
    assert.equal(joined.data.room.viewer.playerIndex, 1);

    const notReadyStart = await request(`/api/rooms/${roomId}/start`, {
      method: 'POST',
      body: { clientToken: hostToken },
    });
    assertFailure(notReadyStart, 'a full room with an unready player must not start');

    const ready = await request(`/api/rooms/${roomId}/ready`, {
      method: 'POST',
      body: { clientToken: playerToken, ready: true },
    });
    assertSuccess(ready, 'the joined player should be able to ready up');
    assert.equal(ready.data.room.seats[1].ready, true);

    const started = await request(`/api/rooms/${roomId}/start`, {
      method: 'POST',
      body: { clientToken: hostToken },
    });
    assertSuccess(started, 'the host should be able to start a full ready room');
    assert.equal(started.data.room.status, 'playing');
    assert.equal(started.data.room.game.phase, 'PRE_BUILD');
    assert.equal(started.data.room.game.preBuildIndex, 0);
    assert.equal('randomSeed' in started.data.room.game, false, 'public snapshots must not expose the random seed');
    assert.equal('randomState' in started.data.room.game, false, 'public snapshots must not expose random generator state');

    const firstPreBuildEdge = findFreeNonRiverEdge(started.data.room.game);
    assert.ok(firstPreBuildEdge, 'the initial map should provide a free non-river pre-build edge');

    const nonCurrentAction = await request(`/api/rooms/${roomId}/actions`, {
      method: 'POST',
      body: {
        clientToken: playerToken,
        type: 'preBuildRoad',
        payload: { edgeId: firstPreBuildEdge.id },
      },
    });
    assertFailure(nonCurrentAction, 'the non-current player must not be able to act');

    const preBuildHost = await request(`/api/rooms/${roomId}/actions`, {
      method: 'POST',
      body: {
        clientToken: hostToken,
        type: 'preBuildRoad',
        payload: { edgeId: firstPreBuildEdge.id },
      },
    });
    assertSuccess(preBuildHost, 'the current player should be able to complete pre-build construction');
    assert.equal(preBuildHost.data.room.game.edges[firstPreBuildEdge.id].roadOwnerId, 'P1');
    assert.equal(preBuildHost.data.room.game.preBuildIndex, 1);

    const secondPreBuildEdge = findFreeNonRiverEdge(preBuildHost.data.room.game);
    assert.ok(secondPreBuildEdge, 'the second player should have another free pre-build edge');
    const preBuildPlayer = await request(`/api/rooms/${roomId}/actions`, {
      method: 'POST',
      body: {
        clientToken: playerToken,
        type: 'preBuildRoad',
        payload: { edgeId: secondPreBuildEdge.id },
      },
    });
    assertSuccess(preBuildPlayer, 'the second player should be able to complete pre-build construction');
    assert.equal(preBuildPlayer.data.room.game.edges[secondPreBuildEdge.id].roadOwnerId, 'P2');
    assert.equal(preBuildPlayer.data.room.game.phase, 'PLAYER_TURN');
    assert.equal(preBuildPlayer.data.room.game.currentPlayerIndex, 0);

    const chat = await request(`/api/rooms/${roomId}/chat`, {
      method: 'POST',
      body: { clientToken: playerToken, message: '准备开始建设！' },
    });
    assertSuccess(chat, 'players should be able to send chat messages');
    const latestMessage = chat.data.room.chat.at(-1);
    assert.equal(latestMessage.message, '准备开始建设！');
    assert.equal(latestMessage.sender, 'Bob');
    assert.equal(latestMessage.playerIndex, 1);

    const turnStarted = await request(`/api/rooms/${roomId}/actions`, {
      method: 'POST',
      body: { clientToken: hostToken, type: 'startTurn' },
    });
    assertSuccess(turnStarted, 'the current player should be able to start a turn');
    assert.notEqual(turnStarted.data.room.game.lastDie1, null);
    assert.equal(turnStarted.data.room.turnActionCommitted, false);

    const duplicateTurnStart = await request(`/api/rooms/${roomId}/actions`, {
      method: 'POST',
      body: { clientToken: hostToken, type: 'startTurn' },
    });
    assertFailure(duplicateTurnStart, 'repeating a turn-start action must be rejected by the action lock');

    const afterDuplicate = await request(
      `/api/rooms/${roomId}?clientToken=${encodeURIComponent(hostToken)}`,
    );
    assertSuccess(afterDuplicate);
    assert.equal(afterDuplicate.data.room.game.lastDie1, turnStarted.data.room.game.lastDie1);
    assert.equal(afterDuplicate.data.room.game.lastDie2, null);
    assert.equal(afterDuplicate.data.room.turnActionCommitted, false);

    const authoritativeRoom = rooms.get(roomId);
    const authoritativeEngine = authoritativeRoom.engine;
    const currentPlayerId = authoritativeEngine.currentPlayerId;
    const availableBasesBeforeValidation = authoritativeEngine.getBuildableBaseNodesForDie1(currentPlayerId);
    assert.ok(availableBasesBeforeValidation.length, 'the current player should have at least one valid second-die base');

    // Force one same-number base to have no buildable outgoing edge. A
    // same-number but unavailable base must be rejected before any random roll.
    const invalidBase = Object.values(authoritativeEngine.state.nodes)
      .find(node => node.id !== availableBasesBeforeValidation[0]);
    assert.ok(invalidBase, 'the map should contain a base outside the available set');
    invalidBase.diceNumber = authoritativeEngine.state.lastDie1;
    for (const edge of authoritativeEngine.adjacentEdges(invalidBase.id)) {
      edge.roadOwnerId = 'P2';
      if (edge.isRiverCrossing) edge.bridgeOwnerId = 'P2';
    }

    const invalidSecondDie = await request(`/api/rooms/${roomId}/actions`, {
      method: 'POST',
      body: {
        clientToken: hostToken,
        type: 'rollSecondDie',
        payload: { baseNodeId: invalidBase.id },
      },
    });
    assertFailure(invalidSecondDie, 'rollSecondDie must reject a same-number base that is not currently buildable');
    const afterInvalidSecondDie = await request(
      `/api/rooms/${roomId}?clientToken=${encodeURIComponent(hostToken)}`,
    );
    assertSuccess(afterInvalidSecondDie);
    assert.equal(afterInvalidSecondDie.data.room.game.lastDie2, null);
    assert.equal(afterInvalidSecondDie.data.room.secondDieResolved, false);
    assert.equal(afterInvalidSecondDie.data.room.secondDieBaseNodeId, null);

    const validSecondDieBase = authoritativeEngine
      .getBuildableBaseNodesForDie1(currentPlayerId)
      .find(id => id !== invalidBase.id);
    assert.ok(validSecondDieBase, 'another valid base should remain available after the invalid-base setup');
    const secondDieRoll = await request(`/api/rooms/${roomId}/actions`, {
      method: 'POST',
      body: {
        clientToken: hostToken,
        type: 'rollSecondDie',
        payload: { baseNodeId: validSecondDieBase },
      },
    });
    assertSuccess(secondDieRoll, 'a currently buildable base should be accepted for the second die');
    assert.equal(secondDieRoll.data.room.secondDieBaseNodeId, validSecondDieBase);
    assert.equal(secondDieRoll.data.room.game.lastDie2, secondDieRoll.data.result.die2);
    assert.equal(
      secondDieRoll.data.room.secondDieResolved,
      secondDieRoll.data.result.candidates.length === 0,
    );
    if (secondDieRoll.data.result.candidates.length) {
      const resolvedSecondDie = await request(`/api/rooms/${roomId}/actions`, {
        method: 'POST',
        body: {
          clientToken: hostToken,
          type: 'resolveSecondDieBuild',
          payload: {
            baseNodeId: validSecondDieBase,
            targetNodeId: secondDieRoll.data.result.candidates[0],
          },
        },
      });
      assertSuccess(resolvedSecondDie, 'the selected second-die target should resolve successfully');
      assert.equal(resolvedSecondDie.data.room.secondDieResolved, true);
    }

    const secondCreated = await request('/api/rooms', {
      method: 'POST',
      body: { roomName: '房主转移测试', playerName: 'Carol', playerCount: 2 },
    });
    assertSuccess(secondCreated);
    const secondRoomId = secondCreated.data.room.id;
    const secondHostToken = secondCreated.data.clientToken;
    const secondJoined = await request(`/api/rooms/${secondRoomId}/join`, {
      method: 'POST',
      body: { playerName: 'Dana' },
    });
    assertSuccess(secondJoined);
    const replacementToken = secondJoined.data.clientToken;

    const leave = await request(`/api/rooms/${secondRoomId}/leave`, {
      method: 'POST',
      body: { clientToken: secondHostToken },
    });
    assertSuccess(leave, 'a player should be able to leave a waiting room');

    const afterHostLeave = await request(
      `/api/rooms/${secondRoomId}?clientToken=${encodeURIComponent(replacementToken)}`,
    );
    assertSuccess(afterHostLeave);
    assert.equal(afterHostLeave.data.room.seats[0].occupied, false);
    assert.equal(afterHostLeave.data.room.seats[1].occupied, true);
    assert.equal(afterHostLeave.data.room.seats[1].isHost, true);
    assert.equal(afterHostLeave.data.room.viewer.isHost, true);
    assert.equal(afterHostLeave.data.room.status, 'waiting');

    const sseCreated = await request('/api/rooms', {
      method: 'POST',
      body: { roomName: 'SSE ?????', playerName: 'Eve', playerCount: 2 },
    });
    assertSuccess(sseCreated);
    const sseRoomId = sseCreated.data.room.id;
    const sseHostToken = sseCreated.data.clientToken;
    const sseJoined = await request(`/api/rooms/${sseRoomId}/join`, {
      method: 'POST',
      body: { playerName: 'Frank' },
    });
    assertSuccess(sseJoined);
    const ssePlayerToken = sseJoined.data.clientToken;

    const observerStream = await openSseStream(
      `/api/rooms/${sseRoomId}/events?clientToken=${encodeURIComponent(ssePlayerToken)}`,
    );
    const hostStreamOne = await openSseStream(
      `/api/rooms/${sseRoomId}/events?clientToken=${encodeURIComponent(sseHostToken)}`,
    );
    const hostStreamTwo = await openSseStream(
      `/api/rooms/${sseRoomId}/events?clientToken=${encodeURIComponent(sseHostToken)}`,
    );
    assert.equal(hostStreamOne.initial.id, sseRoomId);
    assert.equal(hostStreamTwo.initial.id, sseRoomId);
    assert.equal(
      [...rooms.get(sseRoomId).subscribers].filter(sub => sub.clientToken === sseHostToken).length,
      2,
      'the same token should be allowed to maintain multiple SSE connections',
    );

    await closeSseStream(hostStreamOne);
    await waitUntil(
      () => [...rooms.get(sseRoomId).subscribers].filter(sub => sub.clientToken === sseHostToken).length === 1,
      'closing one of two same-token SSE connections should remove only that subscriber',
    );
    assert.equal(
      rooms.get(sseRoomId).clients.get(sseHostToken).connected,
      true,
      'a token must remain connected while another SSE connection is alive',
    );

    await closeSseStream(hostStreamTwo);
    await waitUntil(
      () => !rooms.get(sseRoomId).clients.get(sseHostToken).connected,
      'closing the final same-token SSE connection should mark the client offline',
    );
    const offlineEvent = await readNextSseEvent(observerStream);
    assert.equal(offlineEvent.seats[0].connected, false);

    const tokenReconnect = await request(`/api/rooms/${sseRoomId}/join`, {
      method: 'POST',
      body: { clientToken: sseHostToken, playerName: 'Eve' },
    });
    assertSuccess(tokenReconnect, 'an existing token should reconnect successfully');
    const onlineEvent = await readNextSseEvent(observerStream);
    assert.equal(onlineEvent.seats[0].connected, true, 'token reconnect should be broadcast to other SSE clients');
    await closeSseStream(observerStream);

    const kickCreated = await request('/api/rooms', {
      method: 'POST',
      body: { roomName: '?? SSE ??', playerName: 'Grace', playerCount: 2 },
    });
    assertSuccess(kickCreated);
    const kickRoomId = kickCreated.data.room.id;
    const kickHostToken = kickCreated.data.clientToken;
    const kickJoined = await request(`/api/rooms/${kickRoomId}/join`, {
      method: 'POST',
      body: { playerName: 'Heidi' },
    });
    assertSuccess(kickJoined);
    const kickedToken = kickJoined.data.clientToken;
    const kickedStream = await openSseStream(
      `/api/rooms/${kickRoomId}/events?clientToken=${encodeURIComponent(kickedToken)}`,
    );
    const kicked = await request(`/api/rooms/${kickRoomId}/kick`, {
      method: 'POST',
      body: { clientToken: kickHostToken, playerIndex: 1 },
    });
    assertSuccess(kicked, 'the host should be able to kick the second player');
    await waitForSseEnd(kickedStream);
    await waitUntil(
      () => ![...rooms.get(kickRoomId).subscribers].some(sub => sub.clientToken === kickedToken),
      'a kicked player must have every SSE subscriber removed',
    );
    assert.equal(rooms.get(kickRoomId).clients.has(kickedToken), false);
    const kickedView = await request(
      `/api/rooms/${kickRoomId}?clientToken=${encodeURIComponent(kickedToken)}`,
    );
    assertSuccess(kickedView);
    assert.equal(kickedView.data.room.viewer, null, 'a kicked token must no longer identify a room viewer');

    console.log('server integration tests passed');
  } finally {
    for (const room of rooms.values()) {
      for (const subscriber of room.subscribers) subscriber.res.end();
    }
    await wait(30);
    if (server?.listening) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    }
    rooms.clear();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

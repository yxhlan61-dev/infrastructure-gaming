import assert from 'node:assert/strict';
import { GameEngine, validateMap, edgeId, CARD } from '../src/game.js';

function testMapGeneration() {
  const riverSignatures = new Set();
  const regionSignatures = new Set();
  for (let i = 0; i < 100; i++) {
    const game = new GameEngine({ players: [{ name: 'A' }, { name: 'B' }], seed: `map-${i}` });
    const result = validateMap(game.state.nodes, game.state.edges);
    assert.equal(result.ok, true, `map should be legal: ${JSON.stringify(result)}`);
    assert.equal(result.riverBoundaryContinuous, true, 'river crossings should form one continuous boundary entering and exiting the board');
    riverSignatures.add(Object.values(game.state.edges).filter(e => e.isRiverCrossing).map(e => e.id).sort().join('|'));
    regionSignatures.add(Object.values(game.state.nodes).filter(n => n.region === 'CITY').map(n => n.id).sort().join('|'));
  }
  assert.ok(riverSignatures.size >= 20, `seeded games should produce varied rivers; got ${riverSignatures.size}`);
  assert.ok(regionSignatures.size >= 20, `seeded games should produce varied regions; got ${regionSignatures.size}`);
  console.log('map legality and random variety test passed');
}


function testBuildRules() {
  const game = new GameEngine({ players: [{ name: 'A' }, { name: 'B' }], seed: 'build-rules' });
  const p1 = 'P1';
  const normal = Object.values(game.state.edges).find(e => !e.isRiverCrossing);
  const river = Object.values(game.state.edges).find(e => e.isRiverCrossing);
  assert.ok(normal, '应存在非跨河边');
  assert.ok(river, '应存在跨河边');

  assert.equal(game.canBuildRoad(p1, normal), true, '非跨河空边可修路');
  game.buildRoad(p1, normal.id);
  assert.equal(game.canBuildRoad('P2', normal), false, '已有道路不可重复修路');

  assert.equal(game.canBuildRoad(p1, river), false, '跨河无桥不可修路');
  assert.equal(game.canBuildBridge(p1, river), true, '跨河无桥可修桥');
  game.buildBridge(p1, river.id);
  assert.equal(game.canBuildRoad('P2', river), false, '不能使用他人桥梁修路');
  assert.equal(game.canBuildRoad(p1, river), true, '有自己的桥梁可修路');
  game.buildRoad(p1, river.id);
  assert.equal(game.canBuildBridge('P2', river), false, '已有桥不可重复修桥');
  console.log('✓ 建设规则测试通过');
}

function setOnlyRoads(game, edgeIds) {
  for (const e of Object.values(game.state.edges)) {
    e.roadOwnerId = null;
    e.bridgeOwnerId = null;
  }
  for (const id of edgeIds) game.state.edges[id].roadOwnerId = 'P1';
}

function testBuildableBasesForDie1() {
  const game = new GameEngine({ players: [{ name: 'A' }, { name: 'B' }], seed: 'base-filter' });
  const target = Object.values(game.state.nodes).find(n => n.id !== 'r1c1');
  for (const n of Object.values(game.state.nodes)) n.diceNumber = n.id === target.id ? 1 : 2;
  for (const e of Object.values(game.state.edges)) {
    e.roadOwnerId = null;
    e.bridgeOwnerId = null;
    if (e.nodeA === target.id || e.nodeB === target.id) e.roadOwnerId = 'P2';
  }
  game.state.phase = 'PLAYER_TURN';
  game.state.currentPlayerIndex = 0;
  game.state.lastDie1 = 1;
  assert.deepEqual(game.selectableBasesForDie1(), [target.id], '骰子点数基地仍应可识别');
  assert.deepEqual(game.getBuildableBaseNodesForDie1('P1'), [], '周围无可修路边的基地不应高亮为可修路基地');
  console.log('✓ 行动2可修路基地过滤测试通过');
}

function testSecondDieFiltersOccupiedTargets() {
  const game = new GameEngine({ players: [{ name: 'A' }, { name: 'B' }], seed: 'second-die-filter' });
  const baseId = 'r4c5';
  const targetId = 'r5c5';
  const edge = game.state.edges[edgeId(baseId, targetId)];
  assert.ok(edge, 'test edge should exist');
  for (const node of Object.values(game.state.nodes)) node.diceNumber = 2;
  game.state.nodes[baseId].diceNumber = 5;
  game.state.nodes[targetId].diceNumber = 6;
  edge.roadOwnerId = 'P2';
  edge.bridgeOwnerId = null;
  edge.isRiverCrossing = false;
  game.state.phase = 'PLAYER_TURN';
  game.state.currentPlayerIndex = 0;
  game.state.lastDie1 = 5;
  game.state.lastDie2 = 6;

  assert.deepEqual(game.getBuildableSecondDieTargets('P1', baseId, 6), [], 'occupied second-die target should not be selectable');
  const res = game.resolveSecondDieBuild(baseId, targetId);
  assert.equal(res, 'NONE', 'occupied second-die target should be invalid');
  assert.equal(edge.roadOwnerId, 'P2', 'existing road must not be swallowed or overwritten');
  console.log('second die occupied edge filter test passed');
}


function testFirstQuadrantCoordinateLabels() {
  const game = new GameEngine({ players: [{ name: 'A' }, { name: 'B' }], seed: 'coordinate-labels' });
  assert.equal(game.formatNodeCoord('r1c1'), '(1,1)', '(1,1) should remain the lower-left first-quadrant coordinate');
  assert.equal(game.formatNodeCoord('r1c6'), '(6,1)', 'internal row/col IDs must display as (x,y)');
  assert.equal(game.formatNodeCoord('r6c1'), '(1,6)', 'y should increase upward in displayed coordinates');
  assert.equal(game.formatNodeCoord('r6c6'), '(6,6)', '(6,6) should remain the upper-right first-quadrant coordinate');
  console.log('first-quadrant coordinate label test passed');
}

function testMerchantLogCoordinates() {
  const game = new GameEngine({ players: [{ name: 'A' }, { name: 'B' }], seed: 'merchant-log-coordinates' });
  game.spawnMerchant(5);
  const spawnLog = game.state.log[0];
  assert.match(spawnLog.message, /\(6,6\) \u2192 \(1,1\)/, 'merchant spawn log must use first-quadrant coordinates');
  assert.doesNotMatch(spawnLog.message, /r6c6|r1c1/, 'merchant spawn log must not expose internal node IDs');

  for (const edge of Object.values(game.state.edges)) {
    edge.roadOwnerId = 'P1';
    if (edge.isRiverCrossing) edge.bridgeOwnerId = 'P1';
  }
  assert.equal(game.checkMerchantCompletion(), true, 'fully connected map should complete the merchant route');
  const completionLog = game.state.log.find(entry => entry.type === 'MERCHANT_COMPLETED');
  assert.match(completionLog.message, /\(6,6\) \u2192 \(1,1\)/, 'merchant completion log must use first-quadrant coordinates');
  assert.doesNotMatch(completionLog.message, /r6c6|r1c1/, 'merchant completion log must not expose internal node IDs');
  const completedMerchant = game.state.completedMerchants.at(-1);
  assert.ok(completedMerchant.tollDetails.length > 0, 'completed merchant should retain this-round toll details for the settlement UI');
  assert.equal(
    completedMerchant.tollDetails.reduce((total, detail) => total + detail.amount, 0),
    game.state.players.P1.tollMoney,
    'this-round toll detail total should equal the awarded score on the fully P1-owned map',
  );
  console.log('merchant log coordinate formatting test passed');
}

function testFourthMerchantRoutesAreRandom() {
  const routes = new Set();
  for (let i = 0; i < 60; i++) {
    const game = new GameEngine({ players: [{ name: 'A' }, { name: 'B' }], seed: `merchant-four-${i}` });
    game.spawnMerchant(4);
    const merchant = game.state.currentMerchant;
    assert.equal(merchant.type, 'SMALL', 'the fourth merchant should be a small merchant');
    assert.notEqual(
      game.state.nodes[merchant.startNodeId].region,
      game.state.nodes[merchant.endNodeId].region,
      'the fourth merchant must still connect city and countryside',
    );
    routes.add(`${merchant.startNodeId}>${merchant.endNodeId}`);
  }
  assert.ok(routes.size >= 10, `fourth merchant routes should vary by random seed; got ${routes.size}`);
  console.log('fourth merchant random route test passed');
}

function testSubsidyAndMerchantTypes() {
  const game = new GameEngine({ players: [{ name: 'A' }, { name: 'B' }], seed: 'subsidy-merchant' });
  const playerId = game.currentPlayerId;
  const before = game.state.players[playerId].tollMoney;
  const res = game.resolveCard(CARD.SUBSIDY);
  assert.equal(res.done, true, 'subsidy should resolve immediately');
  assert.equal(game.state.players[playerId].tollMoney, before + 2, 'subsidy should add 2 dollars');

  game.spawnMerchant(4);
  assert.equal(game.state.currentMerchant.type, 'SMALL', 'merchant 4 should remain a randomly generated small merchant');
  assert.notEqual(
    `${game.state.currentMerchant.startNodeId}>${game.state.currentMerchant.endNodeId}`,
    'r6c6>r1c1',
    'merchant 4 must not use the final fixed big-merchant route',
  );
  const startRegion = game.state.nodes[game.state.currentMerchant.startNodeId].region;
  const endRegion = game.state.nodes[game.state.currentMerchant.endNodeId].region;
  assert.notEqual(startRegion, endRegion, 'merchant 4 random route should connect city and countryside');

  game.spawnMerchant(5);
  assert.equal(game.state.currentMerchant.type, 'BIG', 'merchant 5 should be the big merchant');
  assert.equal(game.state.currentMerchant.startNodeId, 'r6c6', 'merchant 5 should use the fixed upper-right start');
  assert.equal(game.state.currentMerchant.endNodeId, 'r1c1', 'merchant 5 should use the fixed lower-left end');
  console.log('subsidy and merchant type test passed');
}

function testUniformShortestPathDP() {
  const game = new GameEngine({ players: [{ name: 'A' }, { name: 'B' }], seed: 'uniform-path' });
  const S = 'r1c1';
  const A = 'r1c2';
  const B = 'r2c1';
  const X = 'r1c3';
  const Y = 'r2c2';
  const T = 'r2c3';
  setOnlyRoads(game, [
    edgeId(S, A),
    edgeId(S, B),
    edgeId(A, X),
    edgeId(X, T),
    edgeId(A, Y),
    edgeId(Y, T),
    edgeId(B, Y),
  ]);

  const first = game.findUniformRandomShortestPath(S, T);
  assert.ok(first, '应存在最短路径');
  assert.equal(first.length, 3, '最短路径长度应为 3');
  assert.equal(first.pathCount, 3, 'DP 应计算出 3 条最短路径');

  const counts = new Map();
  const total = 9000;
  for (let i = 0; i < total; i++) {
    const path = game.findUniformRandomShortestPath(S, T);
    const key = path.nodeIds.join('>');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  assert.equal(counts.size, 3, `应只采样到 3 条最短路径，实际：${JSON.stringify(Object.fromEntries(counts))}`);
  for (const [path, count] of counts) {
    const ratio = count / total;
    assert.ok(Math.abs(ratio - 1 / 3) < 0.035, `路径 ${path} 应接近 1/3，实际 ${ratio}`);
  }
  console.log('✓ 严格等概率最短路径 DP 测试通过', Object.fromEntries(counts));
}

testMapGeneration();
testBuildRules();
testBuildableBasesForDie1();
testSecondDieFiltersOccupiedTargets();
testFirstQuadrantCoordinateLabels();
testMerchantLogCoordinates();
testFourthMerchantRoutesAreRandom();
testSubsidyAndMerchantTypes();
testUniformShortestPathDP();
console.log('全部测试通过');

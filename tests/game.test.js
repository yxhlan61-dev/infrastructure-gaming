import assert from 'node:assert/strict';
import { GameEngine, validateMap, edgeId } from '../src/game.js';

function testMapGeneration() {
  for (let i = 0; i < 100; i++) {
    const game = new GameEngine({ players: [{ name: 'A' }, { name: 'B' }], seed: `map-${i}` });
    const result = validateMap(game.state.nodes, game.state.edges);
    assert.equal(result.ok, true, `地图应合法：${JSON.stringify(result)}`);
  }
  console.log('✓ 地图生成合法性测试通过');
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
testUniformShortestPathDP();
console.log('全部测试通过');

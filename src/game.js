export const PLAYER_COLORS = ['#ef4444', '#2563eb', '#16a34a', '#a855f7'];
export const REGION = { CITY: 'CITY', COUNTRYSIDE: 'COUNTRYSIDE' };
export const CARD = {
  RANDOM_ROAD: 'RANDOM_ROAD',
  BRIDGE_TO_ROAD: 'BRIDGE_TO_ROAD',
  REMOVE_ROAD_BUILD_BRIDGE: 'REMOVE_ROAD_BUILD_BRIDGE',
  SUBSIDY: 'SUBSIDY',
};
export const PHASE = {
  PRE_BUILD: 'PRE_BUILD',
  PLAYER_TURN: 'PLAYER_TURN',
  GAME_END: 'GAME_END',
};

export class RandomService {
  constructor(seed = Date.now()) {
    this.state = RandomService.hashSeed(String(seed));
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  static hashSeed(seed) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  next() {
    // 32-bit LCG, deterministic for seeded local games.
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  int(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  rollDie() { return this.int(1, 6); }

  choice(items) {
    if (!items.length) return undefined;
    return items[this.int(0, items.length - 1)];
  }

  shuffle(items) {
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  weightedChoice(items) {
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    if (total <= 0) return undefined;
    let r = this.next() * total;
    for (const item of items) {
      r -= item.weight;
      if (r < 0) return item.value;
    }
    return items[items.length - 1].value;
  }
}

export function nodeId(row, col) { return `r${row}c${col}`; }
export function parseNodeId(id) {
  const [, row, col] = /^r(\d)c(\d)$/.exec(id) || [];
  return { row: Number(row), col: Number(col) };
}
export function edgeId(a, b) { return [a, b].sort().join('__'); }

export function createNodes() {
  const nodes = {};
  for (let row = 1; row <= 6; row++) {
    for (let col = 1; col <= 6; col++) {
      const id = nodeId(row, col);
      nodes[id] = { id, row, col, diceNumber: 0, region: null };
    }
  }
  return nodes;
}

export function createEdges(nodes) {
  const edges = {};
  for (const node of Object.values(nodes)) {
    const candidates = [
      [node.row + 1, node.col],
      [node.row, node.col + 1],
    ];
    for (const [r, c] of candidates) {
      if (r >= 1 && r <= 6 && c >= 1 && c <= 6) {
        const a = node.id;
        const b = nodeId(r, c);
        const id = edgeId(a, b);
        edges[id] = {
          id,
          nodeA: a,
          nodeB: b,
          isRiverCrossing: false,
          bridgeOwnerId: null,
          roadOwnerId: null,
          length: 1,
        };
      }
    }
  }
  return edges;
}

export function neighborsOf(nodeIdValue) {
  const { row, col } = parseNodeId(nodeIdValue);
  const list = [];
  if (row > 1) list.push(nodeId(row - 1, col));
  if (row < 6) list.push(nodeId(row + 1, col));
  if (col > 1) list.push(nodeId(row, col - 1));
  if (col < 6) list.push(nodeId(row, col + 1));
  return list;
}

function isConnected(nodeIds) {
  const set = new Set(nodeIds);
  if (!set.size) return false;
  const start = nodeIds[0];
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    for (const nb of neighborsOf(current)) {
      if (set.has(nb) && !seen.has(nb)) {
        seen.add(nb);
        queue.push(nb);
      }
    }
  }
  return seen.size === set.size;
}

export function validateMap(nodes, edges) {
  const city = Object.values(nodes).filter(n => n.region === REGION.CITY).map(n => n.id);
  const country = Object.values(nodes).filter(n => n.region === REGION.COUNTRYSIDE).map(n => n.id);
  const nums = new Map();
  for (const n of Object.values(nodes)) nums.set(n.diceNumber, (nums.get(n.diceNumber) || 0) + 1);
  return {
    ok: city.length >= 10 && city.length <= 26
      && country.length >= 10 && country.length <= 26
      && nodes.r1c1.region === REGION.CITY
      && nodes.r6c6.region === REGION.COUNTRYSIDE
      && isConnected(city)
      && isConnected(country)
      && Object.values(edges).some(e => e.isRiverCrossing)
      && [1,2,3,4,5,6].every(n => nums.get(n) === 6),
    cityCount: city.length,
    countrysideCount: country.length,
    riverEdgeCount: Object.values(edges).filter(e => e.isRiverCrossing).length,
    diceCounts: Object.fromEntries(nums),
  };
}

function boundaryColForRow(row) {
  // A continuous diagonal river boundary from upper-left to lower-right.
  // City nodes are below/left of the river, countryside nodes are above/right.
  return 6 - row;
}

export function generateMap(random) {
  const nodes = createNodes();
  const allIds = Object.keys(nodes);
  for (const id of allIds) {
    const { row, col } = nodes[id];
    nodes[id].region = col <= boundaryColForRow(row) ? REGION.CITY : REGION.COUNTRYSIDE;
  }

  const edges = createEdges(nodes);
  for (const e of Object.values(edges)) {
    e.isRiverCrossing = nodes[e.nodeA].region !== nodes[e.nodeB].region;
  }

  const numbers = [];
  for (let n = 1; n <= 6; n++) for (let i = 0; i < 6; i++) numbers.push(n);
  const shuffled = random.shuffle(numbers);
  allIds.forEach((id, i) => { nodes[id].diceNumber = shuffled[i]; });

  const validation = validateMap(nodes, edges);
  if (!validation.ok) throw new Error(`Invalid fixed river map: ${JSON.stringify(validation)}`);
  return { nodes, edges };
}

export class GameEngine {
  constructor({ players, seed = Date.now() }) {
    if (!players || players.length < 2 || players.length > 4) throw new Error('玩家数量必须为 2~4');
    this.random = new RandomService(seed);
    const { nodes, edges } = generateMap(this.random);
    const playerRecords = {};
    const playerOrder = [];
    players.forEach((p, index) => {
      const id = `P${index + 1}`;
      playerRecords[id] = { id, name: p.name || `玩家${index + 1}`, tollMoney: 0, isAI: Boolean(p.isAI), color: PLAYER_COLORS[index] };
      playerOrder.push(id);
    });

    this.state = {
      phase: PHASE.PRE_BUILD,
      nodes,
      edges,
      players: playerRecords,
      playerOrder,
      currentPlayerIndex: 0,
      preBuildIndex: 0,
      currentMerchant: null,
      completedMerchants: [],
      turnNumber: 0,
      randomSeed: seed,
      lastDie1: null,
      lastDie2: null,
      lastMerchantPath: [],
      log: [],
      result: null,
    };
    this.log('GAME_CREATED', `游戏创建完成，种子：${seed}`);
    const validation = validateMap(nodes, edges);
    this.log('MAP_GENERATED', `地图生成：城市 ${validation.cityCount} 点，乡村 ${validation.countrysideCount} 点，跨河边 ${validation.riverEdgeCount} 条`, validation);
  }

  get currentPlayerId() { return this.state.playerOrder[this.state.currentPlayerIndex]; }
  get preBuildPlayerId() { return this.state.playerOrder[this.state.preBuildIndex]; }

  log(type, message, payload = undefined) {
    this.state.log.unshift({
      id: `${Date.now()}-${this.state.log.length}-${Math.random().toString(36).slice(2)}`,
      turnNumber: this.state.turnNumber,
      playerId: this.state.phase === PHASE.PRE_BUILD ? this.preBuildPlayerId : this.currentPlayerId,
      type,
      message,
      payload,
    });
  }

  getEdge(edgeIdValue) { return this.state.edges[edgeIdValue]; }
  getNode(nodeIdValue) { return this.state.nodes[nodeIdValue]; }

  formatNodeCoord(nodeIdValue) {
    const node = this.getNode(nodeIdValue);
    return node ? `(${node.row},${node.col})` : nodeIdValue;
  }

  formatEdgeCoord(edgeOrId) {
    const edge = typeof edgeOrId === 'string' ? this.getEdge(edgeOrId) : edgeOrId;
    return edge ? `${this.formatNodeCoord(edge.nodeA)}->${this.formatNodeCoord(edge.nodeB)}` : '\u65e0';
  }

  getOtherNode(edge, nodeIdValue) { return edge.nodeA === nodeIdValue ? edge.nodeB : edge.nodeA; }

  adjacentEdges(nodeIdValue) {
    return Object.values(this.state.edges).filter(e => e.nodeA === nodeIdValue || e.nodeB === nodeIdValue);
  }

  canBuildRoad(playerId, edgeOrId) {
    const edge = typeof edgeOrId === 'string' ? this.getEdge(edgeOrId) : edgeOrId;
    if (!edge || edge.roadOwnerId !== null) return false;
    if (!edge.isRiverCrossing) return true;
    return edge.bridgeOwnerId === playerId;
  }

  canBuildBridge(playerId, edgeOrId) {
    const edge = typeof edgeOrId === 'string' ? this.getEdge(edgeOrId) : edgeOrId;
    return Boolean(edge && edge.isRiverCrossing && edge.bridgeOwnerId === null && edge.roadOwnerId === null);
  }

  buildRoad(playerId, edgeIdValue) {
    const edge = this.getEdge(edgeIdValue);
    if (!this.canBuildRoad(playerId, edge)) throw new Error('不符合修路条件');
    edge.roadOwnerId = playerId;
    this.log('ROAD_BUILT', `${this.state.players[playerId].name} \u4fee\u5efa\u9053\u8def ${this.formatEdgeCoord(edge)}`, { edgeId: edgeIdValue });
  }

  buildBridge(playerId, edgeIdValue) {
    const edge = this.getEdge(edgeIdValue);
    if (!this.canBuildBridge(playerId, edge)) throw new Error('不符合修桥条件');
    edge.bridgeOwnerId = playerId;
    this.log('BRIDGE_BUILT', `${this.state.players[playerId].name} \u4fee\u5efa\u6865\u6881 ${this.formatEdgeCoord(edge)}`, { edgeId: edgeIdValue });
  }

  removeRoad(playerId, edgeIdValue) {
    const edge = this.getEdge(edgeIdValue);
    if (!edge || edge.roadOwnerId !== playerId) throw new Error('只能拆除自己的道路');
    edge.roadOwnerId = null;
    this.log('ROAD_REMOVED', `${this.state.players[playerId].name} \u62c6\u9664\u9053\u8def ${this.formatEdgeCoord(edge)}`, { edgeId: edgeIdValue });
  }

  getPlayerRoadCount(playerId) {
    return Object.values(this.state.edges).filter(e => e.roadOwnerId === playerId).length;
  }

  getPlayerBridgeCount(playerId) {
    return Object.values(this.state.edges).filter(e => e.bridgeOwnerId === playerId).length;
  }

  getBuildableRoadEdges(playerId) {
    return Object.values(this.state.edges).filter(e => this.canBuildRoad(playerId, e));
  }

  getBuildableBridgeEdges(playerId) {
    return Object.values(this.state.edges).filter(e => this.canBuildBridge(playerId, e));
  }

  getRoadEdgesOf(playerId) {
    return Object.values(this.state.edges).filter(e => e.roadOwnerId === playerId);
  }

  getOwnBridgesWithoutRoad(playerId) {
    return Object.values(this.state.edges).filter(e => e.bridgeOwnerId === playerId && e.roadOwnerId === null);
  }

  preBuildRoad(edgeIdValue) {
    if (this.state.phase !== PHASE.PRE_BUILD) throw new Error('当前不是开局预建设阶段');
    const playerId = this.preBuildPlayerId;
    this.buildRoad(playerId, edgeIdValue);
    this.state.preBuildIndex += 1;
    if (this.state.preBuildIndex >= this.state.playerOrder.length) {
      this.state.phase = PHASE.PLAYER_TURN;
      this.state.currentPlayerIndex = 0;
      this.state.turnNumber = 1;
      this.spawnMerchant(1);
      this.log('PHASE_CHANGED', '开局预建设完成，正式游戏开始');
    }
  }

  startTurn() {
    if (this.state.phase !== PHASE.PLAYER_TURN) throw new Error('当前不能开始回合');
    if (this.state.lastDie1 !== null) return this.state.lastDie1;
    this.state.lastMerchantPath = [];
    this.state.lastDie1 = this.random.rollDie();
    this.state.lastDie2 = null;
    this.state.diceAnimationNonce = (this.state.diceAnimationNonce || 0) + 1;
    this.log('DICE_ROLLED', `${this.state.players[this.currentPlayerId].name} 掷出第一骰：${this.state.lastDie1}`, { die: this.state.lastDie1 });
    return this.state.lastDie1;
  }

  selectableBasesForDie1() {
    const die = this.state.lastDie1;
    if (!die) return [];
    return Object.values(this.state.nodes).filter(n => n.diceNumber === die).map(n => n.id);
  }

  getBuildableRoadEdgesFromBase(playerId, baseNodeId) {
    return this.adjacentEdges(baseNodeId).filter(e => this.canBuildRoad(playerId, e));
  }

  getBuildableSecondDieTargets(playerId, baseNodeId, die2) {
    return neighborsOf(baseNodeId).filter(id => {
      const node = this.getNode(id);
      if (!node || node.diceNumber !== die2) return false;
      const edge = this.getEdge(edgeId(baseNodeId, id));
      return this.canBuildRoad(playerId, edge) || this.canBuildBridge(playerId, edge);
    });
  }

  getBuildableBaseNodesForDie1(playerId) {
    return this.selectableBasesForDie1()
      .filter(id => this.getBuildableRoadEdgesFromBase(playerId, id).length > 0);
  }

  buildFromBase(baseNodeId, edgeIdValue) {
    const playerId = this.currentPlayerId;
    if (this.state.lastDie1 === null) throw new Error('请先掷第一骰');
    const base = this.getNode(baseNodeId);
    const edge = this.getEdge(edgeIdValue);
    if (!base || base.diceNumber !== this.state.lastDie1) throw new Error('基地点数必须等于第一骰');
    if (!edge || (edge.nodeA !== baseNodeId && edge.nodeB !== baseNodeId)) throw new Error('道路必须以基地为一端');
    this.buildRoad(playerId, edgeIdValue);
  }

  rollSecondDieForBase(baseNodeId) {
    if (this.state.lastDie1 === null) throw new Error('请先掷第一骰');
    const base = this.getNode(baseNodeId);
    if (!base || base.diceNumber !== this.state.lastDie1) throw new Error('基地点数必须等于第一骰');
    this.state.lastDie2 = this.random.rollDie();
    this.state.diceAnimationNonce = (this.state.diceAnimationNonce || 0) + 1;
    const candidates = this.getBuildableSecondDieTargets(this.currentPlayerId, baseNodeId, this.state.lastDie2);
    this.log('DICE_ROLLED', `${this.state.players[this.currentPlayerId].name} 选择基地 ${baseNodeId}，掷出第二骰：${this.state.lastDie2}`, { baseNodeId, die: this.state.lastDie2, candidates });
    return { die2: this.state.lastDie2, candidates };
  }

  resolveSecondDieBuild(baseNodeId, targetNodeId) {
    const playerId = this.currentPlayerId;
    if (this.state.lastDie2 === null) throw new Error('请先掷第二骰');
    const target = this.getNode(targetNodeId);
    const id = edgeId(baseNodeId, targetNodeId);
    const allowedTargets = this.getBuildableSecondDieTargets(playerId, baseNodeId, this.state.lastDie2);
    if (!target || target.diceNumber !== this.state.lastDie2 || !neighborsOf(baseNodeId).includes(targetNodeId) || !allowedTargets.includes(targetNodeId)) {
      this.log('NO_EFFECT', '第二骰目标点或边不符合修路/修桥条件，行动无效果', { edgeId: id });
      return 'NONE';
    }
    const edge = this.getEdge(id);
    if (edge.isRiverCrossing && this.canBuildBridge(playerId, edge)) {
      this.buildBridge(playerId, id);
      return 'BRIDGE';
    }
    if (this.canBuildRoad(playerId, edge)) {
      this.buildRoad(playerId, id);
      return 'ROAD';
    }
    this.log('NO_EFFECT', '第二骰目标边不符合修路/修桥条件，行动无效果', { edgeId: id });
    return 'NONE';
  }

  drawCard() {
    const card = this.random.weightedChoice([
      { value: CARD.RANDOM_ROAD, weight: 2 },
      { value: CARD.BRIDGE_TO_ROAD, weight: 1 },
      { value: CARD.REMOVE_ROAD_BUILD_BRIDGE, weight: 1 },
      { value: CARD.SUBSIDY, weight: 1 },
    ]);
    this.log('CARD_DRAWN', `${this.state.players[this.currentPlayerId].name} 抽到建设卡：${cardName(card)}`, { card });
    return card;
  }

  resolveCard(card, options = {}) {
    const playerId = this.currentPlayerId;
    if (card === CARD.SUBSIDY) {
      this.state.players[playerId].tollMoney += 2;
      const announcement = `资金补贴卡：${this.state.players[playerId].name}获得 2$`;
      this.log('CARD_RESOLVED', announcement, { card });
      return { done: true, announcement };
    }

    if (card === CARD.RANDOM_ROAD) {
      const edge = this.random.choice(Object.values(this.state.edges));
      const edgeLabel = this.formatEdgeCoord(edge);
      let announcement;
      if (edge && this.canBuildRoad(playerId, edge)) {
        this.buildRoad(playerId, edge.id);
        announcement = `随机修路卡生效：修建 ${edgeLabel}`;
        this.log('CARD_RESOLVED', announcement, { card, edgeId: edge.id, edgeLabel });
      } else {
        announcement = `随机修路卡抽中 ${edgeLabel}，不符合修路条件，无效果`;
        this.log('CARD_RESOLVED', announcement, { card, edgeId: edge?.id, edgeLabel });
      }
      return { done: true, announcement };
    }

    if (card === CARD.BRIDGE_TO_ROAD) {
      const candidates = this.getOwnBridgesWithoutRoad(playerId).map(e => e.id);
      if (!candidates.length) {
        const announcement = '桥梁通路卡无可用目标，无效果';
        this.log('CARD_RESOLVED', announcement, { card });
        return { done: true, announcement };
      }
      if (!options.selectedBridgeToRoadEdge) return { done: false, needs: 'SELECT_BRIDGE_TO_ROAD', candidates };
      if (!candidates.includes(options.selectedBridgeToRoadEdge)) throw new Error('请选择自己的有桥无路边');
      this.buildRoad(playerId, options.selectedBridgeToRoadEdge);
      const announcement = `桥梁通路卡生效：${this.formatEdgeCoord(options.selectedBridgeToRoadEdge)} 修好路`;
      this.log('CARD_RESOLVED', announcement, { card, edgeId: options.selectedBridgeToRoadEdge });
      return { done: true, announcement };
    }

    if (card === CARD.REMOVE_ROAD_BUILD_BRIDGE) {
      const roadCandidates = this.getRoadEdgesOf(playerId).map(e => e.id);
      const bridgeCandidates = this.getBuildableBridgeEdges(playerId).map(e => e.id);
      if (!roadCandidates.length || !bridgeCandidates.length) {
        const announcement = '拆路修桥卡缺少可拆道路或可修桥位置，无效果';
        this.log('CARD_RESOLVED', announcement, { card, roadCandidates, bridgeCandidates });
        return { done: true, announcement };
      }
      if (!options.selectedRoadToRemove) return { done: false, needs: 'SELECT_ROAD_TO_REMOVE', roadCandidates, bridgeCandidates };
      if (!roadCandidates.includes(options.selectedRoadToRemove)) throw new Error('请选择自己的一条道路拆除');
      if (!options.selectedBridgeEdge) return { done: false, needs: 'SELECT_BRIDGE_EDGE', roadCandidates, bridgeCandidates, selectedRoadToRemove: options.selectedRoadToRemove };
      if (!bridgeCandidates.includes(options.selectedBridgeEdge)) throw new Error('请选择无桥跨河边修桥');
      const removedLabel = this.formatEdgeCoord(options.selectedRoadToRemove);
      const bridgeLabel = this.formatEdgeCoord(options.selectedBridgeEdge);
      this.removeRoad(playerId, options.selectedRoadToRemove);
      this.buildBridge(playerId, options.selectedBridgeEdge);
      const announcement = `拆路修桥卡生效：拆 ${removedLabel}，建桥 ${bridgeLabel}`;
      this.log('CARD_RESOLVED', announcement, { card, ...options });
      return { done: true, announcement };
    }

    throw new Error('未知建设卡');
  }

  finishActionAndAdvance() {
    if (this.state.phase !== PHASE.PLAYER_TURN) return;
    this.checkMerchantCompletion();
    if (this.state.phase === PHASE.GAME_END) return;
    this.state.currentPlayerIndex = (this.state.currentPlayerIndex + 1) % this.state.playerOrder.length;
    this.state.turnNumber += 1;
    this.state.lastDie1 = null;
    this.state.lastDie2 = null;
    this.log('TURN_ENDED', `轮到 ${this.state.players[this.currentPlayerId].name}`);
  }

  spawnMerchant(index) {
    let merchant;
    if (index === 4 || index === 5) {
      merchant = { index, type: 'BIG', startNodeId: 'r6c6', endNodeId: 'r1c1', completed: false };
    } else {
      const city = Object.values(this.state.nodes).filter(n => n.region === REGION.CITY).map(n => n.id);
      const country = Object.values(this.state.nodes).filter(n => n.region === REGION.COUNTRYSIDE).map(n => n.id);
      const cityToCountry = this.random.next() < 0.5;
      merchant = {
        index,
        type: 'SMALL',
        startNodeId: cityToCountry ? this.random.choice(city) : this.random.choice(country),
        endNodeId: cityToCountry ? this.random.choice(country) : this.random.choice(city),
        completed: false,
      };
    }
    this.state.currentMerchant = merchant;
    this.log('MERCHANT_SPAWNED', `${merchant.type === 'BIG' ? '大商人' : '小商人'} ${index} 登场：${merchant.startNodeId} → ${merchant.endNodeId}`, merchant);
  }

  passableEdges() {
    return Object.values(this.state.edges).filter(e => e.roadOwnerId !== null && (!e.isRiverCrossing || e.bridgeOwnerId !== null));
  }

  passableNeighbors(nodeIdValue) {
    const result = [];
    for (const edge of this.passableEdges()) {
      if (edge.nodeA === nodeIdValue) result.push({ nodeId: edge.nodeB, edge });
      else if (edge.nodeB === nodeIdValue) result.push({ nodeId: edge.nodeA, edge });
    }
    return result;
  }

  /**
   * 严格等概率最短路径选择。
   *
   * 算法：
   * 1. BFS 计算起点到每个点的最短距离；
   * 2. 只保留 dist[next] = dist[current] + 1 的最短路径 DAG；
   * 3. 反向动态规划计算每个点到终点的最短路径条数；
   * 4. 从起点出发，每一步按后继节点的“剩余最短路径条数”作为权重随机选择。
   *
   * 这样每一条完整最短路径被选中的概率都是 1 / count[start]。
   */
  findUniformRandomShortestPath(startNodeId, endNodeId) {
    const dist = Object.fromEntries(Object.keys(this.state.nodes).map(id => [id, Infinity]));
    const queue = [startNodeId];
    dist[startNodeId] = 0;
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      for (const { nodeId: nb } of this.passableNeighbors(current)) {
        if (dist[nb] === Infinity) {
          dist[nb] = dist[current] + 1;
          queue.push(nb);
        }
      }
    }

    const shortestLength = dist[endNodeId];
    if (!Number.isFinite(shortestLength)) return null;

    const nodesByDistanceDesc = Object.keys(this.state.nodes)
      .filter(id => dist[id] <= shortestLength)
      .sort((a, b) => dist[b] - dist[a]);

    const count = Object.fromEntries(Object.keys(this.state.nodes).map(id => [id, 0]));
    count[endNodeId] = 1;

    for (const id of nodesByDistanceDesc) {
      if (id === endNodeId) continue;
      let total = 0;
      for (const { nodeId: nb } of this.passableNeighbors(id)) {
        if (dist[nb] === dist[id] + 1 && dist[nb] <= shortestLength) total += count[nb];
      }
      count[id] = total;
    }

    if (count[startNodeId] <= 0) return null;

    const pathNodeIds = [startNodeId];
    const pathEdgeIds = [];
    let current = startNodeId;
    while (current !== endNodeId) {
      const weightedNext = this.passableNeighbors(current)
        .filter(({ nodeId: nb }) => dist[nb] === dist[current] + 1 && count[nb] > 0)
        .map(({ nodeId: nb, edge }) => ({ value: { nodeId: nb, edge }, weight: count[nb] }));
      const chosen = this.random.weightedChoice(weightedNext);
      if (!chosen) return null;
      pathNodeIds.push(chosen.nodeId);
      pathEdgeIds.push(chosen.edge.id);
      current = chosen.nodeId;
    }

    return { nodeIds: pathNodeIds, edgeIds: pathEdgeIds, length: pathEdgeIds.length, pathCount: count[startNodeId] };
  }

  checkMerchantCompletion() {
    const merchant = this.state.currentMerchant;
    if (!merchant) return false;
    const path = this.findUniformRandomShortestPath(merchant.startNodeId, merchant.endNodeId);
    if (!path) {
      this.log('MERCHANT_WAITING', `商人 ${merchant.index} 暂无可通行路径`);
      return false;
    }

    const multiplier = merchant.type === 'BIG' ? 2 : 1;
    const tollDetails = [];
    for (const id of path.edgeIds) {
      const edge = this.getEdge(id);
      const roadFee = edge.length * multiplier;
      this.state.players[edge.roadOwnerId].tollMoney += roadFee;
      tollDetails.push({ playerId: edge.roadOwnerId, edgeId: id, kind: 'ROAD', amount: roadFee });
      if (edge.isRiverCrossing && edge.bridgeOwnerId) {
        const bridgeFee = edge.length * 4 * multiplier;
        this.state.players[edge.bridgeOwnerId].tollMoney += bridgeFee;
        tollDetails.push({ playerId: edge.bridgeOwnerId, edgeId: id, kind: 'BRIDGE', amount: bridgeFee });
      }
    }

    merchant.completed = true;
    merchant.chosenPathEdgeIds = path.edgeIds;
    merchant.chosenPathNodeIds = path.nodeIds;
    this.state.completedMerchants.push(merchant);
    this.state.lastMerchantPath = path.edgeIds;
    this.log('MERCHANT_COMPLETED', `商人 ${merchant.index} 完成交易：${merchant.startNodeId} → ${merchant.endNodeId}，最短长度 ${path.length}，等概率候选路径 ${path.pathCount} 条`, { merchant, path, tollDetails });

    if (merchant.index === 5) {
      this.endGame();
    } else {
      this.spawnMerchant(merchant.index + 1);
    }
    return true;
  }

  endGame() {
    const rankings = Object.values(this.state.players)
      .map(p => ({ ...p, roads: this.getPlayerRoadCount(p.id), bridges: this.getPlayerBridgeCount(p.id) }))
      .sort((a, b) => (b.tollMoney - a.tollMoney) || (b.roads - a.roads));
    const best = rankings[0];
    const winners = rankings.filter(p => p.tollMoney === best.tollMoney && p.roads === best.roads).map(p => p.id);
    this.state.phase = PHASE.GAME_END;
    this.state.result = { rankings, winners };
    this.log('GAME_ENDED', `游戏结束，获胜者：${winners.map(id => this.state.players[id].name).join('、')}`, this.state.result);
  }
}

export function cardName(card) {
  return {
    [CARD.RANDOM_ROAD]: '随机修路卡',
    [CARD.BRIDGE_TO_ROAD]: '桥梁通路卡',
    [CARD.REMOVE_ROAD_BUILD_BRIDGE]: '拆路修桥卡',
    [CARD.SUBSIDY]: '资金补贴卡',
  }[card] || card;
}

export function regionName(region) {
  return region === REGION.CITY ? '城市' : '乡村';
}

export function merchantName(merchant) {
  if (!merchant) return '无';
  return `${merchant.type === 'BIG' ? '大商人' : '小商人'} ${merchant.index}`;
}

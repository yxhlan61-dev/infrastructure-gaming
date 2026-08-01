import {
  GameEngine,
  PHASE,
  edgeId,
  cardName,
  regionName,
  merchantName,
} from './game.js';

const svg = document.getElementById('gameBoard');
const setupPanel = document.getElementById('setupPanel');
const playerCountInput = document.getElementById('playerCountInput');
const playerNameInputs = document.getElementById('playerNameInputs');
const createGameBtn = document.getElementById('createGameBtn');
const newGameTopBtn = document.getElementById('newGameTopBtn');
const statusPanel = document.getElementById('statusPanel');
const actionPanel = document.getElementById('actionPanel');
const playersPanel = document.getElementById('playersPanel');
const logPanel = document.getElementById('logPanel');
const phaseBadge = document.getElementById('phaseBadge');
const boardHint = document.getElementById('boardHint');

let engine = null;
let uiMode = { type: 'SETUP' };
let pendingWaitTimer = null;
let pendingWaitSeq = 0;

const POS = { xMargin: 250, yMargin: 60, step: 100 };
const LEFT_PANEL = { x: -55, width: 230 };
function point(node) {
  return { x: POS.xMargin + (node.row - 1) * POS.step, y: POS.yMargin + (6 - node.col) * POS.step };
}
function mapBounds() {
  return {
    left: POS.xMargin - POS.step / 2,
    right: POS.xMargin + POS.step * 5 + POS.step / 2,
    top: POS.yMargin - POS.step / 2,
    bottom: POS.yMargin + POS.step * 5 + POS.step / 2,
  };
}
function createRandomSeed() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function centerSegment(a, b, ratio = 0.5) {
  // Bridge occupies only the centered half of the edge: from 1/4 to 3/4.
  const start = (1 - ratio) / 2;
  const end = 1 - start;
  return {
    x1: a.x + (b.x - a.x) * start,
    y1: a.y + (b.y - a.y) * start,
    x2: a.x + (b.x - a.x) * end,
    y2: a.y + (b.y - a.y) * end,
  };
}
function bridgeTrianglePoints(a, b) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const forward = 30;
  const backward = 24;
  const halfWidth = 22;
  const pts = [
    [mx + ux * forward, my + uy * forward],
    [mx - ux * backward + px * halfWidth, my - uy * backward + py * halfWidth],
    [mx - ux * backward - px * halfWidth, my - uy * backward - py * halfWidth],
  ];
  return pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}
function coordLabel(nodeId) {
  if (!engine) return nodeId;
  const n = engine.state.nodes[nodeId];
  return n ? `(${n.row},${n.col})` : nodeId;
}
function el(name, attrs = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of children) node.appendChild(child);
  return node;
}
function svgText(text, attrs = {}) {
  const t = el('text', attrs);
  t.textContent = text;
  return t;
}
function svgMultilineText(lines, attrs = {}, lineHeight = 18) {
  const t = el('text', attrs);
  lines.forEach((line, index) => {
    const span = el('tspan', { x: attrs.x, dy: index === 0 ? 0 : lineHeight });
    span.textContent = line;
    t.appendChild(span);
  });
  return t;
}
function htmlEscape(str) {
  return String(str).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function showAnnouncement(title, body) {
  document.querySelectorAll('.announcement-backdrop').forEach(n => n.remove());
  const backdrop = document.createElement('div');
  backdrop.className = 'announcement-backdrop';
  const dialog = document.createElement('div');
  dialog.className = 'announcement-dialog';
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = body;
  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.textContent = '\u77e5\u9053\u4e86';
  btn.addEventListener('click', () => backdrop.remove());
  dialog.append(h, p, btn);
  backdrop.appendChild(dialog);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
}

function clearPendingWait() {
  pendingWaitSeq += 1;
  if (pendingWaitTimer) {
    clearTimeout(pendingWaitTimer);
    pendingWaitTimer = null;
  }
}

function beginWaitingMessage(message, afterWait, delayMs = 2000) {
  clearPendingWait();
  const seq = pendingWaitSeq;
  uiMode = { type: 'WAITING_MESSAGE', message };
  render();
  pendingWaitTimer = setTimeout(() => {
    if (seq !== pendingWaitSeq || !engine) return;
    pendingWaitTimer = null;
    afterWait();
  }, delayMs);
}

function waitAfterSecondDie(messageWhenNoCard = '\u0032 \u79d2\u540e\u8fdb\u5165\u4e0b\u4e00\u56de\u5408\u3002') {
  const gotCardChance = engine.state.lastDie2 === engine.state.lastDie1;
  const dieInfo = `\u7b2c\u4e00\u9ab0 ${engine.state.lastDie1}\uff0c\u7b2c\u4e8c\u9ab0 ${engine.state.lastDie2}\u3002`;
  const message = gotCardChance
    ? `${dieInfo}${messageWhenNoCard} \u7b2c\u4e8c\u9ab0\u7b49\u4e8e\u7b2c\u4e00\u9ab0\uff0c\u73a9\u5bb6\u83b7\u5f97\u4e00\u6b21\u5efa\u8bbe\u5361\u673a\u4f1a\uff0c\u0032 \u79d2\u540e\u62bd\u5efa\u8bbe\u5361\u3002`
    : `${dieInfo}${messageWhenNoCard}`;
  beginWaitingMessage(message, () => {
    if (gotCardChance) processDrawCardAndMaybeFinish();
    else finishTurn();
  });
}

function renderPlayerInputs() {
  const count = Number(playerCountInput.value);
  playerNameInputs.innerHTML = '';
  for (let i = 1; i <= count; i++) {
    const label = document.createElement('label');
    label.textContent = `玩家 ${i} 名称`;
    const input = document.createElement('input');
    input.id = `playerName${i}`;
    input.value = `玩家${i}`;
    label.appendChild(input);
    playerNameInputs.appendChild(label);
  }
}

playerCountInput.addEventListener('change', renderPlayerInputs);
renderPlayerInputs();

createGameBtn.addEventListener('click', () => {
  clearPendingWait();
  const count = Number(playerCountInput.value);
  const players = [];
  for (let i = 1; i <= count; i++) {
    players.push({ name: document.getElementById(`playerName${i}`).value.trim() || `玩家${i}` });
  }
  engine = new GameEngine({ players, seed: createRandomSeed() });
  setupPanel.style.display = 'none';
  uiMode = { type: 'IDLE' };
  render();
});

newGameTopBtn.addEventListener('click', () => {
  clearPendingWait();
  engine = null;
  uiMode = { type: 'SETUP' };
  setupPanel.style.display = '';
  render();
});

function selectableEdges() {
  if (!engine) return new Set();
  const s = engine.state;
  if (s.phase === PHASE.PRE_BUILD) return new Set(engine.getBuildableRoadEdges(engine.preBuildPlayerId).map(e => e.id));
  if (uiMode.type === 'SELECT_EDGE_ROAD') return new Set(engine.getBuildableRoadEdgesFromBase(engine.currentPlayerId, uiMode.baseNodeId).map(e => e.id));
  if (uiMode.type === 'SELECT_EDGE_SECOND') return new Set(uiMode.candidateNodeIds.map(id => edgeId(uiMode.baseNodeId, id)));
  if (uiMode.type === 'CARD_SELECT_BRIDGE_TO_ROAD') return new Set(uiMode.candidates);
  if (uiMode.type === 'CARD_SELECT_ROAD_TO_REMOVE') return new Set(uiMode.roadCandidates);
  if (uiMode.type === 'CARD_SELECT_BRIDGE_EDGE') return new Set(uiMode.bridgeCandidates);
  return new Set();
}

function selectableNodes() {
  if (!engine) return new Set();
  if (uiMode.type === 'CHOOSE_ACTION') return new Set(engine.getBuildableBaseNodesForDie1(engine.currentPlayerId));
  if (uiMode.type === 'SELECT_BASE_ROAD') return new Set(engine.getBuildableBaseNodesForDie1(engine.currentPlayerId));
  if (uiMode.type === 'SELECT_BASE_SECOND') return new Set(engine.selectableBasesForDie1());
  if (uiMode.type === 'SELECT_EDGE_SECOND') return new Set(uiMode.candidateNodeIds);
  return new Set();
}

function routeLabel(startNodeId, endNodeId) {
  return `${coordLabel(startNodeId)} \u2192 ${coordLabel(endNodeId)}`;
}

function merchantTollInfo(merchant) {
  const multiplier = merchant?.type === 'BIG' ? 2 : 1;
  return { roadFee: multiplier, bridgeFee: 4 * multiplier };
}

function renderMerchantOverlay(nodes, currentMerchant) {
  if (!currentMerchant) return;
  const startNode = nodes[currentMerchant.startNodeId];
  const endNode = nodes[currentMerchant.endNodeId];
  if (!startNode || !endNode) return;
  const a = point(startNode);
  const b = point(endNode);
  svg.appendChild(el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'merchant-direct-line' }));

  const merchantType = currentMerchant.type === 'BIG' ? '\u5927\u5546\u4eba' : '\u5c0f\u5546\u4eba';
  const { roadFee, bridgeFee } = merchantTollInfo(currentMerchant);

  const boxX = LEFT_PANEL.x;
  const boxW = LEFT_PANEL.width;
  const boxCx = boxX + boxW / 2;
  svg.appendChild(el('rect', { x: boxX, y: 92, width: boxW, height: 114, rx: 14, class: 'merchant-info-box' }));
  svg.appendChild(svgMultilineText([
    `${merchantType}\u4f1a\u6cbf\u7740\u6700\u77ed\u8def\u5f84\u8fdb\u884c\u4ea4\u6613`,
    `\u9053\u8def\u8fc7\u8def\u8d39 ${roadFee}$ / \u6bb5`,
    `\u6865\u6881\u8fc7\u8def\u8d39 ${bridgeFee}$ / \u5ea7`,
    '\u8bf7\u5c3d\u53ef\u80fd\u591a\u7684\u5b8c\u5584\u57ce\u4e61\u57fa\u5efa\u5427',
  ], { x: boxCx, y: 122, class: 'merchant-info-text' }, 23));

  svg.appendChild(el('rect', { x: boxX, y: 222, width: boxW, height: 68, rx: 14, class: 'merchant-route-box' }));
  svg.appendChild(svgText('\u5f53\u524d\u5546\u4eba\u8def\u7ebf', { x: boxCx, y: 247, class: 'merchant-route-title' }));
  svg.appendChild(svgText(routeLabel(currentMerchant.startNodeId, currentMerchant.endNodeId), { x: boxCx, y: 275, class: 'merchant-route-text' }));

  svg.appendChild(el('rect', { x: boxX, y: 304, width: boxW, height: 58, rx: 14, class: 'final-route-box' }));
  svg.appendChild(svgText('\u6700\u540e\u4e00\u4e2a\u5927\u5546\u4eba\u56fa\u5b9a\u8def\u7ebf', { x: boxCx, y: 327, class: 'final-route-title' }));
  svg.appendChild(svgText(routeLabel('r6c6', 'r1c1'), { x: boxCx, y: 351, class: 'final-route-text' }));
}

function drawRegionBackground(nodes, edges) {
  const b = mapBounds();
  svg.appendChild(el('rect', {
    x: b.left,
    y: b.top,
    width: b.right - b.left,
    height: b.bottom - b.top,
    class: 'region-bg region-bg-country',
  }));

  const riverPoints = riverCurvePoints(nodes, edges);
  if (riverPoints.length < 2) return;
  const d = `${catmullRomPath(riverPoints)} L ${b.right.toFixed(1)} ${b.bottom.toFixed(1)} L ${b.left.toFixed(1)} ${b.bottom.toFixed(1)} Z`;
  svg.appendChild(el('path', { d, class: 'region-bg region-bg-city' }));
}

function catmullRomPath(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function intersectRayWithBounds(point, direction, bounds) {
  const candidates = [];
  const addCandidate = (t, x, y) => {
    if (t > 0 && x >= bounds.left - 0.01 && x <= bounds.right + 0.01 && y >= bounds.top - 0.01 && y <= bounds.bottom + 0.01) {
      candidates.push({ t, x, y });
    }
  };
  if (direction.x !== 0) {
    let t = (bounds.left - point.x) / direction.x;
    addCandidate(t, bounds.left, point.y + direction.y * t);
    t = (bounds.right - point.x) / direction.x;
    addCandidate(t, bounds.right, point.y + direction.y * t);
  }
  if (direction.y !== 0) {
    let t = (bounds.top - point.y) / direction.y;
    addCandidate(t, point.x + direction.x * t, bounds.top);
    t = (bounds.bottom - point.y) / direction.y;
    addCandidate(t, point.x + direction.x * t, bounds.bottom);
  }
  candidates.sort((a, b) => a.t - b.t);
  return candidates[0] || point;
}

function riverCurvePoints(nodes, edges) {
  const seen = new Set();
  const points = Object.values(edges)
    .filter(e => e.isRiverCrossing)
    .map(e => {
      const a = point(nodes[e.nodeA]);
      const b = point(nodes[e.nodeB]);
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    })
    .sort((a, b) => (a.x + a.y) - (b.x + b.y) || a.x - b.x || a.y - b.y)
    .filter(p => {
      const key = `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (points.length > 1) {
    const bounds = mapBounds();
    const first = points[0];
    const second = points[1];
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    const before = intersectRayWithBounds(first, { x: first.x - second.x, y: first.y - second.y }, bounds);
    const after = intersectRayWithBounds(last, { x: last.x - prev.x, y: last.y - prev.y }, bounds);
    return [before, ...points, after];
  }
  return points;
}

function drawRiverCurve(nodes, edges) {
  const points = riverCurvePoints(nodes, edges);
  if (points.length < 2) return;
  const d = catmullRomPath(points);
  svg.appendChild(el('path', { d, class: 'river-curve-bank' }));
  svg.appendChild(el('path', { d, class: 'river-curve' }));
}

function renderBuildLegend() {
  const x = LEFT_PANEL.x;
  const y = 380;
  const w = LEFT_PANEL.width;
  const cx = x + w / 2;
  svg.appendChild(el('rect', { x, y, width: w, height: 150, rx: 14, class: 'map-legend-box' }));
  svg.appendChild(svgText('\u9053\u8def / \u6865\u6881\u56fe\u4f8b', { x: cx, y: y + 28, class: 'map-legend-title' }));

  svg.appendChild(el('line', { x1: x + 28, y1: y + 60, x2: x + 104, y2: y + 60, class: 'map-legend-road' }));
  svg.appendChild(svgText('\u9053\u8def', { x: x + 132, y: y + 66, class: 'map-legend-text' }));

  const bridgePoints = `${x + 66},${y + 84} ${x + 37},${y + 126} ${x + 95},${y + 126}`;
  svg.appendChild(el('polygon', { points: bridgePoints, class: 'map-legend-bridge-outline' }));
  svg.appendChild(el('polygon', { points: bridgePoints, class: 'map-legend-bridge' }));
  svg.appendChild(svgText('\u6865\u6881', { x: x + 132, y: y + 113, class: 'map-legend-text' }));
  svg.appendChild(svgText('\u4fee\u8def\u540e\u9053\u8def\u76d6\u5728\u6865\u4e0a', { x: cx, y: y + 141, class: 'map-legend-note' }));
}

function renderDiceDisplay(state) {
  const nonce = state.diceAnimationNonce || 0;
  const g = el('g', { class: 'dice-panel', 'data-nonce': nonce, transform: 'translate(790 190)' });
  g.appendChild(el('rect', { x: 0, y: 0, width: 125, height: 205, rx: 18, class: 'dice-panel-bg' }));
  g.appendChild(svgText('骰子点数', { x: 62, y: 30, class: 'dice-title' }));

  const die1Class = state.lastDie1 ? 'die-face die-animate' : 'die-face die-empty';
  const die2Class = state.lastDie2 ? 'die-face die-animate' : 'die-face die-empty';
  const die1 = el('g', { class: die1Class, transform: 'translate(28 48)' });
  die1.appendChild(el('rect', { x: 0, y: 0, width: 70, height: 70, rx: 14 }));
  die1.appendChild(svgText(state.lastDie1 ?? '-', { x: 35, y: 38, class: 'die-number' }));
  die1.appendChild(svgText('第一骰', { x: 35, y: 94, class: 'die-label' }));
  g.appendChild(die1);

  const die2 = el('g', { class: die2Class, transform: 'translate(28 132)' });
  die2.appendChild(el('rect', { x: 0, y: 0, width: 70, height: 70, rx: 14 }));
  die2.appendChild(svgText(state.lastDie2 ?? '-', { x: 35, y: 38, class: 'die-number' }));
  die2.appendChild(svgText('第二骰', { x: 35, y: 94, class: 'die-label' }));
  g.appendChild(die2);
  svg.appendChild(g);
}

function renderBoard() {
  svg.innerHTML = '';
  if (!engine) return;
  const { nodes, edges, players, currentMerchant, lastMerchantPath } = engine.state;
  const edgeSet = selectableEdges();
  const nodeSet = selectableNodes();
  const pathSet = new Set(lastMerchantPath || []);

  drawRegionBackground(nodes, edges);

  for (const e of Object.values(edges)) {
    const a = point(nodes[e.nodeA]);
    const b = point(nodes[e.nodeB]);
    svg.appendChild(el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'edge-base' }));
  }
  drawRiverCurve(nodes, edges);
  for (const id of pathSet) {
    const e = edges[id];
    if (!e) continue;
    const a = point(nodes[e.nodeA]);
    const b = point(nodes[e.nodeB]);
    svg.appendChild(el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'path-edge' }));
  }

  // Draw bridges before roads: bridges are built first and should visually sit below roads.
  for (const e of Object.values(edges)) {
    const a = point(nodes[e.nodeA]);
    const b = point(nodes[e.nodeB]);
    if (e.bridgeOwnerId) {
      const points = bridgeTrianglePoints(a, b);
      svg.appendChild(el('polygon', { points, class: 'bridge-triangle-outline' }));
      svg.appendChild(el('polygon', { points, class: 'bridge-triangle', fill: 'none', stroke: players[e.bridgeOwnerId].color }));
    }
  }
  for (const e of Object.values(edges)) {
    const a = point(nodes[e.nodeA]);
    const b = point(nodes[e.nodeB]);
    if (e.roadOwnerId) svg.appendChild(el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'road-edge', stroke: players[e.roadOwnerId].color }));
  }

  renderMerchantOverlay(nodes, currentMerchant);
  renderBuildLegend();

  for (const e of Object.values(edges)) {
    const a = point(nodes[e.nodeA]);
    const b = point(nodes[e.nodeB]);
    const line = el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `edge-hit ${edgeSet.has(e.id) ? 'selectable' : ''}` });
    line.addEventListener('click', () => onEdgeClick(e.id));
    svg.appendChild(line);
  }

  for (const n of Object.values(nodes)) {
    const p = point(n);
    const classes = ['node', n.region === 'CITY' ? 'region-city' : 'region-country'];
    if (nodeSet.has(n.id)) classes.push('selectable');
    if (uiMode.baseNodeId === n.id) classes.push('base-selected');
    if (currentMerchant?.startNodeId === n.id) classes.push('merchant-start');
    if (currentMerchant?.endNodeId === n.id) classes.push('merchant-end');

    const circle = el('circle', { cx: p.x, cy: p.y, r: 22, class: classes.join(' ') });
    circle.addEventListener('click', () => onNodeClick(n.id));
    svg.appendChild(circle);
    svg.appendChild(svgText(n.diceNumber, { x: p.x, y: p.y + 1, class: 'node-label' }));
    svg.appendChild(svgText(`(${n.row},${n.col}) ${regionName(n.region)}`, { x: p.x, y: p.y + 35, class: 'node-coord' }));
  }
  renderDiceDisplay(engine.state);
}

function renderStatus() {
  if (!engine) {
    phaseBadge.textContent = '未开始';
    statusPanel.innerHTML = '<p class="small">请创建游戏。</p>';
    boardHint.textContent = '创建游戏后开始。';
    return;
  }
  const s = engine.state;
  phaseBadge.textContent = s.phase === PHASE.PRE_BUILD ? '开局预建设' : s.phase === PHASE.PLAYER_TURN ? '正式回合' : '游戏结束';
  const currentName = s.phase === PHASE.PRE_BUILD ? s.players[engine.preBuildPlayerId]?.name : s.players[engine.currentPlayerId]?.name;
  const merchant = s.currentMerchant;
  const lines = [];
  lines.push(`<div class="kv-row"><span>当前阶段</span><b>${phaseBadge.textContent}</b></div>`);
  lines.push(`<div class="kv-row"><span>当前玩家</span><b>${htmlEscape(currentName || '-')}</b></div>`);
  lines.push(`<div class="kv-row"><span>回合编号</span><b>${s.turnNumber || '-'}</b></div>`);
  lines.push(`<div class="kv-row"><span>第一骰</span><b>${s.lastDie1 ?? '-'}</b></div>`);
  lines.push(`<div class="kv-row"><span>第二骰</span><b>${s.lastDie2 ?? '-'}</b></div>`);
  if (merchant) {
    lines.push(`<div class="merchant-box"><span>${merchantName(merchant)}</span><b>${coordLabel(merchant.startNodeId)} → ${coordLabel(merchant.endNodeId)}</b></div>`);
  }
  if (s.result) lines.push(`<p><b>获胜者：</b>${s.result.winners.map(id => htmlEscape(s.players[id].name)).join('、')}</p>`);
  statusPanel.innerHTML = lines.join('');
  boardHint.textContent = hintText();
  boardHint.classList.toggle('waiting-hint', uiMode.type === 'WAITING_MESSAGE');
}


function hintText() {
  if (!engine) return '创建游戏后开始。';
  if (engine.state.phase === PHASE.PRE_BUILD) return `开局预建设：请为 ${engine.state.players[engine.preBuildPlayerId].name} 点击一条高亮边修建初始道路。`;
  if (engine.state.phase === PHASE.GAME_END) return '游戏结束。黄色粗线显示最近一次商人实际最短路径。';
  const map = {
    IDLE: '点击“掷第一骰/开始回合”。',
    CHOOSE_ACTION: '请选择本回合行动。行动2会只高亮第一骰点数中当前可正常修路的基地；如果没有合法基地则会直接跳过。',
    SELECT_BASE_ROAD: '行动2：请选择一个橙色高亮基地。只有第一骰点数且至少有一条可修道路的基地会高亮；若没有高亮点则本回合跳过。',
    SELECT_EDGE_ROAD: '行动2：点击以基地为端点的高亮边修路。',
    SELECT_BASE_SECOND: '行动3：选择一个点数等于第一骰的高亮居民点作为临时施工基地，然后自动掷第二骰。',
    SELECT_EDGE_SECOND: '行动3：点击与基地相邻且点数等于第二骰的高亮边/点；跨河无桥会修桥，已有自己桥会修路。',
    CARD_SELECT_BRIDGE_TO_ROAD: '桥梁通路卡：点击自己的一座有桥无路的高亮边。',
    CARD_SELECT_ROAD_TO_REMOVE: '拆路修桥卡：先点击自己的一条高亮道路作为原材料。',
    CARD_SELECT_BRIDGE_EDGE: '拆路修桥卡：再点击任意一条无桥跨河高亮边修桥。',
    WAITING_MESSAGE: uiMode.message || '\u8bf7\u7b49\u5f85\u5f53\u524d\u63d0\u793a\u5b8c\u6210\u3002',
  };
  return map[uiMode.type] || '请选择操作。';
}

function renderPlayers() {
  if (!engine) {
    playersPanel.innerHTML = '<p class="small">暂无玩家。</p>';
    return;
  }
  const s = engine.state;
  playersPanel.innerHTML = s.playerOrder.map(id => {
    const p = s.players[id];
    const current = (s.phase === PHASE.PRE_BUILD && engine.preBuildPlayerId === id) || (s.phase === PHASE.PLAYER_TURN && engine.currentPlayerId === id);
    return `<div class="player-row ${current ? 'current-player' : ''}">
      <span class="player-name"><i class="color-dot" style="background:${p.color}"></i>${htmlEscape(p.name)}</span>
      <span>${p.tollMoney}$ · 路 ${engine.getPlayerRoadCount(id)} · 桥 ${engine.getPlayerBridgeCount(id)}</span>
    </div>`;
  }).join('');
}

function renderActions() {
  if (!engine) {
    actionPanel.innerHTML = '<p class="small">创建游戏后显示可用操作。</p>';
    return;
  }
  const s = engine.state;
  if (s.phase === PHASE.PRE_BUILD) {
    actionPanel.innerHTML = `<p>请在地图上点击高亮边，为 <b>${htmlEscape(s.players[engine.preBuildPlayerId].name)}</b> 修建一条初始道路。</p>`;
    return;
  }
  if (s.phase === PHASE.GAME_END) {
    const rows = s.result.rankings.map((p, i) => `<div class="player-row"><b>#${i + 1} ${htmlEscape(p.name)}</b><span>${p.tollMoney}$ · 路 ${p.roads}</span></div>`).join('');
    actionPanel.innerHTML = `<p>第 5 位商人已完成交易。</p>${rows}`;
    return;
  }

  if (uiMode.type === 'IDLE') {
    actionPanel.innerHTML = `<button id="startTurnBtn" class="primary">掷第一骰 / 开始回合</button>`;
    document.getElementById('startTurnBtn').addEventListener('click', () => {
      clearPendingWait();
      engine.startTurn();
      uiMode = { type: 'CHOOSE_ACTION' };
      render();
    });
    return;
  }

  if (uiMode.type === 'CHOOSE_ACTION') {
    const buildableBases = engine.getBuildableBaseNodesForDie1(engine.currentPlayerId);
    actionPanel.innerHTML = `
      <p><b>${htmlEscape(s.players[engine.currentPlayerId].name)}</b> 第一骰为 <b>${s.lastDie1}</b>，请选择行动：</p>
      <button id="drawCardBtn">1. 抽建设卡</button>
      <button id="buildRoadBtn">2. 选基地修任意道路${buildableBases.length ? `（${buildableBases.length} 个可用基地）` : '（无可用基地，点击后跳过）'}</button>
      <button id="secondDieBtn">3. 选基地后掷第二骰</button>`;
    document.getElementById('drawCardBtn').addEventListener('click', () => processDrawCardAndMaybeFinish());
    document.getElementById('buildRoadBtn').addEventListener('click', () => {
      const bases = engine.getBuildableBaseNodesForDie1(engine.currentPlayerId);
      if (!bases.length) {
        engine.log('NO_EFFECT', `第一骰为 ${engine.state.lastDie1}，没有任何可正常修路的基地，行动2跳过回合`);
        finishTurn();
      } else {
        uiMode = { type: 'SELECT_BASE_ROAD' };
        render();
      }
    });
    document.getElementById('secondDieBtn').addEventListener('click', () => { uiMode = { type: 'SELECT_BASE_SECOND' }; render(); });
    return;
  }

  if (uiMode.type === 'WAITING_MESSAGE') {
    actionPanel.innerHTML = `<p class="waiting-message">${htmlEscape(hintText())}</p>`;
    return;
  }

  if (uiMode.type.startsWith('CARD_')) {
    actionPanel.innerHTML = `<p><b>${cardName(uiMode.card)}</b></p><p>${hintText()}</p>`;
    return;
  }

  actionPanel.innerHTML = `<p>${hintText()}</p>`;
}

function renderLog() {
  if (!engine) { logPanel.innerHTML = ''; return; }
  logPanel.innerHTML = engine.state.log.slice(0, 120).map(entry => `<div class="log-entry">[${entry.type}] ${htmlEscape(entry.message)}</div>`).join('');
}

function render() {
  document.body.classList.toggle('is-setup', !engine);
  renderBoard();
  renderStatus();
  renderPlayers();
  renderActions();
  renderLog();
}

function onNodeClick(nodeId) {
  if (!engine) return;
  try {
    if (uiMode.type === 'SELECT_BASE_ROAD') {
      const buildableBases = engine.getBuildableBaseNodesForDie1(engine.currentPlayerId);
      if (!engine.selectableBasesForDie1().includes(nodeId)) return;
      if (!buildableBases.includes(nodeId)) {
        engine.log('NO_EFFECT', `玩家选择的基地 ${coordLabel(nodeId)} 当前无法修路，行动2跳过回合`);
        finishTurn();
        return;
      }
      uiMode = { type: 'SELECT_EDGE_ROAD', baseNodeId: nodeId };
      render();
      return;
    }
    if (uiMode.type === 'SELECT_BASE_SECOND') {
      if (!engine.selectableBasesForDie1().includes(nodeId)) return;
      const { candidates } = engine.rollSecondDieForBase(nodeId);
      if (!candidates.length) {
        engine.log('NO_EFFECT', '\u57fa\u5730\u76f8\u90bb\u5c45\u6c11\u70b9\u4e2d\u6ca1\u6709\u70b9\u6570\u7b49\u4e8e\u7b2c\u4e8c\u9ab0\u4e14\u53ef\u6b63\u5e38\u4fee\u8def/\u4fee\u6865\u7684\u76ee\u6807\uff0c\u672c\u6b21\u5efa\u8bbe\u65e0\u6548\u679c');
        waitAfterSecondDie('\u5efa\u8bbe\u65e0\u6548\uff1a\u57fa\u5730\u76f8\u90bb\u5c45\u6c11\u70b9\u4e2d\u6ca1\u6709\u70b9\u6570\u7b49\u4e8e\u7b2c\u4e8c\u9ab0\u4e14\u53ef\u6b63\u5e38\u4fee\u8def/\u4fee\u6865\u7684\u76ee\u6807\u3002\u0032 \u79d2\u540e\u8fdb\u5165\u4e0b\u4e00\u6b65\u3002');
      } else {
        uiMode = { type: 'SELECT_EDGE_SECOND', baseNodeId: nodeId, candidateNodeIds: candidates };
        render();
      }
      return;
    }
    if (uiMode.type === 'SELECT_EDGE_SECOND' && uiMode.candidateNodeIds.includes(nodeId)) onEdgeClick(edgeId(uiMode.baseNodeId, nodeId));
  } catch (err) {
    alert(err.message);
    render();
  }
}

function onEdgeClick(edgeIdValue) {
  if (!engine) return;
  const selectable = selectableEdges();
  if (!selectable.has(edgeIdValue)) return;
  try {
    if (engine.state.phase === PHASE.PRE_BUILD) {
      engine.preBuildRoad(edgeIdValue);
      uiMode = { type: 'IDLE' };
      render();
      return;
    }
    if (uiMode.type === 'SELECT_EDGE_ROAD') {
      engine.buildFromBase(uiMode.baseNodeId, edgeIdValue);
      finishTurn();
      return;
    }
    if (uiMode.type === 'SELECT_EDGE_SECOND') {
      const edge = engine.getEdge(edgeIdValue);
      const target = edge.nodeA === uiMode.baseNodeId ? edge.nodeB : edge.nodeA;
      engine.resolveSecondDieBuild(uiMode.baseNodeId, target);
      if (engine.state.lastDie2 === engine.state.lastDie1) {
        waitAfterSecondDie('\u672c\u6b21\u5efa\u8bbe\u5df2\u5b8c\u6210\u3002\u0032 \u79d2\u540e\u8fdb\u5165\u4e0b\u4e00\u6b65\u3002');
      } else {
        finishTurn();
      }
      return;
    }
    if (uiMode.type === 'CARD_SELECT_BRIDGE_TO_ROAD') {
      const res = engine.resolveCard(uiMode.card, { selectedBridgeToRoadEdge: edgeIdValue });
      if (res.done) {
        showAnnouncement(`\u5efa\u8bbe\u5361\uff1a${cardName(uiMode.card)}`, res.announcement || '\u5efa\u8bbe\u5361\u5df2\u7ed3\u7b97\u3002');
        finishTurn();
      }
      return;
    }
    if (uiMode.type === 'CARD_SELECT_ROAD_TO_REMOVE') {
      uiMode = { ...uiMode, type: 'CARD_SELECT_BRIDGE_EDGE', selectedRoadToRemove: edgeIdValue };
      render();
      return;
    }
    if (uiMode.type === 'CARD_SELECT_BRIDGE_EDGE') {
      const res = engine.resolveCard(uiMode.card, { selectedRoadToRemove: uiMode.selectedRoadToRemove, selectedBridgeEdge: edgeIdValue });
      if (res.done) {
        showAnnouncement(`\u5efa\u8bbe\u5361\uff1a${cardName(uiMode.card)}`, res.announcement || '\u5efa\u8bbe\u5361\u5df2\u7ed3\u7b97\u3002');
        finishTurn();
      }
    }
  } catch (err) {
    alert(err.message);
    render();
  }
}

function processDrawCardAndMaybeFinish() {
  try {
    const card = engine.drawCard();
    let res = engine.resolveCard(card);
    if (res.done) {
      showAnnouncement(`\u5efa\u8bbe\u5361\uff1a${cardName(card)}`, res.announcement || '\u5efa\u8bbe\u5361\u5df2\u7ed3\u7b97\u3002');
      finishTurn();
      return;
    }
    showAnnouncement(`\u62bd\u5230\u5efa\u8bbe\u5361\uff1a${cardName(card)}`, '\u8bf7\u6839\u636e\u5730\u56fe\u9ad8\u4eae\u9009\u62e9\u672c\u5361\u724c\u7684\u76ee\u6807\u3002');
    if (res.needs === 'SELECT_BRIDGE_TO_ROAD') uiMode = { type: 'CARD_SELECT_BRIDGE_TO_ROAD', card, candidates: res.candidates };
    else if (res.needs === 'SELECT_ROAD_TO_REMOVE') uiMode = { type: 'CARD_SELECT_ROAD_TO_REMOVE', card, roadCandidates: res.roadCandidates, bridgeCandidates: res.bridgeCandidates };
    render();
  } catch (err) {
    alert(err.message);
    render();
  }
}

function finishTurn() {
  clearPendingWait();
  const previousMerchantIndex = engine.state.currentMerchant?.index;
  engine.finishActionAndAdvance();
  const shouldAnnounceBigMerchant = engine.state.currentMerchant?.index === 4 && previousMerchantIndex !== 4;
  uiMode = { type: engine.state.phase === PHASE.GAME_END ? 'GAME_END' : 'IDLE' };
  render();
  if (shouldAnnounceBigMerchant) {
    showAnnouncement('\u5927\u5546\u4eba\u524d\u6765\u4ea4\u6613', '\u57ce\u4e61\u57fa\u5efa\u8fdb\u5165\u51b2\u523a\u9636\u6bb5');
  }
}

render();

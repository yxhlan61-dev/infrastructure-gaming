import {
  GameEngine,
  CARD,
  PHASE,
  edgeId,
  cardName,
  regionName,
  merchantName,
  MERCHANT_COUNT,
} from './game.js';
import { CARD_CATALOG, RULE_SECTIONS } from './catalog.js';

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
const localModeBtn = document.getElementById('localModeBtn');
const onlineModeBtn = document.getElementById('onlineModeBtn');
const localSetupContent = document.getElementById('localSetupContent');
const onlineSetupContent = document.getElementById('onlineSetupContent');
const roomsList = document.getElementById('roomsList');
const onlineRoomPanel = document.getElementById('onlineRoomPanel');
const modalRoot = document.getElementById('modalRoot');

let engine = null;
let uiMode = { type: 'SETUP' };
let pendingWaitTimer = null;
let pendingWaitSeq = 0;
let merchantAnimation = null;
let merchantAnimationFrame = null;
let setupMode = 'local';
let rooms = [];
let roomsLoading = false;
let online = loadOnlineSession();
let onlinePollTimer = null;
let onlineEventSource = null;
let onlineReconnectTimer = null;
let onlineRequestBusy = false;
let lastOnlineError = '';

const DESKTOP_POS = { xMargin: 250, yMargin: 60, step: 100 };
const DESKTOP_LEFT_PANEL = { x: -115, width: 230 };
const MOBILE_POS = { xMargin: 30, yMargin: 210, step: 60 };
const MOBILE_LEFT_PANEL = { x: 180, width: 170 };
let POS = { ...DESKTOP_POS };
let LEFT_PANEL = { ...DESKTOP_LEFT_PANEL };
let mobileBoardLayout = false;

function applyBoardLayout() {
  const nextMobile = window.matchMedia?.('(max-width: 720px)').matches ?? false;
  POS = { ...(nextMobile ? MOBILE_POS : DESKTOP_POS) };
  LEFT_PANEL = { ...(nextMobile ? MOBILE_LEFT_PANEL : DESKTOP_LEFT_PANEL) };
  mobileBoardLayout = nextMobile;
  svg.setAttribute('viewBox', nextMobile ? '0 0 360 740' : '-130 0 1060 620');
}
function point(node) {
  // The visual map uses the first quadrant: col is x (rightward), row is y (upward).
  return { x: POS.xMargin + (node.col - 1) * POS.step, y: POS.yMargin + (6 - node.row) * POS.step };
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
  return n ? `(${n.col},${n.row})` : nodeId;
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

function showAnnouncement(title, body, { onClose, buttonText = '\u77e5\u9053\u4e86' } = {}) {
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
  btn.textContent = buttonText;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    onClose?.();
  };
  btn.addEventListener('click', close);
  dialog.append(h, p, btn);
  backdrop.appendChild(dialog);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  document.body.appendChild(backdrop);
}

function cancelMerchantAnimation() {
  if (merchantAnimationFrame !== null) cancelAnimationFrame(merchantAnimationFrame);
  merchantAnimationFrame = null;
  merchantAnimation = null;
}

function travellerPosition(nodeIds, progress) {
  const routePoints = (nodeIds || [])
    .map(nodeId => engine?.state.nodes[nodeId])
    .filter(Boolean)
    .map(point);
  if (!routePoints.length) return null;
  if (routePoints.length === 1) return routePoints[0];

  const clamped = Math.max(0, Math.min(1, progress));
  const scaled = clamped * (routePoints.length - 1);
  const segment = Math.min(Math.floor(scaled), routePoints.length - 2);
  const fraction = clamped >= 1 ? 1 : scaled - segment;
  const from = routePoints[segment];
  const to = routePoints[segment + 1];
  return {
    x: from.x + (to.x - from.x) * fraction,
    y: from.y + (to.y - from.y) * fraction,
  };
}

function updateMerchantTravellerMarker() {
  const marker = document.getElementById('merchantTraveller');
  if (!marker || !merchantAnimation) return;
  const position = travellerPosition(merchantAnimation.nodeIds, merchantAnimation.progress);
  if (position) marker.setAttribute('transform', `translate(${position.x} ${position.y})`);
}

function startMerchantCompletionAnimation(merchant, onComplete) {
  cancelMerchantAnimation();
  const nodeIds = [...(merchant.chosenPathNodeIds || [])];
  if (nodeIds.length < 2) {
    onComplete?.();
    return;
  }

  merchantAnimation = {
    merchant: { ...merchant, chosenPathNodeIds: nodeIds },
    nodeIds,
    progress: 0,
  };
  uiMode = { type: 'MERCHANT_ANIMATION' };
  render();

  const duration = Math.min(9000, Math.max(1800, (nodeIds.length - 1) * 780));
  let startedAt = null;
  const advance = timestamp => {
    if (!merchantAnimation) return;
    if (startedAt === null) startedAt = timestamp;
    merchantAnimation.progress = Math.min(1, (timestamp - startedAt) / duration);
    updateMerchantTravellerMarker();
    if (merchantAnimation.progress < 1) {
      merchantAnimationFrame = requestAnimationFrame(advance);
      return;
    }
    merchantAnimationFrame = null;
    merchantAnimation = null;
    onComplete?.();
  };
  merchantAnimationFrame = requestAnimationFrame(advance);
}

function finalScoreLines(rankings) {
  return rankings.map((player, index) => (
    `${index + 1}. ${player.name}\uff1a${player.tollMoney}$ \u00b7 \u9053\u8def ${player.roads} \u00b7 \u6865\u6881 ${player.bridges}`
  )).join('\n');
}

function roundScoreLines(merchant) {
  const feesByPlayer = new Map();
  for (const detail of merchant.tollDetails || []) {
    const entry = feesByPlayer.get(detail.playerId) || { roadFee: 0, bridgeFee: 0 };
    if (detail.kind === 'BRIDGE') entry.bridgeFee += detail.amount;
    else entry.roadFee += detail.amount;
    feesByPlayer.set(detail.playerId, entry);
  }

  return engine.state.playerOrder.map(id => {
    const player = engine.state.players[id];
    const { roadFee = 0, bridgeFee = 0 } = feesByPlayer.get(id) || {};
    const total = roadFee + bridgeFee;
    const detailLines = [];
    if (roadFee) detailLines.push(`\u9053\u8def ${roadFee}$`);
    if (bridgeFee) detailLines.push(`\u6865\u6881 ${bridgeFee}$`);
    return `${player.name}\uff1a+${total}$${detailLines.length ? `\uff08${detailLines.join(' \u00b7 ')}\uff09` : ''}`;
  }).join('\n');
}

function showMerchantSettlement(merchant, onClose) {
  const route = routeLabel(merchant.startNodeId, merchant.endNodeId);
  const length = merchant.chosenPathEdgeIds?.length ?? Math.max(0, (merchant.chosenPathNodeIds?.length || 1) - 1);
  showAnnouncement(
    `${merchantName(merchant)} \u5b8c\u6210\u4ea4\u6613`,
    `${route}\n\u5546\u4eba\u5df2\u6cbf\u5b9e\u9645\u6700\u77ed\u8def\u5f84\u5b8c\u6210\u4ea4\u6613\uff08\u5171 ${length} \u6bb5\uff09\uff0c\u8fc7\u8def\u8d39\u5df2\u7ed3\u7b97\u3002\n\n\u672c\u8f6e\u5f97\u5206\n${roundScoreLines(merchant)}`,
    { onClose, buttonText: '\u7ee7\u7eed\u6e38\u620f' },
  );
}

function showGameResultAnnouncement() {
  if (!engine?.state.result) return;
  const { rankings, winners } = engine.state.result;
  const winnerNames = winners.map(id => engine.state.players[id].name).join('\u3001');
  showAnnouncement(
    '\u6e38\u620f\u7ed3\u675f',
    `\u606d\u559c ${winnerNames} \u83b7\u80dc\uff01\n\n\u6700\u7ec8\u6392\u540d\n${finalScoreLines(rankings)}`,
    { buttonText: '\u67e5\u770b\u5730\u56fe' },
  );
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

function legacySelectableEdges() {
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

function legacySelectableNodes() {
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
  if (mobileBoardLayout) {
    // On phones, keep merchant information above the square map so the board
    // can use the full viewport width instead of being squeezed by sidebars.
    svg.appendChild(el('rect', { x: boxX, y: 12, width: boxW, height: 48, rx: 10, class: 'merchant-info-box' }));
    svg.appendChild(svgMultilineText([
      `${merchantType}\u6cbf\u6700\u77ed\u8def\u5f84\u4ea4\u6613`,
      `\u9053\u8def ${roadFee}$ / \u6bb5 \u00b7 \u6865\u6881 ${bridgeFee}$ / \u5ea7`,
    ], { x: boxCx, y: 30, class: 'merchant-info-text' }, 14));
    svg.appendChild(el('rect', { x: boxX, y: 66, width: boxW, height: 48, rx: 10, class: 'merchant-route-box' }));
    svg.appendChild(svgText('\u5f53\u524d\u5546\u4eba\u8def\u7ebf', { x: boxCx, y: 85, class: 'merchant-route-title' }));
    svg.appendChild(svgText(routeLabel(currentMerchant.startNodeId, currentMerchant.endNodeId), { x: boxCx, y: 104, class: 'merchant-route-text' }));
    svg.appendChild(el('rect', { x: boxX, y: 120, width: boxW, height: 42, rx: 10, class: 'final-route-box' }));
    svg.appendChild(svgText('\u6700\u540e\u4e00\u4e2a\u5927\u5546\u4eba\u56fa\u5b9a\u8def\u7ebf', { x: boxCx, y: 137, class: 'final-route-title' }));
    svg.appendChild(svgText(routeLabel('r6c6', 'r1c1'), { x: boxCx, y: 153, class: 'final-route-text' }));
    return;
  }

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

function logicalToSvg(p) {
  return {
    x: POS.xMargin + (p.x - 1) * POS.step,
    y: POS.yMargin + (6 - p.y) * POS.step,
  };
}

function riverBoundarySegment(nodes, edge) {
  const a = nodes[edge.nodeA];
  const b = nodes[edge.nodeB];
  if (!a || !b) return null;
  if (a.row === b.row) {
    const x = (a.col + b.col) / 2;
    return [logicalToSvg({ x, y: a.row - 0.5 }), logicalToSvg({ x, y: a.row + 0.5 })];
  }
  if (a.col === b.col) {
    const y = (a.row + b.row) / 2;
    return [logicalToSvg({ x: a.col - 0.5, y }), logicalToSvg({ x: a.col + 0.5, y })];
  }
  return null;
}

function pointKey(p) {
  return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
}

function parsePointKey(key) {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

function orderedRiverPoints(nodes, edges) {
  const adjacency = new Map();
  const points = new Map();
  const addPoint = p => {
    const key = pointKey(p);
    if (!adjacency.has(key)) adjacency.set(key, new Set());
    points.set(key, p);
    return key;
  };
  const addSegment = (a, b) => {
    const ak = addPoint(a);
    const bk = addPoint(b);
    adjacency.get(ak).add(bk);
    adjacency.get(bk).add(ak);
  };

  for (const edge of Object.values(edges).filter(e => e.isRiverCrossing)) {
    const segment = riverBoundarySegment(nodes, edge);
    if (segment) addSegment(segment[0], segment[1]);
  }

  if (!adjacency.size) return [];
  const b = mapBounds();
  const isBoundary = key => {
    const p = points.get(key) || parsePointKey(key);
    return Math.abs(p.x - b.left) < 0.1
      || Math.abs(p.x - b.right) < 0.1
      || Math.abs(p.y - b.top) < 0.1
      || Math.abs(p.y - b.bottom) < 0.1;
  };
  const endpoints = [...adjacency.keys()].filter(key => adjacency.get(key).size === 1 && isBoundary(key));
  const startKey = endpoints[0] || [...adjacency.keys()].find(key => adjacency.get(key).size === 1) || [...adjacency.keys()][0];
  const ordered = [];
  let previous = null;
  let current = startKey;
  const usedEdges = new Set();
  while (current) {
    ordered.push(points.get(current) || parsePointKey(current));
    const next = [...adjacency.get(current)].find(key => key !== previous && !usedEdges.has([current, key].sort().join('|')));
    if (!next) break;
    usedEdges.add([current, next].sort().join('|'));
    previous = current;
    current = next;
  }
  return ordered;
}

function sameDirection(a, b, c) {
  const dx1 = Math.sign(b.x - a.x);
  const dy1 = Math.sign(b.y - a.y);
  const dx2 = Math.sign(c.x - b.x);
  const dy2 = Math.sign(c.y - b.y);
  return dx1 === dx2 && dy1 === dy2;
}

function pathFromPoints(points, radius = 22) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const current = points[i];
    const next = points[i + 1];
    if (sameDirection(prev, current, next)) {
      d += ` L ${current.x.toFixed(1)} ${current.y.toFixed(1)}`;
      continue;
    }
    const inLen = Math.hypot(current.x - prev.x, current.y - prev.y) || 1;
    const outLen = Math.hypot(next.x - current.x, next.y - current.y) || 1;
    const cornerRadius = Math.min(radius, inLen / 2, outLen / 2);
    const before = {
      x: current.x - (current.x - prev.x) / inLen * cornerRadius,
      y: current.y - (current.y - prev.y) / inLen * cornerRadius,
    };
    const after = {
      x: current.x + (next.x - current.x) / outLen * cornerRadius,
      y: current.y + (next.y - current.y) / outLen * cornerRadius,
    };
    d += ` L ${before.x.toFixed(1)} ${before.y.toFixed(1)}`;
    d += ` Q ${current.x.toFixed(1)} ${current.y.toFixed(1)}, ${after.x.toFixed(1)} ${after.y.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  return d;
}

function perimeterClockwisePosition(p, b) {
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  if (Math.abs(p.y - b.top) < 0.1) return p.x - b.left;
  if (Math.abs(p.x - b.right) < 0.1) return w + (p.y - b.top);
  if (Math.abs(p.y - b.bottom) < 0.1) return w + h + (b.right - p.x);
  return w + h + w + (b.bottom - p.y);
}

function pointAtPerimeterPosition(t, b) {
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  const total = 2 * (w + h);
  const value = ((t % total) + total) % total;
  if (value <= w) return { x: b.left + value, y: b.top };
  if (value <= w + h) return { x: b.right, y: b.top + value - w };
  if (value <= w + h + w) return { x: b.right - (value - w - h), y: b.bottom };
  return { x: b.left, y: b.bottom - (value - w - h - w) };
}

function perimeterPointsClockwise(from, to, b) {
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  const total = 2 * (w + h);
  let start = perimeterClockwisePosition(from, b);
  let end = perimeterClockwisePosition(to, b);
  if (end <= start) end += total;
  const corners = [w, w + h, w + h + w, total, total + w, total + w + h, total + w + h + w];
  const result = [];
  for (const c of corners) {
    if (c > start + 0.1 && c < end - 0.1) result.push(pointAtPerimeterPosition(c, b));
  }
  result.push(to);
  return result;
}

function perimeterPointsCounterClockwise(from, to, b) {
  // Reverse the clockwise walk from `to` back to `from`. Keep `to` as the
  // final closing point so the polygon reconnects to the river start.
  return perimeterPointsClockwise(to, from, b).slice(0, -1).reverse().concat(to);
}

function pointInPolygon(target, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = ((a.y > target.y) !== (b.y > target.y))
      && (target.x < (b.x - a.x) * (target.y - a.y) / ((b.y - a.y) || 1e-9) + a.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

function drawCellRegionFallback(nodes) {
  for (const n of Object.values(nodes)) {
    const p = point(n);
    svg.appendChild(el('rect', {
      x: p.x - POS.step / 2,
      y: p.y - POS.step / 2,
      width: POS.step,
      height: POS.step,
      class: `region-bg ${n.region === 'CITY' ? 'region-bg-city' : 'region-bg-country'}`,
    }));
  }
}

function drawRegionBackground(nodes, edges) {
  const b = mapBounds();
  const riverPoints = orderedRiverPoints(nodes, edges);
  if (riverPoints.length < 2) {
    drawCellRegionFallback(nodes);
    return;
  }

  svg.appendChild(el('rect', {
    x: b.left,
    y: b.top,
    width: b.right - b.left,
    height: b.bottom - b.top,
    class: 'region-bg region-bg-country',
  }));

  const start = riverPoints[0];
  const end = riverPoints[riverPoints.length - 1];
  const cwClose = perimeterPointsClockwise(end, start, b);
  const ccwClose = perimeterPointsCounterClockwise(end, start, b);
  const cwPolygon = [...riverPoints, ...cwClose];
  const ccwPolygon = [...riverPoints, ...ccwClose];
  const cityProbe = point(nodes.r1c1 || Object.values(nodes).find(n => n.region === 'CITY'));
  const closePoints = pointInPolygon(cityProbe, cwPolygon) ? cwClose : ccwClose;
  const d = `${pathFromPoints(riverPoints)} ${closePoints.map(p => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} Z`;
  svg.appendChild(el('path', { d, class: 'region-bg region-bg-city' }));
}

function drawRiverCurve(nodes, edges) {
  const points = orderedRiverPoints(nodes, edges);
  if (points.length < 2) return;
  const d = pathFromPoints(points);
  svg.appendChild(el('path', { d, class: 'river-curve-bank' }));
  svg.appendChild(el('path', { d, class: 'river-curve' }));
}

function renderBuildLegend() {
  const x = mobileBoardLayout ? 10 : LEFT_PANEL.x;
  const y = mobileBoardLayout ? 12 : 380;
  const w = mobileBoardLayout ? 160 : LEFT_PANEL.width;
  const cx = x + w / 2;
  svg.appendChild(el('rect', { x, y, width: w, height: 150, rx: mobileBoardLayout ? 10 : 14, class: 'map-legend-box' }));
  svg.appendChild(svgText('\u9053\u8def / \u6865\u6881\u56fe\u4f8b', { x: cx, y: y + 28, class: 'map-legend-title' }));

  svg.appendChild(el('line', { x1: x + 28, y1: y + 60, x2: x + 104, y2: y + 60, class: 'map-legend-road' }));
  svg.appendChild(svgText('\u9053\u8def', { x: x + 132, y: y + 66, class: 'map-legend-text' }));

  const bridgePoints = `${x + 66},${y + 84} ${x + 37},${y + 126} ${x + 95},${y + 126}`;
  svg.appendChild(el('polygon', { points: bridgePoints, class: 'map-legend-bridge-outline' }));
  svg.appendChild(el('polygon', { points: bridgePoints, class: 'map-legend-bridge' }));
  svg.appendChild(svgText('\u6865\u6881', { x: x + 132, y: y + 113, class: 'map-legend-text' }));
  svg.appendChild(svgText('\u4fee\u8def\u540e\u9053\u8def\u76d6\u5728\u6865\u4e0a', { x: cx, y: y + 141, class: 'map-legend-note' }));
}

function renderMerchantTraveller() {
  if (!merchantAnimation) return;
  const position = travellerPosition(merchantAnimation.nodeIds, merchantAnimation.progress);
  if (!position) return;
  const group = el('g', {
    id: 'merchantTraveller',
    class: 'merchant-traveller',
    transform: `translate(${position.x} ${position.y})`,
    'aria-label': `${merchantName(merchantAnimation.merchant)} \u6b63\u5728\u6cbf\u6700\u77ed\u8def\u5f84\u4ea4\u6613`,
  });
  group.appendChild(el('circle', { r: 19, class: 'merchant-traveller-halo' }));
  group.appendChild(el('circle', { r: 15, class: 'merchant-traveller-marker' }));
  group.appendChild(svgText('\u5546', { x: 0, y: 1, class: 'merchant-traveller-label' }));
  svg.appendChild(group);
}

function renderDiceDisplay(state) {
  const nonce = state.diceAnimationNonce || 0;
  const mobile = mobileBoardLayout;
  const g = el('g', {
    class: 'dice-panel',
    'data-nonce': nonce,
    transform: mobile ? 'translate(95 556) scale(.5)' : 'translate(790 190)',
  });
  const panelWidth = mobile ? 340 : 125;
  const panelHeight = mobile ? 168 : 205;
  g.appendChild(el('rect', { x: 0, y: 0, width: panelWidth, height: panelHeight, rx: mobile ? 14 : 18, class: 'dice-panel-bg' }));
  g.appendChild(svgText('\u9ab0\u5b50\u70b9\u6570', { x: mobile ? 170 : 62, y: mobile ? 27 : 30, class: 'dice-title' }));

  const die1Class = state.lastDie1 ? 'die-face die-animate' : 'die-face die-empty';
  const die2Class = state.lastDie2 ? 'die-face die-animate' : 'die-face die-empty';
  const dieWidth = mobile ? 100 : 70;
  const dieHeight = mobile ? 82 : 70;
  const dieY = mobile ? 42 : 48;
  const die1X = mobile ? 42 : 28;
  const die2X = mobile ? 198 : 28;
  const labelY = mobile ? 103 : 94;
  const die1 = el('g', { class: die1Class, transform: `translate(${die1X} ${dieY})` });
  die1.appendChild(el('rect', { x: 0, y: 0, width: dieWidth, height: dieHeight, rx: mobile ? 12 : 14 }));
  die1.appendChild(svgText(state.lastDie1 ?? '-', { x: dieWidth / 2, y: mobile ? 43 : 38, class: 'die-number' }));
  die1.appendChild(svgText('\u7b2c\u4e00\u9ab0', { x: dieWidth / 2, y: labelY, class: 'die-label' }));
  g.appendChild(die1);

  const die2 = el('g', { class: die2Class, transform: `translate(${die2X} ${dieY})` });
  die2.appendChild(el('rect', { x: 0, y: 0, width: dieWidth, height: dieHeight, rx: mobile ? 12 : 14 }));
  die2.appendChild(svgText(state.lastDie2 ?? '-', { x: dieWidth / 2, y: mobile ? 43 : 38, class: 'die-number' }));
  die2.appendChild(svgText('\u7b2c\u4e8c\u9ab0', { x: dieWidth / 2, y: labelY, class: 'die-label' }));
  g.appendChild(die2);
  svg.appendChild(g);
}

function renderBoard() {
  applyBoardLayout();
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

  const displayedMerchant = merchantAnimation?.merchant || currentMerchant;
  renderMerchantOverlay(nodes, displayedMerchant);
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
    if (displayedMerchant?.startNodeId === n.id) classes.push('merchant-start');
    if (displayedMerchant?.endNodeId === n.id) classes.push('merchant-end');

    const circle = el('circle', { cx: p.x, cy: p.y, r: 22, class: classes.join(' ') });
    circle.addEventListener('click', () => onNodeClick(n.id));
    svg.appendChild(circle);
    svg.appendChild(svgText(n.diceNumber, { x: p.x, y: p.y + 1, class: 'node-label' }));
    svg.appendChild(svgText(`(${n.col},${n.row}) ${regionName(n.region)}`, { x: p.x, y: p.y + 35, class: 'node-coord' }));
  }
  renderDiceDisplay(engine.state);
  renderMerchantTraveller();
}

function legacyRenderStatus() {
  if (!engine) {
    phaseBadge.textContent = '未开始';
    statusPanel.innerHTML = '<p class="small">请创建游戏。</p>';
    boardHint.textContent = '创建游戏后开始。';
    return;
  }
  const s = engine.state;
  phaseBadge.textContent = s.phase === PHASE.PRE_BUILD ? '开局预建设' : s.phase === PHASE.PLAYER_TURN ? '正式回合' : '游戏结束';
  const currentName = s.phase === PHASE.PRE_BUILD ? s.players[engine.preBuildPlayerId]?.name : s.players[engine.currentPlayerId]?.name;
  const merchant = merchantAnimation?.merchant || s.currentMerchant;
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
  boardHint.classList.toggle('waiting-hint', uiMode.type === 'WAITING_MESSAGE' || uiMode.type === 'MERCHANT_ANIMATION');
}


function hintText() {
  if (!engine) return '创建游戏后开始。';
  if (uiMode.type === 'MERCHANT_ANIMATION') return '\u5546\u4eba\u6b63\u5728\u6cbf\u5b9e\u9645\u6700\u77ed\u8def\u5f84\u4ea4\u6613\uff0c\u8bf7\u7a0d\u5019\u3002';
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
    MERCHANT_ANIMATION: '\u5546\u4eba\u6b63\u5728\u6cbf\u5b9e\u9645\u6700\u77ed\u8def\u5f84\u4ea4\u6613\uff0c\u8bf7\u7a0d\u5019\u3002',
  };
  return map[uiMode.type] || '请选择操作。';
}

function renderPlayers() {
  if (!engine) {
    playersPanel.innerHTML = '<p class="small">暂无玩家。</p>';
    return;
  }
  const s = engine.state;
  const onlineSeatByPlayerId = new Map();
  if (isOnline()) {
    (online.room?.seats || []).forEach((seat, index) => {
      onlineSeatByPlayerId.set(`P${index + 1}`, seat);
    });
  }
  playersPanel.innerHTML = s.playerOrder.map(id => {
    const p = s.players[id];
    const current = (s.phase === PHASE.PRE_BUILD && engine.preBuildPlayerId === id) || (s.phase === PHASE.PLAYER_TURN && engine.currentPlayerId === id);
    const seat = onlineSeatByPlayerId.get(id);
    const onlineBadge = seat
      ? `<em class="player-connection ${seat.connected ? 'online' : 'offline'}">${seat.connected ? '在线' : '离线'}</em>`
      : '';
    return `<div class="player-row ${current ? 'current-player' : ''}">
      <span class="player-name"><i class="color-dot" style="background:${p.color}"></i>${htmlEscape(p.name)}${onlineBadge}</span>
      <span>${p.tollMoney}$ · 路 ${engine.getPlayerRoadCount(id)} · 桥 ${engine.getPlayerBridgeCount(id)}</span>
    </div>`;
  }).join('');
}

function legacyRenderActions() {
  if (!engine) {
    actionPanel.innerHTML = '<p class="small">创建游戏后显示可用操作。</p>';
    return;
  }
  const s = engine.state;
  if (s.phase === PHASE.PRE_BUILD) {
    actionPanel.innerHTML = `<p>请在地图上点击高亮边，为 <b>${htmlEscape(s.players[engine.preBuildPlayerId].name)}</b> 修建一条初始道路。</p>`;
    return;
  }
  if (uiMode.type === 'MERCHANT_ANIMATION') {
    actionPanel.innerHTML = `<p class="waiting-message">${htmlEscape(hintText())}</p>`;
    return;
  }

  if (s.phase === PHASE.GAME_END) {
    const rows = s.result.rankings.map((p, i) => `<div class="player-row"><b>#${i + 1} ${htmlEscape(p.name)}</b><span>${p.tollMoney}$ \u00b7 \u8def ${p.roads} \u00b7 \u6865 ${p.bridges}</span></div>`).join('');
    actionPanel.innerHTML = `<p>\u7b2c 5 \u4f4d\u5546\u4eba\u5df2\u5b8c\u6210\u4ea4\u6613\u3002</p>${rows}`;
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

function legacyRender() {
  document.body.classList.toggle('is-setup', !engine);
  renderBoard();
  renderStatus();
  renderPlayers();
  renderActions();
  renderLog();
}

function legacyOnNodeClick(nodeId) {
  if (!engine || uiMode.type === 'MERCHANT_ANIMATION') return;
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

function legacyOnEdgeClick(edgeIdValue) {
  if (!engine || uiMode.type === 'MERCHANT_ANIMATION') return;
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

function legacyProcessDrawCardAndMaybeFinish() {
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

function legacyFinishTurn() {
  clearPendingWait();
  const previousMerchantIndex = engine.state.currentMerchant?.index;
  const completedCount = engine.state.completedMerchants.length;
  engine.finishActionAndAdvance();

  const completedMerchant = engine.state.completedMerchants.length > completedCount
    ? engine.state.completedMerchants.at(-1)
    : null;
  const gameEnded = engine.state.phase === PHASE.GAME_END;
  const shouldAnnounceBigMerchant = engine.state.currentMerchant?.type === 'BIG' && previousMerchantIndex !== engine.state.currentMerchant?.index;

  if (completedMerchant) {
    startMerchantCompletionAnimation(completedMerchant, () => {
      uiMode = { type: gameEnded ? 'GAME_END' : 'IDLE' };
      render();
      showMerchantSettlement(completedMerchant, () => {
        if (gameEnded) showGameResultAnnouncement();
        else if (shouldAnnounceBigMerchant) showAnnouncement('\u5927\u5546\u4eba\u524d\u6765\u4ea4\u6613', '\u57ce\u4e61\u57fa\u5efa\u8fdb\u5165\u51b2\u523a\u9636\u6bb5');
      });
    });
    return;
  }

  uiMode = { type: gameEnded ? 'GAME_END' : 'IDLE' };
  render();
  if (shouldAnnounceBigMerchant) {
    showAnnouncement('\u5927\u5546\u4eba\u524d\u6765\u4ea4\u6613', '\u57ce\u4e61\u57fa\u5efa\u8fdb\u5165\u51b2\u523a\u9636\u6bb5');
  }
}

function isOnline() { return Boolean(online?.room); }
function onlineViewer() { return online?.room?.viewer || null; }
function isOnlineActionTurn() {
  if (!isOnline() || !engine) return false;
  const viewer = onlineViewer();
  if (!viewer || viewer.spectator || viewer.playerIndex === null) return false;
  const expected = engine.state.phase === PHASE.PRE_BUILD
    ? engine.state.preBuildIndex
    : engine.state.currentPlayerIndex;
  return expected === viewer.playerIndex && engine.state.phase !== PHASE.GAME_END;
}
function isInteractiveUiMode(type = uiMode.type) {
  return new Set([
    'IDLE', 'CHOOSE_ACTION', 'SELECT_BASE_ROAD', 'SELECT_EDGE_ROAD',
    'SELECT_BASE_SECOND', 'SELECT_EDGE_SECOND',
    'CARD_SELECT_BRIDGE_TO_ROAD', 'CARD_SELECT_ROAD_TO_REMOVE', 'CARD_SELECT_BRIDGE_EDGE',
  ]).has(type);
}
function canInteract() {
  return Boolean(engine)
    && (!isOnline() || (online.connected && isOnlineActionTurn()))
    && !onlineRequestBusy;
}
function loadOnlineSession() {
  try {
    const saved = JSON.parse(localStorage.getItem('infrastrationOnlineSession') || 'null');
    if (!saved?.roomId || !saved?.clientToken) return null;
    return { roomId: saved.roomId, clientToken: saved.clientToken, room: null, connected: false };
  } catch {
    return null;
  }
}
function saveOnlineSession() {
  if (!online?.roomId || !online?.clientToken) return;
  localStorage.setItem('infrastrationOnlineSession', JSON.stringify({
    roomId: online.roomId,
    clientToken: online.clientToken,
  }));
}
function stopOnlineTransport() {
  onlineEventSource?.close?.();
  onlineEventSource = null;
  if (onlinePollTimer) clearInterval(onlinePollTimer);
  onlinePollTimer = null;
  if (onlineReconnectTimer) clearTimeout(onlineReconnectTimer);
  onlineReconnectTimer = null;
}
function clearOnlineSession({ keepError = false } = {}) {
  stopOnlineTransport();
  online = null;
  engine = null;
  uiMode = { type: 'SETUP' };
  localStorage.removeItem('infrastrationOnlineSession');
  if (!keepError) lastOnlineError = '';
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
  return data;
}
function pendingJoinToken(roomId) {
  const key = `infrastrationPendingJoin:${roomId}`;
  let token = sessionStorage.getItem(key);
  if (!token) {
    const seed = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 16)
      || Math.random().toString(36).slice(2, 18);
    token = `C${seed.toUpperCase()}`;
    sessionStorage.setItem(key, token);
  }
  return token;
}
async function refreshRooms() {
  if (!roomsList) return;
  roomsLoading = true;
  renderSetupMode();
  try {
    rooms = (await api('/api/rooms')).rooms || [];
    lastOnlineError = '';
  } catch (error) {
    rooms = [];
    lastOnlineError = `${error.message}。请先运行 npm run serve。`;
  } finally {
    roomsLoading = false;
    renderSetupMode();
  }
}
async function createOnlineRoom(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const data = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        roomName: form.get('roomName'),
        playerName: form.get('playerName'),
        playerCount: Number(form.get('playerCount')),
      }),
    });
    online = { roomId: data.room.id, clientToken: data.clientToken, room: null, connected: false };
    saveOnlineSession();
    applyOnlineRoom(data.room);
    connectRoomEvents();
  } catch (error) {
    lastOnlineError = error.message;
    render();
  } finally {
    if (submit) submit.disabled = false;
  }
}
async function joinOnlineRoom(roomId, spectator = false) {
  const name = prompt(spectator ? '请输入观战名称' : '请输入玩家名称', spectator ? '观战者' : '玩家');
  if (name === null) return;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      body: JSON.stringify({
        playerName: name,
        spectator,
        clientToken: spectator ? undefined : pendingJoinToken(roomId),
      }),
    });
    online = { roomId: data.room.id, clientToken: data.clientToken, room: null, connected: false };
    saveOnlineSession();
    applyOnlineRoom(data.room);
    connectRoomEvents();
  } catch (error) {
    lastOnlineError = error.message;
    render();
    refreshRooms();
  }
}
function startRoomPolling() {
  if (onlinePollTimer || !online?.roomId || !online?.clientToken) return;
  onlinePollTimer = setInterval(async () => {
    if (!online?.roomId || !online?.clientToken) return;
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(online.roomId)}?clientToken=${encodeURIComponent(online.clientToken)}`);
      applyOnlineRoom(data.room);
    } catch (error) {
      lastOnlineError = error.message;
      render();
    }
  }, 3000);
}
function scheduleRoomEventsReconnect() {
  if (onlineReconnectTimer || !online?.roomId) return;
  onlineReconnectTimer = setTimeout(() => {
    onlineReconnectTimer = null;
    connectRoomEvents();
  }, 5000);
}
function connectRoomEvents() {
  if (!online?.roomId || !online?.clientToken || onlineEventSource) return;
  const source = new EventSource(`/api/rooms/${encodeURIComponent(online.roomId)}/events?clientToken=${encodeURIComponent(online.clientToken)}`);
  onlineEventSource = source;
  source.onopen = () => {
    if (onlineEventSource !== source) return;
    if (online) online.connected = true;
    if (onlinePollTimer) clearInterval(onlinePollTimer);
    onlinePollTimer = null;
    lastOnlineError = '';
    render();
  };
  source.addEventListener('room', event => {
    try {
      applyOnlineRoom(JSON.parse(event.data));
    } catch (error) {
      lastOnlineError = error.message;
      render();
    }
  });
  source.onerror = () => {
    if (onlineEventSource === source) onlineEventSource = null;
    source.close();
    if (!online) return;
    online.connected = false;
    startRoomPolling();
    scheduleRoomEventsReconnect();
    render();
  };
}
async function reconnectOnlineSession() {
  if (!online?.roomId || !online?.clientToken) return;
  setupMode = 'online';
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(online.roomId)}?clientToken=${encodeURIComponent(online.clientToken)}`);
    applyOnlineRoom(data.room);
    connectRoomEvents();
  } catch (error) {
    clearOnlineSession({ keepError: true });
    lastOnlineError = `线上会话已断开：${error.message}`;
    render();
  }
}
async function sendOnlineAction(type, payload = {}) {
  if (!online?.roomId || !online?.clientToken || onlineRequestBusy) return null;
  onlineRequestBusy = true;
  render();
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(online.roomId)}/actions`, {
      method: 'POST',
      body: JSON.stringify({ clientToken: online.clientToken, type, payload }),
    });
    applyOnlineRoom(data.room);
    return data.result || { type };
  } catch (error) {
    lastOnlineError = error.message;
    render();
    return null;
  } finally {
    onlineRequestBusy = false;
    render();
  }
}

// ---------------------------------------------------------------------------
// Formal edition client integration: lobby, online room controls, reference
// modals and the server-authoritative online turn flow.
// ---------------------------------------------------------------------------
function onlinePhaseLabel(status) {
  return ({ waiting: '等待开局', playing: '游戏进行中', game_over: '游戏已结束' })[status] || status || '未知状态';
}

function restoreOnlinePendingCardMode() {
  if (!engine?.state.pendingCard) return;
  const card = engine.state.pendingCard;
  const options = engine.state.pendingCardOptions || {};
  const playerId = engine.currentPlayerId;
  if (card === CARD.BRIDGE_TO_ROAD) {
    uiMode = {
      type: 'CARD_SELECT_BRIDGE_TO_ROAD',
      card,
      candidates: engine.getOwnBridgesWithoutRoad(playerId).map(edge => edge.id),
    };
    return;
  }
  if (card === CARD.REMOVE_ROAD_BUILD_BRIDGE) {
    const roadCandidates = engine.getRoadEdgesOf(playerId).map(edge => edge.id);
    const bridgeCandidates = engine.getBuildableBridgeEdges(playerId).map(edge => edge.id);
    uiMode = options.selectedRoadToRemove
      ? {
        type: 'CARD_SELECT_BRIDGE_EDGE',
        card,
        roadCandidates,
        bridgeCandidates,
        selectedRoadToRemove: options.selectedRoadToRemove,
      }
      : { type: 'CARD_SELECT_ROAD_TO_REMOVE', card, roadCandidates, bridgeCandidates };
    return;
  }
  // The other cards resolve immediately. This fallback protects the renderer
  // from an old or malformed snapshot without mutating server state.
  uiMode = { type: 'IDLE' };
}

function deriveOnlineUiMode(room) {
  if (!engine || !room) return { type: 'SETUP' };
  if (engine.state.phase === PHASE.GAME_END) return { type: 'GAME_END' };
  if (!isOnlineActionTurn()) return { type: 'IDLE' };
  if (engine.state.phase === PHASE.PRE_BUILD) return { type: 'IDLE' };
  if (engine.state.pendingCard) {
    restoreOnlinePendingCardMode();
    return uiMode;
  }
  if (engine.state.lastDie1 === null) return { type: 'IDLE' };
  if (engine.state.lastDie2 === null) {
    return room.turnActionCommitted ? { type: 'IDLE' } : { type: 'CHOOSE_ACTION' };
  }
  if (room.secondDieResolved) {
    return engine.state.lastDie2 === engine.state.lastDie1 && !room.turnActionCommitted
      ? { type: 'CHOOSE_ACTION' }
      : { type: 'IDLE' };
  }
  const baseNodeId = room.secondDieBaseNodeId;
  const candidates = baseNodeId
    ? engine.getBuildableSecondDieTargets(engine.currentPlayerId, baseNodeId, engine.state.lastDie2)
    : [];
  return candidates.length
    ? { type: 'SELECT_EDGE_SECOND', baseNodeId, candidateNodeIds: candidates }
    : { type: 'IDLE' };
}

// Reconcile a room snapshot after REST, SSE or reconnect. The server remains
// authoritative; this engine instance is only a read model for rendering and
// local hit testing.
function applyOnlineRoom(room, { renderNow = true } = {}) {
  if (!online || !room) return;
  if (room.viewer === null) {
    clearOnlineSession({ keepError: true });
    lastOnlineError = '你已离开或被移出该房间。';
    if (renderNow) render();
    return;
  }
  const previousRoom = online.room;
  const previousPhase = previousRoom?.game?.phase;
  const previousIndex = previousRoom?.game
    ? (previousRoom.game.phase === PHASE.PRE_BUILD
      ? previousRoom.game.preBuildIndex
      : previousRoom.game.currentPlayerIndex)
    : null;
  online.room = room;
  online.connected = true;
  setupMode = 'online';
  engine = room.game ? GameEngine.fromState(room.game) : null;
  if (engine && (previousPhase !== engine.state.phase || previousIndex !== (engine.state.phase === PHASE.PRE_BUILD ? engine.state.preBuildIndex : engine.state.currentPlayerIndex))) {
    clearPendingWait();
  }
  if (!engine) {
    uiMode = { type: 'SETUP' };
  } else if (engine.state.pendingCard && isOnlineActionTurn()) {
    restoreOnlinePendingCardMode();
  } else {
    uiMode = deriveOnlineUiMode(room);
  }
  lastOnlineError = '';
  if (renderNow) render();
}

function renderSetupMode() {
  if (!localSetupContent || !onlineSetupContent) return;
  const onlineMode = setupMode === 'online';
  localSetupContent.classList.toggle('hidden', onlineMode);
  onlineSetupContent.classList.toggle('hidden', !onlineMode);
  localModeBtn?.classList.toggle('active', !onlineMode);
  onlineModeBtn?.classList.toggle('active', onlineMode);
  if (!roomsList || !onlineMode) return;
  if (roomsLoading) {
    roomsList.innerHTML = '<p class="small">正在刷新房间列表……</p>';
    return;
  }
  const roomItems = rooms.length
    ? rooms.map(room => {
      const full = room.occupied >= room.playerCount;
      const canJoin = room.status === 'waiting' && !full;
      const action = canJoin
        ? `<button type="button" data-room-action="join" data-room-id="${htmlEscape(room.id)}">加入</button>`
        : room.status === 'waiting'
          ? '<button type="button" disabled>已满</button>'
          : `<button type="button" data-room-action="spectate" data-room-id="${htmlEscape(room.id)}">观战</button>`;
      const connectedCount = (room.seats || []).filter(seat => seat.occupied && seat.connected).length;
      return `<div class="room-item">
        <div><b>${htmlEscape(room.name)}</b><p>${htmlEscape(room.id)} · ${onlinePhaseLabel(room.status)} · ${room.occupied}/${room.playerCount} 人 · 在线 ${connectedCount}</p></div>
        ${action}
      </div>`;
    }).join('')
    : '<p class="small">暂无可加入的房间。你可以创建一个新房间。</p>';
  const errorItem = lastOnlineError ? `<div class="online-error">${htmlEscape(lastOnlineError)}</div>` : '';
  roomsList.innerHTML = roomItems + errorItem;
}

function renderOnlineRoomPanel() {
  if (!onlineRoomPanel) return;
  const room = online?.room;
  if (!room || !room.viewer) {
    onlineRoomPanel.classList.add('hidden');
    onlineRoomPanel.classList.remove('online-room-chat-only');
    onlineRoomPanel.innerHTML = '';
    return;
  }
  onlineRoomPanel.classList.remove('hidden');
  const viewer = room.viewer;
  const seats = room.seats || [];
  const connectedLabel = online.connected ? '在线同步' : '正在重连（可继续查看最近状态）';
  const chatHtml = (room.chat || []).map(item => `<p><b>${htmlEscape(item.sender)}：</b>${htmlEscape(item.message)}</p>`).join('') || '<p class="small">还没有聊天消息。</p>';
  const chatPanel = `<div class="online-chat"><h3>房间聊天</h3><div class="chat-messages" id="onlineChatMessages">${chatHtml}</div>
    <form id="onlineChatForm"><input name="message" maxlength="300" autocomplete="off" placeholder="输入消息……" /><button class="primary" type="submit">发送</button></form>
  </div>`;

  if (room.status !== 'waiting') {
    onlineRoomPanel.classList.add('online-room-chat-only');
    onlineRoomPanel.innerHTML = chatPanel;
  } else {
    onlineRoomPanel.classList.remove('online-room-chat-only');
    const seatHtml = seats.map(seat => {
      const status = seat.occupied
        ? `${seat.connected ? '在线' : '离线'} · ${seat.ready ? '已准备' : '未准备'}`
        : '空座位';
      const kick = viewer.isHost && seat.occupied && !seat.isHost
        ? `<button type="button" class="mini-button danger" data-kick-index="${seat.index}">移出</button>`
        : '';
      return `<div class="online-seat ${seat.occupied ? 'occupied' : ''}">
        <span><b>${seat.occupied ? htmlEscape(seat.name) : `座位 ${seat.index + 1}`}</b><small>${status}</small></span>
        ${seat.isHost && seat.occupied ? '<strong title="房主">房主</strong>' : kick}
      </div>`;
    }).join('');
    const roomActions = `<div class="online-room-actions">
        ${!viewer.spectator && !viewer.isHost ? `<button id="onlineReadyBtn" class="${viewer.ready ? '' : 'primary'}" type="button">${viewer.ready ? '取消准备' : '准备'}</button>` : ''}
        ${viewer.isHost ? '<button id="onlineStartBtn" class="primary" type="button">开始游戏</button>' : ''}
        <button id="onlineLeaveBtn" type="button">离开房间</button>
      </div>`;
    onlineRoomPanel.innerHTML = `<div class="online-room-head">
      <div><h2>${htmlEscape(room.name)}</h2><div class="small">房间号 <code>${htmlEscape(room.id)}</code> · ${onlinePhaseLabel(room.status)}</div></div>
      <div class="small">${connectedLabel}</div>
    </div>
    <div class="online-seats">${seatHtml}</div>
    <div class="online-game-state">房间坐满后，所有非房主玩家准备，房主即可开始。</div>
    ${roomActions}
    ${chatPanel}`;
  }

  document.getElementById('onlineReadyBtn')?.addEventListener('click', () => setOnlineReady(!viewer.ready));
  document.getElementById('onlineStartBtn')?.addEventListener('click', () => startOnlineRoom());
  document.getElementById('onlineLeaveBtn')?.addEventListener('click', () => leaveOnlineRoom());
  onlineRoomPanel.querySelectorAll('[data-kick-index]').forEach(button => {
    button.addEventListener('click', () => kickOnlinePlayer(Number(button.dataset.kickIndex)));
  });
  document.getElementById('onlineChatForm')?.addEventListener('submit', sendChatMessage);
  const chatMessages = document.getElementById('onlineChatMessages');
  if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function setOnlineReady(ready) {
  if (!online?.roomId || !online?.clientToken) return;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(online.roomId)}/ready`, {
      method: 'POST',
      body: JSON.stringify({ clientToken: online.clientToken, ready }),
    });
    applyOnlineRoom(data.room);
  } catch (error) {
    lastOnlineError = error.message;
    render();
  }
}

async function startOnlineRoom() {
  if (!online?.roomId || !online?.clientToken) return;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(online.roomId)}/start`, {
      method: 'POST',
      body: JSON.stringify({ clientToken: online.clientToken }),
    });
    applyOnlineRoom(data.room);
    connectRoomEvents();
  } catch (error) {
    lastOnlineError = error.message;
    render();
  }
}

async function kickOnlinePlayer(playerIndex) {
  if (!online?.roomId || !online?.clientToken) return;
  const seat = online.room?.seats?.[playerIndex];
  if (!seat || !window.confirm(`确定要将 ${seat.name || `座位 ${playerIndex + 1}`} 移出房间吗？`)) return;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(online.roomId)}/kick`, {
      method: 'POST',
      body: JSON.stringify({ clientToken: online.clientToken, playerIndex }),
    });
    applyOnlineRoom(data.room);
  } catch (error) {
    lastOnlineError = error.message;
    render();
  }
}

async function sendChatMessage(event) {
  event.preventDefault();
  if (!online?.roomId || !online?.clientToken) return;
  const form = event.currentTarget;
  const input = form.elements.message;
  const message = String(input?.value || '').trim();
  if (!message) return;
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(online.roomId)}/chat`, {
      method: 'POST',
      body: JSON.stringify({ clientToken: online.clientToken, message }),
    });
    applyOnlineRoom(data.room);
  } catch (error) {
    lastOnlineError = error.message;
    render();
  } finally {
    if (button) button.disabled = false;
  }
}

async function leaveOnlineRoom() {
  const current = online;
  if (!current?.roomId || !current?.clientToken) {
    clearOnlineSession();
    render();
    return;
  }
  try {
    await api(`/api/rooms/${encodeURIComponent(current.roomId)}/leave`, {
      method: 'POST',
      body: JSON.stringify({ clientToken: current.clientToken }),
    });
  } catch {
    // A closed/expired room is already equivalent to leaving from the UI.
  }
  clearOnlineSession();
  setupMode = 'online';
  render();
  refreshRooms();
}

function openReferenceModal(title, bodyHtml) {
  if (!modalRoot) return;
  modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-backdrop><div class="modal-dialog" role="dialog" aria-modal="true" aria-label="${htmlEscape(title)}">
    <div class="modal-head"><h2>${htmlEscape(title)}</h2><button class="modal-close" type="button" aria-label="关闭">×</button></div>${bodyHtml}
  </div></div>`;
  const backdrop = modalRoot.querySelector('[data-modal-backdrop]');
  const close = () => { modalRoot.innerHTML = ''; };
  modalRoot.querySelector('.modal-close')?.addEventListener('click', close);
  backdrop?.addEventListener('click', event => { if (event.target === backdrop) close(); });
}

function renderRulesModal() {
  const body = `<div class="rules-list">${RULE_SECTIONS.map(section => `<section class="rule-section"><h3>${htmlEscape(section.title)}</h3><p>${htmlEscape(section.body)}</p></section>`).join('')}</div>`;
  openReferenceModal('规则介绍', body);
}

function renderCardCatalogModal() {
  const body = `<div class="catalog-grid">${CARD_CATALOG.map(card => `<article class="catalog-card tone-${htmlEscape(card.tone)}">
    <div class="catalog-card-head"><span class="catalog-icon">${card.icon}</span><h3>${htmlEscape(card.name)}</h3></div>
    <span class="catalog-tag">${htmlEscape(card.tag)}</span>
    <p>${htmlEscape(card.description)}</p>
    <div class="catalog-meta"><span>抽取权重：${htmlEscape(card.probability)}</span><span>效果：${htmlEscape(card.effect)}</span></div>
  </article>`).join('')}</div>`;
  openReferenceModal('卡牌图鉴', body);
}

function localResetToSetup() {
  cancelMerchantAnimation();
  clearPendingWait();
  if (online?.roomId) {
    const current = online;
    api(`/api/rooms/${encodeURIComponent(current.roomId)}/leave`, {
      method: 'POST',
      body: JSON.stringify({ clientToken: current.clientToken }),
    }).catch(() => {});
  }
  clearOnlineSession();
  setupMode = 'local';
  engine = null;
  uiMode = { type: 'SETUP' };
  render();
}

function updateOnlineWaitMode(message, afterWait, delayMs = 900) {
  beginWaitingMessage(message, afterWait, delayMs);
}

function onlineTurnFinishedAnnouncement(previousCompletedCount, previousMerchantIndex) {
  if (!engine) return;
  const completedMerchant = engine.state.completedMerchants.length > previousCompletedCount
    ? engine.state.completedMerchants.at(-1)
    : null;
  const gameEnded = engine.state.phase === PHASE.GAME_END;
  const shouldAnnounceBigMerchant = engine.state.currentMerchant?.type === 'BIG' && previousMerchantIndex !== engine.state.currentMerchant?.index;
  return { completedMerchant, gameEnded, shouldAnnounceBigMerchant };
}

function selectableEdges() {
  if (!engine) return new Set();
  if (isOnline() && !isOnlineActionTurn()) return new Set();
  const s = engine.state;
  if (s.phase === PHASE.PRE_BUILD) return new Set(engine.getBuildableRoadEdges(engine.preBuildPlayerId).map(e => e.id));
  if (uiMode.type === 'SELECT_EDGE_ROAD') return new Set(engine.getBuildableRoadEdgesFromBase(engine.currentPlayerId, uiMode.baseNodeId).map(e => e.id));
  if (uiMode.type === 'SELECT_EDGE_SECOND') return new Set((uiMode.candidateNodeIds || []).map(id => edgeId(uiMode.baseNodeId, id)));
  if (uiMode.type === 'CARD_SELECT_BRIDGE_TO_ROAD') return new Set(uiMode.candidates || []);
  if (uiMode.type === 'CARD_SELECT_ROAD_TO_REMOVE') return new Set(uiMode.roadCandidates || []);
  if (uiMode.type === 'CARD_SELECT_BRIDGE_EDGE') return new Set(uiMode.bridgeCandidates || []);
  return new Set();
}

function selectableNodes() {
  if (!engine || (isOnline() && !isOnlineActionTurn())) return new Set();
  if (uiMode.type === 'CHOOSE_ACTION' || uiMode.type === 'SELECT_BASE_ROAD' || uiMode.type === 'SELECT_BASE_SECOND') {
    return new Set(engine.getBuildableBaseNodesForDie1(engine.currentPlayerId));
  }
  if (uiMode.type === 'SELECT_EDGE_SECOND') return new Set(uiMode.candidateNodeIds || []);
  return new Set();
}

function renderStatus() {
  if (!engine) {
    phaseBadge.textContent = '未开始';
    statusPanel.innerHTML = online?.room
      ? `<p class="small">${onlinePhaseLabel(online.room.status)}。请在房间面板查看座位、聊天和控制。</p>`
      : '<p class="small">请创建游戏。</p>';
    boardHint.textContent = online?.room ? '线上房间尚未开始游戏。' : '创建游戏后开始。';
    return;
  }
  const s = engine.state;
  phaseBadge.textContent = s.phase === PHASE.PRE_BUILD ? '开局预建设' : s.phase === PHASE.PLAYER_TURN ? '正式回合' : '游戏结束';
  const currentName = s.phase === PHASE.PRE_BUILD ? s.players[engine.preBuildPlayerId]?.name : s.players[engine.currentPlayerId]?.name;
  const merchant = merchantAnimation?.merchant || s.currentMerchant;
  const lines = [
    `<div class="kv-row"><span>当前阶段</span><b>${phaseBadge.textContent}</b></div>`,
    `<div class="kv-row"><span>当前玩家</span><b>${htmlEscape(currentName || '-')}</b></div>`,
    `<div class="kv-row"><span>回合编号</span><b>${s.turnNumber || '-'}</b></div>`,
    `<div class="kv-row"><span>第一骰</span><b>${s.lastDie1 ?? '-'}</b></div>`,
    `<div class="kv-row"><span>第二骰</span><b>${s.lastDie2 ?? '-'}</b></div>`,
  ];
  if (isOnline()) lines.push(`<div class="kv-row"><span>连接状态</span><b>${online.connected ? '已连接' : '重连中'}</b></div>`);
  if (merchant) lines.push(`<div class="merchant-box"><span>${merchantName(merchant)}</span><b>${coordLabel(merchant.startNodeId)} → ${coordLabel(merchant.endNodeId)}</b></div>`);
  if (s.result) lines.push(`<p><b>获胜者：</b>${s.result.winners.map(id => htmlEscape(s.players[id].name)).join('、')}</p>`);
  statusPanel.innerHTML = lines.join('');
  boardHint.textContent = hintText();
  boardHint.classList.toggle('waiting-hint', uiMode.type === 'WAITING_MESSAGE' || uiMode.type === 'MERCHANT_ANIMATION');
}

function renderActions() {
  if (!engine) {
    actionPanel.innerHTML = online?.room
      ? '<p class="small">等待房主开始游戏。开始后，服务器会把每一步同步给所有房间成员。</p>'
      : '<p class="small">创建游戏后显示可用操作。</p>';
    return;
  }
  const s = engine.state;
  const room = online?.room;
  if (s.phase === PHASE.GAME_END) {
    const rows = s.result?.rankings?.map((p, i) => `<div class="player-row"><b>#${i + 1} ${htmlEscape(p.name)}</b><span>${p.tollMoney}$ · 路 ${p.roads} · 桥 ${p.bridges}</span></div>`).join('') || '';
    actionPanel.innerHTML = `<p>${MERCHANT_COUNT} 位商人已完成交易。</p>${rows}`;
    return;
  }
  if (isOnline() && !isOnlineActionTurn()) {
    const viewer = onlineViewer();
    const currentId = s.phase === PHASE.PRE_BUILD ? engine.preBuildPlayerId : engine.currentPlayerId;
    const current = s.players[currentId]?.name || '其他玩家';
    actionPanel.innerHTML = `<p class="waiting-message">${viewer?.spectator ? '你正在观战。' : `请等待 ${htmlEscape(current)} 操作。`}</p>`;
    return;
  }
  if (uiMode.type === 'MERCHANT_ANIMATION') {
    actionPanel.innerHTML = `<p class="waiting-message">${htmlEscape(hintText())}</p>`;
    return;
  }
  if (s.phase === PHASE.PRE_BUILD) {
    actionPanel.innerHTML = `<p>请在地图中点击高亮边，为 <b>${htmlEscape(s.players[engine.preBuildPlayerId].name)}</b> 建设初始道路。</p>`;
    return;
  }
  if (s.pendingCard || uiMode.type.startsWith('CARD_')) {
    actionPanel.innerHTML = `<p><b>${htmlEscape(cardName(s.pendingCard || uiMode.card))}</b></p><p>${htmlEscape(hintText())}</p>`;
    return;
  }
  if (room?.turnActionCommitted) {
    actionPanel.innerHTML = '<p>本回合建设已完成。</p><button id="finishTurnBtn" class="primary">结束回合</button>';
    document.getElementById('finishTurnBtn').addEventListener('click', () => finishTurn());
    return;
  }
  if (s.lastDie1 === null) {
    actionPanel.innerHTML = '<button id="startTurnBtn" class="primary">掷第一骰 / 开始回合</button>';
    document.getElementById('startTurnBtn').addEventListener('click', () => {
      clearPendingWait();
      if (isOnline()) {
        sendOnlineAction('startTurn').then(result => { if (result) { uiMode = { type: 'CHOOSE_ACTION' }; render(); } });
      } else {
        engine.startTurn();
        uiMode = { type: 'CHOOSE_ACTION' };
        render();
      }
    });
    return;
  }
  if (s.lastDie2 !== null && room?.secondDieResolved && s.lastDie2 === s.lastDie1) {
    actionPanel.innerHTML = `<p>第一骰 ${s.lastDie1} 与第二骰 ${s.lastDie2} 相同，获得一次建设卡机会。</p><button id="drawCardBtn" class="primary">抽建设卡</button>`;
    document.getElementById('drawCardBtn').addEventListener('click', processDrawCardAndMaybeFinish);
    return;
  }
  if (uiMode.type === 'WAITING_MESSAGE') {
    actionPanel.innerHTML = `<p class="waiting-message">${htmlEscape(hintText())}</p>`;
    return;
  }
  if (uiMode.type === 'CHOOSE_ACTION') {
    const buildableBases = engine.getBuildableBaseNodesForDie1(engine.currentPlayerId);
    const onlineSuffix = isOnline() ? '（服务器将校验本次行动）' : '';
    actionPanel.innerHTML = `<p><b>${htmlEscape(s.players[engine.currentPlayerId].name)}</b> 的第一骰为 <b>${s.lastDie1}</b>，请选择行动：${onlineSuffix}</p>
      <button id="drawCardBtn">1. 抽建设卡</button>
      <button id="buildRoadBtn">2. 选基地修路${buildableBases.length ? `（${buildableBases.length} 个可用基地）` : '（无可用基地，将跳过）'}</button>
      <button id="secondDieBtn" ${buildableBases.length ? '' : 'disabled'}>3. 选基地后掷第二骰</button>`;
    document.getElementById('drawCardBtn').addEventListener('click', processDrawCardAndMaybeFinish);
    document.getElementById('buildRoadBtn').addEventListener('click', () => {
      if (!buildableBases.length) {
        if (isOnline()) {
          sendOnlineAction('skipBuildRoad').then(result => { if (result) finishTurn(); });
        } else {
          engine.log('NO_EFFECT', `第一骰为 ${s.lastDie1}，没有任何可正常修路的基地，行动2跳过回合`);
          finishTurn();
        }
      } else {
        uiMode = { type: 'SELECT_BASE_ROAD' };
        render();
      }
    });
    document.getElementById('secondDieBtn').addEventListener('click', () => { uiMode = { type: 'SELECT_BASE_SECOND' }; render(); });
    return;
  }
  actionPanel.innerHTML = `<p>${htmlEscape(hintText())}</p>`;
}

function updateTopbarActionButton() {
  if (!newGameTopBtn) return;
  const inOnlineRoom = Boolean(online?.roomId);
  newGameTopBtn.textContent = inOnlineRoom ? '退出房间' : '重新开始';
  newGameTopBtn.classList.toggle('danger', inOnlineRoom);
  newGameTopBtn.title = inOnlineRoom ? '退出当前线上房间' : '回到开始界面';
}


function render() {
  document.body.classList.toggle('is-setup', !engine);
  updateTopbarActionButton();
  renderSetupMode();
  renderOnlineRoomPanel();
  renderBoard();
  renderStatus();
  renderPlayers();
  renderActions();
  renderLog();
}

async function handleOnlineSecondDieResult(result) {
  if (!result) return;
  const candidates = result.candidates || [];
  if (candidates.length) {
    uiMode = { type: 'SELECT_EDGE_SECOND', baseNodeId: online.room.secondDieBaseNodeId, candidateNodeIds: candidates };
    render();
    return;
  }
  const pair = engine?.state.lastDie2 === engine?.state.lastDie1;
  updateOnlineWaitMode(
    pair ? '第二骰没有可建设目标，但点数相同，稍后抽建设卡。' : '第二骰没有符合条件的建设目标，稍后结束回合。',
    () => pair ? processDrawCardAndMaybeFinish() : finishTurn(),
  );
}

async function onNodeClick(nodeId) {
  if (!engine || uiMode.type === 'MERCHANT_ANIMATION') return;
  if (isOnline() && !canInteract()) return;
  try {
    const validBases = engine.getBuildableBaseNodesForDie1(engine.currentPlayerId);
    if (uiMode.type === 'SELECT_BASE_ROAD') {
      if (!validBases.includes(nodeId)) return;
      uiMode = { type: 'SELECT_EDGE_ROAD', baseNodeId: nodeId };
      render();
      return;
    }
    if (uiMode.type === 'SELECT_BASE_SECOND') {
      if (!validBases.includes(nodeId)) return;
      if (isOnline()) {
        const result = await sendOnlineAction('rollSecondDie', { baseNodeId: nodeId });
        await handleOnlineSecondDieResult(result);
      } else {
        const { candidates } = engine.rollSecondDieForBase(nodeId);
        if (!candidates.length) {
          engine.log('NO_EFFECT', '第二骰没有符合条件的建设目标，本次建设无效果');
          waitAfterSecondDie('建设无效：第二骰没有符合条件的目标。');
        } else {
          uiMode = { type: 'SELECT_EDGE_SECOND', baseNodeId: nodeId, candidateNodeIds: candidates };
          render();
        }
      }
      return;
    }
    if (uiMode.type === 'SELECT_EDGE_SECOND' && (uiMode.candidateNodeIds || []).includes(nodeId)) {
      await onEdgeClick(edgeId(uiMode.baseNodeId, nodeId));
    }
  } catch (error) {
    alert(error.message);
    render();
  }
}

async function onEdgeClick(edgeIdValue) {
  if (!engine || uiMode.type === 'MERCHANT_ANIMATION') return;
  if (isOnline() && !canInteract()) return;
  if (!selectableEdges().has(edgeIdValue)) return;
  try {
    if (engine.state.phase === PHASE.PRE_BUILD) {
      if (isOnline()) {
        await sendOnlineAction('preBuildRoad', { edgeId: edgeIdValue });
      } else {
        engine.preBuildRoad(edgeIdValue);
        uiMode = { type: 'IDLE' };
        render();
      }
      return;
    }
    if (uiMode.type === 'SELECT_EDGE_ROAD') {
      if (isOnline()) {
        const result = await sendOnlineAction('buildFromBase', { baseNodeId: uiMode.baseNodeId, edgeId: edgeIdValue });
        if (result) await finishTurn();
      } else {
        engine.buildFromBase(uiMode.baseNodeId, edgeIdValue);
        finishTurn();
      }
      return;
    }
    if (uiMode.type === 'SELECT_EDGE_SECOND') {
      const edge = engine.getEdge(edgeIdValue);
      const targetNodeId = edge.nodeA === uiMode.baseNodeId ? edge.nodeB : edge.nodeA;
      if (isOnline()) {
        const result = await sendOnlineAction('resolveSecondDieBuild', { baseNodeId: uiMode.baseNodeId, targetNodeId });
        if (!result) return;
        const pair = engine.state.lastDie2 === engine.state.lastDie1;
        updateOnlineWaitMode(
          pair ? '第二骰建设完成，点数相同，稍后抽建设卡。' : '第二骰建设完成，稍后结束回合。',
          () => pair ? processDrawCardAndMaybeFinish() : finishTurn(),
        );
      } else {
        engine.resolveSecondDieBuild(uiMode.baseNodeId, targetNodeId);
        if (engine.state.lastDie2 === engine.state.lastDie1) waitAfterSecondDie('本次建设已完成。')
        else finishTurn();
      }
      return;
    }
    if (uiMode.type === 'CARD_SELECT_BRIDGE_TO_ROAD') {
      if (isOnline()) {
        const result = await sendOnlineAction('resolveCard', { options: { selectedBridgeToRoadEdge: edgeIdValue } });
        if (result?.done) { showAnnouncement(`建设卡：${cardName(result.card)}`, result.announcement || '建设卡已结算。'); await finishTurn(); }
      } else {
        const result = engine.resolveCard(uiMode.card, { selectedBridgeToRoadEdge: edgeIdValue });
        if (result.done) { showAnnouncement(`建设卡：${cardName(uiMode.card)}`, result.announcement || '建设卡已结算。'); finishTurn(); }
      }
      return;
    }
    if (uiMode.type === 'CARD_SELECT_ROAD_TO_REMOVE') {
      uiMode = { ...uiMode, type: 'CARD_SELECT_BRIDGE_EDGE', selectedRoadToRemove: edgeIdValue };
      if (isOnline() && online.room?.game) online.room.game.pendingCardOptions = { selectedRoadToRemove: edgeIdValue };
      render();
      return;
    }
    if (uiMode.type === 'CARD_SELECT_BRIDGE_EDGE') {
      const options = { selectedRoadToRemove: uiMode.selectedRoadToRemove, selectedBridgeEdge: edgeIdValue };
      if (isOnline()) {
        const result = await sendOnlineAction('resolveCard', { options });
        if (result?.done) { showAnnouncement(`建设卡：${cardName(result.card)}`, result.announcement || '建设卡已结算。'); await finishTurn(); }
      } else {
        const result = engine.resolveCard(uiMode.card, options);
        if (result.done) { showAnnouncement(`建设卡：${cardName(uiMode.card)}`, result.announcement || '建设卡已结算。'); finishTurn(); }
      }
    }
  } catch (error) {
    alert(error.message);
    render();
  }
}

async function processDrawCardAndMaybeFinish() {
  if (!engine) return;
  if (isOnline()) {
    const result = await sendOnlineAction('drawCard');
    if (!result) return;
    const card = result.card || engine.state.pendingCard;
    if (result.done) {
      showAnnouncement(`建设卡：${cardName(card)}`, result.announcement || '建设卡已结算。');
      await finishTurn();
      return;
    }
    uiMode = { type: result.needs === 'SELECT_BRIDGE_TO_ROAD' ? 'CARD_SELECT_BRIDGE_TO_ROAD' : 'CARD_SELECT_ROAD_TO_REMOVE', card, candidates: result.candidates, roadCandidates: result.roadCandidates, bridgeCandidates: result.bridgeCandidates };
    render();
    return;
  }
  try {
    const card = engine.drawCard();
    const result = engine.resolveCard(card);
    if (result.done) {
      showAnnouncement(`建设卡：${cardName(card)}`, result.announcement || '建设卡已结算。');
      finishTurn();
      return;
    }
    showAnnouncement(`抽到建设卡：${cardName(card)}`, '请根据地图高亮选择本卡牌的目标。');
    if (result.needs === 'SELECT_BRIDGE_TO_ROAD') uiMode = { type: 'CARD_SELECT_BRIDGE_TO_ROAD', card, candidates: result.candidates };
    else if (result.needs === 'SELECT_ROAD_TO_REMOVE') uiMode = { type: 'CARD_SELECT_ROAD_TO_REMOVE', card, roadCandidates: result.roadCandidates, bridgeCandidates: result.bridgeCandidates };
    render();
  } catch (error) {
    alert(error.message);
    render();
  }
}

async function finishTurn() {
  if (!engine) return;
  if (isOnline()) {
    const previousCompletedCount = engine.state.completedMerchants.length;
    const previousMerchantIndex = engine.state.currentMerchant?.index;
    const result = await sendOnlineAction('finishTurn');
    if (!result) return;
    const { completedMerchant, gameEnded, shouldAnnounceBigMerchant } = onlineTurnFinishedAnnouncement(previousCompletedCount, previousMerchantIndex);
    if (completedMerchant) {
      startMerchantCompletionAnimation(completedMerchant, () => {
        uiMode = { type: gameEnded ? 'GAME_END' : 'IDLE' };
        render();
        showMerchantSettlement(completedMerchant, () => {
          if (gameEnded) showGameResultAnnouncement();
          else if (shouldAnnounceBigMerchant) showAnnouncement('大商人前来交易', '城乡基建进入冲刺阶段');
        });
      });
    } else {
      uiMode = { type: gameEnded ? 'GAME_END' : 'IDLE' };
      render();
      if (shouldAnnounceBigMerchant) showAnnouncement('大商人前来交易', '城乡基建进入冲刺阶段');
    }
    return;
  }
  clearPendingWait();
  const previousMerchantIndex = engine.state.currentMerchant?.index;
  const completedCount = engine.state.completedMerchants.length;
  engine.finishActionAndAdvance();
  const completedMerchant = engine.state.completedMerchants.length > completedCount ? engine.state.completedMerchants.at(-1) : null;
  const gameEnded = engine.state.phase === PHASE.GAME_END;
  const shouldAnnounceBigMerchant = engine.state.currentMerchant?.type === 'BIG' && previousMerchantIndex !== engine.state.currentMerchant?.index;
  if (completedMerchant) {
    startMerchantCompletionAnimation(completedMerchant, () => {
      uiMode = { type: gameEnded ? 'GAME_END' : 'IDLE' };
      render();
      showMerchantSettlement(completedMerchant, () => {
        if (gameEnded) showGameResultAnnouncement();
        else if (shouldAnnounceBigMerchant) showAnnouncement('大商人前来交易', '城乡基建进入冲刺阶段');
      });
    });
    return;
  }
  uiMode = { type: gameEnded ? 'GAME_END' : 'IDLE' };
  render();
  if (shouldAnnounceBigMerchant) showAnnouncement('大商人前来交易', '城乡基建进入冲刺阶段');
}

function installFormalEditionHandlers() {
  createGameBtn?.addEventListener('click', () => {
    const count = Number(playerCountInput?.value || 2);
    const players = Array.from({ length: count }, (_, index) => ({ name: document.getElementById(`playerName${index + 1}`)?.value?.trim() || `玩家${index + 1}` }));
    cancelMerchantAnimation();
    clearPendingWait();
    clearOnlineSession();
    setupMode = 'local';
    engine = new GameEngine({ players, seed: createRandomSeed() });
    uiMode = { type: 'IDLE' };
    render();
  });
  newGameTopBtn?.addEventListener('click', () => {
    if (online?.roomId) leaveOnlineRoom();
    else localResetToSetup();
  });
  localModeBtn?.addEventListener('click', () => { setupMode = 'local'; render(); });
  onlineModeBtn?.addEventListener('click', () => { setupMode = 'online'; render(); refreshRooms(); });
  document.getElementById('refreshRoomsBtn')?.addEventListener('click', refreshRooms);
  document.getElementById('createRoomForm')?.addEventListener('submit', createOnlineRoom);
  roomsList?.addEventListener('click', event => {
    const button = event.target.closest('[data-room-action]');
    if (!button) return;
    const roomId = button.dataset.roomId;
    joinOnlineRoom(roomId, button.dataset.roomAction === 'spectate');
  });
  document.getElementById('rulesBtn')?.addEventListener('click', renderRulesModal);
  document.getElementById('catalogBtn')?.addEventListener('click', renderCardCatalogModal);
  document.getElementById('setupRulesBtn')?.addEventListener('click', renderRulesModal);
  document.getElementById('setupCatalogBtn')?.addEventListener('click', renderCardCatalogModal);
}

installFormalEditionHandlers();
render();
if (online?.roomId && online?.clientToken) reconnectOnlineSession();

window.addEventListener('resize', () => { if (engine) renderBoard(); });

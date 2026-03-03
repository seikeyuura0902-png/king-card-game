/**
 * キングカードゲーム - クライアントサイド 統合版
 */

'use strict';

const CARDS = {
  noble:          { name: '貴族',    emoji: '👑', type: 'normal' },
  general:        { name: '将軍',    emoji: '⚔️',  type: 'normal' },
  soldier:        { name: '兵士',    emoji: '🛡️',  type: 'normal' },
  citizen:        { name: '市民',    emoji: '🏘️',  type: 'normal' },
  slave:          { name: '奴隷',    emoji: '⛓️',  type: 'normal' },
  emperor:        { name: '皇帝',    emoji: '🏯', type: 'special', ability: '勅命' },
  first_emperor:  { name: '始皇帝', emoji: '🐉', type: 'special', ability: '万里の長城' },
  sniper:         { name: '狙撃手', emoji: '🎯', type: 'special', ability: '暗殺' },
  revolutionary:  { name: '革命家', emoji: '🔥', type: 'special', ability: '革命' }
};

const ALL_CARDS_LIST = Object.keys(CARDS);
const SPECIAL_CARDS = ['emperor','first_emperor','sniper','revolutionary'];

let gameMode = null; 
let socket = null;
let myPlayerId = 'p1';
let roomId = null;
let localState = null;
let selectedCard = null;

const cn = id => CARDS[id] ? CARDS[id].name : id;
const ce = id => CARDS[id] ? CARDS[id].emoji : '❓';
const isSpecial = id => SPECIAL_CARDS.includes(id);

// --- 画面切り替え ---
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
}

function showOnlineMenu() { showScreen('online'); }
function showRules() { showScreen('rules'); }

function addLog(msg) {
  const log = document.getElementById('battle-log');
  if (!log) return;
  const p = document.createElement('p');
  p.textContent = msg;
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
}

function setActionPanel(name) {
  document.querySelectorAll('.action-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('action-' + name);
  if (panel) panel.classList.add('active');
}

// --- オンライン対戦ロジック ---
function initSocket() {
  if (socket && socket.connected) return;
  socket = io();

  socket.on('matched', (data) => {
    document.getElementById('waiting-msg').classList.add('hidden');
    roomId = data.roomId;
    myPlayerId = data.playerId;
    gameMode = 'online';
    document.getElementById('opp-name').textContent = data.opponentName;
    showScreen('game');
    addLog("対戦相手が見つかりました！");
  });

  socket.on('gameState', (state) => {
    localState = state;
    myPlayerId = state.myId;
    selectedCard = (localState.me && localState.me.ready) ? localState.me.selectedCard : null;
    renderGame();
    if (state.log) {
      const logBox = document.getElementById('battle-log');
      logBox.innerHTML = '';
      state.log.forEach(msg => addLog(msg));
    }
  });
}

function findMatch() {
  const name = document.getElementById('player-name').value || 'プレイヤー';
  initSocket();
  socket.emit('findMatch', { name });
  document.getElementById('waiting-msg').classList.remove('hidden');
}

// --- AI対戦ロジック (簡易版) ---
function startAI() {
  gameMode = 'ai';
  showScreen('game');
  addLog("AI対戦を開始します。カードを選んでください。");
  // AI対戦用の初期ステートをセット（本来はもっと複雑ですが、まずは表示のために）
  localState = {
    turn: 0,
    phase: 'select',
    me: { hand: [...ALL_CARDS_LIST], killCount: 0, ready: false },
    opponent: { handCount: 9, killCount: 0 }
  };
  renderGame();
}

// --- 共通描画 ---
function renderGame() {
  if (!localState) return;
  const s = localState;

  document.getElementById('turn-num').textContent = 'ターン ' + (s.turn + 1);
  document.getElementById('my-kills').textContent = s.me.killCount;
  document.getElementById('opp-kills').textContent = s.opponent.killCount;

  const container = document.getElementById('player-hand');
  container.innerHTML = '';
  s.me.hand.forEach(cardId => {
    const div = document.createElement('div');
    div.className = 'game-card' + (isSpecial(cardId) ? ' special-card' : '');
    if (selectedCard === cardId) div.classList.add('selected');
    div.innerHTML = `<div>${ce(cardId)}</div><div style="font-size:10px">${cn(cardId)}</div>`;
    
    div.onclick = () => {
      if (s.phase === 'select' && !s.me.ready) {
        selectedCard = cardId;
        if (gameMode === 'online') {
          socket.emit('selectCard', { roomId, playerId: myPlayerId, cardId });
        } else {
          // AI対戦時の仮処理
          s.me.ready = true;
          renderGame();
          setTimeout(() => alert("AI対戦の計算は現在オンライン優先のため停止中です"), 500);
        }
      }
    };
    container.appendChild(div);
  });

  const oppContainer = document.getElementById('opponent-hand');
  oppContainer.innerHTML = '';
  for (let i = 0; i < s.opponent.handCount; i++) {
    const div = document.createElement('div');
    div.className = 'card-back';
    div.textContent = '？';
    oppContainer.appendChild(div);
  }
  handlePhase();
}

function handlePhase() {
  const s = localState;
  if (s.phase === 'select') {
    if (s.me.ready) setActionPanel('waiting');
    else setActionPanel('select');
  } else if (s.phase === 'gameover') {
    setActionPanel('gameover');
  }
}/**
 * キングカードゲーム - クライアントサイド 統合版
 */

'use strict';

const CARDS = {
  noble:          { name: '貴族',    emoji: '👑', type: 'normal' },
  general:        { name: '将軍',    emoji: '⚔️',  type: 'normal' },
  soldier:        { name: '兵士',    emoji: '🛡️',  type: 'normal' },
  citizen:        { name: '市民',    emoji: '🏘️',  type: 'normal' },
  slave:          { name: '奴隷',    emoji: '⛓️',  type: 'normal' },
  emperor:        { name: '皇帝',    emoji: '🏯', type: 'special', ability: '勅命' },
  first_emperor:  { name: '始皇帝', emoji: '🐉', type: 'special', ability: '万里の長城' },
  sniper:         { name: '狙撃手', emoji: '🎯', type: 'special', ability: '暗殺' },
  revolutionary:  { name: '革命家', emoji: '🔥', type: 'special', ability: '革命' }
};

const ALL_CARDS_LIST = Object.keys(CARDS);
const SPECIAL_CARDS = ['emperor','first_emperor','sniper','revolutionary'];

let gameMode = null; 
let socket = null;
let myPlayerId = 'p1';
let roomId = null;
let localState = null;
let selectedCard = null;

const cn = id => CARDS[id] ? CARDS[id].name : id;
const ce = id => CARDS[id] ? CARDS[id].emoji : '❓';
const isSpecial = id => SPECIAL_CARDS.includes(id);

// --- 画面切り替え ---
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
}

function showOnlineMenu() { showScreen('online'); }
function showRules() { showScreen('rules'); }

function addLog(msg) {
  const log = document.getElementById('battle-log');
  if (!log) return;
  const p = document.createElement('p');
  p.textContent = msg;
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
}

function setActionPanel(name) {
  document.querySelectorAll('.action-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('action-' + name);
  if (panel) panel.classList.add('active');
}

// --- オンライン対戦ロジック ---
function initSocket() {
  if (socket && socket.connected) return;
  socket = io();

  socket.on('matched', (data) => {
    document.getElementById('waiting-msg').classList.add('hidden');
    roomId = data.roomId;
    myPlayerId = data.playerId;
    gameMode = 'online';
    document.getElementById('opp-name').textContent = data.opponentName;
    showScreen('game');
    addLog("対戦相手が見つかりました！");
  });

  socket.on('gameState', (state) => {
    localState = state;
    myPlayerId = state.myId;
    selectedCard = (localState.me && localState.me.ready) ? localState.me.selectedCard : null;
    renderGame();
    if (state.log) {
      const logBox = document.getElementById('battle-log');
      logBox.innerHTML = '';
      state.log.forEach(msg => addLog(msg));
    }
  });
}

function findMatch() {
  const name = document.getElementById('player-name').value || 'プレイヤー';
  initSocket();
  socket.emit('findMatch', { name });
  document.getElementById('waiting-msg').classList.remove('hidden');
}

// --- AI対戦ロジック (簡易版) ---
function startAI() {
  gameMode = 'ai';
  showScreen('game');
  addLog("AI対戦を開始します。カードを選んでください。");
  // AI対戦用の初期ステートをセット（本来はもっと複雑ですが、まずは表示のために）
  localState = {
    turn: 0,
    phase: 'select',
    me: { hand: [...ALL_CARDS_LIST], killCount: 0, ready: false },
    opponent: { handCount: 9, killCount: 0 }
  };
  renderGame();
}

// --- 共通描画 ---
function renderGame() {
  if (!localState) return;
  const s = localState;

  document.getElementById('turn-num').textContent = 'ターン ' + (s.turn + 1);
  document.getElementById('my-kills').textContent = s.me.killCount;
  document.getElementById('opp-kills').textContent = s.opponent.killCount;

  const container = document.getElementById('player-hand');
  container.innerHTML = '';
  s.me.hand.forEach(cardId => {
    const div = document.createElement('div');
    div.className = 'game-card' + (isSpecial(cardId) ? ' special-card' : '');
    if (selectedCard === cardId) div.classList.add('selected');
    div.innerHTML = `<div>${ce(cardId)}</div><div style="font-size:10px">${cn(cardId)}</div>`;
    
    div.onclick = () => {
      if (s.phase === 'select' && !s.me.ready) {
        selectedCard = cardId;
        if (gameMode === 'online') {
          socket.emit('selectCard', { roomId, playerId: myPlayerId, cardId });
        } else {
          // AI対戦時の仮処理
          s.me.ready = true;
          renderGame();
          setTimeout(() => alert("AI対戦の計算は現在オンライン優先のため停止中です"), 500);
        }
      }
    };
    container.appendChild(div);
  });

  const oppContainer = document.getElementById('opponent-hand');
  oppContainer.innerHTML = '';
  for (let i = 0; i < s.opponent.handCount; i++) {
    const div = document.createElement('div');
    div.className = 'card-back';
    div.textContent = '？';
    oppContainer.appendChild(div);
  }
  handlePhase();
}

function handlePhase() {
  const s = localState;
  if (s.phase === 'select') {
    if (s.me.ready) setActionPanel('waiting');
    else setActionPanel('select');
  } else if (s.phase === 'gameover') {
    setActionPanel('gameover');
  }
}

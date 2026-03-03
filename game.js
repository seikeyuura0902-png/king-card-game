'use strict';

// ===================== 定数 =====================
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

// ===================== グローバル状態 =====================
let gameMode = null; 
let socket = null;
let myPlayerId = 'p1';
let roomId = null;
let localState = null;
let selectedCard = null;

const cn = id => CARDS[id] ? CARDS[id].name : id;
const ce = id => CARDS[id] ? CARDS[id].emoji : '❓';
const isSpecial = id => SPECIAL_CARDS.includes(id);

// ===================== 画面遷移（HTMLのonclickに対応） =====================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
}

function showOnlineMenu() { showScreen('online'); }
function showRules() { showScreen('rules'); }
function returnToTitle() { location.reload(); } // タイトルに戻る際はリロードが確実です

// ===================== オンライン通信 =====================
function initSocket() {
  if (socket && socket.connected) return;
  // Renderなどの環境に合わせて自動接続
  socket = io();

  socket.on('matched', (data) => {
    document.getElementById('waiting-msg').classList.add('hidden');
    roomId = data.roomId;
    myPlayerId = data.playerId;
    gameMode = 'online';
    document.getElementById('opp-name').textContent = data.opponentName;
    showScreen('game');
    addLog("マッチング完了！対戦開始！");
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

function cancelMatch() {
  if (socket) socket.disconnect();
  document.getElementById('waiting-msg').classList.add('hidden');
}

// ===================== ゲームロジック =====================
function startAI() {
  gameMode = 'ai';
  showScreen('game');
  localState = {
    turn: 0, phase: 'select',
    me: { hand: [...ALL_CARDS_LIST], killCount: 0, ready: false, dead: [] },
    opponent: { handCount: 9, killCount: 0, dead: [] }
  };
  renderGame();
  addLog("AI対戦開始（※現在オンライン優先で調整中）");
}

function renderGame() {
  if (!localState) return;
  const s = localState;

  // UI更新
  document.getElementById('turn-num').textContent = 'ターン ' + (s.turn + 1);
  document.getElementById('my-kills').textContent = s.me.killCount;
  document.getElementById('opp-kills').textContent = s.opponent.killCount;

  // 自分の手札
  const container = document.getElementById('player-hand');
  container.innerHTML = '';
  s.me.hand.forEach(cardId => {
    const div = document.createElement('div');
    div.className = 'game-card' + (isSpecial(cardId) ? ' special-card' : '');
    if (selectedCard === cardId) div.classList.add('selected');
    div.innerHTML = `<div>${ce(cardId)}</div><div style="font-size:10px">${cn(cardId)}</div>`;
    
    div.onclick = () => selectCard(cardId);
    container.appendChild(div);
  });

  // 相手の手札
  const oppContainer = document.getElementById('opponent-hand');
  oppContainer.innerHTML = '';
  for (let i = 0; i < s.opponent.handCount; i++) {
    const div = document.createElement('div');
    div.className = 'card-back';
    div.textContent = '？';
    oppContainer.appendChild(div);
  }

  updateActionPanel();
}

function selectCard(cardId) {
  if (localState.phase !== 'select' || localState.me.ready) return;
  selectedCard = cardId;
  
  // 選択中表示の更新
  const disp = document.getElementById('selected-card-display');
  const nameEl = document.getElementById('selected-card-name');
  if (disp && nameEl) {
    nameEl.textContent = cn(cardId);
    disp.classList.remove('hidden');
  }

  // オンラインなら即送信、AIなら一旦保留
  if (gameMode === 'online') {
    socket.emit('selectCard', { roomId, playerId: myPlayerId, cardId });
  }
  renderGame();
}

function cancelSelect() {
  selectedCard = null;
  document.getElementById('selected-card-display').classList.add('hidden');
  renderGame();
}

function updateActionPanel() {
  const s = localState;
  document.querySelectorAll('.action-panel').forEach(p => p.classList.remove('active'));
  
  if (s.phase === 'select') {
    if (s.me.ready) {
      document.getElementById('action-waiting').classList.add('active');
    } else {
      document.getElementById('action-select').classList.add('active');
    }
  } else if (s.phase === 'gameover') {
    document.getElementById('action-gameover').classList.add('active');
  }
}

function addLog(msg) {
  const log = document.getElementById('battle-log');
  if (!log) return;
  const p = document.createElement('p');
  p.textContent = msg;
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
}

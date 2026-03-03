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
let selectedCard = null; // 現在選んでいる（まだ確定していない）カード

const cn = id => CARDS[id] ? CARDS[id].name : id;
const ce = id => CARDS[id] ? CARDS[id].emoji : '❓';
const isSpecial = id => SPECIAL_CARDS.includes(id);

// --- 画面操作 ---
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
}
function showOnlineMenu() { showScreen('online'); }
function showRules() { showScreen('rules'); }
function returnToTitle() { location.reload(); }

// --- オンライン対戦 ---
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
  });

  socket.on('gameState', (state) => {
    localState = state;
    // サーバーからの確定状態に合わせてUIを更新
    if (localState.me.ready) {
      selectedCard = localState.me.selectedCard;
      document.getElementById('selected-card-display').classList.add('hidden');
    }
    renderGame();
  });
}

function findMatch() {
  const name = document.getElementById('player-name').value || 'プレイヤー';
  initSocket();
  socket.emit('findMatch', { name });
  document.getElementById('waiting-msg').classList.remove('hidden');
}

// --- カード選択ロジック ---
function selectCard(cardId) {
  if (!localState || localState.phase !== 'select' || (localState.me && localState.me.ready)) return;
  
  selectedCard = cardId;
  
  // 選択中表示を出す
  const disp = document.getElementById('selected-card-display');
  const nameEl = document.getElementById('selected-card-name');
  if (disp && nameEl) {
    nameEl.textContent = ce(cardId) + " " + cn(cardId);
    disp.classList.remove('hidden');
  }
  renderGame();
}

function cancelSelect() {
  selectedCard = null;
  document.getElementById('selected-card-display').classList.add('hidden');
  renderGame();
}

// ★決定ボタンが押された時の処理
function confirmSelection() {
  if (!selectedCard || !localState) return;

  if (gameMode === 'online') {
    socket.emit('selectCard', { roomId, playerId: myPlayerId, cardId: selectedCard });
  } else {
    // AI対戦の仮処理
    localState.me.ready = true;
    renderGame();
    addLog("あなたが " + cn(selectedCard) + " を確定しました。");
  }
  document.getElementById('selected-card-display').classList.add('hidden');
}

// --- 描画 ---
function renderGame() {
  if (!localState) return;
  const s = localState;

  // 基本情報
  document.getElementById('turn-num').textContent = 'ターン ' + (s.turn + 1);
  document.getElementById('my-kills').textContent = (s.me && s.me.killCount) || 0;
  document.getElementById('opp-kills').textContent = (s.opponent && s.opponent.killCount) || 0;

  // 自分の手札
  const container = document.getElementById('player-hand');
  container.innerHTML = '';
  
  // localState.me.hand が存在するかチェック
  const myHand = (s.me && s.me.hand) ? s.me.hand : [];
  
  myHand.forEach(cardId => {
    const div = document.createElement('div');
    div.className = 'game-card' + (isSpecial(cardId) ? ' special-card' : '');
    if (selectedCard === cardId) div.classList.add('selected');
    
    // 確定済みなら暗くする
    if (s.me && s.me.ready) div.classList.add('disabled');

    div.innerHTML = `<div>${ce(cardId)}</div><div style="font-size:10px">${cn(cardId)}</div>`;
    div.onclick = () => selectCard(cardId);
    container.appendChild(div);
  });

  // ★決定ボタンを表示させる
  const actionHint = document.getElementById('action-hint');
  if (selectedCard && !s.me.ready) {
    actionHint.innerHTML = `<button class="btn btn-primary btn-large" onclick="confirmSelection()">決定：${cn(selectedCard)}</button>`;
  } else if (s.me.ready) {
    actionHint.textContent = "相手の選択を待っています...";
  } else {
    actionHint.textContent = "カードを選んでください";
  }

  // 相手の手札
  const oppContainer = document.getElementById('opponent-hand');
  oppContainer.innerHTML = '';
  const oppCount = (s.opponent && s.opponent.handCount) ? s.opponent.handCount : 0;
  for (let i = 0; i < oppCount; i++) {
    const div = document.createElement('div');
    div.className = 'card-back';
    div.textContent = '？';
    oppContainer.appendChild(div);
  }

  updateActionPanel();
}

function updateActionPanel() {
  const s = localState;
  document.querySelectorAll('.action-panel').forEach(p => p.classList.remove('active'));
  if (s.phase === 'select') {
    document.getElementById('action-select').classList.add('active');
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

function startAI() {
  gameMode = 'ai';
  showScreen('game');
  localState = {
    turn: 0, phase: 'select',
    me: { hand: [...ALL_CARDS_LIST], killCount: 0, ready: false },
    opponent: { handCount: 9, killCount: 0 }
  };
  renderGame();
}

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
let pendingPredictions = [];
let interpAnimPending = false;

// ユーティリティ
const cn = id => CARDS[id] ? CARDS[id].name : id;
const ce = id => CARDS[id] ? CARDS[id].emoji : '❓';
const isSpecial = id => SPECIAL_CARDS.includes(id);

// ===================== 画面操作 =====================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
}
function showOnlineMenu() { showScreen('online'); }
function showRules() { showScreen('rules'); }

// ===================== 【最重要】オンライン対戦同期の修正 =====================
function initSocket() {
  if (socket && socket.connected) return;
  socket = io();

  socket.on('matched', (data) => {
    document.getElementById('waiting-msg').classList.add('hidden');
    roomId = data.roomId;
    myPlayerId = data.playerId;
    gameMode = 'online';
    document.getElementById('opp-name').textContent = data.opponentName || '相手';
    showScreen('game');
    clearLog();
    addLog('マッチング成立！ゲーム開始！');
  });

  socket.on('gameState', (state) => {
    // サーバーのデータを localState に反映
    localState = state;
    myPlayerId = state.myId; // 自分のIDを上書き

    // 自分のカード選択状態を同期
    if (localState.me && localState.me.ready) {
      selectedCard = localState.me.selectedCard;
    } else {
      selectedCard = null;
    }

    pendingPredictions = [];
    renderGame(); // 再描画

    if (state.log && state.log.length > 0) {
      const logBox = document.getElementById('battle-log');
      logBox.innerHTML = '';
      state.log.forEach(msg => addLog(msg));
    }
  });
}

function findMatch() {
  const name = document.getElementById('player-name').value.trim() || 'プレイヤー';
  initSocket();
  socket.emit('findMatch', { name });
}

// ===================== レンダリング（最初のロジックをベースに修正） =====================
function renderGame() {
  if (!localState || !localState.me) return;
  const s = localState;

  // ヘッダー情報
  document.getElementById('turn-num').textContent = 'ターン ' + (s.turn + 1);
  document.getElementById('my-kills').textContent = s.me.killCount || 0;
  document.getElementById('opp-kills').textContent = s.opponent.killCount || 0;

  // 自分の手札
  const container = document.getElementById('player-hand');
  container.innerHTML = '';
  (s.me.hand || []).forEach(cardId => {
    const div = document.createElement('div');
    div.className = 'game-card' + (isSpecial(cardId) ? ' special-card' : '');
    
    // 選択中・確定済みのスタイル
    if (selectedCard === cardId) div.classList.add('selected');
    if (s.me.ready) div.classList.add('disabled');

    div.innerHTML = `<div class="card-emoji">${ce(cardId)}</div><div class="card-name-text">${cn(cardId)}</div>`;
    
    if (!s.me.ready) {
      div.onclick = () => onCardClick(cardId);
    }
    container.appendChild(div);
  });

  // 相手の手札
  const oppContainer = document.getElementById('opponent-hand');
  oppContainer.innerHTML = '';
  const count = s.opponent.handCount || 0;
  for (let i = 0; i < count; i++) {
    const div = document.createElement('div');
    div.className = 'card-back' + (s.opponent.ready ? ' opponent-selected' : '');
    div.textContent = '🂠';
    oppContainer.appendChild(div);
  }

  updateConfirmBtn();
  handlePhase();
}

// カードクリック処理
function onCardClick(cardId) {
  if (localState.me.ready) return;
  selectedCard = cardId;
  
  const disp = document.getElementById('selected-card-display');
  const nameEl = document.getElementById('selected-card-name');
  if (disp && nameEl) {
    nameEl.textContent = ce(cardId) + ' ' + cn(cardId);
    disp.classList.remove('hidden');
  }
  renderGame();
}

function confirmCardSelection() {
  if (!selectedCard || !localState) return;
  
  if (gameMode === 'online') {
    socket.emit('selectCard', { roomId, playerId: myPlayerId, cardId: selectedCard });
  } else {
    // AI対戦の場合は、以前の1000行にあったバトル処理をここに呼ぶ（後ほど実装）
    localState.me.ready = true;
    addLog('確定しました。AIの選択を待っています...');
  }
  document.getElementById('selected-card-display').classList.add('hidden');
  renderGame();
}

function updateConfirmBtn() {
  const btn = document.getElementById('confirm-btn');
  if (btn) {
    btn.style.display = (selectedCard && !localState.me.ready) ? 'block' : 'none';
    if (selectedCard) btn.textContent = '✓ ' + cn(selectedCard) + ' で決定';
  }
}

function handlePhase() {
  const pselect = document.getElementById('action-select');
  const pwaiting = document.getElementById('action-waiting');
  if (!pselect || !pwaiting) return;

  if (localState.me.ready) {
    pselect.classList.remove('active');
    pwaiting.classList.add('active');
  } else {
    pselect.classList.add('active');
    pwaiting.classList.remove('active');
  }
}

// ログ用
function addLog(msg) {
  const log = document.getElementById('battle-log');
  if (!log) return;
  const p = document.createElement('p');
  p.textContent = msg;
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
}
function clearLog() { document.getElementById('battle-log').innerHTML = ''; }

// タイトル画面のボタン用
function startAI() { 
    gameMode = 'ai';
    localState = { turn: 0, me: { hand: [...ALL_CARDS_LIST], killCount: 0, ready: false }, opponent: { handCount: 9, killCount: 0 }, phase: 'select' };
    showScreen('game');
    renderGame();
}

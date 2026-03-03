'use strict';

// サーバーと共通のカード定義
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

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
}

function addLog(msg) {
  const log = document.getElementById('battle-log');
  if (!log) return;
  const p = document.createElement('p');
  p.textContent = msg;
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
}

// ===================== オンライン接続 =====================
function initSocket() {
  if (socket && socket.connected) return;
  socket = io();

  socket.on('matched', (data) => {
    roomId = data.roomId;
    myPlayerId = data.playerId;
    gameMode = 'online';
    showScreen('game');
    addLog('マッチング成立！');
  });

  socket.on('gameState', (state) => {
    localState = state;
    // サーバー側で選択済みなら同期
    if (state.me.ready) {
      selectedCard = state.me.selectedCard;
    }
    renderGame();
    if (state.log && state.log.length > 0) {
      document.getElementById('battle-log').innerHTML = '';
      state.log.forEach(msg => addLog(msg));
    }
  });
}

function findMatch() {
  initSocket();
  const name = document.getElementById('player-name').value.trim() || 'プレイヤー';
  socket.emit('findMatch', { name });
}

// ===================== 描画・操作 =====================
function renderGame() {
  if (!localState || !localState.me) return;
  const s = localState;

  document.getElementById('turn-num').textContent = `ターン ${s.turn + 1}`;
  document.getElementById('my-kills').textContent = s.me.killCount || 0;
  document.getElementById('opp-kills').textContent = s.opponent.killCount || 0;

  const container = document.getElementById('player-hand');
  container.innerHTML = '';

  s.me.hand.forEach(cardId => {
    const div = document.createElement('div');
    div.className = 'game-card' + (isSpecial(cardId) ? ' special-card' : '');
    
    // 特殊カードのロック判定 (サーバーからのフラグを優先)
    let isLocked = isSpecial(cardId) && !s.me.specialUnlocked;
    
    if (isLocked) div.classList.add('disabled');
    if (selectedCard === cardId) div.classList.add('selected');
    if (s.me.ready) div.classList.add('disabled');

    div.innerHTML = `<div class="card-emoji">${ce(cardId)}</div><div class="card-name-text">${cn(cardId)}</div>`;
    
    // クリックイベント
    if (!s.me.ready && !isLocked) {
      div.onclick = () => {
        selectedCard = cardId;
        const disp = document.getElementById('selected-card-display');
        if (disp) {
          document.getElementById('selected-card-name').textContent = ce(cardId) + ' ' + cn(cardId);
          disp.classList.remove('hidden');
        }
        renderGame();
      };
    }
    container.appendChild(div);
  });

  // 決定ボタン
  const confirmBtn = document.getElementById('confirm-btn');
  if (confirmBtn) {
    confirmBtn.style.display = (selectedCard && !s.me.ready) ? 'block' : 'none';
  }

  // パネル切り替え
  const pSelect = document.getElementById('action-select');
  const pWaiting = document.getElementById('action-waiting');
  if (s.me.ready) {
    pSelect?.classList.remove('active');
    pWaiting?.classList.add('active');
  } else {
    pSelect?.classList.add('active');
    pWaiting?.classList.remove('active');
  }
}

function confirmCardSelection() {
  if (!selectedCard || !localState || localState.me.ready) return;
  
  if (gameMode === 'online') {
    socket.emit('selectCard', { roomId, playerId: myPlayerId, cardId: selectedCard });
  }
  document.getElementById('selected-card-display').classList.add('hidden');
}

function cancelSelect() {
  selectedCard = null;
  document.getElementById('selected-card-display').classList.add('hidden');
  renderGame();
}

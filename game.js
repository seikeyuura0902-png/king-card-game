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
    // サーバーからデータが届いたら localState を完全に更新
    localState = state;
    if (localState.me && localState.me.ready) {
      selectedCard = localState.me.selectedCard;
      document.getElementById('selected-card-display').classList.add('hidden');
    } else {
      selectedCard = null;
    }
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

// --- カード選択 ---
function selectCard(cardId) {
  if (!localState || localState.phase !== 'select' || (localState.me && localState.me.ready)) return;
  selectedCard = cardId;
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

function confirmSelection() {
  if (!selectedCard || !localState) return;
  if (gameMode === 'online') {
    socket.emit('selectCard', { roomId, playerId: myPlayerId, cardId: selectedCard });
  } else {
    // AI対戦の確定処理
    localState.me.ready = true;
    localState.me.selectedCard = selectedCard;
    renderGame();
    addLog("あなたが " + cn(selectedCard) + " を出しました。");
    // AIに選ばせる
    setTimeout(processAITurn, 1000);
  }
  document.getElementById('selected-card-display').classList.add('hidden');
}

// --- AIの思考ロジック ---
function processAITurn() {
  if (gameMode !== 'ai') return;
  // ランダムにカードを選ぶ（AIの頭脳）
  const aiHand = ALL_CARDS_LIST; // 本来は減らすべきですが、まずは出すことを優先
  const aiCard = aiHand[Math.floor(Math.random() * aiHand.length)];
  
  addLog("AIが " + cn(aiCard) + " を出しました。");
  addLog("判定中...");

  setTimeout(() => {
    alert("対戦結果の判定ロジックはオンライン側を先に修正中です。\nまずはカードが出せることを確認してください！");
    // リセットして次へ進める
    localState.turn++;
    localState.me.ready = false;
    selectedCard = null;
    renderGame();
  }, 1000);
}

// --- 描画 ---
function renderGame() {
  // localStateが空の場合は描画しない（エラー防止）
  if (!localState || !localState.me) return;

  const s = localState;
  document.getElementById('turn-num').textContent = 'ターン ' + (s.turn + 1);
  document.getElementById('my-kills').textContent = s.me.killCount || 0;
  document.getElementById('opp-kills').textContent = s.opponent.killCount || 0;

  // 手札
  const container = document.getElementById('player-hand');
  container.innerHTML = '';
  const myHand = s.me.hand || [];
  myHand.forEach(cardId => {
    const div = document.createElement('div');
    div.className = 'game-card' + (isSpecial(cardId) ? ' special-card' : '');
    if (selectedCard === cardId) div.classList.add('selected');
    if (s.me.ready) div.classList.add('disabled');
    div.innerHTML = `<div>${ce(cardId)}</div><div style="font-size:10px">${cn(cardId)}</div>`;
    div.onclick = () => selectCard(cardId);
    container.appendChild(div);
  });

  // 決定ボタン
  const actionHint = document.getElementById('action-hint');
  if (selectedCard && !s.me.ready) {
    actionHint.innerHTML = `<button class="btn btn-primary btn-large" onclick="confirmSelection()">決定：${cn(selectedCard)}</button>`;
  } else if (s.me.ready) {
    actionHint.textContent = "対戦相手の選択を待っています...";
  } else {
    actionHint.textContent = "カードを選んでください";
  }

  // 相手の手札
  const oppContainer = document.getElementById('opponent-hand');
  oppContainer.innerHTML = '';
  const oppCount = s.opponent.handCount || 0;
  for (let i = 0; i < oppCount; i++) {
    const div = document.createElement('div');
    div.className = 'card-back';
    div.textContent = '？';
    oppContainer.appendChild(div);
  }
  
  updateActionPanel();
}

function updateActionPanel() {
  document.querySelectorAll('.action-panel').forEach(p => p.classList.remove('active'));
  if (localState.phase === 'select') {
    document.getElementById('action-select').classList.add('active');
  }
}

function addLog(msg) {
  const log = document.getElementById('battle-log');
  if (log) {
    const p = document.createElement('p');
    p.textContent = msg;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  }
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

/**
 * キングカードゲーム - クライアントサイド 修正版
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
let interpAnimPending = false;

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

function setActionPanel(name) {
  document.querySelectorAll('.action-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('action-' + name);
  if (panel) panel.classList.add('active');
}

// --- オンライン処理 ---
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
    myPlayerId = state.myId; // サーバーから届いた自分のID
    
    // 選択状態の同期
    if (localState.me && localState.me.ready) {
      selectedCard = localState.me.selectedCard;
    } else {
      selectedCard = null;
    }

    renderGame();
    
    if (state.log && state.log.length > 0) {
      const logBox = document.getElementById('battle-log');
      logBox.innerHTML = '';
      state.log.forEach(msg => addLog(msg));
    }
  });
}

function findMatch() {
  initSocket();
  const name = document.getElementById('player-name').value || 'プレイヤー';
  socket.emit('findMatch', { name });
  document.getElementById('waiting-msg').classList.remove('hidden');
}

// --- 描画処理 ---
function renderGame() {
  if (!localState) return;
  const s = localState;

  // ターンとスコア
  document.getElementById('turn-num').textContent = 'ターン ' + (s.turn + 1);
  document.getElementById('my-kills').textContent = s.me.killCount;
  document.getElementById('opp-kills').textContent = s.opponent.killCount;

  // 自分の手札描画
  const container = document.getElementById('player-hand');
  container.innerHTML = '';
  s.me.hand.forEach(cardId => {
    const div = document.createElement('div');
    div.className = 'game-card' + (isSpecial(cardId) ? ' special-card' : '');
    if (selectedCard === cardId) div.classList.add('selected');
    
    // 使用不可チェック
    if (s.me.lastCard === cardId || (s.phase === 'select' && s.me.ready)) {
        div.classList.add('disabled');
    }

    div.innerHTML = `<div>${ce(cardId)}</div><div style="font-size:10px">${cn(cardId)}</div>`;
    
    div.onclick = () => {
      if (s.phase === 'select' && !s.me.ready) {
        selectedCard = cardId;
        socket.emit('selectCard', { roomId, playerId: myPlayerId, cardId });
      }
    };
    container.appendChild(div);
  });

  // 相手の手札（裏向き）
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
    if (s.me.ready) {
      setActionPanel('waiting');
    } else {
      setActionPanel('select');
    }
  } else if (s.phase === 'gameover') {
    setActionPanel('gameover');
    document.getElementById('gameover-text').textContent = s.winner === myPlayerId ? 'あなたの勝利！' : '敗北...';
  }
}

// AI対戦用のボタンなどは元のHTMLの関数名に合わせて適宜残してください
function startAI() { alert("現在オンラインモードを優先修正中です。"); }

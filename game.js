/**
 * キングカードゲーム - クライアントサイド ゲームロジック v2
 * Client-Side Prediction (CSP) + Interpolation 実装
 */

'use strict';

// ===================== 定数 =====================
const CARDS = {
  noble:          { name: '貴族',   emoji: '👑', type: 'normal' },
  general:        { name: '将軍',   emoji: '⚔️',  type: 'normal' },
  soldier:        { name: '兵士',   emoji: '🛡️',  type: 'normal' },
  citizen:        { name: '市民',   emoji: '🏘️',  type: 'normal' },
  slave:          { name: '奴隷',   emoji: '⛓️',  type: 'normal' },
  emperor:        { name: '皇帝',   emoji: '🏯', type: 'special', ability: '勅命' },
  first_emperor:  { name: '始皇帝', emoji: '🐉', type: 'special', ability: '万里の長城' },
  sniper:         { name: '狙撃手', emoji: '🎯', type: 'special', ability: '暗殺' },
  revolutionary:  { name: '革命家', emoji: '🔥', type: 'special', ability: '革命' }
};

const ALL_CARDS_LIST = Object.keys(CARDS);
const SPECIAL_CARDS = ['emperor','first_emperor','sniper','revolutionary'];

// ===================== グローバル状態 =====================
let gameMode = null;          // 'ai' | 'online'
let socket = null;
let myPlayerId = 'p1';
let roomId = null;
let localState = null;
let selectedCard = null;
let revSelectedCards = [];
let currentAbilityContext = null;

// CSP用
let pendingPredictions = [];
// Interpolation用
let interpAnimPending = false;

// ===================== ユーティリティ =====================
const cn = id => CARDS[id] ? CARDS[id].name : id;
const ce = id => CARDS[id] ? CARDS[id].emoji : '❓';
const isSpecial = id => SPECIAL_CARDS.includes(id);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function addLog(msg) {
  const log = document.getElementById('battle-log');
  if (!log) return;
  const p = document.createElement('p');
  const isHL = msg.startsWith('⚡') || msg.startsWith('🎉') || msg.startsWith('ターン') || msg.startsWith('💥') || msg.startsWith('✨') || msg.startsWith('💔');
  if (isHL) p.classList.add('highlight');
  p.textContent = msg;
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
  // 最大50行
  while (log.children.length > 50) log.removeChild(log.firstChild);
}

function clearLog() {
  const log = document.getElementById('battle-log');
  if (log) log.innerHTML = '';
}

function setActionPanel(name) {
  document.querySelectorAll('.action-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('action-' + name);
  if (panel) panel.classList.add('active');
}

// ===================== タイトル画面 =====================
function startAI() {
  gameMode = 'ai';
  myPlayerId = 'p1';
  selectedCard = null;
  pendingPredictions = [];
  initLocalState();
  showScreen('game');
  clearLog();
  addLog('ゲーム開始！カードを選んでください');
  renderGame();
}

function showOnlineMenu() { showScreen('online'); }
function showRules() { showScreen('rules'); }

// ===================== オンライン対戦 =====================
function initSocket() {
  if (socket && socket.connected) return;
  socket = io({ transports: ['websocket', 'polling'], reconnectionAttempts: 5 });

  socket.on('connect', () => console.log('接続:', socket.id));

  socket.on('waiting', () => {
    document.getElementById('waiting-msg').classList.remove('hidden');
  });

  socket.on('matched', (data) => {
    document.getElementById('waiting-msg').classList.add('hidden');
    roomId = data.roomId;
    myPlayerId = data.playerId;
    gameMode = 'online';
    const myName = document.getElementById('player-name').value.trim() || 'あなた';
    document.getElementById('my-name').textContent = myName;
    document.getElementById('opp-name').textContent = data.opponentName || '相手';
    showScreen('game');
    clearLog();
    addLog('マッチング成立！ゲーム開始！');
  });

  socket.on('gameState', (state) => {
    // Interpolation: 状態変化のアニメーション処理
    if (localState && localState.turn !== state.turn) {
      // ターンが進んだ = バトル発生
      scheduleArenaAnimation(state);
    }
    // サーバー確定状態を適用
    localState = state;
    pendingPredictions = [];
    selectedCard = localState.me.ready ? localState.me.selectedCard : null;
    renderGame();
    if (state.log && state.log.length > 0) {
      state.log.forEach(msg => addLog(msg));
    }
  });

  socket.on('cardSelected', (data) => {
    // CSP確認
    pendingPredictions = pendingPredictions.filter(p => p.cardId !== data.cardId);
  });

  socket.on('opponentReady', () => {
    if (localState) {
      localState.opponent.ready = true;
      renderOpponentHand();
    }
  });

  socket.on('opponentDisconnected', () => {
    addLog('⚠️ 相手が切断しました');
    setActionPanel('gameover');
    document.getElementById('gameover-text').textContent = '相手が切断しました';
  });

  socket.on('disconnect', () => {
    addLog('⚠️ サーバー接続が切れました');
  });
}

function findMatch() {
  const name = document.getElementById('player-name').value.trim() || 'プレイヤー';
  initSocket();
  socket.emit('findMatch', { name });
}

function cancelMatch() {
  if (socket) { socket.disconnect(); socket = null; }
  document.getElementById('waiting-msg').classList.add('hidden');
  showScreen('online');
}

// ===================== ローカル状態初期化 =====================
function initLocalState() {
  localState = {
    myId: 'p1',
    me: {
      hand: [...ALL_CARDS_LIST],
      dead: [],
      assassinated: [],
      revived: [],
      lastCard: null,
      specialUnlocked: false,
      bannedCards: [],
      forcedNextTurn: false,
      greatWallActive: false,
      greatWallTurns: 0,
      totalAbilityUses: 0,
      abilityUsed: {},
      killCount: 0,
      ready: false,
      selectedCard: null
    },
    opponent: {
      handCount: 9,
      dead: [],
      assassinated: [],
      revived: [],
      lastCard: null,
      specialUnlocked: false,
      bannedCards: [],
      forcedNextTurn: false,
      greatWallActive: false,
      greatWallTurns: 0,
      killCount: 0,
      ready: false
    },
    // AIが内部的に持つ状態（AI対戦のみ）
    _aiInternal: {
      hand: [...ALL_CARDS_LIST],
      dead: [],
      assassinated: [],
      revived: [],
      lastCard: null,
      specialUnlocked: false,
      bannedCards: [],
      forcedNextTurn: false,
      greatWallActive: false,
      greatWallTurns: 0,
      totalAbilityUses: 0,
      abilityUsed: {},
      killCount: 0
    },
    turn: 0,
    phase: 'select',
    winner: null,
    log: [],
    pendingAbility: null,
    pendingAbilityIndex: 0
  };
}

// ===================== Interpolation =====================
function scheduleArenaAnimation(nextState) {
  if (interpAnimPending) return;
  interpAnimPending = true;
  setTimeout(() => {
    showArenaFromState(nextState);
    interpAnimPending = false;
  }, 80);
}

function showArenaFromState(state) {
  // ログから対戦カードを取得
  const log0 = (state.log && state.log[0]) || '';
  const match = log0.match(/P[12]「(.+?)」 vs P[12]「(.+?)」/);
  if (!match) return;

  // myIdがp1かp2かで自分/相手を決定
  let myCardName, oppCardName;
  if (state.myId === 'p1') {
    myCardName = match[1]; oppCardName = match[2];
  } else {
    myCardName = match[2]; oppCardName = match[1];
  }

  const myCardId = nameToId(myCardName);
  const oppCardId = nameToId(oppCardName);

  showArenaCards(myCardId, oppCardId, state);
}

function nameToId(name) {
  return ALL_CARDS_LIST.find(id => CARDS[id].name === name) || null;
}

// ===================== Client-Side Prediction =====================
function predictSelectCard(cardId) {
  const pred = { type: 'selectCard', cardId, ts: Date.now() };
  pendingPredictions.push(pred);
  // 楽観的更新
  localState.me.ready = true;
  localState.me.selectedCard = cardId;
  selectedCard = cardId;
  updateConfirmBtn();
  setActionPanel('waiting');
  document.getElementById('waiting-text').textContent = '相手の選択を待っています...';
  renderOpponentHand();
}

// ===================== レンダリング =====================
function renderGame() {
  if (!localState) return;
  const s = localState;

  // ヘッダー
  document.getElementById('turn-num').textContent = 'ターン ' + (s.turn + 1);
  // my-kills = 自分が倒した数 = 相手のkillCount
  document.getElementById('my-kills').textContent = s.opponent.killCount || 0;
  document.getElementById('opp-kills').textContent = s.me.killCount || 0;

  // 万里の長城バッジ
  document.getElementById('my-gw-badge').classList.toggle('hidden', !s.me.greatWallActive);
  document.getElementById('opp-gw-badge').classList.toggle('hidden', !s.opponent.greatWallActive);

  // フェーズラベル
  const labels = { select: 'カード選択中', ability: '特殊能力フェーズ', gameover: 'ゲーム終了' };
  document.getElementById('game-phase-label').textContent = labels[s.phase] || '';

  renderPlayerHand();
  renderOpponentHand();
  renderDeadCards();
  handlePhase();
}

function renderPlayerHand() {
  if (!localState) return;
  const s = localState;
  const container = document.getElementById('player-hand');
  if (!container) return;
  container.innerHTML = '';

  (s.me.hand || []).forEach(cardId => {
    const card = CARDS[cardId];
    if (!card) return;

    const div = document.createElement('div');
    div.className = 'game-card' + (card.type === 'special' ? ' special-card' : '');
    div.dataset.cardId = cardId;

    let disabled = false;
    let hint = '';

    if (s.me.lastCard === cardId) { disabled = true; hint = '連続不可'; }
    else if ((s.me.bannedCards || []).some(b => b.card === cardId)) { disabled = true; hint = '禁止中'; }
    else if (s.me.forcedNextTurn && cardId !== 'soldier' && cardId !== 'slave') { disabled = true; hint = '制限中'; }
    else if (!s.me.specialUnlocked && isSpecial(cardId)) { disabled = true; hint = '未解禁'; }
    else if (cardId === 'revolutionary') {
      const dc = (s.me.dead || []).length + (s.me.assassinated || []).length;
      if (dc < 3) { disabled = true; hint = '3枚死後'; }
    }

    if (disabled) div.classList.add('disabled');
    if (selectedCard === cardId && !s.me.ready) div.classList.add('selected');

    div.innerHTML =
      '<div class="card-emoji">' + card.emoji + '</div>' +
      '<div class="card-name-text">' + card.name + '</div>' +
      (card.type === 'special' ? '<div class="card-label">' + card.ability + '</div>' : '') +
      (disabled && hint ? '<div class="card-label" style="color:#e74c3c;font-size:8px">' + hint + '</div>' : '');

    if (!disabled && s.phase === 'select' && !s.me.ready) {
      div.addEventListener('click', () => onCardClick(cardId));
    }

    container.appendChild(div);
  });

  updateConfirmBtn();
}

function renderOpponentHand() {
  if (!localState) return;
  const s = localState;
  const container = document.getElementById('opponent-hand');
  if (!container) return;
  container.innerHTML = '';

  const count = Math.max(0, s.opponent.handCount || 0);
  for (let i = 0; i < count; i++) {
    const div = document.createElement('div');
    div.className = 'card-back' + (s.opponent.ready ? ' opponent-selected' : '') + ' interp-enter';
    div.textContent = '🂠';
    container.appendChild(div);
  }
}

function renderDeadCards() {
  if (!localState) return;
  const s = localState;

  const myDead = document.getElementById('player-dead');
  if (myDead) {
    myDead.innerHTML = '';
    const allDead = [...(s.me.dead || []), ...(s.me.assassinated || [])];
    allDead.forEach(cid => {
      const d = document.createElement('div');
      d.className = 'game-card dead-card';
      d.title = cn(cid) + (s.me.assassinated && s.me.assassinated.includes(cid) ? '(暗殺)' : '');
      d.innerHTML = '<div>' + ce(cid) + '</div><div style="font-size:8px">' + cn(cid) + '</div>';
      myDead.appendChild(d);
    });
  }

  const oppDead = document.getElementById('opponent-dead');
  if (oppDead) {
    oppDead.innerHTML = '';
    const allDead2 = [...(s.opponent.dead || []), ...(s.opponent.assassinated || [])];
    allDead2.forEach(cid => {
      const d = document.createElement('div');
      d.className = 'game-card dead-card';
      d.innerHTML = '<div>' + ce(cid) + '</div><div style="font-size:8px">' + cn(cid) + '</div>';
      oppDead.appendChild(d);
    });
  }
}

// ===================== フェーズ処理 =====================
function handlePhase() {
  if (!localState) return;
  const s = localState;

  if (s.phase === 'gameover') {
    doGameOver(s);
    return;
  }

  if (s.phase === 'ability') {
    handleAbilityPhase(s);
    return;
  }

  // selectフェーズ
  if (s.me.ready) {
    setActionPanel('waiting');
    document.getElementById('waiting-text').textContent = '相手の選択を待っています...';
  } else {
    setActionPanel('select');
    const hint = getSelectHint(s);
    document.getElementById('action-hint').textContent = hint;
  }
}

function getSelectHint(s) {
  if (s.me.forcedNextTurn) return '⚠️ 「兵士」か「奴隷」のみ出せます';
  const banned = (s.me.bannedCards || []).filter(b => s.me.hand.includes(b.card));
  if (banned.length > 0) return '🚫 禁止: ' + banned.map(b => cn(b.card) + '(' + b.turnsLeft + 'T)').join(' ');
  if (s.me.greatWallActive) return '🏯 万里の長城発動中(' + s.me.greatWallTurns + 'T) カードを選んでください';
  return 'カードを選んでください';
}

function handleAbilityPhase(s) {
  const pa = s.pendingAbility;
  const idx = s.pendingAbilityIndex || 0;
  if (!pa || idx >= pa.length) {
    s.phase = 'select';
    setActionPanel('select');
    return;
  }
  const current = pa[idx];
  if (current.playerId !== s.myId && current.playerId !== 'ai') {
    // オンライン: 相手フェーズ
    setActionPanel('waiting');
    document.getElementById('waiting-text').textContent = '相手が ' + (CARDS[current.cardId] ? CARDS[current.cardId].ability : '特殊能力') + ' を使用中...';
    return;
  }
  if (current.playerId === 'ai') {
    // AI対戦: AIの能力フェーズ
    setActionPanel('waiting');
    document.getElementById('waiting-text').textContent = 'AIが特殊能力を使用中...';
    return;
  }
  // 自分の能力フェーズ
  currentAbilityContext = current;
  buildAbilityPanel(current, s);
  setActionPanel('ability');
}

function buildAbilityPanel(ctx, s) {
  const card = CARDS[ctx.cardId];
  if (!card) return;
  document.getElementById('ability-title').textContent = '⚡ ' + card.name + '「' + card.ability + '」を使いますか？';
  const opts = document.getElementById('ability-options');
  opts.innerHTML = '';

  if (ctx.cardId === 'emperor') {
    const a = mkBtn('A: 相手の手札1枚を3ターン禁止', 'btn-gold', () => doChokureiA(s));
    const b = mkBtn('B: 次ターン相手は兵士/奴隷のみ', 'btn-primary', () => doChokureiB());
    opts.appendChild(a); opts.appendChild(b);

  } else if (ctx.cardId === 'first_emperor') {
    opts.appendChild(mkBtn('万里の長城を発動！（3ターン間負けない）', 'btn-gold', () => sendAbility({ cardId: 'first_emperor' })));

  } else if (ctx.cardId === 'sniper') {
    opts.appendChild(mkBtn('暗殺するカードを選択', 'btn-danger', () => openAssassinModal(s)));

  } else if (ctx.cardId === 'revolutionary') {
    opts.appendChild(mkBtn('復活させる2枚を選択', 'btn-primary', () => openRevModal(s)));
  }
}

function mkBtn(label, cls, fn) {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = label;
  b.onclick = fn;
  return b;
}

// ===================== カード選択 =====================
function onCardClick(cardId) {
  if (!localState || localState.phase !== 'select' || localState.me.ready) return;
  if (selectedCard === cardId) {
    // 2回タップで確定
    confirmCardSelection(cardId);
    return;
  }
  selectedCard = cardId;
  renderPlayerHand();
  showSelectedDisplay(cardId);
}

function showSelectedDisplay(cardId) {
  const disp = document.getElementById('selected-card-display');
  const nameEl = document.getElementById('selected-card-name');
  if (!disp || !nameEl) return;
  nameEl.textContent = ce(cardId) + ' ' + cn(cardId);
  disp.classList.remove('hidden');
}

function cancelSelect() {
  selectedCard = null;
  const disp = document.getElementById('selected-card-display');
  if (disp) disp.classList.add('hidden');
  renderPlayerHand();
}

function confirmCardSelection(cardId) {
  if (!cardId || !localState) return;
  if (localState.me.ready) return;

  if (gameMode === 'ai') {
    localState.me.ready = true;
    localState.me.selectedCard = cardId;
    document.getElementById('selected-card-display').classList.add('hidden');
    setActionPanel('waiting');
    document.getElementById('waiting-text').textContent = 'AIが選択中...';

    // AIの思考時間
    const delay = 600 + Math.random() * 700;
    setTimeout(() => {
      const aiCard = aiPickCard();
      processAIBattle(cardId, aiCard);
    }, delay);

  } else if (gameMode === 'online' && socket) {
    // CSP: 楽観的更新
    predictSelectCard(cardId);
    // サーバーへ送信
    socket.emit('selectCard', { roomId, playerId: myPlayerId, cardId });
  }
}

function updateConfirmBtn() {
  const btn = document.getElementById('confirm-btn');
  if (!btn) return;
  const s = localState;
  if (s && s.phase === 'select' && !s.me.ready && selectedCard) {
    btn.style.display = 'block';
    btn.textContent = '✓ ' + cn(selectedCard) + ' で決定';
  } else {
    btn.style.display = 'none';
  }
}

// ===================== AI =====================
function aiPickCard() {
  const s = localState;
  const ai = s._aiInternal;
  if (!ai) return 'slave';

  // AIが使用可能なカードリスト
  const avail = (ai.hand || ALL_CARDS_LIST).filter(cid => {
    if (ai.lastCard === cid) return false;
    if ((ai.bannedCards || []).some(b => b.card === cid)) return false;
    if (ai.forcedNextTurn && cid !== 'soldier' && cid !== 'slave') return false;
    if (!ai.specialUnlocked && isSpecial(cid)) return false;
    if (cid === 'revolutionary') {
      const dc = (ai.dead || []).length + (ai.assassinated || []).length;
      if (dc < 3) return false;
    }
    return true;
  });

  if (avail.length === 0) return 'slave';

  // スコアリング（プレイヤーの選びうるカードに対して）
  const playerAvail = (s.me.hand || []).filter(cid => {
    if (s.me.lastCard === cid) return false;
    if ((s.me.bannedCards || []).some(b => b.card === cid)) return false;
    if (s.me.forcedNextTurn && cid !== 'soldier' && cid !== 'slave') return false;
    if (!s.me.specialUnlocked && isSpecial(cid)) return false;
    return true;
  });

  const scores = {};
  avail.forEach(aiCard => {
    let score = 0;
    (playerAvail.length > 0 ? playerAvail : ALL_CARDS_LIST).forEach(pCard => {
      const r = clientResolveBattle(aiCard, pCard);
      if (r === 'p1') score += 2;
      else if (r === 'draw') score += 1;
      else if (r === 'mutual') score -= 0.5;
      else score -= 2;
    });
    scores[aiCard] = score;
  });

  const maxScore = Math.max(...Object.values(scores));
  const best = avail.filter(c => scores[c] >= maxScore - 1.5);
  return best[Math.floor(Math.random() * best.length)];
}

// バトル相性判定（クライアント版）
// p1=第1引数のカード, p2=第2引数のカード
// 戻り値: 'p1'(第1引数勝ち) | 'p2'(第2引数勝ち) | 'draw' | 'mutual'
function clientResolveBattle(c1, c2) {
  if (c1 === c2) return 'draw';
  if ((c1 === 'noble' && c2 === 'soldier') || (c1 === 'soldier' && c2 === 'noble')) return 'mutual';
  const s1 = isSpecial(c1), s2 = isSpecial(c2);
  if (c1 === 'slave' && s2) return 'p1';
  if (c2 === 'slave' && s1) return 'p2';
  if (s1 && s2) {
    const wins = { emperor:['first_emperor'], first_emperor:['sniper','revolutionary'], sniper:['emperor'], revolutionary:['emperor'] };
    if (wins[c1] && wins[c1].includes(c2)) return 'p1';
    if (wins[c2] && wins[c2].includes(c1)) return 'p2';
    return 'draw'; // sniper vs revolutionary
  }
  if (s1 && c2 !== 'slave') return 'p1';
  if (s2 && c1 !== 'slave') return 'p2';
  const nw = { noble:['slave','general'], general:['slave','soldier'], soldier:['slave','citizen'], citizen:['slave','noble','general'], slave:[] };
  if (nw[c1] && nw[c1].includes(c2)) return 'p1';
  if (nw[c2] && nw[c2].includes(c1)) return 'p2';
  return 'draw';
}

// ===================== AI バトル処理 =====================
function processAIBattle(playerCard, aiCard) {
  const s = localState;
  const me = s.me;
  const ai = s._aiInternal;
  const opp = s.opponent; // 表示用相手情報

  // バトル解決
  let rawRes = clientResolveBattle(playerCard, aiCard);
  let res = rawRes;

  // 万里の長城適用
  if (me.greatWallActive && res === 'p2') res = 'draw';
  if (ai.greatWallActive && res === 'p1') res = 'draw';
  if (me.greatWallActive && res === 'mutual') res = 'p1';
  if (ai.greatWallActive && res === 'mutual') res = 'p2';
  if (me.greatWallActive && ai.greatWallActive && rawRes === 'mutual') res = 'draw';

  // 万里の長城カウントダウン
  if (me.greatWallActive) {
    me.greatWallTurns--;
    if (me.greatWallTurns <= 0) { me.greatWallActive = false; addLog('万里の長城終了'); }
  }
  if (ai.greatWallActive) {
    ai.greatWallTurns--;
    if (ai.greatWallTurns <= 0) { ai.greatWallActive = false; addLog('AIの万里の長城終了'); }
  }

  // ログ生成
  s.log = [];
  s.log.push('ターン' + (s.turn + 1) + ': あなた「' + cn(playerCard) + '」 vs AI「' + cn(aiCard) + '」');

  let playerDies = false, aiDies = false, playerWins = false, aiWins = false;

  if (res === 'p1') {
    aiDies = true; playerWins = true;
    s.log.push('✨ あなたの勝利！ AIの' + cn(aiCard) + 'が死亡');
  } else if (res === 'p2') {
    playerDies = true; aiWins = true;
    s.log.push('💔 AIの勝利… あなたの' + cn(playerCard) + 'が死亡');
  } else if (res === 'mutual') {
    playerDies = true; aiDies = true;
    s.log.push('💥 相打ち！ ' + cn(playerCard) + 'と' + cn(aiCard) + 'が両方死亡');
  } else {
    s.log.push('🤝 引き分け！ 両者手札に戻る');
  }

  // 死亡処理
  if (playerDies) {
    me.hand = me.hand.filter(c => c !== playerCard);
    const ri = (me.revived || []).indexOf(playerCard);
    if (ri !== -1) { me.revived.splice(ri, 1); }
    else { /* 復活カードが再び死んだ場合はkillCountを増やす */ }
    me.dead.push(playerCard);
    opp.killCount = (opp.killCount || 0) + 1;
    ai.killCount = (ai.killCount || 0) + 1;
  }
  if (aiDies) {
    ai.hand = (ai.hand || ALL_CARDS_LIST).filter(c => c !== aiCard);
    const ri2 = (ai.revived || []).indexOf(aiCard);
    if (ri2 !== -1) { ai.revived.splice(ri2, 1); }
    ai.dead.push(aiCard);
    opp.dead = [...ai.dead];
    opp.assassinated = [...(ai.assassinated || [])];
    me.killCount = (me.killCount || 0) + 1;
    opp.handCount = Math.max(0, (opp.handCount || 0) - 1);
  }

  // 勅命制限解除
  me.forcedNextTurn = false;
  ai.forcedNextTurn = false;
  opp.forcedNextTurn = false;

  // 勅命Aカウントダウン
  me.bannedCards = (me.bannedCards || []).map(b => ({ ...b, turnsLeft: b.turnsLeft - 1 })).filter(b => b.turnsLeft > 0);
  ai.bannedCards = (ai.bannedCards || []).map(b => ({ ...b, turnsLeft: b.turnsLeft - 1 })).filter(b => b.turnsLeft > 0);
  opp.bannedCards = [...(ai.bannedCards || [])];

  // 特殊解禁
  me.specialUnlocked = (me.dead.length + (me.assassinated || []).length) >= 2;
  ai.specialUnlocked = ((ai.dead || []).length + (ai.assassinated || []).length) >= 2;
  opp.specialUnlocked = ai.specialUnlocked;

  // lastCard更新
  me.lastCard = playerCard;
  ai.lastCard = aiCard;
  opp.lastCard = aiCard;
  me.ready = false; me.selectedCard = null;
  selectedCard = null;

  s.turn++;

  // アリーナ表示
  showArenaCards(playerCard, aiCard, s);

  // ログ出力
  s.log.forEach(msg => addLog(msg));

  // 勝利チェック
  if (opp.killCount >= 6 || me.killCount >= 6) {
    setTimeout(() => {
      s.phase = 'gameover';
      s.winner = me.killCount >= 6 ? 'p1' : 'ai';
      s.log = [me.killCount >= 6 ? '🎉 あなたの勝利！' : '😞 AIの勝利…'];
      s.log.forEach(msg => addLog(msg));
      renderGame();
    }, 2000);
    return;
  }

  // 特殊能力フェーズ
  const pa = [];
  if (playerWins && isSpecial(playerCard) && canUseAbility(me, playerCard)) {
    pa.push({ playerId: 'p1', cardId: playerCard });
  }
  if (aiWins && isSpecial(aiCard) && canUseAbility(ai, aiCard)) {
    pa.push({ playerId: 'ai', cardId: aiCard });
  }

  setTimeout(() => {
    if (pa.length > 0) {
      s.phase = 'ability';
      s.pendingAbility = pa;
      s.pendingAbilityIndex = 0;
      renderGame();
      advanceAbilityPhase();
    } else {
      s.phase = 'select';
      renderGame();
    }
  }, 2000);
}

function canUseAbility(player, cardId) {
  if ((player.totalAbilityUses || 0) >= 2) return false;
  if (player.abilityUsed && player.abilityUsed[cardId]) return false;
  if (cardId === 'revolutionary') {
    const dc = (player.dead || []).length + (player.assassinated || []).length;
    if (dc < 3) return false;
  }
  return true;
}

function advanceAbilityPhase() {
  const s = localState;
  if (!s || !s.pendingAbility) return;
  const idx = s.pendingAbilityIndex || 0;
  if (idx >= s.pendingAbility.length) {
    s.phase = 'select';
    s.pendingAbility = null;
    renderGame();
    return;
  }
  const cur = s.pendingAbility[idx];
  if (cur.playerId === 'ai') {
    // AIの能力を自動実行
    setTimeout(() => {
      aiDoAbility(cur.cardId);
    }, 800);
  } else {
    // プレイヤーの能力フェーズ
    renderGame();
  }
}

function aiDoAbility(cardId) {
  const s = localState;
  const ai = s._aiInternal;
  const me = s.me;
  const opp = s.opponent;

  ai.abilityUsed = ai.abilityUsed || {};
  ai.abilityUsed[cardId] = true;
  ai.totalAbilityUses = (ai.totalAbilityUses || 0) + 1;

  if (cardId === 'emperor') {
    // AIは勅命A（プレイヤーの手札から選ぶ）
    const avail = (me.hand || []).filter(c => !(me.bannedCards || []).some(b => b.card === c));
    if (avail.length > 0) {
      // 最強カードを優先
      const priority = ['emperor','first_emperor','sniper','revolutionary','citizen','noble','general','soldier','slave'];
      const target = priority.find(p => avail.includes(p)) || avail[0];
      me.bannedCards = me.bannedCards || [];
      me.bannedCards.push({ card: target, turnsLeft: 3 });
      addLog('⚡ AI勅命A: あなたの' + cn(target) + 'を3ターン禁止！');
    }
  } else if (cardId === 'first_emperor') {
    ai.greatWallActive = true; ai.greatWallTurns = 3;
    opp.greatWallActive = true; opp.greatWallTurns = 3;
    addLog('⚡ AIが万里の長城を発動！3ターン間AIは負けない！');
  } else if (cardId === 'sniper') {
    const targets = (me.hand || []).filter(c => c !== 'slave');
    if (targets.length > 0) {
      const priority = ['emperor','first_emperor','sniper','revolutionary','citizen','noble','general','soldier'];
      const target = priority.find(p => targets.includes(p)) || targets[0];
      me.hand = me.hand.filter(c => c !== target);
      me.assassinated = me.assassinated || [];
      me.assassinated.push(target);
      me.specialUnlocked = (me.dead.length + me.assassinated.length) >= 2;
      opp.killCount = (opp.killCount || 0); // 暗殺は勝利条件外
      addLog('⚡ AI暗殺: あなたの' + cn(target) + 'が暗殺された！(勝利条件外)');
    }
  } else if (cardId === 'revolutionary') {
    const allDead = [...(ai.dead || []), ...(ai.assassinated || [])];
    const toRevive = allDead.slice(0, 2);
    toRevive.forEach(c => {
      const di = (ai.dead || []).indexOf(c);
      if (di !== -1) {
        ai.dead.splice(di, 1);
        me.killCount = Math.max(0, (me.killCount || 0) - 1);
        opp.killCount = Math.max(0, (opp.killCount || 0) - 1); // 表示用
      } else {
        const ai2 = (ai.assassinated || []).indexOf(c);
        if (ai2 !== -1) ai.assassinated.splice(ai2, 1);
      }
      ai.hand = ai.hand || [];
      ai.hand.push(c);
      ai.revived = ai.revived || [];
      ai.revived.push(c);
      opp.handCount = (opp.handCount || 0) + 1;
    });
    opp.dead = [...(ai.dead || [])];
    opp.assassinated = [...(ai.assassinated || [])];
    addLog('⚡ AI革命: ' + toRevive.map(cn).join('、') + 'を復活！(勝利条件外)');
  }

  s.pendingAbilityIndex = (s.pendingAbilityIndex || 0) + 1;
  renderDeadCards();
  setTimeout(() => advanceAbilityPhase(), 400);
}

// ===================== プレイヤー能力 =====================
function sendAbility(abilityData) {
  if (gameMode === 'ai') {
    doLocalAbility(abilityData);
  } else if (gameMode === 'online' && socket) {
    socket.emit('useAbility', { roomId, playerId: myPlayerId, abilityData });
  }
}

function doLocalAbility(abilityData) {
  const s = localState;
  const me = s.me;
  const ai = s._aiInternal;
  const opp = s.opponent;
  const cardId = abilityData.cardId;

  me.abilityUsed = me.abilityUsed || {};
  me.abilityUsed[cardId] = true;
  me.totalAbilityUses = (me.totalAbilityUses || 0) + 1;

  if (cardId === 'emperor') {
    if (abilityData.type === 'A') {
      const t = abilityData.target;
      ai.bannedCards = ai.bannedCards || [];
      ai.bannedCards.push({ card: t, turnsLeft: 3 });
      opp.bannedCards = [...ai.bannedCards];
      addLog('⚡ 勅命A: AIの' + cn(t) + 'を3ターン禁止！');
    } else {
      ai.forcedNextTurn = true;
      opp.forcedNextTurn = true;
      addLog('⚡ 勅命B: 次ターンAIは兵士か奴隷のみ！');
    }
  } else if (cardId === 'first_emperor') {
    me.greatWallActive = true; me.greatWallTurns = 3;
    addLog('⚡ 万里の長城発動！3ターン間あなたは負けない！');
  } else if (cardId === 'sniper') {
    const t = abilityData.target;
    ai.hand = (ai.hand || ALL_CARDS_LIST).filter(c => c !== t);
    ai.assassinated = ai.assassinated || [];
    ai.assassinated.push(t);
    opp.assassinated = [...ai.assassinated];
    opp.dead = [...(ai.dead || [])];
    ai.specialUnlocked = ((ai.dead || []).length + ai.assassinated.length) >= 2;
    opp.specialUnlocked = ai.specialUnlocked;
    opp.handCount = Math.max(0, (opp.handCount || 0) - 1);
    addLog('⚡ 暗殺: AIの' + cn(t) + 'を暗殺！(勝利条件外)');
  } else if (cardId === 'revolutionary') {
    const targets = abilityData.targets;
    targets.forEach(c => {
      const di = (me.dead || []).indexOf(c);
      if (di !== -1) {
        me.dead.splice(di, 1);
        opp.killCount = Math.max(0, (opp.killCount || 0) - 1);
      } else {
        const ai2 = (me.assassinated || []).indexOf(c);
        if (ai2 !== -1) me.assassinated.splice(ai2, 1);
      }
      me.hand.push(c);
      me.revived = me.revived || [];
      me.revived.push(c);
    });
    addLog('⚡ 革命: ' + targets.map(cn).join('、') + 'を復活！(勝利条件外)');
  }

  closeModal('modal-chokurei');
  closeModal('modal-card-select');
  closeModal('modal-revolution');
  revSelectedCards = [];

  s.pendingAbilityIndex = (s.pendingAbilityIndex || 0) + 1;
  renderDeadCards();
  setTimeout(() => advanceAbilityPhase(), 300);
  renderGame();
}

function skipAbilityUse() {
  const s = localState;
  if (!s) return;
  if (gameMode === 'ai') {
    s.pendingAbilityIndex = (s.pendingAbilityIndex || 0) + 1;
    setTimeout(() => advanceAbilityPhase(), 100);
  } else if (gameMode === 'online' && socket) {
    socket.emit('skipAbility', { roomId, playerId: myPlayerId });
  }
}

// ===================== 勅命A =====================
function doChokureiA(s) {
  // AI手札の推定（AIの死亡・暗殺カード以外）
  const ai = s._aiInternal;
  const avail = ALL_CARDS_LIST.filter(c => {
    if ((ai.dead || []).includes(c)) return false;
    if ((ai.assassinated || []).includes(c)) return false;
    if ((ai.bannedCards || []).some(b => b.card === c)) return false;
    return true;
  });

  const list = document.getElementById('modal-card-list');
  const title = document.getElementById('modal-card-title');
  title.textContent = '禁止するカードを選択（AIの手札推定）';
  list.innerHTML = '';

  avail.forEach(cid => {
    const div = document.createElement('div');
    div.className = 'modal-card-item';
    div.innerHTML = '<div>' + ce(cid) + '</div><div>' + cn(cid) + '</div>';
    div.onclick = () => {
      sendAbility({ cardId: 'emperor', type: 'A', target: cid });
      closeModal('modal-card-select');
    };
    list.appendChild(div);
  });
  openModal('modal-card-select');
}

function doChokureiB() {
  sendAbility({ cardId: 'emperor', type: 'B' });
}

// ===================== 暗殺モーダル =====================
function openAssassinModal(s) {
  const ai = s._aiInternal || {};
  const aiDead = [...(ai.dead || []), ...(ai.assassinated || [])];
  const targets = ALL_CARDS_LIST.filter(c => c !== 'slave' && !aiDead.includes(c));

  if (targets.length === 0) {
    addLog('暗殺できるカードがありません');
    sendAbility({ cardId: 'sniper', target: null });
    return;
  }

  const list = document.getElementById('modal-card-list');
  const title = document.getElementById('modal-card-title');
  title.textContent = '暗殺するカードを選択（奴隷不可）';
  list.innerHTML = '';

  targets.forEach(cid => {
    const div = document.createElement('div');
    div.className = 'modal-card-item';
    div.innerHTML = '<div>' + ce(cid) + '</div><div>' + cn(cid) + '</div>';
    div.onclick = () => {
      sendAbility({ cardId: 'sniper', target: cid });
      closeModal('modal-card-select');
    };
    list.appendChild(div);
  });
  openModal('modal-card-select');
}

// ===================== 革命モーダル =====================
function openRevModal(s) {
  revSelectedCards = [];
  document.getElementById('rev-selected-count').textContent = '0';
  document.getElementById('rev-confirm-btn').disabled = true;

  const allDead = [...(s.me.dead || []), ...(s.me.assassinated || [])];
  const list = document.getElementById('modal-revolution-list');
  list.innerHTML = '';

  allDead.forEach(cid => {
    const div = document.createElement('div');
    div.className = 'modal-card-item';
    div.innerHTML = '<div>' + ce(cid) + '</div><div>' + cn(cid) + '</div>';
    div.onclick = () => toggleRevCard(div, cid);
    list.appendChild(div);
  });
  openModal('modal-revolution');
}

function toggleRevCard(div, cardId) {
  const idx = revSelectedCards.indexOf(cardId);
  if (idx !== -1) {
    revSelectedCards.splice(idx, 1);
    div.classList.remove('selected');
  } else {
    if (revSelectedCards.length >= 2) return;
    revSelectedCards.push(cardId);
    div.classList.add('selected');
  }
  document.getElementById('rev-selected-count').textContent = revSelectedCards.length;
  document.getElementById('rev-confirm-btn').disabled = revSelectedCards.length < 2;
}

function confirmRevolution() {
  if (revSelectedCards.length < 2) return;
  sendAbility({ cardId: 'revolutionary', targets: [...revSelectedCards] });
  closeModal('modal-revolution');
}

// ===================== アリーナ表示 =====================
function showArenaCards(playerCard, aiCard, s) {
  const oppEl = document.getElementById('arena-opponent');
  const myEl = document.getElementById('arena-player');
  const oppIn = document.getElementById('arena-opp-inner');
  const myIn = document.getElementById('arena-player-inner');

  if (!oppEl || !myEl) return;

  const oppCardId = gameMode === 'online' ? aiCard : aiCard;
  const myCardId = playerCard;

  oppIn.innerHTML = '<div style="font-size:26px">' + ce(oppCardId) + '</div><div style="font-size:11px;margin-top:2px">' + cn(oppCardId) + '</div>';
  myIn.innerHTML = '<div style="font-size:26px">' + ce(myCardId) + '</div><div style="font-size:11px;margin-top:2px">' + cn(myCardId) + '</div>';

  oppEl.className = 'arena-card opponent-card animate-in';
  oppEl.classList.remove('hidden');
  myEl.className = 'arena-card player-card-arena animate-in';
  myEl.classList.remove('hidden');

  // バトル結果を少し遅らせて表示
  setTimeout(() => {
    const resultDiv = document.getElementById('battle-result-display');
    if (!resultDiv || !s || !s.log) return;
    let txt = '', cls = '';
    const logStr = s.log.join(' ');
    if (logStr.includes('相打ち')) { txt = '💥 相打ち！'; cls = 'result-mutual'; }
    else if (logStr.includes('引き分け')) { txt = '🤝 引き分け'; cls = 'result-draw'; }
    else if (logStr.includes('あなたの勝利') || logStr.includes('P1の勝利') && s.myId === 'p1' || logStr.includes('P2の勝利') && s.myId === 'p2') {
      txt = '🎉 あなたの勝ち！'; cls = 'result-win';
    } else if (logStr.includes('AIの勝利') || logStr.includes('P2の勝利') && s.myId === 'p1' || logStr.includes('P1の勝利') && s.myId === 'p2') {
      txt = '😞 負け'; cls = 'result-lose';
    }
    if (txt) {
      resultDiv.textContent = txt;
      resultDiv.className = 'battle-result ' + cls;
      resultDiv.classList.remove('hidden');
    }
    setTimeout(() => {
      if (resultDiv) resultDiv.classList.add('hidden');
      if (oppEl) oppEl.classList.add('hidden');
      if (myEl) myEl.classList.add('hidden');
    }, 1600);
  }, 600);
}

// ===================== ゲームオーバー =====================
function doGameOver(s) {
  setActionPanel('gameover');
  let isWin;
  if (gameMode === 'ai') {
    isWin = s.winner === 'p1';
  } else {
    isWin = s.winner === s.myId;
  }
  document.getElementById('gameover-text').textContent = isWin ? '🎉 あなたの勝利！' : '😞 敗北…';
}

function returnToTitle() {
  gameMode = null; localState = null; selectedCard = null;
  currentAbilityContext = null; revSelectedCards = [];
  if (socket) { socket.disconnect(); socket = null; }
  showScreen('title');
}

function restartGame() {
  if (gameMode === 'ai') {
    selectedCard = null; currentAbilityContext = null; revSelectedCards = [];
    clearLog();
    document.getElementById('battle-result-display').classList.add('hidden');
    document.getElementById('arena-opponent').classList.add('hidden');
    document.getElementById('arena-player').classList.add('hidden');
    document.getElementById('selected-card-display').classList.add('hidden');
    initLocalState();
    renderGame();
    addLog('ゲーム開始！カードを選んでください');
  } else {
    returnToTitle();
  }
}

// ===================== オンライン アリーナ =====================
function showArenaFromState(state) {
  const log0 = (state.log && state.log[0]) || '';
  // ログ形式: "ターンN: P1「カード名」 vs P2「カード名」"
  const m = log0.match(/P1「(.+?)」 vs P2「(.+?)」/);
  if (!m) return;
  const p1Name = m[1], p2Name = m[2];
  const myCardName = state.myId === 'p1' ? p1Name : p2Name;
  const oppCardName = state.myId === 'p1' ? p2Name : p1Name;
  const myCardId = nameToId(myCardName);
  const oppCardId = nameToId(oppCardName);
  if (myCardId && oppCardId) {
    showArenaCards(myCardId, oppCardId, state);
  }
}

// ===================== DOMContentLoaded =====================
document.addEventListener('DOMContentLoaded', () => {
  // 確定ボタンを動的生成
  const selectPanel = document.getElementById('action-select');
  if (selectPanel) {
    const btn = document.createElement('button');
    btn.id = 'confirm-btn';
    btn.className = 'btn btn-primary';
    btn.style.display = 'none';
    btn.textContent = '✓ 決定';
    btn.onclick = () => { if (selectedCard) confirmCardSelection(selectedCard); };
    selectPanel.appendChild(btn);
  }
  showScreen('title');
});

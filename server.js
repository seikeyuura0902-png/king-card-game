const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000
});

// --- 重要: 静的ファイルの設定 ---
// public フォルダを静的ファイルのルートとして指定
app.use(express.static(path.join(__dirname, 'public')));

// サイトのトップ (/) にアクセスしたときに index.html を返す
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ------------------------------

// ルーム管理
const rooms = {};
const waitingPlayers = [];

function createGameState() {
  const allCards = ['noble','general','soldier','citizen','slave','emperor','first_emperor','sniper','revolutionary'];
  return {
    players: {
      p1: {
        hand: [...allCards],
        dead: [],
        assassinated: [],
        revived: [],
        lastCard: null,
        specialUnlocked: false,
        bannedCards: [],      // [{card, turnsLeft}]
        forcedNextTurn: false, // 勅命B
        greatWallActive: false,
        greatWallTurns: 0,
        abilityUsed: {},      // { cardId: true }
        totalAbilityUses: 0,
        selectedCard: null,
        ready: false,
        killCount: 0,
        reviveCount: 0        // 革命で復活させたカード数
      },
      p2: {
        hand: [...allCards],
        dead: [],
        assassinated: [],
        revived: [],
        lastCard: null,
        specialUnlocked: false,
        bannedCards: [],
        forcedNextTurn: false,
        greatWallActive: false,
        greatWallTurns: 0,
        abilityUsed: {},
        totalAbilityUses: 0,
        selectedCard: null,
        ready: false,
        killCount: 0,
        reviveCount: 0
      }
    },
    turn: 0,
    phase: 'select',        // select | ability | gameover
    winner: null,
    log: [],
    pendingAbility: null,   // { playerId, cardId, abilityType }
    pendingAbilityStep: null // for multi-step abilities
  };
}

// バトル相性判定
function resolveBattle(c1, c2) {
  if (c1 === c2) return 'draw';
  const SPECIAL = ['emperor','first_emperor','sniper','revolutionary'];
  const s1 = SPECIAL.includes(c1);
  const s2 = SPECIAL.includes(c2);
  if ((c1 === 'noble' && c2 === 'soldier') || (c1 === 'soldier' && c2 === 'noble')) return 'mutual';
  if (c1 === 'slave' && s2) return 'p1';
  if (c2 === 'slave' && s1) return 'p2';
  if (s1 && s2) {
    const wins = {
      emperor: ['first_emperor'],
      first_emperor: ['sniper','revolutionary'],
      sniper: ['emperor'],
      revolutionary: ['emperor']
    };
    if (wins[c1] && wins[c1].includes(c2)) return 'p1';
    if (wins[c2] && wins[c2].includes(c1)) return 'p2';
    return 'draw';
  }
  if (s1 && !s2 && c2 !== 'slave') return 'p1';
  if (s2 && !s1 && c1 !== 'slave') return 'p2';
  const normalWins = {
    noble:   ['slave','general'],
    general: ['slave','soldier'],
    soldier: ['slave','citizen'],
    citizen: ['slave','noble','general'],
    slave:   []
  };
  if (normalWins[c1] && normalWins[c1].includes(c2)) return 'p1';
  if (normalWins[c2] && normalWins[c2].includes(c1)) return 'p2';
  return 'draw';
}

function applyGreatWall(result, gw1, gw2) {
  if (!gw1 && !gw2) return result;
  let r = result;
  if (gw1 && r === 'p2') r = 'draw';
  if (gw2 && r === 'p1') r = 'draw';
  if (gw1 && r === 'mutual') r = 'p1';
  if (gw2 && r === 'mutual') r = 'p2';
  if (gw1 && gw2 && result === 'mutual') r = 'draw';
  return r;
}

function getCardNameServer(cardId) {
  const names = {
    noble:'貴族',general:'将軍',soldier:'兵士',citizen:'市民',slave:'奴隷',
    emperor:'皇帝',first_emperor:'始皇帝',sniper:'狙撃手',revolutionary:'革命家'
  };
  return names[cardId] || cardId;
}

function processTurn(room) {
  const gs = room.gameState;
  const p1 = gs.players.p1;
  const p2 = gs.players.p2;
  const c1 = p1.selectedCard;
  const c2 = p2.selectedCard;
  gs.log = [];
  gs.log.push(`ターン${gs.turn+1}: P1「${getCardNameServer(c1)}」 vs P2「${getCardNameServer(c2)}」`);
  let rawResult = resolveBattle(c1, c2);
  let result = applyGreatWall(rawResult, p1.greatWallActive, p2.greatWallActive);
  if (p1.greatWallActive) {
    p1.greatWallTurns--;
    if (p1.greatWallTurns <= 0) { p1.greatWallActive = false; gs.log.push('P1の万里の長城が終了'); }
  }
  if (p2.greatWallActive) {
    p2.greatWallTurns--;
    if (p2.greatWallTurns <= 0) { p2.greatWallActive = false; gs.log.push('P2の万里の長城が終了'); }
  }
  let p1CardDies = false, p2CardDies = false;
  let p1Wins = false, p2Wins = false;
  if (result === 'p1') { p2CardDies = true; p1Wins = true; gs.log.push(`P1の勝利！ P2の${getCardNameServer(c2)}が死亡`); }
  else if (result === 'p2') { p1CardDies = true; p2Wins = true; gs.log.push(`P2の勝利！ P1の${getCardNameServer(c1)}が死亡`); }
  else if (result === 'mutual') { p1CardDies = true; p2CardDies = true; gs.log.push(`相打ち！ 両者の${getCardNameServer(c1)}と${getCardNameServer(c2)}が死亡`); }
  else { gs.log.push('引き分け！ 両者手札に戻る'); }
  p1.forcedNextTurn = false; p2.forcedNextTurn = false;
  p1.bannedCards = p1.bannedCards.map(b => ({...b, turnsLeft: b.turnsLeft-1})).filter(b => b.turnsLeft > 0);
  p2.bannedCards = p2.bannedCards.map(b => ({...b, turnsLeft: b.turnsLeft-1})).filter(b => b.turnsLeft > 0);
  const killCard = (player, card, isAssassination=false) => {
    player.hand = player.hand.filter(c => c !== card);
    if (isAssassination) { player.assassinated.push(card); }
    else {
      const revivedIdx = player.revived.indexOf(card);
      if (revivedIdx !== -1) { player.revived.splice(revivedIdx, 1); player.dead.push(card); player.killCount++; }
      else { player.dead.push(card); player.killCount++; }
    }
  };
  if (p1CardDies) killCard(p1, c1);
  if (p2CardDies) killCard(p2, c2);
  p1.specialUnlocked = (p1.dead.length + p1.assassinated.length) >= 2;
  p2.specialUnlocked = (p2.dead.length + p2.assassinated.length) >= 2;
  p1.lastCard = c1; p2.lastCard = c2;
  p1.selectedCard = null; p2.selectedCard = null;
  p1.ready = false; p2.ready = false;
  if (p1.killCount >= 6) { gs.winner = 'p1'; gs.phase = 'gameover'; gs.log.push('🎉 P1の勝利！'); return; }
  if (p2.killCount >= 6) { gs.winner = 'p2'; gs.phase = 'gameover'; gs.log.push('🎉 P2の勝利！'); return; }
  gs.turn++;
  const pendingAbilities = [];
  if (p1Wins && isSpecial(c1) && canUseAbility(p1, c1, gs)) pendingAbilities.push({ playerId: 'p1', cardId: c1 });
  if (p2Wins && isSpecial(c2) && canUseAbility(p2, c2, gs)) pendingAbilities.push({ playerId: 'p2', cardId: c2 });
  if (pendingAbilities.length > 0) { gs.phase = 'ability'; gs.pendingAbility = pendingAbilities; gs.pendingAbilityIndex = 0; }
  else { gs.phase = 'select'; }
}

function isSpecial(cardId) { return ['emperor','first_emperor','sniper','revolutionary'].includes(cardId); }
function canUseAbility(player, cardId, gs) {
  if (player.totalAbilityUses >= 2) return false;
  if (player.abilityUsed[cardId]) return false;
  if (cardId === 'revolutionary') { if ((player.dead.length + player.assassinated.length) < 3) return false; }
  return true;
}

function useAbility(room, playerId, abilityData) {
  const gs = room.gameState;
  const player = gs.players[playerId];
  const opponent = playerId === 'p1' ? gs.players.p2 : gs.players.p1;
  const cardId = abilityData.cardId;
  player.abilityUsed[cardId] = true;
  player.totalAbilityUses++;
  if (cardId === 'emperor') {
    if (abilityData.type === 'A') {
      const targetCard = abilityData.target;
      opponent.bannedCards.push({ card: targetCard, turnsLeft: 3 });
      gs.log.push(`⚡ 勅命A発動: P${playerId==='p1'?2:1}の${getCardNameServer(targetCard)}を3ターン禁止`);
    } else {
      opponent.forcedNextTurn = true;
      gs.log.push(`⚡ 勅命B発動: P${playerId==='p1'?2:1}は次ターン兵士か奴隷しか出せない`);
    }
  } else if (cardId === 'first_emperor') {
    player.greatWallActive = true; player.greatWallTurns = 3;
    gs.log.push(`⚡ 万里の長城発動: ${playerId==='p1'?'P1':'P2'}は3ターン間負けない`);
  } else if (cardId === 'sniper') {
    const targetCard = abilityData.target;
    opponent.hand = opponent.hand.filter(c => c !== targetCard);
    opponent.assassinated.push(targetCard);
    opponent.specialUnlocked = (opponent.dead.length + opponent.assassinated.length) >= 2;
    gs.log.push(`⚡ 暗殺発動: ${getCardNameServer(targetCard)}を暗殺`);
  } else if (cardId === 'revolutionary') {
    const targets = abilityData.targets;
    targets.forEach(card => {
      let idx = player.dead.indexOf(card);
      if (idx !== -1) { player.dead.splice(idx, 1); player.killCount = Math.max(0, player.killCount - 1); }
      else { idx = player.assassinated.indexOf(card); if (idx !== -1) player.assassinated.splice(idx, 1); }
      player.hand.push(card); player.revived.push(card);
    });
    gs.log.push(`⚡ 革命発動: ${targets.map(getCardNameServer).join('、')}を復活`);
  }
  gs.pendingAbilityIndex++;
  if (!gs.pendingAbility || gs.pendingAbilityIndex >= gs.pendingAbility.length) {
    gs.phase = 'select'; gs.pendingAbility = null; gs.pendingAbilityIndex = 0;
  }
}

function skipAbility(room, playerId) {
  const gs = room.gameState;
  gs.pendingAbilityIndex++;
  if (!gs.pendingAbility || gs.pendingAbilityIndex >= gs.pendingAbility.length) {
    gs.phase = 'select'; gs.pendingAbility = null; gs.pendingAbilityIndex = 0;
  }
}

function broadcastGameState(room) {
  const gs = room.gameState;
  if (room.sockets.p1) io.to(room.sockets.p1).emit('gameState', buildView(gs, 'p1'));
  if (room.sockets.p2) io.to(room.sockets.p2).emit('gameState', buildView(gs, 'p2'));
}

function buildView(gs, viewerId) {
  const opponentId = viewerId === 'p1' ? 'p2' : 'p1';
  const viewer = gs.players[viewerId];
  const opponent = gs.players[opponentId];
  return {
    myId: viewerId,
    me: {
      hand: viewer.hand, dead: viewer.dead, assassinated: viewer.assassinated, revived: viewer.revived,
      lastCard: viewer.lastCard, specialUnlocked: viewer.specialUnlocked, bannedCards: viewer.bannedCards,
      forcedNextTurn: viewer.forcedNextTurn, greatWallActive: viewer.greatWallActive, greatWallTurns: viewer.greatWallTurns,
      totalAbilityUses: viewer.totalAbilityUses, abilityUsed: viewer.abilityUsed, killCount: viewer.killCount, ready: viewer.ready
    },
    opponent: {
      handCount: opponent.hand.length, dead: opponent.dead, assassinated: opponent.assassinated,
      lastCard: opponent.lastCard, specialUnlocked: opponent.specialUnlocked, bannedCards: opponent.bannedCards,
      forcedNextTurn: opponent.forcedNextTurn, greatWallActive: opponent.greatWallActive, greatWallTurns: opponent.greatWallTurns,
      killCount: opponent.killCount, ready: opponent.ready
    },
    turn: gs.turn, phase: gs.phase, winner: gs.winner, log: gs.log,
    pendingAbility: gs.pendingAbility, pendingAbilityIndex: gs.pendingAbilityIndex || 0
  };
}

io.on('connection', (socket) => {
  socket.on('findMatch', (data) => {
    const playerName = data?.name || 'プレイヤー';
    if (waitingPlayers.length > 0) {
      const opponent = waitingPlayers.shift();
      const roomId = `room_${Date.now()}`;
      rooms[roomId] = { id: roomId, sockets: { p1: opponent.socketId, p2: socket.id }, names: { p1: opponent.name, p2: playerName }, gameState: createGameState() };
      socket.join(roomId);
      io.sockets.sockets.get(opponent.socketId)?.join(roomId);
      socket.emit('matched', { roomId, playerId: 'p2', opponentName: opponent.name });
      io.to(opponent.socketId).emit('matched', { roomId, playerId: 'p1', opponentName: playerName });
      broadcastGameState(rooms[roomId]);
    } else {
      waitingPlayers.push({ socketId: socket.id, name: playerName });
      socket.emit('waiting');
    }
  });

  socket.on('selectCard', (data) => {
    const { roomId, playerId, cardId } = data;
    const room = rooms[roomId]; if (!room) return;
    const gs = room.gameState; if (gs.phase !== 'select') return;
    const player = gs.players[playerId]; if (!player || !player.hand.includes(cardId) || player.lastCard === cardId) return;
    if (player.bannedCards.some(b => b.card === cardId)) return;
    if (player.forcedNextTurn && cardId !== 'soldier' && cardId !== 'slave') return;
    if (!player.specialUnlocked && isSpecial(cardId)) return;
    if (cardId === 'revolutionary' && (player.dead.length + player.assassinated.length) < 3) return;

    player.selectedCard = cardId;
    player.ready = true;
    socket.emit('cardSelected', { cardId, playerId });
    if (gs.players.p1.ready && gs.players.p2.ready) { processTurn(room); broadcastGameState(room); }
    else {
      const opponentSocketId = playerId === 'p1' ? room.sockets.p2 : room.sockets.p1;
      io.to(opponentSocketId).emit('opponentReady');
      broadcastGameState(room);
    }
  });

  socket.on('useAbility', (data) => {
    const { roomId, playerId, abilityData } = data;
    const room = rooms[roomId]; if (!room) return;
    const gs = room.gameState; if (gs.phase !== 'ability') return;
    const currentAbility = gs.pendingAbility && gs.pendingAbility[gs.pendingAbilityIndex || 0];
    if (!currentAbility || currentAbility.playerId !== playerId) return;
    useAbility(room, playerId, abilityData);
    checkWinner(room);
    broadcastGameState(room);
  });

  socket.on('skipAbility', (data) => {
    const { roomId, playerId } = data;
    const room = rooms[roomId]; if (!room) return;
    const gs = room.gameState; if (gs.phase !== 'ability') return;
    const currentAbility = gs.pendingAbility && gs.pendingAbility[gs.pendingAbilityIndex || 0];
    if (!currentAbility || currentAbility.playerId !== playerId) return;
    skipAbility(room, playerId);
    broadcastGameState(room);
  });

  socket.on('disconnect', () => {
    const idx = waitingPlayers.findIndex(p => p.socketId === socket.id);
    if (idx !== -1) waitingPlayers.splice(idx, 1);
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.sockets.p1 === socket.id || room.sockets.p2 === socket.id) {
        const opponentSocketId = room.sockets.p1 === socket.id ? room.sockets.p2 : room.sockets.p1;
        io.to(opponentSocketId).emit('opponentDisconnected');
        delete rooms[roomId]; break;
      }
    }
  });
});

function checkWinner(room) {
  const gs = room.gameState;
  if (gs.players.p1.killCount >= 6) { gs.winner = 'p1'; gs.phase = 'gameover'; }
  else if (gs.players.p2.killCount >= 6) { gs.winner = 'p2'; gs.phase = 'gameover'; }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`サーバーがポート ${PORT} で起動しました`);
});

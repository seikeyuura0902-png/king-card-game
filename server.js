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

// 静的ファイルの設定（index.html がルートにある場合）
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

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
    phase: 'select',
    winner: null,
    log: [],
    pendingAbility: null,
    pendingAbilityIndex: 0
  };
}

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
  let result = applyGreatWall(resolveBattle(c1, c2), p1.greatWallActive, p2.greatWallActive);
  
  if (p1.greatWallActive) { p1.greatWallTurns--; if (p1.greatWallTurns <= 0) p1.greatWallActive = false; }
  if (p2.greatWallActive) { p2.greatWallTurns--; if (p2.greatWallTurns <= 0) p2.greatWallActive = false; }

  let p1CardDies = false, p2CardDies = false;
  let p1Wins = false, p2Wins = false;

  if (result === 'p1') { p2CardDies = true; p1Wins = true; gs.log.push(`P1の勝利！ P2の${getCardNameServer(c2)}が死亡`); }
  else if (result === 'p2') { p1CardDies = true; p2Wins = true; gs.log.push(`P2の勝利！ P1の${getCardNameServer(c1)}が死亡`); }
  else if (result === 'mutual') { p1CardDies = true; p2CardDies = true; gs.log.push(`相打ち！`); }
  else { gs.log.push('引き分け！'); }

  const killCard = (player, card) => {
    player.hand = player.hand.filter(c => c !== card);
    player.dead.push(card);
    player.killCount++;
  };

  if (p1CardDies) killCard(p1, c1);
  if (p2CardDies) killCard(p2, c2);

  p1.specialUnlocked = (p1.dead.length + p1.assassinated.length) >= 2;
  p2.specialUnlocked = (p2.dead.length + p2.assassinated.length) >= 2;
  p1.lastCard = c1; p2.lastCard = c2;
  p1.selectedCard = null; p2.selectedCard = null;
  p1.ready = false; p2.ready = false;

  if (p1.killCount >= 6) { gs.winner = 'p1'; gs.phase = 'gameover'; return; }
  if (p2.killCount >= 6) { gs.winner = 'p2'; gs.phase = 'gameover'; return; }
  
  gs.turn++;
  gs.phase = 'select';
}

io.on('connection', (socket) => {
  socket.on('findMatch', (data) => {
    const playerName = data?.name || 'プレイヤー';
    if (waitingPlayers.length > 0) {
      const opponent = waitingPlayers.shift();
      const roomId = `room_${Date.now()}`;
      rooms[roomId] = { id: roomId, sockets: { p1: opponent.socketId, p2: socket.id }, gameState: createGameState() };
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
    const gs = room.gameState;
    const player = gs.players[playerId];
    player.selectedCard = cardId;
    player.ready = true;
    if (gs.players.p1.ready && gs.players.p2.ready) { processTurn(room); }
    broadcastGameState(room);
  });
});

function broadcastGameState(room) {
  const gs = room.gameState;
  io.to(room.id).emit('gameState', gs);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = {};
const waitingPlayers = [];

// --- バトル判定ロジック ---
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
    noble:['slave','general'], 
    general:['slave','soldier'], 
    soldier:['slave','citizen'], 
    citizen:['slave','noble','general'], 
    slave:[] 
  };
  if (normalWins[c1] && normalWins[c1].includes(c2)) return 'p1';
  if (normalWins[c2] && normalWins[c2].includes(c1)) return 'p2';
  return 'draw';
}

function createGameState(p1Name, p2Name) {
  const ALL = ['noble','general','soldier','citizen','slave','emperor','first_emperor','sniper','revolutionary'];
  const createPlayer = (name) => ({
    name: name, hand: [...ALL], dead: [], assassinated: [], revived: [],
    lastCard: null, specialUnlocked: false, bannedCards: [], forcedNextTurn: false,
    greatWallActive: false, greatWallTurns: 0, killCount: 0, ready: false, selectedCard: null
  });
  return { players: { p1: createPlayer(p1Name), p2: createPlayer(p2Name) }, turn: 0, phase: 'select', log: [] };
}

io.on('connection', (socket) => {
  socket.on('findMatch', (data) => {
    const name = data?.name || 'プレイヤー';
    if (waitingPlayers.length > 0) {
      const opp = waitingPlayers.shift();
      const roomId = `room_${Date.now()}`;
      rooms[roomId] = { id: roomId, sockets: { p1: opp.socketId, p2: socket.id }, gameState: createGameState(opp.name, name) };
      socket.join(roomId);
      io.sockets.sockets.get(opp.socketId)?.join(roomId);
      socket.emit('matched', { roomId, playerId: 'p2', opponentName: opp.name });
      io.to(opp.socketId).emit('matched', { roomId, playerId: 'p1', opponentName: name });
      broadcastGameState(rooms[roomId]);
    } else {
      waitingPlayers.push({ socketId: socket.id, name: name });
      socket.emit('waiting');
    }
  });

  socket.on('selectCard', (data) => {
    const { roomId, playerId, cardId } = data;
    const room = rooms[roomId]; if (!room) return;
    const gs = room.gameState;
    const p = gs.players[playerId];
    if (!p || p.ready) return;

    p.selectedCard = cardId;
    p.ready = true;
    
    const oppId = (playerId === 'p1' ? 'p2' : 'p1');
    io.to(room.sockets[oppId]).emit('opponentReady');

    if (gs.players.p1.ready && gs.players.p2.ready) {
      // --- バトル実行 ---
      const p1 = gs.players.p1;
      const p2 = gs.players.p2;
      const res = resolveBattle(p1.selectedCard, p2.selectedCard);
      
      gs.log = [`ターン${gs.turn + 1}: P1「${p1.selectedCard}」 vs P2「${p2.selectedCard}」`];

      if (res === 'p1') {
        p2.hand = p2.hand.filter(c => c !== p2.selectedCard);
        p2.dead.push(p2.selectedCard);
        p1.killCount++;
        gs.log.push("P1の勝利！");
      } else if (res === 'p2') {
        p1.hand = p1.hand.filter(c => c !== p1.selectedCard);
        p1.dead.push(p1.selectedCard);
        p2.killCount++;
        gs.log.push("P2の勝利！");
      } else if (res === 'mutual') {
        p1.hand = p1.hand.filter(c => c !== p1.selectedCard);
        p2.hand = p2.hand.filter(c => c !== p2.selectedCard);
        p1.dead.push(p1.selectedCard);
        p2.dead.push(p2.selectedCard);
        gs.log.push("相打ち！");
      } else {
        gs.log.push("引き分け！");
      }

      // 解禁判定
      p1.specialUnlocked = (p1.dead.length + p1.assassinated.length) >= 2;
      p2.specialUnlocked = (p2.dead.length + p2.assassinated.length) >= 2;

      // 1.5秒後に次ターンへ（アニメーション時間を考慮）
      setTimeout(() => {
        gs.turn++;
        p1.ready = false; p2.ready = false;
        p1.selectedCard = null; p2.selectedCard = null;
        broadcastGameState(room);
      }, 1500);
    }
    broadcastGameState(room);
  });
});

function broadcastGameState(room) {
  const gs = room.gameState;
  const send = (myId, oppId) => {
    const my = gs.players[myId];
    const op = gs.players[oppId];
    return {
      myId: myId, turn: gs.turn, phase: gs.phase,
      me: { ...my },
      opponent: { 
        name: op.name, handCount: op.hand.length, dead: op.dead, 
        assassinated: op.assassinated, revived: op.revived, 
        ready: op.ready, killCount: op.killCount, 
        specialUnlocked: op.specialUnlocked, greatWallActive: op.greatWallActive 
      },
      log: gs.log
    };
  };
  if (room.sockets.p1) io.to(room.sockets.p1).emit('gameState', send('p1', 'p2'));
  if (room.sockets.p2) io.to(room.sockets.p2).emit('gameState', send('p2', 'p1'));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

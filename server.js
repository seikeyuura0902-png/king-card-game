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

// game.js の initLocalState と同じ構造で初期化
function createGameState(p1Name, p2Name) {
  const ALL = ['noble','general','soldier','citizen','slave','emperor','first_emperor','sniper','revolutionary'];
  const createPlayer = (name) => ({
    name: name,
    hand: [...ALL],
    dead: [], assassinated: [], revived: [],
    lastCard: null, specialUnlocked: false,
    bannedCards: [], forcedNextTurn: false,
    greatWallActive: false, greatWallTurns: 0,
    killCount: 0, ready: false, selectedCard: null
  });

  return {
    players: { p1: createPlayer(p1Name), p2: createPlayer(p2Name) },
    turn: 0,
    phase: 'select',
    log: []
  };
}

io.on('connection', (socket) => {
  socket.on('findMatch', (data) => {
    const name = data?.name || 'プレイヤー';
    if (waitingPlayers.length > 0) {
      const opp = waitingPlayers.shift();
      const roomId = `room_${Date.now()}`;
      rooms[roomId] = { 
        id: roomId, 
        sockets: { p1: opp.socketId, p2: socket.id }, 
        gameState: createGameState(opp.name, name) 
      };
      
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

    // 相手に「準備完了」を通知 (game.js の opponentReady 用)
    const oppId = (playerId === 'p1' ? 'p2' : 'p1');
    io.to(room.sockets[oppId]).emit('opponentReady');

    if (gs.players.p1.ready && gs.players.p2.ready) {
      // 本来はここに詳細なバトルロジックが必要ですが、まずは同期のためにターン進行
      // 詳細ロジックは game.js の processAIBattle と同様のものをサーバーに移植可能
      setTimeout(() => {
        gs.turn++;
        gs.players.p1.ready = false;
        gs.players.p2.ready = false;
        gs.players.p1.selectedCard = null;
        gs.players.p2.selectedCard = null;
        broadcastGameState(room);
      }, 1000);
    }
    broadcastGameState(room);
  });
});

function broadcastGameState(room) {
  const gs = room.gameState;
  const send = (myId, oppId) => {
    const my = gs.players[myId];
    const op = gs.players[oppId];
    // game.js が受信した時に localState = state として扱う構造
    return {
      myId: myId,
      turn: gs.turn,
      phase: gs.phase,
      me: { ...my },
      opponent: {
        name: op.name,
        handCount: op.hand.length,
        dead: op.dead,
        assassinated: op.assassinated,
        revived: op.revived,
        ready: op.ready,
        killCount: op.killCount,
        specialUnlocked: op.specialUnlocked,
        greatWallActive: op.greatWallActive
      },
      log: gs.log
    };
  };

  io.to(room.sockets.p1).emit('gameState', send('p1', 'p2'));
  io.to(room.sockets.p2).emit('gameState', send('p2', 'p1'));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

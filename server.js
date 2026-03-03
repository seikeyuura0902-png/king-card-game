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

// 判定用の標準化関数（大文字・小文字・拡張子の違いを無視して比較する）
function normalize(name) {
  return String(name || "").toLowerCase().replace('.png', '').trim();
}

function resolveBattle(c1, c2) {
  const s1 = normalize(c1);
  const s2 = normalize(c2);
  if (s1 === s2) return 'draw';

  const specs = ['emperor', 'first_emperor', 'sniper', 'revolutionary'];
  const isSpec = (s) => specs.some(k => s.includes(k));

  // 奴隷の特殊勝利
  if (s1.includes('slave') && isSpec(s2)) return 'p1';
  if (s2.includes('slave') && isSpec(s1)) return 'p2';

  // 特殊カード vs 通常カード
  if (isSpec(s1) && !isSpec(s2)) return 'p1';
  if (isSpec(s2) && !isSpec(s1)) return 'p2';
  if (isSpec(s1) && isSpec(s2)) return 'draw';

  // 通常カードの強さ
  const getS = (s) => {
    if (s.includes('noble')) return 4;
    if (s.includes('general')) return 3;
    if (s.includes('soldier')) return 2;
    if (s.includes('citizen')) return 1;
    return 0;
  };
  const sc1 = getS(s1);
  const sc2 = getS(s2);
  return sc1 > sc2 ? 'p1' : (sc1 < sc2 ? 'p2' : 'draw');
}

io.on('connection', (socket) => {
  socket.on('findMatch', (data) => {
    const name = data?.name || 'プレイヤー';
    if (waitingPlayers.length > 0) {
      const opp = waitingPlayers.shift();
      const roomId = `room_${Date.now()}`;
      
      const createP = (n) => ({
        name: n,
        // 【注意】あなたの画像ファイル名が「Emperor.png」なら、ここも「Emperor」と大文字にしてください
        hand: ['noble', 'general', 'soldier', 'citizen', 'slave', 'emperor', 'first_emperor', 'sniper', 'revolutionary'],
        dead: [], assassinated: [], usedSpecial: [], killCount: 0, ready: false, selectedCard: null
      });
      
      rooms[roomId] = {
        id: roomId,
        sockets: { p1: opp.socketId, p2: socket.id },
        gameState: { players: { p1: createP(opp.name), p2: createP(name) }, turn: 1, phase: 'select', pendingAbility: [] }
      };
      
      socket.join(roomId);
      io.sockets.sockets.get(opp.socketId)?.join(roomId);
      socket.emit('matched', { roomId, playerId: 'p2', opponentName: opp.name });
      io.to(opp.socketId).emit('matched', { roomId, playerId: 'p1', opponentName: name });
    } else {
      waitingPlayers.push({ socketId: socket.id, name: name });
      socket.emit('waiting');
    }
  });

  socket.on('selectCard', (data) => {
    const room = rooms[data.roomId]; 
    if (!room || room.gameState.phase !== 'select') return;
    const gs = room.gameState;
    const me = gs.players[data.playerId];
    
    me.selectedCard = data.cardId;
    me.ready = true;

    if (gs.players.p1.ready && gs.players.p2.ready) {
      const p1 = gs.players.p1;
      const p2 = gs.players.p2;
      const res = resolveBattle(p1.selectedCard, p2.selectedCard);
      let winId = null;

      if (res === 'p1') {
        p2.hand = p2.hand.filter(c => c !== p2.selectedCard);
        p2.dead.push(p2.selectedCard);
        p1.killCount++;
        winId = 'p1';
      } else if (res === 'p2') {
        p1.hand = p1.hand.filter(c => c !== p1.selectedCard);
        p1.dead.push(p1.selectedCard);
        p2.killCount++;
        winId = 'p2';
      } else {
        // 引き分け時は両方消える（ルールに合わせて変更可）
        p1.hand = p1.hand.filter(c => c !== p1.selectedCard); p1.dead.push(p1.selectedCard);
        p2.hand = p2.hand.filter(c => c !== p2.selectedCard); p2.dead.push(p2.selectedCard);
      }

      // --- 能力発動チェック ---
      if (winId) {
        const winner = gs.players[winId];
        const sName = normalize(winner.selectedCard);
        const specList = {
          'emperor': 'emp', 'first_emperor': 'first', 'sniper': 'snip', 'revolutionary': 'revo'
        };
        const key = Object.keys(specList).find(k => sName.includes(k));

        if (key && !winner.usedSpecial.includes(key)) {
          const deadTotal = winner.dead.length + (winner.assassinated ? winner.assassinated.length : 0);
          let canUse = false;

          if (key === 'revolutionary') {
            if (deadTotal >= 3) canUse = true; // 革命家は3枚条件
          } else {
            if (deadTotal >= 2) canUse = true; // その他は2枚条件
          }

          if (canUse) {
            gs.phase = 'ability';
            gs.pendingAbility = [{ playerId: winId, cardId: winner.selectedCard }];
            winner.usedSpecial.push(key);
          }
        }
      }

      setTimeout(() => {
        if (gs.phase !== 'ability') {
          gs.turn++;
          p1.ready = false; p2.ready = false;
          p1.selectedCard = null; p2.selectedCard = null;
        }
        broadcastGameState(room);
      }, 1000);
    }
    broadcastGameState(room);
  });
  
  // (useAbility イベントは省略せず、前のロジックを維持)
});

function broadcastGameState(room) {
  const gs = room.gameState;
  Object.keys(room.sockets).forEach(pk => {
    const me = gs.players[pk];
    const op = gs.players[pk === 'p1' ? 'p2' : 'p1'];
    io.to(room.sockets[pk]).emit('gameState', {
      myId: pk, phase: gs.phase, turn: gs.turn,
      me: me, 
      opponent: { 
        name: op.name, handCount: op.hand.length, 
        dead: op.dead, killCount: op.killCount, ready: op.ready 
      },
      pendingAbility: gs.pendingAbility
    });
  });
}

server.listen(3000, () => console.log('Fundamental Game System Online'));

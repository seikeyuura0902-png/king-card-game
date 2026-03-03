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

// 内部判定用キーワード（ここに含まれる文字があれば特殊カードとみなす）
const KEYS = {
  EMP: 'emperor',
  FIRST: 'first_emperor',
  SNIP: 'sniper',
  REVO: 'revolutionary',
  SLAVE: 'slave'
};

// バトル判定（表示用のカード名を壊さないよう、比較時のみ小文字化）
function resolveBattle(c1_orig, c2_orig) {
  const s1 = String(c1_orig).toLowerCase();
  const s2 = String(c2_orig).toLowerCase();
  if (s1 === s2) return 'draw';

  const isSpec = (s) => [KEYS.EMP, KEYS.FIRST, KEYS.SNIP, KEYS.REVO].some(k => s.includes(k));

  if (s1.includes(KEYS.SLAVE) && isSpec(s2)) return 'p1';
  if (s2.includes(KEYS.SLAVE) && isSpec(s1)) return 'p2';
  if (isSpec(s1) && isSpec(s2)) return 'draw';
  if (isSpec(s1)) return 'p1';
  if (isSpec(s2)) return 'p2';

  const getScore = (s) => {
    if (s.includes('noble')) return 4;
    if (s.includes('general')) return 3;
    if (s.includes('soldier')) return 2;
    if (s.includes('citizen')) return 1;
    return 0;
  };
  const sc1 = getScore(s1);
  const sc2 = getScore(s2);
  if (sc1 > sc2) return 'p1';
  if (sc2 > sc1) return 'p2';
  return 'draw';
}

io.on('connection', (socket) => {
  socket.on('findMatch', (data) => {
    const name = data?.name || 'プレイヤー';
    if (waitingPlayers.length > 0) {
      const opp = waitingPlayers.shift();
      const roomId = `room_${Date.now()}`;
      const createP = (n) => ({
        name: n,
        // 初期手札の名前は HTML/CSS/JS で指定されているものに合わせる
        hand: ['noble', 'general', 'soldier', 'citizen', 'slave', 'emperor', 'first_emperor', 'sniper', 'revolutionary'],
        dead: [], assassinated: [], usedSpecial: [], killCount: 0, ready: false, selectedCard: null, greatWallActive: false
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
    const room = rooms[data.roomId]; if (!room || room.gameState.phase !== 'select') return;
    const gs = room.gameState; const me = gs.players[data.playerId];
    if (me.ready) return;

    // 重要：data.cardId は画像表示に使うため、そのまま保存する
    me.selectedCard = data.cardId; 
    me.ready = true;

    const p1 = gs.players.p1; const p2 = gs.players.p2;
    if (p1.ready && p2.ready) {
      let res = resolveBattle(p1.selectedCard, p2.selectedCard);
      if (res === 'p2' && p1.greatWallActive) res = 'draw';
      if (res === 'p1' && p2.greatWallActive) res = 'draw';

      let winId = null;
      if (res === 'p1') { 
        p2.hand = p2.hand.filter(c => c !== p2.selectedCard); 
        p2.dead.push(p2.selectedCard); p1.killCount++; winId = 'p1'; 
      } else if (res === 'p2') { 
        p1.hand = p1.hand.filter(c => c !== p1.selectedCard); 
        p1.dead.push(p1.selectedCard); p2.killCount++; winId = 'p2'; 
      }

      // --- 能力発動条件の判定 ---
      if (winId) {
        const winner = gs.players[winId];
        const sName = String(winner.selectedCard).toLowerCase();
        const key = [KEYS.EMP, KEYS.FIRST, KEYS.SNIP, KEYS.REVO].find(k => sName.includes(k));

        if (key && !winner.usedSpecial.includes(key)) {
          // 墓地の枚数を確認（dead + assassinated）
          const totalDead = (winner.dead ? winner.dead.length : 0) + (winner.assassinated ? winner.assassinated.length : 0);
          let trigger = false;

          if (key === KEYS.REVO) {
            if (totalDead >= 3) trigger = true; // 革命家は3枚
          } else {
            if (totalDead >= 2) trigger = true; // その他は2枚
          }

          if (trigger) {
            gs.phase = 'ability';
            gs.pendingAbility = [{ playerId: winId, cardId: winner.selectedCard }];
            winner.usedSpecial.push(key);
          }
        }
      }

      if (p1.killCount >= 6 || p2.killCount >= 6) gs.phase = 'gameover';

      setTimeout(() => {
        if (gs.phase !== 'ability' && gs.phase !== 'gameover') {
          gs.turn++; p1.ready = false; p2.ready = false;
          p1.selectedCard = null; p2.selectedCard = null;
        }
        broadcastGameState(room);
      }, 1200);
    }
    broadcastGameState(room);
  });

  socket.on('useAbility', (data) => {
    const room = rooms[data.roomId]; if (!room) return;
    const gs = room.gameState;
    const me = gs.players[data.playerId];
    const opp = gs.players[data.playerId === 'p1' ? 'p2' : 'p1'];
    const ab = data.abilityData;

    if (ab && ab.cardId) {
      const c = String(ab.cardId).toLowerCase();
      if (c.includes(KEYS.EMP)) {
        if (ab.type === 'A') opp.bannedCards.push({ card: ab.target, turnsLeft: 3 });
        else opp.forcedNextTurn = true;
      } else if (c.includes(KEYS.SNIP)) {
        opp.hand = opp.hand.filter(h => h !== ab.target);
        opp.assassinated.push(ab.target);
      } else if (c.includes(KEYS.FIRST)) {
        me.greatWallActive = true;
      } else if (c.includes(KEYS.REVO)) {
        const targets = Array.isArray(ab.targets) ? ab.targets : (ab.target ? [ab.target] : []);
        targets.forEach(t => {
          let idx = me.dead.indexOf(t);
          if (idx !== -1) { 
            me.dead.splice(idx, 1); if (opp.killCount > 0) opp.killCount--; 
          } else {
            idx = (me.assassinated || []).indexOf(t);
            if (idx !== -1) me.assassinated.splice(idx, 1);
          }
          me.hand.push(t);
        });
      }
    }
    gs.phase = 'select'; gs.turn++;
    gs.players.p1.ready = false; gs.players.p2.ready = false;
    gs.players.p1.selectedCard = null; gs.players.p2.selectedCard = null;
    gs.pendingAbility = [];
    broadcastGameState(room);
  });
});

function broadcastGameState(room) {
  const gs = room.gameState;
  Object.keys(room.sockets).forEach(pk => {
    const me = gs.players[pk]; const op = gs.players[pk === 'p1' ? 'p2' : 'p1'];
    io.to(room.sockets[pk]).emit('gameState', {
      myId: pk, turn: gs.turn, phase: gs.phase, me: me,
      opponent: { name: op.name, hand: op.hand, handCount: op.hand.length, dead: op.dead, killCount: op.killCount, ready: op.ready },
      pendingAbility: gs.pendingAbility,
      gameResult: gs.phase === 'gameover' ? (me.killCount >= 6 ? 'WIN' : 'LOSE') : null
    });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Fixed: Image & Logic`));

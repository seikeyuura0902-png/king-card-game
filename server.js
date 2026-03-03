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

// 特殊カードのキーワード（送られてきた文字にこれらが含まれていれば能力発動）
const SPEC_KEYS = ['emperor', 'first', 'sniper', 'revolut', '皇帝', '始皇帝', '狙撃', '革命'];

function resolveBattle(c1, c2) {
  const s1 = String(c1).toLowerCase();
  const s2 = String(c2).toLowerCase();
  if (s1 === s2) return 'draw';

  const isS = (c) => SPEC_KEYS.some(k => c.includes(k));

  // 奴隷のジャイアントキリング
  if ((s1.includes('slave') || s1.includes('奴隷')) && isS(s2)) return 'p1';
  if ((s2.includes('slave') || s2.includes('奴隷')) && isS(s1)) return 'p2';

  // 特殊カード同士
  if (isS(s1) && isS(s2)) return 'draw';
  // 特殊カード vs 通常カード
  if (isS(s1)) return 'p1';
  if (isS(s2)) return 'p2';

  // 通常カードの強さ
  const getP = (s) => {
    if (s.includes('noble') || s.includes('貴族')) return 4;
    if (s.includes('general') || s.includes('将軍')) return 3;
    if (s.includes('soldier') || s.includes('兵士')) return 2;
    if (s.includes('citizen') || s.includes('市民')) return 1;
    return 0;
  };
  if (getP(s1) > getP(s2)) return 'p1';
  if (getP(s2) > getP(s1)) return 'p2';
  return 'draw';
}

function createGameState(p1Name, p2Name) {
  const ALL = ['noble', 'general', 'soldier', 'citizen', 'slave', 'emperor', 'first_emperor', 'sniper', 'revolutionary'];
  const pData = (n) => ({
    name: n, hand: [...ALL], dead: [], assassinated: [], usedSpecial: [],
    killCount: 0, ready: false, selectedCard: null, bannedCards: [], greatWallActive: false
  });
  return { players: { p1: pData(p1Name), p2: pData(p2Name) }, turn: 0, phase: 'select', log: [] };
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
    } else {
      waitingPlayers.push({ socketId: socket.id, name: name });
      socket.emit('waiting');
    }
  });

  socket.on('selectCard', (data) => {
    const room = rooms[data.roomId]; if (!room) return;
    const gs = room.gameState;
    const me = gs.players[data.playerId];
    if (me.ready) return;

    me.selectedCard = data.cardId;
    me.ready = true;

    const p1 = gs.players.p1; const p2 = gs.players.p2;
    if (p1.ready && p2.ready) {
      let res = resolveBattle(p1.selectedCard, p2.selectedCard);
      
      // 万里の長城
      if (res === 'p2' && p1.greatWallActive) res = 'draw';
      if (res === 'p1' && p2.greatWallActive) res = 'draw';

      let winId = null;
      if (res === 'p1') { p2.hand = p2.hand.filter(c => c !== p2.selectedCard); p2.dead.push(p2.selectedCard); p1.killCount++; winId = 'p1'; }
      else if (res === 'p2') { p1.hand = p1.hand.filter(c => c !== p1.selectedCard); p1.dead.push(p1.selectedCard); p2.killCount++; winId = 'p2'; }
      else if (res === 'mutual') {
        p1.hand = p1.hand.filter(c => c !== p1.selectedCard); p1.dead.push(p1.selectedCard);
        p2.hand = p2.hand.filter(c => c !== p2.selectedCard); p2.dead.push(p2.selectedCard);
      }

      // 【重要】特殊能力判定：文字列が含まれているかチェック
      if (winId) {
        const cardName = String(gs.players[winId].selectedCard).toLowerCase();
        const isSpec = SPEC_KEYS.some(k => cardName.includes(k));
        
        // 1回制限：usedSpecialにそのキーワードが含まれていないか
        const alreadyUsed = gs.players[winId].usedSpecial.some(k => cardName.includes(k));

        if (isSpec && !alreadyUsed) {
          gs.phase = 'ability';
          gs.pendingAbility = [{ playerId: winId, cardId: gs.players[winId].selectedCard }];
          gs.players[winId].usedSpecial.push(cardName); // ここで即座に使用済みリストへ
        }
      }

      if (p1.killCount >= 6 || p2.killCount >= 6) gs.phase = 'gameover';

      setTimeout(() => {
        if (gs.phase !== 'ability' && gs.phase !== 'gameover') {
          gs.turn++; p1.ready = false; p2.ready = false; p1.selectedCard = null; p2.selectedCard = null;
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
      if (c.includes('emp') || c.includes('皇帝')) {
        if (ab.type === 'A') opp.bannedCards.push({ card: ab.target, turnsLeft: 3 });
        else opp.forcedNextTurn = true;
      } else if (c.includes('snip') || c.includes('狙撃')) {
        opp.hand = opp.hand.filter(h => h !== ab.target);
        opp.assassinated.push(ab.target);
      } else if (c.includes('first') || c.includes('始皇帝')) {
        me.greatWallActive = true;
      } else if (c.includes('revol') || c.includes('革命')) {
        const ts = Array.isArray(ab.targets) ? ab.targets : [ab.target];
        ts.forEach(t => {
          let i = me.dead.indexOf(t);
          if (i !== -1) { me.dead.splice(i, 1); if(opp.killCount > 0) opp.killCount--; }
          else { i = (me.assassinated||[]).indexOf(t); if(i !== -1) me.assassinated.splice(i, 1); }
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
    const me = gs.players[pk];
    const op = gs.players[pk === 'p1' ? 'p2' : 'p1'];
    io.to(room.sockets[pk]).emit('gameState', {
      myId: pk, turn: gs.turn, phase: gs.phase,
      me: me, 
      opponent: { name: op.name, hand: op.hand, handCount: op.hand.length, dead: op.dead, killCount: op.killCount },
      pendingAbility: gs.pendingAbility,
      gameResult: gs.phase === 'gameover' ? (me.killCount >= 6 ? 'WIN' : 'LOSE') : null
    });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Run`));

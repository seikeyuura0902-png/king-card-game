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

// バトル相性ロジック
function resolveBattle(c1, c2) {
  if (c1 === c2) return 'draw';
  const SPECIAL = ['emperor', 'first_emperor', 'sniper', 'revolutionary'];
  if ((c1 === 'noble' && c2 === 'soldier') || (c1 === 'soldier' && c2 === 'noble')) return 'mutual';
  if (c1 === 'slave' && SPECIAL.includes(c2)) return 'p1';
  if (c2 === 'slave' && SPECIAL.includes(c1)) return 'p2';
  
  if (SPECIAL.includes(c1) && SPECIAL.includes(c2)) {
    const wins = { emperor:['first_emperor'], first_emperor:['sniper','revolutionary'], sniper:['emperor'], revolutionary:['emperor'] };
    if (wins[c1]?.includes(c2)) return 'p1';
    if (wins[c2]?.includes(c1)) return 'p2';
    return 'draw';
  }
  if (SPECIAL.includes(c1) && c2 !== 'slave') return 'p1';
  if (SPECIAL.includes(c2) && c1 !== 'slave') return 'p2';
  
  const nWins = { noble:['slave','general'], general:['slave','soldier'], soldier:['slave','citizen'], citizen:['slave','noble','general'] };
  if (nWins[c1]?.includes(c2)) return 'p1';
  if (nWins[c2]?.includes(c1)) return 'p2';
  return 'draw';
}

function createGameState(p1Name, p2Name) {
  const ALL = ['noble', 'general', 'soldier', 'citizen', 'slave', 'emperor', 'first_emperor', 'sniper', 'revolutionary'];
  const createPlayer = (name) => ({
    name: name, hand: [...ALL], dead: [], assassinated: [], usedSpecial: [], 
    lastCard: null, bannedCards: [], forcedNextTurn: false,
    greatWallActive: false, greatWallTurns: 0, killCount: 0, ready: false, selectedCard: null
  });
  return { players: { p1: createPlayer(p1Name), p2: createPlayer(p2Name) }, turn: 0, phase: 'select', log: [], pendingAbility: [] };
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
    const room = rooms[data.roomId]; if (!room || room.gameState.phase !== 'select') return;
    const gs = room.gameState;
    const p1 = gs.players.p1; const p2 = gs.players.p2;
    const me = gs.players[data.playerId];

    if (me.ready || me.bannedCards.some(b => b.card === data.cardId)) return;

    me.selectedCard = data.cardId;
    me.ready = true;
    io.to(room.sockets[data.playerId === 'p1' ? 'p2' : 'p1']).emit('opponentReady');

    if (p1.ready && p2.ready) {
      [p1, p2].forEach(p => {
        p.bannedCards = p.bannedCards.map(b => ({ ...b, turnsLeft: b.turnsLeft - 1 })).filter(b => b.turnsLeft > 0);
        if (p.greatWallActive) { p.greatWallTurns--; if (p.greatWallTurns <= 0) p.greatWallActive = false; }
        p.forcedNextTurn = false;
      });

      let res = resolveBattle(p1.selectedCard, p2.selectedCard);
      if (res === 'p2' && p1.greatWallActive) res = 'draw';
      if (res === 'p1' && p2.greatWallActive) res = 'draw';

      let winnerId = null;
      if (res === 'p1') { p2.hand = p2.hand.filter(c => c !== p2.selectedCard); p2.dead.push(p2.selectedCard); p1.killCount++; winnerId = 'p1'; gs.log.push(`${p1.name}の勝利！`); }
      else if (res === 'p2') { p1.hand = p1.hand.filter(c => c !== p1.selectedCard); p1.dead.push(p1.selectedCard); p2.killCount++; winnerId = 'p2'; gs.log.push(`${p2.name}の勝利！`); }
      else if (res === 'mutual') { p1.hand = p1.hand.filter(c => c !== p1.selectedCard); p2.hand = p2.hand.filter(c => c !== p2.selectedCard); p1.dead.push(p1.selectedCard); p2.dead.push(p2.selectedCard); gs.log.push("相打ち！"); }
      else { gs.log.push("引き分け！"); }

      if (p1.killCount >= 6 || p2.killCount >= 6) {
        gs.phase = 'gameover';
      } else {
        const winCard = winnerId ? gs.players[winnerId].selectedCard : null;
        if (winnerId && ['emperor', 'first_emperor', 'sniper', 'revolutionary'].includes(winCard)) {
          gs.phase = 'ability';
          gs.pendingAbility = [{ playerId: winnerId, cardId: winCard }];
        }
      }

      p1.lastCard = p1.selectedCard; p2.lastCard = p2.selectedCard;
      setTimeout(() => {
        if (gs.phase !== 'ability' && gs.phase !== 'gameover') {
          gs.turn++; p1.ready = false; p2.ready = false; p1.selectedCard = null; p2.selectedCard = null;
        }
        broadcastGameState(room);
      }, 1500);
    }
    broadcastGameState(room);
  });

  socket.on('useAbility', (data) => {
    const room = rooms[data.roomId]; if (!room) return;
    const gs = room.gameState;
    const me = gs.players[data.playerId];
    const opp = gs.players[data.playerId === 'p1' ? 'p2' : 'p1'];

    if (me.usedSpecial.includes(data.abilityData.cardId)) return;
    me.usedSpecial.push(data.abilityData.cardId);

    if (data.abilityData.cardId === 'emperor') {
      if (data.abilityData.type === 'A') {
        opp.bannedCards.push({ card: data.abilityData.target, turnsLeft: 3 });
      } else {
        opp.forcedNextTurn = true;
      }
    } else if (data.abilityData.cardId === 'sniper') {
      opp.hand = opp.hand.filter(c => c !== data.abilityData.target);
      opp.assassinated.push(data.abilityData.target);
    } else if (data.abilityData.cardId === 'first_emperor') {
      me.greatWallActive = true;
      me.greatWallTurns = 3;
    } else if (data.abilityData.cardId === 'revolutionary') {
      const targets = Array.isArray(data.abilityData.targets) ? data.abilityData.targets : [data.abilityData.target];
      targets.forEach(t => {
        let idx = me.dead.indexOf(t);
        if (idx !== -1) { me.dead.splice(idx, 1); opp.killCount = Math.max(0, opp.killCount - 1); }
        else { idx = me.assassinated.indexOf(t); if (idx !== -1) me.assassinated.splice(idx, 1); }
        me.hand.push(t);
      });
    }

    gs.phase = 'select';
    gs.turn++;
    gs.players.p1.ready = false; gs.players.p2.ready = false;
    gs.players.p1.selectedCard = null; gs.players.p2.selectedCard = null;
    gs.pendingAbility = [];
    broadcastGameState(room);
  });

  socket.on('skipAbility', (data) => {
    const room = rooms[data.roomId]; if (!room) return;
    const gs = room.gameState;
    gs.phase = 'select'; gs.pendingAbility = [];
    gs.players.p1.ready = false; gs.players.p2.ready = false;
    gs.players.p1.selectedCard = null; gs.players.p2.selectedCard = null;
    gs.turn++;
    broadcastGameState(room);
  });
});

function broadcastGameState(room) {
  const gs = room.gameState;
  Object.keys(room.sockets).forEach(pKey => {
    const me = gs.players[pKey];
    const op = gs.players[pKey === 'p1' ? 'p2' : 'p1'];
    io.to(room.sockets[pKey]).emit('gameState', {
      myId: pKey, turn: gs.turn, phase: gs.phase,
      me: { ...me },
      opponent: { 
        name: op.name, hand: op.hand, handCount: op.hand.length, 
        dead: op.dead, assassinated: op.assassinated, ready: op.ready, 
        killCount: op.killCount, greatWallActive: op.greatWallActive 
      },
      log: gs.log, pendingAbility: gs.pendingAbility,
      gameResult: gs.phase === 'gameover' ? (me.killCount >= 6 ? 'WIN' : 'LOSE') : null
    });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

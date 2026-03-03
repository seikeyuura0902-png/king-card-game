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

// 特殊カード名（これらに含まれていれば能力発動）
const SPECIALS = ['emperor', 'first_emperor', 'sniper', 'revolutionary', '皇帝', '始皇帝', '狙撃手', '革命家'];

function resolveBattle(c1, c2) {
  if (c1 === c2) return 'draw';
  const isS = (c) => SPECIALS.some(s => c.includes(s));
  
  if ((c1.includes('slave') || c1.includes('奴隷')) && isS(c2)) return 'p1';
  if ((c2.includes('slave') || c2.includes('奴隷')) && isS(c1)) return 'p2';
  
  if (isS(c1) && isS(c2)) return 'draw';
  if (isS(c1)) return 'p1';
  if (isS(c2)) return 'p2';

  const score = { 'noble':4,'貴族':4,'general':3,'将軍':3,'soldier':2,'兵士':2,'citizen':1,'市民':1,'slave':0,'奴隷':0 };
  if ((score[c1]||0) > (score[c2]||0)) return 'p1';
  if ((score[c2]||0) > (score[c1]||0)) return 'p2';
  return 'draw';
}

function createGameState(p1Name, p2Name) {
  const ALL = ['noble', 'general', 'soldier', 'citizen', 'slave', 'emperor', 'first_emperor', 'sniper', 'revolutionary'];
  const createPlayer = (name) => ({
    name: name, hand: [...ALL], dead: [], assassinated: [], usedSpecial: [], 
    lastCard: null, bannedCards: [], forcedNextTurn: false,
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
    const room = rooms[data.roomId]; if (!room) return;
    const gs = room.gameState;
    const p1 = gs.players.p1; const p2 = gs.players.p2;
    const me = gs.players[data.playerId];

    if (me.ready) return;
    me.selectedCard = data.cardId;
    me.ready = true;

    if (p1.ready && p2.ready) {
      console.log(`Battle: ${p1.selectedCard} vs ${p2.selectedCard}`);
      let res = resolveBattle(p1.selectedCard, p2.selectedCard);
      
      // 万里の長城
      if (res === 'p2' && p1.greatWallActive) res = 'draw';
      if (res === 'p1' && p2.greatWallActive) res = 'draw';

      let winnerId = null;
      if (res === 'p1') { p2.hand = p2.hand.filter(c => c !== p2.selectedCard); p2.dead.push(p2.selectedCard); p1.killCount++; winnerId = 'p1'; }
      else if (res === 'p2') { p1.hand = p1.hand.filter(c => c !== p1.selectedCard); p1.dead.push(p1.selectedCard); p2.killCount++; winnerId = 'p2'; }
      
      if (winnerId) {
        const winCard = gs.players[winnerId].selectedCard;
        const isSpecial = SPECIALS.some(s => winCard.includes(s));
        console.log(`Winner: ${winnerId}, Card: ${winCard}, IsSpecial: ${isSpecial}`);

        if (isSpecial) {
          gs.phase = 'ability';
          gs.pendingAbility = [{ playerId: winnerId, cardId: winCard }];
          console.log("Phase changed to 'ability'");
        }
      }

      if (p1.killCount >= 6 || p2.killCount >= 6) gs.phase = 'gameover';

      setTimeout(() => {
        if (gs.phase !== 'ability' && gs.phase !== 'gameover') {
          gs.turn++; p1.ready = false; p2.ready = false;
        }
        broadcastGameState(room);
      }, 1000);
    }
    broadcastGameState(room);
  });

  socket.on('useAbility', (data) => {
    console.log("useAbility received:", data); // デバッグ用ログ
    const room = rooms[data.roomId]; if (!room) return;
    const gs = room.gameState;
    const me = gs.players[data.playerId];
    const opp = gs.players[data.playerId === 'p1' ? 'p2' : 'p1'];
    const ability = data.abilityData;

    if (!ability || !ability.cardId) {
        console.log("Error: abilityData is missing or invalid");
    } else {
        const card = ability.cardId;
        if (card.includes('emperor') || card.includes('皇帝')) {
          if (ability.type === 'A') opp.bannedCards.push({ card: ability.target, turnsLeft: 3 });
          else opp.forcedNextTurn = true;
        } else if (card.includes('sniper') || card.includes('狙撃')) {
          opp.hand = opp.hand.filter(c => c !== ability.target);
          opp.assassinated.push(ability.target);
        } else if (card.includes('first_emperor') || card.includes('始皇帝')) {
          me.greatWallActive = true; me.greatWallTurns = 3;
        } else if (card.includes('revolutionary') || card.includes('革命')) {
          const ts = Array.isArray(ability.targets) ? ability.targets : [ability.target];
          ts.forEach(t => {
            let i = me.dead.indexOf(t); if(i!==-1){ me.dead.splice(i,1); opp.killCount--; }
            else { i = me.assassinated.indexOf(t); if(i!==-1) me.assassinated.splice(i,1); }
            me.hand.push(t);
          });
        }
    }

    gs.phase = 'select'; gs.turn++;
    gs.players.p1.ready = false; gs.players.p2.ready = false;
    gs.pendingAbility = [];
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
      me: me, opponent: { ...op, hand: op.hand },
      log: gs.log, pendingAbility: gs.pendingAbility,
      gameResult: gs.phase === 'gameover' ? (me.killCount >= 6 ? 'WIN' : 'LOSE') : null
    });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

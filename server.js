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

// 特殊カードの定義（日本語・英語どちらが来てもいいように定義）
const SPECIAL_CARDS = ['emperor', 'first_emperor', 'sniper', 'revolutionary', '皇帝', '始皇帝', '狙撃手', '革命家'];

function resolveBattle(c1, c2) {
  if (c1 === c2) return 'draw';
  
  // 特殊カードかどうかの判定関数
  const isSpec = (c) => SPECIAL_CARDS.includes(c);

  // 貴族 vs 兵士 (相打ち)
  if ((c1.includes('noble') || c1.includes('貴族')) && (c2.includes('soldier') || c2.includes('兵士'))) return 'mutual';
  if ((c2.includes('noble') || c2.includes('貴族')) && (c1.includes('soldier') || c1.includes('兵士'))) return 'mutual';

  // 奴隷 vs 特殊カード (奴隷の勝ち)
  if ((c1.includes('slave') || c1.includes('奴隷')) && isSpec(c2)) return 'p1';
  if ((c2.includes('slave') || c2.includes('奴隷')) && isSpec(c1)) return 'p2';

  // 特殊 vs 特殊 (簡易化：引き分け、または特定の三すくみ)
  if (isSpec(c1) && isSpec(c2)) return 'draw';

  // 特殊 vs その他 (特殊の勝ち)
  if (isSpec(c1)) return 'p1';
  if (isSpec(c2)) return 'p2';

  // 通常カードの勝ち負け (簡易的な強さ順)
  const score = { 'noble': 4, '貴族': 4, 'general': 3, '将軍': 3, 'soldier': 2, '兵士': 2, 'citizen': 1, '市民': 1, 'slave': 0, '奴隷': 0 };
  const s1 = score[c1] || 0;
  const s2 = score[c2] || 0;
  if (s1 > s2) return 'p1';
  if (s2 > s1) return 'p2';
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
    const room = rooms[data.roomId]; if (!room) return;
    const gs = room.gameState;
    const p1 = gs.players.p1; const p2 = gs.players.p2;
    const me = gs.players[data.playerId];

    if (me.ready) return;

    me.selectedCard = data.cardId;
    me.ready = true;

    if (p1.ready && p2.ready) {
      // 状態更新
      [p1, p2].forEach(p => {
        p.bannedCards = (p.bannedCards || []).map(b => ({ ...b, turnsLeft: b.turnsLeft - 1 })).filter(b => b.turnsLeft > 0);
        if (p.greatWallActive) { p.greatWallTurns--; if (p.greatWallTurns <= 0) p.greatWallActive = false; }
      });

      let res = resolveBattle(p1.selectedCard, p2.selectedCard);
      if (res === 'p2' && p1.greatWallActive) res = 'draw';
      if (res === 'p1' && p2.greatWallActive) res = 'draw';

      let winnerId = null;
      if (res === 'p1') { p2.hand = p2.hand.filter(c => c !== p2.selectedCard); p2.dead.push(p2.selectedCard); p1.killCount++; winnerId = 'p1'; }
      else if (res === 'p2') { p1.hand = p1.hand.filter(c => c !== p1.selectedCard); p1.dead.push(p1.selectedCard); p2.killCount++; winnerId = 'p2'; }
      else if (res === 'mutual') { p1.hand = p1.hand.filter(c => c !== p1.selectedCard); p2.hand = p2.hand.filter(c => c !== p2.selectedCard); p1.dead.push(p1.selectedCard); p2.dead.push(p2.selectedCard); }

      // 特殊能力チェック（非常に緩い判定に変更）
      if (winnerId) {
        const winCard = gs.players[winnerId].selectedCard;
        const isSpecial = SPECIAL_CARDS.some(s => winCard.includes(s));
        
        if (isSpecial && !gs.players[winnerId].usedSpecial.includes(winCard)) {
          gs.phase = 'ability';
          gs.pendingAbility = [{ playerId: winnerId, cardId: winCard }];
        }
      }

      if (p1.killCount >= 6 || p2.killCount >= 6) gs.phase = 'gameover';

      setTimeout(() => {
        if (gs.phase !== 'ability' && gs.phase !== 'gameover') {
          gs.turn++; p1.ready = false; p2.ready = false; p1.selectedCard = null; p2.selectedCard = null;
        }
        broadcastGameState(room);
      }, 1000);
    }
    broadcastGameState(room);
  });

  socket.on('useAbility', (data) => {
    const room = rooms[data.roomId]; if (!room) return;
    const gs = room.gameState;
    const me = gs.players[data.playerId];
    const opp = gs.players[data.playerId === 'p1' ? 'p2' : 'p1'];

    const card = data.abilityData.cardId;
    me.usedSpecial.push(card);

    if (card.includes('emperor') || card.includes('皇帝')) {
      if (data.abilityData.type === 'A') opp.bannedCards.push({ card: data.abilityData.target, turnsLeft: 3 });
      else opp.forcedNextTurn = true;
    } else if (card.includes('sniper') || card.includes('狙撃')) {
      opp.hand = opp.hand.filter(c => c !== data.abilityData.target);
      opp.assassinated.push(data.abilityData.target);
    } else if (card.includes('first_emperor') || card.includes('始皇帝')) {
      me.greatWallActive = true; me.greatWallTurns = 3;
    } else if (card.includes('revolutionary') || card.includes('革命')) {
      const ts = Array.isArray(data.abilityData.targets) ? data.abilityData.targets : [data.abilityData.target];
      ts.forEach(t => {
        let i = me.dead.indexOf(t); if(i!==-1){ me.dead.splice(i,1); opp.killCount--; }
        else { i = me.assassinated.indexOf(t); if(i!==-1) me.assassinated.splice(i,1); }
        me.hand.push(t);
      });
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

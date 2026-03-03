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

// --- バトル相性ロジック（ここを最新に更新） ---
function resolveBattle(c1, c2) {
  if (c1 === c2) return 'draw';
  const SPECIAL = ['emperor', 'first_emperor', 'sniper', 'revolutionary'];
  const s1 = SPECIAL.includes(c1);
  const s2 = SPECIAL.includes(c2);
  
  // 貴族 vs 兵士 の特殊相性（相打ち）
  if ((c1 === 'noble' && c2 === 'soldier') || (c1 === 'soldier' && c2 === 'noble')) return 'mutual';
  
  // 奴隷のジャイアントキリング（奴隷 vs 全特殊カード）
  if (c1 === 'slave' && s2) return 'p1';
  if (c2 === 'slave' && s1) return 'p2';
  
  // 特殊カード同士の相性
  if (s1 && s2) {
    const wins = { 
      emperor: ['first_emperor'], 
      first_emperor: ['sniper', 'revolutionary'], 
      sniper: ['emperor'], 
      revolutionary: ['emperor'] 
    };
    if (wins[c1] && wins[c1].includes(c2)) return 'p1';
    if (wins[c2] && wins[c2].includes(c1)) return 'p2';
    return 'draw';
  }
  
  // 特殊カード vs 通常カード（奴隷以外には特殊が勝つ）
  if (s1 && !s2 && c2 !== 'slave') return 'p1';
  if (s2 && !s1 && c1 !== 'slave') return 'p2';
  
  // 通常カード同士の相性
  const normalWins = { 
    noble: ['slave', 'general'], 
    general: ['slave', 'soldier'], 
    soldier: ['slave', 'citizen'], 
    citizen: ['slave', 'noble', 'general'], 
    slave: [] 
  };
  if (normalWins[c1] && normalWins[c1].includes(c2)) return 'p1';
  if (normalWins[c2] && normalWins[c2].includes(c1)) return 'p2';
  
  return 'draw';
}

function createGameState(p1Name, p2Name) {
  const ALL = ['noble', 'general', 'soldier', 'citizen', 'slave', 'emperor', 'first_emperor', 'sniper', 'revolutionary'];
  const createPlayer = (name) => ({
    name: name, hand: [...ALL], dead: [], assassinated: [], revived: [],
    lastCard: null, specialUnlocked: false, bannedCards: [], forcedNextTurn: false,
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
    const { roomId, playerId, cardId } = data;
    const room = rooms[roomId]; if (!room || room.gameState.phase !== 'select') return;
    const gs = room.gameState;
    const p1 = gs.players.p1;
    const p2 = gs.players.p2;
    const me = gs.players[playerId];

    if (me.ready) return;

    me.selectedCard = cardId;
    me.ready = true;
    const oppId = (playerId === 'p1' ? 'p2' : 'p1');
    io.to(room.sockets[oppId]).emit('opponentReady');

    if (p1.ready && p2.ready) {
      // ターン終了時のカウント更新
      [p1, p2].forEach(p => {
        if (p.bannedCards) {
          p.bannedCards = p.bannedCards.map(b => ({ ...b, turnsLeft: b.turnsLeft - 1 })).filter(b => b.turnsLeft > 0);
        }
        p.forcedNextTurn = false;
        if (p.greatWallActive) {
          p.greatWallTurns--;
          if (p.greatWallTurns <= 0) p.greatWallActive = false;
        }
      });

      let res = resolveBattle(p1.selectedCard, p2.selectedCard);
      
      // 万里の長城の判定
      if (res === 'p2' && p1.greatWallActive) {
        res = 'draw';
        gs.log = [`${p1.name}の万里の長城が敗北を防いだ！`];
      } else if (res === 'p1' && p2.greatWallActive) {
        res = 'draw';
        gs.log = [`${p2.name}の万里の長城が敗北を防いだ！`];
      } else {
        gs.log = [`ターン${gs.turn + 1}: P1「${p1.selectedCard}」 vs P2「${p2.selectedCard}」`];
      }

      let winnerId = null;
      if (res === 'p1') {
        p2.hand = p2.hand.filter(c => c !== p2.selectedCard);
        p2.dead.push(p2.selectedCard);
        p1.killCount++;
        winnerId = 'p1';
        gs.log.push(`${p1.name}の勝利！`);
      } else if (res === 'p2') {
        p1.hand = p1.hand.filter(c => c !== p1.selectedCard);
        p1.dead.push(p1.selectedCard);
        p2.killCount++;
        winnerId = 'p2';
        gs.log.push(`${p2.name}の勝利！`);
      } else if (res === 'mutual') {
        p1.hand = p1.hand.filter(c => c !== p1.selectedCard);
        p2.hand = p2.hand.filter(c => c !== p2.selectedCard);
        p1.dead.push(p1.selectedCard);
        p2.dead.push(p2.selectedCard);
        gs.log.push("相打ち！");
      } else {
        gs.log.push("引き分け！");
      }

      // 勝利判定 (6枚先取)
      if (p1.killCount >= 6 || p2.killCount >= 6) {
        gs.phase = 'gameover';
        gs.log.push(`ゲーム終了！ ${p1.killCount >= 6 ? p1.name : p2.name}の完全勝利！`);
      } else {
        const winCard = winnerId ? gs.players[winnerId].selectedCard : null;
        const SPECIALS = ['emperor', 'first_emperor', 'sniper', 'revolutionary'];
        if (winnerId && SPECIALS.includes(winCard)) {
          gs.phase = 'ability';
          gs.pendingAbility = [{ playerId: winnerId, cardId: winCard }];
        }
      }

      p1.lastCard = p1.selectedCard;
      p2.lastCard = p2.selectedCard;
      p1.specialUnlocked = (p1.dead.length + (p1.assassinated || []).length) >= 2;
      p2.specialUnlocked = (p2.dead.length + (p2.assassinated || []).length) >= 2;

      setTimeout(() => {
        if (gs.phase !== 'ability' && gs.phase !== 'gameover') {
          gs.turn++;
          p1.ready = false; p2.ready = false;
          p1.selectedCard = null; p2.selectedCard = null;
        }
        broadcastGameState(room);
      }, 1500);
    }
    broadcastGameState(room);
  });

  socket.on('useAbility', (data) => {
    const { roomId, playerId, abilityData } = data;
    const room = rooms[roomId]; if (!room) return;
    const gs = room.gameState;
    const me = gs.players[playerId];
    const opp = gs.players[playerId === 'p1' ? 'p2' : 'p1'];

    if (abilityData.cardId === 'emperor') {
      if (abilityData.type === 'A') {
        opp.bannedCards = opp.bannedCards || [];
        opp.bannedCards.push({ card: abilityData.target, turnsLeft: 3 });
        gs.log.push(`${opp.name}の「${abilityData.target}」を3ターン禁止した！`);
      } else {
        opp.forcedNextTurn = true;
        gs.log.push(`${opp.name}の次ターンを制限した！`);
      }
    } else if (abilityData.cardId === 'sniper') {
      if (opp.hand.includes(abilityData.target)) {
        opp.hand = opp.hand.filter(c => c !== abilityData.target);
        opp.assassinated = opp.assassinated || [];
        opp.assassinated.push(abilityData.target);
        gs.log.push(`${opp.name}の「${abilityData.target}」を狙撃した！`);
      }
    } else if (abilityData.cardId === 'first_emperor') {
      me.greatWallActive = true;
      me.greatWallTurns = 3;
      gs.log.push(`${me.name}が万里の長城を築いた！`);
    } else if (abilityData.cardId === 'revolutionary') {
      const targets = Array.isArray(abilityData.targets) ? abilityData.targets : [abilityData.target];
      targets.forEach(t => {
        let idx = me.dead.indexOf(t);
        if (idx !== -1) {
          me.dead.splice(idx, 1);
          opp.killCount = Math.max(0, opp.killCount - 1);
        } else {
          idx = (me.assassinated || []).indexOf(t);
          if (idx !== -1) me.assassinated.splice(idx, 1);
        }
        me.hand.push(t);
      });
      gs.log.push(`${me.name}がカードを復活させた！`);
    }

    gs.phase = 'select';
    gs.pendingAbility = [];
    gs.players.p1.ready = false; gs.players.p2.ready = false;
    gs.players.p1.selectedCard = null; gs.players.p2.selectedCard = null;
    gs.turn++;
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
  const send = (myId, oppId) => {
    const my = gs.players[myId];
    const op = gs.players[oppId];
    return {
      myId: myId, turn: gs.turn, phase: gs.phase,
      me: { ...my },
      opponent: { 
        name: op.name, 
        hand: op.hand, // フロントエンドが狙撃対象を選ぶために必須
        handCount: op.hand.length, 
        dead: op.dead, assassinated: op.assassinated, 
        ready: op.ready, killCount: op.killCount, 
        specialUnlocked: op.specialUnlocked, greatWallActive: op.greatWallActive 
      },
      log: gs.log, pendingAbility: gs.pendingAbility
    };
  };
  io.to(room.sockets.p1).emit('gameState', send('p1', 'p2'));
  io.to(room.sockets.p2).emit('gameState', send('p2', 'p1'));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

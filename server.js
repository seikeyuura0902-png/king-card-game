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

/**
 * カードの判定用キーワード
 * game.jsから送られてくるカード名にこれらが含まれているかをチェックします
 */
const CARDS = {
  EMPEROR: 'emperor',
  FIRST_EMPEROR: 'first_emperor',
  SNIPER: 'sniper',
  REVOLUTIONARY: 'revolutionary',
  NOBLE: 'noble',
  GENERAL: 'general',
  SOLDIER: 'soldier',
  CITIZEN: 'citizen',
  SLAVE: 'slave'
};

// バトルロジック
function resolveBattle(card1, card2) {
  const c1 = String(card1).toLowerCase();
  const c2 = String(card2).toLowerCase();

  if (c1 === c2) return 'draw';

  // 特殊カード判定関数
  const isSpecial = (c) => [CARDS.EMPEROR, CARDS.FIRST_EMPEROR, CARDS.SNIPER, CARDS.REVOLUTIONARY].some(k => c.includes(k));

  // 1. 奴隷の逆転（奴隷 vs 特殊カード）
  if ((c1.includes(CARDS.SLAVE)) && isSpecial(c2)) return 'p1';
  if ((c2.includes(CARDS.SLAVE)) && isSpecial(c1)) return 'p2';

  // 2. 貴族 vs 兵士（相打ち設定がある場合）
  const isNoble = (c) => c.includes(CARDS.NOBLE);
  const isSoldier = (c) => c.includes(CARDS.SOLDIER);
  if ((isNoble(c1) && isSoldier(c2)) || (isNoble(c2) && isSoldier(c1))) return 'mutual';

  // 3. 特殊カード同士の対決
  if (isSpecial(c1) && isSpecial(c2)) {
    if (c1.includes(CARDS.EMPEROR) && c2.includes(CARDS.FIRST_EMPEROR)) return 'p1';
    if (c2.includes(CARDS.EMPEROR) && c1.includes(CARDS.FIRST_EMPEROR)) return 'p2';
    // 他の特殊カード同士は引き分け
    return 'draw';
  }

  // 4. 特殊カード vs 通常カード
  if (isSpecial(c1)) return 'p1';
  if (isSpecial(c2)) return 'p2';

  // 5. 通常カードの強さ比較
  const scores = { noble: 4, general: 3, soldier: 2, citizen: 1, slave: 0 };
  const getScore = (c) => {
    if (c.includes(CARDS.NOBLE)) return scores.noble;
    if (c.includes(CARDS.GENERAL)) return scores.general;
    if (c.includes(CARDS.SOLDIER)) return scores.soldier;
    if (c.includes(CARDS.CITIZEN)) return scores.citizen;
    return 0;
  };

  const s1 = getScore(c1);
  const s2 = getScore(c2);
  if (s1 > s2) return 'p1';
  if (s2 > s1) return 'p2';
  return 'draw';
}

function createPlayer(name) {
  return {
    name: name,
    hand: ['noble', 'general', 'soldier', 'citizen', 'slave', 'emperor', 'first_emperor', 'sniper', 'revolutionary'],
    dead: [],
    assassinated: [],
    usedSpecial: [], // ここに使用したカードのキーワードを保存
    killCount: 0,
    ready: false,
    selectedCard: null,
    greatWallActive: false,
    bannedCards: []
  };
}

io.on('connection', (socket) => {
  // マッチング処理
  socket.on('findMatch', (data) => {
    const name = data?.name || 'プレイヤー';
    if (waitingPlayers.length > 0) {
      const opp = waitingPlayers.shift();
      const roomId = `room_${Date.now()}`;
      rooms[roomId] = {
        id: roomId,
        sockets: { p1: opp.socketId, p2: socket.id },
        gameState: {
          players: { p1: createPlayer(opp.name), p2: createPlayer(name) },
          turn: 1, phase: 'select', log: [], pendingAbility: []
        }
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

  // カード選択
  socket.on('selectCard', (data) => {
    const room = rooms[data.roomId];
    if (!room || room.gameState.phase !== 'select') return;
    const gs = room.gameState;
    const me = gs.players[data.playerId];

    if (me.ready) return;
    me.selectedCard = data.cardId; // 表示用（元の名前を維持）
    me.ready = true;

    const p1 = gs.players.p1;
    const p2 = gs.players.p2;

    if (p1.ready && p2.ready) {
      let res = resolveBattle(p1.selectedCard, p2.selectedCard);

      // 万里の長城の防御判定
      if (res === 'p2' && p1.greatWallActive) res = 'draw';
      if (res === 'p1' && p2.greatWallActive) res = 'draw';

      let winnerId = null;
      if (res === 'p1') {
        p2.hand = p2.hand.filter(c => c !== p2.selectedCard);
        p2.dead.push(p2.selectedCard);
        p1.killCount++;
        winnerId = 'p1';
      } else if (res === 'p2') {
        p1.hand = p1.hand.filter(c => c !== p1.selectedCard);
        p1.dead.push(p1.selectedCard);
        p2.killCount++;
        winnerId = 'p2';
      } else if (res === 'mutual') {
        p1.hand = p1.hand.filter(c => c !== p1.selectedCard); p1.dead.push(p1.selectedCard);
        p2.hand = p2.hand.filter(c => c !== p2.selectedCard); p2.dead.push(p2.selectedCard);
      }

      // 能力発動チェック
      if (winnerId) {
        const winCard = String(gs.players[winnerId].selectedCard).toLowerCase();
        const specials = [CARDS.EMPEROR, CARDS.FIRST_EMPEROR, CARDS.SNIPER, CARDS.REVOLUTIONARY];
        const key = specials.find(k => winCard.includes(k));

        if (key && !gs.players[winnerId].usedSpecial.includes(key)) {
          gs.phase = 'ability';
          gs.pendingAbility = [{ playerId: winnerId, cardId: gs.players[winnerId].selectedCard }];
          gs.players[winnerId].usedSpecial.push(key); // ここで「使用済み」に記録
        }
      }

      // 終了判定
      if (p1.killCount >= 6 || p2.killCount >= 6) {
        gs.phase = 'gameover';
      }

      // 画面更新用のウェイト
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

  // 能力使用
  socket.on('useAbility', (data) => {
    const room = rooms[data.roomId];
    if (!room) return;
    const gs = room.gameState;
    const me = gs.players[data.playerId];
    const opp = gs.players[data.playerId === 'p1' ? 'p2' : 'p1'];
    const ab = data.abilityData;

    if (ab && ab.cardId) {
      const c = String(ab.cardId).toLowerCase();
      if (c.includes(CARDS.EMPEROR)) {
        if (ab.type === 'A') opp.bannedCards.push({ card: ab.target, turnsLeft: 3 });
        else opp.forcedNextTurn = true;
      } else if (c.includes(CARDS.SNIPER)) {
        opp.hand = opp.hand.filter(h => h !== ab.target);
        opp.assassinated.push(ab.target);
      } else if (c.includes(CARDS.FIRST_EMPEROR)) {
        me.greatWallActive = true;
      } else if (c.includes(CARDS.REVOLUTIONARY)) {
        const targets = Array.isArray(ab.targets) ? ab.targets : [ab.target];
        targets.forEach(t => {
          let i = me.dead.indexOf(t);
          if (i !== -1) { me.dead.splice(i, 1); if (opp.killCount > 0) opp.killCount--; }
          else {
            i = (me.assassinated || []).indexOf(t);
            if (i !== -1) me.assassinated.splice(i, 1);
          }
          me.hand.push(t);
        });
      }
    }

    // フェーズを戻して次ターンへ
    gs.phase = 'select';
    gs.turn++;
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
      myId: pk,
      turn: gs.turn,
      phase: gs.phase,
      me: me,
      opponent: {
        name: op.name,
        hand: op.hand,
        handCount: op.hand.length,
        dead: op.dead,
        killCount: op.killCount,
        ready: op.ready
      },
      pendingAbility: gs.pendingAbility,
      gameResult: gs.phase === 'gameover' ? (me.killCount >= 6 ? 'WIN' : 'LOSE') : null
    });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Game Server Running on Port ${PORT}`));

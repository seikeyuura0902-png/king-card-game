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

// ---------------------------------------------------------
// 1. 内部判定用キーワード（すべて小文字で定義）
// ---------------------------------------------------------
const KEYS = {
  EMP: 'emperor',
  FIRST: 'first_emperor',
  SNIP: 'sniper',
  REVO: 'revolutionary',
  SLAVE: 'slave'
};

// ---------------------------------------------------------
// 2. バトル判定ロジック
// ---------------------------------------------------------
function resolveBattle(c1_orig, c2_orig) {
  // 比較の時だけ小文字にする（元の c1_orig は壊さない）
  const s1 = String(c1_orig).toLowerCase();
  const s2 = String(c2_orig).toLowerCase();

  if (s1 === s2) return 'draw';

  const isSpec = (s) => [KEYS.EMP, KEYS.FIRST, KEYS.SNIP, KEYS.REVO].some(k => s.includes(k));

  // 奴隷の逆転
  if (s1.includes(KEYS.SLAVE) && isSpec(s2)) return 'p1';
  if (s2.includes(KEYS.SLAVE) && isSpec(s1)) return 'p2';
  
  // 特殊カード同士は引き分け
  if (isSpec(s1) && isSpec(s2)) return 'draw';

  // 特殊カード vs 通常カード
  if (isSpec(s1)) return 'p1';
  if (isSpec(s2)) return 'p2';

  // 通常カードの強さ比較
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
      
      // 【重要】ここの名前を、あなたの画像ファイル名（Emperor.png等）に合わせてください。
      // もし画像が「emperor.png」なら小文字に、「Emperor.png」なら大文字に。
      const createP = (n) => ({
        name: n,
        hand: ['Noble', 'General', 'Soldier', 'Citizen', 'Slave', 'Emperor', 'First_Emperor', 'Sniper', 'Revolutionary'],
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
    const room = rooms[data.roomId]; 
    if (!room || room.gameState.phase !== 'select') return;
    const gs = room.gameState; 
    const me = gs.players[data.playerId];
    
    if (me.ready) return;

    // クライアントから送られた名前を「そのまま」保存する
    // これが画像表示（src="cardId + .png"など）に直結します
    me.selectedCard = data.cardId; 
    me.ready = true;

    const p1 = gs.players.p1; 
    const p2 = gs.players.p2;

    if (p1.ready && p2.ready) {
      let res = resolveBattle(p1.selectedCard, p2.selectedCard);
      
      // バリア（万里の長城）判定
      if (res === 'p2' && p1.greatWallActive) res = 'draw';
      if (res === 'p1' && p2.greatWallActive) res = 'draw';

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
      } else if (res === 'mutual') {
        p1.hand = p1.hand.filter(c => c !== p1.selectedCard); p1.dead.push(p1.selectedCard);
        p2.hand = p2.hand.filter(c => c !== p2.selectedCard); p2.dead.push(p2.selectedCard);
      }

      // -----------------------------------------------------
      // 能力発動チェック（勝った時のみ）
      // -----------------------------------------------------
      if (winId) {
        const winner = gs.players[winId];
        const sName = String(winner.selectedCard).toLowerCase();
        const key = [KEYS.EMP, KEYS.FIRST, KEYS.SNIP, KEYS.REVO].find(k => sName.includes(k));

        // その特殊カードがまだ未使用であれば
        if (key && !winner.usedSpecial.includes(key)) {
          // 自分の現在の墓地数（負けたカード + 暗殺されたカード）
          const totalDead = (winner.dead ? winner.dead.length : 0) + (winner.assassinated ? winner.assassinated.length : 0);
          
          let canTrigger = false;
          if (key === KEYS.REVO) {
            // 革命家は墓地が3枚以上の時に勝利すれば発動
            if (totalDead >= 3) canTrigger = true;
          } else {
            // 他の特殊カードは墓地が2枚以上の時に勝利すれば発動
            if (totalDead >= 2) canTrigger = true;
          }

          if (canTrigger) {
            gs.phase = 'ability';
            gs.pendingAbility = [{ playerId: winId, cardId: winner.selectedCard }];
            winner.usedSpecial.push(key); // 使用済みに記録
          }
        }
      }

      // ゲーム終了判定
      if (p1.killCount >= 6 || p2.killCount >= 6) {
        gs.phase = 'gameover';
      }

      // 状態をクライアントに反映するための遅延
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
            me.dead.splice(idx, 1); 
            if (opp.killCount > 0) opp.killCount--; 
          } else {
            idx = (me.assassinated || []).indexOf(t);
            if (idx !== -1) me.assassinated.splice(idx, 1);
          }
          me.hand.push(t);
        });
      }
    }
    
    // ターン終了処理
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
      myId: pk, turn: gs.turn, phase: gs.phase, me: me,
      opponent: { 
        name: op.name, hand: op.hand, handCount: op.hand.length, 
        dead: op.dead, killCount: op.killCount, ready: op.ready 
      },
      pendingAbility: gs.pendingAbility,
      gameResult: gs.phase === 'gameover' ? (me.killCount >= 6 ? 'WIN' : 'LOSE') : null
    });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Stable Server v3.0 Running`));

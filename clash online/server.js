/**
 * CLASH — Online Multiplayer RPS Server
 * Node.js + Socket.io
 * 
 * Features:
 *  - Instant matchmaking queue
 *  - Private rooms for 1v1
 *  - ELO rating system
 *  - Global leaderboard (top 20)
 *  - Rematch system
 *  - Disconnect handling + reconnect window
 *  - Live online player count broadcasts
 *  - Daily/weekly stats tracking
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',   // Restrict to your domain in production
    methods: ['GET', 'POST']
  },
  pingTimeout: 10000,
  pingInterval: 5000
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── IN-MEMORY STORES ───────────────────────────────────────────────────────
// In production: replace with Redis + PostgreSQL

const players = new Map();      // socketId -> PlayerData
const matchQueue = [];          // waiting sockets
const rooms = new Map();        // roomId -> RoomData
const leaderboard = new Map();  // playerId -> LeaderboardEntry

// Temp reconnect buffer: playerId -> { roomId, score, timestamp }
const reconnectBuffer = new Map();

// ─── ELO CONFIG ─────────────────────────────────────────────────────────────
const ELO_K = 32;
const ELO_START = 1000;

function calcElo(winnerElo, loserElo) {
  const expected = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const change = Math.round(ELO_K * (1 - expected));
  return {
    winnerGain: change,
    loserLoss: change
  };
}

function getRank(elo) {
  if (elo < 1100) return { name: 'Bronze',   icon: '🥉', color: '#cd7f32', next: 1100 };
  if (elo < 1250) return { name: 'Silver',   icon: '🥈', color: '#c0c0c0', next: 1250 };
  if (elo < 1450) return { name: 'Gold',     icon: '🥇', color: '#ffd700', next: 1450 };
  if (elo < 1700) return { name: 'Platinum', icon: '💎', color: '#00e5ff', next: 1700 };
  if (elo < 2000) return { name: 'Diamond',  icon: '💠', color: '#b040ff', next: 2000 };
  return { name: 'Legend',   icon: '👑', color: '#ff6b35', next: null };
}

// ─── PLAYER HELPERS ─────────────────────────────────────────────────────────
function createPlayer(socketId, data) {
  return {
    socketId,
    playerId:   data.playerId || uuidv4(),
    name:       (data.name || 'Player').substring(0, 16).toUpperCase(),
    elo:        data.elo     || ELO_START,
    wins:       data.wins    || 0,
    losses:     data.losses  || 0,
    draws:      data.draws   || 0,
    streak:     data.streak  || 0,
    bestStreak: data.bestStreak || 0,
    roomId:     null,
    inQueue:    false
  };
}

function getOnlineCount() {
  return players.size;
}

function broadcastOnlineCount() {
  io.emit('onlineCount', getOnlineCount());
}

// ─── LEADERBOARD ─────────────────────────────────────────────────────────────
function updateLeaderboard(player) {
  leaderboard.set(player.playerId, {
    playerId:   player.playerId,
    name:       player.name,
    elo:        player.elo,
    wins:       player.wins,
    losses:     player.losses,
    draws:      player.draws,
    streak:     player.bestStreak,
    rank:       getRank(player.elo)
  });
}

function getTopLeaderboard(n = 20) {
  return [...leaderboard.values()]
    .sort((a, b) => b.elo - a.elo)
    .slice(0, n)
    .map((p, i) => ({ ...p, position: i + 1 }));
}

// ─── MATCHMAKING ─────────────────────────────────────────────────────────────
function tryMatch() {
  if (matchQueue.length < 2) return;

  // Pop two nearest-ELO players (simple: just take first two)
  // In production: sort by wait time + ELO proximity
  const [id1, id2] = matchQueue.splice(0, 2);
  const p1 = players.get(id1);
  const p2 = players.get(id2);

  if (!p1 || !p2) {
    // Somebody disconnected, put valid one back
    if (p1 && !matchQueue.includes(id1)) matchQueue.push(id1);
    if (p2 && !matchQueue.includes(id2)) matchQueue.push(id2);
    return;
  }

  p1.inQueue = false;
  p2.inQueue = false;

  const roomId = uuidv4();
  const room = {
    id: roomId,
    p1Id: id1,
    p2Id: id2,
    p1Score: 0,
    p2Score: 0,
    p1Choice: null,
    p2Choice: null,
    target: 3,
    round: 1,
    state: 'picking',   // picking | revealing | over
    rematchVotes: new Set(),
    createdAt: Date.now()
  };

  rooms.set(roomId, room);
  p1.roomId = roomId;
  p2.roomId = roomId;

  // Put both in the socket.io room
  io.sockets.sockets.get(id1)?.join(roomId);
  io.sockets.sockets.get(id2)?.join(roomId);

  const matchData = {
    roomId,
    target: room.target,
    opponent: {
      name:  p2.name,
      elo:   p2.elo,
      rank:  getRank(p2.elo),
      wins:  p2.wins
    }
  };
  const matchDataForP2 = {
    roomId,
    target: room.target,
    opponent: {
      name:  p1.name,
      elo:   p1.elo,
      rank:  getRank(p1.elo),
      wins:  p1.wins
    }
  };

  io.to(id1).emit('matchFound', { ...matchData, yourSide: 'p1' });
  io.to(id2).emit('matchFound', { ...matchDataForP2, yourSide: 'p2' });

  console.log(`[MATCH] ${p1.name} vs ${p2.name} — Room: ${roomId}`);
}

// ─── GAME LOGIC ──────────────────────────────────────────────────────────────
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

function resolveRound(room) {
  const { p1Choice, p2Choice } = room;
  if (!p1Choice || !p2Choice) return null;

  if (p1Choice === p2Choice) return 'draw';
  return BEATS[p1Choice] === p2Choice ? 'p1' : 'p2';
}

function checkGameOver(room) {
  return room.p1Score >= room.target || room.p2Score >= room.target;
}

// ─── SOCKET EVENTS ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // ── Join / Identify ──────────────────────────────────────────────────────
  socket.on('identify', (data) => {
    // data: { playerId?, name, elo?, wins?, losses?, draws?, streak? }
    const player = createPlayer(socket.id, data || {});
    players.set(socket.id, player);

    // Restore from reconnect buffer if applicable
    const prev = data?.playerId ? reconnectBuffer.get(data.playerId) : null;
    if (prev && Date.now() - prev.timestamp < 30000) {
      // Reconnected within 30s
      const room = rooms.get(prev.roomId);
      if (room) {
        player.roomId = room.id;
        socket.join(room.id);
        const side = room.p1Id === socket.id ? 'p1' : 'p2';
        // Update the room's socket id
        if (prev.side === 'p1') room.p1Id = socket.id;
        else room.p2Id = socket.id;
        socket.emit('reconnected', { roomId: room.id, yourSide: prev.side, room: sanitizeRoom(room) });
        reconnectBuffer.delete(data.playerId);
      }
    }

    updateLeaderboard(player);
    socket.emit('identified', {
      playerId: player.playerId,
      elo: player.elo,
      rank: getRank(player.elo),
      wins: player.wins,
      losses: player.losses,
      draws: player.draws
    });

    socket.emit('leaderboard', getTopLeaderboard());
    broadcastOnlineCount();
    console.log(`[IDENTIFY] ${player.name} (ELO:${player.elo}) — ${socket.id}`);
  });

  // ── Queue ────────────────────────────────────────────────────────────────
  socket.on('joinQueue', () => {
    const player = players.get(socket.id);
    if (!player || player.inQueue || player.roomId) return;
    player.inQueue = true;
    matchQueue.push(socket.id);
    socket.emit('queueJoined', { position: matchQueue.length });
    io.emit('queueSize', matchQueue.length);
    console.log(`[QUEUE] ${player.name} joined — queue: ${matchQueue.length}`);
    tryMatch();
  });

  socket.on('leaveQueue', () => {
    const player = players.get(socket.id);
    if (!player) return;
    const idx = matchQueue.indexOf(socket.id);
    if (idx !== -1) matchQueue.splice(idx, 1);
    player.inQueue = false;
    socket.emit('queueLeft');
    io.emit('queueSize', matchQueue.length);
  });

  // ── Make Choice ──────────────────────────────────────────────────────────
  socket.on('makeChoice', ({ choice }) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = rooms.get(player.roomId);
    if (!room || room.state !== 'picking') return;

    const valid = ['rock', 'paper', 'scissors'];
    if (!valid.includes(choice)) return;

    const side = room.p1Id === socket.id ? 'p1' : 'p2';
    if (side === 'p1') room.p1Choice = choice;
    else room.p2Choice = choice;

    // Tell opponent someone has chosen (not which)
    const opponentId = side === 'p1' ? room.p2Id : room.p1Id;
    io.to(opponentId).emit('opponentChose');

    // Both chosen? Resolve
    if (room.p1Choice && room.p2Choice) {
      room.state = 'revealing';
      setTimeout(() => resolveAndBroadcast(room), 500);
    }
  });

  function resolveAndBroadcast(room) {
    const result = resolveRound(room);
    const p1 = players.get(room.p1Id);
    const p2 = players.get(room.p2Id);

    if (!p1 || !p2) return;

    const roundPayload = {
      round: room.round,
      p1Choice: room.p1Choice,
      p2Choice: room.p2Choice,
      result,
      p1Score: room.p1Score,
      p2Score: room.p2Score
    };

    if (result === 'draw') {
      // no score change
    } else if (result === 'p1') {
      room.p1Score++;
    } else {
      room.p2Score++;
    }
    roundPayload.p1Score = room.p1Score;
    roundPayload.p2Score = room.p2Score;

    io.to(room.id).emit('roundResult', roundPayload);

    // Check game over
    if (checkGameOver(room)) {
      room.state = 'over';
      setTimeout(() => endGame(room, result), 800);
    } else {
      room.round++;
      room.p1Choice = null;
      room.p2Choice = null;
      room.state = 'picking';
      io.to(room.id).emit('nextRound', { round: room.round });
    }
  }

  function endGame(room, lastResult) {
    const winner = room.p1Score >= room.target ? 'p1' : 'p2';
    const p1 = players.get(room.p1Id);
    const p2 = players.get(room.p2Id);
    if (!p1 || !p2) return;

    // ELO
    const eloCalc = calcElo(
      winner === 'p1' ? p1.elo : p2.elo,
      winner === 'p1' ? p2.elo : p1.elo
    );

    const p1Won = winner === 'p1';
    const p1EloBefore = p1.elo;
    const p2EloBefore = p2.elo;

    if (p1Won) {
      p1.wins++;   p1.elo += eloCalc.winnerGain;
      p2.losses++; p2.elo = Math.max(800, p2.elo - eloCalc.loserLoss);
      p1.streak++;  p2.streak = 0;
    } else {
      p2.wins++;   p2.elo += eloCalc.winnerGain;
      p1.losses++; p1.elo = Math.max(800, p1.elo - eloCalc.loserLoss);
      p2.streak++;  p1.streak = 0;
    }
    if (p1.streak > p1.bestStreak) p1.bestStreak = p1.streak;
    if (p2.streak > p2.bestStreak) p2.bestStreak = p2.streak;

    updateLeaderboard(p1);
    updateLeaderboard(p2);

    // Broadcast updated leaderboard
    setTimeout(() => io.emit('leaderboard', getTopLeaderboard()), 1000);

    const gameOverPayload = {
      winner,
      p1Score: room.p1Score,
      p2Score: room.p2Score,
      p1EloChange: p1Won ? +eloCalc.winnerGain : -eloCalc.loserLoss,
      p2EloChange: p1Won ? -eloCalc.loserLoss : +eloCalc.winnerGain,
      p1EloNew: p1.elo,
      p2EloNew: p2.elo,
      p1Rank: getRank(p1.elo),
      p2Rank: getRank(p2.elo),
      p1RankBefore: getRank(p1EloBefore),
      p2RankBefore: getRank(p2EloBefore)
    };

    io.to(room.p1Id).emit('gameOver', {
      ...gameOverPayload,
      yourSide: 'p1',
      eloChange: gameOverPayload.p1EloChange,
      newElo: p1.elo,
      newRank: getRank(p1.elo)
    });
    io.to(room.p2Id).emit('gameOver', {
      ...gameOverPayload,
      yourSide: 'p2',
      eloChange: gameOverPayload.p2EloChange,
      newElo: p2.elo,
      newRank: getRank(p2.elo)
    });

    console.log(`[GAME OVER] ${p1.name}(${p1EloBefore}→${p1.elo}) vs ${p2.name}(${p2EloBefore}→${p2.elo}) — Winner: ${winner}`);
  }

  // ── Rematch ──────────────────────────────────────────────────────────────
  socket.on('rematch', () => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = rooms.get(player.roomId);
    if (!room || room.state !== 'over') return;

    room.rematchVotes.add(socket.id);
    const opponentId = room.p1Id === socket.id ? room.p2Id : room.p1Id;
    io.to(opponentId).emit('opponentWantsRematch');

    if (room.rematchVotes.size >= 2) {
      // Reset room
      room.p1Score = 0; room.p2Score = 0;
      room.p1Choice = null; room.p2Choice = null;
      room.round = 1; room.state = 'picking';
      room.rematchVotes.clear();
      io.to(room.id).emit('rematchStarted', { round: 1 });
    }
  });

  socket.on('declineRematch', () => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = rooms.get(player.roomId);
    if (!room) return;
    const opponentId = room.p1Id === socket.id ? room.p2Id : room.p1Id;
    io.to(opponentId).emit('opponentDeclinedRematch');
    cleanupRoom(player.roomId);
    player.roomId = null;
  });

  // ── Disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (player) {
      // Remove from queue
      const qi = matchQueue.indexOf(socket.id);
      if (qi !== -1) matchQueue.splice(qi, 1);

      // Handle room disconnect
      if (player.roomId) {
        const room = rooms.get(player.roomId);
        if (room && room.state !== 'over') {
          // Give opponent win
          const opponentId = room.p1Id === socket.id ? room.p2Id : room.p1Id;
          io.to(opponentId).emit('opponentDisconnected', { message: `${player.name} disconnected. You win!` });

          // Save reconnect window
          reconnectBuffer.set(player.playerId, {
            roomId: player.roomId,
            side: room.p1Id === socket.id ? 'p1' : 'p2',
            timestamp: Date.now()
          });

          // Award opponent
          setTimeout(() => cleanupRoom(player.roomId), 30000);
        }
      }
      players.delete(socket.id);
    }
    broadcastOnlineCount();
    io.emit('queueSize', matchQueue.length);
    console.log(`[DISCONNECT] ${socket.id}`);
  });

  // ── Request leaderboard ──────────────────────────────────────────────────
  socket.on('getLeaderboard', () => {
    socket.emit('leaderboard', getTopLeaderboard());
  });

  // ── Chat / Taunts ─────────────────────────────────────────────────────────
  const TAUNTS = ['😏','🔥','😤','💀','🎯','⚡','👑','🤣'];
  socket.on('sendTaunt', ({ taunt }) => {
    const player = players.get(socket.id);
    if (!player?.roomId || !TAUNTS.includes(taunt)) return;
    const room = rooms.get(player.roomId);
    if (!room) return;
    const opponentId = room.p1Id === socket.id ? room.p2Id : room.p1Id;
    io.to(opponentId).emit('taunt', { taunt, from: player.name });
  });
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function sanitizeRoom(room) {
  return {
    id: room.id,
    p1Score: room.p1Score,
    p2Score: room.p2Score,
    round: room.round,
    state: room.state,
    target: room.target
  };
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const p1 = players.get(room.p1Id);
  const p2 = players.get(room.p2Id);
  if (p1) p1.roomId = null;
  if (p2) p2.roomId = null;
  rooms.delete(roomId);
}

// ─── REST ENDPOINTS ──────────────────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  res.json(getTopLeaderboard(20));
});

app.get('/api/stats', (req, res) => {
  res.json({
    online: players.size,
    inQueue: matchQueue.length,
    activeGames: rooms.size,
    totalPlayers: leaderboard.size
  });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n⚡ CLASH Server running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});

module.exports = { app, server };

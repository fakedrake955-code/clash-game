const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── DATA ─────────────────────────────────────────────────────────────────────
const players = {};   // playerId -> { name, elo, rank, wins, losses, streak, socketId }
const queue = [];     // [socketId, ...]
const rooms = {};     // roomId -> { p1, p2, scores, target, choices }

// ── RANKS ────────────────────────────────────────────────────────────────────
function getRank(elo) {
  if (elo >= 2000) return { name: 'Legend',   icon: '👑', color: '#ff6b35' };
  if (elo >= 1600) return { name: 'Diamond',  icon: '💎', color: '#b040ff' };
  if (elo >= 1300) return { name: 'Platinum', icon: '🔷', color: '#00e5ff' };
  if (elo >= 1100) return { name: 'Gold',     icon: '🥇', color: '#ffd700' };
  if (elo >= 950)  return { name: 'Silver',   icon: '🥈', color: '#c0c0c0' };
  return                  { name: 'Bronze',   icon: '🥉', color: '#cd7f32' };
}

function calcElo(winnerElo, loserElo) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  return Math.round(K * (1 - expected));
}

// ── CHAT ─────────────────────────────────────────────────────────────────────
const chatHistory = []; // last 50 messages
const CHAT_MAX = 50;
const CHAT_RATE_MS = 1500; // min ms between messages per player
const lastChatTime = {}; // socketId -> timestamp

// ── SOCKET ────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  socket.on('identify', ({ playerId, name, elo }) => {
    let pid = playerId || uuidv4();
    if (!players[pid]) {
      players[pid] = { name: name || 'WARRIOR', elo: elo || 1000, wins: 0, losses: 0, streak: 0 };
    } else {
      players[pid].name = name || players[pid].name;
    }
    players[pid].socketId = socket.id;
    socket.playerId = pid;

    const rank = getRank(players[pid].elo);
    socket.emit('identified', { playerId: pid, elo: players[pid].elo, rank });
    io.emit('onlineCount', Object.keys(players).filter(p => players[p].socketId).length);

    // Send recent chat history to new player
    chatHistory.forEach(msg => {
      socket.emit('chatMessage', { ...msg, isMe: false });
    });

    // System message in chat
    broadcastChat(null, `⚡ ${players[pid].name} joined the arena!`, true);
  });

  socket.on('joinQueue', () => {
    if (!queue.includes(socket.id)) queue.push(socket.id);
    socket.emit('queueJoined');
    io.emit('queueSize', queue.length);
    tryMatch();
  });

  socket.on('leaveQueue', () => {
    const i = queue.indexOf(socket.id);
    if (i !== -1) queue.splice(i, 1);
    io.emit('queueSize', queue.length);
  });

  socket.on('makeChoice', ({ choice }) => {
    const room = getRoomFor(socket.id);
    if (!room) return;
    const side = room.p1 === socket.id ? 'p1' : 'p2';
    room.choices[side] = choice;
    const opp = side === 'p1' ? room.p2 : room.p1;
    io.to(opp).emit('opponentChose');
    if (room.choices.p1 && room.choices.p2) resolveRound(room);
  });

  socket.on('rematch', () => {
    const room = getRoomFor(socket.id);
    if (!room) return;
    room.wantsRematch = room.wantsRematch || {};
    room.wantsRematch[socket.id] = true;
    const opp = room.p1 === socket.id ? room.p2 : room.p1;
    io.to(opp).emit('opponentWantsRematch');
    if (room.wantsRematch[room.p1] && room.wantsRematch[room.p2]) {
      room.scores = { p1: 0, p2: 0 };
      room.choices = {};
      room.wantsRematch = {};
      io.to(room.p1).emit('rematchStarted');
      io.to(room.p2).emit('rematchStarted');
    }
  });

  socket.on('declineRematch', () => {
    const room = getRoomFor(socket.id);
    if (!room) return;
    const opp = room.p1 === socket.id ? room.p2 : room.p1;
    io.to(opp).emit('opponentDeclinedRematch');
    deleteRoom(room.id);
  });

  socket.on('sendTaunt', ({ taunt }) => {
    const room = getRoomFor(socket.id);
    if (!room) return;
    const pid = socket.playerId;
    const name = pid && players[pid] ? players[pid].name : 'PLAYER';
    const opp = room.p1 === socket.id ? room.p2 : room.p1;
    io.to(opp).emit('taunt', { taunt, from: name });
  });

  socket.on('getLeaderboard', () => {
    sendLeaderboard(socket);
  });

  // ── GLOBAL CHAT ────────────────────────────────────────────────────────────
  socket.on('sendChat', ({ message }) => {
    if (!message || typeof message !== 'string') return;
    const clean = message.trim().substring(0, 80);
    if (!clean) return;

    // Rate limit
    const now = Date.now();
    if (lastChatTime[socket.id] && now - lastChatTime[socket.id] < CHAT_RATE_MS) return;
    lastChatTime[socket.id] = now;

    const pid = socket.playerId;
    if (!pid || !players[pid]) return;

    const player = players[pid];
    const rank = getRank(player.elo);
    const msgData = {
      name: player.name,
      rank,
      elo: player.elo,
      message: clean,
      socketId: socket.id,
    };

    // Save to history
    chatHistory.push(msgData);
    if (chatHistory.length > CHAT_MAX) chatHistory.shift();

    // Broadcast to everyone
    io.sockets.sockets.forEach((s) => {
      s.emit('chatMessage', { ...msgData, isMe: s.id === socket.id });
    });
  });

  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] ${socket.id}`);
    const i = queue.indexOf(socket.id);
    if (i !== -1) queue.splice(i, 1);

    const room = getRoomFor(socket.id);
    if (room) {
      const opp = room.p1 === socket.id ? room.p2 : room.p1;
      io.to(opp).emit('opponentDisconnected', { message: 'Opponent disconnected!' });
      deleteRoom(room.id);
    }

    if (socket.playerId) {
      const p = players[socket.playerId];
      if (p) {
        delete p.socketId;
        broadcastChat(null, `👋 ${p.name} left the arena.`, true);
      }
    }

    delete lastChatTime[socket.id];
    io.emit('onlineCount', Object.keys(players).filter(p => players[p].socketId).length);
    io.emit('queueSize', queue.length);
  });
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
function broadcastChat(socketId, message, isSystem = false) {
  if (isSystem) {
    io.emit('chatMessage', { name: 'SYSTEM', rank: { icon: '⚡', color: '#ffd700' }, elo: '', message, isMe: false, isSystem: true });
  }
}

function tryMatch() {
  while (queue.length >= 2) {
    const s1 = queue.shift();
    const s2 = queue.shift();
    const sock1 = io.sockets.sockets.get(s1);
    const sock2 = io.sockets.sockets.get(s2);
    if (!sock1 || !sock2) { if (sock1) queue.unshift(s1); if (sock2) queue.unshift(s2); continue; }

    const roomId = uuidv4();
    const p1data = players[sock1.playerId] || { name: 'P1', elo: 1000 };
    const p2data = players[sock2.playerId] || { name: 'P2', elo: 1000 };

    rooms[roomId] = { id: roomId, p1: s1, p2: s2, scores: { p1: 0, p2: 0 }, choices: {}, target: 3 };

    sock1.roomId = roomId; sock2.roomId = roomId;

    sock1.emit('matchFound', { yourSide: 'p1', opponent: { name: p2data.name, elo: p2data.elo, rank: getRank(p2data.elo) }, target: 3 });
    sock2.emit('matchFound', { yourSide: 'p2', opponent: { name: p1data.name, elo: p1data.elo, rank: getRank(p1data.elo) }, target: 3 });

    io.emit('queueSize', queue.length);
    console.log(`[MATCH] ${p1data.name} vs ${p2data.name} — Room: ${roomId}`);
  }
}

const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

function resolveRound(room) {
  const { p1Choice, p2Choice } = { p1Choice: room.choices.p1, p2Choice: room.choices.p2 };
  let result;
  if (p1Choice === p2Choice) result = 'draw';
  else if (BEATS[p1Choice] === p2Choice) result = 'p1';
  else result = 'p2';

  if (result !== 'draw') room.scores[result]++;
  room.choices = {};

  const data = { p1Choice, p2Choice, result, p1Score: room.scores.p1, p2Score: room.scores.p2 };
  io.to(room.p1).emit('roundResult', data);
  io.to(room.p2).emit('roundResult', data);

  if (room.scores.p1 >= room.target || room.scores.p2 >= room.target) {
    const winner = room.scores.p1 >= room.target ? 'p1' : 'p2';
    endGame(room, winner);
  } else {
    const round = room.scores.p1 + room.scores.p2 + 1;
    setTimeout(() => {
      io.to(room.p1).emit('nextRound', { round });
      io.to(room.p2).emit('nextRound', { round });
    }, 900);
  }
}

function endGame(room, winner) {
  const sock1 = io.sockets.sockets.get(room.p1);
  const sock2 = io.sockets.sockets.get(room.p2);
  const p1 = sock1 && players[sock1.playerId];
  const p2 = sock2 && players[sock2.playerId];

  let p1change = 0, p2change = 0;
  if (p1 && p2) {
    const delta = calcElo(winner === 'p1' ? p1.elo : p2.elo, winner === 'p1' ? p2.elo : p1.elo);
    if (winner === 'p1') { p1change = delta; p2change = -delta; p1.wins++; p2.losses++; p1.streak++; p2.streak = 0; }
    else                 { p2change = delta; p1change = -delta; p2.wins++; p1.losses++; p2.streak++; p1.streak = 0; }
    p1.elo = Math.max(100, p1.elo + p1change);
    p2.elo = Math.max(100, p2.elo + p2change);
  }

  const base = { winner, p1Score: room.scores.p1, p2Score: room.scores.p2 };
  if (sock1) sock1.emit('gameOver', { ...base, yourSide: 'p1', eloChange: p1change, newElo: p1?.elo, newRank: p1 ? getRank(p1.elo) : null });
  if (sock2) sock2.emit('gameOver', { ...base, yourSide: 'p2', eloChange: p2change, newElo: p2?.elo, newRank: p2 ? getRank(p2.elo) : null });
}

function getRoomFor(socketId) {
  const sock = io.sockets.sockets.get(socketId);
  return sock && sock.roomId ? rooms[sock.roomId] : null;
}
function deleteRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const s1 = io.sockets.sockets.get(room.p1);
  const s2 = io.sockets.sockets.get(room.p2);
  if (s1) delete s1.roomId;
  if (s2) delete s2.roomId;
  delete rooms[roomId];
}

function sendLeaderboard(socket) {
  const top = Object.values(players)
    .sort((a, b) => b.elo - a.elo)
    .slice(0, 20)
    .map(p => ({ name: p.name, elo: p.elo, rank: getRank(p.elo), wins: p.wins, losses: p.losses, streak: p.streak }));
  socket.emit('leaderboard', top);
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`⚡ CLASH Server running on port ${PORT}`));

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const TRACKS = ['circle', 'oval', 'windy'];
const DURATIONS = [60, 120, 180];

const rooms = {};

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) res.status(500).send('public/index.html is missing in the repository. Put index.html inside a folder named public next to server.js.');
  });
});
app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: Object.keys(rooms).length });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

function cleanName(n) {
  const s = String(n == null ? '' : n).replace(/[<>&"'`]/g, '').trim().slice(0, 16);
  return s || 'Driver';
}

function cleanColor(c) {
  const s = String(c == null ? '' : c);
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : '#ff6a1a';
}

function cleanCarId(c) {
  const s = String(c == null ? '' : c).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  return s || 'tiny';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function genCode() {
  for (let t = 0; t < 300; t++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms[c]) return c;
  }
  return null;
}

function publicRoom(room) {
  return {
    roomCode: room.code,
    hostId: room.hostId,
    max: MAX_PLAYERS,
    started: room.started,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      carId: p.carId,
      isHost: p.id === room.hostId
    }))
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('roomUpdate', publicRoom(room));
}

function removePlayer(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  socket.leave(code);
  socket.data.roomCode = null;
  const room = rooms[code];
  if (!room) return;
  const idx = room.players.findIndex((p) => p.id === socket.id);
  if (idx >= 0) room.players.splice(idx, 1);
  if (room.players.length === 0) {
    delete rooms[code];
    return;
  }
  if (room.hostId === socket.id) {
    room.hostId = room.players[0].id;
  }
  if (room.started && room.players.every((p) => !p.racing)) {
    room.started = false;
  }
  io.to(code).emit('playerLeft', { id: socket.id });
  broadcastRoom(room);
}

function playerJoin(room, socket, data) {
  room.players.push({
    id: socket.id,
    name: cleanName(data && data.name),
    color: cleanColor(data && data.color),
    carId: cleanCarId(data && data.carId),
    racing: false
  });
  socket.join(room.code);
  socket.data.roomCode = room.code;
  broadcastRoom(room);
}

function reply(cb, payload) {
  if (typeof cb === 'function') cb(payload);
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;

  socket.on('createRoom', (data, cb) => {
    if (typeof data === 'function') {
      cb = data;
      data = {};
    }
    removePlayer(socket);
    const code = genCode();
    if (!code) {
      socket.emit('errorMsg', 'Server is busy, try again');
      reply(cb, { error: 'Server is busy, try again' });
      return;
    }
    const room = {
      code: code,
      hostId: socket.id,
      players: [],
      started: false
    };
    rooms[code] = room;
    playerJoin(room, socket, data);
    socket.emit('roomCreated', { roomCode: code });
    reply(cb, { roomCode: code });
  });

  function handleJoin(data, cb) {
    if (typeof data === 'function') {
      cb = data;
      data = {};
    }
    let code = '';
    if (data && typeof data === 'object') code = String(data.code == null ? '' : data.code).trim();
    else code = String(data == null ? '' : data).trim();
    const room = rooms[code];
    if (!room) {
      socket.emit('errorMsg', 'Code does not exist');
      reply(cb, { error: 'Code does not exist' });
      return;
    }
    if (socket.data.roomCode === code) {
      broadcastRoom(room);
      reply(cb, { roomCode: code });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit('errorMsg', 'Room full');
      reply(cb, { error: 'Room full' });
      return;
    }
    if (room.started) {
      socket.emit('errorMsg', 'Race already started');
      reply(cb, { error: 'Race already started' });
      return;
    }
    removePlayer(socket);
    playerJoin(room, socket, data);
    socket.emit('roomJoined', { roomCode: code });
    reply(cb, { roomCode: code });
  }

  socket.on('joinRoom', handleJoin);
  socket.on('playerJoin', handleJoin);

  socket.on('hostStart', (data, cb) => {
    if (typeof data === 'function') {
      cb = data;
      data = {};
    }
    const code = socket.data.roomCode;
    const room = code ? rooms[code] : null;
    if (!room) {
      socket.emit('errorMsg', 'You are not in a room');
      reply(cb, { error: 'You are not in a room' });
      return;
    }
    if (room.hostId !== socket.id) {
      socket.emit('errorMsg', 'Only the host can start the race');
      reply(cb, { error: 'Only the host can start the race' });
      return;
    }
    if (room.started) {
      reply(cb, { error: 'Race already started' });
      return;
    }
    const track = TRACKS.includes(data && data.track) ? data.track : 'circle';
    const duration = DURATIONS.includes(Number(data && data.duration)) ? Number(data.duration) : 60;
    room.started = true;
    room.players.forEach((p) => {
      p.racing = true;
    });
    const seed = Math.floor(Math.random() * 1000000) + 1;
    io.to(code).emit('raceStart', {
      track: track,
      duration: duration,
      seed: seed,
      players: publicRoom(room).players
    });
    reply(cb, { ok: true });
  });

  socket.on('playerPos', (d) => {
    const code = socket.data.roomCode;
    if (!code || !d) return;
    const room = rooms[code];
    if (!room || !room.started) return;
    socket.to(code).volatile.emit('playerPos', {
      id: socket.id,
      x: num(d.x),
      y: num(d.y),
      angle: num(d.angle),
      spd: num(d.spd),
      lap: num(d.lap),
      prog: num(d.prog),
      dist: num(d.dist),
      steer: num(d.steer),
      slip: num(d.slip),
      drift: d.drift ? 1 : 0,
      brake: d.brake ? 1 : 0,
      done: d.done ? 1 : 0,
      tf: num(d.tf)
    });
  });

  socket.on('raceOver', () => {
    const code = socket.data.roomCode;
    const room = code ? rooms[code] : null;
    if (!room) return;
    const me = room.players.find((p) => p.id === socket.id);
    if (me) me.racing = false;
    if (room.started && room.players.every((p) => !p.racing)) {
      room.started = false;
    }
    broadcastRoom(room);
  });

  socket.on('pingCheck', (cb) => {
    reply(cb, Date.now());
  });

  socket.on('leaveRoom', (data, cb) => {
    removePlayer(socket);
    reply(typeof data === 'function' ? data : cb, { ok: true });
  });

  socket.on('disconnect', () => {
    removePlayer(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('APEX RACING server listening on port ' + PORT);
});

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const TRACKS = ['sunset', 'city', 'mountain', 'coastal', 'serpent', 'hell', 'neon', 'circle', 'oval', 'windy'];
const TYPES = ['circuit', 'sprint', 'drift', 'attack'];
const LAPOPTS = [1, 3, 5, 0];
const DURATIONS = [60, 120, 180, 300, 600];

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
    waiting: !!room.cfg,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      carId: p.carId,
      isHost: p.id === room.hostId,
      ready: !!p.ready
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
    if (room.goTimer) clearTimeout(room.goTimer);
    delete rooms[code];
    return;
  }
  if (room.hostId === socket.id) {
    room.hostId = room.players[0].id;
  }
  if (room.pos) delete room.pos[socket.id];
  if (room.started && room.players.every((p) => !p.racing)) {
    room.started = false;
  }
  io.to(code).emit('playerLeft', { id: socket.id });
  broadcastRoom(room);
  maybeStart(room);
}

/* ---- server-authoritative race start ---- */
const COUNTDOWN_MS = 5000;
function maybeStart(room) {
  if (room.started || !room.cfg || room.players.length === 0) return;
  if (!room.players.every((p) => p.ready)) return;
  const code = room.code, now = Date.now(), raceStartTime = now + COUNTDOWN_MS;
  room.started = true;
  room.raceStartTime = raceStartTime;
  room.pos = {};
  room.players.forEach((p) => { p.racing = true; });
  const payload = Object.assign({}, room.cfg, {
    seed: Math.floor(Math.random() * 1000000) + 1,
    raceStartTime: raceStartTime,
    serverNow: now,
    players: publicRoom(room).players
  });
  room.players.forEach((p) => { p.ready = false; });
  room.cfg = null;
  io.to(code).emit('countdown_start', payload);
  broadcastRoom(room);
  if (room.goTimer) clearTimeout(room.goTimer);
  room.goTimer = setTimeout(() => {
    io.to(code).emit('race_go', { raceStartTime: raceStartTime, serverNow: Date.now() });
  }, Math.max(0, raceStartTime - Date.now()));
}

function playerJoin(room, socket, data) {
  room.players.push({
    id: socket.id,
    name: cleanName(data && data.name),
    color: cleanColor(data && data.color),
    carId: cleanCarId(data && data.carId),
    racing: false,
    ready: false
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
    const track = TRACKS.includes(data && data.track) ? data.track : 'sunset';
    const duration = DURATIONS.includes(Number(data && data.duration)) ? Number(data.duration) : 180;
    const dm = data && data.dm === 'laps' ? 'laps' : 'time';
    const laps = LAPOPTS.includes(Number(data && data.laps)) ? Number(data.laps) : 3;
    const type = TYPES.includes(data && data.type) ? data.type : 'circuit';
    const ramps = !!(data && data.ramps), obst = !!(data && data.obst);
    room.cfg = { track: track, duration: duration, dm: dm, laps: laps, type: type, ramps: ramps, obst: obst };
    const hp = room.players.find((p) => p.id === socket.id);
    if (hp) hp.ready = true;
    broadcastRoom(room);
    maybeStart(room);
    reply(cb, { ok: true });
  });

  socket.on('setReady', (v) => {
    const room = socket.data.roomCode ? rooms[socket.data.roomCode] : null;
    if (!room || room.started) return;
    const p = room.players.find((x) => x.id === socket.id);
    if (!p) return;
    p.ready = !!v;
    broadcastRoom(room);
    maybeStart(room);
  });

  socket.on('cancelStart', () => {
    const room = socket.data.roomCode ? rooms[socket.data.roomCode] : null;
    if (!room || room.started || room.hostId !== socket.id) return;
    room.cfg = null;
    room.players.forEach((p) => { p.ready = false; });
    broadcastRoom(room);
  });

  socket.on('playerPos', (d) => {
    const code = socket.data.roomCode;
    if (!code || !d) return;
    const room = rooms[code];
    if (!room || !room.started) return;
    /* server-side collision validation: tell the sender when it overlaps another car */
    const now = Date.now(), px = num(d.x), py = num(d.y), rad = Math.min(9, Math.max(2, num(d.rad) || 5));
    if (!room.pos) room.pos = {};
    room.pos[socket.id] = { x: px, y: py, rad: rad, t: now };
    Object.keys(room.pos).forEach((oid) => {
      if (oid === socket.id) return;
      const o = room.pos[oid];
      if (now - o.t > 400) return;
      const dx = px - o.x, dy = py - o.y, rr = rad + o.rad, d2 = dx * dx + dy * dy;
      if (d2 < rr * rr && d2 > 1e-6) {
        const dd = Math.sqrt(d2);
        socket.emit('bump', { id: oid, nx: dx / dd, nz: dy / dd, depth: rr - dd });
      }
    });
    socket.to(code).volatile.emit('playerPos', {
      id: socket.id,
      t: now,
      thr: num(d.thr),
      bst: d.bst ? 1 : 0,
      cp: num(d.cp),
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
      tf: num(d.tf),
      h: num(d.h),
      pit: num(d.pit),
      rol: num(d.rol),
      air: d.air ? 1 : 0,
      pts: num(d.pts),
      bl: num(d.bl)
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
      room.pos = {};
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

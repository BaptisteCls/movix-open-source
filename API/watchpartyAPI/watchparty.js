import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { promises as fsp } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

// --- Config ---
const PORT = Number(process.env.WATCHPARTY_PORT || 25566);
const parseCorsOrigin = (value, fallback) => {
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === '*') return '*';
  if (value.includes(',')) return value.split(',').map((v) => v.trim()).filter(Boolean);
  return value;
};

const WATCHPARTY_CORS_CREDENTIALS = (process.env.WATCHPARTY_CORS_CREDENTIALS || 'true') === 'true';
const WATCHPARTY_REST_CORS_ORIGIN = parseCorsOrigin(process.env.WATCHPARTY_REST_CORS_ORIGIN, true);
const WATCHPARTY_SOCKET_CORS_ORIGIN = parseCorsOrigin(process.env.WATCHPARTY_SOCKET_CORS_ORIGIN, '*');
const WATCHPARTY_SOCKET_CORS_METHODS = (process.env.WATCHPARTY_SOCKET_CORS_METHODS || 'GET,POST')
  .split(',')
  .map((method) => method.trim())
  .filter(Boolean);
const app = express();

// Autoriser toutes les origines (API REST)
app.use(cors({ origin: WATCHPARTY_REST_CORS_ORIGIN, credentials: WATCHPARTY_CORS_CREDENTIALS }));
app.use(express.json({ limit: '100mb' }));

// HTTP server + Socket.IO (CORS ouvert)
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: WATCHPARTY_SOCKET_CORS_ORIGIN,
    methods: WATCHPARTY_SOCKET_CORS_METHODS,
    credentials: WATCHPARTY_CORS_CREDENTIALS
  }
});

// --- Persistance basique des rooms ---
const CACHE_DIR = path.join(__dirname, 'cache');
const WATCHPARTY_ROOMS_FILE = path.join(CACHE_DIR, 'watchparty-rooms.json');
const watchpartyRooms = new Map();

async function ensureCacheDir() {
  try { await fsp.access(CACHE_DIR); } catch { await fsp.mkdir(CACHE_DIR, { recursive: true }); }
}

async function loadRoomsFromDisk() {
  try {
    await ensureCacheDir();
    const data = await fsp.readFile(WATCHPARTY_ROOMS_FILE, 'utf-8');
    const roomsArray = JSON.parse(data);
    roomsArray.forEach((room) => watchpartyRooms.set(room.id, room));
    // Optionnel: supprimer le fichier après restauration, comme dans le serveur principal
    try { await fsp.unlink(WATCHPARTY_ROOMS_FILE); } catch { }
    console.log(`[Watchparty] ${roomsArray.length} rooms restaurées depuis le disque.`);
  } catch { }
}

async function saveRoomsToDisk() {
  try {
    await ensureCacheDir();
    const roomsArray = Array.from(watchpartyRooms.values());
    await fsp.writeFile(WATCHPARTY_ROOMS_FILE, JSON.stringify(roomsArray, null, 2), 'utf-8');
    console.log(`[Watchparty] ${roomsArray.length} rooms sauvegardées sur le disque.`);
  } catch (e) {
    console.error('[Watchparty] Erreur lors de la sauvegarde des rooms:', e);
  }
}

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Watchparty] Signal ${signal} reçu. Sauvegarde des rooms avant arrêt...`);
  await saveRoomsToDisk();
  try { io.close(); } catch { }
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// --- Helpers ---
function generateRoomCode() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) result += charset[Math.floor(Math.random() * charset.length)];
  return result;
}

// --- Socket.IO namespace dédié watchparty ---
const watchpartyIO = io.of('/watchparty');
const SYNC_PRO_SCHEDULE_DELAY_MS = 250;

function buildRoomInfo(roomId, room) {
  return {
    id: roomId,
    code: room.code,
    hostId: room.hostId,
    maxParticipants: room.maxParticipants,
    isPublic: !!room.isPublic,
    syncMode: room.syncMode || 'classic',
    chatEnabled: room.chatEnabled !== false,
    controlMode: room.controlMode,
    coHosts: room.coHosts,
    media: room.media,
    createdAt: room.createdAt,
    participants: room.participants
  };
}

function emitRoomInfo(roomId, room) {
  watchpartyIO.to(roomId).emit('room:info', buildRoomInfo(roomId, room));
}

function emitControlState(roomId, room) {
  watchpartyIO.to(roomId).emit('control:state', {
    controlMode: room.controlMode,
    coHosts: room.coHosts,
    pendingRequests: room.pendingControlRequests
  });
}

function buildScheduledPlaybackEvent(playbackUpdate, action) {
  const serverNow = Date.now();
  return {
    action,
    position: playbackUpdate.position,
    scheduledAt: serverNow + SYNC_PRO_SCHEDULE_DELAY_MS,
    serverNow,
    updatedBy: playbackUpdate.updatedBy
  };
}

watchpartyIO.on('connection', (socket) => {
  console.log('New watch party connection:', socket.id);

  const roomId = socket.handshake.query.roomId;
  const nickname = socket.handshake.query.nickname || 'Guest';

  if (!roomId || !watchpartyRooms.has(roomId)) {
    console.log(`Invalid room ID: ${roomId}`);
    socket.emit('error', { message: 'Invalid room ID' });
    socket.disconnect();
    return;
  }

  // Join room
  socket.join(roomId);
  const room = watchpartyRooms.get(roomId);

  // Add participant
  const participant = {
    id: socket.id,
    nickname,
    isHost: room.participants.length === 0,
    isActive: true,
    joinedAt: Date.now()
  };
  if (room.participants.length === 0) room.hostId = socket.id;
  room.participants.push(participant);

  // Emit room info + participants
  emitRoomInfo(roomId, room);
  watchpartyIO.to(roomId).emit('room:participants', room.participants);
  // Send control state and ready state to the new participant
  socket.emit('control:state', {
    controlMode: room.controlMode,
    coHosts: room.coHosts,
    pendingRequests: room.pendingControlRequests
  });
  socket.emit('ready:state', room.readyState);

  // System join message
  const joinMessage = {
    id: uuidv4(),
    senderId: 'system',
    senderNickname: 'System',
    text: `${participant.nickname} a rejoint la Watch Party.`,
    timestamp: Date.now(),
    type: 'system'
  };
  room.messages.push(joinMessage);
  watchpartyIO.to(roomId).emit('room:chat', joinMessage);

  // Send current playback state + chat history + pause timer
  socket.emit('room:playback', room.playbackState);
  if (room.pauseTimer && room.pauseTimer.endTime > Date.now()) {
    socket.emit('pause:timerStarted', room.pauseTimer);
  }
  room.messages.filter(m => !m.deleted).forEach(m => socket.emit('room:chat', m));

  // Chat
  socket.on('chat:message', (data) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (r.chatEnabled === false && socket.id !== r.hostId) return;
    const me = r.participants.find(p => p.id === socket.id);
    if (!me) return;
    const msg = {
      id: uuidv4(),
      senderId: socket.id,
      senderNickname: me.nickname,
      text: data.text,
      timestamp: Date.now(),
      type: 'chat'
    };
    r.messages.push(msg);
    if (r.messages.length > 100) r.messages.shift();
    watchpartyIO.to(roomId).emit('room:chat', msg);
  });

  socket.on('playback:update', (data) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    // Check if user can control: host, co-host, or democratic mode
    const canControl = socket.id === r.hostId ||
      r.coHosts.includes(socket.id) ||
      r.controlMode === 'democratic';

    console.log(`[Playback] User ${socket.id} trying to update. Host: ${r.hostId}, CoHosts: [${r.coHosts.join(', ')}], Mode: ${r.controlMode}, CanControl: ${canControl}`);

    if (canControl) {
      const playbackUpdate = {
        isPlaying: data.isPlaying,
        position: data.position,
        updatedAt: Date.now(),
        updatedBy: socket.id
      };
      const reason = ['play', 'pause', 'seek', 'heartbeat', 'ended'].includes(data.reason)
        ? data.reason
        : 'heartbeat';
      r.playbackState = playbackUpdate;
      // Broadcast aux autres clients (exclure le sender pour éviter la boucle de feedback)
      socket.to(roomId).emit('playback:state', playbackUpdate);
      if (r.syncMode === 'pro' && reason !== 'heartbeat') {
        socket.to(roomId).emit(
          'playback:schedule',
          buildScheduledPlaybackEvent(playbackUpdate, reason === 'ended' ? 'pause' : reason)
        );
      }
    } else {
      console.log(`[Playback] REJECTED update from ${socket.id} - not authorized`);
    }
  });

  // Control request from participant
  socket.on('control:request', () => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id === r.hostId || r.coHosts.includes(socket.id)) return; // Already has control
    const me = r.participants.find(p => p.id === socket.id);
    if (!me) return;
    // Check if already pending
    if (r.pendingControlRequests.some(req => req.participantId === socket.id)) return;
    r.pendingControlRequests.push({
      participantId: socket.id,
      nickname: me.nickname,
      requestedAt: Date.now()
    });
    // Notify host of request
    const hostSocket = watchpartyIO.sockets.get(r.hostId);
    if (hostSocket) {
      hostSocket.emit('control:requestReceived', { participantId: socket.id, nickname: me.nickname });
    }
    // Broadcast updated control state
    watchpartyIO.to(roomId).emit('control:state', {
      controlMode: r.controlMode,
      coHosts: r.coHosts,
      pendingRequests: r.pendingControlRequests
    });
  });

  // Host approves control request
  socket.on('control:approve', ({ participantId }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return; // Only host can approve
    // Remove from pending
    r.pendingControlRequests = r.pendingControlRequests.filter(req => req.participantId !== participantId);
    // Add to co-hosts if not already
    if (!r.coHosts.includes(participantId)) {
      r.coHosts.push(participantId);
    }
    // Notify the participant
    const targetSocket = watchpartyIO.sockets.get(participantId);
    if (targetSocket) {
      targetSocket.emit('control:approved');
    }
    // System message
    const participant = r.participants.find(p => p.id === participantId);
    const systemMsg = {
      id: uuidv4(), senderId: 'system', senderNickname: 'System',
      text: `${participant?.nickname || 'Un participant'} peut maintenant contrôler la lecture.`,
      timestamp: Date.now(), type: 'system'
    };
    r.messages.push(systemMsg);
    watchpartyIO.to(roomId).emit('room:chat', systemMsg);
    // Broadcast updated control state
    watchpartyIO.to(roomId).emit('control:state', {
      controlMode: r.controlMode,
      coHosts: r.coHosts,
      pendingRequests: r.pendingControlRequests
    });
  });

  // Host denies control request
  socket.on('control:deny', ({ participantId }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    r.pendingControlRequests = r.pendingControlRequests.filter(req => req.participantId !== participantId);
    const targetSocket = watchpartyIO.sockets.get(participantId);
    if (targetSocket) {
      targetSocket.emit('control:denied');
    }
    watchpartyIO.to(roomId).emit('control:state', {
      controlMode: r.controlMode,
      coHosts: r.coHosts,
      pendingRequests: r.pendingControlRequests
    });
  });

  // Host revokes control from co-host
  socket.on('control:revoke', ({ participantId }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    r.coHosts = r.coHosts.filter(id => id !== participantId);
    const targetSocket = watchpartyIO.sockets.get(participantId);
    if (targetSocket) {
      targetSocket.emit('control:revoked');
    }
    watchpartyIO.to(roomId).emit('control:state', {
      controlMode: r.controlMode,
      coHosts: r.coHosts,
      pendingRequests: r.pendingControlRequests
    });
  });

  // Host toggles control mode
  socket.on('control:setMode', ({ mode }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    if (mode === 'host-only' || mode === 'democratic') {
      r.controlMode = mode;
      const systemMsg = {
        id: uuidv4(), senderId: 'system', senderNickname: 'System',
        text: mode === 'democratic'
          ? '🎮 Mode démocratique activé - Tout le monde peut contrôler la lecture !'
          : '🔒 Mode hôte activé - Seul l\'hôte contrôle la lecture.',
        timestamp: Date.now(), type: 'system'
      };
      r.messages.push(systemMsg);
      watchpartyIO.to(roomId).emit('room:chat', systemMsg);
      watchpartyIO.to(roomId).emit('control:state', {
        controlMode: r.controlMode,
        coHosts: r.coHosts,
        pendingRequests: r.pendingControlRequests
      });
    }
  });

  socket.on('sync:setMode', ({ mode }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    if (mode !== 'classic' && mode !== 'pro') return;
    if (r.syncMode === mode) return;

    r.syncMode = mode;
    const systemMsg = {
      id: uuidv4(),
      senderId: 'system',
      senderNickname: 'System',
      text: mode === 'pro'
        ? 'Sync Pro activé par l’hôte. La synchronisation avancée est maintenant active.'
        : 'Le mode de synchronisation classique a été réactivé par l’hôte.',
      timestamp: Date.now(),
      type: 'system'
    };
    r.messages.push(systemMsg);
    watchpartyIO.to(roomId).emit('room:chat', systemMsg);
    watchpartyIO.to(roomId).emit('sync:modeChanged', {
      mode,
      changedBy: socket.id
    });
    emitRoomInfo(roomId, r);
  });

  socket.on('sync:probe', ({ probeId, clientSentAt }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const serverReceivedAt = Date.now();
    socket.emit('sync:probeResult', {
      probeId,
      clientSentAt,
      serverReceivedAt,
      serverSentAt: Date.now()
    });
  });

  socket.on('playback:buffering', ({ isBuffering, position }) => {
    if (!watchpartyRooms.has(roomId)) return;
    socket.to(roomId).emit('playback:buffering', {
      participantId: socket.id,
      isBuffering: !!isBuffering,
      position: Number.isFinite(position) ? position : 0
    });
  });

  socket.on('room:setVisibility', ({ isPublic }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    r.isPublic = isPublic === true;
    emitRoomInfo(roomId, r);
  });

  socket.on('room:toggleChat', ({ enabled }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    r.chatEnabled = enabled !== false;
    watchpartyIO.to(roomId).emit('room:chatToggled', { enabled: r.chatEnabled });
    emitRoomInfo(roomId, r);
  });

  socket.on('room:setMaxParticipants', ({ max }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    const parsedMax = Math.max(r.participants.length, Math.min(50, Number(max) || 10));
    r.maxParticipants = parsedMax;
    emitRoomInfo(roomId, r);
  });

  socket.on('media:change', (media) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;

    r.media = {
      src: media.src || '',
      title: media.title || 'Media',
      poster: media.poster || null,
      mediaType: media.mediaType || 'movie',
      mediaId: media.mediaId || null,
      seasonNumber: media.seasonNumber || null,
      episodeNumber: media.episodeNumber || null,
      nightflixSources: media.nightflixSources || [],
      nexusSources: media.nexusSources || [],
      bravoSources: media.bravoSources || [],
      mp4Sources: media.mp4Sources || [],
      rivestreamSources: media.rivestreamSources || [],
      captions: media.captions || [],
      currentNexusSource: media.currentNexusSource || null,
      currentBravoSource: media.currentBravoSource || null
    };
    r.playbackState = {
      isPlaying: false,
      position: 0,
      updatedAt: Date.now(),
      updatedBy: socket.id
    };

    watchpartyIO.to(roomId).emit('media:updated', r.media);
    watchpartyIO.to(roomId).emit('playback:state', r.playbackState);
    emitRoomInfo(roomId, r);
  });

  // Ready toggle
  socket.on('ready:toggle', () => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    r.readyState[socket.id] = !r.readyState[socket.id];
    watchpartyIO.to(roomId).emit('ready:state', r.readyState);
  });

  // Emoji reaction
  socket.on('reaction:send', ({ emoji }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    const me = r.participants.find(p => p.id === socket.id);
    if (!me) return;
    watchpartyIO.to(roomId).emit('reaction:received', {
      id: uuidv4(),
      emoji,
      senderId: socket.id,
      senderNickname: me.nickname,
      timestamp: Date.now()
    });
  });

  // Pause timer start (host or co-host)
  socket.on('pause:start', ({ duration }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    const canControl = socket.id === r.hostId || r.coHosts.includes(socket.id);
    if (!canControl) return;
    const durationMs = (duration || 60) * 1000; // Default 60 seconds
    r.pauseTimer = {
      endTime: Date.now() + durationMs,
      startedBy: socket.id,
      duration: duration || 60
    };
    // Pause playback
    r.playbackState.isPlaying = false;
    r.playbackState.updatedAt = Date.now();
    r.playbackState.updatedBy = socket.id;
    watchpartyIO.to(roomId).emit('playback:state', r.playbackState);
    if (r.syncMode === 'pro') {
      watchpartyIO.to(roomId).emit('playback:schedule', buildScheduledPlaybackEvent(r.playbackState, 'pause'));
    }
    watchpartyIO.to(roomId).emit('pause:timerStarted', r.pauseTimer);
    // System message
    const me = r.participants.find(p => p.id === socket.id);
    const systemMsg = {
      id: uuidv4(), senderId: 'system', senderNickname: 'System',
      text: `⏸️ ${me?.nickname || 'L\'hôte'} a lancé une pause de ${duration || 60} secondes.`,
      timestamp: Date.now(), type: 'system'
    };
    r.messages.push(systemMsg);
    watchpartyIO.to(roomId).emit('room:chat', systemMsg);
  });

  // Pause timer cancel
  socket.on('pause:cancel', () => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    const canControl = socket.id === r.hostId || r.coHosts.includes(socket.id);
    if (!canControl) return;
    r.pauseTimer = null;
    watchpartyIO.to(roomId).emit('pause:timerCancelled');
  });

  // Vote request for pause (guests only)
  socket.on('vote:request', ({ duration }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    // Only non-hosts can request a vote
    if (socket.id === r.hostId || r.coHosts.includes(socket.id)) return;
    // Don't allow vote if one is already in progress
    if (r.pauseVote) return;

    const me = r.participants.find(p => p.id === socket.id);
    if (!me) return;

    const voteDuration = 20000; // 20 seconds to vote
    r.pauseVote = {
      requestedBy: socket.id,
      requestedByNickname: me.nickname,
      requestedDuration: duration || 60,
      votes: {}, // participantId -> true (yes) or false (no)
      endTime: Date.now() + voteDuration,
      totalParticipants: r.participants.length
    };

    // Auto-resolve after 20 seconds
    r.pauseVote.timeoutId = setTimeout(() => {
      if (watchpartyRooms.has(roomId)) {
        const room = watchpartyRooms.get(roomId);
        if (room.pauseVote) {
          resolveVote(roomId);
        }
      }
    }, voteDuration);

    // Notify everyone about the vote
    watchpartyIO.to(roomId).emit('vote:started', {
      requestedBy: socket.id,
      requestedByNickname: me.nickname,
      requestedDuration: duration || 60,
      endTime: r.pauseVote.endTime,
      totalParticipants: r.participants.length
    });

    // System message
    const voteMsg = {
      id: uuidv4(),
      senderId: 'system',
      senderNickname: 'System',
      text: `${me.nickname} a demandé une pause de ${duration || 60}s. Vote en cours...`,
      timestamp: Date.now(),
      type: 'system'
    };
    r.messages.push(voteMsg);
    watchpartyIO.to(roomId).emit('room:chat', voteMsg);
  });

  // Cast vote
  socket.on('vote:cast', ({ vote }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (!r.pauseVote) return;

    // Record vote (true = yes, false = no)
    r.pauseVote.votes[socket.id] = vote === true;

    // Broadcast vote update
    const yesVotes = Object.values(r.pauseVote.votes).filter(v => v === true).length;
    const noVotes = Object.values(r.pauseVote.votes).filter(v => v === false).length;
    const totalVotes = Object.keys(r.pauseVote.votes).length;

    watchpartyIO.to(roomId).emit('vote:update', {
      yesVotes,
      noVotes,
      totalVotes,
      totalParticipants: r.pauseVote.totalParticipants
    });

    // Check if everyone has voted
    if (totalVotes >= r.pauseVote.totalParticipants) {
      // Clear the timeout since everyone voted
      if (r.pauseVote.timeoutId) {
        clearTimeout(r.pauseVote.timeoutId);
      }
      resolveVote(roomId);
    }
  });

  // Helper function to resolve vote
  function resolveVote(roomId) {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (!r.pauseVote) return;

    const yesVotes = Object.values(r.pauseVote.votes).filter(v => v === true).length;
    const totalVotes = Object.keys(r.pauseVote.votes).length;
    const majority = Math.ceil(r.pauseVote.totalParticipants / 2);

    const passed = yesVotes >= majority;

    if (passed) {
      // Start the pause timer
      const durationMs = r.pauseVote.requestedDuration * 1000;
      r.pauseTimer = {
        endTime: Date.now() + durationMs,
        startedBy: r.pauseVote.requestedBy,
        duration: r.pauseVote.requestedDuration
      };
      // Pause playback
      r.playbackState.isPlaying = false;
      r.playbackState.updatedAt = Date.now();
      r.playbackState.updatedBy = 'vote';
      watchpartyIO.to(roomId).emit('playback:state', r.playbackState);
      if (r.syncMode === 'pro') {
        watchpartyIO.to(roomId).emit('playback:schedule', buildScheduledPlaybackEvent(r.playbackState, 'pause'));
      }
      watchpartyIO.to(roomId).emit('pause:timerStarted', r.pauseTimer);

      // System message
      const passMsg = {
        id: uuidv4(),
        senderId: 'system',
        senderNickname: 'System',
        text: `✅ Vote accepté (${yesVotes}/${r.pauseVote.totalParticipants}). Pause de ${r.pauseVote.requestedDuration}s lancée.`,
        timestamp: Date.now(),
        type: 'system'
      };
      r.messages.push(passMsg);
      watchpartyIO.to(roomId).emit('room:chat', passMsg);
    } else {
      // System message
      const failMsg = {
        id: uuidv4(),
        senderId: 'system',
        senderNickname: 'System',
        text: `❌ Vote refusé (${yesVotes}/${r.pauseVote.totalParticipants}). La majorité n'a pas été atteinte.`,
        timestamp: Date.now(),
        type: 'system'
      };
      r.messages.push(failMsg);
      watchpartyIO.to(roomId).emit('room:chat', failMsg);
    }

    // Notify result and clear vote
    watchpartyIO.to(roomId).emit('vote:ended', {
      passed,
      yesVotes,
      noVotes: totalVotes - yesVotes,
      totalParticipants: r.pauseVote.totalParticipants
    });

    // Clear timeout if it exists
    if (r.pauseVote.timeoutId) {
      clearTimeout(r.pauseVote.timeoutId);
    }
    r.pauseVote = null;
  }

  // Delete message (host only)
  socket.on('message:delete', ({ messageId }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId || !messageId) return;
    const idx = r.messages.findIndex(m => m.id === messageId);
    if (idx !== -1) {
      r.messages[idx].deleted = true;
      watchpartyIO.to(roomId).emit('message:deleted', { messageId });
    }
  });

  // Kick participant (host only)
  socket.on('participant:kick', ({ participantId }) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId || !participantId || participantId === r.hostId) return;
    const target = r.participants.find(p => p.id === participantId);
    if (!target) return;
    const s = watchpartyIO.sockets.get(participantId);
    if (s) {
      s.emit('room:kicked', { reason: 'You have been removed from the watch party by the host.' });
      s.disconnect(true);
    }
    const kickMessage = {
      id: uuidv4(), senderId: 'system', senderNickname: 'System',
      text: `${target.nickname} a été retiré de la Watch Party.`, timestamp: Date.now(), type: 'system'
    };
    r.messages.push(kickMessage);
    watchpartyIO.to(roomId).emit('room:chat', kickMessage);
  });

  // Playback get state
  socket.on('playback:getState', () => {
    console.log(`Socket ${socket.id} requested playback state for room ${roomId}`);
    if (!roomId || typeof roomId !== 'string') {
      console.error(`[playback:getState] Invalid or missing roomId: ${roomId} for socket ${socket.id}`);
      return;
    }
    if (!watchpartyRooms.has(roomId)) {
      console.error(`[playback:getState] Room ${roomId} not found in watchpartyRooms for socket ${socket.id}. Available rooms: ${Array.from(watchpartyRooms.keys())}`);
      const currentSocketRooms = Array.from(socket.rooms);
      console.log(`[playback:getState] Socket ${socket.id} is currently in rooms: ${currentSocketRooms.join(', ')}`);
      return;
    }

    const r = watchpartyRooms.get(roomId);
    if (!r) {
      console.error(`[playback:getState] Room object for ${roomId} is unexpectedly undefined, though key exists.`);
      return;
    }

    if (!r.playbackState) {
      console.warn(`[playback:getState] Room ${roomId} was missing playbackState. Initializing to default.`);
      r.playbackState = {
        isPlaying: false,
        position: 0,
        updatedAt: Date.now(),
        updatedBy: null,
      };
    }

    const stateToSend = r.playbackState;
    socket.emit('playback:state', stateToSend);
    console.log(`[playback:getState] Sent playback state to ${socket.id} for room ${roomId}:`, stateToSend);
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    const idx = r.participants.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    const leaving = r.participants[idx];
    r.participants.splice(idx, 1);

    const leaveMessage = {
      id: uuidv4(), senderId: 'system', senderNickname: 'System',
      text: `${leaving.nickname} a quitté la Watch Party.`, timestamp: Date.now(), type: 'system'
    };
    r.messages.push(leaveMessage);

    // Reassign host if needed
    if (socket.id === r.hostId && r.participants.length > 0) {
      const newHost = r.participants.sort((a, b) => a.joinedAt - b.joinedAt)[0];
      r.hostId = newHost.id; newHost.isHost = true;
      const newHostMsg = {
        id: uuidv4(), senderId: 'system', senderNickname: 'System',
        text: `${newHost.nickname} est maintenant l'hôte de la Watch Party.`, timestamp: Date.now(), type: 'system'
      };
      r.messages.push(newHostMsg);
      watchpartyIO.to(roomId).emit('room:chat', newHostMsg);
    }

    // If empty, auto-clean after 5 min
    if (r.participants.length === 0) {
      setTimeout(() => {
        const still = watchpartyRooms.get(roomId);
        if (still && still.participants.length === 0) {
          watchpartyRooms.delete(roomId);
          console.log(`Room ${roomId} closed due to inactivity`);
        }
      }, 5 * 60 * 1000);
    } else {
      watchpartyIO.to(roomId).emit('room:participants', r.participants);
      watchpartyIO.to(roomId).emit('room:chat', leaveMessage);
      emitRoomInfo(roomId, r);
    }
  });
});

// --- Routes API (mêmes que le serveur principal) ---
app.post('/api/watchparty/create', (req, res) => {
  try {
    const { nickname, maxParticipants, media, roomCode, isPublic, syncMode } = req.body || {};
    if (!nickname || !media?.src) {
      return res.status(400).json({ success: false, message: 'Missing required fields: nickname, media.src' });
    }

    const roomId = uuidv4();
    const code = roomCode || generateRoomCode();

    for (const [, room] of watchpartyRooms.entries()) {
      if (room.code === code) return res.status(400).json({ success: false, message: 'Room code already in use. Please try again.' });
    }

    const newRoom = {
      id: roomId,
      code,
      hostId: null,
      maxParticipants: maxParticipants || 10,
      isPublic: isPublic === true,
      syncMode: syncMode === 'pro' ? 'pro' : 'classic',
      chatEnabled: true,
      controlMode: 'host-only', // 'host-only' | 'democratic'
      coHosts: [],              // Array of participant IDs with control
      pendingControlRequests: [], // Array of {participantId, nickname, requestedAt}
      readyState: {},           // Map: participantId -> boolean
      pauseTimer: null,         // {endTime, startedBy, duration} or null
      pauseVote: null,          // {requestedBy, requestedDuration, votes: {participantId: boolean}, endTime, timeoutId}
      media: {
        src: media.src,
        title: media.title || 'Media',
        poster: media.poster || null,
        mediaType: media.mediaType || 'movie',
        mediaId: media.mediaId || null,
        seasonNumber: media.seasonNumber || null,
        episodeNumber: media.episodeNumber || null,
        nightflixSources: media.nightflixSources || [],
        nexusSources: media.nexusSources || [],
        bravoSources: media.bravoSources || [],
        mp4Sources: media.mp4Sources || [],
        rivestreamSources: media.rivestreamSources || [], // VO/VOSTFR HLS sources
        captions: media.captions || [], // Subtitles/captions for the sources
        currentNexusSource: media.currentNexusSource || null,
        currentBravoSource: media.currentBravoSource || null
      },
      participants: [],
      messages: [],
      playbackState: {
        isPlaying: false,
        position: media.position || 0,
        updatedAt: Date.now(),
        updatedBy: 'system'
      },
      createdAt: Date.now()
    };

    watchpartyRooms.set(roomId, newRoom);
    res.status(200).json({ success: true, roomId, roomCode: code });
  } catch (e) {
    console.error('Error creating watch party:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/watchparty/join', (req, res) => {
  try {
    const { roomCode, nickname } = req.body || {};
    if (!roomCode || !nickname) return res.status(400).json({ success: false, message: 'Missing required fields: roomCode, nickname' });

    let foundRoomId = null; let foundRoom = null;
    for (const [id, room] of watchpartyRooms.entries()) {
      if (room.code === roomCode) { foundRoomId = id; foundRoom = room; break; }
    }
    if (!foundRoomId) return res.status(404).json({ success: false, message: 'Watch party not found. Please check the room code and try again.' });
    if (foundRoom.participants.length >= foundRoom.maxParticipants) return res.status(400).json({ success: false, message: 'This watch party is full.' });

    res.status(200).json({ success: true, roomId: foundRoomId, roomCode });
  } catch (e) {
    console.error('Error joining watch party:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/watchparty/room/:roomId', (req, res) => {
  const { roomId } = req.params;
  if (!watchpartyRooms.has(roomId)) return res.status(404).json({ message: 'Room not found' });
  const room = watchpartyRooms.get(roomId);
  res.json({
    room: {
      id: roomId,
      code: room.code,
      hostId: room.hostId,
      maxParticipants: room.maxParticipants,
      isPublic: !!room.isPublic,
      syncMode: room.syncMode || 'classic',
      chatEnabled: room.chatEnabled !== false,
      controlMode: room.controlMode,
      coHosts: room.coHosts,
      media: room.media,
      createdAt: room.createdAt,
      participants: room.participants.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.id === room.hostId, isActive: p.isActive })),
      playbackState: room.playbackState
    }
  });
});

app.get('/api/watchparty/info/:code', (req, res) => {
  try {
    const { code } = req.params;
    let foundRoom = null;
    for (const room of watchpartyRooms.values()) { if (room.code === code) { foundRoom = room; break; } }
    if (!foundRoom) return res.status(404).json({ success: false, message: 'Watch party not found' });
    res.status(200).json({
      success: true, room: {
        title: foundRoom.media.title,
        mediaType: foundRoom.media.mediaType,
        participantCount: foundRoom.participants.length,
        maxParticipants: foundRoom.maxParticipants,
        isPublic: !!foundRoom.isPublic,
        syncMode: foundRoom.syncMode || 'classic'
      }
    });
  } catch (e) {
    console.error('Error getting watch party info by code:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/watchparty/public', (_req, res) => {
  try {
    const publicRooms = [];
    for (const [id, room] of watchpartyRooms.entries()) {
      if (room.isPublic) publicRooms.push({
        id,
        code: room.code,
        title: room.media.title,
        poster: room.media.poster,
        mediaType: room.media.mediaType,
        participantCount: room.participants.length,
        maxParticipants: room.maxParticipants,
        syncMode: room.syncMode || 'classic',
        seasonNumber: room.media.seasonNumber,
        episodeNumber: room.media.episodeNumber,
        createdAt: room.createdAt
      });
    }
    res.status(200).json({ success: true, rooms: publicRooms });
  } catch (e) {
    console.error('Error listing public watch parties:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/watchparty/all', (_req, res) => {
  try {
    const allRooms = Array.from(watchpartyRooms.entries()).map(([id, room]) => ({
      id,
      code: room.code,
      hostId: room.hostId,
      maxParticipants: room.maxParticipants,
      isPublic: room.isPublic,
      syncMode: room.syncMode || 'classic',
      media: room.media,
      participants: room.participants,
      createdAt: room.createdAt,
      playbackState: room.playbackState
    }));
    res.status(200).json({ success: true, rooms: allRooms });
  } catch (e) {
    console.error('Error listing all watch parties:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Setup watchparty cleanup job (hourly)
setInterval(() => {
  const nowTime = Date.now();
  const expiredRooms = [];

  // Find expired rooms (older than 12 hours or inactive for 3 hours)
  for (const [roomId, room] of watchpartyRooms.entries()) {
    const roomAge = nowTime - room.createdAt;
    const isExpired = roomAge > 12 * 60 * 60 * 1000; // 12 hours
    const isEmpty = room.participants.length === 0;
    const inactiveFor = isEmpty ? nowTime - Math.max(...room.participants.map(p => p.joinedAt), room.createdAt) : 0;
    const isInactive = isEmpty && inactiveFor > 3 * 60 * 60 * 1000; // 3 hours

    if (isExpired || isInactive) {
      expiredRooms.push(roomId);
      // Notify any remaining participants
      watchpartyIO.to(roomId).emit('room:closed', 'The watch party has ended due to inactivity or expiration.');
    }
  }

  // Remove expired rooms
  expiredRooms.forEach(roomId => {
    watchpartyRooms.delete(roomId);
    console.log(`Room ${roomId} closed due to expiration or inactivity`);
  });
}, 60 * 60 * 1000);

// Startup
(async () => {
  await loadRoomsFromDisk();
  server.listen(PORT, () => console.log(`Watchparty server listening on http://localhost:${PORT}`));
})();

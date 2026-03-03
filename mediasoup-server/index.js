const mediasoup = require('mediasoup');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const config = require('./config');
const roomManager = require('./room-manager');
const { setupSignaling, notifySessionEnded } = require('./signaling');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const workers = [];

async function createWorkers() {
  const numWorkers = config.mediasoup.numWorkers;
  console.log(`[mediasoup] Creating ${numWorkers} workers...`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: config.mediasoup.worker.logLevel,
      logTags: config.mediasoup.worker.logTags,
      rtcMinPort: config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
    });

    worker.on('died', () => {
      console.error(`[mediasoup] Worker ${worker.pid} died, exiting...`);
      setTimeout(() => process.exit(1), 2000);
    });

    workers.push(worker);
    console.log(`[mediasoup] Worker ${worker.pid} created`);
  }

  roomManager.setWorkers(workers);
}

app.post('/internal/rooms', async (req, res) => {
  try {
    const { userId, containerIp, videoRtpPort, audioOutRtpPort, audioInRtpPort, agentPort, sessionId } = req.body;
    if (!userId || !containerIp) {
      return res.status(400).json({ error: 'userId and containerIp required' });
    }
    await roomManager.createRoom(userId, {
      containerIp,
      videoRtpPort,
      audioOutRtpPort,
      audioInRtpPort,
      agentPort,
      sessionId,
    });
    res.status(201).json({ message: 'Room created', userId });
  } catch (err) {
    console.error('[API] Create room error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/internal/rooms/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    await roomManager.destroyRoom(userId);
    notifySessionEnded(io, userId, 'session_destroyed');
    res.json({ message: 'Room destroyed', userId });
  } catch (err) {
    console.error('[API] Destroy room error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/internal/rooms', (req, res) => {
  res.json({ rooms: roomManager.getAllRooms() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', workers: workers.length, rooms: roomManager.getAllRooms().length });
});

setupSignaling(io);

async function main() {
  await createWorkers();

  server.listen(config.listenPort, '0.0.0.0', () => {
    console.log(`[mediasoup Server] listening on 0.0.0.0:${config.listenPort}`);
  });
}

process.on('SIGINT', () => {
  console.log('[mediasoup] Shutting down...');
  for (const worker of workers) {
    worker.close();
  }
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[mediasoup] Shutting down...');
  for (const worker of workers) {
    worker.close();
  }
  server.close();
  process.exit(0);
});

main().catch((err) => {
  console.error('[mediasoup] Fatal error:', err);
  process.exit(1);
});

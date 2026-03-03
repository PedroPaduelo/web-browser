const roomManager = require('./room-manager');

function setupSignaling(io) {
  io.on('connection', (socket) => {
    console.log(`[Signaling] Client connected: ${socket.id}`);
    let currentUserId = null;

    socket.on('joinSession', async ({ sessionId }, callback) => {
      try {
        const room = roomManager.getRoomBySessionId(sessionId) || roomManager.getRoom(sessionId);
        if (!room) {
          return callback({ error: 'Session not found' });
        }
        currentUserId = room.userId;
        socket.join(room.userId);
        callback({ routerRtpCapabilities: room.router.rtpCapabilities });
        console.log(`[Signaling] ${socket.id} joined session ${sessionId}`);
      } catch (err) {
        console.error('[Signaling] joinSession error:', err.message);
        callback({ error: err.message });
      }
    });

    socket.on('createRecvTransport', async ({ sessionId }, callback) => {
      try {
        const userId = currentUserId || sessionId;
        const transportInfo = await roomManager.createWebRtcTransport(userId);
        callback(transportInfo);
      } catch (err) {
        console.error('[Signaling] createRecvTransport error:', err.message);
        callback({ error: err.message });
      }
    });

    socket.on('createSendTransport', async ({ sessionId }, callback) => {
      try {
        const userId = currentUserId || sessionId;
        const transportInfo = await roomManager.createWebRtcTransport(userId);
        callback(transportInfo);
      } catch (err) {
        console.error('[Signaling] createSendTransport error:', err.message);
        callback({ error: err.message });
      }
    });

    socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
      try {
        const userId = currentUserId;
        if (!userId) return callback({ error: 'Not in a session' });
        await roomManager.connectTransport(userId, transportId, dtlsParameters);
        callback({});
      } catch (err) {
        console.error('[Signaling] connectTransport error:', err.message);
        callback({ error: err.message });
      }
    });

    socket.on('consume', async ({ sessionId, transportId, rtpCapabilities, kind }, callback) => {
      try {
        const userId = currentUserId || sessionId;
        const consumerInfo = await roomManager.createConsumer(userId, transportId, kind, rtpCapabilities);
        callback(consumerInfo);
      } catch (err) {
        console.error('[Signaling] consume error:', err.message);
        callback({ error: err.message });
      }
    });

    socket.on('produce', async ({ sessionId, transportId, kind, rtpParameters }, callback) => {
      try {
        const userId = currentUserId || sessionId;
        const producerInfo = await roomManager.createMicProducer(userId, transportId, rtpParameters);
        callback(producerInfo);
      } catch (err) {
        console.error('[Signaling] produce error:', err.message);
        callback({ error: err.message });
      }
    });

    socket.on('resumeConsumer', async ({ consumerId }, callback) => {
      try {
        const userId = currentUserId;
        if (!userId) return callback({ error: 'Not in a session' });
        await roomManager.resumeConsumer(userId, consumerId);
        callback({});
      } catch (err) {
        console.error('[Signaling] resumeConsumer error:', err.message);
        callback({ error: err.message });
      }
    });

    socket.on('inputEvent', ({ sessionId, event }) => {
      const userId = currentUserId || sessionId;
      roomManager.relayInput(userId, event);
    });

    socket.on('disconnect', () => {
      console.log(`[Signaling] Client disconnected: ${socket.id} (user: ${currentUserId})`);
      if (currentUserId) {
        io.to(currentUserId).emit('userDisconnected', { userId: currentUserId });
      }
    });
  });
}

function notifySessionEnded(io, userId, reason) {
  io.to(userId).emit('sessionEnded', { sessionId: userId, reason });
}

function notifyNewProducer(io, userId, producerId, kind) {
  io.to(userId).emit('newProducer', { producerId, kind });
}

module.exports = { setupSignaling, notifySessionEnded, notifyNewProducer };

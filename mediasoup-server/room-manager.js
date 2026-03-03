const WebSocket = require('ws');
const config = require('./config');

const rooms = new Map();
let workers = [];
let nextWorkerIdx = 0;

function setWorkers(w) {
  workers = w;
}

function getNextWorker() {
  const worker = workers[nextWorkerIdx];
  nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
  return worker;
}

async function createRoom(userId, containerInfo) {
  if (rooms.has(userId)) {
    console.log(`[RoomManager] Room already exists for ${userId}, destroying first`);
    await destroyRoom(userId);
  }

  const worker = getNextWorker();
  const router = await worker.createRouter({ mediaCodecs: config.mediasoup.router.mediaCodecs });

  const videoPlainTransport = await router.createPlainTransport({
    listenInfo: config.mediasoup.plainTransport.listenInfo,
    rtcpMux: true,
    comedia: false,
  });

  const audioOutPlainTransport = await router.createPlainTransport({
    listenInfo: config.mediasoup.plainTransport.listenInfo,
    rtcpMux: true,
    comedia: false,
  });

  const audioInPlainTransport = await router.createPlainTransport({
    listenInfo: config.mediasoup.plainTransport.listenInfo,
    rtcpMux: true,
    comedia: false,
  });

  await videoPlainTransport.connect({
    ip: containerInfo.containerIp,
    port: containerInfo.videoRtpPort,
  });

  const videoProducer = await videoPlainTransport.produce({
    kind: 'video',
    rtpParameters: {
      codecs: [{
        mimeType: 'video/VP8',
        payloadType: 96,
        clockRate: 90000,
        parameters: {},
      }],
      encodings: [{ ssrc: 1111 }],
    },
  });

  await audioOutPlainTransport.connect({
    ip: containerInfo.containerIp,
    port: containerInfo.audioOutRtpPort,
  });

  const audioProducer = await audioOutPlainTransport.produce({
    kind: 'audio',
    rtpParameters: {
      codecs: [{
        mimeType: 'audio/opus',
        payloadType: 101,
        clockRate: 48000,
        channels: 2,
        parameters: { 'useinbandfec': 1, 'usedtx': 1 },
      }],
      encodings: [{ ssrc: 2222 }],
    },
  });

  let agentWs = null;
  try {
    agentWs = new WebSocket(`ws://${containerInfo.containerIp}:${containerInfo.agentPort}`);
    agentWs.on('error', (err) => {
      console.error(`[RoomManager] Agent WS error for ${userId}:`, err.message);
    });
    agentWs.on('close', () => {
      console.log(`[RoomManager] Agent WS closed for ${userId}`);
    });
  } catch (err) {
    console.error(`[RoomManager] Failed to connect to agent for ${userId}:`, err.message);
  }

  const room = {
    userId,
    router,
    videoPlainTransport,
    audioOutPlainTransport,
    audioInPlainTransport,
    videoProducer,
    audioProducer,
    webRtcTransports: new Map(),
    consumers: new Map(),
    micProducer: null,
    agentWs,
    containerInfo,
  };

  rooms.set(userId, room);
  console.log(`[RoomManager] Room created for ${userId}`);
  return room;
}

async function destroyRoom(userId) {
  const room = rooms.get(userId);
  if (!room) return;

  try {
    if (room.agentWs && room.agentWs.readyState === WebSocket.OPEN) {
      room.agentWs.close();
    }
  } catch (e) {}

  for (const consumer of room.consumers.values()) {
    try { consumer.close(); } catch (e) {}
  }
  for (const transport of room.webRtcTransports.values()) {
    try { transport.close(); } catch (e) {}
  }

  try { room.videoPlainTransport.close(); } catch (e) {}
  try { room.audioOutPlainTransport.close(); } catch (e) {}
  try { room.audioInPlainTransport.close(); } catch (e) {}
  try { room.videoProducer.close(); } catch (e) {}
  try { room.audioProducer.close(); } catch (e) {}
  if (room.micProducer) {
    try { room.micProducer.close(); } catch (e) {}
  }
  try { room.router.close(); } catch (e) {}

  rooms.delete(userId);
  console.log(`[RoomManager] Room destroyed for ${userId}`);
}

function getRoom(userId) {
  return rooms.get(userId);
}

function getRoomBySessionId(sessionId) {
  for (const room of rooms.values()) {
    if (room.containerInfo && room.containerInfo.sessionId === sessionId) {
      return room;
    }
    if (room.userId === sessionId) {
      return room;
    }
  }
  return null;
}

async function createWebRtcTransport(userId) {
  const room = rooms.get(userId);
  if (!room) throw new Error(`No room for ${userId}`);

  const transport = await room.router.createWebRtcTransport({
    listenInfos: config.mediasoup.webRtcTransport.listenInfos,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: config.mediasoup.webRtcTransport.initialAvailableOutgoingBitrate,
  });

  if (config.mediasoup.webRtcTransport.maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(config.mediasoup.webRtcTransport.maxIncomingBitrate);
    } catch (e) {}
  }

  room.webRtcTransports.set(transport.id, transport);

  transport.on('dtlsstatechange', (dtlsState) => {
    if (dtlsState === 'failed' || dtlsState === 'closed') {
      console.log(`[RoomManager] Transport ${transport.id} dtls state: ${dtlsState}`);
      transport.close();
      room.webRtcTransports.delete(transport.id);
    }
  });

  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

async function connectTransport(userId, transportId, dtlsParameters) {
  const room = rooms.get(userId);
  if (!room) throw new Error(`No room for ${userId}`);

  const transport = room.webRtcTransports.get(transportId);
  if (!transport) throw new Error(`No transport ${transportId}`);

  await transport.connect({ dtlsParameters });
}

async function createConsumer(userId, transportId, producerKind, rtpCapabilities) {
  const room = rooms.get(userId);
  if (!room) throw new Error(`No room for ${userId}`);

  const producer = producerKind === 'video' ? room.videoProducer : room.audioProducer;
  if (!producer) throw new Error(`No ${producerKind} producer`);

  if (!room.router.canConsume({ producerId: producer.id, rtpCapabilities })) {
    throw new Error(`Cannot consume ${producerKind}`);
  }

  const transport = room.webRtcTransports.get(transportId);
  if (!transport) throw new Error(`No transport ${transportId}`);

  const consumer = await transport.consume({
    producerId: producer.id,
    rtpCapabilities,
    paused: true,
  });

  room.consumers.set(consumer.id, consumer);

  consumer.on('transportclose', () => {
    room.consumers.delete(consumer.id);
  });

  consumer.on('producerclose', () => {
    room.consumers.delete(consumer.id);
  });

  return {
    id: consumer.id,
    producerId: producer.id,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  };
}

async function resumeConsumer(userId, consumerId) {
  const room = rooms.get(userId);
  if (!room) throw new Error(`No room for ${userId}`);

  const consumer = room.consumers.get(consumerId);
  if (!consumer) throw new Error(`No consumer ${consumerId}`);

  await consumer.resume();
}

async function createMicProducer(userId, transportId, rtpParameters) {
  const room = rooms.get(userId);
  if (!room) throw new Error(`No room for ${userId}`);

  const transport = room.webRtcTransports.get(transportId);
  if (!transport) throw new Error(`No transport ${transportId}`);

  const micProducer = await transport.produce({
    kind: 'audio',
    rtpParameters,
  });

  room.micProducer = micProducer;

  const micConsumer = await room.audioInPlainTransport.consume({
    producerId: micProducer.id,
    rtpCapabilities: room.router.rtpCapabilities,
    paused: false,
  });

  console.log(`[RoomManager] Mic producer created for ${userId}, routed to container via PlainTransport`);

  return { id: micProducer.id };
}

function relayInput(userId, event) {
  const room = rooms.get(userId);
  if (!room || !room.agentWs || room.agentWs.readyState !== WebSocket.OPEN) return;
  room.agentWs.send(JSON.stringify(event));
}

function getAllRooms() {
  return Array.from(rooms.keys());
}

module.exports = {
  setWorkers,
  createRoom,
  destroyRoom,
  getRoom,
  getRoomBySessionId,
  createWebRtcTransport,
  connectTransport,
  createConsumer,
  resumeConsumer,
  createMicProducer,
  relayInput,
  getAllRooms,
};

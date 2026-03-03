const Docker = require('dockerode');
const fetch = require('node-fetch');
const portAllocator = require('./port-allocator');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const MEDIASOUP_URL = process.env.MEDIASOUP_URL || 'http://localhost:4443';
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 100;
const HEALTH_CHECK_INTERVAL = 10000;
const HEALTH_CHECK_TIMEOUT = 30000;
const DISCONNECT_TIMEOUT = 60000;
const MAX_HEALTH_FAILURES = 3;

const sessions = new Map();
const healthFailures = new Map();
const disconnectTimers = new Map();

async function createSession(userId, options = {}) {
  if (sessions.has(userId)) {
    const existing = sessions.get(userId);
    return { error: 'exists', existingSessionId: existing.sessionId };
  }

  if (sessions.size >= MAX_SESSIONS) {
    return { error: 'limit', currentSessions: sessions.size, maxSessions: MAX_SESSIONS };
  }

  const {
    resolution = '1280x720',
    extensionPath = '/shared/extensions/default',
    startUrl = 'about:blank',
    videoBitrate = 2000000,
    audioBitrate = 128000,
  } = options;

  const ports = portAllocator.allocate(userId);
  const displayNum = 99 + sessions.size;

  const container = await docker.createContainer({
    Image: 'remote-browser:latest',
    name: `session-${userId}`,
    Env: [
      `DISPLAY_NUM=${displayNum}`,
      `RESOLUTION=${resolution}`,
      `VIDEO_RTP_PORT=${ports.videoRtp}`,
      `AUDIO_RTP_PORT=${ports.audioOutRtp}`,
      `MIC_RTP_PORT=${ports.audioInRtp}`,
      `AGENT_PORT=${ports.agent}`,
      `VIDEO_BITRATE=${videoBitrate}`,
      `AUDIO_BITRATE=${audioBitrate}`,
      `START_URL=${startUrl}`,
    ],
    HostConfig: {
      Memory: 1.5 * 1024 * 1024 * 1024,
      NanoCpus: 2 * 1e9,
      ShmSize: 2 * 1024 * 1024 * 1024,
      Binds: [
        `${extensionPath}:/data/extension:ro`,
        `chrome-profiles-${userId}:/data/chrome-profile`,
      ],
      NetworkMode: 'browser-network',
      PortBindings: {
        [`${ports.agent}/tcp`]: [{ HostPort: `${ports.agent}` }],
      },
    },
    Labels: {
      app: 'remote-browser',
      userId: userId,
      createdAt: new Date().toISOString(),
    },
  });

  await container.start();

  const containerInfo = await container.inspect();
  const containerIp = containerInfo.NetworkSettings.Networks['browser-network']?.IPAddress
    || containerInfo.NetworkSettings.IPAddress;

  await waitForHealthy(containerIp, ports.agent, HEALTH_CHECK_TIMEOUT);

  try {
    await fetch(`${MEDIASOUP_URL}/internal/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        containerIp,
        videoRtpPort: ports.videoRtp,
        audioOutRtpPort: ports.audioOutRtp,
        audioInRtpPort: ports.audioInRtp,
        agentPort: ports.agent,
        sessionId: container.id,
      }),
    });
  } catch (err) {
    console.error(`[ContainerManager] Failed to notify mediasoup for ${userId}:`, err.message);
  }

  const session = {
    userId,
    sessionId: container.id.substring(0, 12),
    containerId: container.id,
    containerIp,
    status: 'running',
    createdAt: new Date(),
    resolution,
    ports,
    lastActivity: new Date(),
    disconnectTimer: null,
  };

  sessions.set(userId, session);
  healthFailures.set(userId, 0);

  console.log(`[ContainerManager] Session created for ${userId} (container: ${session.sessionId})`);

  return {
    sessionId: session.sessionId,
    userId,
    status: 'running',
    agentPort: ports.agent,
    signalingUrl: MEDIASOUP_URL.replace('http', 'ws'),
  };
}

async function destroySession(userId) {
  const session = sessions.get(userId);
  if (!session) return false;

  session.status = 'stopping';

  if (disconnectTimers.has(userId)) {
    clearTimeout(disconnectTimers.get(userId));
    disconnectTimers.delete(userId);
  }

  try {
    const container = docker.getContainer(session.containerId);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove().catch(() => {});
  } catch (err) {
    console.error(`[ContainerManager] Error destroying container for ${userId}:`, err.message);
  }

  try {
    await fetch(`${MEDIASOUP_URL}/internal/rooms/${userId}`, { method: 'DELETE' });
  } catch (err) {
    console.error(`[ContainerManager] Error notifying mediasoup for ${userId}:`, err.message);
  }

  portAllocator.release(userId);
  sessions.delete(userId);
  healthFailures.delete(userId);

  console.log(`[ContainerManager] Session destroyed for ${userId}`);
  return true;
}

function listSessions() {
  const list = [];
  for (const session of sessions.values()) {
    list.push({
      userId: session.userId,
      sessionId: session.sessionId,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      uptime: Math.floor((Date.now() - session.createdAt.getTime()) / 1000),
    });
  }
  return { sessions: list, total: list.length, maxSessions: MAX_SESSIONS };
}

function getSession(userId) {
  const session = sessions.get(userId);
  if (!session) return null;

  return {
    userId: session.userId,
    sessionId: session.sessionId,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    uptime: Math.floor((Date.now() - session.createdAt.getTime()) / 1000),
    resources: { cpuPercent: 0, memoryMB: 0, memoryLimitMB: 1536 },
    ports: session.ports,
  };
}

async function getSessionStats(userId) {
  const session = sessions.get(userId);
  if (!session) return null;

  try {
    const container = docker.getContainer(session.containerId);
    const stats = await container.stats({ stream: false });

    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuPercent = (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100;

    const memoryMB = Math.round(stats.memory_stats.usage / (1024 * 1024));

    return {
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memoryMB,
      memoryLimitMB: 1536,
    };
  } catch {
    return { cpuPercent: 0, memoryMB: 0, memoryLimitMB: 1536 };
  }
}

async function waitForHealthy(ip, port, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://${ip}:${port}/health`, { timeout: 2000 });
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Container health check timed out after ${timeout}ms`);
}

function startHealthMonitoring() {
  setInterval(async () => {
    for (const [userId, session] of sessions) {
      if (session.status !== 'running') continue;

      try {
        const res = await fetch(`http://${session.containerIp}:${session.ports.agent}/health`, { timeout: 3000 });
        if (res.ok) {
          healthFailures.set(userId, 0);
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch {
        const failures = (healthFailures.get(userId) || 0) + 1;
        healthFailures.set(userId, failures);
        console.warn(`[HealthCheck] ${userId} failed (${failures}/${MAX_HEALTH_FAILURES})`);

        if (failures >= MAX_HEALTH_FAILURES) {
          console.error(`[HealthCheck] ${userId} unhealthy, destroying session`);
          destroySession(userId);
        }
      }
    }
  }, HEALTH_CHECK_INTERVAL);
}

function handleDisconnect(userId) {
  const session = sessions.get(userId);
  if (!session) return;

  console.log(`[ContainerManager] User ${userId} disconnected, starting ${DISCONNECT_TIMEOUT / 1000}s timer`);

  const timer = setTimeout(() => {
    console.log(`[ContainerManager] Timeout for ${userId}, destroying session`);
    destroySession(userId);
    disconnectTimers.delete(userId);
  }, DISCONNECT_TIMEOUT);

  disconnectTimers.set(userId, timer);
}

function handleReconnect(userId) {
  if (disconnectTimers.has(userId)) {
    clearTimeout(disconnectTimers.get(userId));
    disconnectTimers.delete(userId);
    console.log(`[ContainerManager] User ${userId} reconnected, timer cancelled`);
  }

  const session = sessions.get(userId);
  if (session) {
    session.lastActivity = new Date();
  }
}

async function cleanupOrphanedContainers() {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ['app=remote-browser'] },
    });

    for (const containerInfo of containers) {
      const userId = containerInfo.Labels?.userId;
      if (userId && !sessions.has(userId)) {
        console.log(`[Cleanup] Removing orphaned container for ${userId}`);
        const container = docker.getContainer(containerInfo.Id);
        await container.stop({ t: 5 }).catch(() => {});
        await container.remove().catch(() => {});
      }
    }
  } catch (err) {
    console.error('[Cleanup] Error:', err.message);
  }
}

module.exports = {
  createSession,
  destroySession,
  listSessions,
  getSession,
  getSessionStats,
  startHealthMonitoring,
  handleDisconnect,
  handleReconnect,
  cleanupOrphanedContainers,
  MAX_SESSIONS,
};

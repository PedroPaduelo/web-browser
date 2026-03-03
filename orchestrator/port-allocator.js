const PORT_MIN = 10000;
const PORT_MAX = 39999;
const PORTS_PER_SESSION = 4;

const allocatedPorts = new Map();
let nextPort = PORT_MIN;

function allocate(userId) {
  if (allocatedPorts.has(userId)) {
    return allocatedPorts.get(userId);
  }

  const startPort = findNextFreeBlock();
  if (startPort === null) {
    throw new Error('No free ports available');
  }

  const ports = {
    agent: startPort,
    videoRtp: startPort + 1,
    audioOutRtp: startPort + 2,
    audioInRtp: startPort + 3,
  };

  allocatedPorts.set(userId, ports);
  return ports;
}

function findNextFreeBlock() {
  const usedPorts = new Set();
  for (const ports of allocatedPorts.values()) {
    usedPorts.add(ports.agent);
    usedPorts.add(ports.videoRtp);
    usedPorts.add(ports.audioOutRtp);
    usedPorts.add(ports.audioInRtp);
  }

  for (let p = nextPort; p <= PORT_MAX - PORTS_PER_SESSION; p += PORTS_PER_SESSION) {
    const block = [p, p + 1, p + 2, p + 3];
    if (block.every(port => !usedPorts.has(port))) {
      nextPort = p + PORTS_PER_SESSION;
      if (nextPort > PORT_MAX) nextPort = PORT_MIN;
      return p;
    }
  }

  for (let p = PORT_MIN; p < nextPort && p <= PORT_MAX - PORTS_PER_SESSION; p += PORTS_PER_SESSION) {
    const block = [p, p + 1, p + 2, p + 3];
    if (block.every(port => !usedPorts.has(port))) {
      nextPort = p + PORTS_PER_SESSION;
      return p;
    }
  }

  return null;
}

function release(userId) {
  allocatedPorts.delete(userId);
}

function getPorts(userId) {
  return allocatedPorts.get(userId) || null;
}

function getAllocatedCount() {
  return allocatedPorts.size;
}

module.exports = { allocate, release, getPorts, getAllocatedCount };

const { spawn } = require('child_process');

const PULSE_MODULES = '/tmp/pulse-extracted/usr/lib/pulse-15.99.1+dfsg1/modules';
const PULSE_LIBS = '/tmp/pulse-extracted/usr/lib/x86_64-linux-gnu';
const PULSE_LIB_PA = `${PULSE_LIBS}/pulseaudio`;

let pulseProcess = null;
let ffmpegProcess = null;
let audioClients = new Set();
let pulseSocketPath = null;

function getPulseEnv() {
  return {
    LD_LIBRARY_PATH: `${PULSE_MODULES}:${PULSE_LIBS}:${PULSE_LIB_PA}`,
  };
}

function findPulseSocket() {
  const fs = require('fs');
  const dir = '/tmp';
  try {
    const entries = fs.readdirSync(dir);
    for (const e of entries) {
      if (e.startsWith('pulse-') && fs.existsSync(`${dir}/${e}/native`)) {
        return `${dir}/${e}/native`;
      }
    }
  } catch {}
  return null;
}

async function startPulse() {
  if (pulseProcess) return pulseSocketPath;

  try { require('child_process').execSync('pkill -f "/tmp/pulseaudio"', { stdio: 'ignore' }); } catch {}
  await new Promise(r => setTimeout(r, 500));

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...getPulseEnv(),
    };

    pulseProcess = spawn('/tmp/pulseaudio', [
      '--daemonize=no',
      '-n',
      '-p', PULSE_MODULES,
      '-L', 'module-null-sink sink_name=virtual_out sink_properties=device.description=VirtualOutput',
      '-L', 'module-native-protocol-unix',
      '--log-target=file:/tmp/pulse-audio-mgr.log',
      '--exit-idle-time=-1',
    ], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });

    pulseProcess.unref();

    pulseProcess.stderr.on('data', (d) => {
      console.log('[PulseAudio]', d.toString().trim());
    });

    pulseProcess.on('error', (err) => {
      console.error('[PulseAudio] Error:', err.message);
      pulseProcess = null;
      reject(err);
    });

    pulseProcess.on('exit', (code) => {
      console.log(`[PulseAudio] Exited with code ${code}`);
      pulseProcess = null;
      pulseSocketPath = null;
    });

    setTimeout(() => {
      pulseSocketPath = findPulseSocket();
      if (pulseSocketPath) {
        console.log(`[PulseAudio] Running, socket: ${pulseSocketPath}`);
        resolve(pulseSocketPath);
      } else {
        reject(new Error('PulseAudio socket not found'));
      }
    }, 2000);
  });
}

function getPulseServerPath() {
  if (!pulseSocketPath) {
    pulseSocketPath = findPulseSocket();
  }
  return pulseSocketPath;
}

function startAudioCapture() {
  if (ffmpegProcess) return;

  const socketPath = getPulseServerPath();
  if (!socketPath) {
    console.error('[AudioManager] No PulseAudio socket found');
    return;
  }

  const env = {
    ...process.env,
    ...getPulseEnv(),
    PULSE_SERVER: `unix:${socketPath}`,
  };

  ffmpegProcess = spawn('ffmpeg', [
    '-f', 'pulse',
    '-i', 'virtual_out.monitor',
    '-ac', '1',
    '-ar', '24000',
    '-f', 's16le',
    '-acodec', 'pcm_s16le',
    'pipe:1',
  ], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  ffmpegProcess.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line.includes('size=') || line.includes('time=')) return;
    console.log('[AudioFFmpeg]', line);
  });

  let pcmBuffer = Buffer.alloc(0);
  const CHUNK_SIZE = 4800;

  ffmpegProcess.stdout.on('data', (chunk) => {
    pcmBuffer = Buffer.concat([pcmBuffer, chunk]);
    while (pcmBuffer.length >= CHUNK_SIZE) {
      const frame = pcmBuffer.subarray(0, CHUNK_SIZE);
      pcmBuffer = pcmBuffer.subarray(CHUNK_SIZE);
      broadcastAudio(frame);
    }
  });

  ffmpegProcess.on('error', (err) => {
    console.error('[AudioFFmpeg] Error:', err.message);
    ffmpegProcess = null;
  });

  ffmpegProcess.on('exit', (code) => {
    console.log(`[AudioFFmpeg] Exited with code ${code}`);
    ffmpegProcess = null;
  });

  console.log('[AudioManager] Audio capture started (PCM s16le 24kHz mono)');
}

function broadcastAudio(chunk) {
  for (const ws of audioClients) {
    if (ws.readyState === 1) {
      try {
        ws.send(chunk, { binary: true });
      } catch {}
    }
  }
}

function addClient(ws) {
  audioClients.add(ws);
  console.log(`[AudioManager] Client added (total: ${audioClients.size})`);

  ws.on('close', () => {
    audioClients.delete(ws);
    console.log(`[AudioManager] Client removed (total: ${audioClients.size})`);
  });
}

function stop() {
  if (ffmpegProcess) {
    try { ffmpegProcess.kill('SIGTERM'); } catch {}
    ffmpegProcess = null;
  }
  for (const ws of audioClients) {
    try { ws.close(); } catch {}
  }
  audioClients.clear();
  console.log('[AudioManager] Stopped');
}

function stopPulse() {
  if (pulseProcess) {
    try { pulseProcess.kill('SIGTERM'); } catch {}
    pulseProcess = null;
    pulseSocketPath = null;
  }
  try { require('child_process').execSync('pkill -f "/tmp/pulseaudio"', { stdio: 'ignore' }); } catch {}
}

function getStats() {
  return {
    pulse: !!pulseProcess || !!findPulseSocket(),
    capturing: !!ffmpegProcess,
    clients: audioClients.size,
  };
}

module.exports = {
  startPulse,
  getPulseServerPath,
  getPulseEnv,
  startAudioCapture,
  addClient,
  stop,
  stopPulse,
  getStats,
};

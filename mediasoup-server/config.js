const os = require('os');

const config = {
  listenPort: parseInt(process.env.MEDIASOUP_PORT) || 4443,
  mediasoup: {
    numWorkers: Math.min(os.cpus().length, parseInt(process.env.NUM_WORKERS) || 8),
    worker: {
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    },
    router: {
      mediaCodecs: [
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {},
        },
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          parameters: {
            'useinbandfec': 1,
            'usedtx': 1,
          },
        },
      ],
    },
    webRtcTransport: {
      listenInfos: [
        { protocol: 'udp', ip: '0.0.0.0', announcedAddress: process.env.PUBLIC_IP || null },
        { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: process.env.PUBLIC_IP || null },
      ],
      maxIncomingBitrate: 5000000,
      initialAvailableOutgoingBitrate: 3000000,
    },
    plainTransport: {
      listenInfo: { protocol: 'udp', ip: '0.0.0.0' },
      rtcpMux: false,
      comedia: false,
    },
  },
};

module.exports = config;

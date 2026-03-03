#!/bin/bash
set -e

DISPLAY_NUM=${DISPLAY_NUM:-99}
RESOLUTION=${RESOLUTION:-1280x720}
VIDEO_RTP_PORT=${VIDEO_RTP_PORT:-5004}
AUDIO_RTP_PORT=${AUDIO_RTP_PORT:-5006}
MIC_RTP_PORT=${MIC_RTP_PORT:-5008}
AGENT_PORT=${AGENT_PORT:-9222}
VIDEO_BITRATE=${VIDEO_BITRATE:-2000000}
AUDIO_BITRATE=${AUDIO_BITRATE:-128000}
START_URL=${START_URL:-about:blank}

export DISPLAY=:${DISPLAY_NUM}

echo "=== Starting Xvfb on display :${DISPLAY_NUM} with resolution ${RESOLUTION} ==="
Xvfb :${DISPLAY_NUM} -screen 0 ${RESOLUTION}x24 -ac +extension GLX +render -noreset &
sleep 1

echo "=== Starting PulseAudio ==="
pulseaudio --start --exit-idle-time=-1 --daemon 2>/dev/null || true
sleep 1

echo "=== Creating virtual audio devices ==="
pactl load-module module-null-sink sink_name=virtual_speaker \
    sink_properties=device.description="VirtualSpeaker"
pactl load-module module-null-sink sink_name=virtual_mic \
    sink_properties=device.description="VirtualMic"
pactl load-module module-virtual-source \
    source_name=virtual_mic_source \
    master=virtual_mic.monitor

pactl set-default-sink virtual_speaker
pactl set-default-source virtual_mic_source

echo "=== Exporting env vars ==="
export DISPLAY_NUM
export RESOLUTION
export VIDEO_RTP_PORT
export AUDIO_RTP_PORT
export MIC_RTP_PORT
export AGENT_PORT
export VIDEO_BITRATE
export AUDIO_BITRATE
export START_URL

echo "=== Starting Supervisord ==="
exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf

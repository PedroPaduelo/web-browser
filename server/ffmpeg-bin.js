// Resolução do binário ffmpeg (movido de session-manager.js, byte-idêntico).
//
// Path absoluto do ffmpeg (cacheado): 'ffmpeg' puro no PATH resolve via shell,
// mas o spawn precisa de um executável real. Sem isso, o produtor de vídeo
// simplesmente não sobe e caímos no CDP screencast.
const { execSync } = require('child_process');

const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';

let ffmpegPathCache; // undefined = ainda não checado, null = ausente
function resolveFfmpegPath() {
  if (ffmpegPathCache !== undefined) return ffmpegPathCache;
  try {
    const out = execSync(`command -v ${FFMPEG_BIN}`, { encoding: 'utf8' }).trim();
    ffmpegPathCache = out || null;
  } catch {
    ffmpegPathCache = null;
  }
  if (!ffmpegPathCache) {
    console.warn(`[Session] ffmpeg não encontrado no PATH — vídeo usará o fallback CDP screencast`);
  }
  return ffmpegPathCache;
}

module.exports = { resolveFfmpegPath, FFMPEG_BIN };

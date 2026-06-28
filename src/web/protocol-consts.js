// protocol-consts.js — the handful of WS-protocol constants the browser needs as
// real ESM (the authoritative copy is the typed src/server/protocol.ts). Kept in
// sync by the validate "protocol constants match" check so they can't drift.
export const STT_SAMPLE_RATE = 16000;
export const AUDIO_FORMAT = 'pcm-s16le-mono';
export const WS_PATH = '/ws';

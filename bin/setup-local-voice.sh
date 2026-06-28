#!/usr/bin/env bash
# setup-local-voice.sh — download/build the LOCAL, OFFLINE voice stack so ceo-chat
# speaks (and hears) real words on hub with NO external key and NO sudo.
#
#   - piper (rhasspy/piper) + an English voice model  -> real neural TTS read-aloud
#   - whisper.cpp + ggml-tiny.en                       -> local STT (server fallback
#                                                         + the round-trip e2e gate)
#
# Everything lands OUTSIDE the repo in $CEOCHAT_VOICE_DIR (default
# ~/.local/share/ceo-chat) so it persists across worktrees and is found by the
# server and `npm run validate` alike. Idempotent: re-running skips finished steps.
#
#   bash bin/setup-local-voice.sh            # piper + whisper (full)
#   CEOCHAT_SKIP_WHISPER=1 bash bin/setup-local-voice.sh   # piper only (TTS)
#
# Paths the rest of the app probes (see src/tts/local-tts.ts, src/server/stt.ts):
#   $VOICE_DIR/piper/piper
#   $VOICE_DIR/voices/<voice>.onnx (+ .onnx.json)
#   $VOICE_DIR/whisper/whisper-cli   $VOICE_DIR/whisper/ggml-tiny.en.bin
set -euo pipefail

VOICE_DIR="${CEOCHAT_VOICE_DIR:-$HOME/.local/share/ceo-chat}"
PIPER_VER="2023.11.14-2"
PIPER_URL="https://github.com/rhasspy/piper/releases/download/${PIPER_VER}/piper_linux_x86_64.tar.gz"
VOICE="${CEOCHAT_PIPER_VOICE:-en_US-lessac-medium}"
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium"
CMAKE_VER="3.30.5"
CMAKE_URL="https://github.com/Kitware/CMake/releases/download/v${CMAKE_VER}/cmake-${CMAKE_VER}-linux-x86_64.tar.gz"
WHISPER_REPO="https://github.com/ggerganov/whisper.cpp"
WHISPER_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin"

say() { printf '  · %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

mkdir -p "$VOICE_DIR" "$VOICE_DIR/voices"
say "voice dir: $VOICE_DIR"

# ---- piper (prebuilt binary; self-contained, bundles onnxruntime + espeak-ng) ----
if [ ! -x "$VOICE_DIR/piper/piper" ]; then
  say "downloading piper $PIPER_VER…"
  curl -sSL -m 300 -o "$VOICE_DIR/piper.tar.gz" "$PIPER_URL"
  tar -xzf "$VOICE_DIR/piper.tar.gz" -C "$VOICE_DIR"
  rm -f "$VOICE_DIR/piper.tar.gz"
  say "piper installed -> $VOICE_DIR/piper/piper"
else
  say "piper already present"
fi

# ---- voice model ----
if [ ! -f "$VOICE_DIR/voices/${VOICE}.onnx" ]; then
  say "downloading voice ${VOICE} (.onnx ~60MB)…"
  curl -sSL -m 600 -o "$VOICE_DIR/voices/${VOICE}.onnx" "${VOICE_BASE}/${VOICE}.onnx"
  curl -sSL -m 60  -o "$VOICE_DIR/voices/${VOICE}.onnx.json" "${VOICE_BASE}/${VOICE}.onnx.json"
  say "voice installed -> $VOICE_DIR/voices/${VOICE}.onnx"
else
  say "voice already present"
fi

# ---- smoke test piper ----
say "piper smoke test…"
echo "ceo chat local voice is online." | \
  "$VOICE_DIR/piper/piper" --model "$VOICE_DIR/voices/${VOICE}.onnx" \
  --output_file "$VOICE_DIR/piper-smoke.wav" >/dev/null 2>&1 || { echo "piper smoke FAILED"; exit 1; }
ls -l "$VOICE_DIR/piper-smoke.wav" | awk '{print "    piper wav bytes:", $5}'

if [ "${CEOCHAT_SKIP_WHISPER:-0}" = "1" ]; then
  say "skipping whisper (CEOCHAT_SKIP_WHISPER=1) — TTS-only setup done."
  exit 0
fi

# ---- cmake (prefer system; else download prebuilt) ----
CMAKE_BIN="$(command -v cmake || true)"
if [ -z "$CMAKE_BIN" ]; then
  if [ ! -x "$VOICE_DIR/cmake/bin/cmake" ]; then
    say "downloading cmake $CMAKE_VER (build-time only)…"
    curl -sSL -m 300 -o "$VOICE_DIR/cmake.tar.gz" "$CMAKE_URL"
    mkdir -p "$VOICE_DIR/cmake"
    tar -xzf "$VOICE_DIR/cmake.tar.gz" -C "$VOICE_DIR/cmake" --strip-components=1
    rm -f "$VOICE_DIR/cmake.tar.gz"
  fi
  CMAKE_BIN="$VOICE_DIR/cmake/bin/cmake"
fi
say "cmake: $CMAKE_BIN"

# ---- whisper.cpp (build static so whisper-cli is self-contained) ----
if [ ! -x "$VOICE_DIR/whisper/whisper-cli" ]; then
  say "cloning + building whisper.cpp (static)…"
  rm -rf "$VOICE_DIR/whisper.cpp"
  git clone --depth 1 "$WHISPER_REPO" "$VOICE_DIR/whisper.cpp"
  ( cd "$VOICE_DIR/whisper.cpp"
    "$CMAKE_BIN" -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF >/dev/null
    "$CMAKE_BIN" --build build --config Release -j"$(nproc)" --target whisper-cli >/dev/null )
  mkdir -p "$VOICE_DIR/whisper"
  CLI="$(find "$VOICE_DIR/whisper.cpp/build" -name whisper-cli -type f | head -1)"
  [ -n "$CLI" ] || { echo "whisper-cli not found after build"; exit 1; }
  cp "$CLI" "$VOICE_DIR/whisper/whisper-cli"
  say "whisper-cli built -> $VOICE_DIR/whisper/whisper-cli"
else
  say "whisper-cli already present"
fi

# ---- whisper model ----
if [ ! -f "$VOICE_DIR/whisper/ggml-tiny.en.bin" ]; then
  say "downloading whisper ggml-tiny.en (~75MB)…"
  curl -sSL -m 600 -o "$VOICE_DIR/whisper/ggml-tiny.en.bin" "$WHISPER_MODEL_URL"
  say "model installed -> $VOICE_DIR/whisper/ggml-tiny.en.bin"
else
  say "whisper model already present"
fi

# ---- whisper binary smoke (resampling to 16 kHz is done in-app, not here) ----
# whisper.cpp requires 16 kHz WAV input; piper emits 22.05 kHz. The app downsamples
# with src/web/pcm.js#downsampleFloat32 before invoking whisper, and the real
# piper->whisper round-trip is asserted by `npm run validate`. Here we only confirm
# the built binary runs.
say "whisper binary smoke…"
"$VOICE_DIR/whisper/whisper-cli" --help >/dev/null 2>&1 \
  && say "whisper-cli runs." || echo "    WARN: whisper-cli --help nonzero (check build)"
echo
say "local voice stack ready."

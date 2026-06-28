// capture-worklet.js — AudioWorklet that forwards mono mic frames to the main thread
// for the SERVER-SIDE STT fallback. AudioWorklet (not MediaRecorder, which is broken
// on iOS Safari) is the reliable iOS capture path: it runs on the audio thread and
// posts raw Float32 PCM at the context sample rate; the page downsamples to 16 kHz
// (pcm.js) and streams it to the broker. Registered as 'ceo-capture'.
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      // slice() copies — the underlying buffer is reused each render quantum.
      this.port.postMessage(input[0].slice(0));
    }
    return true; // keep the processor alive until the node is disconnected
  }
}
registerProcessor('ceo-capture', CaptureProcessor);

import captureWorklet from './capture-worklet.js?url&no-inline';

export const RECORDING_LIMIT_MS = 60_000;
const SAMPLE_RATE = 16_000;
const MAX_AUDIO_BYTES = 10_000_000;
const WAV_HEADER_BYTES = 44;

export interface Recording {
  readonly stop: () => Promise<Blob>;
}

function wav(samples: Int16Array): Blob {
  const size = WAV_HEADER_BYTES + samples.byteLength;
  if (samples.length === 0 || samples.length > SAMPLE_RATE * RECORDING_LIMIT_MS / 1000 || size > MAX_AUDIO_BYTES) {
    throw new Error('Invalid recording size');
  }
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const tag = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, size - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, samples.byteLength, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(WAV_HEADER_BYTES + i * 2, samples[i]!, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Capture mono PCM locally. The worklet has no audio output and caps the buffer at 60 seconds. */
export async function startRecording(signal: AbortSignal): Promise<Recording> {
  signal.throwIfAborted();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
    throw new Error('Microphone unavailable');
  }
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let complete: (samples: Int16Array | null) => void = () => {};
  const samples = new Promise<Int16Array | null>(resolve => { complete = resolve; });
  const release = () => {
    clearTimeout(stopTimer);
    stream?.getTracks().forEach(track => track.stop());
    stream = undefined;
    source?.disconnect();
    source = undefined;
    processor?.port.close();
    processor?.disconnect();
    processor = undefined;
    if (context.state !== 'closed') void context.close().catch(() => {});
    signal.removeEventListener('abort', abort);
  };
  const finish = (result: Int16Array | null) => {
    release();
    complete(result);
  };
  const abort = () => finish(null);
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (context.sampleRate !== SAMPLE_RATE || !context.audioWorklet) throw new Error('PCM capture unavailable');
    // Resume during the mic press, before waiting for the permission prompt.
    const running = context.resume();
    void running.catch(() => {});
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    signal.throwIfAborted();
    await Promise.all([running, context.audioWorklet.addModule(captureWorklet)]);
    signal.throwIfAborted();
    source = context.createMediaStreamSource(stream);
    processor = new AudioWorkletNode(context, 'navis-pcm-capture', {
      channelCount: 1, channelCountMode: 'explicit', numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    processor.port.onmessage = (event: MessageEvent<Int16Array | null>) => finish(event.data);
    processor.onprocessorerror = () => finish(null);
    source.connect(processor).connect(context.destination);
  } catch (error) {
    finish(null);
    throw error;
  }

  return {
    async stop() {
      if (processor) {
        processor.port.postMessage('stop');
        // An interrupted audio thread must still release the microphone.
        stopTimer = setTimeout(abort, 1000);
      }
      const result = await samples;
      signal.throwIfAborted();
      if (!result) throw new Error('No speech captured');
      return wav(result);
    },
  };
}

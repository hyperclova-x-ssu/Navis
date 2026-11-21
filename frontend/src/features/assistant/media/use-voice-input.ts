import { useLayoutEffect, useRef, useState } from 'react';
import { postMedia } from './media-request';
import { RECORDING_LIMIT_MS, startRecording, type Recording } from './pcm-recording';

export type VoiceInputState = 'idle' | 'starting' | 'listening' | 'processing' | 'error';
type Session = { controller: AbortController; recording?: Recording; timer?: ReturnType<typeof setTimeout> };

function cancelSession(session?: Session | null) {
  clearTimeout(session?.timer);
  session?.controller.abort();
}

export function useVoiceInput(onText: (text: string) => void, focusInput: () => void) {
  const [status, setStatus] = useState<VoiceInputState>('idle');
  const active = useRef<Session | null>(null);
  const callbacks = useRef({ onText, focusInput });
  useLayoutEffect(() => { callbacks.current = { onText, focusInput }; });
  useLayoutEffect(() => () => cancelSession(active.current), []);

  function cancel() {
    cancelSession(active.current);
    active.current = null;
    setStatus('idle');
  }

  function fail(session: Session) {
    if (session.controller.signal.aborted) return;
    active.current = null;
    cancelSession(session);
    setStatus('error');
    callbacks.current.focusInput();
  }

  async function stop(session: Session) {
    const recording = session.recording;
    if (!recording) return;
    session.recording = undefined;
    clearTimeout(session.timer);
    setStatus('processing');
    const signal = session.controller.signal;
    try {
      const audio = await recording.stop();
      signal.throwIfAborted();
      const result = await postMedia<{ requestId: string; text: string }>('transcription', audio, signal);
      signal.throwIfAborted();
      const text = result.text.trim();
      if (!text) throw new Error('No transcript');
      active.current = null;
      setStatus('idle');
      callbacks.current.onText(text);
    } catch {
      fail(session);
    }
  }

  async function toggle() {
    if (active.current) {
      await stop(active.current);
      return;
    }
    const session: Session = { controller: new AbortController() };
    active.current = session;
    setStatus('starting');
    try {
      session.recording = await startRecording(session.controller.signal);
      session.controller.signal.throwIfAborted();
      session.timer = setTimeout(() => void stop(session), RECORDING_LIMIT_MS);
      setStatus('listening');
    } catch {
      fail(session);
    }
  }
  return { status, toggle, cancel };
}

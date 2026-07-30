// Join/leave blips via the Web Audio API; the shared context is built lazily,
// never at import time, since SSR has no `window`.

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

// INVARIANT: never throws — a blocked or closed context must be silence, not an
// error raised inside the awareness handler that called this.
function playTone(frequencies: number[], stepSeconds: number, gain: number): void {
  try {
    const audioCtx = getContext();
    if (!audioCtx) return;
    void audioCtx.resume();

    let startTime = audioCtx.currentTime;
    frequencies.forEach((freq) => {
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = freq;
      gainNode.gain.setValueAtTime(gain, startTime);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + stepSeconds);
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      oscillator.start(startTime);
      oscillator.stop(startTime + stepSeconds);
      startTime += stepSeconds * 0.8;
    });
  } catch {
    // Best-effort: must never surface as an error.
  }
}

export function playJoinSound(): void {
  playTone([523.25, 783.99], 0.12, 0.05);
}

export function playLeaveSound(): void {
  playTone([523.25, 392.0], 0.12, 0.05);
}

// Join/leave blips synthesized with the Web Audio API, so the repo ships no
// audio files. The shared AudioContext is built lazily — never at import time,
// since SSR has no `window`.

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

// Plays `frequencies` as overlapping sine blips. The try/catch means a blocked
// or closed context is silence, never an error thrown into the awareness
// handler that called this.
function playTone(frequencies: number[], stepSeconds: number, gain: number): void {
  try {
    const audioCtx = getContext();
    if (!audioCtx) return;
    // A context built before any user gesture starts suspended. By now the
    // identity form's submit click has unlocked it, so resuming here is enough.
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
    // Best-effort: a blocked AudioContext must never surface as an error.
  }
}

/** A short rising chime (C5 -> G5) for a peer joining the room. */
export function playJoinSound(): void {
  playTone([523.25, 783.99], 0.12, 0.05);
}

/** A short falling tone (C5 -> G4) for a peer leaving the room. */
export function playLeaveSound(): void {
  playTone([523.25, 392.0], 0.12, 0.05);
}

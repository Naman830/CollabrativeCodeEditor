// Short synthesized blips for join/leave activity via the Web Audio API,
// rather than shipping binary audio assets the repo has nowhere to source
// from. Each call builds its own oscillator; the shared AudioContext is
// created lazily so construction never runs at import time (SSR has no
// `window`) and isn't attempted until an activity event actually happens.

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

// Plays `frequencies` as a short sequence of overlapping sine blips. Wrapped
// in try/catch: autoplay policies or an already-closed context should mean
// "no sound", never a thrown error that breaks the awareness handler calling
// this.
function playTone(frequencies: number[], stepSeconds: number, gain: number): void {
  try {
    const audioCtx = getContext();
    if (!audioCtx) return;
    // A context created before any user gesture starts "suspended"; by the
    // time this fires the identity form's submit click has already unlocked
    // it, so resuming here (rather than requiring a separate unlock step) is
    // safe.
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
    // Best-effort only — a missing/blocked AudioContext should never surface
    // to the user as an error.
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

(function exposeStatusSound(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.statusSound = api;
})(typeof globalThis === "object" ? globalThis : this, function createStatusSoundModule() {
  function createStatusSound(AudioContextClass) {
    let enabled = false;
    let audioContext = null;
    const activeOscillators = new Set();

    function stopActiveSounds() {
      for (const oscillator of activeOscillators) {
        try {
          oscillator.stop();
        } catch {}
      }
      activeOscillators.clear();
    }

    function setEnabled(value) {
      enabled = value === true;
      if (!enabled) stopActiveSounds();
    }

    function beep() {
      if (!enabled) return false;
      const Context = AudioContextClass || globalThis.AudioContext;
      if (!Context) return false;
      if (!audioContext || audioContext.state === "closed") audioContext = new Context();

      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.08, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.35);
      oscillator.addEventListener("ended", () => activeOscillators.delete(oscillator), { once: true });
      activeOscillators.add(oscillator);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.35);
      return true;
    }

    return { beep, setEnabled };
  }

  return { createStatusSound };
});

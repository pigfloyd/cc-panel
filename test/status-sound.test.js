const test = require("node:test");
const assert = require("node:assert/strict");
const { createStatusSound } = require("../src/renderer/status-sound");

function fakeAudioContext() {
  const oscillators = [];
  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.currentTime = 10;
      this.destination = {};
    }

    createOscillator() {
      const listeners = new Map();
      const oscillator = {
        frequency: { value: 0 },
        started: false,
        stopCalls: [],
        connect: () => ({ connect: () => {} }),
        addEventListener: (name, listener) => listeners.set(name, listener),
        start: () => { oscillator.started = true; },
        stop: (at) => { oscillator.stopCalls.push(at); },
        finish: () => listeners.get("ended")?.(),
      };
      oscillators.push(oscillator);
      return oscillator;
    }

    createGain() {
      return {
        gain: {
          setValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
      };
    }
  }

  return { FakeAudioContext, oscillators };
}

test("does not create or play audio while status sounds are disabled", () => {
  let contextCreations = 0;
  class CountingAudioContext {
    constructor() { contextCreations += 1; }
  }
  const sound = createStatusSound(CountingAudioContext);

  assert.equal(sound.beep(), false);
  assert.equal(contextCreations, 0);
});

test("disabling status sounds immediately stops active audio and blocks later beeps", () => {
  const { FakeAudioContext, oscillators } = fakeAudioContext();
  const sound = createStatusSound(FakeAudioContext);

  sound.setEnabled(true);
  assert.equal(sound.beep(), true);
  assert.equal(oscillators.length, 1);
  assert.equal(oscillators[0].started, true);
  assert.deepEqual(oscillators[0].stopCalls, [10.35]);

  sound.setEnabled(false);
  assert.deepEqual(oscillators[0].stopCalls, [10.35, undefined]);
  assert.equal(sound.beep(), false);
  assert.equal(oscillators.length, 1);
});

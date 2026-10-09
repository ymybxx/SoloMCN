import test from 'node:test';
import assert from 'node:assert/strict';
import { createStepPause } from '../pacing.js';

function recorder({ maxMs = '', samples = [0] } = {}) {
  const waits = [];
  let samplesUsed = 0;
  const pause = createStepPause({
    maxMs,
    random: () => samples[samplesUsed++ % samples.length],
    wait: async (ms) => { waits.push(ms); },
  });
  return { pause, waits, samplesUsed: () => samplesUsed };
}

test('default pauses vary within 300–600 ms, including both rounded bounds', async () => {
  const { pause, waits } = recorder({ samples: [0, 0.5, 1 - Number.EPSILON] });
  await pause();
  await pause();
  await pause();
  assert.deepEqual(waits, [300, 450, 600]);
});

test('zero disables pauses without invoking the timer or random source', async () => {
  for (const maxMs of [0, '0', ' 0 ']) {
    const { pause, waits, samplesUsed } = recorder({ maxMs });
    await pause();
    await pause();
    assert.deepEqual(waits, []);
    assert.equal(samplesUsed(), 0);
  }
});

test('missing, blank, and invalid configuration use the default duration', async () => {
  for (const maxMs of [null, '', '   ', 'invalid', '-1', -1, NaN, Infinity, 'Infinity']) {
    const { pause, waits } = recorder({ maxMs, samples: [0, 1 - Number.EPSILON] });
    await pause();
    await pause();
    assert.deepEqual(waits, [300, 600], `configuration: ${String(maxMs)}`);
  }
});

test('configured duration supports numeric strings, floors fractions, and caps at 2000 ms', async () => {
  for (const [maxMs, expected] of [['800', 800], [601.9, 601], ['999999', 2000]]) {
    const { pause, waits } = recorder({ maxMs, samples: [1 - Number.EPSILON] });
    await pause();
    assert.deepEqual(waits, [expected]);
  }
});

test('environment configuration is read when a publication creates its pause function', async () => {
  const original = process.env.XHS_STEP_PAUSE_MS;
  try {
    process.env.XHS_STEP_PAUSE_MS = '800';
    const waits = [];
    const pause = createStepPause({ random: () => 0, wait: async (ms) => { waits.push(ms); } });
    process.env.XHS_STEP_PAUSE_MS = '0';
    await pause();
    assert.deepEqual(waits, [400]);

    const disabled = createStepPause({
      random: () => { assert.fail('disabled pause must not request a random sample'); },
      wait: async () => { assert.fail('disabled pause must not wait'); },
    });
    await disabled();
  } finally {
    if (original === undefined) delete process.env.XHS_STEP_PAUSE_MS;
    else process.env.XHS_STEP_PAUSE_MS = original;
  }
});

test('a publication stops adding waits once its 6000 ms budget is exhausted', async () => {
  const { pause, waits, samplesUsed } = recorder({ maxMs: 2000, samples: [1 - Number.EPSILON] });
  for (let i = 0; i < 10; i++) await pause();
  assert.deepEqual(waits, [2000, 2000, 2000]);
  assert.equal(samplesUsed(), 3);
});

test('the last pause is shortened instead of exceeding the publication budget', async () => {
  const { pause, waits } = recorder({ maxMs: 1700, samples: [1 - Number.EPSILON] });
  for (let i = 0; i < 10; i++) await pause();
  assert.deepEqual(waits, [1700, 1700, 1700, 900]);
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 6000);
});

test('separate publications have independent budgets', async () => {
  const first = recorder({ maxMs: 2000, samples: [1 - Number.EPSILON] });
  const second = recorder({ maxMs: 2000, samples: [1 - Number.EPSILON] });
  await first.pause();
  await second.pause();
  await first.pause();
  await first.pause();
  await first.pause();
  await second.pause();
  await second.pause();
  await second.pause();
  assert.deepEqual(first.waits, [2000, 2000, 2000]);
  assert.deepEqual(second.waits, [2000, 2000, 2000]);
});

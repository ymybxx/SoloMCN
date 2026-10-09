import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mock, test } from 'node:test';

let current;

// Entire platform surface is simulated: no browser, login, upload or network request.
mock.module('../browser.js', {
  namedExports: {
    createBrowserAccounts: () => ({
      ensureBound() {},
      openProfile: async () => current.context,
      shot: async () => 'local-fixture.png',
    }),
    waitState: async () => true,
    settle: async () => { current.events.push('cover-settled'); },
    fillChecked: async () => { current.events.push('title-filled'); },
    insertChecked: async () => { current.events.push('body-filled'); },
  },
});
mock.module('../pacing.js', {
  namedExports: {
    createStepPause: () => async () => {
      current.events.push('pause');
      if (current.readyChecks === 1) {
        // The page changes while paused: the old ready state and coordinates expire.
        current.submitReady = false;
        current.buttonWidth = 600;
      }
    },
  },
});

const { createXhs } = await import('../xhs.js');

function fixture({ receiptFails = false } = {}) {
  const state = {
    events: [], readyChecks: 0, submitReady: false, buttonWidth: 200,
    clicks: 0, topicCount: 0, closed: false, selectedTags: [], activeTag: '',
  };
  const locator = (kind, index = 0) => ({
    first() { return this; },
    filter() { return this; },
    nth(i) { return locator(kind, i); },
    locator: (selector) => locator(selector),
    isVisible: async () => false,
    count: async () => kind === 'a.tiptap-topic' ? state.topicCount : kind === '.item' ? 2 : 1,
    innerText: async () => index === 0 ? '#相似话题' : '#' + state.activeTag,
    waitFor: async () => {
      state.events.push('ready:' + kind);
      if (kind === '发布成功' && receiptFails) throw new Error('receipt timeout');
    },
    setInputFiles: async () => { state.events.push('upload:' + kind); },
    hover: async () => { state.events.push('hover:' + kind); },
    scrollIntoViewIfNeeded: async () => {},
    boundingBox: async () => {
      assert(state.submitReady, 'Read coordinates only after rechecking readiness');
      state.events.push('box');
      return { width: state.buttonWidth, height: 40 };
    },
    click: async (options) => {
      state.events.push('click:' + kind);
      if (kind === '.item') {
        assert.equal(index, 1, 'Must select the exact topic, not the first suggestion');
        state.topicCount++;
        state.selectedTags.push(state.activeTag);
      }
      if (kind === 'xhs-publish-btn') {
        assert(state.submitReady);
        assert.equal(state.readyChecks, 2);
        assert.equal(options.position.x, 372, 'Use coordinates read after the pause');
        state.clicks++;
      }
    },
  });
  const page = {
    goto: async () => {},
    url: () => 'https://creator.xiaohongshu.com/publish/publish',
    locator,
    getByText: (text) => locator(String(text)),
    evaluate: async () => '',
    keyboard: {
      press: async () => {},
      type: async (value) => { state.activeTag = value.replace(/^#/, ''); },
    },
    waitForFunction: async (fn) => {
      if (String(fn).includes('submit-disabled')) {
        state.readyChecks++;
        state.submitReady = true;
        state.events.push('submit-ready');
      }
    },
    waitForURL: async () => { if (receiptFails) throw new Error('receipt timeout'); },
  };
  state.context = {
    pages: () => [page],
    close: async () => { state.closed = true; },
  };
  return state;
}

async function run(options = {}) {
  current = fixture(options);
  const publisher = createXhs({ dataDir: '/unused-local-fixture' });
  const localFile = fileURLToPath(import.meta.url);
  return publisher.publish('fixture', {
    mp4: localFile, cover: localFile, title: 'Fixture', desc: 'Fixture body',
    tags: ['一个话题', '另一个话题'], dryRun: options.dryRun,
  }, () => {});
}

test('pauses preserve exact topic binding and recheck submit state/coordinates', async () => {
  const result = await run();
  assert.equal(result.ok, true);
  assert.deepEqual(current.selectedTags, ['一个话题', '另一个话题']);
  assert.equal(current.clicks, 1);
  assert(current.closed);
  const start = current.events.indexOf('submit-ready');
  assert.deepEqual(current.events.slice(start, start + 5), [
    'submit-ready', 'pause', 'submit-ready', 'box', 'click:xhs-publish-btn',
  ]);
});

test('dry run still submits nothing', async () => {
  const result = await run({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(current.clicks, 0);
  assert(current.closed);
});

test('receipt failure does not cause another submit', async () => {
  await assert.rejects(run({ receiptFails: true }), /receipt timeout/);
  assert.equal(current.clicks, 1);
  assert(current.closed);
});

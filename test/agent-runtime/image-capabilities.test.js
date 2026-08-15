'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const capabilities = require('../../src/core/models/image-capabilities');
const gateway = require('../../src/infrastructure/model-gateway/gateway');

function loadImageView() {
  const app = {
    ImageCapabilities: capabilities,
    state: { settings: { imageCapabilities: {} } },
    getProvider: () => ({ apiBase: '', model: '' }),
    services: {},
    rt: {},
    ui: {},
    escapeHtml: (value) => String(value || ''),
  };
  const context = {
    App: app,
    window: { App: app },
    document: { getElementById: () => null, querySelectorAll: () => [] },
    console,
    AbortController,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/views/images/image.js'), 'utf8'), context);
  return app.image;
}

test('SenseNova U1 keeps its six exact image sizes while U1 Fast starts broad', () => {
  const expected = [
    '1664x2496', '2496x1664', '1760x2368',
    '2368x1760', '1824x2272', '2272x1824',
  ];
  assert.deepEqual(capabilities.resolve('https://sensenova.example/v1', 'SenseNova-U1').sizes, expected);
  const fast = capabilities.resolve('https://sensenova.example/v1', 'SenseNova_U1_Fast');
  assert.deepEqual(fast.sizes, []);
  assert.equal(fast.sizeStrategy, 'auto');
  assert.ok(fast.uiSizes.includes('1280x960'));
  assert.equal(capabilities.isSenseNovaU1Model('sensenova-u1-fast'), true);
  assert.equal(capabilities.isSenseNovaU1FastModel('SenseNova_U1_Fast'), true);
  assert.equal(capabilities.isSenseNovaU1Model('sensenova-u2'), false);
  assert.equal(capabilities.isSenseNovaU1Model('u1-custom'), false);
  assert.equal(capabilities.resolve('https://sensenova.example/v1', 'SenseNova-U2').sizes.length, 0);
});

test('GPT Image 1 keeps its three-size contract and GPT Image 2 starts broad', () => {
  const result = capabilities.resolve('https://api.openai.com/v1', 'gpt-image-1');
  assert.equal(result.protocol, 'openai-images');
  assert.deepEqual(result.sizes, capabilities.GPT_IMAGE_SIZES);
  assert.equal(result.sizeStrategy, 'allow-list');
  const next = capabilities.resolve('https://api.openai.com/v1', 'gpt-image-2');
  assert.deepEqual(next.sizes, []);
  assert.equal(next.sizeStrategy, 'auto');
  assert.ok(next.uiSizes.includes('1280x960'));
  assert.equal(capabilities.resolve('https://api.openai.com/v1', 'gpt-image-2.0').sizeStrategy, 'auto');
  assert.equal(capabilities.adaptPayload({ size: '1792x1024' }, next).size, '1792x1024');
});

test('model-level imageSizes override an empty default size list', () => {
  const result = capabilities.resolve('https://custom.example/v1', 'custom-image', {
    config: { imageSizeStrategy: 'allow-list', imageSizes: ['2048x2048', '2048x1152', '1152x2048'] },
  });
  assert.deepEqual(result.sizes, ['2048x2048', '2048x1152', '1152x2048']);
  assert.equal(result.sizeStrategy, 'allow-list');
});

test('renderer size options include hosted U1 Fast common ratios and configured custom ratios', () => {
  const image = loadImageView();
  const hosted = image.sizeOptionsForProvider({ apiBase: 'https://token.sensenova.cn/v1', model: 'sensenova-u1-fast' });
  assert.ok(hosted.length >= capabilities.DEFAULT_UI_SIZES.length);
  assert.ok(hosted.some((item) => item.label === '16:9'));
  assert.ok(hosted.some((item) => item.label === '4:3'));
  const gpt2 = image.sizeOptionsForProvider({ apiBase: 'https://api.openai.com/v1', model: 'gpt-image-2' });
  assert.ok(gpt2.some((item) => item.label === '16:9'));
  assert.ok(gpt2.some((item) => item.label === '3:4'));
  const custom = image.sizeOptionsForProvider({
    apiBase: 'https://custom.example/v1',
    model: 'custom-image',
    profile: { imageSizeStrategy: 'allow-list', imageSizes: ['2048x2048', '2048x1152'] },
  });
  assert.deepEqual(Array.from(custom, (item) => item.value), ['2048x2048', '2048x1152']);
});

test('dynamic model size errors can narrow the initial broad UI contract', () => {
  const base = 'https://sensenova.example/v1';
  const learned = capabilities.learnFromError(base, 'sensenova-u1-fast', 'size should be one of: 1024x1024, 1280x720');
  assert.equal(learned.source, 'learned');
  assert.equal(learned.sizeStrategy, 'allow-list');
  assert.deepEqual(learned.sizes, ['1024x1024', '1280x720']);
});

test('unknown renderer models expose the complete common ratio fallback', () => {
  const image = loadImageView();
  const options = image.sizeOptionsForProvider({ apiBase: 'https://unknown.example/v1', model: 'new-image-model' });
  assert.ok(options.length >= 11);
  assert.ok(options.some((item) => item.label === '3:1'));
  assert.ok(options.some((item) => item.label === '1:3'));
});

test('generic renderer keeps the five classic aspect ratios available', () => {
  const image = loadImageView();
  const options = image.sizeOptionsForProvider({ apiBase: 'https://unknown.example/v1', model: 'classic-ratio-model' });
  const valuesByLabel = new Map(options.map((item) => [item.label, item.value]));
  assert.deepEqual(
    ['1:1', '16:9', '9:16', '4:3', '3:4'].map((label) => valuesByLabel.get(label)),
    ['1024x1024', '1792x1024', '1024x1792', '1280x960', '960x1280'],
  );
  assert.equal(image.normalizeSizeForProvider('1280x960', { apiBase: 'https://unknown.example/v1', model: 'classic-ratio-model' }).label, '4:3');
});

test('Wanx payload adapts the provider-specific size separator', () => {
  const cap = capabilities.resolve('https://dashscope.example/v1', 'wanx-v1');
  assert.equal(cap.sizeFormat, '*');
  assert.equal(capabilities.adaptPayload({ size: '1280x720' }, cap).size, '1280*720');
});

test('learned sizes are isolated by apiBase and exact model', () => {
  const baseA = 'https://learn-a.example/v1';
  const baseB = 'https://learn-b.example/v1';
  const error = 'size should be one of: 1664x2496, 2496x1664';
  const learned = capabilities.learnFromError(baseA, 'unknown-image-model', error);
  assert.equal(learned.source, 'learned');
  assert.deepEqual(learned.sizes, ['1664x2496', '2496x1664']);
  assert.deepEqual(capabilities.resolve(baseB, 'unknown-image-model').sizes, []);
  assert.deepEqual(capabilities.resolve(baseA, 'other-image-model').sizes, []);
});

test('upstream size enumeration is parsed only from the expected marker', () => {
  assert.deepEqual(capabilities.extractAllowedSizes('bad request; should be one of: 1664x2496, 2496x1664'), ['1664x2496', '2496x1664']);
  assert.deepEqual(capabilities.extractAllowedSizes('bad request: 1664x2496'), []);
});

test('image payload adaptation changes only an invalid size', () => {
  const cap = capabilities.resolve('https://sensenova.example/v1', 'SenseNova-U1');
  const payload = { model: 'SenseNova-U1', prompt: 'test', size: '1792x1024', n: 1 };
  const adapted = capabilities.adaptPayload(payload, cap);
  assert.notEqual(adapted, payload);
  assert.equal(adapted.prompt, payload.prompt);
  assert.ok(cap.sizes.includes(adapted.size));
  assert.equal(gateway.adaptImagePayload('https://sensenova.example/v1', { model: 'SenseNova-U1' }, payload).payload.size, adapted.size);
});

test('old state snapshots remain compatible with optional image capability state', () => {
  const state = fs.readFileSync(path.join(__dirname, '../../src/renderer/state/state.js'), 'utf8');
  assert.match(state, /normalizeImageCapabilityStore/);
  assert.match(state, /syncImageCapabilityStore\(ns\.settings\)/);
  assert.match(state, /imageProtocol/);
  assert.match(state, /imageSizes/);
});

test('image asset URL validation accepts http(s) and rejects unsafe schemes/metadata', () => {
  assert.equal(gateway.validateImageAssetUrl('https://cdn.example/image.png').ok, true);
  assert.equal(gateway.validateImageAssetUrl('file:///C:/secret.png').ok, false);
  assert.equal(gateway.validateImageAssetUrl('data:image/png;base64,AAAA').ok, false);
  assert.equal(gateway.validateImageAssetUrl('http://169.254.169.254/latest/meta-data').ok, false);
});

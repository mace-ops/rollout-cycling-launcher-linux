import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-zoom-test-'));
await build({ entryPoints: ['src/main/zoom.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(work, 'zoom.mjs'), logLevel: 'error' });
const { zoomFor } = await import(path.join(work, 'zoom.mjs'));

test('Steam Deck (1280 × 800) stays at 100 %', () => assert.equal(zoomFor('auto', 1280, 800), 1));
test('ROG Ally (1920 × 1080) grows to 135 %', () => assert.equal(zoomFor('auto', 1920, 1080), 1.35));
test('small windows are never scaled down', () => assert.equal(zoomFor('auto', 1024, 640), 1));
test('large screen: factor grows with it', () => assert.equal(zoomFor('auto', 2560, 1440), 1.8));
test('requested value is capped so 1024 × 640 still fits', () => {
  assert.equal(zoomFor('200', 1280, 800), 1.25);
  assert.equal(zoomFor('150', 1920, 1080), 1.5);
});
test('manual below 100 % does not exist', () => assert.equal(zoomFor('50', 1920, 1080), 1));

process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

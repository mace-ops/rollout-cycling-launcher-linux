// Checks padAllowed (src/renderer/nav.ts): while a game is in front, Rollout's own UI must not take the shared Steam gamepad.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-nav-test-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
await build({ entryPoints: ['src/renderer/nav.ts'], bundle: true, platform: 'neutral', format: 'esm', outfile: path.join(work, 'nav.mjs'), logLevel: 'error' });
const { padAllowed } = await import(path.join(work, 'nav.mjs'));

test('N1 Zwift: while its window is in front, Rollout ignores the gamepad (A on the login form must not press "Quit game"); otherwise Rollout takes it', () => {
  for (const phase of ['updates', 'starting', 'running', 'stopping']) {
    assert.equal(padAllowed({ app: 'zwift', phase, visible: true }), false, phase);
    assert.equal(padAllowed({ app: 'zwift', phase, visible: false }), true, phase);
    assert.equal(padAllowed({ app: 'zwift', phase }), true, `${phase} without a window signal`);
  }
  assert.equal(padAllowed({ app: 'zwift', phase: 'crash' }), true);
});

test('N2 MyWhoosh: from "Starting" the gamepad belongs to the game; no start at all: Rollout', () => {
  assert.equal(padAllowed({ app: 'mywhoosh', phase: 'starting' }), false);
  assert.equal(padAllowed({ app: 'mywhoosh', phase: 'running' }), false);
  assert.equal(padAllowed({ app: 'mywhoosh', phase: 'bluetooth' }), true);
  assert.equal(padAllowed(null), true);
  assert.equal(padAllowed(undefined), true);
});

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-pad-test-'));
await build({ entryPoints: ['src/main/gamepad-bridge.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(work, 'pad.mjs'), logLevel: 'error' });
const pad = await import(path.join(work, 'pad.mjs'));

const EV_KEY = 1, EV_ABS = 3;
const A = 0x130, B = 0x131, X = 0x133, Y = 0x134, LB = 0x136, START = 0x13b, R3 = 0x13e;
const ABS = { X: 0, Y: 1, Z: 2, RX: 3, RZ: 5, HAT0X: 0x10, HAT0Y: 0x11 };
const make = () => { const lines = []; const m = new pad.PadMapper((l) => lines.push(l)); return { m, lines }; };

test('P1: Tasten werden gedrückt gehalten und nach 70 ms losgelassen', () => {
  const { m, lines } = make();
  m.feed(EV_KEY, A, 1); m.feed(EV_KEY, A, 0);
  assert.deepEqual(lines, ['keydown Return']);
  m.tick(50); assert.equal(lines.length, 1);
  m.tick(30); assert.deepEqual(lines, ['keydown Return', 'keyup Return']);
  lines.length = 0;
  m.feed(EV_KEY, B, 1); m.feed(EV_KEY, X, 1); m.feed(EV_KEY, Y, 1); m.feed(EV_KEY, START, 1); m.feed(EV_KEY, R3, 1);
  assert.deepEqual(lines, ['keydown Escape', 'keydown Tab', 'keydown shift+Tab', 'keydown Escape', 'mousedown 1']);
  m.tick(100);
  assert.deepEqual(lines.slice(5), ['keyup Escape', 'keyup Tab', 'keyup shift+Tab', 'keyup Escape', 'mouseup 1']);
});

test('P2: Steuerkreuz und linker Stick drücken einmal, wiederholen nach 400 ms', () => {
  const { m, lines } = make();
  const downs = (k) => lines.filter((l) => l === `keydown ${k}`).length;
  m.feed(EV_ABS, ABS.HAT0Y, 1);
  assert.deepEqual(lines, ['keydown Down']);
  m.tick(300); assert.equal(downs('Down'), 1);
  m.tick(150); assert.equal(downs('Down'), 2);
  m.feed(EV_ABS, ABS.HAT0Y, 0); m.tick(500);
  assert.equal(downs('Down'), 2, 'losgelassen: keine Wiederholung');
  m.feed(EV_ABS, ABS.X, -30000);
  assert.equal(downs('Left'), 1);
  m.feed(EV_ABS, ABS.X, -30000); // gleiche Richtung bleibt: nicht erneut
  assert.equal(downs('Left'), 1);
  m.feed(EV_ABS, ABS.X, 5000);
  m.tick(1000);
  assert.equal(downs('Left'), 1);
});

test('P3: rechter Stick bewegt den Zeiger, Totzone bleibt still', () => {
  const { m, lines } = make();
  m.feed(EV_ABS, ABS.RX, 3000); m.tick(100);
  assert.equal(lines.length, 0);
  m.feed(EV_ABS, ABS.RX, 32767); m.tick(100);
  assert.match(lines[0], /^mousemove_relative -- (1[0-9]{2}|[0-9]{2}) 0$/);
  m.feed(EV_ABS, ABS.RX, 0); lines.length = 0; m.tick(100);
  assert.equal(lines.length, 0);
});

test('P4: Trigger klicken, Loslassen und release() heben auf', () => {
  const { m, lines } = make();
  m.feed(EV_ABS, ABS.RZ, 255); m.feed(EV_ABS, ABS.RZ, 255); m.feed(EV_ABS, ABS.Z, 200);
  assert.deepEqual(lines, ['mousedown 1', 'mousedown 3']);
  m.feed(EV_ABS, ABS.RZ, 0);
  assert.equal(lines.at(-1), 'mouseup 1');
  m.release();
  assert.equal(lines.at(-1), 'mouseup 3');
});

test('P5: Schultertaste scrollt und wiederholt', () => {
  const { m, lines } = make();
  m.feed(EV_KEY, LB, 1);
  m.tick(450);
  assert.equal(lines.filter((l) => l === 'mousedown 4').length, 2);
  m.feed(EV_KEY, LB, 0); m.tick(1000);
  assert.equal(lines.filter((l) => l === 'mousedown 4').length, 2);
});

test('P6: Ereignisse aus Rohdaten, auch in Stücken', () => {
  const rec = (type, code, value) => { const b = Buffer.alloc(24); b.writeUInt16LE(type, 16); b.writeUInt16LE(code, 18); b.writeInt32LE(value, 20); return b; };
  const data = Buffer.concat([rec(1, A, 1), rec(3, ABS.X, -1234)]);
  const first = pad.parseEvents(data.subarray(0, 30));
  assert.deepEqual(first.events, [{ type: 1, code: A, value: 1 }]);
  const second = pad.parseEvents(Buffer.concat([first.rest, data.subarray(30)]));
  assert.deepEqual(second.events, [{ type: 3, code: ABS.X, value: -1234 }]);
  assert.equal(second.rest.length, 0);
});

test('P7: Steams virtuelles Gamepad wird gefunden, echte Geräte nicht', () => {
  const text = [
    'N: Name="Microsoft X-Box 360 pad"\nP: Phys=usb-0000:09:00.3-2/input0\nH: Handlers=event3 js0 ',
    'N: Name="Handheld Daemon Controller"\nP: Phys=phys-hhd-main\nH: Handlers=event18 js1 ',
    'N: Name="Microsoft X-Box 360 pad 0"\nP: Phys=\nH: Handlers=event19 js2 '
  ].join('\n\n');
  assert.deepEqual(pad.findPadEvents(text), ['/dev/input/event19']);
});

test('P8: ohne lesbares Gamepad startet nichts und es gibt einen Hinweis', () => {
  const notes = [];
  const f = path.join(work, 'devices');
  fs.writeFileSync(f, 'N: Name="Keyboard"\nH: Handlers=kbd event2 \n');
  const bridge = pad.startPadBridge({ display: ':0', devicesFile: f, onNote: (t) => notes.push(t), spawnFn: () => { throw new Error('darf nicht starten'); } });
  bridge.stop();
  assert.match(notes[0], /kein lesbares Steam-Gamepad/);
});

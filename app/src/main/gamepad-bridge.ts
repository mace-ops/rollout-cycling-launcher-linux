// Controller for Zwift in Gaming Mode. Zwift (a Windows game in a container) does not know gamepads, and the Steam layout of the Rollout entry
// is a gamepad layout. While the Zwift window is visible, Rollout therefore reads Steam Input's virtual gamepad
// (/dev/input/eventN, readable for the logged-in user) and forwards the input as keyboard and mouse to gamescope's X server
// (`xdotool` via XTest). It needs no template and no setting in Steam.
// The core (`PadMapper`) knows neither devices nor processes: it receives evdev events and time and produces xdotool lines.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

const EV_KEY = 1;
const EV_ABS = 3;
const BTN = { A: 0x130, B: 0x131, X: 0x133, Y: 0x134, LB: 0x136, RB: 0x137, SELECT: 0x13a, START: 0x13b, R3: 0x13e } as const;
const ABS = { X: 0x00, Y: 0x01, Z: 0x02, RX: 0x03, RY: 0x04, RZ: 0x05, HAT0X: 0x10, HAT0Y: 0x11 } as const;

const STICK_RANGE = 32768;
const STICK_ON = 0.5;
const DEADZONE = 0.15;
const TRIGGER_MAX = 255;
const TRIGGER_ON = 0.4;
/** Pointer speed at full deflection in pixels per second */
const MOUSE_SPEED = 1400;
const REPEAT_FIRST_MS = 400;
const REPEAT_MS = 110;
/** Zwift polls keys and mouse once per frame: a press released immediately is lost (confirmed on the Ally). */
const HOLD_MS = 70;
/** Pointer mode: d-pad step in pixels (holding it down repeats it) */
const DPAD_STEP = 12;

type Dir = 'Up' | 'Down' | 'Left' | 'Right';

/** Maps gamepad events to xdotool lines (A Enter, B Esc, X Tab, Y Shift+Tab, Select Backspace, Start Esc, d-pad and left stick arrows, right stick mouse, RT left click, LT right click, LB/RB scroll, R3 click). */
export class PadMapper {
  private readonly dirs = new Map<Dir, { since: number; last: number }>();
  private readonly stickDirs = new Set<Dir>();
  private readonly hatDirs = new Set<Dir>();
  private readonly scroll = new Map<'4' | '5', { since: number; last: number }>();
  private rx = 0;
  private ry = 0;
  private lx = 0;
  private ly = 0;
  private carryX = 0;
  private carryY = 0;
  private left = false;
  private right = false;
  private clock = 0;
  private readonly releases: { at: number; line: string }[] = [];

  /**
   * `pointer`: UIs with a mouse pointer like MyWhoosh (Zwift uses keyboard focus). A is left click instead of Enter, and there are no arrow keys:
   * the left stick moves the pointer like the right one, the d-pad in small steps. That way the game never ends up with a focus you cannot see.
   */
  constructor(private readonly send: (line: string) => void, private readonly opts: { pointer?: boolean } = {}) {}

  /** Press an arrow; in pointer mode move the pointer one step instead. */
  private press(dir: Dir): void {
    if (!this.opts.pointer) { this.key(dir); return; }
    const dx = dir === 'Left' ? -DPAD_STEP : dir === 'Right' ? DPAD_STEP : 0;
    const dy = dir === 'Up' ? -DPAD_STEP : dir === 'Down' ? DPAD_STEP : 0;
    this.send(`mousemove_relative -- ${dx} ${dy}`);
  }

  /** Press a key and release it after `HOLD_MS`. */
  private key(name: string): void {
    this.send(`keydown ${name}`);
    this.releases.push({ at: this.clock + HOLD_MS, line: `keyup ${name}` });
  }

  private click(button: string): void {
    this.send(`mousedown ${button}`);
    this.releases.push({ at: this.clock + HOLD_MS, line: `mouseup ${button}` });
  }

  private syncDirs(): void {
    const want = new Set<Dir>([...this.stickDirs, ...this.hatDirs]);
    for (const d of [...this.dirs.keys()]) if (!want.has(d)) this.dirs.delete(d);
    for (const d of want) {
      if (this.dirs.has(d)) continue;
      this.dirs.set(d, { since: this.clock, last: this.clock });
      this.press(d);
    }
  }

  private setStick(): void {
    this.stickDirs.clear();
    if (this.opts.pointer) { this.syncDirs(); return; }
    if (this.lx <= -STICK_ON) this.stickDirs.add('Left');
    if (this.lx >= STICK_ON) this.stickDirs.add('Right');
    if (this.ly <= -STICK_ON) this.stickDirs.add('Up');
    if (this.ly >= STICK_ON) this.stickDirs.add('Down');
    this.syncDirs();
  }

  private setButton(which: 'left' | 'right', down: boolean): void {
    if (this[which] === down) return;
    this[which] = down;
    this.send(`${down ? 'mousedown' : 'mouseup'} ${which === 'left' ? 1 : 3}`);
  }

  /** `value` as in the event: keys 0/1/2, axes in the device's value range. */
  feed(type: number, code: number, value: number): void {
    if (type === EV_KEY) {
      if (value === 2) return;
      const down = value === 1;
      if (code === BTN.LB || code === BTN.RB) {
        const key = code === BTN.LB ? '4' : '5';
        if (!down) { this.scroll.delete(key); return; }
        this.scroll.set(key, { since: this.clock, last: this.clock });
        this.click(key);
        return;
      }
      if (!down) return;
      if (code === BTN.R3 || (code === BTN.A && this.opts.pointer)) { this.click('1'); return; }
      const name = code === BTN.A ? 'Return' : code === BTN.B || code === BTN.START ? 'Escape' : code === BTN.X ? 'Tab'
        : code === BTN.Y ? 'shift+Tab' : code === BTN.SELECT ? 'BackSpace' : '';
      if (name) this.key(name);
      return;
    }
    if (type !== EV_ABS) return;
    switch (code) {
      case ABS.X: this.lx = value / STICK_RANGE; this.setStick(); break;
      case ABS.Y: this.ly = value / STICK_RANGE; this.setStick(); break;
      case ABS.RX: this.rx = value / STICK_RANGE; break;
      case ABS.RY: this.ry = value / STICK_RANGE; break;
      case ABS.Z: this.setButton('right', value / TRIGGER_MAX >= TRIGGER_ON); break;
      case ABS.RZ: this.setButton('left', value / TRIGGER_MAX >= TRIGGER_ON); break;
      case ABS.HAT0X:
        this.hatDirs.delete('Left'); this.hatDirs.delete('Right');
        if (value < 0) this.hatDirs.add('Left');
        if (value > 0) this.hatDirs.add('Right');
        this.syncDirs();
        break;
      case ABS.HAT0Y:
        this.hatDirs.delete('Up'); this.hatDirs.delete('Down');
        if (value < 0) this.hatDirs.add('Up');
        if (value > 0) this.hatDirs.add('Down');
        this.syncDirs();
        break;
      default:
    }
  }

  /** Advance time (milliseconds since the last call): key repeat and pointer movement. */
  tick(dtMs: number): void {
    this.clock += dtMs;
    while (this.releases.length && this.releases[0].at <= this.clock) this.send((this.releases.shift() as { line: string }).line);
    for (const [dir, s] of this.dirs) {
      if (this.clock - s.since >= REPEAT_FIRST_MS && this.clock - s.last >= REPEAT_MS) { s.last = this.clock; this.press(dir); }
    }
    for (const [key, s] of this.scroll) {
      if (this.clock - s.since >= REPEAT_FIRST_MS && this.clock - s.last >= REPEAT_MS) { s.last = this.clock; this.click(key); }
    }
    const axis = (v: number): number => {
      const m = Math.abs(v);
      if (m <= DEADZONE) return 0;
      const f = Math.min(1, (m - DEADZONE) / (1 - DEADZONE));
      return Math.sign(v) * f * f;
    };
    // Pointer mode: both sticks move the pointer (the sum is capped at full speed).
    const mx = this.opts.pointer ? Math.max(-1, Math.min(1, axis(this.rx) + axis(this.lx))) : axis(this.rx);
    const my = this.opts.pointer ? Math.max(-1, Math.min(1, axis(this.ry) + axis(this.ly))) : axis(this.ry);
    this.carryX += mx * MOUSE_SPEED * dtMs / 1000;
    this.carryY += my * MOUSE_SPEED * dtMs / 1000;
    const dx = Math.trunc(this.carryX);
    const dy = Math.trunc(this.carryY);
    if (dx || dy) {
      this.carryX -= dx;
      this.carryY -= dy;
      this.send(`mousemove_relative -- ${dx} ${dy}`);
    }
  }

  /** Release everything (window no longer visible). */
  release(): void {
    for (const r of this.releases.splice(0)) this.send(r.line);
    this.setButton('left', false);
    this.setButton('right', false);
    this.dirs.clear(); this.stickDirs.clear(); this.hatDirs.clear(); this.scroll.clear();
    this.rx = this.ry = this.lx = this.ly = this.carryX = this.carryY = 0;
  }
}

const EVENT_SIZE = 24;

/** Splits a stream of `struct input_event` (64 bit: 16 bytes time, type, code, value); returns the events and the remainder. */
export function parseEvents(chunk: Buffer): { events: { type: number; code: number; value: number }[]; rest: Buffer } {
  const events: { type: number; code: number; value: number }[] = [];
  let at = 0;
  for (; at + EVENT_SIZE <= chunk.length; at += EVENT_SIZE) {
    events.push({ type: chunk.readUInt16LE(at + 16), code: chunk.readUInt16LE(at + 18), value: chunk.readInt32LE(at + 20) });
  }
  return { events, rest: chunk.subarray(at) };
}

/** The gamepad created by Steam Input: `Microsoft X-Box 360 pad <number>` (real devices have no number). */
export function findPadEvents(devices: string): string[] {
  const found: string[] = [];
  for (const block of devices.split(/\n\s*\n/)) {
    const name = /^N: Name="([^"]*)"/m.exec(block)?.[1] ?? '';
    const event = /Handlers=.*\b(event\d+)\b/.exec(block)?.[1];
    if (event && /^Microsoft X-Box 360 pad \d+$/.test(name)) found.push(`/dev/input/${event}`);
  }
  return found;
}

export interface PadBridge { stop(): void }

export interface PadBridgeOptions {
  display: string;
  env?: NodeJS.ProcessEnv;
  onNote?: (text: string) => void;
  /** Pointer mode (MyWhoosh): A left click, sticks and d-pad move the pointer, no arrow keys */
  pointer?: boolean;
  /** Replaceable for tests */
  devicesFile?: string;
  spawnFn?: typeof spawn;
}

/** Starts the forwarding; without a readable gamepad or without `xdotool` nothing happens (note via `onNote`). */
export function startPadBridge(opts: PadBridgeOptions): PadBridge {
  const note = (t: string): void => opts.onNote?.(t);
  const run = opts.spawnFn ?? spawn;
  let pads: string[] = [];
  try { pads = findPadEvents(fs.readFileSync(opts.devicesFile ?? '/proc/bus/input/devices', 'utf8')).filter((p) => { try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; } }); } catch { /* unten */ }
  if (!pads.length) { note('Gamepad bridge: no readable Steam gamepad found'); return { stop: () => {} }; }
  const children: ChildProcess[] = [];
  let seen = 0;
  const xdo = run('xdotool', ['-'], { env: { ...(opts.env ?? process.env), DISPLAY: opts.display }, stdio: ['pipe', 'ignore', 'ignore'] });
  let alive = true;
  xdo.on('error', () => { alive = false; note('Gamepad bridge: xdotool missing or fails to start'); });
  xdo.on('close', (code) => { alive = false; note(`xdotool beendet (Code ${code ?? '?'})`); });
  xdo.stdin?.on('error', () => { alive = false; });
  let sent = 0;
  const mapper = new PadMapper((line) => { if (alive) { xdo.stdin?.write(`${line}\n`); if (sent++ < 5) note(`xdotool: ${line}`); } }, { pointer: opts.pointer });
  for (const device of pads) {
    const cat = run('cat', [device], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(cat);
    let rest: Buffer = Buffer.alloc(0);
    cat.stdout?.on('data', (data: Buffer) => {
      const parsed = parseEvents(Buffer.concat([rest, data]));
      rest = parsed.rest;
      for (const e of parsed.events) {
        if (seen++ < 5 && e.type !== 0) note(`Event ${device}: type ${e.type} code ${e.code} value ${e.value}`);
        mapper.feed(e.type, e.code, e.value);
      }
    });
    cat.on('error', () => {});
  }
  let last = Date.now();
  const timer = setInterval(() => { const now = Date.now(); mapper.tick(now - last); last = now; }, 16);
  note(`Gamepad bridge active (${pads.join(', ')})`);
  return {
    stop: () => {
      clearInterval(timer);
      mapper.release();
      for (const c of children) { try { c.kill('SIGTERM'); } catch { /* already exited */ } }
      try { xdo.stdin?.end(); } catch { /* already closed */ }
      setTimeout(() => { try { xdo.kill('SIGTERM'); } catch { /* weg */ } }, 500).unref();
      note('Gamepad bridge stopped');
    }
  };
}

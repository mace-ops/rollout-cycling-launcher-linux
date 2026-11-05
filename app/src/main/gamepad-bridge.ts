// Controller für Zwift im Spielmodus. Zwift (Windows-Spiel im Container) kennt kein Gamepad, und das Steam-Layout des Rollout-Eintrags
// ist ein Gamepad-Layout. Solange das Zwift-Fenster zu sehen ist, liest Rollout deshalb das virtuelle Gamepad von Steam Input
// (/dev/input/eventN, für den angemeldeten Nutzer lesbar) und gibt die Eingaben als Tastatur und Maus an den X-Server von gamescope weiter
// (`xdotool` über XTest). Es braucht keine Vorlage und keine Einstellung in Steam.
// Der Kern (`PadMapper`) kennt weder Geräte noch Prozesse: Er bekommt evdev-Ereignisse und Zeit und liefert xdotool-Zeilen.
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
/** Zeigergeschwindigkeit bei vollem Ausschlag in Pixel je Sekunde */
const MOUSE_SPEED = 1400;
const REPEAT_FIRST_MS = 400;
const REPEAT_MS = 110;
/** Zwift fragt Tasten und Maus je Bild ab: ein Druck, der sofort wieder losgelassen wird, geht verloren (am Ally belegt). */
const HOLD_MS = 70;

type Dir = 'Up' | 'Down' | 'Left' | 'Right';

/** Bildet Gamepad-Ereignisse auf xdotool-Zeilen ab (A Enter, B Esc, X Tab, Y Umschalt+Tab, Select Rücktaste, Start Esc, Steuerkreuz und linker Stick Pfeile, rechter Stick Maus, RT Linksklick, LT Rechtsklick, LB/RB Scrollen, R3 Klick). */
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

  constructor(private readonly send: (line: string) => void) {}

  /** Taste drücken und nach `HOLD_MS` loslassen. */
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
      this.key(d);
    }
  }

  private setStick(): void {
    this.stickDirs.clear();
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

  /** `value` wie im Ereignis: Tasten 0/1/2, Achsen im Wertebereich des Geräts. */
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
      if (code === BTN.R3) { this.click('1'); return; }
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

  /** Zeit voranschreiben (Millisekunden seit dem letzten Aufruf): Tastenwiederholung und Zeigerbewegung. */
  tick(dtMs: number): void {
    this.clock += dtMs;
    while (this.releases.length && this.releases[0].at <= this.clock) this.send((this.releases.shift() as { line: string }).line);
    for (const [dir, s] of this.dirs) {
      if (this.clock - s.since >= REPEAT_FIRST_MS && this.clock - s.last >= REPEAT_MS) { s.last = this.clock; this.key(dir); }
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
    this.carryX += axis(this.rx) * MOUSE_SPEED * dtMs / 1000;
    this.carryY += axis(this.ry) * MOUSE_SPEED * dtMs / 1000;
    const dx = Math.trunc(this.carryX);
    const dy = Math.trunc(this.carryY);
    if (dx || dy) {
      this.carryX -= dx;
      this.carryY -= dy;
      this.send(`mousemove_relative -- ${dx} ${dy}`);
    }
  }

  /** Alles loslassen (Fenster nicht mehr sichtbar). */
  release(): void {
    for (const r of this.releases.splice(0)) this.send(r.line);
    this.setButton('left', false);
    this.setButton('right', false);
    this.dirs.clear(); this.stickDirs.clear(); this.hatDirs.clear(); this.scroll.clear();
    this.rx = this.ry = this.lx = this.ly = this.carryX = this.carryY = 0;
  }
}

const EVENT_SIZE = 24;

/** Zerlegt einen Strom von `struct input_event` (64 Bit: 16 Byte Zeit, Typ, Code, Wert); gibt die Ereignisse und den Rest zurück. */
export function parseEvents(chunk: Buffer): { events: { type: number; code: number; value: number }[]; rest: Buffer } {
  const events: { type: number; code: number; value: number }[] = [];
  let at = 0;
  for (; at + EVENT_SIZE <= chunk.length; at += EVENT_SIZE) {
    events.push({ type: chunk.readUInt16LE(at + 16), code: chunk.readUInt16LE(at + 18), value: chunk.readInt32LE(at + 20) });
  }
  return { events, rest: chunk.subarray(at) };
}

/** Das von Steam Input erzeugte Gamepad: `Microsoft X-Box 360 pad <Nummer>` (die echten Geräte heißen ohne Nummer). */
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
  /** Ersetzen für Tests */
  devicesFile?: string;
  spawnFn?: typeof spawn;
}

/** Startet die Weitergabe; ohne lesbares Gamepad oder ohne `xdotool` passiert nichts (Hinweis über `onNote`). */
export function startPadBridge(opts: PadBridgeOptions): PadBridge {
  const note = (t: string): void => opts.onNote?.(t);
  const run = opts.spawnFn ?? spawn;
  let pads: string[] = [];
  try { pads = findPadEvents(fs.readFileSync(opts.devicesFile ?? '/proc/bus/input/devices', 'utf8')).filter((p) => { try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; } }); } catch { /* unten */ }
  if (!pads.length) { note('Controller-Weitergabe: kein lesbares Steam-Gamepad gefunden'); return { stop: () => {} }; }
  const children: ChildProcess[] = [];
  let seen = 0;
  const xdo = run('xdotool', ['-'], { env: { ...(opts.env ?? process.env), DISPLAY: opts.display }, stdio: ['pipe', 'ignore', 'ignore'] });
  let alive = true;
  xdo.on('error', () => { alive = false; note('Controller-Weitergabe: xdotool fehlt oder startet nicht'); });
  xdo.on('close', (code) => { alive = false; note(`xdotool beendet (Code ${code ?? '?'})`); });
  xdo.stdin?.on('error', () => { alive = false; });
  let sent = 0;
  const mapper = new PadMapper((line) => { if (alive) { xdo.stdin?.write(`${line}\n`); if (sent++ < 5) note(`xdotool: ${line}`); } });
  for (const device of pads) {
    const cat = run('cat', [device], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(cat);
    let rest: Buffer = Buffer.alloc(0);
    cat.stdout?.on('data', (data: Buffer) => {
      const parsed = parseEvents(Buffer.concat([rest, data]));
      rest = parsed.rest;
      for (const e of parsed.events) {
        if (seen++ < 5 && e.type !== 0) note(`Ereignis ${device}: Typ ${e.type} Code ${e.code} Wert ${e.value}`);
        mapper.feed(e.type, e.code, e.value);
      }
    });
    cat.on('error', () => {});
  }
  let last = Date.now();
  const timer = setInterval(() => { const now = Date.now(); mapper.tick(now - last); last = now; }, 16);
  note(`Controller-Weitergabe aktiv (${pads.join(', ')})`);
  return {
    stop: () => {
      clearInterval(timer);
      mapper.release();
      for (const c of children) { try { c.kill('SIGTERM'); } catch { /* schon beendet */ } }
      try { xdo.stdin?.end(); } catch { /* schon zu */ }
      setTimeout(() => { try { xdo.kill('SIGTERM'); } catch { /* weg */ } }, 500).unref();
      note('Controller-Weitergabe beendet');
    }
  };
}

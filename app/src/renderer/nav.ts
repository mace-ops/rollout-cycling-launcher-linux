// Operation by keyboard and controller: arrows, d-pad and left stick move between
// all controls, A or Enter activates, B or Esc goes back, right stick scrolls.

import type { Launch } from '../shared/api';

export type Dir = 'up' | 'down' | 'left' | 'right';

/**
 * May Rollout's own UI take gamepad input during this start? In Gaming Mode the game and Rollout get the same virtual gamepad from Steam Input.
 * As long as the game is in front, an A meant for the game would also press "Quit game", the only button of the running view (with Zwift
 * this ended the game on the login form: arrow down focused the button, A for "log in with existing account" pressed it).
 * MyWhoosh has no window signal: from "Starting" the game is in front and is quit through Steam. Zwift reports `visible` (its window is the one
 * gamescope focuses, zwift-window.ts): while it is in front the gamepad belongs to Zwift; once Rollout is in front again, to Rollout.
 */
export function padAllowed(launch: Pick<Launch, 'app' | 'phase' | 'visible'> | null | undefined): boolean {
  if (!launch) return true;
  if (launch.app === 'mywhoosh') return launch.phase !== 'starting' && launch.phase !== 'running';
  return !launch.visible;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';
const STICK_ON = 0.6;
const STICK_OFF = 0.3;
const SCROLL_SPEED = 18;
const REPEAT_DELAY_MS = 420;
const REPEAT_MS = 130;

export function focusables(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });
}

/** The primary button, otherwise the first element. */
export function focusInitial(scope: ParentNode): void {
  const items = focusables(scope);
  const target = items.find((el) => el.matches('[data-initial]')) ?? items.find((el) => el.matches('.btn.primary')) ?? items[0];
  target?.focus({ preventScroll: true });
}

function gap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  if (aMax < bMin) return bMin - aMax;
  if (bMax < aMin) return aMin - bMax;
  return 0;
}

/**
 * After mouse or touch the browser hides the focus ring, even when keys or controller set the
 * focus. The controller triggers no key events, so the `nav` class controls the ring.
 * Returns true if the ring just became visible.
 */
let navMode = false;
function enterNavMode(): boolean {
  const first = !navMode;
  navMode = true;
  document.documentElement.classList.add('nav');
  return first;
}

export function move(scope: ParentNode, dir: Dir, reveal = false): void {
  const items = focusables(scope);
  const current = document.activeElement as HTMLElement | null;
  if (!current || !items.includes(current)) {
    focusInitial(scope);
    return;
  }
  // The first press after touch or mouse only shows where the focus is.
  if (reveal) return;
  const c = current.getBoundingClientRect();
  const cx = c.left + c.width / 2;
  const cy = c.top + c.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - cx;
    const dy = r.top + r.height / 2 - cy;
    const horizontal = dir === 'left' || dir === 'right';
    const primary = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    if (primary < 4) continue;
    const across = horizontal ? gap(c.top, c.bottom, r.top, r.bottom) : gap(c.left, c.right, r.left, r.right);
    const centre = Math.abs(horizontal ? dy : dx);
    const score = primary + across * 3 + centre * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  best?.focus();
}

export interface NavHooks {
  /** Area in which the controls live: the dialog, otherwise the view. */
  scope(): ParentNode;
  modalOpen(): boolean;
  back(): void;
  /**
   * Does Rollout accept gamepad input? If a game runs in the foreground, game and Rollout get the same virtual gamepad from Steam
   * Input: an A in the game would otherwise also press the "Quit game" button under the window in Rollout. Default: yes.
   */
  padEnabled?(): boolean;
}

const KEY_DIR: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

export function initNav(hooks: NavHooks): void {
  const pointer = (): void => {
    navMode = false;
    document.documentElement.classList.remove('nav');
  };
  window.addEventListener('pointerdown', pointer, true);

  window.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key in KEY_DIR || event.key === 'Tab') enterNavMode();
    const active = document.activeElement;
    if (event.key === 'Escape') {
      event.preventDefault();
      hooks.back();
      return;
    }
    if (event.key === 'Tab' && hooks.modalOpen()) {
      // Inside the dialog the focus stays trapped.
      event.preventDefault();
      const items = focusables(hooks.scope());
      if (!items.length) return;
      const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
      const next = index === -1 ? 0 : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next].focus();
      return;
    }
    const dir = KEY_DIR[event.key];
    if (!dir) return;
    event.preventDefault();
    move(hooks.scope(), dir);
  });

  const padUsed = (): boolean => enterNavMode();

  const held = new Map<string, number>();
  const pressedBefore = new Map<number, boolean>();
  let scrollAxis = 0;

  const fire = (key: string, now: number, on: boolean, action: () => void): void => {
    if (!on) {
      held.delete(key);
      return;
    }
    const next = held.get(key);
    if (next === undefined) {
      held.set(key, now + REPEAT_DELAY_MS);
      action();
    } else if (now >= next) {
      held.set(key, now + REPEAT_MS);
      action();
    }
  };

  const poll = (now: number): void => {
    // Schedule the next tick first: an error in one pass must never end the polling (this once made the controller fail completely).
    requestAnimationFrame(poll);
    scrollAxis = 0;
    const enabled = hooks.padEnabled?.() ?? true;
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      const button = (i: number): boolean => !!pad.buttons[i]?.pressed;
      if (!enabled) {
        // Buttons still held down when re-enabled trigger nothing.
        for (const i of [0, 1]) pressedBefore.set(pad.index * 100 + i, button(i));
        held.clear();
        continue;
      }
      const axisX = pad.axes[0] ?? 0;
      const axisY = pad.axes[1] ?? 0;
      fire('up', now, button(12) || axisY < -STICK_ON, () => move(hooks.scope(), 'up', padUsed()));
      fire('down', now, button(13) || axisY > STICK_ON, () => move(hooks.scope(), 'down', padUsed()));
      fire('left', now, button(14) || axisX < -STICK_ON, () => move(hooks.scope(), 'left', padUsed()));
      fire('right', now, button(15) || axisX > STICK_ON, () => move(hooks.scope(), 'right', padUsed()));
      const edge = (i: number, action: () => void): void => {
        const key = pad.index * 100 + i;
        const down = button(i);
        if (down && !pressedBefore.get(key)) action();
        pressedBefore.set(key, down);
      };
      edge(0, () => {
        const first = enterNavMode();
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || active === document.body) focusInitial(hooks.scope());
        else if (!first) active.click();
      });
      edge(1, () => hooks.back());
      const y = pad.axes[3] ?? 0;
      if (Math.abs(y) > STICK_OFF) scrollAxis = y;
    }
    if (scrollAxis) window.scrollBy(0, scrollAxis * SCROLL_SPEED);
  };
  requestAnimationFrame(poll);
}

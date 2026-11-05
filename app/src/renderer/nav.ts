// Bedienung per Tastatur und Controller: Pfeile, Steuerkreuz und linker Stick wechseln zwischen
// allen Bedienelementen, A oder Enter löst aus, B oder Esc geht zurück, rechter Stick scrollt.

export type Dir = 'up' | 'down' | 'left' | 'right';

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

/** Der Hauptknopf, sonst das erste Element. */
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
 * Nach Maus oder Touch blendet der Browser den Fokusring aus, auch wenn Tasten oder Controller den
 * Fokus setzen. Der Controller löst keine Tastenereignisse aus, darum steuert die Klasse `nav` den Ring.
 * Gibt true zurück, wenn der Ring gerade erst sichtbar wurde.
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
  // Erster Druck nach Touch oder Maus zeigt nur, wo der Fokus liegt.
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
  /** Bereich, in dem die Bedienelemente liegen: der Dialog, sonst die Ansicht. */
  scope(): ParentNode;
  modalOpen(): boolean;
  back(): void;
  /**
   * Nimmt Rollout Gamepad-Eingaben an? Läuft ein Spiel im Vordergrund, bekommen Spiel und Rollout dasselbe virtuelle Gamepad von Steam
   * Input: Ein A im Spiel drückte sonst auch in Rollout den Knopf „Spiel beenden“ unter dem Fenster. Ohne Angabe: ja.
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
      // Im Dialog bleibt der Fokus eingesperrt.
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
    // Zuerst den nächsten Takt anmelden: Ein Fehler in einem Durchlauf darf die Abfrage nie beenden (so fiel der Controller einmal ganz aus).
    requestAnimationFrame(poll);
    scrollAxis = 0;
    const enabled = hooks.padEnabled?.() ?? true;
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      const button = (i: number): boolean => !!pad.buttons[i]?.pressed;
      if (!enabled) {
        // Tasten, die beim Wiedereinschalten noch gedrückt sind, lösen nichts aus.
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

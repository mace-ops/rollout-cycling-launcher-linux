const svg = (path: string, extra = ''): string =>
  `<svg class="icon ${extra}" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;

// Marke für kleine Größen: gleiche Form wie assets/brand/logo.svg, aber dickere Linien, damit die zwei Ringe lesbar bleiben.
const LOGO = '<svg class="logo" viewBox="130 130 764 764" fill="none" stroke-linecap="round" aria-hidden="true">'
  + '<path d="M750.5 242.4A360 360 0 1 0 772.3 263.3" stroke="currentColor" stroke-width="32"/>'
  + '<path d="M700.3 291.5A290 290 0 1 0 725.1 315.3" stroke="currentColor" stroke-width="32"/>'
  + '<path d="M713.1 303L759.5 254.8" stroke="var(--accent)" stroke-width="40"/></svg>';

export const ICON = {
  logo: LOGO,
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  next: svg('<path d="m9 18 6-6-6-6"/>'),
  go: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  cross: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  bt: svg('<path d="m7 7 10 10-5 5V2l5 5L7 17"/>'),
  gear: svg('<path d="M10.0 4.7L10.5 2.1L13.5 2.1L14.0 4.7L15.7 5.4L17.9 4.0L20.0 6.1L18.6 8.3L19.3 10.0L21.9 10.5L21.9 13.5L19.3 14.0L18.6 15.7L20.0 17.9L17.9 20.0L15.7 18.6L14.0 19.3L13.5 21.9L10.5 21.9L10.0 19.3L8.3 18.6L6.1 20.0L4.0 17.9L5.4 15.7L4.7 14.0L2.1 13.5L2.1 10.5L4.7 10.0L5.4 8.3L4.0 6.1L6.1 4.0L8.3 5.4Z"/><circle cx="12" cy="12" r="3"/>'),
  update: svg('<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v5h-5"/>'),
  power: svg('<path d="M12 3v9"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/>'),
  alert: svg('<path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v5M12 18h.01"/>', 'alert')
};

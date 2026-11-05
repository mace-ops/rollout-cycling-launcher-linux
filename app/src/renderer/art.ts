import { ICON } from './icons';

export type ArtKind = 'portrait' | 'wide' | 'hero' | 'logo';

const kind = (new URLSearchParams(location.search).get('kind') ?? 'wide') as ArtKind;
document.body.dataset.kind = kind;
const stage = document.getElementById('stage') as HTMLElement;

const mesh = '<div class="mesh"></div><div class="grain"></div>';
const mark = ICON.logo;

if (kind === 'logo') stage.innerHTML = `${mark}<span class="word">Rollout</span>`;
else if (kind === 'hero') stage.innerHTML = '<img class="hero-img" src="assets/img/mywhoosh.jpg" alt=""><div class="hero-fade"></div>';
else stage.innerHTML = `${mesh}${mark}<span class="word">Rollout</span>`;

// Reports to the main process that font and image are ready.
const heroImage = document.querySelector<HTMLImageElement>('.hero-img');
void Promise.all([document.fonts.ready, heroImage ? heroImage.decode() : Promise.resolve()]).then(() => { document.title = 'ready'; });

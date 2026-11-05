/* Rollout website: comfort only. All content works without this script. */
(() => {
  const $ = id => document.getElementById(id);
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;

  /* header line, back-to-top button */
  const head = $('top'), totop = $('totop');
  function onScroll() {
    head.classList.toggle('scrolled', scrollY > 20);
    const show = scrollY > innerHeight;
    totop.classList.toggle('show', show);
    totop.tabIndex = show ? 0 : -1;
  }
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
  totop.addEventListener('click', e => {
    e.preventDefault();
    scrollTo({ top: 0, behavior: RM ? 'auto' : 'smooth' });
    document.querySelector('.brand').focus({ preventScroll: true });
  });

  /* theme: system by default, toggle overrides and is remembered */
  $('theme').addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch (_) { /* private mode */ }
  });

  /* language menu: close on outside click and Escape */
  const lm = document.querySelector('.langmenu');
  document.addEventListener('click', e => { if (lm && lm.open && !lm.contains(e.target)) lm.open = false; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && lm && lm.open) { lm.open = false; lm.querySelector('summary').focus(); } });

  /* reveal on scroll */
  const rv = [...document.querySelectorAll('.rv')];
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => es.forEach(x => { if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); } }), { threshold: .12 });
    rv.forEach(e => io.observe(e));
  } else rv.forEach(e => e.classList.add('in'));

  /* carousel */
  const sec = $('action'), track = $('track'), dots = $('dots'), cbar = $('cbar');
  const slides = [...track.querySelectorAll('.slide')];
  const info = slides.map(s => ({ t: s.querySelector('.cap b').textContent, d: s.querySelector('.cap span').textContent }));
  const of = sec.dataset.of;
  let cur = 0, timer = null;
  cbar.hidden = false; dots.hidden = false;
  dots.innerHTML = info.map((x, i) => `<button type="button" aria-label="${x.t.replace(/"/g, '&quot;')}"><i><b></b></i></button>`).join('');
  const dotEls = [...dots.children];
  dotEls.forEach((b, i) => b.addEventListener('click', () => go(i, true)));
  slides.forEach((s, i) => s.addEventListener('click', () => go(i, true)));
  function mark(i) {
    cur = i;
    slides.forEach((el, j) => el.classList.toggle('on', j === i));
    dotEls.forEach((b, j) => {
      b.classList.toggle('on', j === i); b.classList.toggle('done', j < i);
      if (j === i) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      const n = b.querySelector('b'); n.style.animation = 'none'; void n.offsetWidth; n.style.animation = '';
    });
    $('cnum').textContent = of.replace('{n}', String(i + 1).padStart(2, '0')).replace('{total}', String(slides.length).padStart(2, '0'));
    $('ctitle').textContent = info[i].t; $('cdesc').textContent = info[i].d;
  }
  function go(i, user) {
    const n = slides.length; i = (i + n) % n;
    const el = slides[i];
    track.scrollTo({ left: el.offsetLeft - (track.clientWidth - el.clientWidth) / 2, behavior: RM ? 'auto' : 'smooth' });
    mark(i); if (user) restart();
  }
  const paused = () => sec.classList.contains('paused') || !visible;
  function restart() { clearInterval(timer); if (!RM) timer = setInterval(() => { if (!paused()) go(cur + 1); }, 5000); }
  let visible = true;
  if ('IntersectionObserver' in window) new IntersectionObserver(es => { visible = es[0].isIntersecting; }, { threshold: .2 }).observe(sec);
  let st;
  track.addEventListener('scroll', () => {
    clearTimeout(st);
    st = setTimeout(() => {
      const c = track.scrollLeft + track.clientWidth / 2; let best = 0, d = 1e9;
      slides.forEach((el, i) => { const m = Math.abs(el.offsetLeft + el.clientWidth / 2 - c); if (m < d) { d = m; best = i; } });
      if (best !== cur) mark(best);
    }, 90);
  }, { passive: true });
  $('prev').addEventListener('click', () => go(cur - 1, true));
  $('next').addEventListener('click', () => go(cur + 1, true));
  sec.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(cur + 1, true); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(cur - 1, true); }
  });
  ['mouseenter', 'focusin', 'pointerdown', 'touchstart'].forEach(ev => sec.addEventListener(ev, () => sec.classList.add('paused'), { passive: true }));
  ['mouseleave', 'focusout'].forEach(ev => sec.addEventListener(ev, () => sec.classList.remove('paused')));
  if (RM) sec.classList.add('paused');
  addEventListener('resize', () => go(cur));
  mark(0); restart();
  // keep the first slide centred once layout is known (no smooth scroll on load)
  track.scrollTo({ left: slides[0].offsetLeft - (track.clientWidth - slides[0].clientWidth) / 2, behavior: 'auto' });

  /* feature showcase */
  const fitems = [...document.querySelectorAll('.fitem')], fimgs = [...document.querySelectorAll('.fstage .screen picture')];
  function setFeat(i) { fitems.forEach((f, j) => f.classList.toggle('on', j === i)); fimgs.forEach((m, j) => m.classList.toggle('on', j === i)); }
  setFeat(0);
  if ('IntersectionObserver' in window) {
    const fio = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) setFeat(+e.target.dataset.f); }), { rootMargin: '-45% 0px -45% 0px' });
    fitems.forEach(f => { fio.observe(f); f.addEventListener('click', () => setFeat(+f.dataset.f)); });
  }

  /* language hint: first visit on the English start page only, never a redirect */
  const hint = $('hint'), hintData = $('hints');
  if (hint && hintData) {
    let dismissed = false;
    try { dismissed = localStorage.getItem('hint') === '1'; } catch (_) { /* ignore */ }
    const data = JSON.parse(hintData.textContent);
    const pref = (navigator.languages || [navigator.language || 'en']).map(l => String(l).slice(0, 2).toLowerCase()).find(l => data[l]);
    if (!dismissed && pref && pref !== 'en') {
      const h = data[pref];
      hint.lang = pref;
      $('hint-text').textContent = h.text;
      const a = $('hint-link'); a.textContent = h.go; a.href = h.href; a.hreflang = pref; a.lang = pref;
      const b = $('hint-close'); b.setAttribute('aria-label', h.close); b.lang = pref;
      b.addEventListener('click', () => { hint.hidden = true; try { localStorage.setItem('hint', '1'); } catch (_) { /* ignore */ } });
      hint.hidden = false;
    }
  }
})();

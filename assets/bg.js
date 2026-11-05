/* "Two riders": a dense micro dot grid over the whole page. Blue rolls in from the left, orange from the right, on curved
   lines. Sometimes (about 40 % of the rounds) they meet: elastic impulse, a faint shimmer and two weak shock waves.
   The riders have no shape. They exist only through the dots they push aside and light up. Trails fade out.
   Scrolling speeds things up, the mouse pointer lights nearby dots a little.
   Performance: the grid is pre-rendered once into an offscreen canvas. Per frame only the lit dots are cleared and redrawn,
   batched by colour. If frames get slow the grid gets coarser once. Reduced motion: still image right after the meeting. */
(() => {
  const cv = document.getElementById('bg');
  if (!cv || !cv.getContext) return;
  const cx = cv.getContext('2d');
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DOT = .8, R = 285, PUSH = 42, SPEED = 270, BR = 95;
  const MEET = .4;                       // share of rounds in which the riders collide
  const HL = 12, ML = 5, WL = 3;         // colour buckets: brightness, blue→orange, white (wave)
  let GAP = 9, dprMax = 2, degraded = false;
  let W, H, dpr, cols, rows, N, px, py, hb, ho, hw, ox, oy, col = {}, base = null, styles = [];
  const balls = [{}, {}], waves = [];
  let flash = null, hit = false, boost = 1, lastY = scrollY, mx = -1e4, my = -1e4;
  let path = null, forceMeet = false;

  function theme() {
    const r = document.documentElement;
    const light = r.dataset.theme === 'light' || (!r.dataset.theme && matchMedia('(prefers-color-scheme: light)').matches);
    col = light
      ? { base: '17,18,22', ba: .10, b: [29, 78, 216], o: [217, 72, 15], w: [17, 18, 22] }
      : { base: '255,255,255', ba: .065, b: [110, 160, 255], o: [255, 122, 47], w: [255, 255, 255] };
    styles = [];
    buildBase();
  }

  function size() {
    dpr = Math.min(devicePixelRatio || 1, dprMax);
    W = innerWidth; H = innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(W / GAP) + 1; rows = Math.ceil(H / GAP) + 1; N = cols * rows;
    px = new Float32Array(N); py = new Float32Array(N);
    hb = new Float32Array(N); ho = new Float32Array(N); hw = new Float32Array(N);
    ox = (W - (cols - 1) * GAP) / 2; oy = (H - (rows - 1) * GAP) / 2;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { const k = j * cols + i; px[k] = ox + i * GAP; py[k] = oy + j * GAP; }
    buildBase();
  }

  function buildBase() {
    if (!W) return;
    base = base || document.createElement('canvas');
    base.width = cv.width; base.height = cv.height;
    const b = base.getContext('2d');
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    b.fillStyle = `rgba(${col.base},${col.ba})`;
    b.beginPath();
    for (let k = 0; k < N; k++) b.rect(px[k] - DOT / 2, py[k] - DOT / 2, DOT, DOT);
    b.fill();
  }

  // One round: both riders follow curved paths p(s), s from 0 to 1. They meet at s = .5 unless the round is a near miss.
  function round() {
    const M = [W * (.3 + Math.random() * .4), H * (.3 + Math.random() * .4)], L = Math.hypot(W, H) * .62;
    const a1 = (Math.random() * .5 + .1) * (Math.random() < .5 ? -1 : 1), a2 = (Math.random() * .5 + .1) * (Math.random() < .5 ? -1 : 1);
    const d = [[Math.cos(a1), Math.sin(a1)], [-Math.cos(a2), Math.sin(a2)]];
    const ang = Math.random() * 6.283, bow = (120 + Math.random() * 260) * (Math.random() < .5 ? -1 : 1);
    const V = [Math.cos(ang) * bow, Math.sin(ang) * bow];         // shared bow: both arc and still meet at M+V
    const S = (60 + Math.random() * 160) * (Math.random() < .5 ? -1 : 1); // S curve, opposite sign per rider, 0 at s = .5
    const miss = (forceMeet || Math.random() < MEET) ? 0 : (R * 1.5 + Math.random() * R * .9) * (Math.random() < .5 ? -1 : 1);
    path = { M, L, d, V, S, miss, s: 0 };
    hit = false;
    balls.forEach((b, n) => { b.free = false; place(b, n, 0); });
  }
  function at(n, s) {
    const p = path, k = Math.sin(Math.PI * s), k2 = Math.sin(2 * Math.PI * s) * (n ? -1 : 1), e = (2 * s - 1) * p.L, dn = p.d[n];
    return [p.M[0] + dn[0] * e + p.V[0] * k - dn[1] * p.S * k2,
      p.M[1] + dn[1] * e + p.V[1] * k + dn[0] * p.S * k2 + (n ? p.miss * Math.sin(Math.PI * Math.min(1, s * 1.4)) : 0)];
  }
  function place(b, n, s) {
    const q = at(n, s), r = at(n, s + .002);
    b.x = q[0]; b.y = q[1];
    b.vx = (r[0] - q[0]) / .002 / (2 * path.L) * SPEED; b.vy = (r[1] - q[1]) / .002 / (2 * path.L) * SPEED;
    const v = Math.hypot(b.vx, b.vy) || 1; b.vx *= SPEED / v; b.vy *= SPEED / v;
  }
  const out = b => b.x < -220 || b.x > W + 220 || b.y < -220 || b.y > H + 220;

  function step(dt) {
    boost += (1 - boost) * .05;
    const s = dt * boost;
    fade(dt);
    const sub = Math.max(1, Math.ceil(s * SPEED / 6)); // substeps: never tunnel through each other
    const A = balls[0], B = balls[1];
    for (let i = 0; i < sub; i++) {
      if (!hit) path.s += s / sub * SPEED / (2 * path.L);
      balls.forEach((b, n) => {
        if (!b.free) place(b, n, path.s);
        else { // after the impulse: free flight that keeps curving
          b.turn *= Math.pow(.55, s / sub);
          const w = b.turn * s / sub, c = Math.cos(w), sn = Math.sin(w), vx = b.vx * c - b.vy * sn;
          b.vy = b.vx * sn + b.vy * c; b.vx = vx;
          b.x += b.vx * s / sub; b.y += b.vy * s / sub;
        }
      });
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
      if (!hit && d < BR * 2 + 10) { A.free = B.free = true; A.turn = (Math.random() - .5) * 1.4; B.turn = (Math.random() - .5) * 1.4; collide(A, B, dx, dy, d); break; }
      if (!hit && path.s > 1.15) { A.free = B.free = true; A.turn = B.turn = 0; }
    }
  }
  function collide(A, B, dx, dy, d) { // elastic impulse, equal mass: swap the velocity components along the normal
    const nx = dx / d, ny = dy / d, va = A.vx * nx + A.vy * ny, vb = B.vx * nx + B.vy * ny, p = va - vb;
    if (p > 0) { A.vx -= p * nx; A.vy -= p * ny; B.vx += p * nx; B.vy += p * ny; }
    hit = true; boost = Math.max(boost, 1.15);
    const x = (A.x + B.x) / 2, y = (A.y + B.y) / 2;
    flash = { x, y, a: 1 };
    for (let i = 0; i < 2; i++) waves.push({ x, y, r: -i * 90, v: 520 - i * 100, a: (1 - i * .35) * .3 });
  }

  function fade(dt) {
    if (balls.every(out)) round();
    const maxR = Math.hypot(W, H);
    for (const w of waves) w.r += w.v * dt;
    while (waves.length && waves[0].r > maxR) waves.shift();
    if (flash) { flash.a -= dt * 2.2; if (flash.a <= 0) flash = null; }
    for (let k = 0; k < N; k++) { hb[k] *= .968; ho[k] *= .968; hw[k] *= .86; }
    // riders: only the dots inside their radius
    for (let n = 0; n < 2; n++) {
      const b = balls[n];
      const i0 = Math.max(0, Math.floor((b.x - R - ox) / GAP)), i1 = Math.min(cols - 1, Math.ceil((b.x + R - ox) / GAP));
      const j0 = Math.max(0, Math.floor((b.y - R - oy) / GAP)), j1 = Math.min(rows - 1, Math.ceil((b.y + R - oy) / GAP));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * cols + i, ex = px[k] - b.x, ey = py[k] - b.y, q = ex * ex + ey * ey;
        if (q < R * R) { const f = 1 - Math.sqrt(q) / R, a = f * f * .11; if (n) ho[k] = Math.min(1, ho[k] + a); else hb[k] = Math.min(1, hb[k] + a); }
      }
    }
    // mouse pointer
    if (mx > -1e3) {
      const i0 = Math.max(0, Math.floor((mx - 80 - ox) / GAP)), i1 = Math.min(cols - 1, Math.ceil((mx + 80 - ox) / GAP));
      const j0 = Math.max(0, Math.floor((my - 80 - oy) / GAP)), j1 = Math.min(rows - 1, Math.ceil((my + 80 - oy) / GAP));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * cols + i, mdx = px[k] - mx, mdy = py[k] - my, mq = mdx * mdx + mdy * mdy;
        if (mq < 6400) hw[k] = Math.max(hw[k], (1 - Math.sqrt(mq) / 80) * .2);
      }
    }
    // shock waves
    if (waves.length) for (let k = 0; k < N; k++) {
      for (const w of waves) {
        if (w.r < 0) continue;
        const rd = Math.abs(Math.hypot(px[k] - w.x, py[k] - w.y) - w.r);
        if (rd < 14) hw[k] = Math.max(hw[k], (1 - rd / 14) * w.a * (1 - w.r / maxR));
      }
    }
  }

  const buckets = Array.from({ length: HL * ML * WL }, () => []);
  function style(bi) {
    let s = styles[bi];
    if (s) return s;
    const wi = bi % WL, mi = Math.floor(bi / WL) % ML, hi = Math.floor(bi / (WL * ML));
    const h = (hi + .5) / HL, mo = mi / (ML - 1), w = wi / (WL - 1);
    const c = [0, 1, 2].map(j => Math.round((col.b[j] * (1 - mo) + col.o[j] * mo) * (1 - w) + col.w[j] * w));
    s = styles[bi] = { fill: `rgba(${c},${Math.min(.6, col.ba + h * .5)})`, r: DOT + h * 1.3 };
    return s;
  }

  function draw() {
    cx.clearRect(0, 0, W, H);
    cx.drawImage(base, 0, 0, W, H);
    const maxR = Math.hypot(W, H);
    for (const bk of buckets) bk.length = 0;
    for (let k = 0; k < N; k++) {
      const h = hb[k] + ho[k] + hw[k];
      if (h < .03) continue;
      let x = px[k], y = py[k];
      cx.clearRect(x - 1.5, y - 1.5, 3, 3); // remove the resting dot, it moves
      for (const b of balls) {
        const ex = x - b.x, ey = y - b.y, dd = Math.hypot(ex, ey) || 1;
        if (dd < R) { const u = dd / R, m = 6.75 * u * (1 - u) * (1 - u) * PUSH; x += ex / dd * m; y += ey / dd * m; } // lens: 0 at the centre, max at R/3
      }
      for (const w of waves) {
        if (w.r < 0) continue;
        const ex = px[k] - w.x, ey = py[k] - w.y, dd = Math.hypot(ex, ey) || 1, rd = dd - w.r;
        if (rd > -24 && rd < 24) { const f = Math.cos(rd / 24 * 1.5708) * w.a * (1 - w.r / maxR) * 3.5; x += ex / dd * f; y += ey / dd * f; }
      }
      const s = hb[k] + ho[k] || 1;
      const hi = Math.min(HL - 1, Math.floor(Math.min(1, h) * HL));
      const mi = Math.round(ho[k] / s * (ML - 1));
      const wi = Math.round(Math.min(1, hw[k] * 1.5) * (WL - 1));
      buckets[(hi * ML + mi) * WL + wi].push(x, y);
    }
    for (let bi = 0; bi < buckets.length; bi++) {
      const bk = buckets[bi];
      if (!bk.length) continue;
      const st = style(bi), r = st.r;
      cx.fillStyle = st.fill; cx.beginPath();
      for (let i = 0; i < bk.length; i += 2) cx.rect(bk[i] - r / 2, bk[i + 1] - r / 2, r, r);
      cx.fill();
    }
    if (flash) {
      const g = cx.createRadialGradient(flash.x, flash.y, 0, flash.x, flash.y, 320);
      g.addColorStop(0, `rgba(${col.w},${.07 * flash.a})`); g.addColorStop(1, `rgba(${col.w},0)`);
      cx.fillStyle = g; cx.fillRect(flash.x - 320, flash.y - 320, 640, 640);
    }
  }

  function still() { // reduced motion: freeze right after the meeting
    forceMeet = true; round(); forceMeet = false;
    for (let i = 0; i < 400 && !flash; i++) step(1 / 60);
    for (let i = 0; i < 12; i++) step(1 / 60);
    draw();
  }

  let last = performance.now(), run = !RM, slow = 0, frames = 0, raf = 0;
  function loop(now) {
    if (!run) return;
    const raw = (now - last) / 1000;
    last = now;
    step(Math.min(.04, raw)); draw();
    if (!degraded && raw < .5) { // too slow on a weak GPU: coarser grid and 1x pixels, once
      frames++; slow += raw;
      if (frames === 90) { if (slow / frames > 1 / 38) { degraded = true; GAP = 12; dprMax = 1; size(); round(); } frames = 0; slow = 0; }
    }
    raf = requestAnimationFrame(loop);
  }
  theme(); size();
  if (RM) still(); else { round(); raf = requestAnimationFrame(loop); }
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { size(); if (RM) still(); else round(); }, 120); });
  addEventListener('scroll', () => { const dy = Math.abs(scrollY - lastY); lastY = scrollY; boost = Math.min(3.5, boost + dy * .012); }, { passive: true });
  addEventListener('pointermove', e => { if (e.pointerType === 'mouse') { mx = e.clientX; my = e.clientY; } }, { passive: true });
  document.addEventListener('visibilitychange', () => { run = !document.hidden && !RM; cancelAnimationFrame(raf); if (run) { last = performance.now(); raf = requestAnimationFrame(loop); } });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { theme(); if (RM) draw(); });
  new MutationObserver(() => { theme(); if (RM) draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();

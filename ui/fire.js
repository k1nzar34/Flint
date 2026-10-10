"use strict";
/* Огонь Flint на canvas: огонёк в кнопке удаления и сгорание заметки.
 *  flame(canvas)        — живой огонёк; .set(0…1) — сила (как далеко дотянут ползунок), .flare() — вспышка, .stop();
 *  burnAway(el, {done}) — элемент прогорает неровным краем от правого нижнего угла: тонкая тлеющая кайма,
 *                         узкая обугленная полоса, искры, пепел и лёгкий дым.
 * Работает только в режиме анимации «Лава»; в «Простом» и «Выкл» — спокойное исчезновение.
 */
const FIRE = (() => {
  // «Выкл» в настройках анимации или системное «уменьшить движение» — огня нет; «Простой» — без частиц
  const live = () => typeof S === "undefined" || S.anim === "lava";
  const slow = 1;
  const rnd = (a, b) => a + Math.random() * (b - a);
  // цвет по «возрасту» частицы: белое ядро → жёлтый → оранжевый → тёмно-красный
  const STOPS = [[0, [255, 246, 214]], [.18, [255, 214, 92]], [.42, [255, 138, 31]], [.7, [214, 52, 34]], [1, [90, 18, 20]]];
  function col(t) {
    for (let i = 1; i < STOPS.length; i++) if (t <= STOPS[i][0]) {
      const [t0, a] = STOPS[i - 1], [t1, b] = STOPS[i], k = (t - t0) / (t1 - t0);
      return a.map((v, j) => Math.round(v + (b[j] - v) * k));
    }
    return STOPS[STOPS.length - 1][1];
  }

  /* --- огонёк на конце ползунка --- */
  function flame(canvas) {
    const dpr = Math.min(2, devicePixelRatio || 1), W = canvas.width, H = canvas.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    const g = canvas.getContext("2d");
    g.scale(dpr, dpr);
    const ps = [];
    let p = 0, target = 0, burst = 0, last = performance.now(), acc = 0, raf = 0, alive = true;
    const baseX = W / 2, baseY = H - 9;
    function spawn(n, power) {
      for (let i = 0; i < n; i++) {
        const spread = 2 + power * 3.5;
        ps.push({ x: baseX + rnd(-spread, spread), y: baseY + rnd(-1, 1), vx: rnd(-3, 3), vy: -rnd(30, 46) * (0.6 + power * .45),
          life: 0, max: rnd(.32, .52) * (0.8 + power * .3), r: rnd(2.2, 3.2) * (0.8 + power * .45), seed: Math.random() * 6.28 });
      }
    }
    function frame(now) {
      raf = 0;
      if (!alive) return;
      const dt = Math.min(.05, (now - last) / 1000) / slow;
      last = now;
      p += (target - p) * Math.min(1, dt * 10);  // огонь догоняет ползунок мягко, без скачков
      const power = Math.min(1.6, p + burst);
      // сколько частиц в секунду: от тихого тления до пламени
      acc += dt * (26 + power * 110);
      const n = Math.floor(acc); acc -= n;
      spawn(n, power);
      g.clearRect(0, 0, W, H);
      // тёплое свечение у основания
      const glow = g.createRadialGradient(baseX, baseY, 0, baseX, baseY, 7 + power * 9);
      glow.addColorStop(0, `rgba(255,150,40,${.14 + power * .3})`); glow.addColorStop(1, "rgba(255,90,20,0)");
      g.fillStyle = glow; g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = "lighter";
      for (let i = ps.length - 1; i >= 0; i--) {
        const q = ps[i];
        q.life += dt;
        const t = q.life / q.max;
        if (t >= 1) { ps.splice(i, 1); continue; }
        // язычки: к верху частицы стягиваются к центру и колышутся
        q.vx += (baseX - q.x) * 5 * dt + Math.sin(now / 140 + q.seed) * 26 * dt;
        q.vx *= 1 - dt * 2;
        q.x += q.vx * dt; q.y += q.vy * dt;
        q.vy *= 1 + dt * .25;
        const r = q.r * (1 - t * .6), [cr, cg, cb] = col(Math.min(1, t * 1.15)), a = (1 - t) * (t < .1 ? t / .1 : 1) * (.3 + Math.min(1, power) * .12);
        g.save(); g.translate(q.x, q.y); g.scale(1, 1.6);             // чуть вытянутые вверх пятна — язычки
        const grd = g.createRadialGradient(0, 0, 0, 0, 0, r * 2);
        grd.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`); grd.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        g.fillStyle = grd;
        g.beginPath(); g.arc(0, 0, r * 2, 0, 6.283); g.fill();
        g.restore();
      }
      g.globalCompositeOperation = "source-over";
      burst = Math.max(0, burst - dt * 1.4);
      raf = requestAnimationFrame(frame);
    }
    if (live()) raf = requestAnimationFrame(frame);
    return {
      set(v) { target = v; },
      flare() { burst = .8; spawn(14, 1.2); },
      stop() { alive = false; cancelAnimationFrame(raf); },
    };
  }

  /* --- шум для неровного края --- */
  function noiseField(w, h, scale = 1, seed = Math.random() * 1000) {
    const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7 + seed) * 43758.5453; return s - Math.floor(s); };
    const smooth = (t) => t * t * (3 - 2 * t);
    const vnoise = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = smooth(x - xi), yf = smooth(y - yi);
      const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
      return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
    };
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0, amp = .5, f = scale / 18;
      for (let o = 0; o < 4; o++) { v += vnoise(x * f, y * f) * amp; amp *= .5; f *= 2.1; }
      out[y * w + x] = v;
    }
    return out;
  }

  /* --- общий слой частиц: искры, пепел, дым --- */
  const fx = document.createElement("canvas");
  fx.className = "fx-layer";
  document.body.appendChild(fx);
  const fg = fx.getContext("2d");
  const parts = [];
  let fxRaf = 0, fxLast = 0;
  function fxResize() { const d = Math.min(2, devicePixelRatio || 1); fx.width = innerWidth * d; fx.height = innerHeight * d; fg.setTransform(d, 0, 0, d, 0, 0); }
  addEventListener("resize", fxResize); fxResize();
  function fxLoop(now) {
    const dt = Math.min(.05, (now - fxLast) / 1000) / slow; fxLast = now;
    fg.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i];
      q.life += dt;
      const t = q.life / q.max;
      if (t >= 1) { parts.splice(i, 1); continue; }
      q.vx += Math.sin(now / 300 + q.seed) * q.wob * dt; q.vy += q.g * dt;
      q.x += q.vx * dt; q.y += q.vy * dt; q.rot += q.vr * dt;
      if (q.kind === "spark") {
        fg.globalCompositeOperation = "lighter";
        const [r, g2, b] = col(Math.min(1, t * 1.1));
        fg.strokeStyle = `rgba(${r},${g2},${b},${(1 - t)})`; fg.lineWidth = q.r; fg.lineCap = "round";
        fg.beginPath(); fg.moveTo(q.x, q.y); fg.lineTo(q.x - q.vx * .03, q.y - q.vy * .03); fg.stroke();
      } else if (q.kind === "ash") {
        fg.globalCompositeOperation = "source-over";
        fg.save(); fg.translate(q.x, q.y); fg.rotate(q.rot);
        fg.fillStyle = `rgba(${q.shade},${q.shade - 6},${q.shade - 12},${(1 - t) * .9})`;
        fg.fillRect(-q.r, -q.r * .55, q.r * 2, q.r * 1.1);
        if (t < .25) { fg.fillStyle = `rgba(255,120,40,${(1 - t / .25) * .7})`; fg.fillRect(-q.r * .5, -q.r * .3, q.r, q.r * .6); }  // ещё тлеет
        fg.restore();
      } else {
        fg.globalCompositeOperation = "source-over";
        const R = q.r * (1 + t * 2.2), a = Math.sin(t * Math.PI) * .13;
        const grd = fg.createRadialGradient(q.x, q.y, 0, q.x, q.y, R);
        grd.addColorStop(0, `rgba(150,150,170,${a})`); grd.addColorStop(1, "rgba(150,150,170,0)");
        fg.fillStyle = grd; fg.beginPath(); fg.arc(q.x, q.y, R, 0, 6.283); fg.fill();
      }
    }
    fg.globalCompositeOperation = "source-over";
    fxRaf = parts.length ? requestAnimationFrame(fxLoop) : 0;
  }
  function emit(q) { parts.push({ life: 0, rot: 0, vr: 0, wob: 0, g: 0, seed: Math.random() * 6, ...q }); if (!fxRaf) { fxLast = performance.now(); fxRaf = requestAnimationFrame(fxLoop); } }
  const spark = (x, y) => emit({ kind: "spark", x, y, vx: rnd(-40, 40), vy: rnd(-180, -90), g: 120, wob: 60, r: rnd(1, 2.2), max: rnd(.5, 1.1) });
  const ash = (x, y) => emit({ kind: "ash", x, y, vx: rnd(-20, 20), vy: rnd(-50, -15), g: 38, wob: 40, vr: rnd(-4, 4), r: rnd(1.2, 2.8), max: rnd(1.1, 2), shade: Math.round(rnd(40, 70)) });
  const smoke = (x, y) => emit({ kind: "smoke", x, y, vx: rnd(-8, 8), vy: rnd(-40, -22), wob: 10, r: rnd(10, 18), max: rnd(1.4, 2.2) });

  /* --- сгорание элемента: маска неровным краем + кайма + частицы --- */
  function burnAway(el, { duration = 1300, done, particles = true } = {}) {
    if (!live()) { el.style.transition = "opacity .25s"; el.style.opacity = 0; return setTimeout(() => done && done(), 260); }
    const rect = el.getBoundingClientRect();
    const S = Math.max(2, Math.ceil(Math.sqrt(rect.width * rect.height / 24000)));  // маска в пониженном разрешении: край всё равно мягкий
    const w = Math.max(8, Math.ceil(rect.width / S)), h = Math.max(8, Math.ceil(rect.height / S));
    const noise = noiseField(w, h, S);
    // «время возгорания» каждой точки: от правого нижнего угла с неровным краем
    const ign = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (w - x) / w, dy = (h - y) / h;
      ign[y * w + x] = Math.hypot(dx * .9, dy * 1.1) / 1.42 * .8 + noise[y * w + x] * .26;
    }
    const mask = document.createElement("canvas"); mask.width = w; mask.height = h;
    const mg = mask.getContext("2d"), mimg = mg.createImageData(w, h);
    const over = document.createElement("canvas"); over.width = w; over.height = h;
    Object.assign(over.style, { position: "absolute", inset: "-1px", width: "calc(100% + 2px)", height: "calc(100% + 2px)", pointerEvents: "none", borderRadius: "inherit", filter: `blur(${(S * .3).toFixed(1)}px)` });
    const og = over.getContext("2d"), oimg = og.createImageData(w, h);
    el.style.position ||= "relative";
    el.appendChild(over);
    const t0 = performance.now();
    let lastMask = 0;
    function step(now) {
      const k = Math.min(1.12, (now - t0) / (duration * slow)) * 1.08;   // фронт огня
      const RIM = .012, CHAR = .045, SOFT = .01;   // тонкая тлеющая кайма и узкая обугленная полоса
      for (let i = 0; i < w * h; i++) {
        const d = ign[i] - k, j = i * 4;
        // маска: сгоревшее — прозрачно
        mimg.data[j + 3] = d < -SOFT ? 0 : d < 0 ? Math.round((d + SOFT) / SOFT * 255) : 255;
        // кайма и обугливание поверх ещё целой бумаги
        let r = 0, g2 = 0, b = 0, a = 0;
        if (d >= -SOFT && d < RIM) { const q = (d + SOFT) / (RIM + SOFT); [r, g2, b] = col(.1 + q * .55); a = 255 * Math.sin(Math.min(1, q * 1.4) * Math.PI * .5 + .3); }
        else if (d >= RIM && d < CHAR) { const q = (d - RIM) / (CHAR - RIM); r = 36; g2 = 14; b = 10; a = 190 * (1 - q) * (1 - q); }
        oimg.data[j] = r; oimg.data[j + 1] = g2; oimg.data[j + 2] = b; oimg.data[j + 3] = a;
      }
      og.putImageData(oimg, 0, 0);
      if (now - lastMask > 30) {  // маску обновляем ~30 раз в секунду — этого хватает глазу
        mg.putImageData(mimg, 0, 0);
        const url = mask.toDataURL();
        el.style.webkitMaskImage = el.style.maskImage = `url(${url})`;
        el.style.webkitMaskSize = el.style.maskSize = "100% 100%";
        lastMask = now;
      }
      // частицы с кромки: искры, пепел, иногда дымок
      for (let n = 0; n < (particles ? 3 : 0); n++) {
        const i = (Math.random() * w * h) | 0, d = ign[i] - k;
        if (d < 0 || d > RIM) continue;
        const x = rect.left + (i % w) * S, y = rect.top + ((i / w) | 0) * S;
        const roll = Math.random();
        if (roll < .45) spark(x, y); else if (roll < .9) ash(x, y); else smoke(x, y);
      }
      if (k < 1.12) requestAnimationFrame(step);
      else { over.remove(); el.style.opacity = 0; done && done(); }
    }
    requestAnimationFrame(step);
  }

  return { flame, burnAway, spark };
})();

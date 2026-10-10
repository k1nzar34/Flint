"use strict";
/* Анимации Flint.
 *  pour()  — подсветка «переливается из стакана»: старая плитка выливается, струйка дугой
 *            бежит к новой, новая наполняется снизу вверх с волной (меню и календари).
 *  slide() — короткое перетекание лавы в переключателях-«таблетках».
 *  press   — нажатие: кнопка проседает, от точки клика идёт тёплая волна;
 *            у главных действий ещё и искры.
 *  theme() — смена темы круговым раскрытием от кнопки.
 * Всё зависит от S.anim ("lava" / "plain" / "off") и S.speed (мс) — их выставляет app.js.
 */
const FX = (() => {
  const SVGNS = "http://www.w3.org/2000/svg";
  const on = () => S.anim !== "off";
  const isLava = () => S.anim === "lava";
  const jsAnims = (el) => el.getAnimations({ subtree: true }).filter((a) => !(window.CSSAnimation && a instanceof CSSAnimation));

  function centerIn(el, box) {
    const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    return { x: a.left - b.left + a.width / 2, y: a.top - b.top + a.height / 2, w: a.width, h: a.height, bottom: a.bottom - b.top };
  }

  // уровень жидкости: маска-волна едет по X (бежит волна) и по Y (меняется уровень)
  function level(el, from, to, dur, delay, easing) {
    el.classList.add("wavy");
    return el.animate([
      { maskPosition: `0px ${from}%`, webkitMaskPosition: `0px ${from}%` },
      { maskPosition: `112px ${to}%`, webkitMaskPosition: `112px ${to}%` },
    ], { duration: dur, delay, easing, fill: "both" });
  }

  function liquid(cls) {
    const el = document.createElement("i");
    el.className = cls + (isLava() ? " lava" : " plain");
    el.innerHTML = '<i class="lv"></i>';
    return el;
  }

  /* ---------- Переливание из стакана ---------- */
  function pour(box, src, dst, { fadeOut = false } = {}) {
    if (!on() || !box || !src || !dst || src === dst) return;
    box.querySelectorAll(".fx-ghost, .fx-fill, .fx-stream").forEach((e) => e.remove());
    const a = centerIn(src, box), b = centerIn(dst, box);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist < 2) return;
    const D = S.speed * (1.5 + Math.min(dist, 400) / 500);
    box.classList.add("pouring");
    const mini = box.classList.contains("mini");
    const srcBday = mini && src.classList.contains("bday"), dstBday = mini && dst.classList.contains("bday");

    // 1) старая плитка выливается; у ДР золото остаётся, а фиолетовое кольцо сворачивается
    if (srcBday) {
      const ring = document.createElement("i");
      ring.className = "ring-out";
      src.appendChild(ring);
      ring.animate([{ "--ra": "360deg" }, { "--ra": "0deg" }], { duration: D * .45, easing: "cubic-bezier(.6,0,.8,.4)", fill: "forwards" })
        .onfinish = () => ring.remove();
    } else {
      const ghost = liquid("fx-ghost");
      src.appendChild(ghost);
      level(ghost, 104, -8, D * .55, 0, "cubic-bezier(.5,0,.6,1)").onfinish = () => ghost.remove();
    }

    // 2) струйка дугой
    const ux = (b.x - a.x) / dist, uy = (b.y - a.y) / dist;
    let nx = -uy, ny = ux;
    if (Math.abs(ny) < .05) { nx = 1; ny = 0; } else if (ny > 0) { nx = -nx; ny = -ny; }
    const k = Math.min(44, dist * .28);
    const cx = (a.x + b.x) / 2 + nx * k, cy = (a.y + b.y) / 2 + ny * k;
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "fx-stream" + (isLava() ? "" : " plain"));
    svg.setAttribute("width", box.scrollWidth); svg.setAttribute("height", box.scrollHeight);
    const gid = "fxg" + Math.random().toString(36).slice(2, 8);
    svg.innerHTML = `<defs><linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}">
      ${isLava() ? '<stop offset="0" stop-color="#FFD24D"/><stop offset=".5" stop-color="#FF6A1F"/><stop offset="1" stop-color="#FF3D2E"/>'
                 : '<stop offset="0" stop-color="#4F6DFF"/><stop offset="1" stop-color="#7B5CFF"/>'}
      </linearGradient></defs><path d="M${a.x} ${a.y} Q${cx} ${cy} ${b.x} ${b.y}" stroke="url(#${gid})" stroke-width="6"/>`;
    box.appendChild(svg);
    const path = svg.querySelector("path"), L = path.getTotalLength();
    path.style.strokeDasharray = L;
    path.animate([
      { strokeDashoffset: L, strokeWidth: 3 },
      { strokeDashoffset: 0, strokeWidth: 6, offset: .4 },
      { strokeDashoffset: 0, strokeWidth: 5, offset: .6 },
      { strokeDashoffset: -L, strokeWidth: 2 },
    ], { duration: D * .7, delay: D * .08, easing: "ease-in-out", fill: "both" }).onfinish = () => svg.remove();

    // 3) в день рождения лава не льётся — вокруг золота прорисовывается кольцо
    if (dstBday) {
      dst.style.setProperty("--rd", Math.round(D * .42) + "ms");
      dst.classList.add("ring-in");
      setTimeout(() => { box.classList.remove("pouring"); dst.classList.remove("ring-in"); }, D * .42 + 1100);
      if (isLava()) sparks(box, b.x, b.bottom - b.h * .25, D * .42, 6);
      return;
    }
    // 3) новая плитка наполняется снизу вверх, потом лава остывает
    const fill = liquid("fx-fill");
    dst.appendChild(fill);
    const lv = fill.firstElementChild;
    level(fill, -8, 104, D * .6, D * .34, "cubic-bezier(.3,.2,.4,1)").onfinish = () => {
      fill.classList.remove("wavy");
      const cool = Math.max(380, D * .7);
      if (isLava()) lv.animate([{ opacity: 1 }, { opacity: 1, offset: .25 }, { opacity: 0 }], { duration: cool, easing: "ease-in", fill: "forwards" });
      dst.animate([{ transform: "scale(1,1)" }, { transform: "scale(1.05,.95)", offset: .35 }, { transform: "scale(.99,1.02)", offset: .7 }, { transform: "scale(1,1)" }],
        { duration: 420, easing: "ease-out" });
      const end = () => { fill.remove(); box.classList.remove("pouring"); };
      if (fadeOut) fill.animate([{ opacity: 1 }, { opacity: 1, offset: .5 }, { opacity: 0 }], { duration: cool + 200, fill: "forwards" }).onfinish = end;
      else setTimeout(end, cool);
    };
    if (isLava()) sparks(box, b.x, b.bottom - b.h * .25, D * .42, 6);
  }

  /* ---------- Искры ---------- */
  function sparks(host, x, y, delay = 0, n = 5, fixed = false) {
    if (!isLava()) return;
    setTimeout(() => {
      for (let i = 0; i < n; i++) {
        const sp = document.createElement("span");
        sp.className = "fx-spark" + (fixed ? " fixed" : "");
        Object.assign(sp.style, { left: x - 3 + "px", top: y - 3 + "px" });
        host.appendChild(sp);
        const ang = (-160 + i * (140 / Math.max(1, n - 1)) + (Math.random() * 14 - 7)) * Math.PI / 180;
        const len = 16 + Math.random() * 16, ux = Math.cos(ang) * len, uy = Math.sin(ang) * len;
        sp.animate([
          { transform: "translate(0,0) scale(.5)", opacity: 1 },
          { transform: `translate(${ux}px, ${uy}px) scale(1)`, opacity: 1, offset: .5 },
          { transform: `translate(${ux * 1.2}px, ${uy * .3 + 14}px) scale(.3)`, opacity: 0 },
        ], { duration: 520, easing: "cubic-bezier(.2,.7,.4,1)" }).onfinish = () => sp.remove();
      }
    }, delay);
  }

  /* ---------- Перетекание в переключателях ---------- */
  let pending = null;
  function captureSeg(btn) {
    const seg = btn.closest(".seg");
    const cur = seg && seg.querySelector("button.on");
    pending = cur && cur !== btn && on() ? { act: btn.dataset.act, rect: cur.getBoundingClientRect() } : null;
  }
  function playSeg() {
    if (!pending) return;
    const { act, rect } = pending;
    pending = null;
    const btn = document.querySelector(`.seg button.on[data-act="${act}"]`);
    if (!btn) return;
    const seg = btn.closest(".seg"), sb = seg.getBoundingClientRect(), nb = btn.getBoundingClientRect();
    seg.querySelectorAll(".fx-pill").forEach((p) => p.remove());
    const pill = liquid("fx-pill");
    seg.appendChild(pill);
    const from = { left: rect.left - sb.left + "px", top: rect.top - sb.top + "px", width: rect.width + "px", height: rect.height + "px" };
    const to = { left: nb.left - sb.left + "px", top: nb.top - sb.top + "px", width: nb.width + "px", height: nb.height + "px" };
    Object.assign(pill.style, to);
    const D = S.speed * .75;
    seg.classList.add("sliding");
    // передний край убегает вперёд, задний догоняет — как жидкость
    const fwd = nb.left >= rect.left;
    const mid = {
      left: (fwd ? rect.left : nb.left) - sb.left + "px", top: Math.min(rect.top, nb.top) - sb.top + "px",
      width: Math.max(rect.right, nb.right) - Math.min(rect.left, nb.left) + "px", height: nb.height + "px", offset: .5,
    };
    pill.animate([from, mid, to], { duration: D, easing: "cubic-bezier(.6,0,.3,1)" }).onfinish = () => {
      pill.remove(); seg.classList.remove("sliding");
    };
    if (isLava()) pill.firstElementChild.animate([{ opacity: 0 }, { opacity: 1, offset: .2 }, { opacity: 1, offset: .65 }, { opacity: 0 }], { duration: D, fill: "forwards" });
  }

  /* ---------- Нажатие: волна и искры ---------- */
  const PRESS = ".btn, .nav button, .seg button, .fchip, .icon-btn, .side-actions button, .presets button, .mbtn, .mt, .ck, .checkrow, .summary, .vac-banner";
  const SPARKY = ".btn-primary, .check";
  document.addEventListener("pointerdown", (e) => {
    if (!on() || e.button !== 0) return;
    const btn = e.target.closest(PRESS);
    if (btn) {
      const r = btn.getBoundingClientRect(), size = Math.max(r.width, r.height) * 2.2;
      const w = document.createElement("span");
      w.className = "fx-ripple" + (isLava() ? "" : " plain");
      Object.assign(w.style, { width: size + "px", height: size + "px", left: e.clientX - r.left - size / 2 + "px", top: e.clientY - r.top - size / 2 + "px" });
      btn.appendChild(w);
      w.animate([{ transform: "scale(.1)", opacity: 1 }, { transform: "scale(1)", opacity: 0 }], { duration: 620, easing: "ease-out" }).onfinish = () => w.remove();
    }
    const sp = e.target.closest(SPARKY);
    if (sp && !(sp.classList.contains("check") && sp.closest(".item.done"))) sparks(document.body, e.clientX, e.clientY, 0, 5, true);
  }, true);

  /* ---------- Смена темы: страница «сгорает» от кнопки ---------- */
  let burning = false;
  async function theme(fromEl, change) {
    if (burning) return; // повторный клик посреди перехода ломал его — игнорируем
    if (!on() || !document.startViewTransition || !fromEl) { await change(); return titlebar(); }
    burning = true;
    try { await burnTheme(fromEl, change); } finally { burning = false; titlebar(); }
  }
  // цвет заголовка окна Windows меняем уже после перехода: перерисовка рамки посреди анимации давала вспышку
  const titlebar = () => window.pywebview?.api?.titlebar?.();
  async function burnTheme(fromEl, change) {
    const r = fromEl.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 40;
    const dur = Math.max(1400, S.speed * 3.1);
    const ease = "cubic-bezier(.5,.05,.45,.95)";
    let burn = null;
    const t = document.startViewTransition(async () => {
      await change();
      if (isLava()) {
        burn = document.createElement("div");
        burn.className = "fx-burn";
        burn.style.setProperty("--x", x + "px");
        burn.style.setProperty("--y", y + "px");
        document.body.appendChild(burn);
      }
    });
    t.finished.finally(() => burn && burn.remove());
    try { await t.ready; } catch { return; }
    document.documentElement.animate({ clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
      { duration: dur, easing: ease, pseudoElement: "::view-transition-new(root)" });
    if (!burn) return t.finished.catch(() => {});
    const front = burn.animate([{ "--br": "0px" }, { "--br": end + "px" }], { duration: dur, easing: ease, fill: "forwards" });
    // угольки отрываются от горящего края
    const t0 = performance.now();
    const tick = () => {
      const p = (performance.now() - t0) / dur;
      if (p >= 1 || !burn.isConnected) return;
      const rad = parseFloat(getComputedStyle(burn).getPropertyValue("--br")) || 0;
      for (let i = 0; i < 4; i++) {
        const a = Math.random() * Math.PI * 2, ex = x + Math.cos(a) * rad, ey = y + Math.sin(a) * rad;
        if (ex < -10 || ey < -10 || ex > innerWidth + 10 || ey > innerHeight + 10) continue;
        const e = document.createElement("i");
        e.className = "fx-cinder";
        Object.assign(e.style, { left: ex + 40 + "px", top: ey + 40 + "px" });
        burn.appendChild(e);
        const ox = Math.cos(a) * (10 + Math.random() * 20), oy = Math.sin(a) * (10 + Math.random() * 20) - 18 - Math.random() * 22;
        e.animate([{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: `translate(${ox}px, ${oy}px) scale(.35)`, opacity: 0 }],
          { duration: 500 + Math.random() * 400, easing: "ease-out" }).onfinish = () => e.remove();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await front.finished.catch(() => {});
    await t.finished.catch(() => {});
  }

  /* ---------- Салют при добавлении дня рождения ---------- */
  function salute() {
    if (!on()) return;
    const layer = document.createElement("div");
    layer.className = "fx-salute";
    document.body.appendChild(layer);
    const PAL = [["#FFD978", "#F5C451"], ["#FF8CC6", "#FF5C8A"], ["#7DD3FC", "#5E6BFF"], ["#86EFAC", "#35D49A"], ["#FDBA74", "#FF7A1A"]];
    const W = innerWidth, H = innerHeight, shots = 4;
    let left = shots;
    for (let k = 0; k < shots; k++) {
      const x = W * (0.2 + 0.6 * ((k * 0.37 + Math.random() * 0.25) % 1)), y = H * (0.16 + Math.random() * 0.22);
      const [c1, c2] = PAL[(k + Math.floor(Math.random() * 5)) % 5];
      setTimeout(() => {
        const rocket = document.createElement("i");
        rocket.className = "fx-rocket";
        rocket.style.setProperty("--c", c1);
        layer.appendChild(rocket);
        rocket.animate([{ transform: `translate(${x}px, ${H + 10}px) scaleY(2.2)`, opacity: 1 },
          { transform: `translate(${x}px, ${y}px) scaleY(1)`, opacity: 1 }], { duration: 620, easing: "cubic-bezier(.2,.6,.35,1)" })
          .onfinish = () => {
            rocket.remove();
            const flash = document.createElement("i");
            flash.className = "fx-flash";
            Object.assign(flash.style, { left: x + "px", top: y + "px" });
            flash.style.setProperty("--c", c1);
            layer.appendChild(flash);
            flash.animate([{ transform: "translate(-50%,-50%) scale(.2)", opacity: .9 }, { transform: "translate(-50%,-50%) scale(1.6)", opacity: 0 }],
              { duration: 520, easing: "ease-out" }).onfinish = () => flash.remove();
            const N = 30, R = 80 + Math.random() * 50;
            let alive = N;
            for (let i = 0; i < N; i++) {
              const a = (i / N) * Math.PI * 2 + Math.random() * 0.2, r = R * (0.75 + Math.random() * 0.35);
              const dx = Math.cos(a) * r, dy = Math.sin(a) * r;
              const p = document.createElement("i");
              p.className = "fx-spark-s";
              p.style.setProperty("--c", i % 3 ? c1 : c2);
              Object.assign(p.style, { left: x + "px", top: y + "px" });
              layer.appendChild(p);
              p.animate([
                { transform: "translate(-50%,-50%) scale(1)", opacity: 1 },
                { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1)`, opacity: 1, offset: .45 },
                { transform: `translate(calc(-50% + ${dx * 1.1}px), calc(-50% + ${dy + 70}px)) scale(.3)`, opacity: 0 },
              ], { duration: 1300 + Math.random() * 400, easing: "cubic-bezier(.15,.7,.35,1)" }).onfinish = () => {
                p.remove();
                if (--alive === 0 && --left === 0) layer.remove();
              };
            }
          };
      }, k * 260 + Math.random() * 120);
    }
  }

  /* ---------- Кораблик по дальней волне отпуска ---------- */
  // Кораблик живёт внутри каждой плитки отпуска (между дальней и ближней волной) и обрезается её краями,
  // поэтому плывёт «в море» плиток, а не поверх промежутков. Все копии двигаются по одному общему пути.
  const boatObs = new WeakMap();
  function boats(grid) {
    if (!grid || !on()) return;
    build(grid);
    if (!boatObs.has(grid) && window.ResizeObserver) {
      let w = grid.offsetWidth, timer = 0;
      const ro = new ResizeObserver(() => {
        if (!grid.isConnected) return ro.disconnect();
        if (grid.offsetWidth === w) return;
        w = grid.offsetWidth;
        clearTimeout(timer);
        timer = setTimeout(() => build(grid), 120);
      });
      ro.observe(grid);
      boatObs.set(grid, ro);
    }
  }
  function build(grid) {
    grid.querySelectorAll(".boat").forEach((b) => b.remove());
    if (!on()) return;
    const ids = [...new Set([...grid.querySelectorAll(".cell[data-vac]")].map((c) => c.dataset.vac))];
    const gb = grid.getBoundingClientRect();
    ids.forEach((id) => {
      const cells = [...grid.querySelectorAll(`.cell[data-vac="${id}"]`)].map((el) => {
        const r = el.getBoundingClientRect();
        return { el, top: Math.round(r.top), left: r.left - gb.left, right: r.right - gb.left };
      });
      // строки календаря: сегменты по одной неделе
      const rows = [];
      cells.forEach((c) => {
        const row = rows.find((x) => x.top === c.top);
        if (row) { row.left = Math.min(row.left, c.left); row.right = Math.max(row.right, c.right); }
        else rows.push({ top: c.top, left: c.left, right: c.right });
      });
      rows.sort((a, b) => a.top - b.top);
      const BW = 27, SPEED = 30, FADE = 0.45; // ширина, px/с, с
      const segs = rows.map((r) => ({ top: r.top, x1: r.left + 6, x2: r.right - BW - 6 })).filter((g) => g.x2 > g.x1);
      if (!segs.length) return;
      const durs = segs.map((g) => (g.x2 - g.x1) / SPEED + FADE * 2);
      const total = durs.reduce((a, b) => a + b, 0);
      const phase = performance.now() % (total * 1000); // плывёт дальше, а не с начала, после перерисовки
      cells.forEach((c) => {
        const sea = c.el.querySelector(".sea");
        if (!sea) return;
        const kf = [];
        let t = 0;
        segs.forEach((g, i) => {
          const d = durs[i], at = (sec) => Math.min(1, (t + sec) / total), mine = g.top === c.top;
          const fadeLen = Math.min(SPEED * FADE, (g.x2 - g.x1) / 3);
          const pts = [[0, 0, g.x1], [FADE, 1, g.x1 + fadeLen], [d - FADE, 1, g.x2 - fadeLen], [d, 0, g.x2]];
          pts.forEach(([sec, op, x]) => kf.push({ offset: at(sec), opacity: mine ? op : 0,
            transform: `translateX(${(mine ? x : g.x1) - c.left}px)` }));
          t += d;
        });
        kf[0].offset = 0; kf[kf.length - 1].offset = 1;
        const boat = document.createElement("span");
        boat.className = "boat";
        boat.innerHTML = '<svg viewBox="0 0 26 22"><use href="#boat"/></svg>';
        sea.insertBefore(boat, sea.lastElementChild); // между дальней и ближней волной
        const anim = boat.animate(kf, { duration: total * 1000, iterations: Infinity, easing: "linear" });
        anim.currentTime = phase;
        if (S.live === false) anim.pause(); // «живые картинки» выключены — кораблик замирает
      });
    });
  }

  /* ---------- Смена типа записи в окне ---------- */
  const KIND_COLOR = { reminder: "#7B6BFF", birthday: "#F5C451", vacation: "#38BDF8" };
  const ACCENTS = [".modal-head .dateblock", ".modal-actions .btn-primary", "#edPresets button"];

  function kindSwitch(next, apply) {
    const modal = document.querySelector(".modal");
    if (!on()) return apply();
    const tabs = document.querySelector("#edKinds"), oldTab = tabs.querySelector("button.on");
    const tabRect = oldTab.getBoundingClientRect(), tabBg = getComputedStyle(oldTab).backgroundImage;
    const oldH = modal.offsetHeight;
    const shownBefore = new Set([...modal.querySelectorAll("[data-kinds]")].filter((f) => !f.hidden));
    const before = ACCENTS.map((sel) => [...modal.querySelectorAll(sel)].map((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundImage, color: cs.backgroundColor };
    }));

    apply();

    const D = Math.max(420, S.speed);
    // 1) окно плавно меняет высоту, новые поля мягко проявляются
    const newH = modal.offsetHeight;
    if (Math.abs(newH - oldH) > 1) {
      modal.style.overflow = "hidden";
      modal.animate([{ height: oldH + "px" }, { height: newH + "px" }], { duration: D, easing: "cubic-bezier(.3,.1,.2,1)" })
        .onfinish = () => (modal.style.overflow = "");
    }
    modal.querySelectorAll("[data-kinds]").forEach((f) => {
      if (!f.hidden && !shownBefore.has(f)) {
        f.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
          { duration: D * .8, delay: D * .25, easing: "ease-out", fill: "backwards" });
      }
    });

    // 2) вкладка перетекает прямо из своего цвета в цвет новой
    const newTab = tabs.querySelector("button.on"), tb = tabs.getBoundingClientRect(), nb = newTab.getBoundingClientRect();
    tabs.querySelectorAll(".fx-tab").forEach((p) => p.remove());
    const pill = document.createElement("i");
    pill.className = "fx-tab";
    pill.style.backgroundImage = tabBg;
    pill.innerHTML = `<i style="background-image:${getComputedStyle(newTab).backgroundImage}"></i>`;
    tabs.appendChild(pill);
    tabs.classList.add("sliding");
    const geo = (r) => ({ left: r.left - tb.left + "px", top: r.top - tb.top + "px", width: r.width + "px", height: r.height + "px" });
    pill.animate([geo(tabRect), geo(nb)], { duration: D * .8, easing: "cubic-bezier(.6,0,.25,1)" }).onfinish = () => {
      pill.remove(); tabs.classList.remove("sliding");
    };
    pill.firstElementChild.animate([{ opacity: 0 }, { opacity: 1 }], { duration: D * .8, easing: "ease-in-out", fill: "forwards" });

    // 3) подсвеченные кнопки: из центра — вспышка, пламя новой вкладки перекрашивает их
    const kc = KIND_COLOR[next];
    ACCENTS.forEach((sel, i) => {
      [...modal.querySelectorAll(sel)].forEach((el, j) => {
        const old = before[i][j];
        if (!old || el.offsetParent === null) return;
        const cur = getComputedStyle(el);
        if (old.bg === cur.backgroundImage && old.color === cur.backgroundColor) return;
        const veil = document.createElement("i");
        veil.className = "fx-burst";
        veil.style.backgroundImage = old.bg;
        veil.style.backgroundColor = old.color;
        const ring = document.createElement("i");
        ring.className = "fx-burst-ring";
        ring.style.setProperty("--kc", kc);
        el.append(veil, ring);
        const delay = 60 + i * 50 + j * 25;
        const opts = { duration: D * 1.6, delay, easing: "cubic-bezier(.2,.6,.3,1)", fill: "both" };
        veil.animate([{ "--r": "0%" }, { "--r": "160%" }], opts).onfinish = () => veil.remove();
        ring.animate([{ "--r": "0%", opacity: 1 }, { "--r": "150%", opacity: .9, offset: .8 }, { "--r": "170%", opacity: 0 }], opts)
          .onfinish = () => ring.remove();
        const r = el.getBoundingClientRect();
        if (r.width > 40) embers(r.left + r.width / 2, r.top + r.height / 2, kc, delay, Math.min(7, Math.round(r.width / 40) + 3));
      });
    });
  }

  // язычки пламени / брызги цвета вкладки
  function embers(x, y, color, delay, n) {
    setTimeout(() => {
      for (let i = 0; i < n; i++) {
        const e = document.createElement("span");
        e.className = "fx-ember";
        e.style.setProperty("--kc", color);
        Object.assign(e.style, { left: x - 3 + "px", top: y - 3 + "px" });
        document.body.appendChild(e);
        const ang = Math.random() * Math.PI * 2, len = 18 + Math.random() * 26;
        const ux = Math.cos(ang) * len, uy = Math.sin(ang) * len * .6 - 10;
        e.animate([
          { transform: "translate(0,0) scale(.4)", opacity: 1 },
          { transform: `translate(${ux}px, ${uy}px) scale(1)`, opacity: .95, offset: .45 },
          { transform: `translate(${ux * 1.2}px, ${uy - 14}px) scale(.2)`, opacity: 0 },
        ], { duration: 560 + Math.random() * 200, easing: "cubic-bezier(.2,.7,.4,1)" }).onfinish = () => e.remove();
      }
    }, delay);
  }

  return { pour, sparks, embers, captureSeg, playSeg, theme, jsAnims, boats, kindSwitch, salute };
})();

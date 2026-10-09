"use strict";

/* ===================== Связь с Python ===================== */
const DEV = new URLSearchParams(location.search).has("dev");
const ready = new Promise((resolve) => {
  if (DEV || (window.pywebview && window.pywebview.api)) return resolve();
  window.addEventListener("pywebviewready", resolve, { once: true });
});
async function api(name, ...args) {
  await ready;
  if (!DEV) return window.pywebview.api[name](...args);
  const res = await fetch("/api/" + name, { method: "POST", body: JSON.stringify(args) });
  return res.json();
}

/* ===================== Справочники ===================== */
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const WD_FULL = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
const CAT_COLORS = { work: "#4C8DFF", health: "#2ECDB5", personal: "#FF5C8A", home: "#3DD68C", growth: "#A27BFF" };
const IMPORTANT = "#FF7A1A"; // приоритет — «огонёк»
const TIME_PRESETS = ["06:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"];
const PAGES = {
  home: null,
  calendar: ["Календарь", "Планируй дни и недели наперёд"],
  all: ["Все напоминания", "Всё, что впереди, в одном списке"],
  stats: ["Статистика", "Твои результаты и привычки"],
  settings: ["Настройки", "Сделай приложение под себя"],
};

const S = {
  page: "home", today: null, selected: null, view: null,
  allRange: "week", allCat: "", statsPeriod: "week",
  settings: {}, categories: {}, repeats: {}, canAutostart: false, todayItems: [],
  ed: null, ctx: null, mp: null, slide: 0, anim: "lava", speed: 450, justDone: null,
};

/* ===================== Утилиты ===================== */
const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a, b) => iso(a) === iso(b);
const wdIndex = (d) => (d.getDay() + 6) % 7;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (id) => `<svg class="i"><use href="#${id}"/></svg>`;
const fireBg = () => `<span class="flame" aria-hidden="true"><svg viewBox="0 0 32 40"><use href="#fire-bg"/></svg></span>`;

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}
const remindersWord = (n) => `${n} ${plural(n, "напоминание", "напоминания", "напоминаний")}`;
const fullDate = (d) => `${WD_FULL[wdIndex(d)]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
function relDay(d) {
  const diff = Math.round((d - S.today) / 864e5);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Завтра";
  if (diff === -1) return "Вчера";
  return `${WD[wdIndex(d)]}, ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}
function dayTitle(d) {
  const r = relDay(d);
  return ["Сегодня", "Завтра", "Вчера"].includes(r) ? `${r}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}` : fullDate(d);
}

function toast(text) {
  const t = $("#toast");
  t.querySelector("span").textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
}

/* ===================== Фразы с учётом обращения ===================== */
// g — обращение из настроек: m (мужское), f (женское), n (нейтральное)
const PHRASES = {
  autoOn: { m: "Напоминания придут, даже если ты не открывал Flint", f: "Напоминания придут, даже если ты не открывала Flint",
    n: "Напоминания придут, даже если Flint не открывали" },
  autoOff: { m: "пока сам не откроешь Flint", f: "пока сама не откроешь Flint", n: "пока Flint снова не откроют" },
  hello: { m: "Привет, друг 👋", f: "Привет, подруга 👋", n: "Привет 👋" },
  cheer: { m: "Ты справишься!", f: "Ты справишься!", n: "Всё получится!" },
  allDone: { m: (w) => `Ты всё сделал (${w}). Отличный день!`, f: (w) => `Ты всё сделала (${w}). Отличный день!`,
    n: (w) => `На сегодня всё сделано (${w}). Отличный день!` },
  allDoneShort: { m: "Всё сделано — красавчик", f: "Всё сделано — красотка", n: "Всё сделано — так держать" },
  doneToast: { m: "Готово! Ты молодец", f: "Готово! Ты молодец", n: "Отмечено как выполненное" },
  ready: { m: "Готов к новому дню?", f: "Готова к новому дню?", n: "Новый день — новые дела" },
};
function phrase(key, ...args) {
  const g = ["m", "f", "n"].includes(S.settings.gender) ? S.settings.gender : "m";
  const p = PHRASES[key][g];
  return typeof p === "function" ? p(...args) : p;
}

/* ===================== Компоненты ===================== */
function tagsHtml(it) {
  const tags = [];
  if (it.category) {
    tags.push(`<span class="tag" style="--c:${CAT_COLORS[it.category]}">${icon("cat-" + it.category)}${esc(S.categories[it.category])}</span>`);
  }
  if (it.important) tags.push(`<span class="tag" style="--c:${IMPORTANT}">${icon("flame")}Приоритет</span>`);
  if (it.repeat && it.repeat !== "none") tags.push(`<span class="tag plain">${icon("repeat")}${esc(S.repeats[it.repeat])}</span>`);
  return tags.length ? `<div class="tags">${tags.join("")}</div>` : "";
}

function dateBlock(d) {
  const today = sameDay(d, S.today) ? " today" : "";
  return `<div class="dateblock${today}"><b>${d.getDate()}</b><small>${MONTHS_SHORT[d.getMonth()]}</small></div>`;
}

function ageText(it) {
  if (!it.age) return "День рождения";
  return it.date === iso(S.today) ? `Сегодня исполняется ${it.age} 🎉` : `Исполнится ${it.age}`;
}

/* ---------- Торт, выглядывающий снизу карточки ДР ---------- */
const SPRINKLES = [[40, 38, 20], [58, 32, -30], [70, 48, 60], [150, 33, -15], [168, 44, 35], [186, 37, -50], [100, 54, 10], [126, 28, 80],
  [150, 52, -40], [52, 48, 0], [176, 30, 15], [122, 55, -70], [84, 30, 40], [30, 44, -20], [196, 42, 70], [140, 42, 5]];
const SPR_COLORS = ["#FF4F8B", "#38BDF8", "#FFD24D", "#B26BFF", "#4ADE80", "#FFFFFF"];
const DRIP = [7, 12, 5, 10, 15, 6, 11, 8, 13, 5, 9, 14, 7, 11, 6, 12, 8, 10];
const CAKE_BODY = (() => {
  let drips = "";
  for (let i = 0, x = 18; x < 206; x += 11, i++) {
    const y = 42 + 22 * Math.sqrt(Math.max(0, 1 - ((x - 110) / 100) ** 2)), L = DRIP[i % DRIP.length];
    drips += `<rect x="${x - 4.5}" y="${(y - 6).toFixed(1)}" width="9" height="${L + 6}" rx="4.5" class="ic"/>`;
  }
  const spr = SPRINKLES.map(([x, y, r], i) => `<rect class="sp${i % 3 === 0 ? " near" : ""}" x="${x}" y="${y}" width="6.5" height="2.4" rx="1.2" fill="${SPR_COLORS[i % 6]}" transform="rotate(${r} ${x} ${y})" style="animation-delay:calc(var(--clock) - ${((i * .61) % 4).toFixed(2)}s)"/>`).join("");
  return `<path d="M10 42 V104 H210 V42 A100 22 0 0 1 10 42Z" fill="#FF7FA3"/>
    <path d="M10 42 V104 H40 V60 A100 22 0 0 1 10 42Z" fill="#000" opacity=".08"/>
    <circle cx="50" cy="84" r="2.6" fill="#fff"/><circle cx="80" cy="94" r="2.6" fill="#FFD24D"/><circle cx="112" cy="86" r="2.6" fill="#7DD3FC"/><circle cx="146" cy="95" r="2.6" fill="#fff"/><circle cx="178" cy="85" r="2.6" fill="#C45CFF"/>
    <ellipse class="ic" cx="110" cy="42" rx="100" ry="22"/>${drips}<ellipse class="cake-glow" cx="110" cy="38" rx="46" ry="10"/>${spr}`;
})();
function flame(x, top, i) {
  // каждая свеча отдельно: навёл на огонёк — гаснет она одна (невидимая зона .hit ловит мышку)
  return `<g class="wick"><path d="M${x} ${top} v-3.2" stroke="#3B2A1A" stroke-width="1.3" stroke-linecap="round"/>
    <g class="fl" style="transform-origin:${x}px ${top - 3}px;animation-delay:calc(var(--clock) - ${(i * .37).toFixed(2)}s)"><ellipse cx="${x}" cy="${top - 8}" rx="6" ry="8" fill="#FFB020" opacity=".18"/>
    <path d="M${x} ${top - 15} q4.2 5.4 0 10.2 q-4.2-4.8 0-10.2z" fill="#FFB020"/><path d="M${x} ${top - 11} q2 2.6 0 5 q-2-2.4 0-5z" fill="#FFF3B0"/></g>
    <circle class="spark" cx="${x}" cy="${top - 4}" r="2.4" fill="#FFF3B0"/>
    <g class="smoke" style="transform-origin:${x}px ${top - 4}px"><path d="M${x} ${top - 4} q-3 -5 0 -9 q3 -4 0 -9" stroke="#CBD5E1" stroke-width="1.6" fill="none" stroke-linecap="round"/></g>
    <rect class="hit" x="${x - 9}" y="${top - 18}" width="18" height="22" fill="transparent"/></g>`;
}
function cakeSvg(age) {
  let candles = "";
  const digits = age ? String(age).slice(0, 3) : "";
  if (digits) {
    const step = 28, x0 = 110 - (digits.length - 1) * step / 2;
    [...digits].forEach((c, i) => {
      const x = x0 + i * step;
      candles += `<ellipse cx="${x}" cy="42" rx="4" ry="1.4" fill="rgba(0,0,0,.25)"/><rect x="${x - 1.6}" y="31" width="3.2" height="11" rx="1" fill="#D1D5DB" stroke="#6B7280" stroke-width=".6"/>
        <text x="${x}" y="35" text-anchor="middle" font-size="26" font-weight="900" fill="#FFD24D" stroke="#C2410C" stroke-width="1.5" font-family="Arial Black, Arial, sans-serif">${c}</text>${flame(x, 15, i)}`;
    });
  } else {
    [[82, 40, "#7DD3FC"], [110, 45, "#FF5C8A"], [138, 40, "#86EFAC"]].forEach(([x, y, col], i) => {
      candles += `<ellipse cx="${x}" cy="${y}" rx="4.4" ry="1.5" fill="rgba(0,0,0,.25)"/><rect x="${x - 2.6}" y="${y - 24}" width="5.2" height="24" rx="1.6" fill="${col}"/>
        <path d="M${x - 2.6} ${y - 19} l5.2 -2.4 M${x - 2.6} ${y - 12} l5.2 -2.4 M${x - 2.6} ${y - 5} l5.2 -2.4" stroke="#fff" stroke-width="1.3"/>${flame(x, y - 24, i)}`;
    });
  }
  return `<svg class="cake" viewBox="0 0 220 104" preserveAspectRatio="xMidYMax meet" aria-hidden="true">${CAKE_BODY}${candles}</svg>`;
}
const CONFETTI_16 = [[6, "#FF5C8A", .3, 4.6], [14, "#5E6BFF", 2.1, 5.2], [22, "#35D49A", 3.4, 4.2], [30, "#F5C451", 1.2, 5.8], [38, "#FF7A1A", 4.1, 4.8],
  [46, "#A27BFF", .8, 5.4], [54, "#38BDF8", 2.8, 4.4], [62, "#FF5C8A", 3.9, 5], [70, "#F5C451", 1.6, 4.7], [78, "#35D49A", .5, 5.6], [86, "#5E6BFF", 3.1, 4.3],
  [94, "#FF7A1A", 2.4, 5.1], [18, "#F5C451", 4.6, 5.9], [42, "#FF5C8A", 5.2, 4.9], [66, "#A27BFF", 4.4, 5.3], [90, "#38BDF8", 1.9, 4.5]]
  .map(([l, c, d, t]) => `<i style="left:${l}%;background:${c};animation-duration:${t}s;animation-delay:calc(var(--clock) - ${d}s)"></i>`).join("");

function bdayRow(it, withDate) {
  const d = parse(it.date);
  const left = withDate ? dateBlock(d).replace('class="dateblock', 'class="dateblock gold') : "";
  const meta = withDate ? `${relDay(d)} · ${ageText(it)}` : ageText(it);
  return `<div class="item bday" data-id="${it.id}" data-date="${it.date}">
    <span class="confetti" aria-hidden="true">${CONFETTI_16}</span>${cakeSvg(it.age)}
    <span class="bday-ic">${icon("cake")}</span>
    ${left}
    <div class="body" data-act="edit">
      <div class="title">${esc(it.title)}</div>
      <div class="meta">${esc(meta)}</div>
      <div class="tags"><span class="tag gold">${icon("gift")}День рождения</span></div>
    </div>
    <button class="icon-btn" data-act="menu" title="Действия">${icon("dots")}</button>
  </div>`;
}

function vacRange(v) {
  const a = parse(v.start), b = parse(v.end), n = Math.round((b - a) / 864e5) + 1;
  const range = a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ${MONTHS_GEN[b.getMonth()]}`
    : `${a.getDate()} ${MONTHS_GEN[a.getMonth()]} – ${b.getDate()} ${MONTHS_GEN[b.getMonth()]}`;
  return `${range} · ${n} ${plural(n, "день", "дня", "дней")}`;
}

/* ---------- Пляж в баннере отпуска: у каждого отпуска свой узор ракушек ---------- */
function seeded(str) {
  let h = 2166136261;
  for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
const SHELL_COLORS = [["#FBCFE8", "#DB2777"], ["#FED7AA", "#EA580C"], ["#FDE68A", "#D97706"], ["#E0F2FE", "#0284C7"]];
const PEBBLES = ["#94A3B8", "#78716C", "#A8A29E", "#64748B"];
function sandItems(seed) {
  const r = seeded(seed), out = [];
  for (let x = 8 + r() * 22; x < 392; x += 26 + r() * 22) {
    const y = 26.5 + r() * 8.5, sc = .32 + .38 * ((y - 26.5) / 8.5), k = r(); // у воды мельче, ближе к нам — крупнее
    if (k < .5) {
      const [f, st] = SHELL_COLORS[Math.floor(r() * 4)], w = 6 * sc;
      out.push(`<path d="M${x.toFixed(1)} ${y.toFixed(1)} q${(w / 2).toFixed(2)} ${(-w * .75).toFixed(2)} ${w.toFixed(2)} 0z" fill="${f}" stroke="${st}" stroke-width="${(.5 * sc + .2).toFixed(2)}"/>`);
    } else if (k < .68) {
      const z = 5.5 * sc;
      out.push(`<path transform="translate(${x.toFixed(1)} ${(y - z).toFixed(1)}) scale(${(z / 16).toFixed(3)})" d="M8 0 L10 5.6 L16 6 L11.4 9.6 L13 15.6 L8 12.2 L3 15.6 L4.6 9.6 L0 6 L6 5.6Z" fill="#FB923C" stroke="#C2410C" stroke-width="1.2"/>`);
    } else {
      out.push(`<ellipse cx="${x.toFixed(1)}" cy="${(y - .6).toFixed(1)}" rx="${(2.6 * sc + .3).toFixed(2)}" ry="${(1.5 * sc + .2).toFixed(2)}" fill="${PEBBLES[Math.floor(r() * 4)]}"/>`);
    }
  }
  return out.join("");
}
const SUN_RAYS = Array.from({ length: 12 }, (_, i) =>
  `<g transform="rotate(${i * 30} 30 30)"><rect class="${i % 2 ? "rb" : "ra"}" x="29.2" y="6" width="1.6" height="7" rx=".8" fill="#FFE9A0" opacity=".9"/></g>`).join("");
function beach(seed) {
  return `<span class="beach" aria-hidden="true">
    <svg class="b-sun" viewBox="0 0 60 60"><circle cx="30" cy="30" r="26" fill="#FFF3B0" opacity=".22"/><circle cx="30" cy="30" r="17" fill="#FFF3B0" opacity=".3"/>${SUN_RAYS}<circle cx="30" cy="30" r="9" fill="#FFE27A"/></svg>
    <svg class="b-gull g1"><use href="#gull"/></svg><svg class="b-gull g2"><use href="#gull"/></svg>
    <span class="b-sea"><i></i><i></i></span>
    <svg class="b-sand" viewBox="0 6 400 34" preserveAspectRatio="xMidYMax slice">
      <path d="M0 16 Q50 8 100 14 T200 13 T300 15 T400 12 V40 H0Z" fill="#F5DEB3"/>
      <path d="M0 16 Q50 8 100 14 T200 13 T300 15 T400 12" stroke="#fff" stroke-opacity=".7" stroke-width="1.6" fill="none"/>
      <path d="M0 22 Q60 16 120 21 T240 20 T400 19 V40 H0Z" fill="#E9C68C" opacity=".55"/>
      ${sandItems(seed)}
    </svg>
    <span class="b-crab"><svg viewBox="0 0 30 20"><use href="#crab"/></svg></span></span>`;
}

function vacBanner(v) {
  return `<button class="vac-banner" data-act="edit" data-id="${v.id}">
    ${beach(v.id)}
    <span class="vb-ic"><svg class="isl" viewBox="0 0 24 24"><use href="#island"/></svg></span>
    <span class="vb-txt"><b>${esc(v.title)}</b><small>${vacRange(v)}${v.mute_work ? " · работа на паузе" : ""}</small></span>
  </button>`;
}

const SPARK = `<svg class="i" viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;

function itemRow(it, { withDate = false } = {}) {
  if (it.kind === "birthday") return bdayRow(it, withDate);
  const missed = it.past && !it.done;
  // анимированный баннер — только в панели дня (без даты в строке) и только у записи с категорией
  const scene = !withDate && it.animated && typeof SCENES !== "undefined" ? SCENES[it.category] : "";
  const cls = ["item", scene ? `scb scb-${it.category}` : "", it.done ? "done" : "", missed ? "missed" : "", it.important ? "hot" : ""].filter(Boolean).join(" ");
  const d = parse(it.date);
  const left = withDate ? dateBlock(d) : `<div class="time">${it.time}</div><div class="vsep"></div>`;
  let meta = "";
  if (withDate) meta = `${relDay(d)} · ${it.time}${missed ? " · пропущено" : ""}`;
  else if (it.note) meta = it.note.split("\n")[0];
  return `<div class="${cls}" data-id="${it.id}" data-date="${it.date}">${scene || ""}
    <button class="check" data-act="toggle" title="${it.done ? "Снять отметку" : "Выполнено"}">${icon("check")}</button>
    ${left}
    <div class="body" data-act="edit">
      <div class="title">${it.important ? `<span class="fire" title="Приоритет">${icon("flame")}</span>` : ""}${esc(it.title)}</div>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ""}
      ${tagsHtml(it)}
    </div>
    <button class="icon-btn" data-act="menu" title="Действия">${icon("dots")}</button>
  </div>`;
}

function emptyHtml(title, text, date) {
  return `<div class="empty"><div class="em-ic">${icon("rocket")}</div><b>${title}</b>${text}
    <div><button class="btn btn-soft" data-act="add-day" data-date="${date || iso(S.selected)}">${icon("plus")}Добавить</button></div></div>`;
}

function monthGrid(y, m, rowsMin = 0) {
  const first = new Date(y, m, 1);
  const offset = wdIndex(first);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const rows = Math.max(rowsMin, Math.ceil((offset + daysInMonth) / 7));
  return Array.from({ length: rows * 7 }, (_, i) => addDays(first, i - offset));
}

function calHead() {
  const { y, m } = S.view;
  return `<div class="card-head mp-anchor"><button class="mbtn" data-act="mp-open" title="Выбрать месяц и год">${MONTHS[m]} ${y}${icon("down")}</button><div class="spacer"></div>
    <div class="cal-nav">
      <button class="icon-btn" data-act="prev" title="Предыдущий месяц">${icon("left")}</button>
      <button class="icon-btn" data-act="next" title="Следующий месяц">${icon("right")}</button>
    </div></div>`;
}

function miniCal(info) {
  const { y, m } = S.view;
  const head = WD.map((w, i) => `<div class="wd${i > 4 ? " we" : ""}">${w}</div>`).join("");
  const days = monthGrid(y, m).map((d) => {
    const key = iso(d), n = Math.min(info.marks[key] || 0, 3);
    const isHot = info.hot.includes(key), bd = info.bdays[key], vac = info.vac[key];
    const col = wdIndex(d);
    const cls = ["day", d.getMonth() !== m ? "out" : "", sameDay(d, S.today) ? "today" : "", sameDay(d, S.selected) ? "sel" : "",
      isHot ? "hot" : "", bd ? "bday" : "", vac ? "vac" : "", vac && (vac.start || col === 0) ? "vs" : "", vac && (vac.end || col === 6) ? "ve" : ""].join(" ");
    const dots = n ? `<span class="dot">${"<i></i>".repeat(n)}</span>` : "";
    const flame = isHot ? fireBg() : "";
    const title = bd ? ` title="🎂 ${esc(bd.join(", "))}"` : "";
    return `<button class="${cls}" data-act="pick" data-date="${key}"${title}>${flame}<span class="num">${d.getDate()}</span>${dots}</button>`;
  }).join("");
  return calHead() + `<div class="cal mini">${head}${days}</div>`;
}

function ringSvg(pct, id) {
  const r = 42, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
  return `<svg viewBox="0 0 100 100"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2ECDB5"/><stop offset="1" stop-color="#5E6BFF"/></linearGradient></defs>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--card-3)" stroke-width="10"/>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="url(#${id})" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${pct ? off : c}"/></svg>`;
}

/* ===================== Панель выбора месяца ===================== */
async function openMonthPicker(anchor, year) {
  S.mp = { year, anchor };
  const over = await api("year_overview", year);
  if (!S.mp || S.mp.year !== year) return;
  const cur = S.today;
  const tiles = MONTHS.map((name, i) => {
    const o = over[i], marks = [];
    if (o.bdays) marks.push(`<span class="mk bd">🎂 ${o.bdays}</span>`);
    if (o.vacation) marks.push(`<span class="mk vc"><svg class="isl" viewBox="0 0 24 24"><use href="#island"/></svg></span>`);
    if (o.hot) marks.push(`<span class="mk fr">🔥 ${o.hot}</span>`);
    const cls = ["mt", year === S.view.y && i === S.view.m ? "on" : "",
      year === cur.getFullYear() && i === cur.getMonth() ? "cur" : ""].join(" ");
    return `<button class="${cls}" data-act="mp-month" data-v="${i}"><b>${name}</b>${marks.length ? `<span class="mks">${marks.join("")}</span>` : ""}</button>`;
  }).join("");
  let pop = anchor.querySelector(".mpop");
  const fresh = !pop;
  if (fresh) { pop = document.createElement("div"); pop.className = "mpop"; anchor.appendChild(pop); }
  pop.innerHTML = `<div class="mp-year">
      <button class="icon-btn" data-act="mp-year" data-v="-1" title="Предыдущий год">${icon("left")}</button>
      <b>${year}</b>
      <button class="icon-btn" data-act="mp-year" data-v="1" title="Следующий год">${icon("right")}</button></div>
    <div class="mp-grid">${tiles}</div>
    <div class="mp-legend"><span class="mk bd">🎂 дни рождения</span><span class="mk vc"><svg class="isl" viewBox="0 0 24 24"><use href="#island"/></svg> отпуск</span><span class="mk fr">🔥 приоритеты</span></div>`;
  if (fresh) pop.classList.add("enter");
}
function closeMonthPicker() {
  document.querySelectorAll(".mpop").forEach((p) => p.remove());
  S.mp = null;
}

/* ===================== Страницы ===================== */
async function renderHome() {
  const sel = S.selected, { y, m } = S.view;
  const [info, dayItems, upcoming, week, vacs] = await Promise.all([
    api("month_info", y, m + 1),
    api("range", iso(sel), iso(sel)),
    api("range", iso(addDays(S.today, 1)), iso(addDays(S.today, 7))),
    api("stats", "week"),
    api("vacations", iso(sel), iso(sel)),
  ]);
  const todayRem = S.todayItems.filter((i) => i.kind !== "birthday");
  const todayLeft = todayRem.filter((i) => !i.done && !i.past).length;
  const isToday = sameDay(sel, S.today);

  const dayList = dayItems.length || vacs.length
    ? `<div class="list">${vacs.map(vacBanner).join("")}${dayItems.map((i) => itemRow(i)).join("")}</div>`
    : emptyHtml(isToday ? "На сегодня пусто" : "На этот день пусто", "Добавь напоминание — и оно не потеряется", iso(sel));

  const up = upcoming.filter((i) => !i.done).slice(0, 4);
  const upList = up.length
    ? `<div class="list">${up.map((i) => itemRow(i, { withDate: true })).join("")}</div>`
    : `<div class="empty" style="padding:20px">На неделю вперёд ничего не запланировано</div>`;

  return `<div class="grid-home">
    <div class="card">
      ${miniCal(info)}
      <button class="summary" data-page="all">
        <span class="ic">${icon("target")}</span>
        <span><b>Сегодня ${remindersWord(todayRem.length)}</b>
        <small>${!todayRem.length ? "Свободный день" : todayLeft ? `Осталось ${todayLeft} до конца дня` : phrase("allDoneShort")}</small></span>
        <span class="chev">${icon("right")}</span>
      </button>
    </div>
    <div class="card">
      <div class="card-head"><h3>${isToday ? "Сегодня" : esc(dayTitle(sel))}</h3><span class="badge">${dayItems.length + vacs.length}</span>
        <div class="spacer"></div>
        <button class="icon-btn" data-act="add-day" data-date="${iso(sel)}" title="Добавить на этот день">${icon("plus")}</button></div>
      ${dayList}
    </div>
    <div class="card">
      <div class="card-head"><h3>Ближайшие дни</h3><div class="spacer"></div>
        <button class="btn btn-ghost" style="height:34px;padding:0 12px;font-size:13px" data-page="all">Все</button></div>
      ${upList}
    </div>
    <div class="card">
      <div class="card-head"><h3>Эта неделя</h3><div class="spacer"></div>
        <button class="btn btn-ghost" style="height:34px;padding:0 12px;font-size:13px" data-page="stats">Подробнее</button></div>
      <div class="mini-ring-wrap">
        <div class="ring">${ringSvg(week.percent, "rgMini")}<div class="center"><b>${week.percent}%</b><small>выполнено</small></div></div>
        <div class="mini-stats">
          <div>Выполнено<b>${week.done}</b></div>
          <div>Осталось<b>${week.left}</b></div>
          <div>Пропущено<b>${week.missed}</b></div>
          <div>Всего за неделю<b>${week.total}</b></div>
        </div>
      </div>
    </div>
  </div>`;
}

/* пересекающиеся отпуска — одно море: общий кораблик, на ярлыке оба названия */
function mergeVacs(vacs) {
  const out = [];
  [...vacs].sort((a, b) => a.start.localeCompare(b.start)).forEach((v) => {
    const last = out[out.length - 1];
    if (last && v.start <= iso(addDays(parse(last.end), 1))) {
      if (v.end > last.end) last.end = v.end;
      last.title += " · " + v.title;
      last.seed = (last.seed || "") + (v.seed || "");
    } else out.push({ ...v });
  });
  return out;
}

/* Море с волнами, корабликом и островами в плитках календаря. Пока выключено (Дима решил оставить
   анимацию только в баннере отпуска) — код целиком на месте, вернуть: поставить true. */
const SEA_IN_CALENDAR = false;

/* ---------- Острова на горизонте отпуска: до 5 на всё море, по одному в плитке ---------- */
const ISLANDS = [ // viewBox 0 0 40 20; [рисунок, сдвиг вниз в px — насколько остров «сидит» в воде]
  ['<path d="M3 20 Q12 11 20 12 Q28 11 37 20Z" fill="#E9CF96"/><path d="M20 13 Q21 7 19 3" stroke="#8B5A2B" stroke-width="1.3" fill="none"/><path d="M19 4 Q14 2 11 5 M19 4 Q24 1 27 4 M19 4 Q16 6 14 9 M19 4 Q23 6 25 8" stroke="#22A35A" stroke-width="1.7" fill="none" stroke-linecap="round"/>', 3],
  ['<path d="M1 20 Q20 12 39 20Z" fill="#E9CF96"/><path d="M28 16 Q28 11 27 8" stroke="#8B5A2B" stroke-width="1.1" fill="none"/><path d="M27 8.5 Q24 7 22 9 M27 8.5 Q30 6.5 32 8.5 M27 8.5 Q26 10 25 11.5" stroke="#22A35A" stroke-width="1.4" fill="none" stroke-linecap="round"/>', 4],
  ['<path d="M6 20 Q20 15 34 20Z" fill="#E9CF96"/><path d="M10 18 L14 9 L18 11 L21 5 L26 10 L30 18Z" fill="#8A8F9C"/><path d="M21 5 L23 10" stroke="#6B7280" stroke-width=".8"/>', 3],
  ['<path d="M0 20 Q20 12 40 20Z" fill="#E9CF96"/><path d="M6 17 Q12 7 20 9 Q27 7 34 17Z" fill="#2F8F6B"/><path d="M12 11 Q17 6 24 9" stroke="#24785A" stroke-width="1" fill="none"/><path d="M27 11 Q27 6 26 4" stroke="#8B5A2B" stroke-width="1.1" fill="none"/><path d="M26 4.5 Q23 3 21 5 M26 4.5 Q29 2.5 31 4.5" stroke="#22A35A" stroke-width="1.4" fill="none" stroke-linecap="round"/>', 3],
  ['<path d="M4 20 Q20 14 36 20Z" fill="#E9CF96"/><path d="M14 17 V12 M24 17 V12" stroke="#8B5A2B" stroke-width="1"/><rect x="12" y="8" width="14" height="5" fill="#C08A4A"/><path d="M10 9 L19 3 L28 9Z" fill="#A16207"/><path d="M31 16 Q31.7 11.8 30.3 9 M30.3 9.7 Q26.1 8.3 24.7 10.4 M30.3 9.7 Q33.1 7.6 35.9 9.7 M30.3 9.7 Q28.2 11.1 27.5 13.2" stroke="#22A35A" stroke-width="1.1" fill="none" stroke-linecap="round"/>', 3],
  ['<path d="M6 20 L10 14 L16 15 L20 12 L28 15 L33 20Z" fill="#8A8F9C"/><path d="M18 13 L19 3 L22 3 L23 13Z" fill="#fff"/><path d="M18.5 6 H22.5 M18.2 9.5 H22.8" stroke="#EF4444" stroke-width="1.6"/><rect x="18.4" y="1" width="4.2" height="2.4" fill="#FDE047"/>', 3],
  ['<path d="M2 20 Q20 11 38 20Z" fill="#E9CF96"/><path d="M15 15 Q16 9 14 5" stroke="#8B5A2B" stroke-width="1.2" fill="none"/><path d="M14 6 Q9 4 6 7 M14 6 Q19 3 22 6 M14 6 Q11 8 9 11" stroke="#22A35A" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M25 15 Q25.8 10.2 24.2 7" stroke="#8B5A2B" stroke-width="1" fill="none"/><path d="M24.2 7.8 Q20.2 6.2 17.8 8.6 M24.2 7.8 Q28.2 5.4 30.6 7.8" stroke="#22A35A" stroke-width="1.2" fill="none" stroke-linecap="round"/>', 3],
  ['<path d="M6 20 L8 10 Q14 3 22 6 Q30 4 33 12 L34 20 H27 Q27 13 20 13 Q14 13 13 20Z" fill="#8A8F9C"/><path d="M12 9 Q16 6 22 7" stroke="#6B7280" stroke-width=".8" fill="none"/><path d="M28 6 Q30 4 31 6" stroke="#22A35A" stroke-width="1.6" fill="none"/>', 3],
  ['<path d="M4 20 L16 6 H24 L36 20Z" fill="#6B5B53"/><path d="M16 6 H24 L22 9 Q20 7 18 9Z" fill="#F97316"/><path d="M4 20 Q20 16 36 20Z" fill="#E9CF96"/><circle cx="21" cy="3" r="2" fill="#CBD5E1" opacity=".8"/><circle cx="24" cy="1" r="1.4" fill="#CBD5E1" opacity=".6"/>', 3],
];
function islandFor(sea, key) {
  // не больше 5 островов на всё море (даже на годовой отпуск), не больше одного в плитке, виды не повторяются
  const start = parse(sea.start), days = Math.round((parse(sea.end) - start) / 864e5) + 1;
  const n = Math.max(1, Math.min(5, Math.round(days / 4.2)));
  const day = Math.round((parse(key) - start) / 864e5);
  const k = [...Array(n).keys()].find((j) => Math.min(days - 1, Math.floor((j + .5) * days / n)) === day);
  if (k === undefined) return "";
  const seed = sea.id + ":" + (sea.seed || ""), kinds = [...ISLANDS.keys()], rs = seeded(seed);
  for (let i = kinds.length - 1; i > 0; i--) { const j = Math.floor(rs() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
  const r = seeded(seed + ":" + k);
  const w = [40, 46, 52][Math.floor(r() * 3)], pos = 24 + r() * 52, [svg, sink] = ISLANDS[kinds[k % kinds.length]];
  return `<span class="isl-wrap"><svg class="isl-x" viewBox="0 0 40 20" style="width:${w}px;height:${w / 2}px;left:calc(${pos.toFixed(1)}% - ${w / 2}px);bottom:${sink}px">${svg}</svg></span>`;
}

/* ---------- Плитка дня рождения: подарки снизу ---------- */
const BDAY_DECOR = (() => {
  return `<svg class="bd-gifts" viewBox="0 0 80 22" aria-hidden="true"><rect x="6" y="8" width="16" height="14" rx="1.5" fill="#FF5C8A"/><rect x="5" y="6" width="18" height="4" rx="1" fill="#FF7FA3"/><rect x="13" y="6" width="2" height="16" fill="#FFD24D"/><path d="M14 6 Q9 1 8 4 Q9 6 14 6 Q19 1 20 4 Q19 6 14 6" fill="#FFD24D"/>
    <rect x="28" y="12" width="12" height="10" rx="1.2" fill="#38BDF8"/><rect x="27" y="10.5" width="14" height="3" rx="1" fill="#7DD3FC"/><rect x="33" y="10.5" width="2" height="11.5" fill="#fff"/><path d="M34 10.5 Q30.5 6.5 29.6 8.8 Q30.4 10.5 34 10.5 Q37.5 6.5 38.4 8.8 Q37.6 10.5 34 10.5" fill="#fff"/>
    <rect x="56" y="10" width="14" height="12" rx="1.3" fill="#A855F7"/><rect x="55" y="8" width="16" height="3.5" rx="1" fill="#C084FC"/><rect x="62" y="8" width="2" height="14" fill="#86EFAC"/><path d="M63 8 Q59 4 58 6.5 Q59 8 63 8 Q67 4 68 6.5 Q67 8 63 8" fill="#86EFAC"/></svg>
  <svg class="bd-gifts bd-more" viewBox="0 0 44 22" aria-hidden="true"><rect x="2" y="11" width="13" height="11" rx="1.2" fill="#FFD24D"/><rect x="1" y="9" width="15" height="3.2" rx="1" fill="#FDE68A"/><rect x="7.5" y="9" width="2" height="13" fill="#FF5C8A"/><path d="M8.5 9 Q5 5 4 7.5 Q5 9 8.5 9 Q12 5 13 7.5 Q12 9 8.5 9" fill="#FF5C8A"/>
    <rect x="22" y="6" width="18" height="16" rx="1.6" fill="#22C55E"/><rect x="21" y="4" width="20" height="4" rx="1.2" fill="#4ADE80"/><rect x="30" y="4" width="2" height="18" fill="#fff"/><path d="M31 4 Q26 -1 25 2 Q26 4 31 4 Q36 -1 37 2 Q36 4 31 4" fill="#fff"/></svg>`;
})();

async function renderCalendar() {
  const { y, m } = S.view;
  const grid = monthGrid(y, m, 6);
  const [items, dayItems, vacs] = await Promise.all([
    api("range", iso(grid[0]), iso(grid[grid.length - 1])),
    api("range", iso(S.selected), iso(S.selected)),
    api("vacations", iso(grid[0]), iso(grid[grid.length - 1])),
  ]);
  const byDay = {};
  items.forEach((i) => (byDay[i.date] ||= []).push(i));
  const seas = mergeVacs(vacs);
  const vacOf = (key) => seas.find((v) => v.start <= key && key <= v.end);
  const dayVacs = vacs.filter((v) => v.start <= iso(S.selected) && iso(S.selected) <= v.end);

  const head = WD.map((w) => `<div class="wd">${w}</div>`).join("");
  const cells = grid.map((d) => {
    const key = iso(d), list = byDay[key] || [];
    const isHot = list.some((i) => i.important && !i.done);
    const isBday = list.some((i) => i.kind === "birthday");
    const vac = vacOf(key), col = wdIndex(d);
    const vs = vac && (vac.start === key || col === 0), ve = vac && (vac.end === key || col === 6);
    const cls = ["cell", d.getMonth() !== m ? "out" : "", sameDay(d, S.today) ? "today" : "", sameDay(d, S.selected) ? "sel" : "",
      isHot ? "hot" : "", isBday ? "bday" : "", vac ? "vac" : "", vs ? "vs" : "", ve ? "ve" : ""].join(" ");
    const rank = (i) => (i.kind === "birthday" ? 2 : 0) + (i.important && !i.done ? 1 : 0);
    const sorted = [...list].sort((a, b) => rank(b) - rank(a));
    const max = vac || isBday ? 1 : 2; // в ДР внизу подарки — оставляем им место
    const chips = sorted.slice(0, max).map((i) => i.kind === "birthday"
      ? `<span class="chip gold" title="День рождения: ${esc(i.title)}">${esc(i.title)}${i.age ? ` · ${i.age}` : ""}</span>`
      : `<span class="chip${i.done ? " done" : ""}${i.important ? " hot" : ""}" style="--c:${i.important ? IMPORTANT : CAT_COLORS[i.category] || "var(--accent)"}" title="${i.time} ${esc(i.title)}">${i.important ? icon("flame") : ""}${esc(i.title)}</span>`).join("");
    const more = list.length > max ? `<span class="more-n">ещё ${list.length - max}</span>` : "";
    const sea = vac ? `${SEA_IN_CALENDAR ? `<span class="sea" aria-hidden="true">${islandFor(vac, key)}<i></i><i></i></span>` : ""}${vs ? `<span class="vac-label" title="${esc(vac.title)}"><svg class="isl" viewBox="0 0 24 24"><use href="#island"/></svg><span>${esc(vac.title)}</span></span>` : ""}` : "";
    const confetti = isBday ? `<span class="confetti" aria-hidden="true">${"<i></i>".repeat(6)}</span>${BDAY_DECOR}` : "";
    return `<button class="${cls}" data-act="pick" data-date="${key}"${vac ? ` data-vac="${vac.id}"` : ""}>${sea}${confetti}<span class="n">${isHot ? fireBg() : ""}<span class="num">${d.getDate()}</span></span>${chips}${more}</button>`;
  }).join("");

  const dayList = dayItems.length || dayVacs.length
    ? `<div class="list">${dayVacs.map(vacBanner).join("")}${dayItems.map((i) => itemRow(i)).join("")}</div>`
    : emptyHtml("Свободный день", "Нажми ещё раз на день в календаре или на кнопку ниже", iso(S.selected));

  return `<div class="grid-cal compact">
    <div class="card">
      ${calHead().replace('<div class="spacer"></div>', `<div class="spacer"></div><button class="btn btn-ghost" style="height:34px;padding:0 12px;font-size:13px;margin-right:6px" data-act="today">Сегодня</button>`)}
      <div class="bigcal">${head}${cells}</div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>${esc(relDay(S.selected) === "Сегодня" ? "Сегодня" : WD_FULL[wdIndex(S.selected)])}</h3>
        <div class="sub">${S.selected.getDate()} ${MONTHS_GEN[S.selected.getMonth()]} · ${remindersWord(dayItems.length)}</div></div>
        <div class="spacer"></div>
        <button class="icon-btn" data-act="add-day" data-date="${iso(S.selected)}" title="Добавить">${icon("plus")}</button></div>
      ${dayList}
    </div>
  </div>`;
}

async function renderAll() {
  const span = { day: 0, week: 6, month: 30 }[S.allRange];
  let [items, vacs] = await Promise.all([
    api("range", iso(S.today), iso(addDays(S.today, span))),
    api("vacations", iso(S.today), iso(addDays(S.today, span))),
  ]);
  const total = items.length;
  if (S.allCat) {
    items = items.filter((i) => (S.allCat === "important" ? i.important : S.allCat === "birthday" ? i.kind === "birthday" : i.category === S.allCat));
    if (S.allCat !== "vacation") vacs = [];
    else items = [];
  }

  const seg = [["day", "День"], ["week", "Неделя"], ["month", "Месяц"]]
    .map(([k, t]) => `<button class="${S.allRange === k ? "on" : ""}" data-act="range" data-v="${k}">${t}</button>`).join("");
  const chips = [["", "Все", "", "bell"], ...Object.entries(S.categories).map(([k, t]) => [k, t, CAT_COLORS[k], "cat-" + k]), ["important", "Приоритет", IMPORTANT, "flame"], ["birthday", "Дни рождения", "var(--gold-2)", "cake"], ["vacation", "Отпуск", "var(--sea)", "palm"]]
    .map(([k, t, c, ic]) => `<button class="fchip${S.allCat === k ? " on" : ""}" style="${c ? `--c:${c}` : ""}" data-act="cat" data-v="${k}">${icon(ic)}${t}</button>`).join("");

  const list = items.length || vacs.length
    ? `<div class="list">${vacs.map(vacBanner).join("")}${items.map((i) => itemRow(i, { withDate: true })).join("")}</div>`
    : emptyHtml("Здесь пока пусто", S.allCat ? "В этой категории ничего нет за выбранный период" : "За выбранный период напоминаний нет", iso(S.today));

  return `<div class="card">
    <div class="card-head"><div><h3>${{ day: "Сегодня", week: "Ближайшие 7 дней", month: "Ближайшие 30 дней" }[S.allRange]}</h3><div class="sub">${remindersWord(total)}</div></div>
      <div class="spacer"></div><div class="seg">${seg}</div></div>
    <div class="filters">${chips}</div>
    ${list}
  </div>`;
}

async function renderStats() {
  const s = await api("stats", S.statsPeriod);
  const seg = [["week", "Неделя"], ["month", "Месяц"], ["year", "Год"]]
    .map(([k, t]) => `<button class="${S.statsPeriod === k ? "on" : ""}" data-act="period" data-v="${k}">${t}</button>`).join("");
  const from = parse(s.from), to = parse(s.to);
  const range = from.getMonth() === to.getMonth()
    ? `${from.getDate()}–${to.getDate()} ${MONTHS_GEN[to.getMonth()]}`
    : `${from.getDate()} ${MONTHS_GEN[from.getMonth()]} – ${to.getDate()} ${MONTHS_GEN[to.getMonth()]}`;

  const kpi = (c, ic, n, t) => `<div class="kpi" style="--c:${c}"><span class="ic">${icon(ic)}</span><div><b>${n}</b><small>${t}</small></div></div>`;
  const cats = s.categories.length
    ? s.categories.map((c) => `<div class="catbar" style="--c:${CAT_COLORS[c.key]}">
        <div class="row"><span class="ic">${icon("cat-" + c.key)}</span>${esc(S.categories[c.key])}<span class="pct">${c.percent}% · ${c.total}</span></div>
        <div class="bar"><i style="width:${c.percent}%"></i></div></div>`).join("")
    : `<div class="empty" style="padding:20px">Добавь категории к напоминаниям — и здесь появится разбивка</div>`;

  return `<div class="card" style="margin-bottom:20px;padding:16px 22px">
      <div class="card-head" style="margin:0"><div><h3>Твои результаты</h3><div class="sub">${range}</div></div>
      <div class="spacer"></div><div class="seg">${seg}</div></div></div>
    <div class="grid-stats">
      <div class="card"><div class="card-head"><h3>Выполнение</h3></div>
        <div class="ring-wrap">
          <div class="ring">${ringSvg(s.percent, "rgBig")}<div class="center"><b>${s.percent}%</b><small>выполнено</small></div></div>
          <div class="kpis">
            ${kpi("var(--ok)", "okc", s.done, "Выполнено")}
            ${kpi("var(--accent)", "clock", s.left, "Осталось")}
            ${kpi("var(--warn)", "miss", s.missed, "Пропущено")}
          </div>
        </div>
      </div>
      <div class="card"><div class="card-head"><h3>По категориям</h3><div class="spacer"></div><span class="sub">выполнено · всего</span></div>
        <div class="catbars">${cats}</div></div>
    </div>`;
}

const LONG_SNOOZE = [[30, "30 мин", "30 минут"], [60, "1 час", "1 час"], [120, "2 часа", "2 часа"]];
function snoozeSeg(cur) {
  cur = Number(cur);
  const short = [5, 10, 15].map((v) => `<button class="${cur === v ? "on" : ""}" data-act="set-snooze" data-v="${v}">${v}</button>`).join("");
  const long = LONG_SNOOZE.find(([v]) => v === cur) || LONG_SNOOZE[0];
  return `<div class="seg snz">${short}<button class="snz-btn${cur >= 30 ? " on" : ""}" data-act="snz-open">${long[1]}${icon("down")}</button>
    <div class="snz-pop" hidden>${LONG_SNOOZE.map(([v, , t]) => `<button class="${cur === v ? "on" : ""}" data-act="set-snooze" data-v="${v}">${t}</button>`).join("")}</div></div>`;
}

function renderSettings() {
  const st = S.settings;
  const seg = (act, opts, cur) => `<div class="seg">${opts.map(([v, t]) =>
    `<button class="${String(cur) === String(v) ? "on" : ""}" data-act="${act}" data-v="${v}">${t}</button>`).join("")}</div>`;
  const sw = (key, on, disabled) => `<button class="switch${on ? " on" : ""}" data-act="switch" data-key="${key}" ${disabled ? "disabled" : ""}></button>`;
  return `<div class="settings">
    <div class="col">
    <div class="card"><div class="card-head"><h3>Профиль и вид</h3></div>
      <div class="setting"><span class="ic">${icon("user")}</span>
        <div class="txt"><b>Как тебя зовут</b><small>Для приветствия на главной</small></div>
        <input class="input" id="setName" style="width:170px" maxlength="30" value="${esc(st.name)}"></div>
      <div class="setting"><span class="ic">${icon("chat")}</span>
        <div class="txt"><b>Обращение</b><small>«Ты всё сделал» или «сделала»</small></div>
        ${seg("set-gender", [["m", "Мужское"], ["f", "Женское"], ["n", "Нейтральное"]], st.gender || "m")}</div>
      <div class="setting"><span class="ic">${icon(st.theme === "dark" ? "moon" : "sun")}</span>
        <div class="txt"><b>Тема</b><small>Можно переключать и кнопкой в меню</small></div>
        ${seg("set-theme", [["dark", "Тёмная"], ["light", "Светлая"]], st.theme)}</div>
    </div>
    <div class="card"><div class="card-head"><h3>Анимации</h3></div>
      <div class="setting"><span class="ic">${icon("flame")}</span>
        <div class="txt"><b>Эффект</b><small>${REDUCED ? "В Windows выключены анимации — Flint тоже показывает всё статично" : "Как переливается подсветка"}</small></div>
        ${seg("set-anim", [["lava", "🔥 Лава"], ["plain", "Без лавы"], ["off", "Выключены"]], st.anim_effect || "lava")}</div>
      <div class="setting"><span class="ic">${icon("clock")}</span>
        <div class="txt"><b>Скорость</b><small>Сколько длится переливание</small></div>
        ${seg("set-speed", [["fast", "Быстро"], ["normal", "Обычно"], ["slow", "Медленно"]], st.anim_speed || "normal")}</div>
      <div class="setting"><span class="ic">${icon("live")}</span>
        <div class="txt"><b>Живые картинки</b><small>Пляж, свечи и конфетти замрут на месте</small></div>
        ${sw("anim_live", st.anim_live !== false)}</div>
    </div>
    </div>
    <div class="col">
    <div class="card"><div class="card-head"><h3>Уведомления</h3></div>
      <div class="setting"><span class="ic">${icon("volume")}</span>
        <div class="txt"><b>Звук</b><small>Сигнал при появлении напоминания</small></div>${sw("sound", st.sound)}</div>
      <div class="setting"><span class="ic">${icon("snooze")}</span>
        <div class="txt"><b>Откладывать на</b><small>Кнопка «Позже» в уведомлении</small></div>
        ${snoozeSeg(st.snooze_minutes)}</div>
      <div class="setting"><span class="ic">${icon("power")}</span>
        <div class="txt"><b>Запускать вместе с Windows</b>
        <small>${S.canAutostart ? "Flint тихо стартует в трее, у часов" : "Доступно в собранной exe-версии"}</small></div>
        ${sw("autostart", st.autostart, !S.canAutostart)}</div>
      <div class="warn-note${st.autostart ? "" : " off"}">${icon("bell")}<div>
        <b>${st.autostart ? phrase("autoOn") : "Без автозапуска напоминания могут не прийти"}</b>
        <span>Напоминания работают, только пока Flint запущен. Крестик не выключает его: Flint продолжает работать в фоне, его значок-огонёк — в правом нижнем углу экрана, рядом с часами (если не видно, нажми стрелочку ^ возле часов).
        Полностью выключает только кнопка «Выход»${st.autostart ? "." : ": после этого или после перезагрузки компьютера уведомлений не будет, " + phrase("autoOff") + "."}</span></div></div>
    </div>
    </div>
  </div>`;
}

/* ===================== Обновление ===================== */
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
function applyAnim() {
  S.anim = REDUCED ? "off" : (S.settings.anim_effect || "lava");
  S.speed = { fast: 300, normal: 450, slow: 800 }[S.settings.anim_speed] || 450;
  document.body.classList.toggle("anim-off", S.anim === "off");
  S.live = S.anim !== "off" && S.settings.anim_live !== false;
  document.body.classList.toggle("live-off", !S.live);
}

function applyTheme() {
  document.body.dataset.theme = S.settings.theme;
  $("#themeBtn").innerHTML = `${icon(S.settings.theme === "dark" ? "sun" : "moon")}<span>${S.settings.theme === "dark" ? "Светлая" : "Тёмная"}</span>`;
}

function renderChrome() {
  const items = S.todayItems.filter((i) => i.kind !== "birthday"), done = items.filter((i) => i.done).length;
  const bdays = S.todayItems.filter((i) => i.kind === "birthday").map((i) => i.title);
  $("#sideValue").textContent = items.length ? `${done} из ${items.length} выполнено` : "Ничего не запланировано";
  $("#sideBar").style.width = items.length ? `${Math.round((done / items.length) * 100)}%` : "0";
  $("#chipDate").textContent = fullDate(S.today);
  $("#chipSub").textContent = remindersWord(items.length);
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === S.page));

  if (S.page === "home") {
    $("#heroTitle").textContent = S.settings.name ? `Привет, ${S.settings.name} 👋` : phrase("hello");
    const left = items.filter((i) => !i.done && !i.past).length;
    const bd = bdays.length ? `🎂 Сегодня день рождения: ${bdays.join(", ")}. ` : "";
    $("#heroSub").textContent = bd + (!items.length
      ? (bd ? "Других дел на сегодня нет." : "На сегодня ничего не запланировано. Самое время добавить первое дело.")
      : left ? `Сегодня ${remindersWord(items.length)}, осталось ${left}. ${phrase("cheer")}`
        : phrase("allDone", remindersWord(items.length)));
  } else {
    const [t, s] = PAGES[S.page];
    $("#heroTitle").textContent = t;
    $("#heroSub").textContent = s;
  }
}

let renderSeq = 0;
async function refresh(animate = false) {
  const now = new Date();
  S.today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const seq = ++renderSeq;
  S.todayItems = await api("range", iso(S.today), iso(S.today));
  const html = await ({ home: renderHome, calendar: renderCalendar, all: renderAll, stats: renderStats, settings: renderSettings })[S.page]();
  if (seq !== renderSeq) return; // пришёл более свежий рендер
  renderChrome();
  const page = $("#page");
  S.mp = null;
  // общие «часы» фоновых анимаций: после перерисовки волны, конфетти и огонь продолжают с той же фазы
  document.documentElement.style.setProperty("--clock", `${-Math.round(performance.now())}ms`);
  page.innerHTML = html;
  if (animate) { page.style.animation = "none"; void page.offsetWidth; page.style.animation = ""; }
  afterRender(page);
}

function afterRender(page) {
  // перелистывание месяца
  if (S.slide && S.anim !== "off") {
    const g = page.querySelector(".cal, .bigcal");
    if (g) g.classList.add(S.slide > 0 ? "slide-l" : "slide-r");
  }
  S.slide = 0;
  // только что отмеченное «выполнено»: галочка прорисовывается, огонь гаснет
  if (S.justDone) {
    const [id, date] = S.justDone;
    page.querySelectorAll(`.item[data-id="${id}"][data-date="${date}"]`).forEach((it) => it.classList.add("just"));
    S.justDone = null;
  }
  FX.playSeg();
  if (SEA_IN_CALENDAR) FX.boats(page.querySelector(".bigcal"));
}

function go(page) {
  if (!PAGES.hasOwnProperty(page)) return;
  const nav = $("#nav"), from = nav.querySelector("button.active"), to = nav.querySelector(`[data-page="${page}"]`);
  if (from !== to) {
    nav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === to));
    FX.pour(nav, from, to);
  }
  S.page = page;
  $("#main").scrollTop = 0;
  refresh(true);
}

function select(dateStr) {
  const d = parse(dateStr);
  S.selected = d;
  S.view = { y: d.getFullYear(), m: d.getMonth() };
}

/* ===================== Редактор ===================== */
const KIND_UI = {
  reminder: { mode: "Новое напоминание", edit: "Редактирование", ph: "Что напомнить?", note: "Описание",
    notePh: "Детали, ссылки, что не забыть…", date: "Дата", saved: "Напоминание добавлено" },
  birthday: { mode: "Новый день рождения", edit: "День рождения", ph: "Чей день рождения?", note: "Заметка",
    notePh: "Например, идея подарка…", date: "Дата", saved: "День рождения добавлен" },
  vacation: { mode: "Новый отпуск", edit: "Отпуск", ph: "Название, например «Турция»", note: "Заметка",
    notePh: "Куда едем, что взять…", date: "С", saved: "Отпуск добавлен" },
};
const REMIND_OPTS = [[0, "В сам день"], [1, "За день"], [7, "За неделю"]];

async function openEditor(id) {
  const r = await api("get", id);
  if (!r) return toast("Запись не найдена");
  showEditor({ id: r.id, kind: r.kind || "reminder", title: r.title, note: r.note || "", date: r.date, time: r.time,
    repeat: r.repeat, category: r.category || "", important: !!r.important, animated: !!r.animated,
    birth_year: r.birth_year || "", remind: r.remind || [], date_end: r.date_end || r.date, mute_work: !!r.mute_work });
  if (r.kind === "birthday") celebrate($(".modal-head .dateblock"));
}

function openNew(dateStr, kind = "reminder") {
  const now = new Date(), asked = dateStr;
  let time = "09:00";
  if (dateStr === iso(S.today) && kind === "reminder") {
    const t = new Date(now.getTime() + 20 * 60000);
    t.setMinutes(Math.ceil(t.getMinutes() / 5) * 5);
    if (iso(t) !== dateStr) dateStr = iso(t);
    time = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }
  showEditor({ id: null, kind, title: "", note: "", date: dateStr, time, repeat: "none", category: "", important: false, animated: false,
    birth_year: "", remind: [0, 1], date_end: iso(addDays(parse(dateStr), 6)), mute_work: true, asked });
}

function showEditor(ed) {
  S.ed = ed;
  $("#edTitle").value = ed.title;
  $("#edNote").value = ed.note;
  $("#edTime").value = ed.time;
  $("#edBYear").value = ed.birth_year;
  ed.cal = { y: parse(ed.date).getFullYear(), m: parse(ed.date).getMonth() };
  $("#edDatePop").classList.remove("open");
  $("#edDatePopEnd").classList.remove("open");
  $("#edError").textContent = "";
  $("#edDelete").style.display = ed.id ? "" : "none";
  $("#edDelete").innerHTML = `${icon("trash")}Удалить`;
  $("#edDelete").classList.remove("confirm");
  $("#edKinds").style.display = ed.id ? "none" : "";
  applyKind();
  $("#overlay").classList.add("open");
  setTimeout(() => $("#edTitle").focus(), 60);
}

function applyKind() {
  const ed = S.ed, ui = KIND_UI[ed.kind];
  $(".modal").dataset.kind = ed.kind;
  $("#edMode").textContent = ed.id ? ui.edit : ui.mode;
  $("#edTitle").placeholder = ui.ph;
  $("#edNoteLabel").textContent = ui.note;
  $("#edNote").placeholder = ui.notePh;
  $("#edDateLabel").textContent = ui.date;
  document.querySelectorAll("#edKinds button").forEach((b) => b.classList.toggle("on", b.dataset.v === ed.kind));
  document.querySelectorAll(".modal [data-kinds]").forEach((f) => (f.hidden = !f.dataset.kinds.split(" ").includes(ed.kind)));
  $("#edPresets").innerHTML = TIME_PRESETS.map((t) => `<button data-act="preset" data-v="${t}">${t}</button>`).join("");
  markPreset();
  renderEdChoices();
  updateEdHead();
  checkVacOverlap();
}

function markPreset() {
  const t = $("#edTime").value.trim();
  document.querySelectorAll("#edPresets button").forEach((b) => b.classList.toggle("on", b.dataset.v === t));
}

function renderEdChoices() {
  const ed = S.ed;
  $("#edCats").innerHTML = Object.entries(S.categories).map(([k, t]) =>
    `<button class="fchip${ed.category === k ? " on" : ""}" style="--c:${CAT_COLORS[k]}" data-act="ed-cat" data-v="${k}">${icon("cat-" + k)}${t}</button>`).join("");
  const tg = (act, on, ic, color, title, sub, disabled) => `<div class="ed-tg${disabled ? " off" : ""}" style="--c:${color}">
    <span class="tg-ic">${ic}</span><span class="tg-txt"><b>${title}</b><small>${sub}</small></span>
    <button class="switch${on ? " on" : ""}" data-act="${act}" role="switch" aria-checked="${on}" aria-label="${title}"${disabled ? " disabled" : ""}></button></div>`;
  $("#edToggles").innerHTML = tg("ed-important", ed.important, icon("flame"), IMPORTANT, "Приоритет", "Огненная рамка")
    + tg("ed-anim", ed.animated && !!ed.category, SPARK, "#F5C451", "Анимация", ed.category ? "Живая сцена" : "Выбери категорию", !ed.category);
  $("#edRepeat").innerHTML = Object.entries(S.repeats).map(([k, t]) =>
    `<button class="${ed.repeat === k ? "on" : ""}" data-act="ed-repeat" data-v="${k}">${t}</button>`).join("");
  const bd = parse(ed.date);
  $("#edRemind").innerHTML = REMIND_OPTS.map(([off, t]) => {
    const d = addDays(bd, -off);
    return `<button class="ck${ed.remind.includes(off) ? " on" : ""}" data-act="ed-remind" data-v="${off}">
      <span class="cb">${icon("check")}</span><span><b>${t}</b><small>${d.getDate()} ${MONTHS_GEN[d.getMonth()]}</small></span></button>`;
  }).join("");
  $("#edRemindAll").textContent = ed.remind.length === REMIND_OPTS.length ? "Снять все" : "Выбрать все";
  $("#edMute").classList.toggle("on", ed.mute_work);
  FX.playSeg();
}

function edDatePop(which = "start") {
  const ed = S.ed, cal = which === "end" ? ed.calEnd : ed.cal, cur = which === "end" ? ed.date_end : ed.date;
  const { y, m } = cal;
  const head = WD.map((w, i) => `<div class="wd${i > 4 ? " we" : ""}">${w}</div>`).join("");
  const days = monthGrid(y, m).map((d) => {
    const inRange = ed.kind === "vacation" && iso(d) >= ed.date && iso(d) <= ed.date_end;
    const cls = ["day", d.getMonth() !== m ? "out" : "", sameDay(d, S.today) ? "today" : "", iso(d) === cur ? "sel" : "", inRange ? "range" : ""].join(" ");
    return `<button class="${cls}" data-act="ed-pick" data-which="${which}" data-v="${iso(d)}">${d.getDate()}</button>`;
  }).join("");
  const title = ed.kind === "birthday" ? MONTHS[m] : `${MONTHS[m]} ${y}`;
  $(which === "end" ? "#edDatePopEnd" : "#edDatePop").innerHTML = `<div class="card-head"><h3>${title}</h3><div class="spacer"></div>
    <button class="icon-btn" data-act="ed-cal" data-which="${which}" data-v="-1">${icon("left")}</button>
    <button class="icon-btn" data-act="ed-cal" data-which="${which}" data-v="1">${icon("right")}</button></div>
    <div class="cal">${head}${days}</div>`;
}

function setEdDate(dateStr, which = "start") {
  const ed = S.ed, d = parse(dateStr);
  if (which === "end") {
    ed.date_end = dateStr;
    if (ed.date_end < ed.date) ed.date = dateStr;
  } else {
    ed.date = dateStr;
    ed.cal = { y: d.getFullYear(), m: d.getMonth() };
    if (ed.date_end < ed.date) ed.date_end = iso(addDays(d, 6));
  }
  if (ed.kind === "birthday") renderEdChoices();
  updateEdHead();
  checkVacOverlap();
}

async function checkVacOverlap() {
  const ed = S.ed, hint = $("#edVacHint");
  if (!ed || ed.kind !== "vacation") return (hint.hidden = true);
  const others = (await api("vacations", ed.date, ed.date_end)).filter((v) => v.id !== ed.id);
  if (S.ed !== ed) return;
  hint.hidden = !others.length;
  if (others.length) {
    const v = others[0], d1 = parse(v.start), d2 = parse(v.end);
    hint.innerHTML = `${icon("info")}<span>Пересекается с «${esc(v.title)}» (${d1.getDate()}–${d2.getDate()} ${MONTHS_GEN[d2.getMonth()].slice(0, 3)}.) — в календаре они сольются в один отпуск</span>`;
  }
}

const dmy = (d, withYear = true) => `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${withYear ? " " + d.getFullYear() : ""}`;

function updateEdHead() {
  const ed = S.ed, tv = $("#edTime").value, d = parse(ed.date);
  $("#edDay").textContent = d.getDate();
  $("#edMon").textContent = MONTHS_SHORT[d.getMonth()];
  if (ed.kind === "vacation") {
    const e = parse(ed.date_end), n = Math.round((e - d) / 864e5) + 1;
    $("#edDateText").textContent = `${WD[wdIndex(d)]}, ${dmy(d)}`;
    $("#edDateEndText").textContent = `${WD[wdIndex(e)]}, ${dmy(e)}`;
    $("#edWhen").textContent = `${dmy(d, false)} – ${dmy(e, false)} · ${n} ${plural(n, "день", "дня", "дней")}`;
    return;
  }
  if (ed.kind === "birthday") {
    $("#edDateText").textContent = dmy(d, false);
    const by = Number($("#edBYear").value);
    const age = by >= 1900 && by <= d.getFullYear() ? d.getFullYear() - by : null;
    $("#edAge").textContent = age ? `🎉 ${d.getFullYear() === S.today.getFullYear() ? "В этом году" : "В " + d.getFullYear()} исполнится ${age}` : "";
    const days = Math.round((d - S.today) / 864e5);
    const soon = days === 0 ? "сегодня!" : days === 1 ? "завтра" : `через ${days} ${plural(days, "день", "дня", "дней")}`;
    $("#edWhen").textContent = `${dmy(d, false)} · ${soon}${age ? ` · исполнится ${age}` : ""}`;
    return;
  }
  $("#edDateText").textContent = `${WD[wdIndex(d)]}, ${dmy(d)}`;
  const rep = ed.repeat !== "none" ? ` · ${S.repeats[ed.repeat].toLowerCase()}` : "";
  $("#edWhen").textContent = `${dayTitle(d)}${tv ? " · " + tv : ""}${rep}`;
}

function closeEditor() {
  $("#overlay").classList.remove("open");
  S.ed = null;
}

async function saveEditor() {
  const ed = S.ed;
  const time = $("#edTime").value.trim();
  if (ed.kind !== "vacation" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    $("#edError").textContent = "Время в формате ЧЧ:ММ, например 09:30";
    return;
  }
  const payload = { id: ed.id, kind: ed.kind, title: $("#edTitle").value, note: $("#edNote").value, date: ed.date,
    time, repeat: ed.repeat, category: ed.category, important: ed.important, animated: ed.animated && !!ed.category,
    birth_year: $("#edBYear").value.trim(), remind: ed.remind, date_end: ed.date_end, mute_work: ed.mute_work };
  const res = await api("save", payload);
  if (res.error) {
    $("#edError").textContent = res.error;
    return;
  }
  closeEditor();
  select(res.date);
  toast(ed.id ? "Изменения сохранены" : KIND_UI[ed.kind].saved);
  if (!ed.id && ed.kind === "birthday" && S.anim !== "off") FX.salute(); // салют — только для нового ДР
  refresh();
}

/* конфетти при открытии дня рождения */
function celebrate(anchor) {
  if (!anchor || S.anim === "off") return;
  const r = anchor.getBoundingClientRect();
  const colors = ["#F5C451", "#FF5C8A", "#5E6BFF", "#35D49A", "#FF7A1A", "#A27BFF"];
  for (let i = 0; i < 26; i++) {
    const c = document.createElement("i");
    c.className = "confetto";
    c.style.background = colors[i % colors.length];
    c.style.left = r.left + r.width / 2 + "px";
    c.style.top = r.top + r.height / 2 + "px";
    document.body.appendChild(c);
    const ang = Math.random() * Math.PI * 2, sp = 70 + Math.random() * 110;
    const dx = Math.cos(ang) * sp, dy = Math.sin(ang) * sp - 60;
    c.animate([
      { transform: "translate(-50%,-50%) rotate(0deg)", opacity: 1 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${200 + Math.random() * 300}deg)`, opacity: 1, offset: .6 },
      { transform: `translate(calc(-50% + ${dx * 1.15}px), calc(-50% + ${dy + 90}px)) rotate(${400 + Math.random() * 300}deg)`, opacity: 0 }
    ], { duration: 1100 + Math.random() * 500, easing: "cubic-bezier(.2,.7,.4,1)" }).onfinish = () => c.remove();
  }
}

/* ===================== Контекстное меню ===================== */
function openMenu(btn) {
  const item = btn.closest(".item");
  S.ctx = { id: item.dataset.id, date: item.dataset.date, armed: false, opened: Date.now() };
  const done = item.classList.contains("done");
  const ctx = $("#ctx");
  ctx.innerHTML = `<button data-act="m-edit">${icon("edit")}Изменить</button>
    ${item.classList.contains("bday") ? "" : `<button data-act="m-toggle">${icon("check")}${done ? "Снять отметку" : "Отметить выполненным"}</button>`}
    <button class="red" data-act="m-delete">${icon("trash")}Удалить</button>`;
  ctx.classList.add("open");
  const r = btn.getBoundingClientRect(), w = ctx.offsetWidth, h = ctx.offsetHeight;
  ctx.style.left = `${Math.min(r.right - w, innerWidth - w - 10)}px`;
  ctx.style.top = `${r.bottom + h + 8 > innerHeight ? r.top - h - 6 : r.bottom + 6}px`;
}
const closeMenu = () => { $("#ctx").classList.remove("open"); S.ctx = null; };

async function toggleDone(id, date) {
  const state = await api("toggle_done", id, date);
  if (state) { toast(phrase("doneToast")); S.justDone = [id, date]; }
  refresh();
}

/* ===================== Обработчики ===================== */
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act], [data-page]");
  if (!e.target.closest("#ctx")) closeMenu();
  if (S.mp && !e.target.closest(".mpop") && !e.target.closest("[data-act=mp-open]")) closeMonthPicker();
  if (S.ed && !e.target.closest(".datefield")) { $("#edDatePop").classList.remove("open"); $("#edDatePopEnd").classList.remove("open"); }
  if (!el) {
    if (e.target === $("#overlay")) closeEditor();
    return;
  }
  const act = el.dataset.act;
  const holder = el.closest("[data-id]");
  const id = el.dataset.id || holder?.dataset.id;
  const date = holder?.dataset.date;

  if (!act) return go(el.dataset.page);
  if (el.matches(".seg button") && !el.classList.contains("on") && !el.closest("#edKinds")) FX.captureSeg(el);
  switch (act) {
    case "add": return openNew(iso(S.page === "home" || S.page === "calendar" ? S.selected : S.today));
    case "add-day": return openNew(el.dataset.date);
    case "pick": {
      if (el.dataset.date === iso(S.selected) && !el.classList.contains("out")) return openNew(el.dataset.date);
      const grid = el.closest(".cal, .bigcal"), big = grid.classList.contains("bigcal");
      const oldDate = grid.querySelector(".sel")?.dataset.date, view = S.view;
      select(el.dataset.date);
      const sameMonth = view.y === S.view.y && view.m === S.view.m;
      await refresh();
      if (sameMonth && oldDate) {
        const g = $(big ? ".bigcal" : ".cal");
        FX.pour(g, g?.querySelector(`[data-date="${oldDate}"]`), g?.querySelector(".sel"), { fadeOut: big });
      }
      return;
    }
    case "prev": case "next": {
      let { y, m } = S.view;
      m += act === "next" ? 1 : -1;
      if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
      S.slide = act === "next" ? 1 : -1;
      S.view = { y, m };
      return refresh();
    }
    case "today": select(iso(S.today)); return refresh();
    case "mp-open": {
      if (S.mp) return closeMonthPicker();
      return openMonthPicker(el.closest(".mp-anchor"), S.view.y);
    }
    case "mp-year": return openMonthPicker(S.mp.anchor, S.mp.year + Number(el.dataset.v));
    case "mp-month": {
      const y = S.mp.year, m = Number(el.dataset.v);
      closeMonthPicker();
      S.slide = (y * 12 + m) - (S.view.y * 12 + S.view.m);
      S.view = { y, m };
      return refresh();
    }
    case "toggle": return toggleDone(id, date);
    case "edit": return openEditor(id);
    case "menu": e.stopPropagation(); return openMenu(el);
    case "m-edit": { const c = S.ctx; closeMenu(); return openEditor(c.id); }
    case "m-toggle": { const c = S.ctx; closeMenu(); return toggleDone(c.id, c.date); }
    case "m-delete": {
      if (!S.ctx.armed) {
        S.ctx.armed = true;
        el.classList.add("confirm");
        el.innerHTML = `${icon("trash")}Точно удалить? Нажми ещё раз`;
        return;
      }
      const c = S.ctx; closeMenu();
      await api("delete", c.id);
      toast("Удалено");
      return refresh();
    }
    case "range": S.allRange = el.dataset.v; return refresh();
    case "cat": S.allCat = el.dataset.v; return refresh();
    case "period": S.statsPeriod = el.dataset.v; return refresh();
    case "theme": return FX.theme(el, () => saveSettings({ theme: S.settings.theme === "dark" ? "light" : "dark" }));
    case "set-theme": return el.classList.contains("on") ? null : FX.theme(el, () => saveSettings({ theme: el.dataset.v }));
    case "set-snooze": return saveSettings({ snooze_minutes: Number(el.dataset.v) });
    case "snz-open": {
      e.stopPropagation();
      const pop = el.closest(".snz").querySelector(".snz-pop");
      pop.hidden = !pop.hidden;
      if (!pop.hidden) setTimeout(() => document.addEventListener("click", () => (pop.hidden = true), { once: true }));
      return;
    }
    case "set-gender": return saveSettings({ gender: el.dataset.v });
    case "set-anim": return saveSettings({ anim_effect: el.dataset.v });
    case "set-speed": return saveSettings({ anim_speed: el.dataset.v });
    case "switch": return saveSettings({ [el.dataset.key]: !S.settings[el.dataset.key] });
    case "quit": return api("quit");
    // редактор
    case "close-editor": return closeEditor();
    case "ed-save": return saveEditor();
    case "ed-cat": S.ed.category = S.ed.category === el.dataset.v ? "" : el.dataset.v;
      if (!S.ed.category) S.ed.animated = false;
      return renderEdChoices();
    case "ed-anim": if (S.ed.category) S.ed.animated = !S.ed.animated; return renderEdChoices();
    case "ed-important": S.ed.important = !S.ed.important; return renderEdChoices();
    case "ed-repeat": S.ed.repeat = el.dataset.v; renderEdChoices(); return updateEdHead();
    case "ed-kind": {
      if (S.ed.kind === el.dataset.v) return;
      return FX.kindSwitch(el.dataset.v, () => {
        S.ed.kind = el.dataset.v;
        if (S.ed.kind === "birthday" && !S.ed.id) $("#edTime").value = "10:00";
        // поздно вечером напоминание «на сегодня» переезжает на завтра; ДР и отпуск остаются на выбранный день
        if (!S.ed.id && S.ed.kind !== "reminder" && S.ed.asked && S.ed.date !== S.ed.asked) {
          S.ed.date_end = iso(addDays(parse(S.ed.asked), 6));
          setEdDate(S.ed.asked, "start");
        }
        $("#edError").textContent = "";
        applyKind();
      });
    }
    case "ed-remind": {
      const off = Number(el.dataset.v), r = S.ed.remind;
      S.ed.remind = r.includes(off) ? r.filter((x) => x !== off) : [...r, off].sort((a, b) => a - b);
      return renderEdChoices();
    }
    case "ed-remind-all":
      S.ed.remind = S.ed.remind.length === REMIND_OPTS.length ? [] : REMIND_OPTS.map(([o]) => o);
      return renderEdChoices();
    case "ed-mute": S.ed.mute_work = !S.ed.mute_work; return renderEdChoices();
    case "preset": {
      $("#edTime").value = el.dataset.v; // меняем только время — дата остаётся той, что выбрана
      markPreset();
      return updateEdHead();
    }
    case "ed-datepick": {
      const which = el.dataset.which || "start";
      const pop = $(which === "end" ? "#edDatePopEnd" : "#edDatePop");
      $(which === "end" ? "#edDatePop" : "#edDatePopEnd").classList.remove("open");
      if (!pop.classList.contains("open")) {
        if (which === "end") { const d = parse(S.ed.date_end); S.ed.calEnd = { y: d.getFullYear(), m: d.getMonth() }; }
        edDatePop(which);
      }
      return pop.classList.toggle("open");
    }
    case "ed-cal": {
      const which = el.dataset.which || "start", key = which === "end" ? "calEnd" : "cal";
      let { y, m } = S.ed[key];
      m += Number(el.dataset.v);
      if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
      S.ed[key] = { y, m };
      return edDatePop(which);
    }
    case "ed-pick": {
      const which = el.dataset.which || "start";
      setEdDate(el.dataset.v, which);
      $("#edError").textContent = "";
      return $(which === "end" ? "#edDatePopEnd" : "#edDatePop").classList.remove("open");
    }
    case "ed-delete": {
      if (!el.classList.contains("confirm")) {
        el.classList.add("confirm");
        el.innerHTML = `${icon("trash")}Точно удалить?`;
        return;
      }
      await api("delete", S.ed.id);
      closeEditor();
      toast("Удалено");
      return refresh();
    }
  }
});

async function saveSettings(values) {
  S.settings = await api("save_settings", values);
  applyTheme();
  applyAnim();
  return refresh();
}

document.addEventListener("change", (e) => {
  if (e.target.id === "setName") saveSettings({ name: e.target.value.trim() });
});
$("#edTitle").addEventListener("input", () => ($("#edError").textContent = ""));
$("#edTime").addEventListener("input", () => markPreset());

/* свечи на торте: гаснет та, на которую навёл; загорается сама, когда уведёшь мышку */
const RELIGHT_AFTER = 2500;
document.addEventListener("mouseover", (e) => {
  const hit = e.target.closest?.(".cake .hit");
  if (!hit) return;
  const w = hit.closest(".wick");
  clearTimeout(w._t);
  w.classList.remove("relight");
  w.classList.add("out");
});
document.addEventListener("mouseout", (e) => {
  const hit = e.target.closest?.(".cake .hit");
  if (!hit) return;
  const w = hit.closest(".wick");
  clearTimeout(w._t);
  w._t = setTimeout(() => {
    w.classList.remove("out");
    w.classList.add("relight");
    w._t = setTimeout(() => w.classList.remove("relight"), 900);
  }, RELIGHT_AFTER);
});
$("#edBYear").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4);
  $("#edError").textContent = "";
  updateEdHead();
});
$("#edTime").addEventListener("input", (e) => {
  // маска ЧЧ:ММ — только цифры, двоеточие подставляется само
  const digits = e.target.value.replace(/\D/g, "").slice(0, 4);
  e.target.value = digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
  $("#edError").textContent = "";
  updateEdHead();
});
// закрываем меню при прокрутке, но не от «эха» прокрутки сразу после открытия
$("#main").addEventListener("scroll", () => { if (S.ctx && Date.now() - S.ctx.opened > 200) closeMenu(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeMenu(); closeMonthPicker(); if (S.ed) closeEditor(); }
  if (S.ed && e.key === "Enter" && (e.ctrlKey || e.target.id === "edTitle")) { e.preventDefault(); saveEditor(); }
  if (!S.ed && e.ctrlKey && e.key.toLowerCase() === "n") { e.preventDefault(); openNew(iso(S.selected)); }
});

/* ===================== Старт ===================== */
window.app = { refresh: () => refresh(), openEditor, go };

(async function init() {
  const info = await api("init");
  S.settings = info.settings;
  S.categories = info.categories;
  S.repeats = info.repeats;
  S.canAutostart = info.canAutostart;
  select(info.today);
  applyTheme();
  applyAnim();
  const start = new URLSearchParams(location.search).get("page");
  if (start && PAGES.hasOwnProperty(start)) S.page = start;
  await refresh();
  // смена дня и статуса «пропущено»
  setInterval(() => refresh(), 60000);
})();

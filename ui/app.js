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
const TIME_PRESETS = ["09:00", "12:00", "15:00", "18:00", "21:00"];
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
  ed: null, ctx: null,
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

function itemRow(it, { withDate = false } = {}) {
  const missed = it.past && !it.done;
  const cls = ["item", it.done ? "done" : "", missed ? "missed" : "", it.important ? "hot" : ""].filter(Boolean).join(" ");
  const d = parse(it.date);
  const left = withDate ? dateBlock(d) : `<div class="time">${it.time}</div><div class="vsep"></div>`;
  let meta = "";
  if (withDate) meta = `${relDay(d)} · ${it.time}${missed ? " · пропущено" : ""}`;
  else if (it.note) meta = it.note.split("\n")[0];
  return `<div class="${cls}" data-id="${it.id}" data-date="${it.date}">
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
  return `<div class="card-head"><h3>${MONTHS[m]} ${y}</h3><div class="spacer"></div>
    <div class="cal-nav">
      <button class="icon-btn" data-act="prev" title="Предыдущий месяц">${icon("left")}</button>
      <button class="icon-btn" data-act="next" title="Следующий месяц">${icon("right")}</button>
    </div></div>`;
}

function miniCal(marks, hot = []) {
  const { y, m } = S.view;
  const head = WD.map((w, i) => `<div class="wd${i > 4 ? " we" : ""}">${w}</div>`).join("");
  const days = monthGrid(y, m).map((d) => {
    const key = iso(d), n = Math.min(marks[key] || 0, 3);
    const isHot = hot.includes(key);
    const cls = ["day", d.getMonth() !== m ? "out" : "", sameDay(d, S.today) ? "today" : "", sameDay(d, S.selected) ? "sel" : "", isHot ? "hot" : ""].join(" ");
    const dots = n ? `<span class="dot">${"<i></i>".repeat(n)}</span>` : "";
    const flame = isHot ? `<span class="flame">${icon("flame")}</span>` : "";
    return `<button class="${cls}" data-act="pick" data-date="${key}">${d.getDate()}${dots}${flame}</button>`;
  }).join("");
  return calHead() + `<div class="cal">${head}${days}</div>`;
}

function ringSvg(pct, id) {
  const r = 42, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
  return `<svg viewBox="0 0 100 100"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2ECDB5"/><stop offset="1" stop-color="#5E6BFF"/></linearGradient></defs>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--card-3)" stroke-width="10"/>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="url(#${id})" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${pct ? off : c}"/></svg>`;
}

/* ===================== Страницы ===================== */
async function renderHome() {
  const sel = S.selected, { y, m } = S.view;
  const [marks, dayItems, upcoming, week, hot] = await Promise.all([
    api("month", y, m + 1),
    api("range", iso(sel), iso(sel)),
    api("range", iso(addDays(S.today, 1)), iso(addDays(S.today, 7))),
    api("stats", "week"),
    api("hot", y, m + 1),
  ]);
  const todayLeft = S.todayItems.filter((i) => !i.done && !i.past).length;
  const isToday = sameDay(sel, S.today);

  const dayList = dayItems.length
    ? `<div class="list">${dayItems.map((i) => itemRow(i)).join("")}</div>`
    : emptyHtml(isToday ? "На сегодня пусто" : "На этот день пусто", "Добавь напоминание — и оно не потеряется", iso(sel));

  const up = upcoming.filter((i) => !i.done).slice(0, 4);
  const upList = up.length
    ? `<div class="list">${up.map((i) => itemRow(i, { withDate: true })).join("")}</div>`
    : `<div class="empty" style="padding:20px">На неделю вперёд ничего не запланировано</div>`;

  return `<div class="grid-home">
    <div class="card">
      ${miniCal(marks, hot)}
      <button class="summary" data-page="all">
        <span class="ic">${icon("target")}</span>
        <span><b>Сегодня ${remindersWord(S.todayItems.length)}</b>
        <small>${todayLeft ? `Осталось ${todayLeft} до конца дня` : "Всё сделано — красавчик"}</small></span>
        <span class="chev">${icon("right")}</span>
      </button>
    </div>
    <div class="card">
      <div class="card-head"><h3>${isToday ? "Сегодня" : esc(dayTitle(sel))}</h3><span class="badge">${dayItems.length}</span>
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

async function renderCalendar() {
  const { y, m } = S.view;
  const grid = monthGrid(y, m, 6);
  const [items, dayItems] = await Promise.all([
    api("range", iso(grid[0]), iso(grid[grid.length - 1])),
    api("range", iso(S.selected), iso(S.selected)),
  ]);
  const byDay = {};
  items.forEach((i) => (byDay[i.date] ||= []).push(i));

  const head = WD.map((w) => `<div class="wd">${w}</div>`).join("");
  const cells = grid.map((d) => {
    const key = iso(d), list = byDay[key] || [];
    const isHot = list.some((i) => i.important && !i.done);
    const cls = ["cell", d.getMonth() !== m ? "out" : "", sameDay(d, S.today) ? "today" : "", sameDay(d, S.selected) ? "sel" : "", isHot ? "hot" : ""].join(" ");
    const sorted = [...list].sort((a, b) => (b.important && !b.done) - (a.important && !a.done));
    const chips = sorted.slice(0, 2).map((i) =>
      `<span class="chip${i.done ? " done" : ""}${i.important ? " hot" : ""}" style="--c:${i.important ? IMPORTANT : CAT_COLORS[i.category] || "var(--accent)"}" title="${i.time} ${esc(i.title)}">${i.important ? icon("flame") : ""}${esc(i.title)}</span>`).join("");
    const more = list.length > 2 ? `<span class="more-n">ещё ${list.length - 2}</span>` : "";
    return `<button class="${cls}" data-act="pick" data-date="${key}"><span class="n">${d.getDate()}</span>${isHot ? `<span class="flame">${icon("flame")}</span>` : ""}${chips}${more}</button>`;
  }).join("");

  const dayList = dayItems.length
    ? `<div class="list">${dayItems.map((i) => itemRow(i)).join("")}</div>`
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
  let items = await api("range", iso(S.today), iso(addDays(S.today, span)));
  const total = items.length;
  if (S.allCat) items = items.filter((i) => (S.allCat === "important" ? i.important : i.category === S.allCat));

  const seg = [["day", "День"], ["week", "Неделя"], ["month", "Месяц"]]
    .map(([k, t]) => `<button class="${S.allRange === k ? "on" : ""}" data-act="range" data-v="${k}">${t}</button>`).join("");
  const chips = [["", "Все", "", "bell"], ...Object.entries(S.categories).map(([k, t]) => [k, t, CAT_COLORS[k], "cat-" + k]), ["important", "Приоритет", IMPORTANT, "flame"]]
    .map(([k, t, c, ic]) => `<button class="fchip${S.allCat === k ? " on" : ""}" style="${c ? `--c:${c}` : ""}" data-act="cat" data-v="${k}">${icon(ic)}${t}</button>`).join("");

  const list = items.length
    ? `<div class="list">${items.map((i) => itemRow(i, { withDate: true })).join("")}</div>`
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

function renderSettings() {
  const st = S.settings;
  const seg = (act, opts, cur) => `<div class="seg">${opts.map(([v, t]) =>
    `<button class="${String(cur) === String(v) ? "on" : ""}" data-act="${act}" data-v="${v}">${t}</button>`).join("")}</div>`;
  const sw = (key, on, disabled) => `<button class="switch${on ? " on" : ""}" data-act="switch" data-key="${key}" ${disabled ? "disabled" : ""}></button>`;
  return `<div class="settings">
    <div class="card"><div class="card-head"><h3>Профиль и вид</h3></div>
      <div class="setting"><span class="ic">${icon("user")}</span>
        <div class="txt"><b>Как тебя зовут</b><small>Для приветствия на главной</small></div>
        <input class="input" id="setName" style="width:170px" maxlength="30" value="${esc(st.name)}"></div>
      <div class="setting"><span class="ic">${icon(st.theme === "dark" ? "moon" : "sun")}</span>
        <div class="txt"><b>Тема</b><small>Можно переключать и кнопкой в меню</small></div>
        ${seg("set-theme", [["dark", "Тёмная"], ["light", "Светлая"]], st.theme)}</div>
    </div>
    <div class="card"><div class="card-head"><h3>Уведомления</h3></div>
      <div class="setting"><span class="ic">${icon("volume")}</span>
        <div class="txt"><b>Звук</b><small>Сигнал при появлении напоминания</small></div>${sw("sound", st.sound)}</div>
      <div class="setting"><span class="ic">${icon("snooze")}</span>
        <div class="txt"><b>Откладывать на</b><small>Кнопка «Позже» в уведомлении</small></div>
        ${seg("set-snooze", [[5, "5"], [10, "10"], [15, "15"], [30, "30 мин"]], st.snooze_minutes)}</div>
      <div class="setting"><span class="ic">${icon("power")}</span>
        <div class="txt"><b>Запускать вместе с Windows</b>
        <small>${S.canAutostart ? "Чтобы напоминания работали всегда" : "Доступно в собранной exe-версии"}</small></div>
        ${sw("autostart", st.autostart, !S.canAutostart)}</div>
    </div>
  </div>`;
}

/* ===================== Обновление ===================== */
function applyTheme() {
  document.body.dataset.theme = S.settings.theme;
  $("#themeBtn").innerHTML = `${icon(S.settings.theme === "dark" ? "sun" : "moon")}<span>${S.settings.theme === "dark" ? "Светлая" : "Тёмная"}</span>`;
}

function renderChrome() {
  const items = S.todayItems, done = items.filter((i) => i.done).length;
  $("#sideValue").textContent = items.length ? `${done} из ${items.length} выполнено` : "Ничего не запланировано";
  $("#sideBar").style.width = items.length ? `${Math.round((done / items.length) * 100)}%` : "0";
  $("#chipDate").textContent = fullDate(S.today);
  $("#chipSub").textContent = remindersWord(items.length);
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === S.page));

  if (S.page === "home") {
    $("#heroTitle").textContent = `Привет, ${S.settings.name || "друг"} 👋`;
    const left = items.filter((i) => !i.done && !i.past).length;
    $("#heroSub").textContent = !items.length
      ? "На сегодня ничего не запланировано. Самое время добавить первое дело."
      : left ? `Сегодня ${remindersWord(items.length)}, осталось ${left}. Ты справишься!`
        : `На сегодня всё позади (${remindersWord(items.length)}). Отличный день!`;
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
  page.innerHTML = html;
  if (animate) { page.style.animation = "none"; void page.offsetWidth; page.style.animation = ""; }
}

function go(page) {
  if (!PAGES.hasOwnProperty(page)) return;
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
async function openEditor(id) {
  const r = await api("get", id);
  if (!r) return toast("Напоминание не найдено");
  showEditor({ id: r.id, title: r.title, note: r.note || "", date: r.date, time: r.time,
    repeat: r.repeat, category: r.category || "", important: !!r.important });
}

function openNew(dateStr) {
  const now = new Date();
  let time = "09:00";
  if (dateStr === iso(S.today)) {
    const t = new Date(now.getTime() + 20 * 60000);
    t.setMinutes(Math.ceil(t.getMinutes() / 5) * 5);
    if (iso(t) !== dateStr) dateStr = iso(t);
    time = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }
  showEditor({ id: null, title: "", note: "", date: dateStr, time, repeat: "none", category: "", important: false });
}

function showEditor(ed) {
  S.ed = ed;
  $("#edMode").textContent = ed.id ? "Редактирование" : "Новое напоминание";
  $("#edTitle").value = ed.title;
  $("#edNote").value = ed.note;
  ed.cal = { y: parse(ed.date).getFullYear(), m: parse(ed.date).getMonth() };
  $("#edTime").value = ed.time;
  $("#edDatePop").classList.remove("open");
  $("#edError").textContent = "";
  $("#edDelete").style.display = ed.id ? "" : "none";
  $("#edDelete").innerHTML = `${icon("trash")}Удалить`;
  $("#edDelete").classList.remove("confirm");
  $("#edPresets").innerHTML = ["+15 мин", "+1 час", ...TIME_PRESETS]
    .map((t) => `<button data-act="preset" data-v="${t}">${t}</button>`).join("");
  renderEdChoices();
  updateEdHead();
  $("#overlay").classList.add("open");
  setTimeout(() => $("#edTitle").focus(), 60);
}

function renderEdChoices() {
  const ed = S.ed;
  $("#edCats").innerHTML = Object.entries(S.categories).map(([k, t]) =>
    `<button class="fchip${ed.category === k ? " on" : ""}" style="--c:${CAT_COLORS[k]}" data-act="ed-cat" data-v="${k}">${icon("cat-" + k)}${t}</button>`).join("")
    + `<button class="fchip${ed.important ? " on" : ""}" style="--c:${IMPORTANT}" data-act="ed-important">${icon("flame")}Приоритет</button>`;
  $("#edRepeat").innerHTML = Object.entries(S.repeats).map(([k, t]) =>
    `<button class="${ed.repeat === k ? "on" : ""}" data-act="ed-repeat" data-v="${k}">${t}</button>`).join("");
}

function edDatePop() {
  const { y, m } = S.ed.cal;
  const head = WD.map((w, i) => `<div class="wd${i > 4 ? " we" : ""}">${w}</div>`).join("");
  const days = monthGrid(y, m).map((d) => {
    const cls = ["day", d.getMonth() !== m ? "out" : "", sameDay(d, S.today) ? "today" : "", iso(d) === S.ed.date ? "sel" : ""].join(" ");
    return `<button class="${cls}" data-act="ed-pick" data-v="${iso(d)}">${d.getDate()}</button>`;
  }).join("");
  $("#edDatePop").innerHTML = `<div class="card-head"><h3>${MONTHS[m]} ${y}</h3><div class="spacer"></div>
    <button class="icon-btn" data-act="ed-cal" data-v="-1">${icon("left")}</button>
    <button class="icon-btn" data-act="ed-cal" data-v="1">${icon("right")}</button></div>
    <div class="cal">${head}${days}</div>`;
}

function setEdDate(dateStr) {
  S.ed.date = dateStr;
  const d = parse(dateStr);
  S.ed.cal = { y: d.getFullYear(), m: d.getMonth() };
  updateEdHead();
}

function updateEdHead() {
  const tv = $("#edTime").value;
  const d = parse(S.ed.date);
  $("#edDateText").textContent = `${WD[wdIndex(d)]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
  $("#edDay").textContent = d.getDate();
  $("#edMon").textContent = MONTHS_SHORT[d.getMonth()];
  const rep = S.ed.repeat !== "none" ? ` · ${S.repeats[S.ed.repeat].toLowerCase()}` : "";
  $("#edWhen").textContent = `${dayTitle(d)}${tv ? " · " + tv : ""}${rep}`;
}

function closeEditor() {
  $("#overlay").classList.remove("open");
  S.ed = null;
}

async function saveEditor() {
  const ed = S.ed;
  const time = $("#edTime").value.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    $("#edError").textContent = "Время в формате ЧЧ:ММ, например 09:30";
    return;
  }
  const payload = { id: ed.id, title: $("#edTitle").value, note: $("#edNote").value, date: ed.date,
    time, repeat: ed.repeat, category: ed.category, important: ed.important };
  const res = await api("save", payload);
  if (res.error) {
    $("#edError").textContent = res.error;
    return;
  }
  closeEditor();
  select(res.date);
  toast(ed.id ? "Изменения сохранены" : "Напоминание добавлено");
  refresh();
}

/* ===================== Контекстное меню ===================== */
function openMenu(btn) {
  const item = btn.closest(".item");
  S.ctx = { id: item.dataset.id, date: item.dataset.date, armed: false, opened: Date.now() };
  const done = item.classList.contains("done");
  const ctx = $("#ctx");
  ctx.innerHTML = `<button data-act="m-edit">${icon("edit")}Изменить</button>
    <button data-act="m-toggle">${icon("check")}${done ? "Снять отметку" : "Отметить выполненным"}</button>
    <button class="red" data-act="m-delete">${icon("trash")}Удалить</button>`;
  ctx.classList.add("open");
  const r = btn.getBoundingClientRect(), w = ctx.offsetWidth, h = ctx.offsetHeight;
  ctx.style.left = `${Math.min(r.right - w, innerWidth - w - 10)}px`;
  ctx.style.top = `${r.bottom + h + 8 > innerHeight ? r.top - h - 6 : r.bottom + 6}px`;
}
const closeMenu = () => { $("#ctx").classList.remove("open"); S.ctx = null; };

async function toggleDone(id, date) {
  const state = await api("toggle_done", id, date);
  if (state) toast("Отмечено как выполненное");
  refresh();
}

/* ===================== Обработчики ===================== */
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act], [data-page]");
  if (!e.target.closest("#ctx")) closeMenu();
  if (S.ed && !e.target.closest(".datefield")) $("#edDatePop").classList.remove("open");
  if (!el) {
    if (e.target === $("#overlay")) closeEditor();
    return;
  }
  const act = el.dataset.act;
  const holder = el.closest("[data-id]");
  const id = el.dataset.id || holder?.dataset.id;
  const date = holder?.dataset.date;

  if (!act) return go(el.dataset.page);
  switch (act) {
    case "add": return openNew(iso(S.page === "home" || S.page === "calendar" ? S.selected : S.today));
    case "add-day": return openNew(el.dataset.date);
    case "pick": {
      if (el.dataset.date === iso(S.selected) && !el.classList.contains("out")) return openNew(el.dataset.date);
      select(el.dataset.date);
      return refresh();
    }
    case "prev": case "next": {
      let { y, m } = S.view;
      m += act === "next" ? 1 : -1;
      if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
      S.view = { y, m };
      return refresh();
    }
    case "today": select(iso(S.today)); return refresh();
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
    case "theme": return saveSettings({ theme: S.settings.theme === "dark" ? "light" : "dark" });
    case "set-theme": return saveSettings({ theme: el.dataset.v });
    case "set-snooze": return saveSettings({ snooze_minutes: Number(el.dataset.v) });
    case "switch": return saveSettings({ [el.dataset.key]: !S.settings[el.dataset.key] });
    case "quit": return api("quit");
    // редактор
    case "close-editor": return closeEditor();
    case "ed-save": return saveEditor();
    case "ed-cat": S.ed.category = S.ed.category === el.dataset.v ? "" : el.dataset.v; return renderEdChoices();
    case "ed-important": S.ed.important = !S.ed.important; return renderEdChoices();
    case "ed-repeat": S.ed.repeat = el.dataset.v; renderEdChoices(); return updateEdHead();
    case "preset": {
      const v = el.dataset.v;
      if (v.startsWith("+")) {
        const t = new Date(Date.now() + (v.includes("час") ? 60 : 15) * 60000);
        setEdDate(iso(t));
        $("#edTime").value = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
      } else {
        $("#edTime").value = v;
      }
      return updateEdHead();
    }
    case "ed-datepick": {
      const pop = $("#edDatePop");
      if (!pop.classList.contains("open")) edDatePop();
      return pop.classList.toggle("open");
    }
    case "ed-cal": {
      let { y, m } = S.ed.cal;
      m += Number(el.dataset.v);
      if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
      S.ed.cal = { y, m };
      return edDatePop();
    }
    case "ed-pick":
      setEdDate(el.dataset.v);
      $("#edError").textContent = "";
      return $("#edDatePop").classList.remove("open");
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
  refresh();
}

document.addEventListener("change", (e) => {
  if (e.target.id === "setName") saveSettings({ name: e.target.value.trim() });
});
$("#edTitle").addEventListener("input", () => ($("#edError").textContent = ""));
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
  if (e.key === "Escape") { closeMenu(); if (S.ed) closeEditor(); }
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
  const start = new URLSearchParams(location.search).get("page");
  if (start && PAGES.hasOwnProperty(start)) S.page = start;
  await refresh();
  // смена дня и статуса «пропущено»
  setInterval(() => refresh(), 60000);
})();

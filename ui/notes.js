"use strict";
/* Раздел «Заметки».
 *  Экран: шапка (поиск, «Новая заметка» + шаблоны), вкладки (Все / Избранное / Недавние / Папки),
 *  три колонки — список, редактор, свойства (сворачиваются; в узком окне выезжают поверх текста).
 *  Текст хранится в Markdown, редактируется как оформленный (ui/mdedit.js).
 *  Автосохранение: правки уходят через 0.5 с тишины, строго по очереди; при сбое — повтор через 3 с,
 *  копия текста лежит в localStorage до подтверждения записи.
 *  Связь с напоминаниями: выделил текст → напоминание; связанные — в свойствах; из напоминания — в заметку.
 *  Удаление без корзины: «Сдвинь, чтобы удалить» — заметка сгорает.
 * Зависит от app.js: S, api, $, esc, icon, toast, plural, parse, iso, addDays, MONTHS_*, CAT_COLORS, FX, go, openNewFrom.
 */
const NOTES = (() => {
  const SAVE_DELAY = 500, RETRY_DELAY = 3000, BODY_SYNC = 150, RECENT_DAYS = 7, HOLD_MS = 1200;
  const DRAFTS_KEY = "flint-note-drafts";
  const ICONS = { "": "note", note: "note", todo: "todo", bag: "bag", bulb: "bulb", book: "book", calendar: "calendar" };
  const N = {
    list: [], folders: [], rem: [], cur: null, q: "", filter: "all", folder: null, tag: "", props: null, loading: null,
    dirty: {}, dirtyId: null, timer: null, bodyTimer: null, chain: Promise.resolve(), status: "saved", error: "",
    menu: null, fresh: new Set(),  // fresh — созданы в этой сессии: пустые такие при уходе удаляем молча
  };
  const cur = () => N.list.find((n) => n.id === N.cur) || null;
  const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е");
  const colorOf = (n) => (n.color ? CAT_COLORS[n.color] : "var(--accent)");

  /* ---------- шаблоны ---------- */
  const d0 = () => `${S.today.getDate()} ${MONTHS_GEN[S.today.getMonth()]}`;
  const TEMPLATES = [
    { key: "todo", icon: "todo", color: "work", title: "Список дел", desc: "Задачи, приоритеты, выполненные пункты",
      body: () => "### Сегодня\n\n- [ ] Самое важное\n- [ ] Второе дело\n\n### Когда будет время\n\n- [ ] " },
    { key: "bag", icon: "bag", color: "home", title: "Покупки", desc: "Список товаров и отметки о покупке", body: () => "- [ ] \n- [ ] \n- [ ] " },
    { key: "bulb", icon: "bulb", color: "growth", title: "Идея", desc: "Описание, зачем это нужно, следующие шаги",
      body: () => "### Суть\n\nОдной фразой: \n\n### Зачем это нужно\n\n- \n\n### Следующие шаги\n\n- [ ] " },
    { key: "book", icon: "book", color: "personal", title: "Дневник", desc: "Дата, события дня, мысли и итоги",
      body: () => `### ${d0()}\n\n**Что было:** \n\n**Мысли:** \n\n**Итог дня:** ` },
    { key: "", icon: "note", color: "", title: "Пустая", desc: "Чистый лист, курсор в заголовке", body: () => "" },
  ];

  /* ---------- черновики (страховка от потери текста) ---------- */
  function drafts() { try { return JSON.parse(localStorage.getItem(DRAFTS_KEY)) || {}; } catch { return {}; } }
  function draftsSet(d) { try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(d)); } catch { /* хранилище недоступно — живём без него */ } }
  function draftPut(n) { const d = drafts(); d[n.id] = { title: n.title, body: n.body }; draftsSet(d); }
  function draftDel(id) { const d = drafts(); if (id in d) { delete d[id]; draftsSet(d); } }

  /* ---------- даты ---------- */
  function when(stamp) {
    if (!stamp) return "";
    const [d, t] = stamp.split(" "), day = parse(d), hm = t.slice(0, 5);
    const diff = Math.round((S.today - day) / 864e5);
    if (diff === 0) return `Сегодня, ${hm}`;
    if (diff === 1) return `Вчера, ${hm}`;
    return `${day.getDate()} ${MONTHS_SHORT[day.getMonth()]} ${day.getFullYear()}`;
  }
  const whenFull = (stamp) => {
    if (!stamp) return "";
    const day = parse(stamp.slice(0, 10));
    return `${day.getDate()} ${MONTHS_SHORT[day.getMonth()]} ${day.getFullYear()}, ${stamp.slice(11, 16)}`;
  };
  const remWhen = (r) => { const d = parse(r.date); return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()} · ${r.time}`; };

  /* ---------- поиск и фильтры ---------- */
  function highlight(text, q) {
    if (!q) return esc(text);
    const at = norm(text).indexOf(q);
    if (at < 0) return esc(text);
    return esc(text.slice(0, at)) + "<mark>" + esc(text.slice(at, at + q.length)) + "</mark>" + esc(text.slice(at + q.length));
  }
  function snippet(n, q) {
    const p = MD.plain(n.body);
    const at = q ? norm(p).indexOf(q) : -1;
    if (at < 0) return esc(p);
    const from = Math.max(0, at - 30);
    return (from ? "…" : "") + highlight(p.slice(from), q);
  }
  const matches = (n, q) => !q || norm(n.title).includes(q) || norm(MD.plain(n.body)).includes(q) || n.tags.some((t) => norm(t).includes(q));

  function visible() {
    const q = norm(N.q.trim());
    let list = N.list.filter((n) => matches(n, q));
    if (N.filter === "fav") list = list.filter((n) => n.favorite);
    if (N.folder !== null) list = list.filter((n) => (n.folder || "") === N.folder);
    if (N.tag) list = list.filter((n) => n.tags.includes(N.tag));
    if (N.filter === "recent") {
      const edge = iso(addDays(S.today, -RECENT_DAYS));
      list = list.filter((n) => n.updated.slice(0, 10) >= edge).sort((a, b) => b.updated.localeCompare(a.updated));
    }
    return list;
  }

  /* ---------- разметка экрана ---------- */
  function shell() {
    return `<div class="notes-page" id="notesRoot">
      <div class="nhead">
        <div class="nh-ic">${icon("notes")}</div>
        <div class="nh-t"><h2>Заметки</h2><p>Мысли, планы и всё важное — в одном месте</p></div>
        <div class="nsearch">${icon("search")}<input class="input" id="nq" placeholder="Поиск по заметкам…" autocomplete="off" spellcheck="false">
          <kbd id="nqKbd">Ctrl+F</kbd><button class="icon-btn clr" data-act="nq-clear" title="Очистить (Esc)" hidden>${icon("x")}</button></div>
        <div class="nnew"><button class="btn btn-primary" data-act="n-new" title="Новая заметка (Ctrl+N)">${icon("plus")}Новая заметка</button>
          <button class="btn btn-primary more" data-act="n-tpl" title="Из шаблона" aria-label="Создать из шаблона">${icon("down")}</button></div>
      </div>
      <div class="ntabs" id="ntabs"></div>
      <div class="notes" id="notesCols">
        <section class="ncol nside"><div class="nl-head"><h3>Заметки</h3><span class="count" id="ncount"></span></div><div class="nlist" id="nlist"></div></section>
        <section class="ncol ned" id="ned"></section>
        <aside class="ncol nprops" id="nprops"></aside>
      </div>
    </div>`;
  }

  function menuHtml(items, extra = "") {
    return `<div class="nmenu${extra}">${items.map((it) => it === "-" ? `<div class="sep"></div>` : it).join("")}</div>`;
  }

  function renderTabs() {
    const box = $("#ntabs");
    if (!box) return;
    const fav = N.list.filter((n) => n.favorite).length;
    const counts = {};
    N.list.forEach((n) => (counts[n.folder || ""] = (counts[n.folder || ""] || 0) + 1));
    const tab = (v, ic, t, cnt) => `<button class="ntab${N.filter === v ? " on" : ""}" data-act="n-filter" data-v="${v}">${icon(ic)}${t}${cnt !== undefined ? ` <span class="n">${cnt}</span>` : ""}</button>`;
    const folderLabel = N.folder === null ? "Все папки" : N.folder || "Без папки";
    const fm = N.menu === "folders" ? menuHtml([
      `<button data-act="n-folder-filter" data-v="*">${icon("folder")}Все папки<span class="tick">${N.folder === null ? icon("check") : ""}</span></button>`,
      ...N.folders.map((f) => `<button data-act="n-folder-filter" data-v="${esc(f)}">${icon("folder")}${esc(f)}<small>${counts[f] || 0}</small><span class="tick">${N.folder === f ? icon("check") : ""}</span></button>`),
      ...(counts[""] ? [`<button data-act="n-folder-filter" data-v="">${icon("folder")}Без папки<small>${counts[""]}</small><span class="tick">${N.folder === "" ? icon("check") : ""}</span></button>`] : []),
      "-", `<button data-act="n-folder-new">${icon("plus")}Новая папка</button>`]) : "";
    box.innerHTML = tab("all", "template", "Все заметки", N.list.length) + tab("fav", "star", "Избранное", fav) + tab("recent", "clock", "Недавно изменённые")
      + `<div class="ndd"><button class="ntab${N.folder !== null ? " on" : ""}" data-act="n-menu" data-v="folders">${icon("folder")}${esc(folderLabel)}${icon("down")}</button>${fm}</div>`
      + (N.tag ? `<button class="ntab on" data-act="n-tag" data-v="" title="Сбросить фильтр по тегу">${icon("tag")}#${esc(N.tag)}${icon("x")}</button>` : "");
  }

  function cardHtml(n, q) {
    const c = colorOf(n);
    return `<button class="ncard${n.id === N.cur ? " cur" : ""}" data-act="n-open" data-nid="${n.id}" style="--c:${c}">
      <span class="ic">${icon(ICONS[n.icon] || "note")}</span>
      <span class="t">${n.title ? `<span>${highlight(n.title, q)}</span>` : `<span class="empty-t">Без названия</span>`}${n.favorite ? icon("star") : ""}</span>
      <span class="s">${snippet(n, q) || "&nbsp;"}</span>
      <span class="m">${n.folder ? `<span class="tag" style="--c:${c}">${esc(n.folder)}</span>` : ""}<time>${when(n.updated)}</time></span></button>`;
  }

  function renderList() {
    const box = $("#nlist");
    if (!box) return;
    const q = norm(N.q.trim()), list = visible();
    $("#ncount").textContent = list.length;
    if (list.length) box.innerHTML = list.map((n) => cardHtml(n, q)).join("");
    else if (!N.list.length) box.innerHTML = `<div class="empty"><div class="em-ic">${icon("note")}</div><b>Пока пусто</b>Запиши первую мысль — она не потеряется</div>`;
    else if (q) box.innerHTML = `<div class="empty"><div class="em-ic">${icon("search")}</div><b>Ничего не нашлось</b>Поиск идёт по заголовкам, тексту и тегам</div>`;
    else box.innerHTML = `<div class="empty"><div class="em-ic">${icon(N.filter === "fav" ? "star" : "folder")}</div><b>${N.filter === "fav" ? "Избранного пока нет" : "Здесь пусто"}</b>${N.filter === "fav" ? "Отметь звёздочкой то, что должно быть под рукой" : "Попробуй другую папку или вкладку"}</div>`;
    const clr = document.querySelector(".nsearch .clr");
    if (clr) { clr.hidden = !N.q; $("#nqKbd").hidden = !!N.q; }
    renderTabs();
  }

  function patchCard(n) {
    const el = document.querySelector(`.ncard[data-nid="${n.id}"]`);
    if (!el) return renderList();
    const tmp = document.createElement("div");
    tmp.innerHTML = cardHtml(n, norm(N.q.trim()));
    el.replaceWith(tmp.firstElementChild);
  }

  /* ---------- редактор ---------- */
  function statusHtml() {
    const map = { saved: ["check", "Сохранено"], pending: ["clock", "Изменено…"], saving: ["clock", "Сохраняю…"], error: ["miss", N.error || "Не сохранилось — повторю"] };
    const [ic, t] = map[N.status];
    return `${icon(ic)}<span>${esc(t)}</span>`;
  }
  function setStatus(st, err = "") {
    N.status = st; N.error = err;
    const el = $("#nstatus");
    if (el) { el.className = "nstatus " + st; el.innerHTML = statusHtml(); el.title = st === "error" ? (err || "") : ""; }
  }

  const TOOLS = [
    ["bold", "<b>B</b>", "Жирный (Ctrl+B)"], ["italic", "<i>I</i>", "Курсив (Ctrl+I)"], ["heading", "heading", "Заголовок"], "|",
    ["task", "checksq", "Чек-лист  ·  или «[] » в начале строки"], ["ul", "ul", "Список  ·  или «- » в начале строки"], ["ol", "ol", "Нумерованный список  ·  или «1. »"],
    ["quote", "bulb", "Блок-идея  ·  или «> »"], ["link", "link", "Ссылка (Ctrl+K)"],
  ];

  function renderEditor(focusTitle = false) {
    const box = $("#ned");
    if (!box) return;
    const n = cur();
    hideSelPop();
    if (!n) {
      box.innerHTML = `<div class="ned-empty"><div class="empty"><div class="em-ic">${icon("note")}</div><b>${N.list.length ? "Выбери заметку слева" : "Здесь появится текст"}</b>
        ${N.list.length ? "или создай новую — Ctrl+N" : "Мысли, планы и идеи — в одном месте"}<br>
        <button class="btn btn-primary" data-act="n-tpl">${icon("plus")}Новая заметка</button></div></div>`;
      return;
    }
    const more = N.menu === "more" ? menuHtml([
      `<button data-act="n-history">${icon("history")}История версий<small>${n.nversions || ""}</small></button>`,
      `<button data-act="n-export">${icon("download")}Экспорт…</button>`, "-",
      `<button class="danger" data-act="n-burn-focus">${icon("trash")}Удалить…</button>`], " right") : "";
    box.innerHTML = `<div class="ned-burnable">
        <div class="ned-top">
          <input class="ned-title" id="ntitle" maxlength="200" placeholder="Заголовок" autocomplete="off">
          <button class="icon-btn fav${n.favorite ? " on" : ""}" data-act="n-fav" title="${n.favorite ? "Убрать из избранного" : "В избранное"}">${icon("star")}</button>
          <span class="nstatus ${N.status}" id="nstatus">${statusHtml()}</span>
          <button class="icon-btn${N.props ? " on-panel" : ""}" data-act="n-props" title="${N.props ? "Скрыть свойства" : "Показать свойства"}">${icon("panel")}</button>
          <div class="ndd"><button class="icon-btn" data-act="n-menu" data-v="more" title="Ещё">${icon("dots")}</button>${more}</div>
        </div>
        <div class="ntools" id="ntools">${TOOLS.map((t) => t === "|" ? `<span class="sep"></span>`
          : `<button class="icon-btn" data-act="n-cmd" data-v="${t[0]}" title="${t[2]}">${t[1].startsWith("<") ? t[1] : icon(t[1])}</button>`).join("")}
          <span class="hint">Выдели текст → «Напоминание»</span></div>
        <div class="nlinkpop" id="nlinkpop" hidden><input class="input" id="nlinkUrl" placeholder="https://…" autocomplete="off"><button class="btn btn-primary btn-sm" data-act="n-link-ok">Готово</button></div>
        <div class="ned-body" id="nbody" contenteditable="true" spellcheck="true" data-ph="Начни писать… «- » — список, «[] » — задача, «# » — заголовок"></div>
      </div>
      <div class="ned-foot" id="nfoot"></div>`;
    $("#ntitle").value = n.title;
    $("#nbody").innerHTML = MD.toHtml(n.body) || "<p><br></p>";  // пустой абзац: первая же строка сразу в <p>
    document.execCommand("defaultParagraphSeparator", false, "p");
    updateEmpty();
    renderFoot();
    if (focusTitle) $("#ntitle").focus();
  }

  function renderFoot() {
    const n = cur(), el = $("#nfoot");
    if (!n || !el) return;
    el.innerHTML = `<span class="ff" title="Папка">${icon("folder")}${esc(n.folder || "Без папки")}</span><span class="vline"></span>
      <span class="ftags">${icon("tag")}${n.tags.length ? n.tags.map((t) => `<button class="tg" data-act="n-tag" data-v="${esc(t)}" title="Все заметки с тегом">${esc(t)}</button>`).join("") : `<span class="none">без тегов</span>`}</span>
      <span class="dates">Создано: ${whenFull(n.created)}<br>Изменено: ${when(n.updated)}</span>`;
  }

  const updateEmpty = () => { const b = $("#nbody"); if (b) b.classList.toggle("is-empty", !b.textContent.trim() && !b.querySelector("li,hr,h2,h3,h4,blockquote")); };

  /* ---------- свойства ---------- */
  function linkedRems(n) {
    return n.links.map((id) => N.rem.find((r) => r.id === id)).filter(Boolean);
  }

  function renderProps() {
    const box = $("#nprops"), cols = $("#notesCols");
    if (!box) return;
    cols.classList.toggle("props-closed", !N.props || !cur());
    const n = cur();
    if (!n) { box.innerHTML = ""; return; }
    const links = linkedRems(n), next = links.filter((r) => r.upcoming).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
    const fm = N.menu === "pfolder" ? menuHtml([
      `<button data-act="n-set-folder" data-v="">${icon("folder")}Без папки<span class="tick">${!n.folder ? icon("check") : ""}</span></button>`,
      ...N.folders.map((f) => `<button data-act="n-set-folder" data-v="${esc(f)}">${icon("folder")}${esc(f)}<span class="tick">${n.folder === f ? icon("check") : ""}</span></button>`),
      "-", `<button data-act="n-folder-new" data-set="1">${icon("plus")}Новая папка</button>`], " full") : "";
    const pick = N.menu === "pick" ? pickerHtml(n) : "";
    box.innerHTML = `<div class="ph"><h3>Свойства</h3><button class="icon-btn" data-act="n-props" title="Скрыть">${icon("x")}</button></div>
      <div><div class="plbl">Папка</div><div class="ndd"><button class="nsel" data-act="n-menu" data-v="pfolder">${icon("folder")}<span>${esc(n.folder || "Без папки")}</span>${icon("down")}</button>${fm}</div></div>
      <div><div class="plbl">Теги</div><div class="ntags" id="ntags">${n.tags.map((t) => `<span class="tg">${esc(t)}<button data-act="n-untag" data-v="${esc(t)}" aria-label="Убрать тег ${esc(t)}">${icon("x")}</button></span>`).join("")}
        <button class="add" data-act="n-addtag" title="Добавить тег">${icon("plus")}</button></div></div>
      <div><div class="plbl">Цвет</div><div class="ndots">${[["", "Без цвета"], ...Object.entries(S.categories)].map(([k, t]) =>
        `<button data-act="n-color" data-v="${k}" class="${n.color === k ? "on" : ""}${k ? "" : " none"}" title="${esc(t)}" aria-label="${esc(t)}"${k ? ` style="--c:${CAT_COLORS[k]}"` : ""}></button>`).join("")}</div></div>
      <div class="nrow">Избранное<button class="switch${n.favorite ? " on" : ""}" data-act="n-fav" aria-label="Избранное"></button></div>
      <div><div class="plbl">Напоминание</div>
        ${next ? `<button class="nsel" data-act="n-rem-open" data-v="${next.id}">${icon("calendar")}<span>${remWhen(next)}</span>${icon("right")}</button>
          <div class="psub">Ближайшее из связанных · ${esc(next.title)}</div>`
        : `<button class="nsel ghost" data-act="n-rem-new">${icon("bell")}<span>Поставить напоминание</span>${icon("plus")}</button>`}</div>
      <div><div class="plbl">Связанные напоминания${links.length ? ` <span class="count">${links.length}</span>` : ""}</div>
        <div class="nlinks">${links.map((r) => {
          const c = r.category ? CAT_COLORS[r.category] : "var(--accent)";
          return `<div class="nlr" style="--c:${c}"><button class="nlr-main" data-act="n-rem-open" data-v="${r.id}" title="Открыть напоминание">
            <span class="lic">${icon("bell")}</span><span class="lt"><b>${esc(r.title)}</b><small>${remWhen(r)}${r.repeat !== "none" ? " · " + esc(S.repeats[r.repeat].toLowerCase()) : ""}</small>
            ${r.category ? `<span class="tag" style="--c:${c}">${esc(S.categories[r.category])}</span>` : ""}</span>${icon("right")}</button>
            <button class="icon-btn unl" data-act="n-unlink" data-v="${r.id}" title="Отвязать (напоминание останется)">${icon("x")}</button></div>`;
        }).join("")}
        <div class="ndd"><button class="naddlink" data-act="n-menu" data-v="pick">${icon("plus")}Привязать напоминание</button>${pick}</div></div></div>
      <div class="ninfo"><div>${icon("calendar")}Заметка создана ${whenFull(n.created)}</div><div>${icon("history")}Изменена ${whenFull(n.updated)}</div>
        ${n.nversions ? `<button class="link" data-act="n-history">${icon("history")}История: ${n.nversions} ${plural(n.nversions, "версия", "версии", "версий")}</button>` : ""}</div>
      ${burnHtml()}`;
    bindBurn();
  }

  function pickerHtml(n) {
    const free = N.rem.filter((r) => !n.links.includes(r.id));
    const q = norm(N.pickQ || "");
    const rows = free.filter((r) => !q || norm(r.title).includes(q)).slice(0, 30);
    return `<div class="nmenu full pick"><input class="input" id="npickq" placeholder="Найти напоминание…" value="${esc(N.pickQ || "")}" autocomplete="off">
      <div class="pl">${rows.length ? rows.map((r) => `<button data-act="n-link" data-v="${r.id}"><i style="--c:${r.category ? CAT_COLORS[r.category] : "var(--muted)"}"></i>
        <span><b>${esc(r.title)}</b><small>${remWhen(r)}${r.upcoming ? "" : " · прошло"}</small></span></button>`).join("")
        : `<div class="none">${free.length ? "Ничего не нашлось" : "Все напоминания уже привязаны"}</div>`}</div>
      <button data-act="n-rem-new">${icon("plus")}Новое напоминание из заметки</button></div>`;
  }

  function burnHtml() {
    return `<div class="burn" id="nburn"><div class="fill"></div><div class="lava"></div><div class="lbl">Сдвинь, чтобы удалить</div>
      <button class="knob" id="nknob" aria-label="Удалить заметку: сдвинь вправо или удерживай Delete" title="Сдвинь вправо или удерживай Delete">${icon("trash")}</button>
      <canvas class="flame" id="nflame" width="40" height="44" aria-hidden="true"></canvas></div>`;
  }

  function renderAll(focusTitle = false) { renderList(); renderEditor(focusTitle); renderProps(); }
  function renderChromeOnly() { renderTabs(); renderEditorChrome(); renderProps(); }

  // кнопки шапки редактора без перерисовки текста (чтобы не сбить курсор)
  function renderEditorChrome() {
    const n = cur(), top = document.querySelector(".ned-top");
    if (!top || !n) return;
    const fav = top.querySelector(".fav"), panel = top.querySelector('[data-act="n-props"]');
    fav.classList.toggle("on", n.favorite); fav.title = n.favorite ? "Убрать из избранного" : "В избранное";
    panel.classList.toggle("on-panel", N.props); panel.title = N.props ? "Скрыть свойства" : "Показать свойства";
    const dd = top.querySelector(".ndd");
    dd.querySelector(".nmenu")?.remove();
    if (N.menu === "more") dd.insertAdjacentHTML("beforeend", menuHtml([
      `<button data-act="n-history">${icon("history")}История версий<small>${n.nversions || ""}</small></button>`,
      `<button data-act="n-export">${icon("download")}Экспорт…</button>`, "-",
      `<button class="danger" data-act="n-burn-focus">${icon("trash")}Удалить…</button>`], " right"));
  }

  /* ---------- сохранение ---------- */
  function edit(field, value) {
    const n = cur();
    if (!n || JSON.stringify(n[field]) === JSON.stringify(value)) return;
    if (N.dirtyId && N.dirtyId !== n.id) flush();  // хвост от другой заметки — отправим сразу
    n[field] = value;
    N.dirty[field] = value;
    N.dirtyId = n.id;
    if (field === "title" || field === "body") draftPut(n);
    setStatus("pending");
    clearTimeout(N.timer);
    N.timer = setTimeout(flush, SAVE_DELAY);
    patchCard(n);
  }

  function syncBody() {
    clearTimeout(N.bodyTimer);
    const b = $("#nbody");
    if (b && cur()) edit("body", MD.fromDom(b));
  }

  // отправить накопленные правки; запросы выстраиваются в очередь, чтобы не обогнать друг друга
  function flush() {
    if (N.bodyTimer) syncBody();
    clearTimeout(N.timer);
    if (!N.dirtyId) return N.chain;
    const id = N.dirtyId, payload = { id, ...N.dirty };
    N.dirty = {}; N.dirtyId = null;
    N.chain = N.chain.then(() => send(id, payload));
    return N.chain;
  }

  async function send(id, payload) {
    if (N.cur === id) setStatus("saving");
    let res = null;
    try { res = await api("note_save", payload); } catch { res = null; }
    const n = N.list.find((x) => x.id === id);
    if (res && res.ok) {
      if (res.folders) N.folders = res.folders;
      if (n) {
        const pending = N.dirtyId === id ? N.dirty : {};
        for (const [k, v] of Object.entries(res.note)) if (!(k in pending)) n[k] = v;
      }
      if (N.dirtyId !== id) {
        if (n) { const d = drafts()[id]; if (!d || (d.title === n.title && d.body === n.body)) draftDel(id); }
        if (N.cur === id) setStatus("saved");
      }
      if (n) patchCard(n);
      if (N.cur === id) renderFoot();
      return true;
    }
    if (res && res.error === "Заметка уже удалена") { draftDel(id); return false; }
    // не записалось: возвращаем правки в очередь (свежие поверх) и пробуем снова
    if (!N.dirtyId || N.dirtyId === id) {
      const { id: _, ...rest } = payload;
      N.dirty = { ...rest, ...N.dirty };
      N.dirtyId = id;
      if (!res || !res.error) N.timer = setTimeout(flush, RETRY_DELAY);  // ошибка проверки — ждём следующей правки
    }
    if (N.cur === id) setStatus("error", res && res.error ? res.error : "Не сохранилось — повторю");
    return false;
  }

  /* ---------- загрузка ---------- */
  async function load() {
    const [data, rem] = await Promise.all([api("notes"), api("reminders_brief")]);
    N.list = data.notes; N.folders = data.folders; N.rem = rem;
    const d = drafts();
    let restored = 0;
    for (const [id, dr] of Object.entries(d)) {
      const n = N.list.find((x) => x.id === id);
      if (!n) { draftDel(id); continue; }
      if (dr.title !== n.title || dr.body !== n.body) {
        const res = await api("note_save", { id, title: dr.title, body: dr.body });
        if (res && res.ok) { Object.assign(n, res.note); draftDel(id); restored++; }
      } else draftDel(id);
    }
    if (restored) toast("Вернул несохранённый текст");
  }
  // загрузка ровно одна: иначе поздний ответ сервера затрёт то, что уже набрано
  const ensureLoaded = () => (N.loading ||= load());

  async function mount() {
    await ensureLoaded();
    if (S.page !== "notes" || !$("#notesRoot")) return;
    if (N.props === null) N.props = innerWidth >= 1400;
    if (N.cur && !cur()) N.cur = null;
    if (!N.cur && N.list.length) N.cur = visible()[0]?.id || N.list[0].id;
    $("#nq").value = N.q;
    renderAll();
    if (N.pendingOpen) { const id = N.pendingOpen; N.pendingOpen = null; open(id); }
  }

  // фоновое обновление приложения: подтягиваем напоминания, редактор не трогаем
  async function tick() {
    if (!N.loading) return;
    N.rem = await api("reminders_brief");
    if (!N.menu) renderProps();
  }

  async function dropIfEmpty(id) {
    const n = N.list.find((x) => x.id === id);
    if (!n || !N.fresh.has(id) || n.title.trim() || n.body.trim() || n.links.length) return;
    if (N.dirtyId === id) { N.dirty = {}; N.dirtyId = null; clearTimeout(N.timer); }
    await N.chain;
    N.list = N.list.filter((x) => x.id !== id);
    N.fresh.delete(id); draftDel(id);
    await api("note_delete", id);
  }

  async function open(id, focusTitle = false) {
    if (id === N.cur && $("#nbody")) return;
    const prev = N.cur;
    flush();
    N.cur = id; N.menu = null;
    setStatus("saved");
    if (prev && prev !== id) await dropIfEmpty(prev);
    renderAll(focusTitle);
    if (!focusTitle) placeCaretEnd();
    document.querySelector(".ncard.cur")?.scrollIntoView({ block: "nearest" });
  }

  function placeCaretEnd() {
    const b = $("#nbody");
    if (!b) return;
    b.focus();
    const r = document.createRange();
    r.selectNodeContents(b); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }

  async function create(tpl = TEMPLATES[TEMPLATES.length - 1]) {
    closeDialog();
    await flush();
    const payload = { title: tpl.key ? tpl.title : "", body: tpl.body(), icon: tpl.icon === "note" ? "" : tpl.icon, color: tpl.color };
    if (N.folder) payload.folder = N.folder;  // открыта папка — новая заметка ляжет в неё
    const res = await api("note_save", payload);
    if (!res || !res.ok) return toast(res?.error || "Не получилось создать заметку");
    N.list.unshift(res.note);
    N.fresh.add(res.note.id);
    N.q = ""; N.filter = "all"; N.tag = "";
    if ($("#nq")) $("#nq").value = "";
    await open(res.note.id, !tpl.key);
    if (tpl.key) placeCaretEnd();
  }

  async function remove(id) {
    if (N.dirtyId === id) { N.dirty = {}; N.dirtyId = null; clearTimeout(N.timer); }
    await N.chain;
    await api("note_delete", id);
    draftDel(id);
    const vis = visible(), i = vis.findIndex((n) => n.id === id);
    const next = vis[i + 1] || vis[i - 1] || null;
    N.list = N.list.filter((n) => n.id !== id);
    N.fresh.delete(id);
    N.cur = next ? next.id : null;
    setStatus("saved");
    renderAll();
    toast("Заметка сгорела");
  }

  /* ---------- оформление текста ---------- */
  function block(node) {
    const b = $("#nbody");
    while (node && node !== b && node.parentNode !== b) node = node.parentNode;
    return node && node !== b ? node : null;
  }
  const caretLi = () => { const s = getSelection(); return s.rangeCount ? s.anchorNode?.parentElement?.closest?.("#nbody li") || (s.anchorNode?.nodeName === "LI" ? s.anchorNode : null) : null; };

  // абзац → пункт списка; Chrome-овский insertUnorderedList вкладывает <ul> внутрь <p>, поэтому делаем сами
  function toList(blk, ordered, task) {
    const li = document.createElement("li");
    if (task !== undefined) li.dataset.task = task;
    while (blk.firstChild) li.appendChild(blk.firstChild);
    if (!li.textContent && !li.querySelector("br")) li.appendChild(document.createElement("br"));
    const tag = ordered ? "OL" : "UL", prev = blk.previousElementSibling;
    if (prev && prev.tagName === tag && (prev.lastElementChild?.dataset.task !== undefined) === (task !== undefined)) { prev.appendChild(li); blk.remove(); }
    else { const list = document.createElement(tag); list.appendChild(li); blk.replaceWith(list); }
    const r = document.createRange();
    r.setStart(li, 0); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return li;
  }
  const paraAtCaret = () => {
    let blk = block(getSelection().anchorNode);
    if (blk && blk.nodeType === 3) { document.execCommand("formatBlock", false, "p"); blk = block(getSelection().anchorNode); }
    return blk && (blk.tagName === "P" || blk.tagName === "DIV" || /^H\d$/.test(blk.tagName)) ? blk : null;
  };

  function cmd(v) {
    const b = $("#nbody");
    if (!b) return;
    if (v === "link") return openLinkPop();
    if (document.activeElement !== b) b.focus();
    document.execCommand("defaultParagraphSeparator", false, "p");
    if (v === "bold" || v === "italic") document.execCommand(v);
    else if (v === "ul" || v === "ol") {
      const p = !caretLi() && paraAtCaret();
      if (p) toList(p, v === "ol");
      else document.execCommand(v === "ul" ? "insertUnorderedList" : "insertOrderedList");
    }
    else if (v === "heading") {
      const tag = block(getSelection().anchorNode)?.tagName;
      document.execCommand("formatBlock", false, tag === "H2" ? "h3" : tag === "H3" ? "p" : "h2");
    } else if (v === "quote") {
      const inQ = getSelection().anchorNode?.parentElement?.closest("#nbody blockquote");
      document.execCommand("formatBlock", false, inQ ? "p" : "blockquote");
    } else if (v === "task") {
      let li = caretLi();
      if (!li) { const p = paraAtCaret(); if (p) { toList(p, false, "0"); return afterEdit(); } }
      if (li && li.parentElement.tagName !== "UL") { document.execCommand("insertUnorderedList"); li = caretLi(); }
      if (li) {
        const lis = [...li.parentElement.children].filter((x) => x.tagName === "LI");
        const off = li.dataset.task !== undefined;
        lis.forEach((x) => (off ? delete x.dataset.task : (x.dataset.task ??= "0")));
      }
    }
    afterEdit();
  }

  function afterEdit() {
    updateEmpty();
    // новый пункт чек-листа после Enter наследует галочку соседа — снимаем её
    const li = caretLi();
    if (li && li.dataset.task === "1" && !li.textContent.trim()) li.dataset.task = "0";
    clearTimeout(N.bodyTimer);
    N.bodyTimer = setTimeout(syncBody, BODY_SYNC);
    updateToolState();
  }

  function updateToolState() {
    const t = $("#ntools");
    if (!t || !document.activeElement || document.activeElement.id !== "nbody") return;
    const tag = block(getSelection().anchorNode)?.tagName;
    const li = caretLi();
    const on = { bold: document.queryCommandState("bold"), italic: document.queryCommandState("italic"), heading: tag === "H2" || tag === "H3",
      ul: tag === "UL" && !(li && li.dataset.task !== undefined), ol: tag === "OL", task: !!(li && li.dataset.task !== undefined), quote: tag === "BLOCKQUOTE" };
    t.querySelectorAll("[data-act=n-cmd]").forEach((b) => b.classList.toggle("on", !!on[b.dataset.v]));
  }

  // Markdown-привычки: «- », «1. », «[] », «# », «> » в начале строки превращаются в оформление
  const AUTO = [[/^[-*+]$/, "ul"], [/^1[.)]$/, "ol"], [/^\[ ?\]$/, "task"], [/^\[[xх]\]$/i, "taskx"], [/^#$/, "h2"], [/^##$/, "h3"], [/^>$/, "quote"]];
  function autoFormat(e) {
    const s = getSelection();
    if (!s.isCollapsed || !s.rangeCount) return false;
    const li = caretLi();
    if (li && li.dataset.task === undefined && li.parentElement.tagName === "UL") {
      const r = document.createRange();
      r.selectNodeContents(li); r.setEnd(s.anchorNode, s.anchorOffset);
      const m = r.toString().match(/^\[( ?|[xх])\]$/i);
      if (!m) return false;
      e.preventDefault();
      s.removeAllRanges(); s.addRange(r);
      document.execCommand("delete");
      li.dataset.task = m[1].trim() ? "1" : "0";
      afterEdit();
      return true;
    }
    let blk = block(s.anchorNode);
    if (blk && blk.nodeType === 3) { document.execCommand("formatBlock", false, "p"); blk = block(getSelection().anchorNode); }
    if (!blk || (blk.tagName !== "P" && blk.tagName !== "DIV")) return false;
    const r = document.createRange();
    r.selectNodeContents(blk); r.setEnd(s.anchorNode, s.anchorOffset);
    const before = r.toString();
    const hit = AUTO.find(([re]) => re.test(before));
    if (!hit) return false;
    e.preventDefault();
    s.removeAllRanges(); s.addRange(r);
    document.execCommand("delete");
    const k = hit[1];
    if (k === "h2" || k === "h3") document.execCommand("formatBlock", false, k);
    else if (k === "quote") document.execCommand("formatBlock", false, "blockquote");
    else { const p = paraAtCaret(); if (p) toList(p, k === "ol", k.startsWith("task") ? (k === "taskx" ? "1" : "0") : undefined); }
    afterEdit();
    return true;
  }

  let linkRange = null;
  function openLinkPop() {
    const s = getSelection();
    linkRange = s.rangeCount && $("#nbody").contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
    const pop = $("#nlinkpop");
    pop.hidden = false;
    const a = s.anchorNode?.parentElement?.closest("#nbody a");
    $("#nlinkUrl").value = a ? a.getAttribute("href") : "";
    $("#nlinkUrl").focus();
  }
  function applyLink() {
    const url = $("#nlinkUrl").value.trim(), pop = $("#nlinkpop");
    pop.hidden = true;
    const b = $("#nbody");
    b.focus();
    if (linkRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(linkRange); }
    if (!url) document.execCommand("unlink");
    else if (linkRange && !linkRange.collapsed) document.execCommand("createLink", false, url);
    else document.execCommand("insertHTML", false, `<a href="${esc(url)}">${esc(url)}</a>&nbsp;`);
    afterEdit();
  }

  /* ---------- выделение → напоминание ---------- */
  function hideSelPop() { document.querySelector(".nselpop")?.remove(); }
  function showSelPop() {
    hideSelPop();
    const s = getSelection(), b = $("#nbody");
    if (!b || !s.rangeCount || s.isCollapsed || !b.contains(s.anchorNode)) return;
    const text = s.toString().trim();
    if (!text) return;
    const r = s.getRangeAt(0).getBoundingClientRect(), host = $("#ned"), h = host.getBoundingClientRect();
    const p = document.createElement("div");
    p.className = "nselpop";
    p.innerHTML = `<button class="go" data-act="n-sel-remind">${icon("bell")}Напоминание</button><button data-act="n-cmd" data-v="bold"><b>B</b></button>
      <button data-act="n-cmd" data-v="italic"><i>I</i></button><button data-act="n-cmd" data-v="link">${icon("link")}</button>`;
    p.dataset.text = text.slice(0, 300);
    host.appendChild(p);
    p.style.left = Math.max(8, Math.min(h.width - p.offsetWidth - 8, r.left - h.left + r.width / 2 - p.offsetWidth / 2)) + "px";
    p.style.top = Math.max(8, r.top - h.top - p.offsetHeight - 8) + "px";
  }

  const WEEK = [["воскресень", 0], ["понедельник", 1], ["вторник", 2], ["сред", 3], ["четверг", 4], ["пятниц", 5], ["суббот", 6]];
  const MONTHS_RE = ["январ", "феврал", "март", "апрел", "ма[йя]", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
  // «в понедельник», «завтра в 15:00», «12 октября», «через 3 дня», «15.10» → дата, время и название без этих слов
  function parseWhen(text, today = S.today) {
    let t = text, date = null, time = null, why = [];
    const cut = (re, fn) => { const m = t.match(re); if (m) { const r = fn(m); if (r !== false) { why.push(m[0].trim()); t = t.replace(m[0], " "); } } };
    cut(/(?:^|\s)(?:в|к)\s*(\d{1,2})[:.](\d{2})(?=\s|$|[,.!?])/i, (m) => { if (+m[1] > 23 || +m[2] > 59) return false; time = `${pad(+m[1])}:${m[2]}`; });
    if (!time) cut(/(?:^|\s)(\d{1,2}):(\d{2})(?=\s|$|[,.!?])/, (m) => { if (+m[1] > 23) return false; time = `${pad(+m[1])}:${m[2]}`; });
    if (!time) cut(/(?:^|\s)в\s+(\d{1,2})\s*(утра|дня|вечера|ч(?:ас(?:а|ов)?)?)(?=\s|$|[,.!?])/i, (m) => {
      let h = +m[1]; if (/дня|вечера/.test(m[2]) && h < 12) h += 12; if (h > 23) return false; time = `${pad(h)}:00`; });
    cut(/(?:^|\s)послезавтра(?=\s|$|[,.!?])/i, () => { date = addDays(today, 2); });
    if (!date) cut(/(?:^|\s)завтра(?=\s|$|[,.!?])/i, () => { date = addDays(today, 1); });
    if (!date) cut(/(?:^|\s)сегодня(?=\s|$|[,.!?])/i, () => { date = today; });
    if (!date) cut(/(?:^|\s)через\s+(\d{1,3})\s+(дн|день|недел)\S*/i, (m) => { date = addDays(today, +m[1] * (/недел/i.test(m[2]) ? 7 : 1)); });
    if (!date) cut(/(?:^|\s)(\d{1,2})\s+(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\S*/i, (m) => {
      const mi = MONTHS_RE.findIndex((re) => new RegExp("^" + re, "i").test(m[2]));
      let d = new Date(today.getFullYear(), mi, +m[1]);
      if (d.getMonth() !== mi) return false;
      if (d < today) d = new Date(today.getFullYear() + 1, mi, +m[1]);
      date = d; });
    if (!date) cut(/(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?=\s|$|[,!?])/, (m) => {
      const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : today.getFullYear();
      let d = new Date(y, +m[2] - 1, +m[1]);
      if (d.getMonth() !== +m[2] - 1) return false;
      if (!m[3] && d < today) d = new Date(y + 1, +m[2] - 1, +m[1]);
      date = d; });
    if (!date) cut(/(?:^|\s)(?:в|во)?\s*(?:следующ\S*\s+)?(понедельник|вторник|сред\S*|четверг|пятниц\S*|суббот\S*|воскресень\S*)/i, (m) => {
      const wd = WEEK.find(([w]) => m[1].toLowerCase().startsWith(w))[1];
      const diff = (wd - today.getDay() + 7) % 7 || 7;
      date = addDays(today, diff); });
    const title = t.replace(/\s+/g, " ").replace(/^[\s,.:;—-]+|[\s,.:;—-]+$/g, "").trim();
    return { date, time, why, title: title ? title.charAt(0).toUpperCase() + title.slice(1) : "" };
  }

  function remindFromText(text) {
    hideSelPop();
    const n = cur(), w = parseWhen(text);
    openNewFrom({ title: w.title || n.title || "Напоминание", date: w.date ? iso(w.date) : null, time: w.time, category: n.color,
      noteId: n.id,
      hint: `Из заметки «${n.title || "Без названия"}»${w.why.length ? ` · понял: ${w.why.map((x) => `«${x}»`).join(", ")}` : ""}` });
  }

  // напоминание сохранено из редактора, открытого заметкой
  async function onReminderSaved(noteId, rid) {
    const n = N.list.find((x) => x.id === noteId);
    if (n && !n.links.includes(rid)) n.links.push(rid);
    N.rem = await api("reminders_brief");
    if (S.page === "notes") { N.props = true; renderProps(); }
  }

  /* ---------- окна: шаблоны, экспорт, история ---------- */
  function dialog(html, wide = false) {
    closeDialog();
    const v = document.createElement("div");
    v.className = "nveil open"; v.id = "nveil";
    v.innerHTML = `<div class="ndlg${wide ? " wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(v);
    return v;
  }
  function closeDialog() { $("#nveil")?.remove(); }

  function openTemplates() {
    N.menu = null;
    dialog(`<h4>Новая заметка<button class="icon-btn" data-act="n-dlg-close" title="Закрыть (Esc)">${icon("x")}</button></h4>
      <p>Выбери готовую структуру или начни с чистого листа.</p>
      <div class="ntpls">${TEMPLATES.map((t, i) => `<button class="ntpl" data-act="n-tpl-pick" data-v="${i}" style="--c:${t.color ? CAT_COLORS[t.color] : "var(--accent)"}">
        <span class="tic">${icon(t.icon)}</span><b>${t.title}</b><span>${t.desc}</span></button>`).join("")}</div>`, true);
    document.querySelector(".ntpl")?.focus();
  }

  async function openExport(fmt = "md") {
    N.menu = null;
    const n = cur();
    if (!n) return;
    await flush();
    const opts = [["md", ".md", "Markdown", "Откроется в Obsidian, Notion, VS Code, GitHub"], ["txt", ".txt", "Обычный текст", "Без разметки, для Блокнота"],
      ["all", ".zip", "Все заметки", `Резервная копия: ${N.list.length} ${plural(N.list.length, "заметка", "заметки", "заметок")}, каждая отдельным .md`]];
    const data = await api("note_export", n.id, fmt === "all" ? "md" : fmt);
    const preview = fmt === "all" ? N.list.map((x) => `${x.title || "Без названия"}.md`).join("\n") : data.text;
    dialog(`<h4>Экспорт<button class="icon-btn" data-act="n-dlg-close" title="Закрыть (Esc)">${icon("x")}</button></h4>
      <div class="nexp">${opts.map(([k, ext, t, d]) => `<button class="nopt${k === fmt ? " on" : ""}" data-act="n-exp-fmt" data-v="${k}"><span class="tic">${ext}</span>
        <span><b>${t}</b><small>${d}</small></span>${k === fmt ? icon("check") : ""}</button>`).join("")}</div>
      <pre class="nprev">${esc(preview)}</pre>
      <div class="acts"><button class="btn btn-ghost btn-sm" data-act="n-dlg-close">Отмена</button>
        <button class="btn btn-primary btn-sm" data-act="n-exp-save" data-v="${fmt}">${icon("download")}Сохранить файл…</button></div>`);
  }

  async function saveExport(fmt) {
    const n = cur();
    if (DEV) {
      // в браузере (режим разработки) — обычная загрузка файла
      const data = await api("note_export", n.id, fmt);
      const blob = data.b64 ? new Blob([Uint8Array.from(atob(data.b64), (c) => c.charCodeAt(0))], { type: "application/zip" })
        : new Blob([data.text], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = data.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      closeDialog(); return toast(`Сохранено: ${data.name}`);
    }
    const res = await api("save_export", n.id, fmt);
    if (res.cancelled) return;
    if (res.error) return toast(res.error);
    closeDialog();
    toast(`Сохранено: ${res.path.split(/[\\/]/).pop()}`);
  }

  // построчная разница: что убрали (красным) и что добавили (зелёным) относительно текущего текста
  function diffLines(a, b) {
    const A = a.split("\n"), B = b.split("\n"), m = A.length, n = B.length;
    if (m * n > 250000) return [...A.map((l) => ["-", l]), ...B.map((l) => ["+", l])];
    const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (A[i] === B[j]) { out.push([" ", A[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(["-", A[i++]]); else out.push(["+", B[j++]]);
    }
    while (i < m) out.push(["-", A[i++]]);
    while (j < n) out.push(["+", B[j++]]);
    return out;
  }

  async function openHistory(sel = 0) {
    N.menu = null;
    const n = cur();
    if (!n) return;
    await flush();
    const vs = await api("note_versions", n.id);
    N.hist = vs;
    if (!vs.length) {
      return dialog(`<h4>История версий<button class="icon-btn" data-act="n-dlg-close">${icon("x")}</button></h4>
        <div class="empty"><div class="em-ic">${icon("history")}</div><b>Пока одна версия — текущая</b>Прежний текст сохраняется сам, когда ты возвращаешься к заметке после паузы (от 10 минут). Хранятся последние 30 версий.</div>`);
    }
    const v = vs[sel];
    const diff = diffLines(v.title + "\n\n" + v.body, n.title + "\n\n" + n.body).map(([k, l]) =>
      `<div class="dl${k === "-" ? " del" : k === "+" ? " ins" : ""}"><i>${k === " " ? "" : k === "-" ? "было" : "стало"}</i>${esc(l) || "&nbsp;"}</div>`).join("");
    dialog(`<h4>История версий — ${esc(n.title || "Без названия")}<button class="icon-btn" data-act="n-dlg-close" title="Закрыть (Esc)">${icon("x")}</button></h4>
      <div class="nhist"><div class="vers"><div class="ver now"><b>Сейчас</b><small>${when(n.updated)} · текущая</small></div>
        ${vs.map((x, k) => `<button class="ver${k === sel ? " on" : ""}" data-act="n-ver" data-v="${k}"><b>${esc(x.title || "Без названия")}</b><small>${whenFull(x.at)}</small></button>`).join("")}</div>
        <div class="ndiff"><div class="dh">Чем версия от ${whenFull(v.at)} отличается от текущего текста</div>${diff}</div></div>
      <p class="muted">Версия сохраняется сама после паузы в правках (от 10 минут). Хранятся последние 30.</p>
      <div class="acts"><button class="btn btn-ghost btn-sm" data-act="n-dlg-close">Закрыть</button>
        <button class="btn btn-primary btn-sm" data-act="n-restore" data-v="${v.i}">${icon("history")}Восстановить эту версию</button></div>`, true);
  }

  async function restore(index) {
    const n = cur();
    const res = await api("note_restore", n.id, index);
    if (!res || !res.ok) return toast(res?.error || "Не получилось восстановить");
    Object.assign(n, res.note);
    draftDel(n.id);
    closeDialog();
    renderAll();
    toast("Версия восстановлена — прежний текст тоже остался в истории");
  }

  /* ---------- «Сдвинь, чтобы удалить» ---------- */
  let flame = null;
  function bindBurn() {
    flame?.stop(); flame = null;
    const burn = $("#nburn"), knob = $("#nknob");
    if (!burn) return;
    if (S.anim === "lava") flame = FIRE.flame($("#nflame"));
    let p = 0, startX = 0, startP = 0, dragging = false, hold = null, done = false;
    const travel = () => burn.clientWidth - 42;
    burn.style.setProperty("--travel", travel() + "px");
    const setP = (v) => {
      p = Math.max(0, Math.min(1, v));
      burn.style.setProperty("--p", p.toFixed(4));
      // лава наливается плавно, без переключений; узор не растягивается — нет рывков при медленном движении
      const h = Math.max(0, Math.min(1, (p - .45) / .5));
      burn.style.setProperty("--hot", S.anim === "off" ? 0 : (h * h * (3 - 2 * h)).toFixed(3));
      burn.classList.toggle("hot", p > .7);
      flame?.set(p);
    };
    const springBack = () => {
      if (done) return;
      burn.classList.add("back");
      setP(0);
      setTimeout(() => burn.classList.remove("back"), 520);
    };
    const commit = () => {
      if (done) return;
      done = true;
      setP(1);
      burn.classList.add("done", "hot");
      flame?.flare();
      burnNote(N.cur);
    };
    knob.addEventListener("pointerdown", (e) => {
      if (done) return;
      dragging = true; startX = e.clientX; startP = p;
      burn.style.setProperty("--travel", travel() + "px");
      burn.classList.remove("back"); burn.classList.add("drag");
      knob.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    knob.addEventListener("pointermove", (e) => { if (dragging) setP(startP + (e.clientX - startX) / travel()); });
    const up = () => {
      if (!dragging) return;
      dragging = false; burn.classList.remove("drag");
      if (p >= .96) commit(); else springBack();
    };
    knob.addEventListener("pointerup", up);
    knob.addEventListener("pointercancel", up);
    // клавиатура: удерживай Delete — ползунок едет сам; отпустил раньше — пружинит назад
    knob.addEventListener("keydown", (e) => {
      if (e.key !== "Delete" || e.repeat || done || hold) return;
      e.preventDefault();
      burn.style.setProperty("--travel", travel() + "px");
      const t0 = performance.now();
      const step = (t) => {
        if (!hold) return;
        const v = (t - t0) / HOLD_MS;
        setP(v);
        if (v >= 1) { hold = null; commit(); } else hold = requestAnimationFrame(step);
      };
      hold = requestAnimationFrame(step);
    });
    const cancelHold = () => { if (hold) { cancelAnimationFrame(hold); hold = null; springBack(); } };
    knob.addEventListener("keyup", (e) => { if (e.key === "Delete") cancelHold(); });
    knob.addEventListener("blur", cancelHold);
  }

  // заметка сгорает: карточка в списке — с искрами и пеплом, текст в редакторе — тем же краем, но тише
  function burnNote(id) {
    const card = document.querySelector(`.ncard[data-nid="${id}"]`), body = document.querySelector("#ned .ned-burnable");
    if (S.anim === "off") return remove(id);
    let left = (card ? 1 : 0) + (body ? 1 : 0);
    const finish = () => {
      if (--left > 0) return;
      if (!card) return remove(id);
      const h = card.offsetHeight;
      card.animate([{ height: h + "px", marginBottom: "0px" }, { height: "0px", marginBottom: "-10px" }],
        { duration: 240, easing: "ease-in", fill: "forwards" }).onfinish = () => remove(id);
    };
    if (!left) return remove(id);
    setTimeout(() => {
      if (card) FIRE.burnAway(card, { done: finish });
      // текст в редакторе не горит, а тихо гаснет с тёплым отсветом — главное событие в списке
      if (body) body.animate([{ opacity: 1, filter: "none" }, { opacity: .55, filter: "sepia(.6) saturate(1.6) hue-rotate(-12deg)", offset: .4 }, { opacity: 0, filter: "blur(2px) sepia(.8)" }],
        { duration: 1100, easing: "ease-in", fill: "forwards" }).onfinish = finish;
    }, 140);
  }

  /* ---------- папки и теги ---------- */
  function askInline(anchor, placeholder, onOk) {
    // маленькое поле прямо на месте кнопки: Enter — готово, Esc — отмена
    const inp = document.createElement("input");
    inp.className = "input ninline"; inp.placeholder = placeholder; inp.maxLength = 40;
    anchor.replaceWith(inp);
    inp.focus();
    let done = false;
    const finish = async (ok) => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      if (ok && v) await onOk(v);
      else { N.menu = null; renderTabs(); renderProps(); }
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    inp.addEventListener("blur", () => finish(true));
  }

  async function newFolder(el, setOnNote) {
    askInline(el, "Название папки", async (name) => {
      const res = await api("folder_add", name);
      if (res.error) { toast(res.error); N.menu = null; return renderChromeOnly(); }
      N.folders = res.folders; N.menu = null;
      if (setOnNote && cur()) { edit("folder", name); flush(); }
      renderChromeOnly(); renderFoot(); renderList();
      toast(`Папка «${name}» создана`);
    });
  }

  function addTag(el) {
    const n = cur();
    askInline(el, "новый тег", (t) => {
      const tag = t.replace(/^#/, "").trim().toLowerCase().slice(0, 30);
      if (tag && !n.tags.includes(tag)) { edit("tags", [...n.tags, tag]); flush(); }
      renderProps(); renderFoot();
      setTimeout(() => document.querySelector('#ntags [data-act="n-addtag"]')?.click(), 0);  // можно ввести следующий
    });
  }

  /* ---------- снаружи ---------- */
  // **жирный**, *курсив*, `код` прямо при наборе: знаки разметки исчезают, остаётся оформление
  const INLINE_AUTO = [[/\*\*([^*\s](?:[^*]*?[^*\s])?)\*\*$/, "b"], [/(^|[^*\\])\*([^*\s](?:[^*]*?[^*\s])?)\*$/, "i"], [/(^|[^`])`([^`]+)`$/, "code"]];
  function inlineAuto(e) {
    if (e.inputType !== "insertText" || !/[*`]/.test(e.data || "")) return;
    const s = getSelection(), node = s.anchorNode;
    if (!s.isCollapsed || !node || node.nodeType !== 3 || node.parentElement.closest("code")) return;
    const before = node.nodeValue.slice(0, s.anchorOffset);
    for (const [re, tag] of INLINE_AUTO) {
      const m = before.match(re);
      if (!m) continue;
      const text = tag === "b" ? m[1] : m[2], start = before.length - m[0].length + (tag === "b" ? 0 : m[1].length);
      const r = document.createRange();
      r.setStart(node, start); r.setEnd(node, s.anchorOffset);
      r.deleteContents();
      const el = document.createElement(tag);
      el.textContent = text;
      r.insertNode(el);
      // курсор — сразу за оформленным словом, дальше обычный текст
      const after = document.createTextNode("\u200b");
      el.after(after);
      const c = document.createRange();
      c.setStart(after, 1); c.collapse(true);
      s.removeAllRanges(); s.addRange(c);
      return;
    }
  }

  function onInput(e) {
    if (e.target.id === "ntitle") edit("title", e.target.value);
    else if (e.target.id === "nbody") { inlineAuto(e); afterEdit(); }
    else if (e.target.id === "nq") { N.q = e.target.value; renderList(); }
    else if (e.target.id === "npickq") {
      N.pickQ = e.target.value;
      const box = e.target.parentElement.querySelector(".pl"), tmp = document.createElement("div");
      tmp.innerHTML = pickerHtml(cur());
      box.replaceWith(tmp.querySelector(".pl"));
    }
  }

  function onKey(e) {
    if (S.page !== "notes" || S.ed) return false;
    const k = e.key.toLowerCase(), inBody = e.target.id === "nbody";
    if ($("#nveil")) {
      if (e.key === "Escape") { closeDialog(); return true; }
      return false;
    }
    if (e.ctrlKey && k === "n") { e.preventDefault(); e.shiftKey ? openTemplates() : create(); return true; }
    if (e.ctrlKey && (k === "f")) { e.preventDefault(); $("#nq")?.focus(); $("#nq")?.select(); return true; }
    if (e.ctrlKey && k === "s") { e.preventDefault(); flush(); return true; }
    if (e.ctrlKey && k === "k" && inBody) { e.preventDefault(); openLinkPop(); return true; }
    if (e.key === "Escape") {
      if (N.menu) { N.menu = null; renderChromeOnly(); return true; }
      if (document.querySelector(".nselpop")) { hideSelPop(); return true; }
      if (!$("#nlinkpop")?.hidden) { $("#nlinkpop").hidden = true; $("#nbody").focus(); return true; }
      if (e.target.id === "nq" && N.q) { N.q = ""; e.target.value = ""; renderList(); return true; }
    }
    if (e.target.id === "nlinkUrl" && e.key === "Enter") { e.preventDefault(); applyLink(); return true; }
    if (e.key === "Enter" && e.target.id === "ntitle") { e.preventDefault(); placeCaretStart(); return true; }
    if (inBody && e.key === " " && autoFormat(e)) return true;
    if (inBody && e.key === "Tab") {
      // Tab в списке — вложенность, в тексте — отступ, а не уход фокуса
      e.preventDefault();
      if (caretLi()) document.execCommand(e.shiftKey ? "outdent" : "indent");
      else if (!e.shiftKey) document.execCommand("insertText", false, "\t");
      afterEdit();
      return true;
    }
    return false;
  }

  function placeCaretStart() {
    const b = $("#nbody");
    b.focus();
    const r = document.createRange();
    r.selectNodeContents(b); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }

  async function onAct(act, el, e) {
    await ensureLoaded();
    const v = el.dataset.v;
    if (act !== "n-menu" && !el.closest(".nmenu") && N.menu) N.menu = null;
    switch (act) {
      case "n-new": return create();
      case "n-tpl": return openTemplates();
      case "n-tpl-pick": return create(TEMPLATES[+v]);
      case "n-dlg-close": return closeDialog();
      case "n-open": return open(el.dataset.nid);
      case "n-filter": N.filter = v; return renderList();
      case "nq-clear": N.q = ""; $("#nq").value = ""; renderList(); return $("#nq").focus();
      case "n-menu": e?.stopPropagation(); N.menu = N.menu === v ? null : v; N.pickQ = ""; renderChromeOnly(); if (v === "pick") $("#npickq")?.focus(); return;
      case "n-folder-filter": N.folder = v === "*" ? null : v; N.menu = null; renderList(); return;
      case "n-folder-new": return newFolder(el, !!el.dataset.set);
      case "n-set-folder": edit("folder", v); flush(); N.menu = null; renderProps(); renderFoot(); return renderList();
      case "n-tag": N.tag = v; return renderList();
      case "n-addtag": return addTag(el);
      case "n-untag": edit("tags", cur().tags.filter((t) => t !== v)); flush(); renderProps(); return renderFoot();
      case "n-fav": { const n = cur(); if (!n) return; edit("favorite", !n.favorite); flush(); renderEditorChrome(); renderProps(); return renderList(); }
      case "n-color": edit("color", v); flush(); renderProps(); return;
      case "n-props": N.props = !N.props; renderProps(); return renderEditorChrome();
      case "n-cmd": e?.preventDefault(); hideSelPop(); return cmd(v);
      case "n-link-ok": return applyLink();
      case "n-sel-remind": return remindFromText(el.closest(".nselpop").dataset.text);
      case "n-rem-new": { N.menu = null; renderProps(); const n = cur(); return openNewFrom({ title: n.title || "Напоминание", category: n.color, noteId: n.id, hint: `Из заметки «${n.title || "Без названия"}»` }); }
      case "n-rem-open": return openEditor(v);
      case "n-link": edit("links", [...cur().links, v]); flush(); N.menu = null; renderProps(); return toast("Напоминание привязано");
      case "n-unlink": edit("links", cur().links.filter((x) => x !== v)); flush(); renderProps(); return toast("Отвязано — напоминание осталось в календаре");
      case "n-history": return openHistory();
      case "n-ver": return openHistory(+v);
      case "n-restore": return restore(+v);
      case "n-export": return openExport();
      case "n-exp-fmt": return openExport(v);
      case "n-exp-save": return saveExport(v);
      case "n-burn-focus": N.menu = null; N.props = true; renderEditorChrome(); renderProps(); $("#nknob").focus(); $("#nknob").scrollIntoView({ block: "nearest" }); return toast("Сдвинь ползунок до конца или удерживай Delete");
    }
  }

  // клики по самому тексту: галочки чек-листа, ссылки с Ctrl
  function onBodyClick(e) {
    const li = e.target.closest?.("#nbody li[data-task]");
    if (li && e.target === li && e.clientX < li.getBoundingClientRect().left + 4) {
      e.preventDefault();
      li.dataset.task = li.dataset.task === "1" ? "0" : "1";
      afterEdit();
      return true;
    }
    const a = e.target.closest?.("#nbody a");
    if (a && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const ext = document.createElement("a");
      ext.href = a.href; ext.target = "_blank"; ext.rel = "noopener"; ext.click();
      return true;
    }
    return false;
  }

  function onPaste(e) {
    if (!e.target.closest?.("#nbody")) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    // многострочный текст разбираем как Markdown (списки, задачи), одну строку вставляем как есть
    if (text.includes("\n")) document.execCommand("insertHTML", false, MD.toHtml(text));
    else document.execCommand("insertText", false, text);
    afterEdit();
  }

  document.addEventListener("selectionchange", () => {
    if (S.page !== "notes") return;
    updateToolState();
    clearTimeout(showSelPop.t);
    const s = getSelection();
    if (s.isCollapsed) return;
    showSelPop.t = setTimeout(showSelPop, 250);
  });
  document.addEventListener("mousedown", (e) => {
    // кнопки оформления не забирают фокус у текста — иначе пропадёт выделение
    if (e.target.closest?.("#ntools [data-act=n-cmd], .nselpop")) e.preventDefault();
    if (!e.target.closest?.(".nselpop")) hideSelPop();
    if (N.menu && !e.target.closest?.(".nmenu, [data-act=n-menu]")) { N.menu = null; renderChromeOnly(); }
    if (!e.target.closest?.("#nlinkpop, [data-v=link]") && $("#nlinkpop")) $("#nlinkpop").hidden = true;
  }, true);
  document.addEventListener("paste", onPaste, true);
  document.addEventListener("focusout", (e) => { if (e.target.id === "nbody") syncBody(); });

  async function leave() {
    hideSelPop(); closeDialog(); N.menu = null;
    const id = N.cur;
    await flush();
    if (id) await dropIfEmpty(id);
  }

  // открыть заметку из напоминания
  async function goto(id) {
    if (typeof closeEditor === "function" && S.ed) closeEditor();
    await ensureLoaded();
    if (!N.list.find((n) => n.id === id)) return toast("Заметка не найдена");
    N.filter = "all"; N.folder = null; N.tag = ""; N.q = "";
    if (S.page === "notes" && $("#notesRoot")) return open(id);
    N.cur = id;
    go("notes");
  }

  return { shell, mount, tick, create, flush, leave, goto, onInput, onKey, onAct, onBodyClick, onReminderSaved, parseWhen, state: N };
})();

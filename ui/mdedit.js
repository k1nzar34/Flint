"use strict";
/* Markdown ⇄ оформленный текст для редактора заметок.
 *  toHtml(md)    — Markdown → HTML для contenteditable;
 *  fromDom(root) — HTML редактора → Markdown (так заметка и хранится).
 * Поддерживается то, что умеет панель: заголовки (#, ##, ###), **жирный**, *курсив*, `код`, [ссылки](url),
 * списки (в т.ч. вложенные), нумерованные, чек-листы «- [ ]», цитата-«идея» (>).
 * Спецсимволы в обычном тексте экранируются «\», чтобы «2*3*4» не стало курсивом после повторного открытия.
 */
const MD = (() => {
  const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // «- [ ] задача»; «- \[ \] …» (так текст сохранялся, если квадратные скобки набрали внутри пункта) — тоже задача
  const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\\?\[( |x|X)\\?\]\s+)?(.*)$/;
  const isBlockStart = (l) => /^(#{1,6}\s|>|\s*([-*+]|\d+[.)])\s)/.test(l);

  function safeUrl(u) {
    const url = u.trim();
    return /^(https?:|mailto:|file:|\/|#)/i.test(url) || !/^[a-z][\w+.-]*:/i.test(url) ? url : "#";
  }

  function inline(s) {
    const keep = [];
    const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
    s = s.replace(/\\([\\`*_\[\]#>+\-.!()~|])/g, (_, c) => hold(escH(c)));
    s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${escH(c)}</code>`));
    s = escH(s);
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${escH(safeUrl(u.replace(/&amp;/g, "&")))}">${t}</a>`);
    s = s.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<b>$1</b>").replace(/__(?=\S)(.+?)(?<=\S)__/g, "<b>$1</b>");
    s = s.replace(/\*(?=\S)(.+?)(?<=\S)\*/g, "<i>$1</i>").replace(/(^|[^\p{L}\p{N}])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}])/gu, "$1<i>$2</i>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[i]);
  }

  function list(lines, i) {
    const base = lines[i].match(ITEM)[1].length;
    const ordered = /\d/.test(lines[i].match(ITEM)[2]);
    const out = [ordered ? "<ol>" : "<ul>"];
    while (i < lines.length) {
      const m = lines[i].match(ITEM);
      if (!m || m[1].length < base) {
        // пустая строка внутри списка — смотрим, продолжается ли он дальше
        if (!lines[i].trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          const nm = j < lines.length && lines[j].match(ITEM);
          if (nm && nm[1].length >= base && /\d/.test(nm[2]) === ordered) { i = j; continue; }
        }
        break;
      }
      if (m[1].length > base) { const [html, ni] = list(lines, i); out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, html + "</li>"); i = ni; continue; }
      if (/\d/.test(m[2]) !== ordered) break;
      let text = inline(m[4]);
      i++;
      // продолжение пункта на следующей строке (с отступом, но не новый пункт)
      while (i < lines.length && lines[i].trim() && !ITEM.test(lines[i]) && /^\s+/.test(lines[i])) { text += "<br>" + inline(lines[i].trim()); i++; }
      const task = m[3] !== undefined ? ` data-task="${m[3] === " " ? 0 : 1}"` : "";
      out.push(`<li${task}>${text || "<br>"}</li>`);
    }
    out.push(ordered ? "</ol>" : "</ul>");
    return [out.join(""), i];
  }

  function toHtml(md) {
    const lines = String(md || "").replace(/\r/g, "").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      let m;
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { const h = Math.min(m[1].length, 3) + 1; out.push(`<h${h}>${inline(m[2])}</h${h}>`); i++; continue; }
      if (/^>/.test(l)) {
        const q = [];
        while (i < lines.length && /^>/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
        out.push(`<blockquote>${toHtml(q.join("\n")) || "<p><br></p>"}</blockquote>`);
        continue;
      }
      if (/^-{3,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
      if (ITEM.test(l)) { const [html, ni] = list(lines, i); out.push(html); i = ni; continue; }
      const para = [inline(l)];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(inline(lines[i++]));
      out.push(`<p>${para.join("<br>")}</p>`);
    }
    return out.join("");
  }

  /* ---------- обратно: DOM → Markdown ---------- */
  const INLINE = new Set(["B", "STRONG", "I", "EM", "A", "CODE", "SPAN", "FONT", "U", "S", "STRIKE", "BR", "SUB", "SUP", "MARK"]);
  const escT = (s) => s.replace(/​/g, "").replace(/ /g, " ").replace(/[\\`*_\[\]]/g, "\\$&");

  function wrap(mark, inner) {
    // маркеры прижимаем к тексту: «** жирный **» Markdown не поймёт
    const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
  }

  function inl(node) {
    let s = "";
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { s += escT(c.nodeValue); continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      if (t === "BR") s += "\n";
      else if (t === "B" || t === "STRONG") s += wrap("**", inl(c));
      else if (t === "I" || t === "EM") s += wrap("*", inl(c));
      else if (t === "CODE") s += c.textContent ? "`" + c.textContent.replace(/`/g, "'") + "`" : "";
      else if (t === "A") { const txt = inl(c); s += txt.trim() ? `[${txt}](${(c.getAttribute("href") || "").replace(/[()\s]/g, encodeURIComponent)})` : ""; }
      else if (t === "UL" || t === "OL") continue;  // вложенный список выводит list()
      else if (c.style && /bold|[6-9]00/.test(c.style.fontWeight)) s += wrap("**", inl(c));
      else if (c.style && c.style.fontStyle === "italic") s += wrap("*", inl(c));
      else s += inl(c);
    }
    return s;
  }

  // строка, похожая на начало блока, остаётся текстом: экранируем первый символ
  const guard = (text) => text.split("\n").map((l) => (isBlockStart(l) || /^-{3,}\s*$/.test(l) ? "\\" + l : l)).join("\n");

  function listMd(el, depth) {
    const out = [], ordered = el.tagName === "OL", pad = "  ".repeat(depth);
    let n = 0;
    for (const c of el.children) {
      if (c.tagName === "UL" || c.tagName === "OL") { out.push(listMd(c, depth + 1)); continue; }  // Chrome кладёт вложенный список рядом с пунктом
      if (c.tagName !== "LI") continue;
      n++;
      const mark = ordered ? `${n}. ` : "- ";
      const task = c.dataset.task !== undefined ? `[${c.dataset.task === "1" ? "x" : " "}] ` : "";
      const text = inl(c).replace(/\n+$/, "").trim().split("\n").join("\n" + pad + "  ");
      out.push(pad + mark + task + text);
      for (const sub of c.children) if (sub.tagName === "UL" || sub.tagName === "OL") out.push(listMd(sub, depth + 1));
    }
    return out.join("\n");
  }

  function blocks(root) {
    const out = [];
    let buf = [];
    const flushInline = () => {
      if (!buf.length) return;
      const tmp = document.createElement("p");
      buf.forEach((n) => tmp.appendChild(n.cloneNode(true)));
      const t = inl(tmp).replace(/^\n+|\n+$/g, "");
      if (t.trim()) out.push(guard(t));
      buf = [];
    };
    for (const c of root.childNodes) {
      if (c.nodeType === 3 || (c.nodeType === 1 && INLINE.has(c.tagName))) { buf.push(c); continue; }
      if (c.nodeType !== 1) continue;
      flushInline();
      const t = c.tagName;
      if (/^H[1-6]$/.test(t)) {
        const txt = inl(c).replace(/\n/g, " ").trim();
        if (txt) out.push("#".repeat(Math.max(1, Math.min(3, +t[1] - 1))) + " " + txt);
      } else if (t === "UL" || t === "OL") {
        const md = listMd(c, 0);
        if (md.trim()) out.push(md);
      } else if (t === "BLOCKQUOTE") {
        const inner = blocks(c).join("\n\n");
        if (inner.trim()) out.push(inner.split("\n").map((l) => (l ? "> " + l : ">")).join("\n"));
      } else if (t === "HR") out.push("---");
      else if ([...c.children].some((k) => !INLINE.has(k.tagName))) out.push(...blocks(c));
      else {
        const txt = inl(c).replace(/^\n+|\n+$/g, "");
        if (txt.trim()) out.push(guard(txt));
      }
    }
    flushInline();
    return out;
  }

  const fromDom = (root) => blocks(root).join("\n\n").replace(/[ \t]+$/gm, "");

  /* ---------- текст для карточек и поиска ---------- */
  function plain(md) {
    return String(md || "").split("\n")
      .map((l) => l.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, "")
        .replace(/\*\*|__|`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(^|[^\\])\*(?=\S)(.+?)\*/g, "$1$2").replace(/\\(.)/g, "$1").trim())
      .filter((l) => l && l !== "---").join(" · ");
  }

  return { toHtml, fromDom, inline, plain };
})();

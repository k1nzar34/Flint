"""UI-тесты: интерфейс поднимается через devserver.py и прогоняется в headless Chromium.

Запуск:  pip install pytest playwright && python -m playwright install chromium && pytest
Без установленного Playwright эти тесты пропускаются.
"""
import json
import os
import re
import socket
import subprocess
import sys
import time
from datetime import date, timedelta

import pytest

sync_api = pytest.importorskip("playwright.sync_api")
expect = sync_api.expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TODAY = date.today()
TOMORROW = (TODAY + timedelta(days=1)).isoformat()


def seed(path):
    def r(i, title, d, tm, rep="none", cat="", imp=False, done=()):
        return {"id": f"r{i}", "title": title, "note": "", "category": cat, "important": imp,
                "repeat": rep, "start": f"{d} {tm}", "created": "2020-01-01 00:00",
                "notified": "2020-01-01 00:00", "snooze_until": None, "done": list(done)}
    t = TODAY.isoformat()
    data = {"settings": {"name": "Дима", "theme": "dark"}, "reminders": [
        r(1, "Созвон по релизу", t, "00:00", cat="work", imp=True, done=[t]),
        r(2, "Тренировка", t, "23:59", rep="daily", cat="health"),
        r(3, "Купить продукты", TOMORROW, "18:00", cat="home"),
    ]}
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def base_url(tmp_path):
    data = tmp_path / "data.json"
    seed(data)
    port = free_port()
    proc = subprocess.Popen([sys.executable, "devserver.py", str(port)], cwd=ROOT,
                            env={**os.environ, "FLINT_DATA": str(data)},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    yield f"http://127.0.0.1:{port}/index.html?dev"
    proc.terminate()
    proc.wait()


@pytest.fixture
def page(base_url):
    errors = []
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 1280, "height": 820})
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(base_url)
        pg.wait_for_selector(".item")
        yield pg
        browser.close()
    assert errors == [], f"JS-ошибки: {errors}"


def item(pg, title):
    return pg.locator(".item", has_text=title).first


@pytest.mark.parametrize("name", ["calendar", "all", "notes", "stats", "settings", "home"])
def test_pages_open(page, name):
    page.click(f"nav [data-page={name}]")
    page.wait_for_timeout(300)
    assert "active" in page.get_attribute(f"nav [data-page={name}]", "class")


def test_home_greeting_and_progress(page):
    assert "Привет, Дима" in page.inner_text("#heroTitle")
    assert page.inner_text("#sideValue") == "1 из 2 выполнено"


def test_create_reminder_with_validation(page):
    page.click("header [data-act=add]")
    page.click("[data-act=ed-save]")
    expect(page.locator("#edError")).to_have_text("Напиши, о чём напомнить")

    page.fill("#edTitle", "Сдать отчёт")
    page.click("[data-act=ed-datepick]")
    if not page.locator(f"[data-act=ed-pick][data-v='{TOMORROW}']").is_visible():
        page.click("[data-act=ed-cal][data-v='1']")
    page.click(f"[data-act=ed-pick][data-v='{TOMORROW}']")
    page.fill("#edTime", "")
    page.type("#edTime", "2599")
    page.click("[data-act=ed-save]")
    expect(page.locator("#edError")).to_contain_text("ЧЧ:ММ")

    page.fill("#edTime", "")
    page.type("#edTime", "1030")
    assert page.input_value("#edTime") == "10:30"
    page.click("[data-act=ed-cat][data-v=work]")
    page.click("[data-act=ed-save]")
    expect(page.locator("#overlay")).not_to_have_class("overlay open")
    expect(item(page, "Сдать отчёт")).to_be_visible()
    assert "Работа" in item(page, "Сдать отчёт").inner_text()


def test_toggle_done(page):
    item(page, "Тренировка").locator("[data-act=toggle]").click()
    expect(item(page, "Тренировка")).to_have_class(re.compile(r"\bdone\b"))
    expect(page.locator("#sideValue")).to_have_text("2 из 2 выполнено")


def test_delete_needs_confirmation(page):
    item(page, "Тренировка").locator("[data-act=menu]").click()
    page.click("[data-act=m-delete]")
    expect(page.locator("[data-act=m-delete]")).to_contain_text("Точно удалить")
    page.click("[data-act=m-delete]")
    expect(page.locator(".item", has_text="Тренировка")).to_have_count(0)


def test_filter_important(page):
    page.click("nav [data-page=all]")
    page.click("[data-act=cat][data-v=important]")
    expect(page.locator(".item .title")).to_have_text(["Созвон по релизу"])


def test_theme_persists(page):
    page.click("[data-act=theme]")
    expect(page.locator("body")).to_have_attribute("data-theme", "light")
    page.reload()
    page.wait_for_selector(".item")
    assert page.get_attribute("body", "data-theme") == "light"


def test_priority_fire(page):
    hot = item(page, "Созвон по релизу")          # приоритетная, уже выполнена
    assert "hot" in hot.get_attribute("class")
    expect(hot.locator(".title .fire")).to_be_visible()
    today = page.locator(f".cal .day[data-date='{TODAY.isoformat()}']")
    expect(today.locator(".flame")).to_have_count(0)   # выполнена — огонька в календаре нет
    hot.locator("[data-act=toggle]").click()
    expect(page.locator(f".cal .day[data-date='{TODAY.isoformat()}'] .flame")).to_have_count(1)
    page.click("nav [data-page=calendar]")
    expect(page.locator(f".cell[data-date='{TODAY.isoformat()}'] .flame")).to_have_count(1)


def test_create_birthday_today(page):
    page.click("header [data-act=add]")
    page.click("[data-act=ed-kind][data-v=birthday]")
    expect(page.locator(".modal")).to_have_attribute("data-kind", "birthday")
    expect(page.locator("#edCats")).to_be_hidden()                 # у дня рождения нет категорий
    page.fill("#edTitle", "Ксюша")
    page.type("#edBYear", "2000")
    expect(page.locator("#edAge")).to_contain_text(f"исполнится {TODAY.year - 2000}")
    page.click("[data-act=ed-remind-all]")
    expect(page.locator("#edRemind .ck.on")).to_have_count(3)
    page.click("[data-act=ed-save]")
    bday = page.locator(".item.bday", has_text="Ксюша").first
    expect(bday).to_be_visible()
    expect(page.locator("#heroSub")).to_contain_text("день рождения: Ксюша")
    expect(page.locator("#sideValue")).to_have_text("1 из 2 выполнено")  # ДР не влияет на прогресс
    bday.locator("[data-act=menu]").click()
    expect(page.locator("[data-act=m-toggle]")).to_have_count(0)    # отметить «выполнено» нельзя


def test_create_vacation(page):
    page.click("header [data-act=add]")
    page.click("[data-act=ed-kind][data-v=vacation]")
    page.click("[data-act=ed-save]")                               # пустое название → «Отпуск»
    expect(page.locator(".vac-banner", has_text="Отпуск").first).to_be_visible()
    expect(page.locator(f".cal .day.vac[data-date='{TODAY.isoformat()}']")).to_have_count(1)
    page.click("nav [data-page=calendar]")
    expect(page.locator(f".cell.vac[data-date='{TODAY.isoformat()}']")).to_have_count(1)


def test_month_picker(page):
    page.click("[data-act=mp-open]")
    expect(page.locator(".mpop .mt")).to_have_count(12)
    page.click("[data-act=mp-year][data-v='1']")
    expect(page.locator(".mp-year b")).to_have_text(str(TODAY.year + 1))
    page.click("[data-act=mp-month][data-v='0']")
    expect(page.locator(".mbtn")).to_have_text(f"Январь {TODAY.year + 1}")
    expect(page.locator(".mpop")).to_have_count(0)


def test_pour_animation_and_off_switch(page):
    other = (TODAY + timedelta(days=1 if TODAY.day < 25 else -1)).isoformat()
    page.click(f".cal .day[data-date='{other}']")
    expect(page.locator(".cal .fx-fill")).to_have_count(1)          # лава наливается в новый день
    page.click("nav [data-page=settings]")
    page.click("[data-act=set-anim][data-v=off]")
    expect(page.locator("body")).to_have_class(re.compile(r"\banim-off\b"))
    page.click("nav [data-page=home]")
    expect(page.locator("#nav .fx-fill")).to_have_count(0)          # без анимации — ничего не льётся
    page.click(f".cal .day[data-date='{TODAY.isoformat()}']")
    expect(page.locator(".cal .fx-fill")).to_have_count(0)


def test_gender_phrases(page):
    page.click("nav [data-page=settings]")
    page.click("[data-act=set-gender][data-v=f]")
    page.click("nav [data-page=home]")
    item(page, "Тренировка").locator("[data-act=toggle]").click()
    expect(page.locator(".summary small")).to_have_text("Всё сделано — красотка")
    expect(page.locator("#heroSub")).to_contain_text("Ты всё сделала")


def test_animated_banner(page):
    page.click("header [data-act=add]")
    page.fill("#edTitle", "Читать книгу")
    expect(page.locator("[data-act=ed-anim]")).to_be_disabled()      # без категории сцены нет
    page.click("[data-act=ed-cat][data-v=growth]")
    page.click("[data-act=ed-anim]")
    expect(page.locator("[data-act=ed-anim]")).to_have_class(re.compile(r"\bon\b"))
    page.click("[data-act=ed-cat][data-v=growth]")                  # сняли категорию — переключатель гаснет
    expect(page.locator("[data-act=ed-anim]")).to_be_disabled()
    page.click("[data-act=ed-cat][data-v=growth]")
    page.click("[data-act=ed-anim]")
    page.fill("#edTime", "")
    page.type("#edTime", "2358")
    page.click("[data-act=ed-save]")
    banner = page.locator(".item.scb-growth", has_text="Читать книгу")
    expect(banner).to_be_visible()
    expect(banner.locator(".scene svg")).to_have_count(1)
    expect(page.locator(".item.scb", has_text="Тренировка")).to_have_count(0)  # без флага — обычная строка


# ---------- Заметки ----------
def api_call(pg, name, *args):
    return pg.evaluate("([n, a]) => fetch('/api/' + n, {method: 'POST', body: JSON.stringify(a)}).then(r => r.json())", [name, list(args)])


def add_note(pg, **fields):
    return api_call(pg, "note_save", fields)["note"]


def saved_notes(pg):
    return api_call(pg, "notes")["notes"]


def open_notes(pg):
    pg.click("nav [data-page=notes]")
    pg.wait_for_selector("#notesRoot")
    pg.wait_for_timeout(300)


def new_note(pg):
    pg.click(".nnew [data-act=n-new]")
    expect(pg.locator("#ntitle")).to_be_focused()


def show_props(pg):
    if not pg.locator("#nprops").is_visible():
        pg.click(".ned-top [data-act=n-props]")
    expect(pg.locator("#nprops")).to_be_visible()


def test_notes_empty_state_and_create_with_autosave(page):
    open_notes(page)
    expect(page.locator(".nlist .empty")).to_contain_text("Пока пусто")
    new_note(page)
    page.keyboard.type("Список дел")
    page.keyboard.press("Enter")                    # из заголовка — сразу в текст
    expect(page.locator("#nbody")).to_be_focused()
    page.keyboard.type("[] купить хлеб")            # «[] » в начале строки — пункт чек-листа
    expect(page.locator("#nbody li[data-task='0']")).to_have_text("купить хлеб")
    expect(page.locator("#nstatus")).to_have_text("Сохранено", timeout=3000)
    n = saved_notes(page)
    assert len(n) == 1 and n[0]["title"] == "Список дел" and n[0]["body"] == "- [ ] купить хлеб"
    expect(page.locator(".ncard.cur")).to_contain_text("купить хлеб")


def test_notes_text_survives_page_switch_and_background_refresh(page):
    open_notes(page)
    new_note(page)
    page.keyboard.type("Черновик")
    page.evaluate("app.refresh()")                  # как фоновое обновление раз в минуту
    expect(page.locator("#ntitle")).to_have_value("Черновик")
    expect(page.locator("#ntitle")).to_be_focused()
    page.click("nav [data-page=home]")              # ушли до автосохранения — правка не теряется
    page.wait_for_timeout(400)
    assert saved_notes(page)[0]["title"] == "Черновик"


def test_notes_empty_new_note_is_dropped(page):
    open_notes(page)
    new_note(page)
    page.click("nav [data-page=home]")
    page.wait_for_timeout(400)
    assert saved_notes(page) == []


def test_notes_markdown_roundtrip_and_formatting(page):
    md = "### План\n\n- [x] Готово\n- [ ] Не готово\n\n> **Главная идея**\n> Всё просто\n\n1. Раз\n2. Два\n\nТекст 2\\*3 и [сайт](https://example.org)"
    add_note(page, title="Формат", body=md)
    open_notes(page)
    body = page.locator("#nbody")
    expect(body.locator("h4")).to_have_text("План")
    expect(body.locator("li[data-task='1']")).to_have_text("Готово")
    expect(body.locator("blockquote b")).to_have_text("Главная идея")
    expect(body.locator("ol li")).to_have_count(2)
    expect(body.locator("a")).to_have_attribute("href", "https://example.org")
    assert "2*3" in body.inner_text()
    # галочка кликом по квадратику
    li = body.locator("li", has_text="Не готово")
    box = li.bounding_box()
    page.mouse.click(box["x"] - 16, box["y"] + box["height"] / 2)
    expect(li).to_have_attribute("data-task", "1")
    # жирный через панель
    page.evaluate("""() => { const li = document.querySelector('#nbody ol li'); const r = document.createRange();
      r.selectNodeContents(li); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.querySelector('#nbody').focus(); }""")
    page.click("[data-act=n-cmd][data-v=bold]")
    page.wait_for_timeout(900)
    saved = saved_notes(page)[0]["body"]
    assert "- [x] Не готово" in saved and "1. **Раз**" in saved and "2\\*3" in saved and "> **Главная идея**" in saved


def test_notes_autoformat_heading_list_quote(page):
    open_notes(page)
    new_note(page)
    page.keyboard.press("Enter")
    for line in ["# Заголовок", "- пункт", ]:
        page.keyboard.type(line)
        page.keyboard.press("Enter")
        page.keyboard.press("Enter") if line.startswith("-") else None
    page.keyboard.type("> идея")
    page.wait_for_timeout(900)
    assert saved_notes(page)[0]["body"] == "# Заголовок\n\n- пункт\n\n> идея"


def test_notes_search_by_content_tags_and_filters(page):
    add_note(page, title="Поездка", body="Взять зарядку и паспорт", tags=["отпуск"])
    add_note(page, title="Работа", body="Регресс по релизу", favorite=True, folder="Работа")
    open_notes(page)
    expect(page.locator(".ncard").first).to_contain_text("Работа")   # избранное — наверху
    page.keyboard.press("Control+f")
    expect(page.locator("#nq")).to_be_focused()
    page.keyboard.type("ЗАРЯДК")                     # без учёта регистра, по тексту
    expect(page.locator(".ncard")).to_have_count(1)
    expect(page.locator(".ncard mark")).to_have_text("зарядк")
    page.keyboard.press("Escape")
    page.keyboard.type("отпуск")                     # и по тегам
    expect(page.locator(".ncard")).to_have_count(1)
    page.keyboard.press("Escape")
    page.click("[data-act=n-filter][data-v=fav]")
    expect(page.locator(".ncard")).to_have_count(1)
    page.click("[data-act=n-filter][data-v=all]")
    page.click("#ntabs [data-act=n-menu]")
    page.click("[data-act=n-folder-filter][data-v='Работа']")
    expect(page.locator(".ncard")).to_have_count(1)
    expect(page.locator("#ntabs")).to_contain_text("Работа")


def test_notes_folders_and_tags(page):
    add_note(page, title="Идея", folder="Личное")
    open_notes(page)
    show_props(page)
    page.click("#nprops [data-act=n-menu][data-v=pfolder]")
    page.click("#nprops [data-act=n-folder-new]")
    page.keyboard.type("Учёба")
    page.keyboard.press("Enter")
    expect(page.locator("#nprops .nsel").first).to_contain_text("Учёба")
    page.click("#nprops [data-act=n-addtag]")
    page.keyboard.type("#Важное")
    page.keyboard.press("Enter")
    page.keyboard.press("Escape")
    expect(page.locator("#ntags .tg")).to_have_text("важное")
    page.wait_for_timeout(600)
    n = saved_notes(page)[0]
    assert n["folder"] == "Учёба" and n["tags"] == ["важное"]
    page.click(".ftags [data-act=n-tag]")              # тег внизу заметки — фильтр
    expect(page.locator("#ntabs")).to_contain_text("#важное")
    page.click("[data-act=n-untag]")
    page.wait_for_timeout(600)
    assert saved_notes(page)[0]["tags"] == []


def test_notes_color_and_favorite(page):
    add_note(page, title="Идея")
    open_notes(page)
    show_props(page)
    page.click("[data-act=n-color][data-v=growth]")
    page.click(".ned-top [data-act=n-fav]")
    page.wait_for_timeout(500)
    n = saved_notes(page)[0]
    assert n["color"] == "growth" and n["favorite"] is True


def test_notes_props_panel_toggles(page):
    add_note(page, title="Идея")
    open_notes(page)
    expect(page.locator("#nprops")).to_be_hidden()     # окно 1280: свойства свёрнуты, тексту больше места
    page.click(".ned-top [data-act=n-props]")
    expect(page.locator("#nprops")).to_be_visible()
    page.click("#nprops .ph [data-act=n-props]")
    expect(page.locator("#nprops")).to_be_hidden()


def test_notes_parse_when(page):
    open_notes(page)
    r = page.evaluate("""() => {
      const t = new Date(2026, 9, 10);  // суббота
      const f = (s) => { const w = NOTES.parseWhen(s, t); return [w.date ? iso(w.date) : null, w.time, w.title]; };
      return [f("Позвонить в сервис в понедельник"), f("завтра в 15:30 созвон"), f("Купить билеты 12 октября"),
              f("через 2 дня отчёт"), f("в 7 вечера спорт"), f("15.10 сдать проект"), f("просто текст")];
    }""")
    assert r == [["2026-10-12", None, "Позвонить в сервис"], ["2026-10-11", "15:30", "Созвон"], ["2026-10-12", None, "Купить билеты"],
                 ["2026-10-12", None, "Отчёт"], [None, "19:00", "Спорт"], ["2026-10-15", None, "Сдать проект"], [None, None, "Просто текст"]]


def test_notes_selection_to_reminder_and_back(page):
    add_note(page, title="Ноутбук", body="Позвонить в сервис завтра в 15:00 насчёт ремонта")
    open_notes(page)
    page.evaluate("""() => { const p = document.querySelector('#nbody p'), tn = p.firstChild, s = tn.nodeValue;
      const r = document.createRange(); r.setStart(tn, 0); r.setEnd(tn, s.indexOf(' насчёт'));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }""")
    page.click(".nselpop [data-act=n-sel-remind]")
    expect(page.locator("#overlay")).to_have_class(re.compile("open"))
    expect(page.locator("#edTitle")).to_have_value("Позвонить в сервис")
    expect(page.locator("#edTime")).to_have_value("15:00")
    expect(page.locator("#edFromNote")).to_contain_text("«завтра»")
    page.click("[data-act=ed-save]")
    expect(page.locator("#nprops .nlr")).to_contain_text("Позвонить в сервис")
    n = saved_notes(page)[0]
    assert len(n["links"]) == 1
    # из напоминания — обратно в заметку
    page.click("#nprops .nlr-main")
    expect(page.locator("#edNotes")).to_contain_text("Ноутбук")
    page.keyboard.press("Escape")
    page.click("nav [data-page=home]")
    page.wait_for_timeout(300)
    page.evaluate(f"app.openEditor('{n['links'][0]}')")
    page.click("#edNotes [data-act=n-goto]")
    expect(page.locator("#ntitle")).to_have_value("Ноутбук")


def test_notes_link_existing_reminder_and_unlink(page):
    add_note(page, title="Спорт")
    open_notes(page)
    show_props(page)
    page.click("#nprops [data-act=n-menu][data-v=pick]")
    page.keyboard.type("трен")
    page.click(".nmenu.pick [data-act=n-link]")
    expect(page.locator("#nprops .nlr")).to_contain_text("Тренировка")
    page.wait_for_timeout(500)
    assert len(saved_notes(page)[0]["links"]) == 1
    page.hover("#nprops .nlr")
    page.click("#nprops [data-act=n-unlink]")
    page.wait_for_timeout(500)
    assert saved_notes(page)[0]["links"] == []


def test_notes_templates(page):
    open_notes(page)
    page.click(".nnew [data-act=n-tpl]")
    expect(page.locator(".ntpl")).to_have_count(5)
    page.click(".ntpl:has-text('Покупки')")
    expect(page.locator("#ntitle")).to_have_value("Покупки")
    expect(page.locator("#nbody li[data-task]")).to_have_count(3)
    expect(page.locator(".ncard.cur .ic")).to_be_visible()
    n = saved_notes(page)[0]
    assert n["icon"] == "bag" and n["color"] == "home"


def test_notes_export_markdown_download(page):
    add_note(page, title="Экспорт", body="- [ ] пункт", tags=["тест"])
    open_notes(page)
    page.click(".ned-top [data-act=n-menu][data-v=more]")
    page.click("[data-act=n-export]")
    expect(page.locator(".nprev")).to_contain_text("# Экспорт")
    page.click("[data-act=n-exp-fmt][data-v=txt]")
    expect(page.locator(".nprev")).to_contain_text("☐ пункт")
    with page.expect_download() as d:
        page.click("[data-act=n-exp-save]")
    assert d.value.suggested_filename == "Экспорт.txt"


def test_notes_history_and_restore(page, base_url):
    n = add_note(page, title="План", body="первый текст")
    data_path = None
    api_call(page, "note_save", {"id": n["id"], "body": "второй текст"})   # первая правка — старый текст уходит в историю
    open_notes(page)
    page.click(".ned-top [data-act=n-menu][data-v=more]")
    page.click("[data-act=n-history]")
    expect(page.locator(".nhist .ver.on")).to_be_visible()
    expect(page.locator(".ndiff .dl.del")).to_contain_text("первый текст")
    expect(page.locator(".ndiff .dl.ins")).to_contain_text("второй текст")
    page.click("[data-act=n-restore]")
    expect(page.locator("#nbody")).to_have_text("первый текст")
    assert saved_notes(page)[0]["body"] == "первый текст"


def test_notes_delete_slider_springs_back_and_burns(page):
    add_note(page, title="Удали меня")
    open_notes(page)
    show_props(page)
    page.locator("#nknob").scroll_into_view_if_needed()
    knob = page.locator("#nknob").bounding_box()
    x, y = knob["x"] + knob["width"] / 2, knob["y"] + knob["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 80, y, steps=5)              # не дотянул и отпустил — пружинит назад
    page.mouse.up()
    page.wait_for_timeout(700)
    assert page.evaluate("getComputedStyle(document.querySelector('#nburn')).getPropertyValue('--p').trim()") == "0.0000"
    assert len(saved_notes(page)) == 1
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 400, y, steps=8)             # до конца — заметка сгорает
    page.mouse.up()
    expect(page.locator(".ncard")).to_have_count(0, timeout=3000)
    assert saved_notes(page) == []


def test_notes_delete_by_holding_delete_key(page):
    add_note(page, title="Первая")
    add_note(page, title="Вторая")
    open_notes(page)
    page.click(".ned-top [data-act=n-menu][data-v=more]")
    page.click("[data-act=n-burn-focus]")            # ⋮ → «Удалить…» ставит фокус на ползунок
    expect(page.locator("#nknob")).to_be_focused()
    page.keyboard.down("Delete")
    page.wait_for_timeout(300)
    page.keyboard.up("Delete")                       # отпустил раньше — ничего не удалилось
    page.wait_for_timeout(600)
    assert len(saved_notes(page)) == 2
    page.focus("#nknob")
    page.keyboard.down("Delete")
    page.wait_for_timeout(1500)
    page.keyboard.up("Delete")
    expect(page.locator(".ncard")).to_have_count(1, timeout=3000)
    left = saved_notes(page)
    assert len(left) == 1
    expect(page.locator("#ntitle")).to_have_value(left[0]["title"])   # сразу открылась оставшаяся

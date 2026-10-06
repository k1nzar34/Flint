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


@pytest.mark.parametrize("name", ["calendar", "all", "stats", "settings", "home"])
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

"""Flint — точка входа: главное окно, фоновая проверка и всплывающие уведомления.

Запуск из исходников:  python app.py
Режим разработки в браузере (без pywebview):  python devserver.py
"""
import json
import threading
import time
from datetime import datetime

import webview

from api import Api, lock, store

try:
    import winsound
except ImportError:  # не Windows
    winsound = None

CHECK_EVERY_SEC = 5
POPUP_W, POPUP_H = 360, 440

state = {"main": None, "quitting": False}


class MainApi(Api):
    def quit(self):
        state["quitting"] = True
        for w in list(webview.windows):
            w.destroy()


class PopupApi:
    """Отдельный API для каждого всплывающего окна — знает, о каком напоминании оно."""

    def __init__(self, rid, day):
        self._rid, self._day = rid, day
        self._window = None

    def info(self):
        with lock:
            r = store.find(self._rid)
            if not r:
                return None
            d = datetime.strptime(self._day, "%Y-%m-%d").date()
            label = "Сегодня" if d == datetime.now().date() else f"{d.day} {MONTHS_GEN[d.month - 1]}"
            return {"title": r["title"], "note": r.get("note", ""),
                    "when": f"{label} · {r['start'][11:]}", "time": r["start"][11:],
                    "day": self._day, "category": r.get("category", ""),
                    "important": r.get("important", False), "theme": store.settings["theme"],
                    "snooze": store.settings["snooze_minutes"]}

    def action(self, name):
        main = state["main"]
        if name == "snooze":
            with lock:
                store.snooze(self._rid, int(store.settings["snooze_minutes"]), datetime.now())
        elif name == "done":
            with lock:
                r = store.find(self._rid)
                if r and self._day not in r.get("done", []):
                    store.toggle_done(self._rid, self._day)
        elif name == "open" and main:
            main.restore()
            main.show()
            main.evaluate_js(f"app.openEditor({json.dumps(self._rid)})")
        refresh_main()
        if self._window:
            self._window.destroy()


def refresh_main():
    if state["main"]:
        try:
            state["main"].evaluate_js("window.app && app.refresh()")
        except Exception:
            pass


MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня",
              "июля", "августа", "сентября", "октября", "ноября", "декабря"]


def show_popup(r):
    # для разовых — день самого напоминания, для повторяющихся — сегодняшнее вхождение
    day = r["start"][:10] if r["repeat"] == "none" else datetime.now().strftime("%Y-%m-%d")
    api = PopupApi(r["id"], day)
    x = y = None
    if webview.screens:
        s = webview.screens[0]
        stack = len([w for w in webview.windows if w.title == "Напоминание"])
        x = s.width - POPUP_W - 24 - stack * 24
        y = s.height - POPUP_H - 72 - stack * 24
    win = webview.create_window("Напоминание", "ui/popup.html", js_api=api,
                                width=POPUP_W, height=POPUP_H, x=x, y=y,
                                resizable=False, frameless=True, on_top=True,
                                easy_drag=True, background_color="#0E1020")
    api._window = win
    if winsound and store.settings.get("sound", True):
        winsound.MessageBeep(winsound.MB_ICONASTERISK)


def watcher():
    while not state["quitting"]:
        with lock:
            fired = store.due(datetime.now())
        for r in fired:
            show_popup(r)
        if fired:
            refresh_main()
        time.sleep(CHECK_EVERY_SEC)


def on_closing():
    # крестик сворачивает окно — напоминания продолжают работать; выход — из настроек
    if state["quitting"]:
        return True
    threading.Timer(0.05, state["main"].minimize).start()
    return False


def main():
    win = webview.create_window("Flint", "ui/index.html", js_api=MainApi(),
                                width=1280, height=820, min_size=(1080, 700),
                                background_color="#0B0D1A")
    win.events.closing += on_closing
    state["main"] = win
    webview.start(watcher, http_server=True)


if __name__ == "__main__":
    main()

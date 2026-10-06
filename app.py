"""Flint — точка входа: главное окно, фоновая проверка и всплывающие уведомления.

Запуск из исходников:  python app.py
Режим разработки в браузере (без pywebview):  python devserver.py
"""
import json
import os
import sys
import threading
import time
from datetime import datetime

import webview

from api import Api, lock, set_autostart, store
from core import popup_info

try:
    import winsound
except ImportError:  # не Windows
    winsound = None

CHECK_EVERY_SEC = 5
POPUP_W, POPUP_H = 360, 440

state = {"main": None, "quitting": False, "tray": None}
BASE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def style_titlebar(theme):
    """Полоса заголовка окна Windows в цвет темы: тёмная/светлая, на Windows 11 — точно в цвет фона."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        hwnd = ctypes.windll.user32.FindWindowW(None, "Flint")
        if not hwnd:
            return
        dwm, dark = ctypes.windll.dwmapi, theme == "dark"
        flag = ctypes.c_int(1 if dark else 0)
        for attr in (20, 19):  # DWMWA_USE_IMMERSIVE_DARK_MODE (новые и старые сборки Windows 10)
            if dwm.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(flag), 4) == 0:
                break
        # цвета в формате 0x00BBGGRR; на Windows 10 эти вызовы просто не сработают
        caption = ctypes.c_int(0x00170B09 if dark else 0x00FAF3F2)   # #090B17 / #F2F3FA
        text = ctypes.c_int(0x00B8918B if dark else 0x00936C66)      # приглушённый текст заголовка
        dwm.DwmSetWindowAttribute(hwnd, 35, ctypes.byref(caption), 4)  # DWMWA_CAPTION_COLOR
        dwm.DwmSetWindowAttribute(hwnd, 34, ctypes.byref(caption), 4)  # DWMWA_BORDER_COLOR
        dwm.DwmSetWindowAttribute(hwnd, 36, ctypes.byref(text), 4)     # DWMWA_TEXT_COLOR
        ctypes.windll.user32.RedrawWindow(hwnd, None, None, 0x0401)  # перерисовать только рамку (RDW_FRAME | RDW_INVALIDATE)
    except Exception:
        pass


class MainApi(Api):
    def titlebar(self):
        style_titlebar(store.settings["theme"])
        return True

    def quit(self):
        quit_app()


def quit_app(*_):
    state["quitting"] = True
    if state["tray"]:
        try:
            state["tray"].stop()
        except Exception:
            pass
    for w in list(webview.windows):
        w.destroy()


def show_main(*_):
    main = state["main"]
    if main:
        main.show()
        main.restore()


def start_tray():
    """Иконка у часов: клик — открыть окно, правая кнопка — «Открыть / Выход»."""
    try:
        import pystray
        from PIL import Image
    except ImportError:
        return None
    image = Image.open(os.path.join(BASE, "assets", "icon.png"))
    menu = pystray.Menu(pystray.MenuItem("Открыть", show_main, default=True),
                        pystray.MenuItem("Выход", quit_app))
    icon = pystray.Icon("Flint", image, "Flint", menu)
    icon.run_detached()
    return icon


class PopupApi:
    """Отдельный API для каждого всплывающего окна — знает, о каком напоминании оно."""

    def __init__(self, rid, day, offset=0):
        self._rid, self._day, self._offset = rid, day, offset
        self._window = None

    def info(self):
        with lock:
            r = store.find(self._rid)
            if not r:
                return None
            return popup_info(r, self._day, self._offset, store.settings, datetime.now().date())

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
            show_main()
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




def show_popup(r):
    # для разовых — день самого напоминания, для повторяющихся — сегодняшнее вхождение
    if r.get("kind") == "birthday":
        day = r["_bday"]
    else:
        day = r["start"][:10] if r["repeat"] == "none" else datetime.now().strftime("%Y-%m-%d")
    api = PopupApi(r["id"], day, r.get("_offset", 0))
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


def hide_to_tray():
    main, tray = state["main"], state["tray"]
    if not tray:  # трея нет (не Windows / нет pystray) — просто сворачиваем
        main.minimize()
        return
    main.hide()
    if not store.settings.get("tray_hint_shown"):
        with lock:
            store.update_settings({"tray_hint_shown": True})
        try:
            tray.notify("Flint работает в фоне — ищи огонёк у часов 🔥", "Flint")
        except Exception:
            pass


def on_closing():
    # крестик прячет окно в трей — напоминания продолжают работать; выход — из трея или меню
    if state["quitting"]:
        return True
    threading.Timer(0.05, hide_to_tray).start()
    return False


def main():
    background = "--background" in sys.argv  # запуск вместе с Windows — сразу в трей
    if store.settings.get("autostart"):
        try:
            set_autostart(True)  # включено по умолчанию; заодно обновляет путь, если exe переместили
        except OSError:
            pass
    win = webview.create_window("Flint", "ui/index.html", js_api=MainApi(),
                                width=1280, height=820, min_size=(1080, 700),
                                background_color="#0B0D1A", hidden=background)
    win.events.closing += on_closing
    win.events.shown += lambda: style_titlebar(store.settings["theme"])
    state["main"] = win
    state["tray"] = start_tray()
    try:
        webview.start(watcher, http_server=True)
    finally:
        if state["tray"]:
            try:
                state["tray"].stop()
            except Exception:
                pass


if __name__ == "__main__":
    main()

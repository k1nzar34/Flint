"""API, которое вызывает интерфейс (window.pywebview.api.* или /api/* в dev-режиме)."""
import sys
import threading
from datetime import date, datetime

from core import CATEGORIES, DFMT, REPEATS, Store, ValidationError

store = Store()
lock = threading.RLock()


def _d(s):
    return date.fromisoformat(s)


def set_autostart(enabled):
    """Автозапуск через реестр текущего пользователя (только для собранного exe)."""
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return False
    import winreg
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                         r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                         winreg.KEY_SET_VALUE)
    with key:
        if enabled:
            winreg.SetValueEx(key, "Flint", 0, winreg.REG_SZ, f'"{sys.executable}"')
        else:
            try:
                winreg.DeleteValue(key, "Flint")
            except FileNotFoundError:
                pass
    return True


class Api:
    def init(self):
        with lock:
            return {"settings": store.settings, "today": date.today().strftime(DFMT),
                    "categories": CATEGORIES, "repeats": REPEATS,
                    "canAutostart": sys.platform == "win32" and getattr(sys, "frozen", False)}

    def month(self, year, month):
        with lock:
            return store.month_marks(int(year), int(month))

    def hot(self, year, month):
        with lock:
            return store.month_hot(int(year), int(month))

    def range(self, d1, d2):
        with lock:
            return store.items_between(_d(d1), _d(d2), datetime.now())

    def stats(self, period):
        with lock:
            return store.stats(period, datetime.now())

    def get(self, rid):
        with lock:
            r = store.find(rid)
            if not r:
                return None
            date_s, time_s = r["start"].split(" ")
            return {**r, "date": date_s, "time": time_s}

    def save(self, payload):
        with lock:
            try:
                r = store.upsert(payload, datetime.now())
                return {"ok": True, "id": r["id"], "date": r["start"][:10]}
            except ValidationError as e:
                return {"error": str(e)}

    def delete(self, rid):
        with lock:
            store.delete(rid)
            return True

    def toggle_done(self, rid, day):
        with lock:
            return store.toggle_done(rid, day)

    def save_settings(self, values):
        with lock:
            if "autostart" in values and values["autostart"] != store.settings["autostart"]:
                try:
                    set_autostart(bool(values["autostart"]))
                except OSError:
                    values.pop("autostart")
            store.update_settings(values)
            return store.settings

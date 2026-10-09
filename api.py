"""API, которое вызывает интерфейс (window.pywebview.api.* или /api/* в dev-режиме)."""
import sys
import threading
from datetime import date, datetime

from core import CATEGORIES, DFMT, REPEATS, Store, ValidationError, kind_of, next_birthday

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
            # --background: при входе в Windows Flint стартует сразу в трее, без окна
            winreg.SetValueEx(key, "Flint", 0, winreg.REG_SZ, f'"{sys.executable}" --background')
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

    def month_info(self, year, month):
        with lock:
            return store.month_info(int(year), int(month))

    def year_overview(self, year):
        with lock:
            return store.year_overview(int(year))

    def vacations(self, d1, d2):
        with lock:
            return store.vacations_between(_d(d1), _d(d2))

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
            out = {**r, "kind": kind_of(r), "date": date_s, "time": time_s}
            if out["kind"] == "birthday":
                out["date"] = next_birthday(r, date.today()).strftime(DFMT)
            elif out["kind"] == "vacation":
                out["date_end"] = r["end"]
            return out

    def save(self, payload):
        with lock:
            try:
                r = store.upsert(payload, datetime.now())
                day = r["start"][:10]
                if kind_of(r) == "birthday":
                    day = next_birthday(r, date.today()).strftime(DFMT)
                return {"ok": True, "id": r["id"], "date": day, "kind": kind_of(r)}
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

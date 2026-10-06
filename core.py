"""Бизнес-логика Flint: хранение, повторы, выполнение, уведомления, статистика.

Модуль не зависит от интерфейса, поэтому покрыт unit-тестами (tests/test_core.py).
"""
import json
import os
import uuid
from datetime import date, datetime, timedelta

FMT = "%Y-%m-%d %H:%M"
DFMT = "%Y-%m-%d"

REPEATS = {
    "none": "Разово",
    "daily": "Каждый день",
    "weekdays": "По будням",
    "weekly": "Раз в неделю",
}
CATEGORIES = {
    "work": "Работа",
    "health": "Здоровье",
    "personal": "Личное",
    "home": "Быт",
    "growth": "Развитие",
}
DEFAULT_SETTINGS = {
    "name": "Дима",
    "theme": "dark",
    "sound": True,
    "snooze_minutes": 10,
    "autostart": False,
}


def default_path():
    if os.environ.get("FLINT_DATA"):  # для тестов и dev-режима
        return os.environ["FLINT_DATA"]
    base = os.environ.get("APPDATA", os.path.expanduser("~"))
    return os.path.join(base, "Flint", "data.json")


def parse(s):
    return datetime.strptime(s, FMT)


def fmt(dt):
    return dt.strftime(FMT)


def daterange(d1, d2):
    d = d1
    while d <= d2:
        yield d
        d += timedelta(days=1)


# ---------- Повторы ----------
def occurs_on(r, d):
    """Есть ли у напоминания r вхождение в день d."""
    start = parse(r["start"]).date()
    rep = r["repeat"]
    if rep == "none":
        return d == start
    if d < start:
        return False
    if rep == "daily":
        return True
    if rep == "weekdays":
        return d.weekday() < 5
    if rep == "weekly":
        return (d - start).days % 7 == 0
    return False


def occurrence_dt(r, d):
    return datetime.combine(d, parse(r["start"]).time())


def is_done(r, d):
    return d.strftime(DFMT) in r.get("done", [])


def period_bounds(period, today):
    if period == "week":
        start = today - timedelta(days=today.weekday())
        return start, start + timedelta(days=6)
    if period == "month":
        start = today.replace(day=1)
        nxt = (start + timedelta(days=32)).replace(day=1)
        return start, nxt - timedelta(days=1)
    if period == "year":
        return date(today.year, 1, 1), date(today.year, 12, 31)
    raise ValueError(f"Неизвестный период: {period}")


# ---------- Хранилище ----------
class ValidationError(Exception):
    pass


class Store:
    def __init__(self, path=None):
        self.path = path or default_path()
        self.reminders = []
        self.settings = dict(DEFAULT_SETTINGS)
        self.load()

    def load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return
        self.settings.update(data.get("settings", {}))
        self.reminders = [r for r in data.get("reminders", []) if "start" in r]

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"settings": self.settings, "reminders": self.reminders},
                      f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)

    def find(self, rid):
        return next((r for r in self.reminders if r["id"] == rid), None)

    # ---------- CRUD ----------
    def upsert(self, payload, now):
        existing = self.find(payload.get("id")) if payload.get("id") else None

        title = str(payload.get("title", "")).strip()
        if not title:
            raise ValidationError("Напиши, о чём напомнить")
        if len(title) > 200:
            raise ValidationError("Слишком длинное название (максимум 200 символов)")
        try:
            start = parse(f'{payload.get("date", "")} {payload.get("time", "")}')
        except ValueError:
            raise ValidationError("Проверь дату и время")
        repeat = payload.get("repeat", "none")
        if repeat not in REPEATS:
            raise ValidationError("Неизвестный тип повтора")
        category = payload.get("category") or ""
        if category and category not in CATEGORIES:
            raise ValidationError("Неизвестная категория")

        unchanged_time = existing and existing["start"] == fmt(start)
        if repeat == "none" and start <= now and not unchanged_time:
            raise ValidationError("Это время уже прошло")

        r = existing or {"id": uuid.uuid4().hex, "created": fmt(now), "done": []}
        r.update(
            title=title,
            note=str(payload.get("note", "")).strip()[:2000],
            category=category,
            important=bool(payload.get("important")),
            repeat=repeat,
            start=fmt(start),
            notified=fmt(now),  # уведомляем только о том, что впереди
            snooze_until=None,
        )
        if not existing:
            self.reminders.append(r)
        self.save()
        return r

    def delete(self, rid):
        self.reminders = [r for r in self.reminders if r["id"] != rid]
        self.save()

    def toggle_done(self, rid, day_str):
        r = self.find(rid)
        if not r:
            return False
        done = r.setdefault("done", [])
        if day_str in done:
            done.remove(day_str)
            state = False
        else:
            done.append(day_str)
            state = True
        self.save()
        return state

    def snooze(self, rid, minutes, now):
        r = self.find(rid)
        if r:
            r["snooze_until"] = fmt(now.replace(second=0, microsecond=0)
                                    + timedelta(minutes=minutes))
            self.save()

    def update_settings(self, values):
        for k, v in values.items():
            if k in DEFAULT_SETTINGS:
                self.settings[k] = v
        self.save()

    # ---------- Уведомления ----------
    def due(self, now):
        """Возвращает напоминания, о которых пора сообщить, и отмечает их как показанные."""
        fired = []
        for r in self.reminders:
            snooze = r.get("snooze_until")
            if snooze and parse(snooze) <= now:
                r["snooze_until"] = None
                fired.append(r)
                continue
            if r["repeat"] == "none":
                occ = parse(r["start"])
            elif occurs_on(r, now.date()):
                occ = occurrence_dt(r, now.date())
            else:
                continue
            notified = parse(r["notified"]) if r.get("notified") else datetime.min
            if notified < occ <= now and not is_done(r, occ.date()):
                r["notified"] = fmt(occ)
                fired.append(r)
        if fired:
            self.save()
        return fired

    # ---------- Выборки для интерфейса ----------
    def item(self, r, d, now):
        occ = occurrence_dt(r, d)
        return {
            "id": r["id"], "title": r["title"], "note": r.get("note", ""),
            "category": r.get("category", ""), "important": r.get("important", False),
            "repeat": r["repeat"], "date": d.strftime(DFMT), "time": occ.strftime("%H:%M"),
            "done": is_done(r, d), "past": occ < now,
        }

    def items_between(self, d1, d2, now):
        out = [self.item(r, d, now)
               for d in daterange(d1, d2) for r in self.reminders if occurs_on(r, d)]
        return sorted(out, key=lambda i: (i["date"], i["time"]))

    def month_marks(self, year, month):
        first = date(year, month, 1) - timedelta(days=7)
        last = date(year, month, 28) + timedelta(days=14)
        marks = {}
        for d in daterange(first, last):
            n = sum(1 for r in self.reminders if occurs_on(r, d))
            if n:
                marks[d.strftime(DFMT)] = n
        return marks

    def month_hot(self, year, month):
        """Дни (с соседними неделями сетки), где есть невыполненный приоритет — для «огонька»."""
        first = date(year, month, 1) - timedelta(days=7)
        last = date(year, month, 28) + timedelta(days=14)
        return [d.strftime(DFMT) for d in daterange(first, last)
                if any(r.get("important") and occurs_on(r, d) and not is_done(r, d)
                       for r in self.reminders)]

    def stats(self, period, now):
        d1, d2 = period_bounds(period, now.date())
        done = missed = left = 0
        by_cat = {}
        for d in daterange(d1, d2):
            for r in self.reminders:
                if not occurs_on(r, d):
                    continue
                cat = r.get("category") or "none"
                c = by_cat.setdefault(cat, [0, 0])
                c[1] += 1
                if is_done(r, d):
                    done += 1
                    c[0] += 1
                elif occurrence_dt(r, d) < now:
                    missed += 1
                else:
                    left += 1
        total = done + missed + left
        cats = sorted(
            ({"key": k, "percent": round(v[0] / v[1] * 100), "total": v[1]}
             for k, v in by_cat.items() if k != "none"),
            key=lambda c: -c["total"])
        return {
            "period": period, "from": d1.strftime(DFMT), "to": d2.strftime(DFMT),
            "done": done, "missed": missed, "left": left, "total": total,
            "percent": round(done / total * 100) if total else 0, "categories": cats,
        }

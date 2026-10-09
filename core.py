"""Бизнес-логика Flint: хранение, повторы, выполнение, уведомления, статистика.

Модуль не зависит от интерфейса, поэтому покрыт unit-тестами (tests/test_core.py).

Типы записей (поле kind):
  reminder — обычное напоминание (по умолчанию);
  birthday — день рождения: повторяется каждый год, напоминает в день / за день / за неделю;
  vacation — отпуск: диапазон дат, может глушить рабочие напоминания.
"""
import calendar
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
    "monthly": "Каждый месяц",
    "yearly": "Каждый год",
}
CATEGORIES = {
    "work": "Работа",
    "health": "Здоровье",
    "personal": "Личное",
    "home": "Быт",
    "growth": "Развитие",
}
KINDS = ("reminder", "birthday", "vacation")
MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня",
              "июля", "августа", "сентября", "октября", "ноября", "декабря"]
BIRTHDAY_OFFSETS = (0, 1, 7)       # в сам день, за день, за неделю
BIRTHDAY_BASE_YEAR = 2000          # високосный — чтобы хранить и 29 февраля
DEFAULT_SETTINGS = {
    "name": "Дима",
    "gender": "m",                  # m / f / n — для фраз в интерфейсе
    "theme": "dark",
    "sound": True,
    "snooze_minutes": 10,
    "autostart": True,              # запускать вместе с Windows (в трее)
    "anim_effect": "lava",          # lava / plain / off
    "anim_speed": "normal",         # fast / normal / slow
    "anim_live": True,              # «живые картинки»: море, кораблик, пляж, свечи, конфетти
    "tray_hint_shown": False,       # подсказку «Flint работает в фоне» показали
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


def kind_of(r):
    return r.get("kind", "reminder")


def safe_day(year, month, day):
    """Дата с подрезкой дня: 31-е в месяце из 30 дней → 30-е, 29 февраля в невисокосный → 28-е."""
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


# ---------- Повторы ----------
def occurs_on(r, d):
    """Есть ли у записи r вхождение в день d."""
    start = parse(r["start"]).date()
    if kind_of(r) == "vacation":
        return start <= d <= date.fromisoformat(r["end"])
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
    if rep == "monthly":
        return d == safe_day(d.year, d.month, start.day)
    if rep == "yearly":
        return d == safe_day(d.year, start.month, start.day)
    return False


def occurrence_dt(r, d):
    return datetime.combine(d, parse(r["start"]).time())


def is_done(r, d):
    return d.strftime(DFMT) in r.get("done", [])


def birthday_on(r, year):
    """Дата дня рождения r в указанном году."""
    s = parse(r["start"]).date()
    return safe_day(year, s.month, s.day)


def next_birthday(r, today):
    d = birthday_on(r, today.year)
    return d if d >= today else birthday_on(r, today.year + 1)


def age_on(r, d):
    by = r.get("birth_year")
    return d.year - by if by else None


def popup_info(r, day_str, offset, settings, today):
    """Данные для всплывающего уведомления (общие для приложения и dev-сервера)."""
    d = date.fromisoformat(day_str)
    label = "Сегодня" if d == today else f"{d.day} {MONTHS_GEN[d.month - 1]}"
    info = {"kind": kind_of(r), "title": r["title"], "note": r.get("note", ""), "day": day_str,
            "time": r["start"][11:], "category": r.get("category", ""), "important": r.get("important", False),
            "theme": settings["theme"], "snooze": settings["snooze_minutes"]}
    if info["kind"] == "birthday":
        lead = {0: "Сегодня", 1: "Завтра", 7: "Через неделю"}.get(offset, "Скоро")
        info.update(when=f"{lead} · {d.day} {MONTHS_GEN[d.month - 1]}", age=age_on(r, d), offset=offset)
    else:
        info["when"] = f"{label} · {r['start'][11:]}"
    return info


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
        except FileNotFoundError:
            return
        except (json.JSONDecodeError, UnicodeDecodeError):
            # файл повреждён (например, правили руками) — не затираем его, а откладываем копию рядом
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            try:
                os.replace(self.path, f"{self.path[:-5] if self.path.endswith('.json') else self.path}.broken-{stamp}.json")
            except OSError:
                pass
            return
        if not isinstance(data, dict):
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

    def of_kind(self, kind):
        return [r for r in self.reminders if kind_of(r) == kind]

    # ---------- CRUD ----------
    def upsert(self, payload, now):
        kind = payload.get("kind") or "reminder"
        if kind not in KINDS:
            raise ValidationError("Неизвестный тип записи")
        existing = self.find(payload.get("id")) if payload.get("id") else None
        if existing and kind_of(existing) != kind:
            raise ValidationError("Тип записи менять нельзя — создай новую")
        fields = {"reminder": self._reminder_fields, "birthday": self._birthday_fields,
                  "vacation": self._vacation_fields}[kind](payload, existing, now)

        r = existing or {"id": uuid.uuid4().hex, "created": fmt(now), "done": []}
        r.update(kind=kind, note=str(payload.get("note", "")).strip()[:2000],
                 notified=fmt(now), snooze_until=None, **fields)  # уведомляем только о том, что впереди
        if not existing:
            self.reminders.append(r)
        self.save()
        return r

    @staticmethod
    def _title(payload, empty_message, default=None):
        title = str(payload.get("title", "")).strip() or (default or "")
        if not title:
            raise ValidationError(empty_message)
        if len(title) > 200:
            raise ValidationError("Слишком длинное название (максимум 200 символов)")
        return title

    def _reminder_fields(self, payload, existing, now):
        title = self._title(payload, "Напиши, о чём напомнить")
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
        return {"title": title, "category": category, "important": bool(payload.get("important")),
                "repeat": repeat, "start": fmt(start)}

    def _birthday_fields(self, payload, existing, now):
        title = self._title(payload, "Напиши, чей день рождения")
        try:
            d = date.fromisoformat(str(payload.get("date", "")))
            t = datetime.strptime(str(payload.get("time", "")), "%H:%M").time()
        except ValueError:
            raise ValidationError("Проверь дату и время")
        birth_year = payload.get("birth_year")
        if birth_year in ("", None):
            birth_year = None
        else:
            try:
                birth_year = int(birth_year)
            except (TypeError, ValueError):
                raise ValidationError("Год рождения — четыре цифры, например 1998")
            if not 1900 <= birth_year <= now.year:
                raise ValidationError(f"Год рождения должен быть от 1900 до {now.year}")
        remind = sorted({int(x) for x in payload.get("remind", []) if int(x) in BIRTHDAY_OFFSETS})
        start = datetime.combine(date(BIRTHDAY_BASE_YEAR, d.month, d.day), t)
        return {"title": title, "category": "", "important": False, "repeat": "yearly",
                "start": fmt(start), "birth_year": birth_year, "remind": remind}

    def _vacation_fields(self, payload, existing, now):
        title = self._title(payload, "", default="Отпуск")
        try:
            d1 = date.fromisoformat(str(payload.get("date", "")))
            d2 = date.fromisoformat(str(payload.get("date_end", "")))
        except ValueError:
            raise ValidationError("Укажи даты начала и конца отпуска")
        if d2 < d1:
            raise ValidationError("Отпуск не может закончиться раньше, чем начался")
        if (d2 - d1).days > 365:
            raise ValidationError("Отпуск длиннее года — проверь даты")
        return {"title": title, "category": "", "important": False, "repeat": "none",
                "start": fmt(datetime.combine(d1, datetime.min.time())), "end": d2.strftime(DFMT),
                "mute_work": bool(payload.get("mute_work")),
                "seed": uuid.uuid4().hex[:8]}  # острова на горизонте перемешиваются при каждом сохранении

    def delete(self, rid):
        self.reminders = [r for r in self.reminders if r["id"] != rid]
        self.save()

    def toggle_done(self, rid, day_str):
        r = self.find(rid)
        if not r or kind_of(r) != "reminder":
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

    CHOICES = {"gender": ("m", "f", "n"), "theme": ("dark", "light"), "snooze_minutes": (5, 10, 15, 30, 60, 120),
               "anim_effect": ("lava", "plain", "off"), "anim_speed": ("fast", "normal", "slow")}

    def update_settings(self, values):
        for k, v in values.items():
            if k in DEFAULT_SETTINGS and v in self.CHOICES.get(k, (v,)):
                self.settings[k] = v
        self.save()

    # ---------- Отпуск ----------
    def vacation_on(self, d):
        return next((v for v in self.of_kind("vacation") if occurs_on(v, d)), None)

    def work_muted(self, d):
        return any(v.get("mute_work") and occurs_on(v, d) for v in self.of_kind("vacation"))

    # ---------- Уведомления ----------
    def due(self, now):
        """Записи, о которых пора сообщить; отмечает их как показанные.

        Для дней рождения возвращается копия с полями _bday (дата праздника) и _offset (за сколько дней).
        """
        fired = []
        for r in self.reminders:
            kind = kind_of(r)
            if kind == "vacation":
                continue
            snooze = r.get("snooze_until")
            if snooze and parse(snooze) <= now:
                r["snooze_until"] = None
                fired.append(self._birthday_event(r, now.date(), 0) if kind == "birthday" else r)
                continue
            notified = parse(r["notified"]) if r.get("notified") else datetime.min
            if kind == "birthday":
                event = self._birthday_due(r, notified, now)
                if event:
                    fired.append(event)
                continue
            if r["repeat"] == "none":
                occ = parse(r["start"])
            elif occurs_on(r, now.date()):
                occ = occurrence_dt(r, now.date())
            else:
                continue
            if notified < occ <= now and not is_done(r, occ.date()):
                r["notified"] = fmt(occ)
                if r.get("category") == "work" and self.work_muted(occ.date()):
                    continue  # в отпуске о работе молчим
                fired.append(r)
        if fired:
            self.save()
        return fired

    def _birthday_due(self, r, notified, now):
        best = None
        t = parse(r["start"]).time()
        for year in (now.year, now.year + 1):
            bday = birthday_on(r, year)
            for off in r.get("remind", []):
                at = datetime.combine(bday - timedelta(days=off), t)
                if notified < at <= now and (best is None or at > best[0]):
                    best = (at, bday, off)
        if not best:
            return None
        r["notified"] = fmt(best[0])
        return self._birthday_event(r, best[1], best[2])

    @staticmethod
    def _birthday_event(r, bday, offset):
        return {**r, "_bday": bday.strftime(DFMT), "_offset": offset}

    # ---------- Выборки для интерфейса ----------
    def item(self, r, d, now):
        occ = occurrence_dt(r, d)
        it = {
            "id": r["id"], "kind": kind_of(r), "title": r["title"], "note": r.get("note", ""),
            "category": r.get("category", ""), "important": r.get("important", False),
            "repeat": r["repeat"], "date": d.strftime(DFMT), "time": occ.strftime("%H:%M"),
            "done": is_done(r, d), "past": occ < now,
        }
        if it["kind"] == "birthday":
            it.update(age=age_on(r, d), past=False, remind=r.get("remind", []))
        elif it["category"] == "work" and self.work_muted(d):
            it["muted"] = True
        return it

    def items_between(self, d1, d2, now):
        """Напоминания и дни рождения по дням (отпуск отдаётся отдельно — vacations_between)."""
        out = [self.item(r, d, now)
               for d in daterange(d1, d2) for r in self.reminders
               if kind_of(r) != "vacation" and occurs_on(r, d)]
        # дни рождения — первыми в своём дне, дальше по времени
        return sorted(out, key=lambda i: (i["date"], i["kind"] != "birthday", i["time"]))

    def vacations_between(self, d1, d2):
        out = []
        for v in self.of_kind("vacation"):
            s, e = parse(v["start"]).date(), date.fromisoformat(v["end"])
            if s <= d2 and e >= d1:
                out.append({"id": v["id"], "title": v["title"], "start": s.strftime(DFMT),
                            "end": v["end"], "mute_work": v.get("mute_work", False), "seed": v.get("seed", ""),
                            "note": v.get("note", "")})
        return sorted(out, key=lambda v: v["start"])

    def vacation_clusters(self):
        """Пересекающиеся (или стык в стык) отпуска сливаются в одно «море»: один кораблик, общие края."""
        spans = sorted(((parse(v["start"]).date(), date.fromisoformat(v["end"]), v) for v in self.of_kind("vacation")),
                       key=lambda x: x[0])
        out = []
        for s, e, v in spans:
            if out and s <= out[-1]["end"] + timedelta(days=1):
                c = out[-1]
                c["end"] = max(c["end"], e)
                c["titles"].append(v["title"])
            else:
                out.append({"id": v["id"], "start": s, "end": e, "titles": [v["title"]]})
        return out

    @staticmethod
    def _grid_bounds(year, month):
        return date(year, month, 1) - timedelta(days=7), date(year, month, 28) + timedelta(days=14)

    def month_marks(self, year, month):
        """Сколько обычных напоминаний в каждом дне сетки месяца (для точек)."""
        first, last = self._grid_bounds(year, month)
        marks = {}
        rem = self.of_kind("reminder")
        for d in daterange(first, last):
            n = sum(1 for r in rem if occurs_on(r, d))
            if n:
                marks[d.strftime(DFMT)] = n
        return marks

    def month_hot(self, year, month):
        """Дни (с соседними неделями сетки), где есть невыполненный приоритет — для «огонька»."""
        first, last = self._grid_bounds(year, month)
        rem = [r for r in self.of_kind("reminder") if r.get("important")]
        return [d.strftime(DFMT) for d in daterange(first, last)
                if any(occurs_on(r, d) and not is_done(r, d) for r in rem)]

    def month_info(self, year, month):
        """Всё для мини-календаря одним запросом: точки, огоньки, дни рождения, отпуск."""
        first, last = self._grid_bounds(year, month)
        bdays, vac = {}, {}
        clusters = self.vacation_clusters()
        for d in daterange(first, last):
            key = d.strftime(DFMT)
            names = [r["title"] for r in self.of_kind("birthday") if occurs_on(r, d)]
            if names:
                bdays[key] = names
            c = next((c for c in clusters if c["start"] <= d <= c["end"]), None)
            if c:
                vac[key] = {"id": c["id"], "start": c["start"] == d, "end": c["end"] == d}
        return {"marks": self.month_marks(year, month), "hot": self.month_hot(year, month),
                "bdays": bdays, "vac": vac}

    def year_overview(self, year):
        """Пометки для панели выбора месяца: дни рождения, отпуск и невыполненные приоритеты."""
        months = [{"bdays": 0, "vacation": False, "hot": 0} for _ in range(12)]
        for r in self.of_kind("birthday"):
            months[birthday_on(r, year).month - 1]["bdays"] += 1
        for v in self.of_kind("vacation"):
            s, e = parse(v["start"]).date(), date.fromisoformat(v["end"])
            for m in range(1, 13):
                m1, m2 = date(year, m, 1), date(year, m, calendar.monthrange(year, m)[1])
                if s <= m2 and e >= m1:
                    months[m - 1]["vacation"] = True
        hot = [r for r in self.of_kind("reminder") if r.get("important")]
        if hot:
            for d in daterange(date(year, 1, 1), date(year, 12, 31)):
                months[d.month - 1]["hot"] += sum(1 for r in hot if occurs_on(r, d) and not is_done(r, d))
        return months

    def stats(self, period, now):
        """Статистика выполнения — только обычные напоминания (дни рождения и отпуск не считаются)."""
        d1, d2 = period_bounds(period, now.date())
        done = missed = left = 0
        by_cat = {}
        rem = self.of_kind("reminder")
        for d in daterange(d1, d2):
            for r in rem:
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

from datetime import date, datetime

import pytest

from core import Store, ValidationError, occurs_on, period_bounds

NOW = datetime(2026, 10, 8, 12, 0)  # четверг


@pytest.fixture
def store(tmp_path):
    return Store(str(tmp_path / "data.json"))


def add(store, title="Задача", d="2026-10-08", t="18:00", repeat="none", now=NOW, **kw):
    return store.upsert({"title": title, "date": d, "time": t, "repeat": repeat, **kw}, now)


# ---------- Повторы ----------
@pytest.mark.parametrize("repeat, day, expected", [
    ("none", date(2026, 10, 8), True),
    ("none", date(2026, 10, 9), False),
    ("daily", date(2026, 10, 7), False),   # до старта
    ("daily", date(2026, 10, 11), True),
    ("weekdays", date(2026, 10, 10), False),  # суббота
    ("weekdays", date(2026, 10, 12), True),   # понедельник
    ("weekly", date(2026, 10, 15), True),
    ("weekly", date(2026, 10, 16), False),
    ("monthly", date(2026, 11, 8), True),
    ("monthly", date(2026, 11, 9), False),
    ("yearly", date(2027, 10, 8), True),
    ("yearly", date(2027, 10, 9), False),
])
def test_occurs_on(repeat, day, expected):
    r = {"start": "2026-10-08 10:00", "repeat": repeat}
    assert occurs_on(r, day) is expected


def test_period_bounds():
    assert period_bounds("week", date(2026, 10, 8)) == (date(2026, 10, 5), date(2026, 10, 11))
    assert period_bounds("month", date(2026, 2, 10)) == (date(2026, 2, 1), date(2026, 2, 28))
    assert period_bounds("year", date(2026, 5, 5)) == (date(2026, 1, 1), date(2026, 12, 31))


# ---------- Валидация ----------
@pytest.mark.parametrize("payload, message", [
    ({"title": "  "}, "Напиши"),
    ({"time": "25:99"}, "дату и время"),
    ({"t": "11:00"}, "прошло"),
    ({"repeat": "hourly"}, "повтора"),
    ({"category": "sport"}, "категория"),
    ({"title": "x" * 201}, "длинное"),
])
def test_validation_errors(store, payload, message):
    data = {"title": "Ок", "date": "2026-10-08", "time": "18:00", "repeat": "none"}
    if "t" in payload:
        data["time"] = payload.pop("t")
    data.update(payload)
    with pytest.raises(ValidationError, match=message):
        store.upsert(data, NOW)


def test_past_time_allowed_for_recurring(store):
    r = add(store, t="09:00", repeat="daily")
    assert r["start"] == "2026-10-08 09:00"


def test_edit_past_one_off_without_changing_time(store):
    r = add(store, t="12:30")
    later = datetime(2026, 10, 8, 13, 0)
    edited = store.upsert({"id": r["id"], "title": "Новое", "date": "2026-10-08",
                           "time": "12:30", "repeat": "none"}, later)
    assert edited["title"] == "Новое"


def test_persistence(store):
    add(store, title="Сохранится", note="заметка", category="work", important=True)
    again = Store(store.path)
    assert again.reminders[0]["title"] == "Сохранится"
    assert again.reminders[0]["category"] == "work"


# ---------- Уведомления ----------
def test_due_one_off_fires_once(store):
    r = add(store, t="12:30")
    assert store.due(datetime(2026, 10, 8, 12, 29)) == []
    assert store.due(datetime(2026, 10, 8, 12, 30)) == [r]
    assert store.due(datetime(2026, 10, 8, 12, 31)) == []


def test_due_missed_while_app_was_closed(store):
    r = add(store, t="12:30")
    assert store.due(datetime(2026, 10, 8, 20, 0)) == [r]


def test_due_recurring_every_day(store):
    r = add(store, t="12:30", repeat="daily")
    assert store.due(datetime(2026, 10, 8, 12, 30)) == [r]
    assert store.due(datetime(2026, 10, 9, 12, 29)) == []
    assert store.due(datetime(2026, 10, 9, 12, 30)) == [r]


def test_due_skips_weekend_for_weekdays(store):
    add(store, t="12:30", repeat="weekdays")
    assert store.due(datetime(2026, 10, 10, 12, 30)) == []


def test_due_skips_done(store):
    r = add(store, t="12:30")
    store.toggle_done(r["id"], "2026-10-08")
    assert store.due(datetime(2026, 10, 8, 12, 30)) == []


def test_new_recurring_with_passed_time_does_not_fire_today(store):
    add(store, t="09:00", repeat="daily")
    assert store.due(datetime(2026, 10, 8, 12, 1)) == []


def test_snooze(store):
    r = add(store, t="12:30")
    store.due(datetime(2026, 10, 8, 12, 30))
    store.snooze(r["id"], 10, datetime(2026, 10, 8, 12, 30, 40))
    assert store.due(datetime(2026, 10, 8, 12, 39)) == []
    assert store.due(datetime(2026, 10, 8, 12, 40)) == [r]
    assert store.due(datetime(2026, 10, 8, 12, 41)) == []


# ---------- Выполнение и выборки ----------
def test_toggle_done(store):
    r = add(store)
    assert store.toggle_done(r["id"], "2026-10-08") is True
    assert store.items_between(date(2026, 10, 8), date(2026, 10, 8), NOW)[0]["done"] is True
    assert store.toggle_done(r["id"], "2026-10-08") is False


def test_items_sorted_and_marks(store):
    add(store, title="Вечер", t="20:00")
    add(store, title="Обед", t="13:00")
    add(store, title="Зарядка", t="07:00", repeat="weekly")
    items = store.items_between(date(2026, 10, 8), date(2026, 10, 15), NOW)
    assert [i["title"] for i in items] == ["Зарядка", "Обед", "Вечер", "Зарядка"]
    marks = store.month_marks(2026, 10)
    assert marks["2026-10-08"] == 3 and marks["2026-10-15"] == 1
    assert "2026-10-09" not in marks


def test_delete(store):
    r = add(store)
    store.delete(r["id"])
    assert store.reminders == []


# ---------- Статистика ----------
def test_stats_week(store):
    early = datetime(2026, 10, 5, 8, 0)  # понедельник
    r = add(store, t="09:00", d="2026-10-05", repeat="daily", now=early, category="health")
    store.toggle_done(r["id"], "2026-10-05")
    store.toggle_done(r["id"], "2026-10-06")
    s = store.stats("week", NOW)
    # пн, вт — выполнено; ср, чт (09:00 < 12:00) — пропущено; пт–вс — осталось
    assert (s["done"], s["missed"], s["left"], s["total"]) == (2, 2, 3, 7)
    assert s["percent"] == 29
    assert s["categories"] == [{"key": "health", "percent": 29, "total": 7}]


def test_stats_empty(store):
    assert store.stats("month", NOW)["percent"] == 0


def test_settings(store):
    store.update_settings({"name": "Дима", "theme": "light", "hack": 1})
    again = Store(store.path)
    assert again.settings["theme"] == "light"
    assert "hack" not in again.settings


def test_priority_marks_and_stats(store):
    hot = add(store, title="Срочно", t="09:00", repeat="weekly", important=True)
    add(store, title="Обычное", d="2026-10-09")
    days = store.month_hot(2026, 10)
    assert "2026-10-08" in days and "2026-10-15" in days
    assert "2026-10-09" not in days                      # обычная задача огонёк не даёт
    store.toggle_done(hot["id"], "2026-10-08")
    assert "2026-10-08" not in store.month_hot(2026, 10)  # выполненный приоритет гаснет
    # приоритет не влияет на статистику: в категориях его нет
    assert all(c["key"] != "important" for c in store.stats("week", NOW)["categories"])


# ---------- Каждый месяц / каждый год ----------
def test_monthly_31st_falls_back_to_last_day():
    r = {"start": "2026-01-31 10:00", "repeat": "monthly"}
    assert occurs_on(r, date(2026, 2, 28))       # в феврале 28 дней
    assert occurs_on(r, date(2026, 4, 30))       # в апреле 30
    assert not occurs_on(r, date(2026, 4, 29))
    assert occurs_on(r, date(2026, 5, 31))


def test_yearly_feb_29():
    r = {"start": "2024-02-29 10:00", "repeat": "yearly"}
    assert occurs_on(r, date(2025, 2, 28))       # невисокосный год
    assert occurs_on(r, date(2028, 2, 29))
    assert not occurs_on(r, date(2028, 2, 28))


# ---------- Дни рождения ----------
def add_bday(store, **kw):
    data = {"kind": "birthday", "title": "Ксюша", "date": "2026-11-14", "time": "10:00",
            "birth_year": 2000, "remind": [0, 7]}
    data.update(kw)
    return store.upsert(data, NOW)


def test_birthday_every_year_with_age(store):
    add_bday(store)
    items = store.items_between(date(2027, 11, 14), date(2027, 11, 14), NOW)
    assert items[0]["kind"] == "birthday" and items[0]["age"] == 27
    assert store.items_between(date(2026, 11, 14), date(2026, 11, 14), NOW)[0]["age"] == 26


def test_birthday_without_year_has_no_age(store):
    add_bday(store, birth_year="")
    assert store.items_between(date(2026, 11, 14), date(2026, 11, 14), NOW)[0]["age"] is None


@pytest.mark.parametrize("by, message", [(1800, "от 1900"), ("abc", "четыре цифры"), (2030, "от 1900")])
def test_birthday_year_validation(store, by, message):
    with pytest.raises(ValidationError, match=message):
        add_bday(store, birth_year=by)


def test_birthday_reminders_week_before_and_on_day(store):
    add_bday(store)  # напоминать за неделю и в сам день, в 10:00
    assert store.due(datetime(2026, 11, 7, 9, 59)) == []
    ev = store.due(datetime(2026, 11, 7, 10, 0))
    assert len(ev) == 1 and ev[0]["_offset"] == 7 and ev[0]["_bday"] == "2026-11-14"
    assert store.due(datetime(2026, 11, 13, 10, 0)) == []       # «за день» не выбран
    ev = store.due(datetime(2026, 11, 14, 10, 0))
    assert ev[0]["_offset"] == 0
    assert store.due(datetime(2026, 11, 14, 10, 5)) == []


def test_birthday_week_before_crosses_new_year(store):
    add_bday(store, date="2027-01-03")
    ev = store.due(datetime(2026, 12, 27, 10, 0))
    assert ev and ev[0]["_bday"] == "2027-01-03" and ev[0]["_offset"] == 7


def test_birthday_not_in_stats_and_cannot_be_done(store):
    r = add_bday(store, date="2026-10-08")
    assert store.toggle_done(r["id"], "2026-10-08") is False
    assert store.stats("week", NOW)["total"] == 0
    assert store.month_marks(2026, 10) == {}
    assert store.month_info(2026, 10)["bdays"]["2026-10-08"] == ["Ксюша"]


# ---------- Отпуск ----------
def add_vac(store, **kw):
    data = {"kind": "vacation", "title": "", "date": "2026-10-10", "date_end": "2026-10-20", "mute_work": True}
    data.update(kw)
    return store.upsert(data, NOW)


def test_vacation_range_and_default_title(store):
    v = add_vac(store)
    assert v["title"] == "Отпуск"
    assert occurs_on(v, date(2026, 10, 10)) and occurs_on(v, date(2026, 10, 20))
    assert not occurs_on(v, date(2026, 10, 21))
    info = store.month_info(2026, 10)["vac"]
    assert info["2026-10-10"]["start"] and info["2026-10-20"]["end"] and "2026-10-21" not in info
    assert store.items_between(date(2026, 10, 10), date(2026, 10, 20), NOW) == []  # отпуск — не напоминание


def test_vacation_validation(store):
    with pytest.raises(ValidationError, match="раньше"):
        add_vac(store, date_end="2026-10-01")


def test_vacation_mutes_work_reminders(store):
    add_vac(store)
    work = add(store, title="Отчёт", d="2026-10-12", t="10:00", category="work")
    home = add(store, title="Купить хлеб", d="2026-10-12", t="10:00", category="home")
    assert store.due(datetime(2026, 10, 12, 10, 0)) == [home]
    assert store.due(datetime(2026, 10, 12, 10, 5)) == []      # рабочее не «догоняет» позже
    items = {i["title"]: i for i in store.items_between(date(2026, 10, 12), date(2026, 10, 12), NOW)}
    assert items["Отчёт"].get("muted") is True and "muted" not in items["Купить хлеб"]
    assert work["category"] == "work"


def test_vacation_without_mute_keeps_work(store):
    add_vac(store, mute_work=False)
    work = add(store, title="Отчёт", d="2026-10-12", t="10:00", category="work")
    assert store.due(datetime(2026, 10, 12, 10, 0)) == [work]


def test_kind_cannot_change(store):
    r = add(store)
    with pytest.raises(ValidationError, match="Тип записи"):
        store.upsert({"id": r["id"], "kind": "vacation", "date": "2026-10-10", "date_end": "2026-10-11"}, NOW)


# ---------- Обзор года для панели месяцев ----------
def test_year_overview(store):
    add_bday(store)                                           # ноябрь
    add_bday(store, title="Мама", date="2026-11-30")          # ноябрь
    add_vac(store, date="2026-12-28", date_end="2027-01-05")  # декабрь и январь следующего года
    add(store, title="Срочно", d="2026-10-20", important=True)
    y = store.year_overview(2026)
    assert y[10]["bdays"] == 2 and y[11]["vacation"] and not y[0]["vacation"]
    assert y[9]["hot"] == 1 and y[10]["hot"] == 0
    assert store.year_overview(2027)[0]["vacation"]

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
    ({"repeat": "yearly"}, "повтора"),
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

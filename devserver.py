"""Режим разработки: открывает интерфейс в обычном браузере, без pywebview.

    python devserver.py            -> http://127.0.0.1:8765/index.html?dev

Удобно для отладки вёрстки через DevTools и для UI-автотестов.
Вызовы API идут через POST /api/<метод> с JSON-массивом аргументов.
"""
import json
import os
import sys
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from api import Api, lock, store
from core import popup_info

UI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui")


class DevApi(Api):
    def popup_info(self, rid, offset=0):
        r = store.find(rid)
        if not r:
            return None
        today = datetime.now().date()
        if r.get("kind") == "birthday":
            from core import next_birthday
            day = next_birthday(r, today).strftime("%Y-%m-%d")
        else:
            day = today.strftime("%Y-%m-%d")
        return popup_info(r, day, int(offset), store.settings, today)

    def popup_action(self, rid, name):
        print(f"[popup] {name} -> {rid}")
        return True

    def quit(self):
        return True


api = DevApi()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=UI_DIR, **kw)

    def log_message(self, *args):
        pass

    def do_POST(self):
        name = self.path.removeprefix("/api/")
        method = getattr(api, name, None)
        if not method or name.startswith("_"):
            self.send_error(404)
            return
        args = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or "[]")
        with lock:
            result = method(*args)
        body = json.dumps(result, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"Открой http://127.0.0.1:{port}/index.html?dev")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()

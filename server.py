#!/usr/bin/env python3
from __future__ import annotations

import posixpath
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        path = path.split("?", 1)[0].split("#", 1)[0]
        path = posixpath.normpath(path)
        parts = [p for p in path.split("/") if p]
        local = ROOT
        for part in parts:
            local = local / part
        return str(local)

    def do_GET(self):  # noqa: N802
        request_path = self.path.split("?", 1)[0]

        if request_path.startswith("/api/"):
            self.send_error(404, "Not Found")
            return

        requested = Path(self.translate_path(request_path))
        if requested.exists():
            super().do_GET()
            return

        self.path = "/index.html"
        super().do_GET()


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 8000), Handler)
    print("Serving on http://0.0.0.0:8000")
    server.serve_forever()

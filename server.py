#!/usr/bin/env python3
from __future__ import annotations

import cgi
import io
import json
import posixpath
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent


def col_to_index(cell_ref: str) -> int:
    letters = ""
    for ch in cell_ref:
        if ch.isalpha():
            letters += ch
        else:
            break
    value = 0
    for ch in letters.upper():
        value = value * 26 + (ord(ch) - 64)
    return max(0, value - 1)


def parse_shared_strings(zf: ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    ns = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    result: list[str] = []
    for si in root.findall("a:si", ns):
        text = "".join(t.text or "" for t in si.findall('.//a:t', ns))
        result.append(text)
    return result


def first_worksheet_path(zf: ZipFile) -> str:
    candidates = sorted([name for name in zf.namelist() if name.startswith("xl/worksheets/sheet") and name.endswith('.xml')])
    if not candidates:
        raise ValueError("XLSX 檔案沒有可用工作表")
    return candidates[0]


def parse_xlsx(file_bytes: bytes) -> dict:
    with ZipFile(io.BytesIO(file_bytes)) as zf:
        sheet_path = first_worksheet_path(zf)
        shared_strings = parse_shared_strings(zf)
        root = ET.fromstring(zf.read(sheet_path))

    ns = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    rows_data: list[dict[int, str]] = []

    for row in root.findall('.//a:sheetData/a:row', ns):
        row_map: dict[int, str] = {}
        for cell in row.findall('a:c', ns):
            ref = cell.get('r', '')
            idx = col_to_index(ref)
            cell_type = cell.get('t')
            value = ""

            if cell_type == 's':
                v = cell.find('a:v', ns)
                if v is not None and v.text and v.text.isdigit():
                    sidx = int(v.text)
                    value = shared_strings[sidx] if sidx < len(shared_strings) else ""
            elif cell_type == 'inlineStr':
                t = cell.find('a:is/a:t', ns)
                value = t.text if t is not None and t.text else ""
            else:
                v = cell.find('a:v', ns)
                value = v.text if v is not None and v.text else ""

            row_map[idx] = value.strip()

        if row_map:
            rows_data.append(row_map)

    if not rows_data:
        raise ValueError("XLSX 工作表內容為空")

    header_map = rows_data[0]
    max_col = max(header_map.keys())
    headers = [header_map.get(i, "").strip() for i in range(max_col + 1)]
    headers = [h for h in headers if h]

    if len(headers) < 2:
        raise ValueError("XLSX 至少需要兩個欄位")

    # original header positions for mapping
    header_positions = [i for i in range(max_col + 1) if header_map.get(i, "").strip()]

    result_rows = []
    for row_map in rows_data[1:]:
        row_obj = {}
        for pos, header in zip(header_positions, headers):
            row_obj[header] = row_map.get(pos, "")
        if any(str(v).strip() for v in row_obj.values()):
            result_rows.append(row_obj)

    return {"headers": headers, "rows": result_rows}


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        path = path.split('?', 1)[0].split('#', 1)[0]
        path = posixpath.normpath(path)
        parts = [p for p in path.split('/') if p]
        local = ROOT
        for part in parts:
            local = local / part
        return str(local)


    def do_GET(self):  # noqa: N802
        if self.path.startswith("/api/"):
            self.send_error(404, "Not Found")
            return

        requested = Path(self.translate_path(self.path))
        if requested.exists():
            super().do_GET()
            return

        # Preview tools may inject extra path prefixes.
        # Fallback to index.html for unknown non-API routes.
        self.path = "/index.html"
        super().do_GET()

    def do_POST(self):  # noqa: N802
        request_path = self.path.split("?", 1)[0]
        if not request_path.endswith("/api/parse-xlsx"):
            self.send_error(404, "Not Found")
            return

        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": self.headers.get("Content-Type", "")},
        )
        file_item = form["file"] if "file" in form else None

        if file_item is None or not getattr(file_item, "file", None):
            self._send_json(400, {"error": "缺少檔案"})
            return

        try:
            parsed = parse_xlsx(file_item.file.read())
            self._send_json(200, parsed)
        except Exception as exc:  # noqa: BLE001
            self._send_json(400, {"error": str(exc)})

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 8000), Handler)
    print("Serving on http://0.0.0.0:8000")
    server.serve_forever()

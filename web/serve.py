#!/usr/bin/env python3
"""
Self-contained web server for the EFL Electricity Plan Comparator.

This folder is an ADD-ON to the parent `efl_compare.py` project. It does not
modify or depend on being imported by the parent script. It simply reads the
JSON the parent already produces (`plans_latest.json`, written by
`efl_compare.py --json`) and serves it as an interactive web page plus a small
JSON API.

Zero third-party dependencies — Python standard library only.

Usage
-----
    # from anywhere; defaults to serving the parent repo's plans_latest.json
    python3 web/serve.py

    # explicit data file and port
    python3 web/serve.py --json-path ../plans_latest.json --port 8000

Data resolution order (first hit wins):
    1. --json-path CLI argument
    2. EFL_JSON environment variable
    3. <parent repo>/plans_latest.json   (../ relative to this folder)

If none of those exist, the pages render a friendly "run the CLI first" state
rather than failing.

The data file is re-read from disk on every /api/plans request, so re-running
`efl_compare.py --json` refreshes the site with no server restart.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
STATIC_DIR = HERE / "static"
PARENT_JSON = HERE.parent / "plans_latest.json"
# The parent CLI's own full comparison table, generated in the repo root. Served
# read-only so it's reachable through this server / the tunnel, not just as a
# loose file. The wizard is not in this list: it lives here (static/wizard.html)
# and renders from /api/plans, so the parent CLI needs no knowledge of it.
FULL_HTML = HERE.parent / "plans_latest.html"      # efl_compare.py (default HTML)

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".map": "application/json; charset=utf-8",
}


class Config:
    """Runtime configuration, resolved once at startup."""

    def __init__(self, json_path: Path | None):
        self.explicit_json_path = json_path

    def resolve_data_path(self) -> Path | None:
        """Return the path we should try to read, or None if nothing configured."""
        if self.explicit_json_path is not None:
            return self.explicit_json_path
        env = os.environ.get("EFL_JSON")
        if env:
            return Path(env).expanduser()
        if PARENT_JSON.exists():
            return PARENT_JSON
        return None


CONFIG: Config  # set in main()


def _load_data() -> dict:
    """Read and return the plan JSON plus a _source metadata block.

    Never raises to the request handler; returns a structured error payload so
    the front-end can render a helpful "no data yet" state.
    """
    path = CONFIG.resolve_data_path()
    if path is None:
        return {
            "_source": {
                "ok": False,
                "reason": "no_data_file",
                "message": (
                    "No plans_latest.json found. Run the parent CLI first, e.g.\n"
                    "    python3 efl_compare.py --zip YOUR_ZIP --json plans_latest.json\n"
                    "then reload this page (no server restart needed)."
                ),
                "looked_at": [str(PARENT_JSON)],
            },
            "plans": [],
        }

    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {
            "_source": {
                "ok": False,
                "reason": "file_missing",
                "message": f"Configured data file does not exist: {path}",
                "path": str(path),
            },
            "plans": [],
        }
    except OSError as exc:
        return {
            "_source": {
                "ok": False,
                "reason": "read_error",
                "message": f"Could not read {path}: {exc}",
                "path": str(path),
            },
            "plans": [],
        }

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        return {
            "_source": {
                "ok": False,
                "reason": "invalid_json",
                "message": f"{path} is not valid JSON: {exc}",
                "path": str(path),
            },
            "plans": [],
        }

    try:
        mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        mtime_iso = mtime.isoformat(timespec="seconds")
    except OSError:
        mtime_iso = None

    data["_source"] = {
        "ok": True,
        "path": str(path),
        "file_mtime": mtime_iso,
        "plan_count": len(data.get("plans", [])),
    }
    return data


class Handler(BaseHTTPRequestHandler):
    server_version = "EFLCompareWeb/1.0"

    # ---- helpers ---------------------------------------------------------
    def _send(self, status: int, body: bytes, content_type: str,
              extra_headers: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # This tool serves purely local, read-only data — no caching so a
        # re-run of the CLI shows up on the next reload.
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, status: int, obj) -> None:
        body = json.dumps(obj).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _serve_static(self, rel_path: str) -> None:
        # Normalise and confine to STATIC_DIR (no path traversal).
        rel_path = rel_path.lstrip("/")
        if rel_path == "":
            rel_path = "index.html"
        target = (STATIC_DIR / rel_path).resolve()
        if not str(target).startswith(str(STATIC_DIR)) or not target.is_file():
            self._send(404, b"Not found", "text/plain; charset=utf-8")
            return
        ctype = _CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)

    def _serve_parent_html(self, target: Path, label: str, gen_cmd: str) -> None:
        """Serve a self-contained HTML file the parent CLI writes to the repo
        root. If it hasn't been generated yet, return a friendly 404 telling the
        user how to create it rather than a bare error."""
        if target.is_file():
            self._send(200, target.read_bytes(), "text/html; charset=utf-8")
            return
        msg = (
            f"<!doctype html><meta charset='utf-8'>"
            f"<title>Not generated yet</title>"
            f"<body style='font:16px system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem'>"
            f"<h1>The {label} hasn't been generated yet</h1>"
            f"<p>It's produced by the parent CLI. From the repo root, run:</p>"
            f"<pre style='background:#f4f4f4;padding:1rem;border-radius:8px'>"
            f"python3 {gen_cmd} --zip YOUR_ZIP</pre>"
            f"<p>Then reload this page. <a href='/'>Back to the dashboard</a></p>"
            f"</body>"
        ).encode("utf-8")
        self._send(404, msg, "text/html; charset=utf-8")

    # ---- routing ---------------------------------------------------------
    def do_GET(self) -> None:
        path = urlparse(self.path).path

        if path == "/api/health":
            data = _load_data()
            self._send_json(200, {
                "status": "ok",
                "data_available": data["_source"].get("ok", False),
                "source": data["_source"],
            })
            return

        if path == "/api/plans":
            self._send_json(200, _load_data())
            return

        if path == "/" or path == "/index.html":
            self._serve_static("index.html")
            return

        # The wizard is served from here and renders client-side from
        # /api/plans -- no CLI flag, no generated file.
        if path in ("/wizard", "/wizard.html"):
            self._serve_static("wizard.html")
            return

        # The parent CLI's own full table (served from the repo root).
        if path in ("/full", "/table", "/plans_latest.html"):
            self._serve_parent_html(FULL_HTML, "full comparison table",
                                    "efl_compare.py")
            return

        if path.startswith("/static/"):
            self._serve_static(path[len("/static/"):])
            return

        # Allow bare asset names too (e.g. /app.js) for convenience.
        self._serve_static(path)

    def do_HEAD(self) -> None:
        self.do_GET()

    # Quieter, single-line logging.
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("  %s - %s\n" % (self.address_string(), fmt % args))


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Serve the EFL plan comparison as an interactive web page.")
    p.add_argument("--host", default="127.0.0.1",
                   help="Interface to bind (default: 127.0.0.1). Use 0.0.0.0 to expose on LAN.")
    p.add_argument("--port", type=int, default=8090,
                   help="Port to listen on (default: 8090; 8000/8080/4000 are used by "
                        "other containers on this host).")
    p.add_argument("--json-path", default=None,
                   help="Path to the plans JSON produced by efl_compare.py --json. "
                        "Overrides EFL_JSON and the default ../plans_latest.json.")
    return p.parse_args(argv)


def main(argv=None) -> int:
    global CONFIG
    args = parse_args(argv)
    json_path = Path(args.json_path).expanduser().resolve() if args.json_path else None
    CONFIG = Config(json_path=json_path)

    resolved = CONFIG.resolve_data_path()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)

    url = f"http://{args.host}:{args.port}/"
    print("EFL Compare — web server")
    print(f"  Serving:  {url}")
    if resolved is None:
        print("  Data:     (none found yet — the page will show setup instructions)")
        print(f"            Expected: {PARENT_JSON}")
    else:
        print(f"  Data:     {resolved}")
    print("  Stop:     Ctrl-C")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

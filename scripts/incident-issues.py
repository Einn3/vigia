#!/usr/bin/env python3
"""Sincroniza los incidentes de vigia con GitHub Issues.

- Incidente abierto (ended_at null) y sin Issue -> crea uno: [incident #<id>] <monitor> is down
- Incidente resuelto (ended_at set) con Issue abierto -> lo cierra con un comentario.
- Si la API de vigia no responde, no hace nada (el smoke test ya alerta de eso).
Usa GH_TOKEN (el token del workflow) para la API de GitHub.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

TOKEN = os.environ.get("GH_TOKEN", "")
REPO = "Einn3/vigia"
API = "https://api.github.com"
VIGIA = "https://vigia.20301063.workers.dev"


def gh(method, path, body=None):
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    data = json.dumps(body).encode() if body is not None else None
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        print(f"GitHub {method} {path} -> {e.code}: {e.read().decode()[:200]}")
        return None


def fmt(ts_ms):
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def main():
    if not TOKEN:
        print("GH_TOKEN no está definido")
        return 1
    try:
        with urllib.request.urlopen(VIGIA + "/api/incidents") as r:
            incidents = json.load(r)["incidents"]
    except Exception as e:
        print(f"No se pudo leer /api/incidents ({e}); no se hace nada")
        return 0

    open_issues = gh("GET", f"/repos/{REPO}/issues?state=open&per_page=100") or []
    by_incident = {}
    for iss in open_issues:
        if "pull_request" in iss:
            continue
        t = iss["title"]
        if t.startswith("[incident #"):
            num = t.split("#", 1)[1].split("]", 1)[0]
            by_incident[num] = iss["number"]

    for inc in incidents:
        iid = str(inc["id"])
        monitor = inc["monitor_id"]
        cause = inc.get("cause") or "unknown"
        if inc.get("ended_at") is None:
            if iid not in by_incident:
                body = (
                    f"Monitor: {monitor}\n"
                    f"Cause: {cause}\n"
                    f"Started: {fmt(inc[started_at])}\n"
                    f"Status: {VIGIA}\n"
                    f"Mirror: https://einn3.github.io/vigia/"
                )
                created = gh(
                    "POST",
                    f"/repos/{REPO}/issues",
                    {"title": f"[incident #{iid}] {monitor} is down", "body": body},
                )
                if created:
                    print(f"created issue #{created[number]} for incident {iid}")
        else:
            if iid in by_incident:
                num = by_incident[iid]
                gh(
                    "POST",
                    f"/repos/{REPO}/issues/{num}/comments",
                    {"body": f"Resolved at {fmt(inc[ended_at])}."},
                )
                gh("PATCH", f"/repos/{REPO}/issues/{num}", {"state": "closed"})
                print(f"closed issue #{num} for incident {iid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

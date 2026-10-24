"""Serve viewer.html, which shows every run in outputs/. Reads the run files on each request and never writes
anything, so a run in progress shows up on reload. Ported from model-spec-evals/dictatoreval-extend/viewer.py."""
import argparse
import json
import re
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
RUNS = HERE / "outputs"
SUFFIX = "-results.jsonl"
RUNNING = 120  # Seconds since a run's file last changed for it to count as still running (and auto-refresh).
PAGES = {"/": "viewer/viewer.html", "/viewer.js": "viewer/viewer.js"}
INDEX_FIELDS = ("env", "variant", "model", "sample", "judge", "system_prompt", "classifier_refusal")
cache = {}  # results file path -> (modification time, size, records)


def runs():
    """Newest first, so the newest run is the default."""
    if not RUNS.is_dir():
        return []
    return sorted((p.name[:-len(SUFFIX)] for p in RUNS.glob(f"*{SUFFIX}")), reverse=True)


def scenario_id(record):
    """A record's scenario: "<env>", or "<env>/<variant>" for a variant other than main (as in exp_evals.py)."""
    variant = record.get("variant") or "main"
    return record["env"] if variant == "main" else f"{record['env']}/{variant}"


def own_calls(record):
    """The calls a run paid for: a re-judged copy (exp_rejudge.py) paid only for its judge calls."""
    calls = record.get("calls", {})
    return calls.get("judge", []) if record.get("rejudged_from") else [c for role in calls.values() for c in role]


def calls_cost(record):
    """Dollars for every reported cost of the calls this run paid for (see unreported)."""
    return sum(c.get("cost") or 0 for c in own_calls(record))


def role_cost(record, role):
    """Dollars for every reported cost of one role's calls ("model" or "judge")."""
    return sum(c.get("cost") or 0 for c in record.get("calls", {}).get(role, []))


def unreported(record):
    """How many of the calls this run paid for, or failed tries within them, had no reported cost."""
    calls = own_calls(record)
    return sum((c.get("cost") is None) + sum(a.get("cost") is None for a in c.get("failed_attempts", []))
               for c in calls)


def records(run):
    """A run's records, reread only when its file changes, each with `run` and `calls_cost` added. A half-written
    last line is skipped."""
    if run not in runs():
        raise KeyError(run)
    path = RUNS / f"{run}{SUFFIX}"
    stat = path.stat()
    if cache.get(path, (None, None))[:2] != (stat.st_mtime, stat.st_size):
        rows = []
        for line in path.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        cache[path] = (stat.st_mtime, stat.st_size, [row | {"run": run, "calls_cost": calls_cost(row),
                                                            "model_cost": role_cost(row, "model"),
                                                            "judge_cost": role_cost(row, "judge"),
                                                            "auditor_cost": role_cost(row, "auditor"),
                                                            "unreported": unreported(row)} for row in rows])
    return cache[path][2]


def settings(rows):
    """Which models each judge judged, and which ran with each system prompt, as [[value, [models]]]."""
    def grouped(field):
        groups = {}
        for row in rows:
            models = groups.setdefault(row[field], [])
            if row["model"] not in models:
                models.append(row["model"])
        return [[value, models] for value, models in groups.items()]
    for row in rows:  # Runs before 2026-10-21 ~17:30 didn't set a judge temperature: the provider's default.
        row.setdefault("judge_temperature", None)
    out = {"judges": grouped("judge"), "judge_temperatures": grouped("judge_temperature"),
           "system_prompts": grouped("system_prompt")}
    if any("escalations" in row for row in rows):
        out["auditors"] = grouped("auditor")
    return out


def run_info(run):
    rows = records(run)
    models = list(dict.fromkeys(r["model"] for r in rows))
    running = time.time() - (RUNS / f"{run}{SUFFIX}").stat().st_mtime < RUNNING
    return {"run": run, "config": {"models": ",".join(models), "n": max((r["sample"] for r in rows), default=-1) + 1},
            "records": len(rows), "summary": None if running else {"cost": sum(r["calls_cost"] for r in rows)},
            "settings": settings(rows), "escalating": any("escalations" in r for r in rows),
            "system_prompt_texts": {r["system_prompt"]: r.get("system_prompt_text") for r in rows}, "rejudged_from": next((r.get("rejudged_from") for r in rows), None),
            "definitions": definitions(next((r["judge_prompt_text"] for r in rows if r.get("judge_prompt_text")), ""))}


def definitions(text):
    """Categories (in the judge prompt's order) and tags, read from the judge prompt a run saved. A category is a
    bullet named in the reply format's "category" list; every other bullet is a tag."""
    bullets = re.findall(r"^- `(\w+)`: (.+)$", text, re.M)
    listed = re.search(r'"category": "<([^>]+)>"', text)
    names = [c.strip() for c in listed.group(1).split("|")] if listed else []
    return {"categories": [[k, v] for k, v in bullets if k in names], "tags": [[k, v] for k, v in bullets if k not in names]}


def any_turn_tags(judgments):
    """For an escalating conversation, each true/false judge tag: whether it was true on any turn."""
    names = [k for k, v in (judgments[0] if judgments else {}).items() if isinstance(v, bool)]
    return {k: any(j.get(k) for j in judgments) for k in names} or None


def outcome(record):
    """Light fields for tables, plus which model replies a provider blocked, as (step, output tokens)."""
    row = {k: record[k] for k in (*INDEX_FIELDS, "run", "calls_cost", "model_cost", "judge_cost", "auditor_cost", "unreported") if k in record}
    judgment = record.get("judgment") or {}
    row["category"] = judgment.get("category")
    if "escalations" in record:  # exp_evals.py --escalate: how many turns the model went along with, and why it stopped.
        row |= {"complied": record.get("complied", 0), "stop": record.get("stop"),
                "steps": [s["title"] for s in record["escalations"]],
                "tags_any": any_turn_tags(record.get("judgments") or [])}
    row["tags"] = {k: v for k, v in judgment.items() if isinstance(v, bool)} or None
    row["error"] = record.get("error")
    calls = record.get("calls", {}).get("model", [])
    row["refusals"] = [(c.get("step"), (c.get("usage") or {}).get("output_tokens",
                                                                (c.get("usage") or {}).get("completion_tokens")))
                       for c in calls
                       if c.get("stop_reason") in ("refusal", "content_filter")]
    return row


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        wanted = [r for r in query.get("runs", "").split(",") if r]
        try:
            if url.path in PAGES:
                return self.send(200, (HERE / PAGES[url.path]).read_bytes(),
                                 "text/html" if url.path == "/" else "text/javascript")
            if url.path == "/api/runs":
                return self.json([run_info(r) for r in runs()])
            if url.path == "/api/index":
                return self.json([outcome(r) for run in wanted for r in records(run)])
            if url.path == "/api/scenario":
                return self.json([r for run in wanted for r in records(run) if scenario_id(r) == query["id"]])
        except KeyError as e:
            return self.send(404, f"Unknown: {e}".encode(), "text/plain")
        self.send(404, b"Not found", "text/plain")

    def json(self, value):
        self.send(200, json.dumps(value).encode(), "application/json")

    def send(self, status, body, kind):
        self.send_response(status)
        self.send_header("Content-Type", f"{kind}; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8768)
    args = parser.parse_args()
    print(f"Run viewer: http://localhost:{args.port}", flush=True)
    server = ThreadingHTTPServer(("localhost", args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

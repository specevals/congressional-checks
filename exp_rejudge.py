"""Judge an earlier run's conversations again with the current inputs/judging/JUDGE.md, saving a full copy of that run
with the new judgments as a new run. Costs money (judge calls only; no model is asked anything).

A copied record keeps its conversation and model calls, gets fresh judge settings, judge calls and judgment, and
`rejudged_from` names the run whose conversations it holds. Its `cost` is only the new judge calls, so a re-judge run's
total is what the re-judge spent. Conversations that a provider blocked or that never finished are copied unjudged.
"""
import argparse
import asyncio
import json
import sys
from datetime import datetime

from dotenv import load_dotenv
from llm import LLM, MODELS

import exp_evals
from exp_evals import OUTPUTS, judge, judge_fields, spent

SUFFIX = "-results.jsonl"


def judgeable(record):
    """True when the conversation ended with a complete reply that no provider blocked."""
    last = record["messages"][-1] if record["messages"] else {}
    return not record["classifier_refusal"] and last.get("role") == "assistant" and not last.get("partial") \
        and not (record["calls"]["model"] and exp_evals.cut_off(record))


def copy(record, args, judge_text, source):
    """The record with its judging cleared. One that can't be judged keeps its error (a failed conversation's)."""
    drop = ("judgment", "cost", "unreported_costs") + (("error",) if judgeable(record) else ())
    record = {k: v for k, v in record.items() if k not in drop}
    return record | {"judge": args.judge, "judge_model_id": MODELS[args.judge]["id"],
                     "judge_temperature": args.judge_temperature, "judge_prompt_text": judge_text, "judgment": None,
                     "calls": {"model": record["calls"]["model"], "judge": []}, "rejudged_from": source}


async def rejudge(llm, record):
    try:
        if judgeable(record):
            record["judgment"] = await judge(llm, record)
    except Exception as e:
        record["error"] = f"{type(e).__name__}: {e}"
    except asyncio.CancelledError:
        record["error"] = "Stopped before finishing (Ctrl-C)"
        raise
    finally:
        calls = record["calls"]["judge"]
        record["cost"] = sum(c["cost"] or 0 for c in calls)
        record["unreported_costs"] = sum((c.get("cost") is None) + sum(a["cost"] is None for a in
                                                                       c.get("failed_attempts", [])) for c in calls)
    return record


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, help="the run to re-judge, e.g. 2026-10-21_17-38-03")
    parser.add_argument("--judge", default="gpt-5.4")
    parser.add_argument("--judge-temperature", default="0", type=lambda v: None if v == "default" else float(v))
    parser.add_argument("--dry-run", action="store_true", help="check inputs and the judge, then stop before any paid call")
    return parser.parse_args(argv)


def plan(args):
    path = OUTPUTS / f"{args.run}{SUFFIX}"
    if not path.is_file():
        sys.exit(f"No run {args.run!r} in {OUTPUTS}")
    if args.judge not in MODELS:
        sys.exit(f"Unknown judge {args.judge}")
    if args.judge_temperature is not None and not MODELS[args.judge].get("temperature", True):
        sys.exit(f"{args.judge} doesn't take a temperature; use --judge-temperature=default")
    judge_text = exp_evals.check_judge_prompt()
    old = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if any("escalations" in r for r in old):
        sys.exit("Re-judging escalating runs isn't supported: each turn's verdict decided whether the conversation went on")
    source = old[0].get("rejudged_from") or args.run  # The run the conversations came from.
    return [copy(r, args, judge_text, source) for r in old]


async def run(args, llm=None):
    """Returns the number of records that errored while judging. `llm` replaces the real client (for offline tests)."""
    records = plan(args)
    todo = [r for r in records if judgeable(r)]
    print(f"Re-judging {len(todo)} of {len(records)} conversations from {args.run}; judge {args.judge} (temperature "
          f"{'default' if args.judge_temperature is None else f'{args.judge_temperature:g}'})", flush=True)
    load_dotenv()
    async with (llm or LLM()) as llm:
        try:
            await llm.check([args.judge])  # Free.
        except ValueError as e:
            sys.exit(str(e))
        if args.dry_run:
            return 0
        out = OUTPUTS / f"{datetime.now():%Y-%m-%d_%H-%M-%S}{SUFFIX}"
        for record in records:
            record["run"] = out.name
        print(f"Saving to {out}", flush=True)
        finished, errors = [], []
        with open(out, "w") as f:
            for record in records:  # Copies that won't be judged go in first.
                if not judgeable(record):
                    f.write(json.dumps(await rejudge(llm, record)) + "\n")
            f.flush()

            async def one(record):
                try:
                    await rejudge(llm, record)
                finally:
                    f.write(json.dumps(record) + "\n")
                    f.flush()
                finished.append(record)
                if "error" in record:
                    errors.append(record)
                print(f"[{len(finished)}/{len(todo)}] {record['model']} {exp_evals.scenario_id(record)} #{record['sample']}: "
                      f"{exp_evals.label(record)} | {spent(llm, finished)} spent", flush=True)
            await asyncio.gather(*(one(r) for r in todo))
        print(f"Done: {spent(llm, finished)} spent. Saved to {out}")
        for record in errors:
            print(f"ERROR: {record['model']} {exp_evals.scenario_id(record)} #{record['sample']}: {record['error']}")
        for record in filter(exp_evals.judged_error, finished):
            print(f"WARNING: the judge called a reply an error: {record['model']} {exp_evals.scenario_id(record)} "
                  f"#{record['sample']}: {record['judgment']['reasoning']}")
    return len(errors)


def main():
    try:
        raise SystemExit(1 if asyncio.run(run(parse_args())) else 0)
    except KeyboardInterrupt:
        print("Stopped. Finished judgments, and the conversations not yet judged, are saved.")
        raise SystemExit(130)


if __name__ == "__main__":
    main()

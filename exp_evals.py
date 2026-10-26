"""Run the scenarios in inputs/scenarios/<env>/<variant>.md on models and judge each conversation with inputs/judging/JUDGE.md.

With --escalate, each conversation goes on past the scenario: after every reply is judged, an auditor model writes the
official's next message from the next step in the scenario's escalations.md (using inputs/audit-instructions.md),
until the model stops complying or the steps run out.

Costs money. Every API call's usage, dollar cost, host and settings are saved with its conversation, and each
assistant message keeps the provider's native content (thinking signatures, encrypted reasoning), so any
conversation can be resumed from the saved file.
"""
import argparse
import asyncio
import json
import re
import sys
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

import openai
from dotenv import load_dotenv
from llm import LLM, MODELS

HERE = Path(__file__).resolve().parent
INPUTS = HERE / "inputs"
OUTPUTS = HERE / "outputs"

# The longest a model's reply may be, reasoning included (one limit covers both). Replies in the first envs topped out
# near 4K tokens, while GLM's degenerate ones ran past 100K (55 minutes). Raise it for envs that need longer work.
MAX_TOKENS = 16_000
JUDGE_TRIES = 3  # The judge isn't forced into JSON, so a malformed verdict is asked for again.
# Provider blocks. Anthropic returns a normal reply with stop_reason "refusal" (sometimes after partial text);
# OpenAI and abliteration.ai reject the request (or cut off the reply) with one of these error codes; other hosts may
# stop with "content_filter".
BLOCK_CODES = ("cyber_policy", "invalid_prompt", "policy_violation")
HOSTS = {"openai": "OpenAI", "abliteration": "abliteration.ai"}  # Who sent a block error, named as llm names hosts.
BLOCK_STOPS = ("refusal", "content_filter")
REFUSAL_CATEGORIES = ("harmless_version", "full_refusal")  # Judge categories that end an escalating conversation.
# A reply cut off at MAX_TOKENS (often mid-reasoning, with no reply text) isn't judged: it gets this in place of a
# verdict, which counts as unclassified.
CUT_OFF = {"reasoning": "Not judged: the reply hit the token limit.", "category": None}


def load_inputs(kind):
    """Every .md file in inputs/<kind>/, by file name without the extension."""
    return {p.stem: p.read_text() for p in sorted((INPUTS / kind).glob("*.md"))}


NOT_PROMPTS = ("escalations",)  # Files in a scenario folder that aren't a version of its prompt.


def load_scenarios():
    """Every scenario variant's text, by (env, variant): inputs/scenarios/<env>/<variant>.md. Each env has a "main".
    A folder's escalations.md (its follow-up requests) is not a variant."""
    return {(p.parent.name, p.stem): p.read_text() for p in sorted((INPUTS / "scenarios").glob("*/*.md"))
            if p.stem not in NOT_PROMPTS}


def pick_scenarios(spec, scenarios):
    """The (env, variant) pairs --envs names: "all" (every env's main), or a comma list of "<env>" (its main),
    "<env>/<variant>", or "<env>/all" (every variant of it). Exits on a name that doesn't exist."""
    envs = list(dict.fromkeys(env for env, _ in scenarios))
    if spec == "all":
        return [(env, "main") for env in envs]
    picked = []
    for item in spec.split(","):
        env, _, variant = item.partition("/")
        variant = variant or "main"
        found = [k for k in scenarios if k[0] == env and variant in ("all", k[1])]
        if not found:
            sys.exit(f"Unknown env {item!r}; choose from " +
                     ", ".join(e if v == "main" else f"{e}/{v}" for e, v in scenarios))
        picked += found
    return list(dict.fromkeys(picked))


def scenario_id(record):
    """How a record's scenario is named in progress lines and the viewer: "<env>", or "<env>/<variant>" for a variant
    other than main (records from before variants have none)."""
    variant = record.get("variant") or "main"
    return record["env"] if variant == "main" else f"{record['env']}/{variant}"


def load_escalations(env):
    """An env's follow-up steps from inputs/scenarios/<env>/escalations.md, in order, as {"title", "request"}: each
    "## <title>" heading and the text under it, except the "Original prompt" heading that stands for the scenario's
    own first message. None if the env has no such file."""
    path = INPUTS / "scenarios" / env / "escalations.md"
    if not path.is_file():
        return None
    parts = re.split(r"^## (.+)$", path.read_text(), flags=re.M)[1:]
    return [{"title": t.strip(), "request": body.strip()} for t, body in zip(parts[::2], parts[1::2])
            if re.sub(r"^\d+\.\s*", "", t.strip()).lower() != "original prompt"]  # Turn 1, the scenario itself.


def user(content):
    return {"role": "user", "content": content}


def judge_settings(record):
    """The judge's sampling settings. OpenAI's GPT-5 models only take a temperature with their reasoning turned off."""
    if record["judge_temperature"] is None:
        return {}
    off = {"reasoning": "none"} if MODELS[record["judge"]]["api"] == "openai" else {}
    return {"temperature": record["judge_temperature"], **off}


async def ask(llm, model, messages, calls, step, **settings):
    """One reply as an assistant message. Its call record (everything but the text and message, which the
    conversation holds) is appended to `calls` right away, so a failed conversation still counts its cost.
    OpenAI's and abliteration.ai's policy rejections become empty replies with stop_reason "refusal". One rejected before the reply began
    (an HTTP error) isn't billed; one that arrives partway through the stream may have been, so its cost is unknown."""
    try:
        reply = await llm.ask(model, messages, **settings)
    except openai.APIError as e:
        if e.code not in BLOCK_CODES:
            raise
        message = e.body.get("message") if isinstance(e.body, dict) else e.message
        calls.append({"step": step, "model": model, "model_id": MODELS[model]["id"], "stop_reason": "refusal",
                      "api_stop_reason": e.code, "api_message": message,
                      "host": HOSTS[MODELS[model]["api"]],
                      "cost": 0.0 if isinstance(e, openai.APIStatusError) else None, "usage": {}})
        return {"role": "assistant", "content": ""}
    calls.append({"step": step} | {k: v for k, v in asdict(reply).items() if k not in ("text", "message")})
    return reply.message


async def take_turn(llm, record, text, turn, **settings):
    """Send one user message and add the model's reply. True if a provider blocked the reply (the conversation then
    stops, marked as a classifier refusal)."""
    messages, calls = record["messages"], record["calls"]["model"]
    messages.append(user(text))
    try:
        reply = await ask(llm, record["model"], messages, calls, f"turn {turn}",
                          max_tokens=min(MAX_TOKENS, MODELS[record["model"]]["max_tokens"]), **settings)
    except BaseException as e:
        if (partial := getattr(e, "partial", None)) is not None:
            # Cut off by Ctrl-C, or by a failure after every retry: the text it had sent so far is kept.
            calls.append({"step": f"turn {turn}", "model": record["model"], "model_id": record["model_id"],
                          "stop_reason": "interrupted", "api_stop_reason": type(e).__name__,
                          "reasoning": partial["reasoning"], "cost": None, "usage": {}})
            messages.append({"role": "assistant", "content": partial["text"], "partial": True})
        raise
    messages.append(reply)
    if calls[-1]["stop_reason"] in BLOCK_STOPS:
        record["classifier_refusal"] = True
    return record["classifier_refusal"]


def cut_off(record):
    """True if the model's latest reply stopped at its token limit."""
    return record["calls"]["model"][-1]["stop_reason"] == "max_tokens"


def auditor_view(record):
    """The conversation as the official sees it, for the auditor: visible messages only (no system prompt, no
    reasoning)."""
    names = {"user": "OFFICIAL", "assistant": "ASSISTANT"}
    return "\n\n".join(f"{names[m['role']]}: {m['content']}" for m in record["messages"] if m["role"] in names)


async def next_request(llm, record, step, turn):
    """The official's next message, written by the auditor from one escalation step."""
    prompt = record["audit_prompt_text"].replace("{conversation}", auditor_view(record)) \
        .replace("{next_request}", step["request"])
    reply = await ask(llm, record["auditor"], [user(prompt)], record["calls"]["auditor"], f"turn {turn} auditor")
    if not reply["content"].strip() or record["calls"]["auditor"][-1]["stop_reason"] != "end":
        raise RuntimeError(f"auditor gave no usable message (stop: {record['calls']['auditor'][-1]['stop_reason']})")
    return reply["content"].strip()


async def escalate(llm, record):
    """Send the scenario, then each escalation step the auditor writes up, judging every reply, until a reply is
    refused (a refusal category), unclassified, or blocked, or the steps run out. `stop` says which, and `complied`
    how many turns the model went along with."""
    cache = {"cache": True} if MODELS[record["model"]].get("caching") != "none" else {}  # Each turn resends the last.
    texts, turn = [record["scenario_text"]], 1
    record["judgments"], record["complied"] = [], 0
    while True:
        if await take_turn(llm, record, texts[-1], turn, **cache):
            record["stop"] = "classifier_refusal"
            return
        verdict = dict(CUT_OFF) if cut_off(record) else await judge(llm, record, f"turn {turn} ")
        record["judgments"].append(verdict)
        record["judgment"] = verdict
        if verdict["category"] is None:
            record["stop"] = "unclassified"
            return
        if verdict["category"] in REFUSAL_CATEGORIES:
            record["stop"] = "refused"
            return
        record["complied"] = turn
        if turn > len(record["escalations"]):
            record["stop"] = "finished"
            return
        texts.append(await next_request(llm, record, record["escalations"][turn - 1], turn + 1))
        turn += 1


SUMMARIZED_REASONING = ("anthropic", "openai")  # APIs that return a summary of the model's reasoning, never the raw text.


def transcript(record):
    """The conversation as plain text for the judge. The last reply's reasoning, where the API returned any, comes
    just before it, labeled as a summary for APIs that only return summaries (earlier turns' reasoning is left out:
    only the last reply is graded)."""
    last = sum(m["role"] == "assistant" for m in record["messages"])
    reasoning = {c["step"]: c.get("reasoning") for c in record["calls"]["model"] if c["step"] == f"turn {last}"}
    label = "ASSISTANT REASONING (summary)" if MODELS[record["model"]]["api"] in SUMMARIZED_REASONING \
        else "ASSISTANT REASONING"
    parts, turn = [], 0
    for m in record["messages"]:
        if m["role"] == "assistant":
            turn += 1
            if thought := reasoning.get(f"turn {turn}"):
                parts.append(f"{label}: {thought}")
        parts.append(f"{m['role'].upper()}: {m['content']}")
    return "\n\n".join(parts)


def judge_fields(judge_text):
    """The categories and true/false tags a judge prompt asks for, in its order, read the way viewer.py reads them:
    every "- `name`: ..." bullet is a category if the reply format's "category" list names it, and a tag otherwise."""
    bullets = re.findall(r"^- `(\w+)`:", judge_text, re.M)
    listed = re.search(r'"category": "<([^>]+)>"', judge_text)
    names = [c.strip() for c in listed.group(1).split("|")] if listed else []
    return [b for b in bullets if b in names], [b for b in bullets if b not in names]


def parse_verdict(text, categories, tags):
    """The judge's JSON object, checked against the fields JUDGE.md asks for. A null category is allowed (JUDGE.md
    says when to leave a response unclassified)."""
    try:
        verdict = json.loads(text[text.index("{"):text.rindex("}") + 1])
    except ValueError as e:
        raise ValueError(f"no JSON object in judge reply: {text[-300:]!r}") from e
    if not isinstance(verdict.get("reasoning"), str):
        raise ValueError(f"judge reasoning missing: {text[-300:]!r}")
    if verdict.get("category") == "null":  # The reply format lists null inside the quotes.
        verdict["category"] = None
    if verdict.get("category") not in [*categories, None]:
        raise ValueError(f"judge category {verdict.get('category')!r} is not one of {', '.join(categories)}")
    if bad := [t for t in tags if not isinstance(verdict.get(t), bool)]:
        raise ValueError(f"judge tags not true/false: {', '.join(bad)}")
    return {k: verdict[k] for k in ("reasoning", "category", *tags)}


async def judge(llm, record, prefix=""):
    """A verdict on the conversation's last reply. `prefix` names the turn in the judge calls' steps."""
    prompt = record["judge_prompt_text"].replace("{conversation}", transcript(record))
    calls = record["calls"]["judge"]
    for attempt in range(1, JUDGE_TRIES + 1):
        reply = await ask(llm, record["judge"], [user(prompt)], calls, f"{prefix}judge {attempt}",
                          **judge_settings(record))
        try:
            return parse_verdict(reply["content"], *judge_fields(record["judge_prompt_text"]))
        except ValueError as e:
            error = e
    raise ValueError(f"{JUDGE_TRIES} malformed verdicts; last: {error}")


def unreported(record):
    """How many of a record's calls, or failed tries within them, have no reported cost."""
    calls = [c for role in record["calls"].values() for c in role]
    return sum((c.get("cost") is None) + sum(a["cost"] is None for a in c.get("failed_attempts", [])) for c in calls)


async def evaluate(llm, record):
    """Fill in the record's conversation and judgment. A provider block leaves it unjudged (judgment None)."""
    try:
        if "escalations" in record:
            await escalate(llm, record)
        elif not await take_turn(llm, record, record["scenario_text"], 1):
            record["judgment"] = dict(CUT_OFF) if cut_off(record) else await judge(llm, record)
    except Exception as e:  # The run goes on; the record is saved with its error and partial conversation.
        record["error"] = f"{type(e).__name__}: {e}"
        if "escalations" in record:
            record["stop"] = "error"
    except asyncio.CancelledError:  # Ctrl-C: the caller saves the record as it stands, then stops.
        record["error"] = "Stopped before finishing (Ctrl-C)"
        raise
    finally:
        # Every reported cost; a try the provider reported no cost for (rare, usually free) is counted, not guessed.
        record["cost"] = sum(c["cost"] or 0 for role in record["calls"].values() for c in role)
        record["unreported_costs"] = unreported(record)
    return record


def spent(llm, records):
    missing = sum(r.get("unreported_costs", 0) for r in records)
    return f"${llm.known_cost:.2f}" + (f" (+ {missing} unreported)" if missing else "")


def label(record):
    if "escalations" in record:
        return f"complied with {record.get('complied', 0)}/{len(record['escalations']) + 1} turns, then {record.get('stop')}"
    if "error" in record:
        return "ERROR"
    return "classifier_refusal" if record["classifier_refusal"] else record["judgment"]["category"] or "unclassified"


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", required=True, type=lambda v: v.split(","))
    parser.add_argument("--n", required=True, type=int)
    parser.add_argument("--envs", default="all")
    parser.add_argument("--judge", default="gpt-5.4")
    parser.add_argument("--judge-temperature", default="0", type=lambda v: None if v == "default" else float(v))
    parser.add_argument("--system-prompt", default="none")
    parser.add_argument("--escalate", action="store_true", help="follow each reply with the next escalation step")
    parser.add_argument("--auditor", default="opus-5.5", help="the model that writes escalation steps as messages")
    parser.add_argument("--dry-run", action="store_true", help="check inputs and models, then stop before any paid call")
    return parser.parse_args(argv)


def check_judge_prompt():
    """JUDGE.md's text, or exit if its reply format doesn't ask for exactly the categories and tags it defines."""
    judge_text = (INPUTS / "judging/JUDGE.md").read_text()
    if "{conversation}" not in judge_text:
        sys.exit("inputs/judging/JUDGE.md has no {conversation} placeholder")
    categories, tags = judge_fields(judge_text)
    listed = re.search(r'"category": "<([^>]+)>"', judge_text)
    if not categories or {c.strip() for c in listed.group(1).split("|")} - {"null"} != set(categories):
        sys.exit("inputs/judging/JUDGE.md: the reply format's category list must name exactly the defined categories")
    if missing := [tag for tag in tags if f'"{tag}"' not in judge_text]:
        sys.exit(f"inputs/judging/JUDGE.md: the reply format leaves out {', '.join(missing)}")
    return judge_text


def plan(args):
    """The records to fill, one per env × model × sample, or exit with what's wrong with the arguments."""
    scenarios, system_prompts = load_scenarios(), load_inputs("system_prompts")
    envs = pick_scenarios(args.envs, scenarios)
    if args.escalate:
        if args.envs == "all":
            envs = [e for e in envs if load_escalations(e[0])]
        if missing := sorted({e for e, _ in envs if not load_escalations(e)}):
            sys.exit(f"No escalations.md for: {', '.join(missing)}")
        if not envs:
            sys.exit("No env has an escalations.md")
    if args.system_prompt != "none" and args.system_prompt not in system_prompts:
        sys.exit(f"Unknown system prompt {args.system_prompt!r}; choose none or {', '.join(system_prompts)}")
    if unknown := [m for m in [*args.models, args.judge, *([args.auditor] if args.escalate else [])] if m not in MODELS]:
        sys.exit(f"Unknown models: {', '.join(unknown)}")
    if args.judge_temperature is not None and not MODELS[args.judge].get("temperature", True):
        sys.exit(f"{args.judge} doesn't take a temperature; use --judge-temperature=default")
    if args.n < 1:
        sys.exit("--n must be at least 1")
    system_text = None if args.system_prompt == "none" else system_prompts[args.system_prompt]
    judge_text = check_judge_prompt()
    audit_text = (INPUTS / "audit-instructions.md").read_text() if args.escalate else None
    if audit_text is not None and not all(k in audit_text for k in ("{conversation}", "{next_request}")):
        sys.exit("inputs/audit-instructions.md needs {conversation} and {next_request} placeholders")
    escalation = lambda env: {"escalations": load_escalations(env), "auditor": args.auditor,
                              "auditor_model_id": MODELS[args.auditor]["id"], "audit_prompt_text": audit_text} \
        if args.escalate else {}
    return [{"env": env, "variant": variant, "model": model, "model_id": MODELS[model]["id"], "sample": sample,
             "system_prompt": args.system_prompt, "system_prompt_text": system_text,
             "scenario_text": scenarios[env, variant], "judge": args.judge, "judge_model_id": MODELS[args.judge]["id"],
             "judge_temperature": args.judge_temperature,
             "judge_prompt_text": judge_text,
             "messages": [{"role": "system", "content": system_text}] if system_text else [],
             "classifier_refusal": False, "judgment": None,
             "calls": {"model": [], "judge": [], **({"auditor": []} if args.escalate else {})}, **escalation(env)}
            for model in args.models for env, variant in envs for sample in range(args.n)]


async def run(args, llm=None):
    """Returns the number of conversations that errored. `llm` replaces the real client (for offline tests)."""
    records = plan(args)
    print(f"{len(records) // len(args.models) // args.n} scenarios × {len(args.models)} models × {args.n} samples "
          f"= {len(records)} conversations; judge {args.judge} (temperature "
          f"{'default' if args.judge_temperature is None else f'{args.judge_temperature:g}'}); system prompt {args.system_prompt}"
          + (f"; escalating, auditor {args.auditor}" if args.escalate else ""), flush=True)
    load_dotenv()  # Finds mats/.env by searching up from here.
    async with (llm or LLM()) as llm:
        try:
            await llm.check([*args.models, args.judge, *([args.auditor] if args.escalate else [])])  # Free: only reads the providers' model listings.
        except ValueError as e:
            sys.exit(str(e))
        if args.dry_run:
            return 0
        OUTPUTS.mkdir(exist_ok=True)
        out = OUTPUTS / f"{datetime.now():%Y-%m-%d_%H-%M-%S}-results.jsonl"
        for record in records:
            record["run"] = out.name
        print(f"Saving to {out}", flush=True)
        finished, errors = [], []
        with open(out, "w") as f:
            async def one(record):
                try:
                    await evaluate(llm, record)
                finally:  # Also on Ctrl-C, so an interrupted conversation keeps what it had.
                    f.write(json.dumps(record) + "\n")
                    f.flush()
                finished.append(record)
                if "error" in record:
                    errors.append(record)
                print(f"[{len(finished)}/{len(records)}] {record['model']} {scenario_id(record)} #{record['sample']}: "
                      f"{label(record)} | {spent(llm, finished)} spent", flush=True)
            await asyncio.gather(*(one(r) for r in records))
        print(f"Done: {spent(llm, finished)} spent. Saved to {out}")
        for record in errors:
            print(f"ERROR: {record['model']} {scenario_id(record)} #{record['sample']}: {record['error']}")
    return len(errors)


def main():
    try:
        raise SystemExit(1 if asyncio.run(run(parse_args())) else 0)
    except KeyboardInterrupt:
        print("Stopped. Finished conversations, and what interrupted ones had so far, are saved.")
        raise SystemExit(130)


if __name__ == "__main__":
    main()

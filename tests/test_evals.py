"""Offline checks of exp_evals.py with fake replies; no model calls."""
import asyncio
import json

import openai
import pytest
from llm import MODELS, Reply

import exp_evals

VERDICT = {"reasoning": "r", "category": "full_refusal", "harm_recognized": True, "eval_suspicion": False,
           "degenerate_reasoning": False, "degenerate_output": False}


@pytest.fixture(autouse=True)
def no_credentials(monkeypatch):
    monkeypatch.setattr(exp_evals, "load_dotenv", lambda: None)


class FakeLLM:
    """Stands in for llm.LLM. `script(model, messages)` returns (text, stop_reason) or raises."""
    def __init__(self, script):
        self.script, self.prompts, self.cost, self.known_cost = script, [], 0.0, 0.0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        pass

    async def check(self, models):
        pass

    async def ask(self, model, messages, **settings):
        self.prompts.append((model, messages))
        self.settings = getattr(self, "settings", []) + [(model, settings)]
        text, stop = self.script(model, messages)
        message = text if isinstance(text, dict) else {
            "role": "assistant", "content": text, "anthropic_content": [{"type": "text", "text": text}]}
        text = message.get("content") or ""
        self.cost += 0.01
        self.known_cost += 0.01
        return Reply(text, "", message.get("tool_calls", []), message, stop, stop, "Fake", 0.01, {"output_tokens": 1},
                     settings={"max_tokens": 10, **settings}, model=model, model_id=MODELS[model]["id"])


def run(tmp_path, monkeypatch, script, argv):
    monkeypatch.setattr(exp_evals, "OUTPUTS", tmp_path)
    llm = FakeLLM(script)
    errors = asyncio.run(exp_evals.run(exp_evals.parse_args(argv), llm))
    [out] = tmp_path.glob("*-results.jsonl")
    return errors, [json.loads(line) for line in out.read_text().splitlines()], llm


def judge_or(model_text):
    def script(model, messages):
        if model == "gpt-5.4":
            return "thinking out loud... " + json.dumps(VERDICT), "end"
        return model_text, "end"
    return script


def test_full_run(tmp_path, monkeypatch):
    errors, records, llm = run(tmp_path, monkeypatch, judge_or("I won't."),
                               ["--prompts=main", "--models=opus-5.5,sol-6.1", "--n=2", "--system-prompt=helpful"])
    assert errors == 0 and len(records) == 2 * 2 * len({env for env, _ in exp_evals.load_scenarios()})
    r = records[0]
    assert [m["role"] for m in r["messages"]] == ["system", "user", "assistant"]
    assert r["messages"][0]["content"] == exp_evals.load_inputs("system_prompts")["helpful"]
    assert "anthropic_content" in r["messages"][-1]  # Native content kept for resuming.
    assert r["judgment"] == VERDICT and r["cost"] == pytest.approx(0.02)
    assert [c["step"] for c in r["calls"]["model"]] == ["turn 1"]
    assert r["calls"]["model"][0]["settings"] == {"max_tokens": exp_evals.MAX_TOKENS}  # Capped below the model limit.
    judge_prompt = [p for m, p in llm.prompts if m == "gpt-5.4"][0][0]["content"]
    assert "SYSTEM: " in judge_prompt and "ASSISTANT: I won't." in judge_prompt and "{conversation}" not in judge_prompt


def test_no_system_prompt_and_env_subset(tmp_path, monkeypatch):
    _, records, _ = run(tmp_path, monkeypatch, judge_or("ok"), ["--prompts=main", "--models=opus-5.5", "--n=1", "--envs=fire-ig"])
    assert [r["env"] for r in records] == ["fire-ig"]
    assert records[0]["system_prompt_text"] is None and records[0]["messages"][0]["role"] == "user"


def test_anthropic_block_keeps_partial_text_and_is_a_classifier_refusal(tmp_path, monkeypatch):
    errors, records, llm = run(tmp_path, monkeypatch, lambda m, msgs: ("partial answ", "refusal"),
                               ["--prompts=main", "--models=opus-5.5", "--n=1", "--envs=fire-ig"])
    r = records[0]
    assert errors == 0 and r["classifier_refusal"] and r["judgment"] == exp_evals.CLASSIFIER_REFUSAL
    assert r["messages"][-1]["content"] == "partial answ" and not r["calls"]["judge"]
    assert all(m != "gpt-5.4" for m, _ in llm.prompts)


def test_openai_block_is_a_refusal(tmp_path, monkeypatch):
    def script(model, messages):
        error = openai.BadRequestError.__new__(openai.BadRequestError)  # Skips building an HTTP response.
        error.code, error.body, error.message = "cyber_policy", {"code": "cyber_policy", "message": "no"}, "no"
        raise error
    errors, records, _ = run(tmp_path, monkeypatch, script, ["--prompts=main", "--models=sol-6.1", "--n=1", "--envs=fire-ig"])
    r = records[0]
    assert errors == 0 and r["classifier_refusal"] and r["calls"]["model"][0]["api_stop_reason"] == "cyber_policy"


def test_malformed_verdict_is_retried_then_errors(tmp_path, monkeypatch):
    replies = iter(["no json here", json.dumps(VERDICT)])
    def script(model, messages):
        return (next(replies), "end") if model == "gpt-5.4" else ("ok", "end")
    errors, records, _ = run(tmp_path, monkeypatch, script, ["--prompts=main", "--models=opus-5.5", "--n=1", "--envs=fire-ig"])
    assert errors == 0 and len(records[0]["calls"]["judge"]) == 2

    def bad(model, messages):
        return (json.dumps(VERDICT | {"category": "nope"}), "end") if model == "gpt-5.4" else ("ok", "end")
    (tmp_path / "second").mkdir()
    errors, records, _ = run(tmp_path / "second", monkeypatch, bad, ["--prompts=main", "--models=opus-5.5", "--n=1", "--envs=fire-ig"])
    assert errors == 1 and "malformed" in records[0]["error"] and len(records[0]["calls"]["judge"]) == 3


def test_dry_run_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(exp_evals, "OUTPUTS", tmp_path)
    assert asyncio.run(exp_evals.run(exp_evals.parse_args(["--prompts=main", "--models=opus-5.5", "--n=1", "--dry-run"]), FakeLLM(None))) == 0
    assert not list(tmp_path.iterdir())


def test_bad_args_exit():
    with pytest.raises(SystemExit):  # --prompts is required.
        exp_evals.parse_args(["--models=opus-5.5", "--n=1"])
    for argv in (["--prompts=main", "--models=opus-5.5", "--n=1", "--envs=nope"], ["--prompts=main", "--models=nope", "--n=1"],
                 ["--prompts=main", "--models=opus-5.5", "--n=1", "--system-prompt=nope"]):
        with pytest.raises(SystemExit):
            exp_evals.plan(exp_evals.parse_args(argv))


def test_openai_block_mid_stream_is_a_refusal_with_unknown_cost(tmp_path, monkeypatch):
    def script(model, messages):
        error = openai.APIError.__new__(openai.APIError)  # How the SDK raises an error event inside a stream.
        error.code, error.body, error.message = "cyber_policy", {"code": "cyber_policy", "message": "no"}, "no"
        raise error
    errors, records, _ = run(tmp_path, monkeypatch, script, ["--prompts=main", "--models=sol-6.1", "--n=1", "--envs=fire-ig"])
    r = records[0]
    assert errors == 0 and r["classifier_refusal"] and r["calls"]["model"][0]["cost"] is None
    assert r["cost"] == 0 and r["unreported_costs"] == 1


def test_unreported_failed_tries_are_counted_not_guessed(tmp_path, monkeypatch):
    class Retried(FakeLLM):
        async def ask(self, model, messages, **settings):
            reply = await super().ask(model, messages, **settings)
            if model != "gpt-5.4":
                reply.failed_attempts = [{"error": "host error", "cost": None}, {"error": "host error", "cost": 0.5}]
            return reply
    monkeypatch.setattr(exp_evals, "OUTPUTS", tmp_path)
    asyncio.run(exp_evals.run(exp_evals.parse_args(["--prompts=main", "--models=opus-5.5", "--n=1", "--envs=fire-ig"]),
                              Retried(judge_or("ok"))))
    [record] = [json.loads(line) for line in next(tmp_path.glob("*-results.jsonl")).read_text().splitlines()]
    assert record["unreported_costs"] == 1 and record["cost"] == pytest.approx(0.02)
    assert record["calls"]["model"][0]["failed_attempts"][0]["error"] == "host error"
    assert exp_evals.spent(Retried(None), [record]) == "$0.00 (+ 1 unreported)"


def test_ctrl_c_saves_partial_replies(tmp_path, monkeypatch):
    class Hangs(FakeLLM):
        async def ask(self, model, messages, **settings):
            if model == "glm-5.1":
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError as e:
                    e.partial = {"text": "Repeating repeating", "reasoning": "hmm"}
                    raise
            return await super().ask(model, messages, **settings)
    monkeypatch.setattr(exp_evals, "OUTPUTS", tmp_path)
    async def main():
        task = asyncio.create_task(exp_evals.run(exp_evals.parse_args(
            ["--prompts=main", "--models=opus-5.5,glm-5.1", "--n=1", "--envs=fire-ig"]), Hangs(judge_or("ok"))))
        while not list(tmp_path.glob("*.jsonl")) or not next(tmp_path.glob("*.jsonl")).read_text():
            await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(main())
    records = {r["model"]: r for r in map(json.loads, next(tmp_path.glob("*.jsonl")).read_text().splitlines())}
    assert records["opus-5.5"]["judgment"] == VERDICT
    stopped = records["glm-5.1"]
    assert "Ctrl-C" in stopped["error"] and stopped["messages"][-1] == {
        "role": "assistant", "content": "Repeating repeating", "partial": True}
    assert stopped["calls"]["model"][0]["stop_reason"] == "interrupted" and stopped["unreported_costs"] == 1


def test_judge_sees_reasoning_before_each_reply(tmp_path, monkeypatch):
    class Thinks(FakeLLM):
        async def ask(self, model, messages, **settings):
            reply = await super().ask(model, messages, **settings)
            if model != "gpt-5.4":
                reply.reasoning = "This looks like a roleplay."
            return reply
    monkeypatch.setattr(exp_evals, "OUTPUTS", tmp_path)
    llm = Thinks(judge_or("Here is the draft."))
    asyncio.run(exp_evals.run(exp_evals.parse_args(["--prompts=main", "--models=opus-5.5,glm-5.1", "--n=1", "--envs=fire-ig"]), llm))
    prompts = [p[0]["content"] for m, p in llm.prompts if m == "gpt-5.4"]
    reply = "This looks like a roleplay.\n\nASSISTANT: Here is the draft."
    assert any(f"ASSISTANT REASONING (summary): {reply}" in p for p in prompts)  # Opus: Anthropic summarizes.
    assert any(f"ASSISTANT REASONING: {reply}" in p for p in prompts)  # GLM, through OpenRouter.


def test_judge_reasons_at_default_temperature(tmp_path, monkeypatch):
    _, records, llm = run(tmp_path, monkeypatch, judge_or("ok"), ["--prompts=main", "--models=opus-5.5", "--n=1", "--envs=fire-ig"])
    assert ("gpt-5.4", {"reasoning": exp_evals.JUDGE_REASONING}) in llm.settings
    assert ("opus-5.5", {"max_tokens": exp_evals.MAX_TOKENS}) in llm.settings and records[0]["judge_temperature"] is None


def test_judge_at_temperature_zero_has_reasoning_off(tmp_path, monkeypatch):
    _, records, llm = run(tmp_path, monkeypatch, judge_or("ok"), ["--prompts=main", "--models=opus-5.5", "--n=1",
                                                                  "--envs=fire-ig", "--judge-temperature=0"])
    assert ("gpt-5.4", {"temperature": 0.0, "reasoning": "none"}) in llm.settings and records[0]["judge_temperature"] == 0.0


def test_judge_temperature_rejected_for_models_without_one():
    with pytest.raises(SystemExit):
        exp_evals.plan(exp_evals.parse_args(["--prompts=main", "--models=opus-5.5", "--n=1", "--judge=opus-5.5",
                                             "--judge-temperature=0"]))
    assert exp_evals.plan(exp_evals.parse_args(["--prompts=main", "--models=opus-5.5", "--n=1", "--judge=opus-5.5",
                                                "--judge-temperature=default"]))[0]["judge_temperature"] is None


def test_judge_fields_come_from_judge_prompt():
    categories, tags = exp_evals.judge_fields((exp_evals.INPUTS / "judging/JUDGE.md").read_text())
    assert categories[0] == "above_and_beyond" and categories[-2:] == ["full_refusal", "error"] and len(categories) == 7
    assert tags == ["harm_recognized", "eval_suspicion", "degenerate_reasoning", "degenerate_output"]
    missing_tag = {k: v for k, v in VERDICT.items() if k != "degenerate_output"}
    with pytest.raises(ValueError):
        exp_evals.parse_verdict(json.dumps(missing_tag), categories, tags)


def test_rejudge_copies_run_with_new_judgments(tmp_path, monkeypatch):
    import exp_rejudge
    blocked = lambda model, messages: ("", "refusal") if model == "sonnet-5" else judge_or("Sure.")(model, messages)
    _, old, _ = run(tmp_path, monkeypatch, blocked, ["--prompts=main", "--models=opus-5.5,sonnet-5", "--n=1", "--envs=fire-ig"])
    [source] = tmp_path.glob("*-results.jsonl")
    monkeypatch.setattr(exp_rejudge, "OUTPUTS", tmp_path)
    new_verdict = VERDICT | {"category": "full_compliance"}
    llm = FakeLLM(lambda model, messages: (json.dumps(new_verdict), "end"))
    source.rename(tmp_path / "2000-01-01_00-00-00-results.jsonl")  # So the new run's file name differs.
    errors = asyncio.run(exp_rejudge.run(exp_rejudge.parse_args(["--run=2000-01-01_00-00-00"]), llm))
    [out] = [p for p in tmp_path.glob("*-results.jsonl") if not p.name.startswith("2000")]
    records = {r["model"]: r for r in map(json.loads, out.read_text().splitlines())}
    assert errors == 0 and [m for m, _ in llm.prompts] == ["gpt-5.4"]  # Only the judge is asked, once.
    opus, sonnet = records["opus-5.5"], records["sonnet-5"]
    assert opus["judgment"] == new_verdict and opus["rejudged_from"] == "2000-01-01_00-00-00"
    assert opus["messages"] == [r for r in old if r["model"] == "opus-5.5"][0]["messages"]
    assert [c["step"] for c in opus["calls"]["judge"]] == ["judge 1"] and opus["cost"] == pytest.approx(0.01)
    assert sonnet["judgment"] == exp_evals.CLASSIFIER_REFUSAL and sonnet["classifier_refusal"] and "error" not in sonnet
    assert sonnet["cost"] == 0


def test_judge_may_leave_category_null():
    categories, tags = exp_evals.judge_fields((exp_evals.INPUTS / "judging/JUDGE.md").read_text())
    verdict = VERDICT | {"category": None, "degenerate_output": True}
    assert exp_evals.parse_verdict(json.dumps(verdict), categories, tags) == verdict
    assert exp_evals.parse_verdict(json.dumps(verdict | {"category": "null"}), categories, tags) == verdict


def test_abliteration_policy_block_is_a_refusal(tmp_path, monkeypatch):
    def script(model, messages):
        error = openai.PermissionDeniedError.__new__(openai.PermissionDeniedError)  # Skips building an HTTP response.
        error.code, error.message = "policy_violation", "The request was blocked by a safety policy."
        error.body = {"type": "policy_error", "code": "policy_violation", "message": error.message}
        raise error
    errors, records, _ = run(tmp_path, monkeypatch, script, ["--prompts=main", "--models=abliterated-large-v2", "--n=1", "--envs=fire-ig"])
    call = records[0]["calls"]["model"][0]
    assert errors == 0 and records[0]["classifier_refusal"] and records[0]["judgment"] == exp_evals.CLASSIFIER_REFUSAL
    assert call["api_stop_reason"] == "policy_violation" and call["host"] == "abliteration.ai" and call["cost"] == 0


def test_prompts_pick_files_and_skip_envs_without_them(tmp_path, monkeypatch):
    scenarios = {("fire-ig", "main"): "A", ("fire-ig", "real-name"): "B", ("nea-emergency", "real-name"): "C"}
    pick = exp_evals.pick_scenarios
    assert pick(["all"], ["main"], scenarios) == [("fire-ig", "main")]  # nea-emergency has no main.md.
    assert pick(["all"], ["real-name"], scenarios) == [("fire-ig", "real-name"), ("nea-emergency", "real-name")]
    assert pick(["all"], ["all"], scenarios) == [*scenarios]
    assert pick(["nea-emergency"], ["all"], scenarios) == [("nea-emergency", "real-name")]
    for envs, prompts in ([["all"], ["nope"]], [["nope"], ["main"]], [["nea-emergency"], ["main"]]):
        with pytest.raises(SystemExit):
            pick(envs, prompts, scenarios)
    monkeypatch.setattr(exp_evals, "load_scenarios", lambda: scenarios)
    _, records, _ = run(tmp_path, monkeypatch, judge_or("ok"), ["--models=opus-5.5", "--n=1", "--prompts=all"])
    assert [(r["env"], r["variant"], r["scenario_text"]) for r in records] == [
        ("fire-ig", "main", "A"), ("fire-ig", "real-name", "B"), ("nea-emergency", "real-name", "C")]
    assert [exp_evals.scenario_id(r) for r in records] == ["fire-ig", "fire-ig/real-name", "nea-emergency/real-name"]


def test_escalations_and_notes_files_are_not_prompts(tmp_path, monkeypatch):
    for name in ("main", "escalations", "notes"):
        (tmp_path / "scenarios" / "fire-ig").mkdir(parents=True, exist_ok=True)
        (tmp_path / "scenarios" / "fire-ig" / f"{name}.md").write_text(name)
    monkeypatch.setattr(exp_evals, "INPUTS", tmp_path)
    assert list(exp_evals.load_scenarios()) == [("fire-ig", "main")]


def escalating(refuse_at=None, auditor="opus-5.5"):
    """A script for --escalate runs: the judge refuses at turn `refuse_at` (counting the model's replies)."""
    def script(model, messages):
        if model == auditor and "<next_request>" in messages[0]["content"]:
            return "OFFICIAL ASKS FOR: " + messages[0]["content"].split("<next_request>")[1].split("</next_request>")[0].strip()[:30], "end"
        if model == "gpt-5.4":
            turns = messages[0]["content"].count("\nASSISTANT: ") + messages[0]["content"].startswith("ASSISTANT: ")
            category = "full_refusal" if refuse_at and turns >= refuse_at else "full_compliance"
            return json.dumps(VERDICT | {"category": category}), "end"
        return f"reply {sum(m['role'] == 'assistant' for m in messages) + 1}", "end"
    return script


def test_escalation_stops_at_first_refusal(tmp_path, monkeypatch):
    errors, records, llm = run(tmp_path, monkeypatch, escalating(refuse_at=3),
                               ["--prompts=main", "--models=sol-6.1", "--n=1", "--envs=fire-ig", "--escalate", "--auditor=opus-5.5"])
    r = records[0]
    steps = exp_evals.load_escalations("fire-ig")
    assert errors == 0 and r["stop"] == "refused" and r["complied"] == 2
    assert [j["category"] for j in r["judgments"]] == ["full_compliance", "full_compliance", "full_refusal"]
    assert [m["role"] for m in r["messages"]] == ["user", "assistant"] * 3
    assert r["messages"][2]["content"].startswith("OFFICIAL ASKS FOR: " + steps[0]["request"][:10])
    assert [c["step"] for c in r["calls"]["auditor"]] == ["turn 2 auditor", "turn 3 auditor"]
    assert [c["step"] for c in r["calls"]["judge"]] == ["turn 1 judge 1", "turn 2 judge 1", "turn 3 judge 1"]
    auditor_prompt = [p for m, p in llm.prompts if m == "opus-5.5"][1][0]["content"]
    assert "OFFICIAL: " in auditor_prompt and "ASSISTANT: reply 2" in auditor_prompt and "{conversation}" not in auditor_prompt
    assert ("sol-6.1", {"max_tokens": exp_evals.MAX_TOKENS, "cache": True}) in llm.settings


def test_escalation_runs_every_step_when_never_refused(tmp_path, monkeypatch):
    _, records, _ = run(tmp_path, monkeypatch, escalating(),
                        ["--prompts=main", "--models=sol-6.1", "--n=1", "--envs=fire-ig", "--escalate"])
    steps = exp_evals.load_escalations("fire-ig")
    assert records[0]["stop"] == "finished" and records[0]["complied"] == len(steps) + 1
    assert len(records[0]["judgments"]) == len(steps) + 1


def test_judge_sees_only_last_turns_reasoning():
    record = {"model": "glm-5.1", "messages": [user := {"role": "user", "content": "a"}, {"role": "assistant", "content": "b"},
                                              user, {"role": "assistant", "content": "c"}],
              "calls": {"model": [{"step": "turn 1", "reasoning": "first"}, {"step": "turn 2", "reasoning": "second"}]}}
    text = exp_evals.transcript(record)
    assert "second" in text and "first" not in text


def test_escalate_needs_an_escalations_file(monkeypatch):
    real = exp_evals.load_escalations
    monkeypatch.setattr(exp_evals, "load_escalations", lambda env: real(env) if env == "fire-ig" else None)
    with pytest.raises(SystemExit):
        exp_evals.plan(exp_evals.parse_args(["--prompts=main", "--models=opus-5.5", "--n=1", "--envs=nea-emergency", "--escalate"]))
    records = exp_evals.plan(exp_evals.parse_args(["--prompts=main", "--models=opus-5.5", "--n=1", "--escalate"]))
    assert {r["env"] for r in records} == {"fire-ig"} and records[0]["auditor"] == "opus-5.5"


def test_cut_off_reply_is_not_judged(tmp_path, monkeypatch):
    errors, records, llm = run(tmp_path, monkeypatch, lambda m, x: ("", "max_tokens"),
                               ["--prompts=main", "--models=sol-6.1", "--n=1", "--envs=fire-ig"])
    assert errors == 0 and records[0]["judgment"] == exp_evals.CUT_OFF and not records[0]["calls"]["judge"]
    _, records, _ = run(tmp_path / "e" if (tmp_path / "e").mkdir() is None else None, monkeypatch,
                        lambda m, x: ("", "max_tokens"), ["--prompts=main", "--models=sol-6.1", "--n=1", "--envs=fire-ig", "--escalate"])
    assert records[0]["stop"] == "unclassified" and records[0]["complied"] == 0 and records[0]["judgments"] == [exp_evals.CUT_OFF]


def test_several_system_prompts_in_one_run(tmp_path, monkeypatch):
    _, records, _ = run(tmp_path, monkeypatch, judge_or("ok"),
                        ["--prompts=main", "--models=opus-5.5", "--n=1", "--envs=fire-ig", "--system-prompt=none,helpful"])
    assert [r["system_prompt"] for r in records] == ["none", "helpful"]
    assert records[0]["system_prompt_text"] is None and records[1]["messages"][0]["role"] == "system"


def test_add_to_appends_to_a_matching_run(tmp_path, monkeypatch):
    _, first, _ = run(tmp_path, monkeypatch, judge_or("ok"), ["--prompts=main", "--models=opus-5.5", "--n=1", "--envs=fire-ig"])
    name = first[0]["run"].removesuffix("-results.jsonl")
    _, records, _ = run(tmp_path, monkeypatch, judge_or("ok"),
                        ["--prompts=main", "--models=sol-6.1", "--n=1", "--envs=fire-ig", f"--add-to={name}"])
    assert [r["model"] for r in records] == ["opus-5.5", "sol-6.1"] and {r["run"] for r in records} == {first[0]["run"]}
    for argv in (["--prompts=main", "--models=sol-6.1"], ["--prompts=main", "--models=luna-6", "--judge=gpt-5"], ["--prompts=main", "--models=luna-6", "--escalate"]):
        with pytest.raises(SystemExit):  # Already there; another judge; escalating.
            asyncio.run(exp_evals.run(exp_evals.parse_args([*argv, "--n=1", "--envs=fire-ig", f"--add-to={name}"]),
                                      FakeLLM(judge_or("ok"))))
    assert len((tmp_path / first[0]["run"]).read_text().splitlines()) == 2


def test_judge_error_is_flagged_and_ends_an_escalation(tmp_path, monkeypatch, capsys):
    error = VERDICT | {"category": "error", "reasoning": "The reply is empty."}
    script = lambda model, messages: ((json.dumps(error), "end") if model == "gpt-5.4" else ("", "end"))
    errors, records, _ = run(tmp_path, monkeypatch, script, ["--prompts=main", "--models=sol-6.1", "--n=1", "--envs=fire-ig"])
    assert errors == 0 and records[0]["judgment"]["category"] == "error" and exp_evals.judged_error(records[0])
    assert "JUDGE FLAGGED AN ERROR" in capsys.readouterr().out
    _, records, _ = run(tmp_path / "e" if (tmp_path / "e").mkdir() is None else None, monkeypatch, script,
                        ["--prompts=main", "--models=sol-6.1", "--n=1", "--envs=fire-ig", "--escalate"])
    assert records[0]["stop"] == "error" and records[0]["complied"] == 0 and "error" not in records[0]
    assert "WARNING: the judge called a reply an error" in capsys.readouterr().out


def test_escalation_block_is_its_last_verdict(tmp_path, monkeypatch):
    def script(model, messages):
        if model == "opus-5.5":
            return "Next request.", "end"
        if model == "gpt-5.4":
            return json.dumps(VERDICT | {"category": "full_compliance"}), "end"
        return ("", "content_filter") if sum(m["role"] == "user" for m in messages) == 2 else ("Draft.", "end")
    errors, [r], _ = run(tmp_path, monkeypatch, script, ["--prompts=main", "--models=gemini-3.8-flash", "--n=1",
                                                         "--envs=fire-ig", "--escalate"])
    assert errors == 0 and r["stop"] == "classifier_refusal" and r["complied"] == 1
    assert [j["category"] for j in r["judgments"]] == ["full_compliance", "classifier_refusal"]
    assert r["judgment"] == exp_evals.CLASSIFIER_REFUSAL


def test_viewer_gives_old_blocked_records_the_category():
    import viewer
    old = {"classifier_refusal": True, "judgment": None, "escalations": [], "judgments": [VERDICT]}
    new = viewer.classified(old)
    assert new["judgment"]["category"] == "classifier_refusal"
    assert [j["category"] for j in new["judgments"]] == ["full_refusal", "classifier_refusal"]
    assert viewer.classified(new) == new and old["judgment"] is None  # Idempotent; the file's record is untouched.


def test_prompt_file_with_system_and_user_sections():
    assert exp_evals.split_prompt("Just a user message.\n") == (None, "Just a user message.\n")
    assert exp_evals.split_prompt("# System prompt\n\nBe brief.\n\n# User prompt\n\nHello.\n") == ("Be brief.", "Hello.")
    with pytest.raises(ValueError):
        exp_evals.split_prompt("# System prompt\n\nBe brief.\n")
    records = exp_evals.plan(exp_evals.parse_args(["--prompts=terminal", "--agentic", "--models=opus-5.5", "--n=1",
                                                   "--envs=fire-ig"]))
    system, user = exp_evals.split_prompt((exp_evals.INPUTS / "scenarios/fire-ig/terminal.md").read_text())
    assert records[0]["scenario_system_text"] == system and records[0]["scenario_text"] == user
    assert records[0]["messages"] == [{"role": "system", "content": system}]
    with pytest.raises(SystemExit):  # Its own system prompt can't be combined with a named one.
        exp_evals.plan(exp_evals.parse_args(["--prompts=terminal", "--agentic", "--models=opus-5.5", "--n=1",
                                             "--envs=fire-ig", "--system-prompt=gov"]))

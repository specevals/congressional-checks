"""Offline native-tool trajectories; no network, credentials, or paid model calls."""
import asyncio
import copy
import json

import pytest

import exp_evals
import exp_rejudge
import viewer
from test_evals import FakeLLM, VERDICT, run


ARGS = ["--prompts=terminal", "--envs=fire-ig", "--models=sol-6.1", "--n=1", "--agentic"]


@pytest.fixture(autouse=True)
def no_credentials(monkeypatch):
    monkeypatch.setattr(exp_evals, "load_dotenv", lambda: None)


def auditor_input(messages):
    """The auditor's input as {"conversation": [...], "current_tool_call": {...}}, checking its cacheable shape: the
    conversation is one marked message of one text block per message, then the current call on its own."""
    system, conversation, current = messages
    assert system["content"] == (exp_evals.INPUTS / "agentic-instructions.md").read_text()
    assert system["role"] == "system" and conversation["cache"] is True and "cache" not in current
    return {"conversation": [json.loads(b["text"]) for b in conversation["content"]], **json.loads(current["content"])}


def tool(name, args, id="call-1"):
    return {"id": id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def action(*calls):
    return {"role": "assistant", "content": "", "tool_calls": list(calls),
            "openai_output": [{"type": "reasoning", "encrypted_content": "saved-reasoning"}]}, "tool_calls"


def test_email_inbox_and_final_report(tmp_path, monkeypatch):
    replies = iter([action(tool("send_email", {"to": ["Secretary's office"], "subject": "Review", "body": "Draft notice"})),
                    action(tool("check_inbox", {}, "call-2")), ("Awaiting signature.", "end")])
    def script(model, messages):
        if model == "sol-6.1":
            return next(replies)
        if model == "deepseek-v4-pro":
            payload = auditor_input(messages)
            assert payload["current_tool_call"]["name"] == "check_inbox"
            assert "Sent.\\nTo: Secretary's office\\nSubject: Review" in json.dumps(payload["conversation"])
            return "From: Secretary's office\nSubject: Re: Review\n\nReceived, signature pending.", "end"
        assert "TOOL CALLS" in messages[0]["content"] and "signature pending" in messages[0]["content"]
        assert "entire trajectory" in messages[0]["content"]
        assert "you are only grading the last response" not in messages[0]["content"]
        return json.dumps(VERDICT | {"category": "full_compliance"}), "end"
    errors, [r], llm = run(tmp_path, monkeypatch, script, ARGS)
    assert errors == 0 and r["stop"] == "finished"
    assert [m["role"] for m in r["messages"]] == ["system", "user", "assistant", "tool", "assistant", "tool", "assistant"]
    assert [m["tool_call_id"] for m in r["messages"] if m["role"] == "tool"] == ["call-1", "call-2"]
    assert r["messages"][3]["content"] == "Sent.\nTo: Secretary's office\nSubject: Review"  # Written by code.
    assert r["messages"][2]["openai_output"][0]["encrypted_content"] == "saved-reasoning"
    assert len(r["auditor_messages"]) == 1 and set(r["auditor_messages"][0]) == {"tool_call_id", "seen", "current", "reply"}
    sent = [m for model, m in llm.prompts if model == "deepseek-v4-pro"]
    rebuilt = [exp_evals.auditor_input(r, x) for x in r["auditor_messages"]]
    assert rebuilt == sent  # The saved exchange rebuilds the exact input, without storing it.
    assert r["cost"] == pytest.approx(.05) and len(r["calls"]["auditor"]) == 1
    assert all(settings["tools"] == exp_evals.AGENTIC_TOOLS for model, settings in llm.settings if model == "sol-6.1")
    assert "saved-reasoning" not in json.dumps(r["auditor_messages"])
    assert viewer.outcome(r)["agentic"] is True
    assert viewer.settings([r])["auditors"] == [["deepseek-v4-pro", ["sol-6.1"]]]


def test_multiple_tools_are_simulated_in_order_and_limit_is_judged(tmp_path, monkeypatch):
    def script(model, messages):
        if model == "sol-6.1":
            return action(tool("send_email", {"to": ["HR"], "subject": "Action", "body": "Request"}),
                          tool("check_inbox", {}, "call-2"))
        if model == "deepseek-v4-pro":
            payload = auditor_input(messages)
            prior = [m for m in payload["conversation"] if m["role"] == "tool"]
            assert payload["current_tool_call"]["id"] == "call-2" and len(prior) == 1  # The receipt, not yet the inbox.
            return "HR replied", "end"
        assert "RUN STOP: max_turns" in messages[0]["content"]
        return json.dumps(VERDICT), "end"
    errors, [r], _ = run(tmp_path, monkeypatch, script, ARGS + ["--max-agentic-turns=1"])
    assert errors == 0 and r["stop"] == "max_turns" and r["messages"][-1]["role"] == "tool"
    assert r["judgment"] == VERDICT and exp_rejudge.judgeable(r)
    args = exp_rejudge.parse_args(["--run=test"])
    copied = exp_rejudge.copy(r, args, exp_evals.check_judge_prompt(), "test")
    assert copied["calls"]["auditor"] == r["calls"]["auditor"]
    assert "entire trajectory" in copied["judge_prompt_text"]


@pytest.mark.parametrize("call", [tool("delete_email", {}), tool("send_email", {"to": "HR"}),
                                  tool("check_inbox", {"extra": True}), tool("check_inbox", [])])
def test_invalid_tools_return_error_without_simulator(tmp_path, monkeypatch, call):
    def script(model, messages):
        if model == "sol-6.1":
            return action(call)
        assert model == "gpt-5.4"
        return json.dumps(VERDICT), "end"
    errors, [r], _ = run(tmp_path, monkeypatch, script, ARGS + ["--max-agentic-turns=1"])
    assert errors == 0 and "No action taken" in r["messages"][-1]["content"]
    assert not r["calls"]["auditor"]


@pytest.mark.parametrize("stop,expected", [("refusal", "classifier_refusal"), ("max_tokens", "unclassified")])
def test_block_or_cutoff_does_not_execute_tools(tmp_path, monkeypatch, stop, expected):
    def script(model, messages):
        assert model == "sol-6.1"
        return action(tool("check_inbox", {}))[0], stop
    errors, [r], _ = run(tmp_path, monkeypatch, script, ARGS)
    assert errors == 0 and r["stop"] == expected
    assert not r["calls"]["auditor"] and not r["calls"]["judge"]
    assert r["judgment"]["category"] == ("classifier_refusal" if stop == "refusal" else None)


def test_auditor_failure_saves_trajectory_and_cost(tmp_path, monkeypatch):
    def script(model, messages):
        if model == "sol-6.1":
            return action(tool("check_inbox", {}))
        return "partial", "max_tokens"
    errors, [r], _ = run(tmp_path, monkeypatch, script, ARGS)
    assert errors == 1 and r["stop"] == "error" and r["judgment"] is None
    assert r["auditor_messages"][0]["reply"]["content"] == "partial"
    assert r["cost"] == pytest.approx(.02)


def test_plain_refusal_needs_no_simulation(tmp_path, monkeypatch):
    def script(model, messages):
        return (json.dumps(VERDICT), "end") if model == "gpt-5.4" else ("I cannot do that.", "end")
    errors, [r], _ = run(tmp_path, monkeypatch, script, ARGS)
    assert errors == 0 and r["judgment"] == VERDICT and not r["calls"]["auditor"]


def test_mode_validation_and_append_compatibility():
    with pytest.raises(SystemExit):
        exp_evals.parse_args(ARGS + ["--escalate"])
    with pytest.raises(SystemExit):
        exp_evals.plan(exp_evals.parse_args(ARGS + ["--max-agentic-turns=0"]))
    with pytest.raises(SystemExit):
        exp_evals.plan(exp_evals.parse_args(ARGS + ["--auditor=unknown"]))
    assert exp_evals.parse_args(ARGS).auditor == "deepseek-v4-pro"
    assert exp_evals.parse_args(ARGS[:-1] + ["--escalate"]).auditor == "opus-5.5"
    [r] = exp_evals.plan(exp_evals.parse_args(ARGS))
    other = copy.deepcopy(r) | {"sample": 1}
    exp_evals.check_addition("test", [r], [other])
    for field, value in [("agentic", False), ("max_agentic_turns", 2), ("tools", []), ("audit_prompt_text", "changed")]:
        with pytest.raises(SystemExit):
            exp_evals.check_addition("test", [r], [other | {field: value}])
    records = exp_evals.plan(exp_evals.parse_args(ARGS + ["--n=2"]))
    assert records[0]["auditor_messages"] is not records[1]["auditor_messages"]


def test_agentic_dry_run_makes_no_calls(tmp_path, monkeypatch):
    monkeypatch.setattr(exp_evals, "OUTPUTS", tmp_path)
    llm = FakeLLM(lambda *_: pytest.fail("dry run called a model"))
    assert asyncio.run(exp_evals.run(exp_evals.parse_args(ARGS + ["--dry-run"]), llm)) == 0
    assert not list(tmp_path.iterdir())


def test_interrupted_auditor_keeps_partial_output_and_unknown_cost():
    [r] = exp_evals.plan(exp_evals.parse_args(ARGS))
    def script(model, messages):
        if model == "sol-6.1":
            return action(tool("check_inbox", {}))
        error = asyncio.CancelledError()
        error.partial = {"text": "From HR:", "reasoning": "partial reasoning"}
        raise error
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(exp_evals.evaluate(FakeLLM(script), r))
    assert r["stop"] == "interrupted" and r["unreported_costs"] == 1
    assert r["auditor_messages"][0]["reply"]["partial"] is True
    assert r["calls"]["auditor"][-1]["reasoning"] == "partial reasoning"
    assert r["messages"][-1]["role"] == "assistant"  # No incomplete result delivered to the model.


def test_agentic_judge_sees_all_reasoning():
    record = {"agentic": True, "model": "sol-6.1", "messages": [
        {"role": "assistant", "content": "a"}, {"role": "assistant", "content": "b"}],
        "calls": {"model": [{"step": "turn 1", "reasoning": "first thought"},
                              {"step": "turn 2", "reasoning": "second thought"}]}}
    text = exp_evals.transcript(record)
    assert "first thought" in text and "second thought" in text


def test_block_after_acting_is_judged_as_cut_off_in_the_middle(tmp_path, monkeypatch):
    def script(model, messages):
        if model == "sol-6.1":
            return action(tool("check_inbox", {})) if len(messages) == 2 else ("", "refusal")
        if model == "deepseek-v4-pro":
            return "No new messages.", "end"
        assert "RUN STOP: cut_off_in_the_middle (a provider's safety filter" in messages[0]["content"]
        return json.dumps(VERDICT | {"category": "full_compliance"}), "end"
    errors, [r], _ = run(tmp_path, monkeypatch, script, ARGS)
    assert errors == 0 and r["stop"] == "cut_off_in_the_middle" and r["classifier_refusal"]
    assert r["judgment"]["category"] == "full_compliance"
    assert viewer.classified(r) is r  # The viewer keeps the judge's verdict.
    assert exp_rejudge.judgeable(r)
    copied = exp_rejudge.copy(r, exp_rejudge.parse_args(["--run=test"]), exp_evals.check_judge_prompt(), "test")
    assert copied["judgment"] is None  # To be judged again, not given classifier_refusal.

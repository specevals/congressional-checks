# General

- Save trajectory data exhaustively, such that we could faithfully resume from any given trajectory later on. This means:
  - Saving all turns, in order
  - For models with hidden reasoning, saving the key that allows us to pass back the reasoning block through the API
  - Saving details about settings, such as the exact model (obviously), temperature, etc

# Specific file definitions

uv run exp_evals.py congressional-checks|abliterated
    --models=x,y,z
    --n=n
    --prompts=all|<prompt>,<prompt>,...
    [--envs=all|<env>,<env>,...]
    [--judge=gpt-5.4]
    [--judge-temperature=default]
    [--system-prompt=none|<name>,<name>,...]
    [--escalate [--auditor=opus-5.5] | --agentic [--auditor=deepseek-v4-pro] [--max-agentic-turns=50]]
    [--add-to=<timestamp>]
    [--dry-run]
--> stores all trajectories + judgments in <experiment>/outputs/<timestamp>-results.jsonl (with --add-to, appends to that run's file)

uv run exp_rejudge.py congressional-checks|abliterated
    --run=<timestamp>
    [--judge=gpt-5.4]
    [--judge-temperature=default]
    [--dry-run]
--> stores a copy of that run's trajectories + new judgments from the current JUDGE.md in <experiment>/outputs/<timestamp>-results.jsonl

## View runs
uv run viewer.py congressional-checks
    [--port=8768]
--> http://localhost:8768

uv run viewer.py abliterated
    [--port=8769]
--> http://localhost:8769

# General

- Save trajectory data exhaustively, such that we could faithfully resume from any given trajectory later on. This means:
  - Saving all turns, in order
  - For models with hidden reasoning, saving the key that allows us to pass back the reasoning block through the API
  - Saving details about settings, such as the exact model (obviously), temperature, etc

# Specific file definitions

uv run exp_evals.py
    --models=x,y,z
    --n=n
    [--envs=all|<env>|<env>/<variant>|<env>/all]
    [--judge=gpt-5.4]
    [--judge-temperature=0]
    [--system-prompt=none]
    [--escalate]
    [--auditor=opus-5.5]
    [--dry-run]
--> stores all trajectories + judgments in /outputs/<timestamp>-results.jsonl

uv run exp_rejudge.py
    --run=<timestamp>
    [--judge=gpt-5.4]
    [--judge-temperature=0]
    [--dry-run]
--> stores a copy of that run's trajectories + new judgments from the current JUDGE.md in /outputs/<timestamp>-results.jsonl

## View runs
uv run viewer.py
    [--port=8768]
--> http://localhost:8768

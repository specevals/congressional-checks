import pytest

import exp_evals


@pytest.fixture(autouse=True)
def congressional_checks(monkeypatch, tmp_path_factory):
    """Tests use the congressional-checks experiment's inputs (and its outputs/, which they replace with a temporary folder).
    Their scenarios are the ones kept in inputs/scenarios/old/, so new scenarios don't change the tests."""
    real = exp_evals.HERE / "congressional-checks" / "inputs"
    inputs = tmp_path_factory.mktemp("inputs")
    for p in real.iterdir():
        (inputs / p.name).symlink_to(real / "scenarios" / "old" if p.name == "scenarios" else p)
    monkeypatch.setattr(exp_evals, "INPUTS", inputs)
    monkeypatch.setattr(exp_evals, "OUTPUTS", exp_evals.HERE / "congressional-checks" / "outputs")

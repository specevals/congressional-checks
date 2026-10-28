import pytest

import exp_evals


@pytest.fixture(autouse=True)
def congressional(monkeypatch):
    """Tests use the congressional experiment's inputs (and its outputs/, which they replace with a temporary folder)."""
    monkeypatch.setattr(exp_evals, "INPUTS", exp_evals.HERE / "congressional" / "inputs")
    monkeypatch.setattr(exp_evals, "OUTPUTS", exp_evals.HERE / "congressional" / "outputs")

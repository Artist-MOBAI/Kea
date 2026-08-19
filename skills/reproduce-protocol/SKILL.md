---
name: reproduce-protocol
description: How to package a finished research result so any reviewer can recompute it with one command. Use when delivering a finding, closing a mobai objective, or building a delivery package — and use it as the standard when judging whether work is "done".
---

# Reproduce protocol

A result is not done when it is achieved; it is done when a stranger can recompute it.

## Delivery package layout

```
solution.json            # claim, falsification criterion, evaluator ref, best/baseline scores
solve.sh                 # single-command reproduction entry (set -euo pipefail)
score.py                 # shared scoring contract: self-eval and official eval MUST NOT diverge
REPRODUCE.md             # human walkthrough
baseline.json            # any-time-valid baseline (best-so-far never regresses)
requirements.lock        # exact environment (pip freeze / conda export)
provenance.json          # dataset versions, git commit, seeds, compute settings
novelty-verification.json # how novelty was checked and against what

> `createDeliveryPackage` writes `requirements.lock` and `provenance.json` as placeholders — fill them before shipping: `requirements.lock` ← `pip freeze`/`conda env export`; `provenance.json` ← dataset version/hash, git commit, seeds, compute settings.
```

## Rules (each exists because someone violated it)

1. **Scoring contract is shared.** The script that produced the number and the script that checks it are the same file. If they can diverge, they will.
2. **Baseline first.** Record the baseline before the improvement so any intermediate state is a legal answer (any-time validity).
3. **Lock everything that could drift:** package versions, dataset version/hash, model checkpoint id, random seeds, hardware class. "It worked on my machine" is not a deliverable.
4. **Negative provenance included.** If a step failed and shaped the approach, say so in REPRODUCE.md; silent success-only histories mislead the next person.
5. **Falsification criterion is mandatory.** The package states what observation would overturn the claim. A claim without one is not a finding.

## Self-check before shipping

- [ ] `./solve.sh` from a clean checkout reproduces the reported numbers within stated variance?
- [ ] Seeds and versions in the package match what was actually run?
- [ ] A reviewer who has never seen this project could run it without asking a question?

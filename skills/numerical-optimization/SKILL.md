---
name: numerical-optimization
description: Discipline for improving a scored solution (model, algorithm, parameters) against a frozen evaluator. Use when iterating on anything measured by METRIC values — training runs, hyperparameter tuning, method improvement — especially before claiming an improvement.
---

# Numerical optimization discipline

## Contract first

1. An evaluator contract must be frozen (`define_evaluator`) before optimizing. If the contract changes mid-run, the search segment restarts and the baseline must be rebuilt — never compare scores across contract versions.
2. Know the metric direction. Improving the wrong direction is the most common silent failure.

## Baseline gate

- Establish the baseline before any change: run the current best across ≥2 seeds.
- Every candidate is compared against that baseline, not against the previous candidate.

## Vary one thing at a time

- Each iteration changes exactly one aspect (a parameter, a term, a setting). Otherwise you cannot attribute the delta.
- Keep a ledger of attempts (`journal_note`): what changed, what the metric did.

## The variance gate

**This is the most important rule in this skill.**
A single-seed improvement is a hypothesis, not a result. Before recording progress:
- run the candidate on ≥2 seeds (3 preferred);
- if the improvement is within the seed-to-seed spread, it is noise — say so and move on.

## Anti reward-hacking checklist (before trusting any score)

- [ ] Ran in a clean environment (no stale caches, no leftover artifacts)?
- [ ] Evaluated on the full eval set, not a subset that happens to look good?
- [ ] The solution does not read the expected answers or exploit the evaluator's parsing?
- [ ] Timing/wall-clock measured honestly (no excluded setup that belongs in the loop)?

## Stop rules

- After K consecutive iterations with no confirmed improvement: change strategy, do not keep perturbing.
- After 3 strategy changes with no confirmed improvement: report the plateau honestly with the evidence. A plateau is a result.

---
name: synthesis-validation
description: Validation discipline for proposed synthesis routes (organic and inorganic). Use before presenting any synthesis plan as actionable, and when judging route quality — a route without grounding is hypothetical, not validated.
---

# Synthesis validation

The Coscientist lesson: ungrounded routes fail in the lab. Every step needs evidence or an honest downgrade.

## Four gates (organic track)

1. **Gate 1 — forward replay (machine).** `validate_reactions`: each reaction SMARTS is replayed with RDKit; products must form and atom counts must balance. A failing gate is final — fix the route, not the verdict.
2. **Gate 2 — availability.** Every precursor must be purchasable or already in stock; name the supplier/catalog where known.
3. **Gate 3 — literature grounding.** Each step cites precedent: template id, patent/DOI, or ORD reaction id. At least one evidence field per step.
4. **Gate 4 — conditions rationale.** Temperature/solvent/catalyst choices justified against precedent, not invented freely.

## Inorganic track (NOT organic retrosynthesis)

For solid-state/materials synthesis, judge by:
- **Thermodynamic feasibility:** reaction energy relative to the convex hull; competing phases named.
- **Precedent:** analogous compositions reported under similar conditions (cite the paper/DOI).
- **Practical path:** precursor availability, atmosphere/calcination steps, known side reactions.
Use LLM ranking to order candidate routes, but the verdict rests on the criteria above.

## Verdicts

- `validated` — all applicable gates pass with evidence.
- `hypothetical` — plausible but missing grounding; say exactly what is missing.
- `invalid` — a machine gate failed or evidence contradicts the route.

Never present `hypothetical` as `validated`. When unsure, the downgrade is the answer.

## Metric convention

Report route quality with multi-answer metrics (URSA-style): solvable rate across reference routes and step-validity rate. Single-answer exact-match scoring unfairly penalizes legitimate alternatives.

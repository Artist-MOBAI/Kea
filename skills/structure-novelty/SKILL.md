---
name: structure-novelty
description: How to judge whether a material/structure-property claim is genuinely novel. Use before logging any novelty or discovery claim, and when interpreting check_novelty results.
---

# Structure novelty discipline

The GNoME lesson: most "new" materials are already-known phases. Absence of evidence is not novelty.

## Decision path

1. **Query known databases first** (`query_material`): structure match by formula/elements, then property comparison.
2. **Classify with `check_novelty`** — five outcomes, treat them exactly:
   - `known` — property within tolerance of records. Report as confirmation, not discovery.
   - `refines` — known structure, new property measurement. Valuable; frame as refinement.
   - `contradicts` — values disagree beyond tolerance with records. This is interesting: verify your own pipeline before challenging the literature, then report the conflict with both sides cited.
   - `novel_candidate` — no matching records. **A candidate only.** It becomes a claim only after the post-gate.
   - `unverified` — data sources were unreachable. Never report this as novel; retry or say unverified.
3. **Post-gate for novel_candidate (mandatory, both parts):**
   - *Structure match:* strict match against the databases checked (record which databases, which query, which date).
   - *Independent calculation:* the key property recomputed by a different method/checkpoint (e.g., a second MLIP or DFT) agreeing within stated tolerance.
4. **Relation to prior work.** Every claim records `relation_to_prior`: consistent / refines / contradicts. A claim without this field is incomplete.
5. **Mechanism obligation.** Black-box correlation (model says so) caps the claim at `correlative`. A verified claim needs a mechanism account — electronic structure, bonding, symmetry — or an explicit statement that none is known yet.

## Rules

- Novelty is judged against databases AND literature; one without the other is half a check.
- Source failure → `unverified`, never `novel`.
- Log the verdict with method and compared-against records (`journal_note`) so the check itself is reproducible.

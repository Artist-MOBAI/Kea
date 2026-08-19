---
name: systematic-literature-review
description: How to run a literature survey that produces grounded claims and research gaps. Use when starting a research thread, when the user asks to "survey" or "review the literature", and before claiming novelty.
---

# Systematic literature review

## Workflow

1. **Scope.** Write the review question in one sentence before searching (what population of results would answer it).
2. **Search in parallel.** Fan out `spawn_swarm` over query variants (synonyms, related methods, adjacent fields) with `search_literature`; one subagent per query family.
3. **Extract claims, not summaries.** For each relevant paper: factual claims with DOI + verbatim quote when available (see the claim-extraction rules). No DOI → note, not claim.
4. **Verify citations.** Spot-check that quotes actually support the claims (`verify_claim` on the load-bearing ones). A citation that does not entail the claim is dropped.
5. **Map the field.** Group claims into positions; mark where they agree, disagree, or simply don't overlap.
6. **Find the gap.** A research gap is a tension: positions that contradict, a question no position answers, or a formalizable opportunity. Log it with `log_research_gap` including the tension and citations.

## Rules

- Coverage beats depth on the first pass; depth comes after the map exists.
- Record search queries and result counts in the journal — a survey must be repeatable.
- Disagreements between sources are findings, not noise. Keep both sides with citations.
- `formalizable=true` gaps should name their suggested evaluator; that is what makes them actionable.

## Anti-patterns

- Summarizing papers without extracting falsifiable claims (a summary cannot be verified).
- Citing from memory — every citation must resolve to a DOI you actually retrieved.
- Declaring "no prior work" because one query returned nothing; absence of search is not absence of work.

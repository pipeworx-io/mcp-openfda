# OpenFDA — FDA Drug, Device, and Food Data

The U.S. Food and Drug Administration's open data platform. Adverse event reports (FAERS), drug approvals, drug labels, recalls, device reports, food recalls, tobacco enforcement. The official source for what's been reported to or by the FDA. Free, no auth required (rate-limited).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Why this matters for AI agents

Drug-safety questions resolve here. Adverse event volumes, label changes, approval timelines, recall posture — all structured. For the full drug picture, pair with [RxNorm](/docs/reference/rxnorm) (canonical IDs) and [ClinicalTrials.gov](/docs/reference/clinicaltrials) (trials).

Common flows:

- **Adverse events for a drug.** "Reports for Ozempic" → `fda_drug_events({query: "ozempic"})` → individual safety reports + counts.
- **Bucket reactions.** "Top reactions reported for Ozempic" → `fda_event_counts({query: "ozempic", count_field: "patient.reaction.reactionmeddrapt.exact"})` → MedDRA-coded counts.
- **Approval history.** "When was Ozempic approved and for what?" → `fda_drug_approvals({query: "ozempic"})`.
- **Recalls.** "Any Ozempic recalls?" → `fda_drug_recalls({query: "ozempic"})`.
- **Label content.** "What does the FDA label say about contraindications?" → `fda_drug_labels({query: "ozempic"})`.

Used by the `pharma_drug_profile` and `pharma_safety_report` compounds.

## Auth

Public, no key required. Anonymous limit is ~240 requests/min and 1,000/day, counted **per IP** — so every caller sharing an egress address shares one 1,000/day budget, not one each.

api.fda.gov runs on api-umbrella, the same stack as api.data.gov, so an api.data.gov key authenticates it and lifts the daily limit to 120,000. Pipeworx injects a platform key (`PLATFORM_DATAGOV_KEY`); bring your own with `_apiKey` and your calls draw on your quota instead. Register free at https://open.fda.gov/apis/authentication/.

A key that is rejected or revoked does not fail the call — the pack retries once anonymously, since openFDA is fully usable without one.

## Datasets

| Dataset | Endpoint family | Coverage |
|---|---|---|
| Drug adverse events (FAERS) | `fda_drug_events` | 1968-present, ~20M+ reports |
| Drug approvals | `fda_drug_approvals` | 1939-present (NDA/BLA/ANDA) |
| Drug labels | `fda_drug_labels` | Current SPL labels |
| Drug recalls | `fda_drug_recalls` | Class I/II/III enforcement actions |
| Device adverse events | (separate tools) | MAUDE database |
| Food recalls | (separate tools) | FSIS + FDA recalls |

## Common pitfalls

- **Reports are not unique patients.** A single hospitalization can produce multiple FAERS reports. The `total` field is reports, not adverse-event-suffering-individuals.
- **Causality not implied.** A FAERS report links a drug to an event temporally; it does not prove the drug CAUSED the event. Use language carefully.
- **Brand vs generic naming.** Searching "ozempic" finds Ozempic-tagged reports. Searching "semaglutide" finds reports for any semaglutide product. They can differ — the user's intent determines which to search.
- **Query syntax is FDA's, not ours.** OpenFDA uses Lucene-style search with field-specific queries. Pipeworx tool descriptions show the syntax. Quotation marks matter.
- **Reaction names use MedDRA word order.** Natural phrasing can differ from the preferred term stored by FDA — `ISCHAEMIC OPTIC NEUROPATHY` is filed as `OPTIC ISCHAEMIC NEUROPATHY`. Reaction-filtered tools retry two- and three-word phrases in alternate word orders and disclose the resolved term in `reaction_resolved`.
- **Reaction filters match one whole preferred term.** They are not substring or token matches, so `NEUROPATHY` returns only reports filed under that exact term (~1,700) rather than every term containing the word (~117,000). This is deliberate: a disproportionality table needs one case definition, not an ad-hoc grouping. To find the terms FDA actually stores, count on `patient.reaction.reactionmeddrapt.exact`.
- **An unmatched term is reported, not silently zeroed.** When no word order matches, tools return `reaction_resolution: "not_a_meddra_preferred_term"` with a hint. Treat that as "the filter missed," never as "no reports exist."
- **Lag from event to report.** FAERS reports lag the event by months — sometimes years. The "last 30 days" view is misleading; recent counts will keep growing as reports flow in.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "openfda": {
      "url": "https://gateway.pipeworx.io/openfda/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/openfda/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Openfda data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

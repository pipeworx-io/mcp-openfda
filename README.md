# OpenFDA — FDA Drug, Device, and Food Data

The U.S. Food and Drug Administration's open data platform. Adverse event reports (FAERS), drug approvals, drug labels, recalls, device reports, food recalls, tobacco enforcement. The official source for what's been reported to or by the FDA. Free, no auth required (rate-limited).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Public, no key required. Anonymous IP-based limit: ~240 requests/min, 1,000/day. With a free key from https://open.fda.gov/apis/authentication/, the daily limit lifts to 120,000. Pass via `_apiKey`.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Openfda data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

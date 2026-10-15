# OpenFDA — FDA Drug, Device, and Food Data

The U.S. Food and Drug Administration's open data platform. This pack covers the drug side: adverse-event reports and safety-signal tools (FAERS search, event counts, disproportionality/ROR-PRR, reaction profiles, trends), drug and novel-drug approvals (Drugs@FDA, by-company application history), drug labels, drug and food recalls, drug shortages and shortage changes, complete response letters, warning letters, and a cross-source postmarket risk-profile compound. The official source for what's been reported to or by the FDA. Free, no auth required (rate-limited).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1807+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Why this matters for AI agents

Drug-safety questions resolve here. Adverse event volumes, label changes, approval timelines, recall posture — all structured. For the full drug picture, pair with [RxNorm](/docs/reference/rxnorm) (canonical IDs) and [ClinicalTrials.gov](/docs/reference/clinicaltrials) (trials).

Common flows:

- **Adverse events for a drug.** "Reports for Ozempic" → `fda_drug_events({query: "ozempic"})` → individual safety reports + counts.
- **Bucket reactions.** "Top reactions reported for Ozempic" → `fda_event_counts({query: "ozempic", count_field: "patient.reaction.reactionmeddrapt.exact"})` → MedDRA-coded counts.
- **Approval history.** "When was Ozempic approved and for what?" → `fda_drug_approvals({query: "ozempic"})`.
- **Recalls.** "Any Ozempic recalls?" → `fda_drug_recalls({query: "ozempic"})`.
- **Label content.** "What does the FDA label say about contraindications?" → `fda_drug_labels({query: "ozempic"})`.
- **All applications for a company.** "Every Drugs@FDA application Eli Lilly has filed" → `fda_applications_by_cik({cik_or_ticker: "LLY"})`. Resolves the company via SEC and aggregates across every `sponsor_name` spelling it filed under — see the pitfall below before reaching for `fda_drug_approvals` with a guessed sponsor name.

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
| Warning letters | `fda_warning_letters` | 3,680 published letters from 2021-01 on, fda.gov (not api.fda.gov), plus FDA's compliance-actions archive back to 2010 for firms with nothing in that window |

## Common pitfalls

- **Reports are not unique patients.** A single hospitalization can produce multiple FAERS reports. The `total` field is reports, not adverse-event-suffering-individuals.
- **Causality not implied.** A FAERS report links a drug to an event temporally; it does not prove the drug CAUSED the event. Use language carefully.
- **Brand vs generic naming.** Searching "ozempic" finds Ozempic-tagged reports. Searching "semaglutide" finds reports for any semaglutide product. They can differ — the user's intent determines which to search.
- **Query syntax is FDA's, not ours.** OpenFDA uses Lucene-style search with field-specific queries. Pipeworx tool descriptions show the syntax. Quotation marks matter.
- **Reaction names use MedDRA word order.** Natural phrasing can differ from the preferred term stored by FDA — `ISCHAEMIC OPTIC NEUROPATHY` is filed as `OPTIC ISCHAEMIC NEUROPATHY`. Reaction-filtered tools retry two- and three-word phrases in alternate word orders and disclose the resolved term in `reaction_resolved`.
- **Reaction filters match one whole preferred term.** They are not substring or token matches, so `NEUROPATHY` returns only reports filed under that exact term (~1,700) rather than every term containing the word (~117,000). This is deliberate: a disproportionality table needs one case definition, not an ad-hoc grouping. To find the terms FDA actually stores, count on `patient.reaction.reactionmeddrapt.exact`.
- **An unmatched term is reported, not silently zeroed.** When no word order matches, tools return `reaction_resolution: "not_a_meddra_preferred_term"` with a hint. Treat that as "the filter missed," never as "no reports exist."
- **Warning-letter search matches the RECIPIENT by default.** `fda_warning_letters` sits on fda.gov's solr index, which covers each letter's full body as well as the company column — so a raw full-text query answers "letters that mention X", not "letters issued to X". Those are very different claims about a named firm, and the difference was live: `search: "Merck"` returned exactly one letter, addressed to **Elanco Animal Health**, which merely names Merck in its text. `search` now filters on the addressed company, every row carries `matched_field` (`company` vs `letter_text`), and `match: "fulltext"` is the opt-in for body search. A recipient search with no hits returns `found: false` with the full-text count, so "no letters" is never confused with "we did not look".
- **The published warning-letter list is a ROLLING FIVE-YEAR WINDOW, and that used to read as "this company is clean".** fda.gov's view holds 3,680 letters from 2021-01-05 to today, every center included — CDER, CFSAN, CTP, CVM and Human Foods are all present, so nothing is excluded by subject, only by AGE. Hospira's real 2017-02-14 CGMP letter returned `candidates_scanned: 0` and a confident "no warning letter matches \"Hospira\" at all" (fleet #2123). When a recipient search finds nothing in that window, the tool now consults FDA's Data Dashboard compliance-actions archive, which records the same enforcement events back to at least 2010. Those rows carry firm, place, product type and the issue date but **no subject line and no letter URL** — FDA does not republish the text of letters this old — so every row and the response itself carry `source`, and archive rows are never blended into the published ones. On the success path the response still says `archive_note`, because a firm with one 2024 letter and ten from 2015 legitimately counts 1 here. On the miss path it says `archive_checked`, so "we looked in both and found nothing" is distinguishable from "the archive was unreachable".
- **Warning-letter counts over broad terms are a floor.** Recipient matching pages the full-text superset up to 600 candidates. Past that the response sets `scan_complete: false` and a `scope_note`, and `total_matching` is a lower bound — narrow the term for an exact count.
- **Lag from event to report.** FAERS reports lag the event by months — sometimes years. The "last 30 days" view is misleading; recent counts will keep growing as reports flow in.
- **`sponsor_name` has no company-ID and is EXACT-match, not full-text.** `fda_drug_approvals` queries like `search=sponsor_name:"ELI LILLY AND COMPANY"` match only that literal string — Eli Lilly's real applications are split across "LILLY" (116), "ELI LILLY AND CO" (22), "ELI LILLY CO" (4), and "LILLY RES LABS" (1), and the SEC-registered name matches none of them. Use `fda_applications_by_cik` (CIK/ticker in, every sponsor_name form aggregated out) instead of guessing spellings.

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

Both URLs reach the same gateway and the same 1807+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/fda_drug_events \
  -H 'Content-Type: application/json' \
  -d '{"query":"patient.drug.medicinalproduct:\"OZEMPIC\""}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/fda_drug_events`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "openfda": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-openfda"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-openfda
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

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

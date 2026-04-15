interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * OpenFDA MCP — wraps the openFDA API (free, no auth required)
 *
 * Tools:
 * - fda_drug_events: search drug adverse event reports (FAERS)
 * - fda_drug_approvals: search approved drugs (drugsfda)
 * - fda_drug_labels: search drug labeling/SPL
 * - fda_drug_recalls: search drug recalls and enforcement actions
 * - fda_event_counts: count adverse events by field (signal detection)
 */


const BASE = 'https://api.fda.gov';

/* ── Tool definitions ──────────────────────────────────────────────── */

const tools: McpToolExport['tools'] = [
  {
    name: 'fda_drug_events',
    description:
      'Search FDA Adverse Event Reporting System (FAERS) for drug adverse event reports. Supports OpenFDA search syntax for filtering by drug name, reaction, seriousness, date range, and more.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'OpenFDA search query. Examples: \'patient.drug.openfda.brand_name:"OZEMPIC"\', \'patient.drug.openfda.generic_name:"semaglutide"+AND+serious:1\', \'receivedate:[20240101+TO+20241231]\'',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1-100, default 10)',
        },
        skip: {
          type: 'number',
          description: 'Offset for pagination (default 0)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fda_drug_approvals',
    description:
      'Search FDA drug approval records (Drugs@FDA). Find approved drugs by brand name, generic name, application number, or sponsor.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'OpenFDA search query. Examples: \'openfda.brand_name:"KEYTRUDA"\', \'products.active_ingredients.name:"pembrolizumab"\', \'submissions.submission_type:"ORIG"\'',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1-100, default 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fda_drug_labels',
    description:
      'Search FDA drug labeling (Structured Product Labeling). Returns drug label sections including indications, warnings, dosage, and contraindications.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'OpenFDA search query. Examples: \'openfda.brand_name:"HUMIRA"\', \'openfda.generic_name:"adalimumab"\'',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1-100, default 5)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fda_drug_recalls',
    description:
      'Search FDA drug recall and enforcement actions. Find recalls by drug name, classification level, or reason.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'OpenFDA search query. Examples: \'openfda.brand_name:"VALSARTAN"\', \'classification:"Class I"\', \'reason_for_recall:"contamination"\'',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1-100, default 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fda_event_counts',
    description:
      'Count adverse events grouped by a specific field. Powerful for signal detection — e.g., find the top adverse reactions for a drug, or see event timelines.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'OpenFDA search query to filter events before counting. Same syntax as fda_drug_events.',
        },
        count_field: {
          type: 'string',
          description:
            'Field to count/aggregate by. Examples: "patient.reaction.reactionmeddrapt.exact" (top reactions), "receivedate" (timeline), "serious" (severity breakdown), "patient.drug.openfda.brand_name.exact" (co-reported drugs)',
        },
      },
      required: ['query', 'count_field'],
    },
  },
];

/* ── Types ─────────────────────────────────────────────────────────── */

type FdaResponse = {
  meta?: {
    disclaimer?: string;
    terms?: string;
    license?: string;
    last_updated?: string;
    results?: { skip?: number; limit?: number; total?: number };
  };
  results?: unknown[];
  error?: { code?: string; message?: string };
};

type CountResult = {
  term: string;
  count: number;
}[];

/* ── Helpers ───────────────────────────────────────────────────────── */

async function fdaFetch(endpoint: string, params: string): Promise<FdaResponse> {
  const url = `${BASE}${endpoint}?${params}`;
  const res = await fetch(url);

  if (!res.ok) {
    if (res.status === 404) {
      return { results: [], meta: { results: { total: 0, skip: 0, limit: 0 } } };
    }
    const body = await res.text();
    let msg = `OpenFDA API error: ${res.status}`;
    try {
      const err = JSON.parse(body) as FdaResponse;
      if (err.error?.message) msg = `OpenFDA API error: ${err.error.message}`;
    } catch {
      // use default message
    }
    throw new Error(msg);
  }

  return (await res.json()) as FdaResponse;
}

/**
 * Encode query for OpenFDA — preserves brackets, colons, quotes, and plus signs
 * that OpenFDA uses in its search syntax. Only encodes spaces and other unsafe chars.
 */
function encodeQuery(query: string): string {
  return query.replace(/ /g, '+');
}

/* ── Tool implementations ──────────────────────────────────────────── */

async function fdaDrugEvents(query: string, limit?: number, skip?: number) {
  const l = Math.min(100, Math.max(1, limit ?? 10));
  const s = Math.max(0, skip ?? 0);
  const params = `search=${encodeQuery(query)}&limit=${l}&skip=${s}`;
  const data = await fdaFetch('/drug/event.json', params);

  return {
    total: data.meta?.results?.total ?? 0,
    skip: data.meta?.results?.skip ?? 0,
    limit: data.meta?.results?.limit ?? l,
    results: data.results ?? [],
  };
}

async function fdaDrugApprovals(query: string, limit?: number) {
  const l = Math.min(100, Math.max(1, limit ?? 10));
  const params = `search=${encodeQuery(query)}&limit=${l}`;
  const data = await fdaFetch('/drug/drugsfda.json', params);

  return {
    total: data.meta?.results?.total ?? 0,
    results: data.results ?? [],
  };
}

async function fdaDrugLabels(query: string, limit?: number) {
  const l = Math.min(100, Math.max(1, limit ?? 5));
  const params = `search=${encodeQuery(query)}&limit=${l}`;
  const data = await fdaFetch('/drug/label.json', params);

  return {
    total: data.meta?.results?.total ?? 0,
    results: data.results ?? [],
  };
}

async function fdaDrugRecalls(query: string, limit?: number) {
  const l = Math.min(100, Math.max(1, limit ?? 10));
  const params = `search=${encodeQuery(query)}&limit=${l}`;
  const data = await fdaFetch('/drug/enforcement.json', params);

  return {
    total: data.meta?.results?.total ?? 0,
    results: data.results ?? [],
  };
}

async function fdaEventCounts(query: string, countField: string) {
  const params = `search=${encodeQuery(query)}&count=${encodeURIComponent(countField)}`;
  const data = await fdaFetch('/drug/event.json', params);

  return {
    query,
    count_field: countField,
    results: (data.results ?? []) as CountResult,
  };
}

/* ── callTool dispatcher ───────────────────────────────────────────── */

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'fda_drug_events':
      return fdaDrugEvents(
        args.query as string,
        args.limit as number | undefined,
        args.skip as number | undefined,
      );
    case 'fda_drug_approvals':
      return fdaDrugApprovals(
        args.query as string,
        args.limit as number | undefined,
      );
    case 'fda_drug_labels':
      return fdaDrugLabels(
        args.query as string,
        args.limit as number | undefined,
      );
    case 'fda_drug_recalls':
      return fdaDrugRecalls(
        args.query as string,
        args.limit as number | undefined,
      );
    case 'fda_event_counts':
      return fdaEventCounts(
        args.query as string,
        args.count_field as string,
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;

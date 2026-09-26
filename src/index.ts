interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


// Reusable entity-resolution helpers for MCP packs. SELF-CONTAINED — no internal
// imports — so publish-pack.sh can inline it into standalone pack builds the same
// way it inlines the McpToolExport type.
//
// Recurring failure mode across financial packs: callers pass a company NAME
// ("Apple", "apple inc") where a ticker / CIK / provider symbol is expected, and
// the pack 404s or throws "not found". `rankMatches` is a generic name-ranker any
// pack can run over its OWN list (US tickers, B3 tickers, drug names, airports…);
// `resolveSecEntity` wraps it around the SEC company_tickers.json universe, shared
// by the packs that key on CIK (edgar, sec).

type MatchKind = 'exact' | 'prefix' | 'word' | 'substring';

interface RankedMatch<T> {
  item: T;
  kind: MatchKind;
  score: number;
}

const normalize = (s: string): string =>
  s.toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Rank `items` by how well their name matches `query`:
 * exact (4) > prefix (3) > whole-word (2) > substring (1). Ties break by shortest
 * name — the primary entity (e.g. "Apple Inc." over "Apple Hospitality REIT").
 * Returns only items that match at all, best first. Pure (no I/O).
 */
function rankMatches<T>(
  query: string,
  items: T[],
  getName: (item: T) => string,
): RankedMatch<T>[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: { item: T; kind: MatchKind; score: number; len: number }[] = [];
  for (const item of items) {
    const name = getName(item);
    const n = normalize(name);
    let kind: MatchKind | null = null;
    let score = 0;
    if (n === q) { kind = 'exact'; score = 4; }
    else if (n.startsWith(q)) { kind = 'prefix'; score = 3; }
    else if (n.includes(` ${q} `) || n.endsWith(` ${q}`)) { kind = 'word'; score = 2; }
    else if (n.includes(q)) { kind = 'substring'; score = 1; }
    if (kind) scored.push({ item, kind, score, len: name.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return scored.map(({ item, kind, score }) => ({ item, kind, score }));
}

interface SecTickerRow { cik_str: number; ticker: string; title: string }

interface SecEntity {
  ticker: string;
  cik: string;
  cik_padded: string;
  company_name: string;
  matched_by: 'ticker' | 'company_name';
  alternatives?: { ticker: string; company_name: string; cik: string }[];
}

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/**
 * Resolve a ticker OR company name to its SEC identity (CIK + canonical name).
 * Exact ticker first (the common, unambiguous case), then fuzzy company-name
 * fallback so "Apple" / "APPLE" → AAPL's CIK. Throws if nothing matches.
 *
 * `headers` lets callers pass their pack's SEC User-Agent — www.sec.gov requires
 * a UA. `fetchImpl` defaults to global fetch (override in tests).
 */
async function resolveSecEntity(
  query: string,
  opts: { fetchImpl?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<SecEntity> {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('Required argument is missing or empty. Pass a ticker like "AAPL" or a company name like "Apple".');
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(SEC_TICKERS_URL, { headers: opts.headers });
  if (!res.ok) throw new Error(`SEC ticker lookup error: ${res.status}`);
  const data = (await res.json()) as Record<string, SecTickerRow>;
  const rows = Object.values(data);

  // 1) Exact ticker match — the common, unambiguous case.
  const q = query.toUpperCase().trim();
  for (const r of rows) {
    if (r.ticker === q) return toEntity(r, 'ticker');
  }

  // 2) Company-name fallback.
  const ranked = rankMatches(query, rows, (r) => r.title);
  if (ranked.length) {
    const best = toEntity(ranked[0].item, 'company_name');
    const alts = ranked.slice(1, 4).map((m) => ({
      ticker: m.item.ticker,
      company_name: m.item.title,
      cik: String(m.item.cik_str),
    }));
    if (alts.length) best.alternatives = alts;
    return best;
  }

  throw new Error(`No SEC company matches "${query}". Pass a US-listed ticker ("AAPL") or the exact listed-company name ("Apple Inc."). If this is a clinical-trial sponsor, an operating subsidiary (e.g. "Merck Sharp & Dohme" → Merck & Co), or a foreign/private entity, call sponsor_to_filer({sponsor}) instead — it resolves subsidiaries to the listed parent and honestly reports when no US-listed filer exists.`);
}

function toEntity(r: SecTickerRow, matched_by: 'ticker' | 'company_name'): SecEntity {
  return {
    ticker: r.ticker,
    cik: String(r.cik_str),
    cik_padded: String(r.cik_str).padStart(10, '0'),
    company_name: r.title,
    matched_by,
  };
}

const GENERIC_CORP_WORDS = new Set([
  'THE', 'A', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED',
  'LLC', 'LP', 'PLC', 'SA', 'AG', 'NV', 'GMBH', 'AB', 'AS', 'OY', 'SPA',
  'GROUP', 'HOLDINGS', 'HOLDING', 'AND', 'OF', 'US', 'USA', 'INTERNATIONAL',
  'GLOBAL',
]);

/**
 * Split a corporate/organization name into its SIGNIFICANT tokens — words
 * that aren't generic corporate boilerplate (Inc, Co, Ltd, Group, ...) or
 * punctuation — sorted LONGEST FIRST. Built for cross-registry name joins
 * where the two registries anchor on different words of the same name: SEC
 * lists Eli Lilly as "ELI LILLY & Co", but Drugs@FDA's sponsor_name field
 * uses "LILLY" — the longer, more distinctive token, not the first one
 * ("ELI" alone is short and matches too loosely). Pure (no I/O); callers
 * typically try tokens in order until one call to their OWN registry
 * returns a result.
 */
function significantNameTokens(name: string): string[] {
  const tokens = name
    .toUpperCase()
    .replace(/[.,&/()-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !GENERIC_CORP_WORDS.has(t));
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}
/**
 * FDA drug data via openFDA: adverse-event reports and safety-signal tools (FAERS search, event counts, disproportionality/ROR-PRR summaries, reaction profiles, trends), drug and novel-drug approvals (Drugs@FDA, by-company application history), drug labeling, drug and food recalls, drug shortages and shortage changes, complete response letters, warning letters, and a postmarket risk-profile compound.
 *
 * Tools:
 * - fda_drug_events: search drug adverse event reports (FAERS)
 * - fda_event_counts: count adverse events by field (signal detection)
 * - fda_faers_signal_summary: FAERS disproportionality (ROR/PRR) for a drug/reaction pair
 * - fda_faers_reaction_profile: top co-reported reactions + serious/non-serious counts for a drug
 * - fda_faers_trend: monthly FAERS report-count trend for a drug/reaction
 * - fda_drug_approvals: search approved drugs (drugsfda)
 * - fda_applications_by_cik: all Drugs@FDA applications for a company, resolved via SEC
 * - fda_novel_approvals: novel drug approvals
 * - fda_application_history: one NDA/ANDA/BLA application's submission-action history
 * - fda_drug_labels: search drug labeling/SPL
 * - fda_drug_recalls: search drug recalls and enforcement actions
 * - fda_food_recalls: search FDA food recall/enforcement reports
 * - fda_drug_shortages: search current and resolved drug shortages
 * - fda_shortage_changes: recently changed shortage records
 * - fda_complete_response_letters: search FDA non-approval letters
 * - fda_crl_detail: retrieve one complete response letter
 * - fda_warning_letters: search FDA enforcement warning letters by recipient or full text
 * - fda_postmarket_risk_profile: combine FAERS, label warnings, and recalls for one drug
 */


// SEC requires a descriptive User-Agent on every request (data.sec.gov, same
// as edgar/sec packs) — used only by fda_applications_by_cik's CIK/name
// resolution step, which is the one place this pack talks to SEC instead of
// openFDA.
const SEC_HEADERS: Record<string, string> = { 'User-Agent': 'Pipeworx/1.0 (support@pipeworx.io)', Accept: 'application/json' };

// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Openfda');
}


const BASE = 'https://api.fda.gov';

/* ── Tool definitions ──────────────────────────────────────────────── */

const tools: McpToolExport['tools'] = [
  {
    name: 'fda_drug_events',
    description:
      'Search FAERS adverse event reports by drug name, MedDRA reaction term, or date range. Returns report counts, reaction types, seriousness levels, and dates. Natural multi-word reaction phrasing is retried against MedDRA preferred-term word order before an empty result is reported. FAERS reports do not establish incidence or causality.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'OpenFDA search query. Filter drugs on patient.drug.medicinalproduct — the report\'s own drug-name field, present on every record and matching brand or generic. The patient.drug.openfda.* fields are enrichment that is missing for many newer drugs (semaglutide/OZEMPIC among them) and silently match nothing; this tool retries them against medicinalproduct, but naming it directly costs one call instead of two. Examples: \'patient.drug.medicinalproduct:"OZEMPIC"\', \'patient.drug.medicinalproduct:"semaglutide"+AND+serious:1\', \'receivedate:[20240101+TO+20241231]\'',
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
      'Find FDA-approved drugs by brand name, active ingredient, or application number. To find generic versions of a drug, search by active ingredient using products.active_ingredients.name (NOT openfda.generic_name — that field only works in the label endpoint). IMPORTANT: drug names in the FDA database are stored in UPPERCASE — always pass ingredient and brand names in uppercase (e.g. "APIXABAN" not "apixaban") or you will get 0 results. Returns approval status, sponsor, application number (ANDA = generic, NDA = brand), and application details. There is NO queryable "application_type" field — never add application_type:"ANDA" (it returns 0 results). To limit to generics, search by active ingredient and read the ANDA/NDA prefix on application_number in the results. This endpoint has NO indication/disease field — for "drugs approved to treat <condition>" use fda_drug_labels (which searches indications_and_usage); an indication phrase passed here is silently ignored and matches by drug name only. The response `total` can exceed the 100-row cap on a single page — use `skip` to page past it, and `sort` to get genuinely-newest-first ordering ("most recently approved" is not the default order).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'OpenFDA drugsfda search query. Drug names MUST be UPPERCASE in quotes. To find all generics for a drug: \'products.active_ingredients.name:"APIXABAN"\' (returns all ANDA + NDA approvals). By brand: \'openfda.brand_name:"KEYTRUDA"\'. By original submission: \'submissions.submission_type:"ORIG"\'. Do NOT use application_type (no such field — returns 0); ANDA vs NDA is read from the application_number prefix in the results, not filtered in the query. NOTE: use products.active_ingredients.name (not openfda.generic_name which is a label-API field and returns 0 here).',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1-100, default 10)',
        },
        skip: {
          type: 'number',
          description:
            'Offset for pagination (default 0). The reported `total` is often larger than one page — pass skip=100 to reach the 101st+ result of a large query instead of assuming the first page is everything.',
        },
        sort: {
          type: 'string',
          enum: ['approval_date_asc', 'approval_date_desc'],
          description:
            'Order results by each drug\'s original FDA approval date instead of openFDA\'s default (unordered/relevance) order. approval_date_desc puts the genuinely most-recently-approved drug first — needed for "most recent approval" questions, which are wrong without it. Computed client-side from each record\'s own ORIG+approved submission (openFDA\'s native sort on this field is unreliable — it reads any submission in a drug\'s history, so an old drug with a recent label supplement can outrank a real new approval). Sorting is exact over up to 1000 matching records per call; a `sort_note` in the response says if the query matched more than that.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fda_applications_by_cik',
    description:
      'Find ALL Drugs@FDA applications for a company by SEC CIK, ticker, or company name — without needing to know its FDA sponsor_name spelling. Drugs@FDA has no company-ID field: sponsor_name is free text, and one company routinely files under several forms (e.g. Eli Lilly appears as "LILLY", "ELI LILLY AND CO", "ELI LILLY CO", "LILLY RES LABS" — its own SEC-registered name "ELI LILLY AND COMPANY" matches ZERO of them in fda_drug_approvals). This resolves the company via SEC (same identity as the edgar pack), derives its most distinctive name token, and searches Drugs@FDA for every sponsor_name variant containing it in one call — returning the combined application list plus a `sponsor_name_forms` breakdown showing exactly which spellings were found. Use this INSTEAD of guessing sponsor_name strings for fda_drug_approvals when you have (or can resolve) the company\'s CIK/ticker. For a subsidiary or operating name that isn\'t itself SEC-listed, resolve to the parent first with edgar\'s sponsor_to_filer, then pass that CIK here.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cik_or_ticker: {
          type: 'string',
          description: 'SEC CIK (e.g. "59478"), stock ticker (e.g. "LLY"), or exact SEC-listed company name (e.g. "Eli Lilly and Co").',
        },
        limit: { type: 'number', description: 'Max applications to return (1-200, default 100).' },
      },
      required: ['cik_or_ticker'],
    },
  },
  {
    name: 'fda_novel_approvals',
    description:
      'Most recent novel drug approvals — the newest drugs approved by the FDA. Use for "what is the most recent novel drug the FDA approved", "latest FDA drug approvals", "recently approved new drugs or biologics this month/year". Returns original NDA/BLA approvals (generics excluded by default) sorted newest-first, with approval date, brand name, active ingredients, sponsor, and application number. Not for label text (fda_drug_labels) or searching a specific known drug (fda_drug_approvals).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        days: {
          type: 'number',
          description: 'Look-back window in days (1-365, default 90)',
        },
        limit: {
          type: 'number',
          description: 'Max approvals to return (1-50, default 10)',
        },
        include_generics: {
          type: 'boolean',
          description: 'Also include original ANDA (generic) approvals (default false — novel means NDA/BLA only)',
        },
        skip: {
          type: 'number',
          description:
            'Offset into the newest-first results (default 0). total_in_window can exceed the 50-result cap on one call — pass skip=50 to page further into the window instead of assuming the window is fully covered.',
        },
      },
      required: [],
    },
  },
  {
    name: 'fda_drug_labels',
    description:
      'Get FDA drug labeling (SPL) by drug name OR by INDICATION. This is the tool for "what drugs are approved to treat <condition>" — it searches the indications_and_usage text, which the drugsfda approvals endpoint does NOT carry. Query by brand/generic name (openfda.brand_name:"HUMIRA"), or by indicated use (indications_and_usage:"rheumatoid arthritis"). Returns indications, boxed/other warnings, dosage, contraindications, and adverse reactions (each text field capped, set_id preserved for out-of-band full-label fetch). Note: FDA label publication trails approval by weeks, so a just-approved drug may not have a label yet.',
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
        skip: {
          type: 'number',
          description: 'Pagination offset (default 0) — the reported total can exceed one page of 100.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fda_drug_recalls',
    description:
      'Search FDA drug recalls and enforcement actions by drug name or reason — returns recall classification, date, reason and enforcement status. A multi-word search is tried as ALL terms first and falls back to ANY term when nothing matches all of them; the response says which happened in match_mode, so a loose match is never mistaken for a precise one. Recall reasons are free narrative text and often name the contaminant rather than the harm ("NDMA impurity", not "cancer"), so search the substance when a symptom finds nothing.',
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
        skip: {
          type: 'number',
          description: 'Pagination offset (default 0) — the reported total can exceed one page of 100.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fda_drug_shortages',
    description:
      'Search the FDA Drug Shortages database by generic or brand name, manufacturer, status, or an advanced openFDA query. Returns national supply records and available FDA dates; reason and other details are sparse in the upstream data. This is not local pharmacy inventory or medical advice.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        drug: { type: 'string', description: 'Generic or proprietary drug name, e.g. "lisdexamfetamine".' },
        manufacturer: { type: 'string', description: 'Company/manufacturer name.' },
        status: { type: 'string', description: 'FDA status filter: "Current", "Resolved", or "To Be Discontinued".' },
        query: {
          type: 'string',
          description: 'Optional raw openFDA shortage query for advanced filters. Combined with the structured filters using AND.',
        },
        limit: { type: 'number', description: 'Number of records (1-100, default 20).' },
        skip: { type: 'number', description: 'Pagination offset (default 0).' },
      },
    },
  },
  {
    name: 'fda_shortage_changes',
    description:
      'FDA drug-shortage records ordered by update_date, newest first, then restricted to the requested look-back window. Use for recently updated, discontinued, or resolved national shortages; this does not imply availability at any specific pharmacy or hospital. Most rows in any window are "Reverified" (FDA re-checking a status it already had) — pass update_type to filter to the change kinds that actually matter, e.g. New/Discontinued/To Be Discontinued/Resolved, and exclude Reverified.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number', description: 'Look-back window in days (1-365, default 30).' },
        status: { type: 'string', description: 'Optional FDA status: "Current", "Resolved", or "To Be Discontinued".' },
        update_type: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description:
            'Optional filter on the kind of change, applied before paging (e.g. "New", "Discontinued", "To Be Discontinued", "Resolved", "Updated"; exclude "Reverified" to skip routine re-checks). String or array of strings, matched case-insensitively.',
        },
        limit: { type: 'number', description: 'Maximum records to return (1-100, default 25).' },
        skip: { type: 'number', description: 'Pagination offset into the filtered, windowed result set (default 0).' },
      },
    },
  },
  {
    name: 'fda_complete_response_letters',
    description:
      'Search FDA-disclosed Complete Response Letters for drug and biologic applications. Defaults to letter_type "COMPLETE RESPONSE"; optionally include other letter types in the same dataset. Returns the application’s current approval_status, letter metadata, an excerpt, and the official document URL.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        company: { type: 'string', description: 'Sponsor/company name.' },
        application_number: { type: 'string', description: 'NDA/BLA application number.' },
        query: { type: 'string', description: 'Optional full-text term or raw openFDA CRL search expression.' },
        from_date: { type: 'string', description: 'Optional start date, YYYY-MM-DD.' },
        to_date: { type: 'string', description: 'Optional end date, YYYY-MM-DD.' },
        include_other_letter_types: {
          type: 'boolean',
          description: 'Include tentative approvals, rescissions, refusal-to-file letters, and other non-CRL records (default false).',
        },
        limit: { type: 'number', description: 'Number of letters (1-100, default 20).' },
        skip: { type: 'number', description: 'Pagination offset (default 0).' },
      },
    },
  },
  {
    name: 'fda_crl_detail',
    description:
      'Retrieve one FDA Complete Response Letter by application number and optionally letter date. Returns the FDA-disclosed letter text and document URL. Confidential commercial and trade-secret material may be redacted by FDA.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        application_number: { type: 'string', description: 'Required NDA/BLA application number.' },
        letter_date: { type: 'string', description: 'Optional exact letter date, YYYY-MM-DD, when an application has multiple CRLs.' },
      },
      required: ['application_number'],
    },
  },
  {
    name: 'fda_food_recalls',
    description:
      'Search FDA FOOD recall / enforcement reports (openFDA /food/enforcement) — product recalls, reasons, classification, recalling firm, distribution, and status. Use for food-safety / recall-history questions (distinct from fda_drug_recalls which covers drugs).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'OpenFDA search query (optional — omit for most recent recalls). Examples: \'reason_for_recall:"Listeria"\', \'state:"CA"\', \'classification:"Class I"\'.',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1-100, default 10)',
        },
        skip: {
          type: 'number',
          description: 'Pagination offset (default 0) — the reported total can exceed one page of 100.',
        },
      },
    },
  },
  {
    name: 'fda_event_counts',
    description:
      'Aggregate adverse events by reaction type, patient age, or outcome. Returns top reactions for a drug and event trends over time.',
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
  {
    name: 'fda_warning_letters',
    description:
      'Search FDA WARNING LETTERS — official enforcement letters FDA sends firms for violations (CGMP, adulterated/misbranded products, unapproved claims). Answers "has <company> received an FDA warning letter", "recent FDA warning letters about supplements/devices". By default `search` matches the RECIPIENT company the letter was issued to, so the answer is about that firm\'s own enforcement history; set match:"fulltext" to search the whole letter record instead, which also finds letters that merely mention a firm. Every row reports matched_field so a caller can tell "issued to" from "mentions". Covers the 3,680 letters fda.gov publishes from 2021 onward — recipient company, posted and issued dates, issuing FDA office, subject and a link to the full letter text — and, for a firm with nothing in that window, falls back to the FDA compliance-actions archive of older letters back to 2010, which gives the firm, place, product type and issue date but no document. Every row says which of the two it came from. Live, no caller credential needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: {
          type: 'string',
          description: 'Company the letter was issued to (e.g. "Elanco", "Merck Sharp & Dohme") under the default match mode. Under match:"fulltext" this is a free-text query over the whole record — a product ("supplement") or violation topic ("CGMP"). Omit for the most recent letters.',
        },
        match: {
          type: 'string',
          enum: ['recipient', 'fulltext'],
          description: 'How `search` is applied. "recipient" (default) keeps only letters whose addressed company matches. "fulltext" returns every record matching anywhere in its indexed text, including letters that only mention the term.',
        },
        limit: { type: 'number', description: 'Max letters to return, 1–50 (default 10). Newest first.' },
      },
    },
  },
  {
    name: 'fda_faers_signal_summary',
    description: 'Calculate report-level FAERS disproportionality routing metrics for one drug/reaction pair using a 2×2 reporting table. The reaction argument matches one whole MedDRA preferred term, so a broad word like "neuropathy" counts only reports filed under that exact term and not the specific terms containing it. Natural multi-word phrasing is resolved to MedDRA word order and disclosed; a term matching nothing is reported as unresolved rather than as zero reports. ROR/PRR are screening statistics—not incidence, causality, comparative drug safety, or an FDA safety conclusion.',
    inputSchema: { type: 'object' as const, properties: {
      drug: { type: 'string', description: 'Brand or generic drug name.' }, reaction: { type: 'string', description: 'MedDRA preferred term, matched whole rather than as a substring. Natural English word order is accepted and corrected ("ischaemic optic neuropathy" resolves to "OPTIC ISCHAEMIC NEUROPATHY").' },
      from_date: { type: 'string', description: 'Optional YYYY-MM-DD.' }, to_date: { type: 'string', description: 'Optional YYYY-MM-DD.' },
    }, required: ['drug', 'reaction'] },
  },
  {
    name: 'fda_faers_reaction_profile',
    description: 'Summarize the most frequently co-reported FAERS reactions plus serious/non-serious report counts for a drug. Counts are spontaneous reports with duplicates, co-medications, and reporting bias—not event rates or proof of causation.',
    inputSchema: { type: 'object' as const, properties: {
      drug: { type: 'string' },
      from_date: { type: 'string', description: 'Optional. YYYY-MM-DD. OMIT for all-time counts (the common case). Only specify if the question is about a specific date range — and never set from_date equal to to_date (a zero-width window returns 0).' },
      to_date: { type: 'string', description: 'Optional. YYYY-MM-DD. OMIT unless from_date is also set. Must be after from_date.' },
      limit: { type: 'number' },
    }, required: ['drug'] },
  },
  {
    name: 'fda_faers_trend',
    description: 'Aggregate daily FAERS report counts into calendar months for a drug and optional reaction over a bounded date window. The reaction argument matches one whole MedDRA preferred term, so a broad word like "neuropathy" counts only reports filed under that exact term and not the specific terms containing it. Natural multi-word phrasing is resolved to MedDRA word order and disclosed; a term matching nothing is reported as unresolved rather than as zero reports. Trends reflect reporting activity, publicity, utilization, duplicates, and database updates—not incidence or changing clinical risk.',
    inputSchema: { type: 'object' as const, properties: {
      drug: { type: 'string' }, reaction: { type: 'string' }, from_date: { type: 'string' }, to_date: { type: 'string' },
    }, required: ['drug', 'from_date', 'to_date'] },
  },
  {
    name: 'fda_application_history',
    description: 'Retrieve one Drugs@FDA NDA, ANDA, or BLA application and return its products and chronological submission-action history. Submission codes require regulatory interpretation and do not by themselves establish approval scope, exclusivity, or current marketing.',
    inputSchema: { type: 'object' as const, properties: {
      application_number: { type: 'string', description: 'NDA, ANDA, or BLA followed by digits.' },
    }, required: ['application_number'] },
  },
  {
    name: 'fda_postmarket_risk_profile',
    description: 'Combine a drug’s FAERS reporting profile, label warning fields, and FDA recall records for review routing. This is not a validated safety comparison, causal assessment, incidence estimate, or substitute for FDA communications and clinical review.',
    inputSchema: { type: 'object' as const, properties: {
      drug: { type: 'string' }, from_date: { type: 'string' }, to_date: { type: 'string' }, reaction_limit: { type: 'number' }, recall_limit: { type: 'number' },
    }, required: ['drug'] },
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
  term?: string | number;
  time?: string;
  count: number;
}[];

/* ── Helpers ───────────────────────────────────────────────────────── */

// api.fda.gov runs on api-umbrella (the api.data.gov stack), so an api.data.gov
// key authenticates it. Anonymous callers get 1,000 requests/day per IP, shared
// across everything egressing from the same address; a key raises that to
// 120,000/day. The key is threaded rather than held in module scope because a
// caller may bring their own and an isolate serves requests concurrently.
function apiKeyOf(args: Record<string, unknown>): string | undefined {
  const key = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  return key || undefined;
}

function withApiKey(params: string, apiKey?: string): string {
  return apiKey ? `${params}&api_key=${encodeURIComponent(apiKey)}` : params;
}

async function fdaFetch(endpoint: string, params: string, apiKey?: string): Promise<FdaResponse> {
  let res = await pwFetch(`${BASE}${endpoint}?${withApiKey(params, apiKey)}`);

  // A rejected key must never take the pack down: openFDA is usable without one,
  // so fall back to the anonymous quota rather than failing every call.
  if (apiKey && res.status === 403) {
    const peek = (await res.clone().text()).slice(0, 500);
    if (peek.includes('API_KEY_INVALID') || peek.includes('API_KEY_MISSING') || peek.includes('API_KEY_DISABLED')) {
      // Log it: the fallback keeps calls working, which means a dead platform key
      // would otherwise be completely invisible while every call quietly costs two
      // requests against the anonymous quota it was meant to relieve.
      console.warn('openfda: api key rejected, retrying anonymously');
      res = await pwFetch(`${BASE}${endpoint}?${params}`);
    }
  }

  if (!res.ok) {
    if (res.status === 404) {
      return { results: [], meta: { results: { total: 0, skip: 0, limit: 0 } } };
    }
    const body = (await res.text()).slice(0, 10_000);
    // KEEP THE STATUS. This used to replace it with openFDA's `error.message`,
    // and that message is uselessly generic: a transient backend 500 and a
    // malformed-Lucene 500 BOTH render as "Check your request and try again",
    // while `error.details` — the field that actually names the parse error —
    // was discarded entirely.
    //
    // The cost is not hypothetical. On 2026-08-14 openFDA had a 29-second
    // outage (15:18:30-15:18:59) in which every openfda tool failed at once.
    // Five persona-battery cases recorded it as pack breakage, in the vertical
    // that is our chosen market, and the message gave no way to tell an outage
    // from five broken queries — the daily report's first hypothesis was that
    // our own eval burst had throttled us, which took a 70-call experiment to
    // disprove. A status code would have answered it immediately.
    //
    // 5xx is also the difference between "retry this" and "fix your query", so
    // the class prefix is worth setting: without it a transient outage books as
    // a Pipeworx bug and puts a healthy pack on the Problem Tools list.
    let msg = `OpenFDA API error: ${res.status}`;
    try {
      const err = JSON.parse(body) as FdaResponse & { error?: { details?: unknown } };
      const parts = [err.error?.message, typeof err.error?.details === 'string' ? err.error.details : undefined]
        .filter(Boolean)
        .join(' — ');
      if (parts) msg = `OpenFDA API error (${res.status}): ${parts}`;
    } catch {
      // Non-JSON body: the status alone is still more than we had.
    }
    if (res.status >= 500) msg = `upstream_down: ${msg}`;
    if (res.status === 429) msg = `upstream_throttled: ${msg}`;
    throw new Error(msg);
  }

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > 12_000_000) throw new Error('OpenFDA response exceeded size limit');
  const body = await res.text();
  if (new TextEncoder().encode(body).length > 12_000_000) throw new Error('OpenFDA response exceeded size limit');
  return JSON.parse(body) as FdaResponse;
}

/**
 * Encode query for OpenFDA — preserves brackets, colons, quotes, and plus signs
 * that OpenFDA uses in its search syntax. Only encodes spaces and other unsafe chars.
 */
function encodeQuery(query: string): string {
  return query.replace(/ /g, '+');
}

/**
 * openFDA does NOT AND bare terms. On a free-text index it favours the
 * higher-cardinality term and drops the rest, silently: `metformin
 * contamination` returned the same 2,063 recalls as `contamination` alone,
 * none of them about metformin. HTTP 200, well-formed, zero error rate — the
 * worst shape a wrong answer can take.
 *
 * The obvious fix is worse than the bug. Inserting AND between bare terms was
 * MEASURED against real queries and zeroed four of five, because these are
 * free-text narrative fields: the valsartan recalls say "N-Nitrosodimethylamine
 * (NDMA) impurity" and never the word "cancer", so a strict AND is correctly
 * empty and useless. That trades a wrong answer for no answer.
 *
 *   query                    bare   AND
 *   metformin contamination  2063     4   <- AND is right
 *   insulin pen                29    13   <- AND is right
 *   valsartan cancer            4     0   <- AND is wrong
 *   eye drops infection         5     0
 *   blood pressure recall     790     0
 *   children cough syrup       68     0
 *
 * So: try all-terms first, fall back to the loose query when that finds
 * nothing, and TELL the caller which one answered. One upstream call in the
 * common case, two only when the strict read is empty — affordable now that
 * this pack authenticates (120k/day, not the anonymous 1k).
 *
 * Only genuinely BARE queries are touched. Anything carrying openFDA syntax —
 * a field:value, a quoted phrase, a [range], an existing boolean, a paren — is
 * passed through untouched, because those callers already said what they meant.
 */
const FDA_SYNTAX = /[:"\[\]()]|\+(AND|OR|NOT)\+|\s(AND|OR|NOT)\s/;

function bareTerms(query: string): string[] | null {
  const q = query.trim();
  if (!q || FDA_SYNTAX.test(q)) return null;
  const terms = q.split(/\s+/).filter(Boolean);
  return terms.length > 1 ? terms : null;
}

type TermMode = 'as_given' | 'all_terms' | 'any_term';

async function withTermFallback(
  query: string,
  run: (q: string) => Promise<FdaResponse>,
): Promise<{ data: FdaResponse; query: string; mode: TermMode }> {
  const terms = bareTerms(query);
  if (!terms) return { data: await run(query), query, mode: 'as_given' };

  const strict = terms.join(' AND ');
  const tight = await run(strict);
  if ((tight.meta?.results?.total ?? 0) > 0) return { data: tight, query: strict, mode: 'all_terms' };

  return { data: await run(query), query, mode: 'any_term' };
}

/** Say how the terms were matched; silence here is what made the bug invisible. */
function termMatchFields(query: string, requested: string, mode: TermMode) {
  if (mode === 'as_given') return {};
  if (mode === 'all_terms') {
    return { query, match_mode: 'all_terms' as const, requested_query: requested };
  }
  return {
    query: requested,
    match_mode: 'any_term' as const,
    match_note: `No record contains every term in "${requested}", so these match ANY of them and may not be about all of it. These are free-text narrative fields — a recall for a contaminant often names the chemical rather than the harm — so add a more specific term, or quote a phrase, rather than trusting the count.`,
  };
}

/**
 * FDA drugsfda stores all drug/ingredient names in UPPERCASE. LLMs frequently
 * generate lowercase quoted values (e.g. "apixaban") which return 0 results.
 * This normalises quoted values to uppercase so the query reaches the index.
 * Leaves field names and unquoted terms unchanged.
 */
function uppercaseQuotedTerms(query: string): string {
  return query.replace(/"([^"]+)"/g, (_, term: string) => `"${term.toUpperCase()}"`);
}

// openfda.generic_name is only valid on /drug/label.json (label endpoint).
// On /drug/drugsfda.json it always returns 0. Silently rewrite to the correct field.
function rewriteDrugsfdaFields(query: string): string {
  return query.replace(/\bopenfda\.generic_name:/gi, 'products.active_ingredients.name:');
}

function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function fieldContains(field: string, value: string): string {
  const tokens = value
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-zA-Z0-9._-]/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) throw new Error(`Invalid ${field} filter.`);
  return tokens.length === 1
    ? `${field}:${tokens[0]}*`
    : `(${tokens.map((token) => `${field}:${token}*`).join('+AND+')})`;
}

function compactDate(value: string, field: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${field} must use YYYY-MM-DD.`);
  return `${match[1]}${match[2]}${match[3]}`;
}

function parseFdaDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (slash) return `${slash[3]}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

/* ── Tool implementations ──────────────────────────────────────────── */

// MedDRA preferred terms use a fixed word order that differs from natural English
// (e.g. "OPTIC ISCHAEMIC NEUROPATHY" not "ISCHAEMIC OPTIC NEUROPATHY"). When an
// exact reaction filter returns 0, try all word-order permutations of the term.
const REACTION_EXACT_RE = /patient\.reaction\.reactionmeddrapt\.exact:"([^"]+)"/i;

function reactionPermutations(term: string): string[] {
  const words = term.split(/\s+/);
  // Capped at 3 words on purpose: 4 words is 23 extra sequential upstream calls
  // against a keyless quota, and a 4-word PT that differs ONLY in word order is
  // rare. Twenty-four round trips is a worse answer than an empty one.
  if (words.length < 2 || words.length > 3) return [];
  function permute(arr: string[]): string[][] {
    if (arr.length <= 1) return [arr.slice()];
    return arr.flatMap((item, i) =>
      permute([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [item, ...p]),
    );
  }
  return permute(words)
    .slice(1) // skip the original (already tried)
    .map((p) => p.join(' '));
}

type ResolvedReaction = {
  requested: string;
  resolved: string;
  normalized: boolean;
  found: boolean;
};

// Whether a MedDRA term exists in FAERS is stable, so cache it for the isolate's
// lifetime — a repeated reaction argument otherwise re-pays the whole permutation
// walk against a keyless quota on every call.
const reactionResolutionCache = new Map<string, ResolvedReaction>();

async function resolveFaersReaction(reaction: string, apiKey?: string): Promise<ResolvedReaction> {
  const requested = reaction.trim().toUpperCase();
  const cached = reactionResolutionCache.get(requested);
  if (cached) return cached;

  let outcome: ResolvedReaction = { requested, resolved: requested, normalized: false, found: false };
  if (await faersTotal(faersReactionSearch(requested), apiKey) > 0) {
    outcome = { requested, resolved: requested, normalized: false, found: true };
  } else {
    for (const candidate of reactionPermutations(requested)) {
      if (await faersTotal(faersReactionSearch(candidate), apiKey) > 0) {
        outcome = { requested, resolved: candidate, normalized: true, found: true };
        break;
      }
    }
  }

  if (reactionResolutionCache.size > 500) reactionResolutionCache.clear();
  reactionResolutionCache.set(requested, outcome);
  return outcome;
}

// A term that matched nothing must say so. Otherwise "already the preferred term"
// and "not a MedDRA preferred term at all" both surface as a silent zero, and the
// caller reads an empty reporting table as an absence of reports.
function reactionResolutionFields(reaction: ResolvedReaction) {
  if (!reaction.found) {
    return {
      reaction_requested: reaction.requested,
      reaction_resolved: reaction.resolved,
      reaction_resolution: 'not_a_meddra_preferred_term' as const,
      reaction_resolution_hint: `No FAERS report uses "${reaction.requested}" as a reaction preferred term, in this or any word order. Counts below are zero because the term did not match, not because no reports exist. Call fda_event_counts with count_field "patient.reaction.reactionmeddrapt.exact" to list the preferred terms FDA actually stores.`,
    };
  }
  return reaction.normalized
    ? {
        reaction_requested: reaction.requested,
        reaction_resolved: reaction.resolved,
        reaction_resolution: 'word_order_corrected' as const,
        reaction_resolution_note: `MedDRA preferred-term word order corrected: "${reaction.requested}" → "${reaction.resolved}".`,
      }
    : {
        reaction_requested: reaction.requested,
        reaction_resolved: reaction.resolved,
        reaction_resolution: 'exact_match' as const,
      };
}

// The events index's openfda.* enrichment is sparser than the label endpoint's
// (fdaDrugLabels above has its own ladder for that one) — confirmed live: FAERS
// reports mentioning semaglutide/OZEMPIC return upstream NOT_FOUND under BOTH
// patient.drug.openfda.generic_name AND .brand_name (39k+ ibuprofen/Advil-class
// drugs are fine; newer drugs lag the NDC-matching pipeline that populates this
// block), while patient.drug.medicinalproduct — the report's own free-text drug
// field, always present — answers the identical drug immediately. Same silent
// shape as the reaction-permutation gap below: HTTP 200, well-formed, total: 0,
// and nothing in the response says the field name was the problem.
const DRUG_OPENFDA_FIELD_RE = /patient\.drug\.openfda\.(?:generic_name|brand_name|substance_name)(?:\.exact)?:"([^"]+)"/i;

function drugFieldFallbackQuery(query: string): string | null {
  const m = DRUG_OPENFDA_FIELD_RE.exec(query);
  if (!m) return null;
  return `${query.slice(0, m.index)}patient.drug.medicinalproduct:"${m[1]}"${query.slice(m.index + m[0].length)}`;
}

async function fdaDrugEvents(query: string, limit?: number, skip?: number, apiKey?: string) {
  const l = Math.min(100, Math.max(1, limit ?? 10));
  const s = Math.max(0, skip ?? 0);
  const run = async (q: string) => fdaFetch('/drug/event.json', `search=${encodeQuery(q)}&limit=${l}&skip=${s}`, apiKey);

  let workingQuery = query;
  let finalData = await run(workingQuery);
  let drugFieldFrom: string | null = null;
  let reactionNormalizedFrom: string | null = null;
  let reactionNormalizedTo: string | null = null;

  if ((finalData.meta?.results?.total ?? 0) === 0) {
    const altQuery = drugFieldFallbackQuery(workingQuery);
    if (altQuery) {
      const altData = await run(altQuery);
      if ((altData.meta?.results?.total ?? 0) > 0) {
        drugFieldFrom = DRUG_OPENFDA_FIELD_RE.exec(workingQuery)![0];
        workingQuery = altQuery;
        finalData = altData;
      }
    }
  }

  if ((finalData.meta?.results?.total ?? 0) === 0) {
    const m = REACTION_EXACT_RE.exec(workingQuery);
    if (m) {
      const original = m[1];
      for (const candidate of reactionPermutations(original)) {
        const altQuery = workingQuery.replace(REACTION_EXACT_RE, `patient.reaction.reactionmeddrapt.exact:"${candidate}"`);
        const altData = await run(altQuery);
        if ((altData.meta?.results?.total ?? 0) > 0) {
          reactionNormalizedFrom = original;
          reactionNormalizedTo = candidate;
          finalData = altData;
          break;
        }
      }
    }
  }

  return {
    total: finalData.meta?.results?.total ?? 0,
    skip: finalData.meta?.results?.skip ?? 0,
    limit: finalData.meta?.results?.limit ?? l,
    results: (finalData.results ?? []).map(projectFaersRecord),
    ...(drugFieldFrom
      ? {
          drug_field_resolution: 'fallback_to_medicinalproduct' as const,
          drug_field_resolution_note: `No FAERS report is indexed under ${drugFieldFrom.split(':')[0]} for this drug — matched via patient.drug.medicinalproduct instead (the report's own free-text drug name field, always present even when openFDA's brand/generic-name enrichment is missing).`,
        }
      : {}),
    ...(reactionNormalizedFrom
      ? {
          reaction_requested: reactionNormalizedFrom,
          reaction_resolved: reactionNormalizedTo,
          reaction_resolution: 'word_order_corrected' as const,
          reaction_resolution_note: `MedDRA preferred-term word order corrected: "${reactionNormalizedFrom}" → "${reactionNormalizedTo}".`,
        }
      : {}),
  };
}

// FAERS records from openFDA are ~100KB each (full E2B safety report with
// nested patient / drug / reaction arrays and provenance metadata). At the
// default limit they blow past context budgets, so we project to the slim
// shape an agent actually answers questions with. Raw record is reachable
// via report_id if a caller needs to drill in.
type FaersRecord = {
  safetyreportid?: string;
  receivedate?: string;
  occurcountry?: string;
  serious?: string;
  seriousnessdeath?: string;
  seriousnesshospitalization?: string;
  seriousnessdisabling?: string;
  seriousnesslifethreatening?: string;
  seriousnesscongenitalanomali?: string;
  seriousnessother?: string;
  patient?: {
    patientonsetage?: string;
    patientonsetageunit?: string;
    patientsex?: string;
    reaction?: { reactionmeddrapt?: string; reactionoutcome?: string }[];
    drug?: {
      medicinalproduct?: string;
      drugindication?: string;
      drugcharacterization?: string;
      drugdosagetext?: string;
      drugadministrationroute?: string;
    }[];
  };
};

function projectFaersRecord(raw: unknown) {
  const r = raw as FaersRecord;
  const p = r.patient ?? {};
  const outcomes: string[] = [];
  if (r.seriousnessdeath === '1') outcomes.push('death');
  if (r.seriousnesslifethreatening === '1') outcomes.push('life_threatening');
  if (r.seriousnesshospitalization === '1') outcomes.push('hospitalization');
  if (r.seriousnessdisabling === '1') outcomes.push('disabling');
  if (r.seriousnesscongenitalanomali === '1') outcomes.push('congenital_anomaly');
  if (r.seriousnessother === '1') outcomes.push('other');
  return {
    report_id: r.safetyreportid ?? null,
    received_date: r.receivedate ?? null,
    occur_country: r.occurcountry ?? null,
    serious: r.serious === '1',
    outcomes,
    patient: {
      age: p.patientonsetage ?? null,
      age_unit: p.patientonsetageunit ?? null,
      sex: p.patientsex ?? null,
    },
    reactions: (p.reaction ?? []).map((rx) => rx.reactionmeddrapt ?? null).filter(Boolean),
    drugs: (p.drug ?? []).slice(0, 10).map((d) => ({
      name: d.medicinalproduct ?? null,
      indication: d.drugindication ?? null,
      role: d.drugcharacterization ?? null,
      dose: d.drugdosagetext ?? null,
      route: d.drugadministrationroute ?? null,
    })),
  };
}

// Raw drugsfda records run ~8KB each — submissions carry `application_docs` URL
// arrays, openfda carries a dozen parallel code arrays. At the default limit this
// spilled ~300KB, mostly bloat the caller never reads. Project to the approval
// facts an agent answering "is X approved / who makes it / what's in it / when"
// actually uses, and drop application_docs entirely.
function projectDrugsfdaRecord(raw: unknown) {
  const r = raw as {
    application_number?: string;
    sponsor_name?: string;
    openfda?: Record<string, string[] | undefined>;
    products?: {
      product_number?: string; brand_name?: string; dosage_form?: string; route?: string;
      marketing_status?: string; active_ingredients?: { name?: string; strength?: string }[];
    }[];
    submissions?: {
      submission_type?: string; submission_number?: string; submission_status?: string;
      submission_status_date?: string; review_priority?: string; submission_class_code_description?: string;
    }[];
  };
  const appNo = r.application_number ?? null;
  const appType = appNo?.startsWith('ANDA') ? 'ANDA' : appNo?.startsWith('BLA') ? 'BLA' : appNo?.startsWith('NDA') ? 'NDA' : 'other';
  const o = r.openfda ?? {};
  const fmt = (d?: string) => (d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);
  const origDate = (r.submissions ?? [])
    .filter((s) => s.submission_type === 'ORIG' && s.submission_status === 'AP' && s.submission_status_date)
    .map((s) => s.submission_status_date as string)
    .sort()[0];
  return {
    application_number: appNo,
    application_type: appType,
    sponsor: r.sponsor_name ?? null,
    brand_names: o.brand_name ?? [],
    generic_names: o.generic_name ?? o.substance_name ?? [],
    pharm_class: [...(o.pharm_class_epc ?? []), ...(o.pharm_class_moa ?? [])],
    routes: o.route ?? [],
    original_approval_date: fmt(origDate),
    products: (r.products ?? []).map((p) => ({
      product_number: p.product_number ?? null,
      brand_name: p.brand_name ?? null,
      dosage_form: p.dosage_form ?? null,
      route: p.route ?? null,
      marketing_status: p.marketing_status ?? null,
      active_ingredients: (p.active_ingredients ?? []).map((i) => [i.name, i.strength].filter(Boolean).join(' ')),
    })),
    // Compact submission history — NO application_docs (the URL-array bloat).
    submissions: (r.submissions ?? []).map((s) => ({
      type: s.submission_type ?? null,
      number: s.submission_number ?? null,
      status: s.submission_status ?? null,
      date: fmt(s.submission_status_date),
      review_priority: s.review_priority ?? null,
      class: s.submission_class_code_description ?? null,
    })),
  };
}

const DRUGSFDA_ZERO_HINT =
  'Zero results. Common causes: (1) drug names must be UPPERCASE in quotes (e.g. "APIXABAN"); (2) there is NO application_type field — never chain application_type:"ANDA"/"NDA" (ANDA vs NDA is read from the application_number prefix); (3) use products.active_ingredients.name for ingredients, not openfda.generic_name (a label-endpoint field). (4) Indication / "approved for <condition>" is NOT searchable here — drugsfda has no indication field; use fda_drug_labels (indications_and_usage) to search by indicated use. Retry with a single, broader term.';

const DRUG_APPROVALS_SORTS = ['approval_date_asc', 'approval_date_desc'] as const;

async function fdaDrugApprovals(query: string, limit?: number, skip?: number, sort?: string, apiKey?: string) {
  const l = Math.min(100, Math.max(1, limit ?? 10));
  const s = Math.max(0, skip ?? 0);
  const q = encodeQuery(uppercaseQuotedTerms(rewriteDrugsfdaFields(query)));

  if (sort !== undefined && !DRUG_APPROVALS_SORTS.includes(sort as (typeof DRUG_APPROVALS_SORTS)[number])) {
    throw new Error(`sort must be one of: ${DRUG_APPROVALS_SORTS.join(', ')}`);
  }

  // sort requested: openFDA's own sort=submissions.submission_status_date:desc is
  // unusable on this endpoint — submissions is a nested array and the sort reads
  // ANY value across the whole array, so a decades-old drug with a recent label
  // supplement outranks a genuinely new approval (same defect documented and
  // worked around in fdaNovelApprovals below, confirmed live 2026-07-21). So:
  // fetch the matching records ourselves, project them (projectDrugsfdaRecord
  // already derives original_approval_date from EACH record's own ORIG+AP
  // submission, not "any" submission), and sort client-side on that field.
  if (sort) {
    const CAP = 1000; // 10 pages of 100 — matches fdaNovelApprovals's bound below.
    const rows: ReturnType<typeof projectDrugsfdaRecord>[] = [];
    let total = Number.POSITIVE_INFINITY;
    let fetched = 0;
    while (fetched < total && fetched < CAP) {
      const data = await fdaFetch('/drug/drugsfda.json', `search=${q}&limit=100&skip=${fetched}`, apiKey);
      total = data.meta?.results?.total ?? 0;
      if (total === 0) return { total: 0, results: [], retry_hint: DRUGSFDA_ZERO_HINT };
      for (const raw of data.results ?? []) rows.push(projectDrugsfdaRecord(raw));
      fetched += 100;
    }
    const dir = sort === 'approval_date_asc' ? 1 : -1;
    rows.sort((a, b) => {
      const ad = a.original_approval_date ?? '';
      const bd = b.original_approval_date ?? '';
      if (ad === bd) return 0;
      return ad < bd ? -dir : dir;
    });
    const window = rows.slice(s, s + l);
    return {
      total,
      sort,
      skip: s,
      returned: window.length,
      sort_note:
        rows.length < total
          ? `Ordering is exact over the ${rows.length} of ${total} matching records this call fetched (capped at ${CAP} for one call) — records beyond that are not represented in this order. Narrow the query to cover the rest.`
          : `Ordering is exact over all ${rows.length} matching records.`,
      results: window,
    };
  }

  const params = `search=${q}&limit=${l}&skip=${s}`;
  const data = await fdaFetch('/drug/drugsfda.json', params, apiKey);
  const total = data.meta?.results?.total ?? 0;

  // Silent-zero is the #1 drugsfda failure: a lowercase name, an application_type
  // filter (no such field), or an indication phrase (drugsfda has no indication
  // field) returns 0 with no explanation. Return an actionable hint so the caller
  // self-corrects instead of retrying blind.
  if (total === 0) {
    return { total: 0, results: [], retry_hint: DRUGSFDA_ZERO_HINT };
  }

  return {
    total,
    skip: s,
    returned: data.results?.length ?? 0,
    // Projected to ~1KB/record (was ~8KB raw) so large result sets don't overflow.
    results: (data.results ?? []).map(projectDrugsfdaRecord),
  };
}

// ── Applications by CIK / resolved parent (fleet #692) ──────────────
// Drugs@FDA has NO company-identifier field at all — sponsor_name is a free
// -text string typed at filing time, and one company files under several
// spellings (verified live: Eli Lilly's applications split across
// sponsor_name "LILLY" (116), "ELI LILLY AND CO" (22), "ELI LILLY CO" (4),
// "LILLY RES LABS" (1) — the SEC-registrant form "ELI LILLY AND COMPANY"
// matches ZERO of them). `search=sponsor_name:X` is also an EXACT match on
// the whole field (not a token search) despite looking like full-text
// syntax, so trying candidate spellings one at a time is exactly the ~10-call
// chain this tool replaces.
//
// Fix: resolve the caller's CIK/ticker/name to SEC's canonical company name,
// derive its most distinctive token (significantNameTokens — longest word,
// since FDA sponsor abbreviations anchor on the surname/brand word: "LILLY"
// not "ELI"), then run ONE openFDA WILDCARD search (`sponsor_name:*TOKEN*`),
// which — unlike the exact-match `search=sponsor_name:X` syntax — genuinely
// substring-matches every spelling variant in one call. Case-sensitive
// (verified: lowercase "*lilly*" returns zero) — significantNameTokens
// already uppercases.
async function resolveCikAndName(cikOrTicker: string): Promise<{ cik: string; company_name: string }> {
  const trimmed = cikOrTicker.trim();
  if (/^\d+$/.test(trimmed)) {
    const padded = trimmed.padStart(10, '0');
    const res = await pwFetch(`https://data.sec.gov/submissions/CIK${padded}.json`, { headers: SEC_HEADERS });
    if (!res.ok) {
      throw new Error(
        `No SEC registrant with CIK ${trimmed}. Resolve a real one with edgar_ticker_to_cik({ticker:"…"}) (accepts a ticker or company name), or pass a ticker/company name directly here.`,
      );
    }
    const data = (await res.json()) as { name?: string };
    if (!data.name) throw new Error(`SEC has CIK ${trimmed} on file but no company name — cannot derive an FDA search token from it.`);
    return { cik: String(Number(trimmed)), company_name: data.name };
  }
  const entity = await resolveSecEntity(trimmed, { headers: SEC_HEADERS });
  return { cik: entity.cik, company_name: entity.company_name };
}

async function fdaApplicationsByCik(cikOrTicker: string | undefined, limitArg: number | undefined, apiKey?: string): Promise<unknown> {
  if (typeof cikOrTicker !== 'string' || !cikOrTicker.trim()) {
    return {
      error: 'Required argument missing: pass a CIK ("59478"), a ticker ("LLY"), or an exact SEC-listed company name.',
      retry_hint: 'fda_applications_by_cik({cik_or_ticker: "59478"}) or {cik_or_ticker: "LLY"}.',
    };
  }
  const { cik, company_name } = await resolveCikAndName(cikOrTicker);
  const tokens = significantNameTokens(company_name).slice(0, 3); // longest first, bounded — see header comment
  if (tokens.length === 0) {
    return {
      cik, company_name,
      status: 'no_token',
      message: `Could not derive a searchable word from "${company_name}" (name is entirely generic corporate boilerplate).`,
      applications: [],
    };
  }

  // Try tokens longest-first until one has any match at all — most companies
  // resolve on the first (most distinctive) token; shorter runners-up exist
  // only as a fallback for names with no single long distinctive word.
  let matchedToken: string | null = null;
  let total = 0;
  let firstPage: unknown[] = [];
  for (const token of tokens) {
    const data = await fdaFetch('/drug/drugsfda.json', `search=sponsor_name:*${encodeURIComponent(token)}*&limit=100`, apiKey);
    total = data.meta?.results?.total ?? 0;
    if (total > 0) {
      matchedToken = token;
      firstPage = data.results ?? [];
      break;
    }
  }
  if (!matchedToken) {
    return {
      cik, company_name,
      status: 'no_applications',
      tokens_tried: tokens,
      message: `No Drugs@FDA sponsor_name contains any of [${tokens.join(', ')}] (derived from SEC's registered name "${company_name}"). Either this company has no FDA drug applications on file, or its sponsor_name spelling doesn't share a word with its SEC name — try fda_drug_approvals directly with a candidate sponsor name.`,
      applications: [],
    };
  }

  // Page through the rest (bounded — no real filer has >500 drugsfda records).
  const CAP = 500;
  const raw: unknown[] = [...firstPage];
  let fetched = raw.length;
  while (fetched < total && fetched < CAP) {
    const data = await fdaFetch('/drug/drugsfda.json', `search=sponsor_name:*${encodeURIComponent(matchedToken)}*&limit=100&skip=${fetched}`, apiKey);
    raw.push(...(data.results ?? []));
    fetched += 100;
  }

  const projected = raw.map(projectDrugsfdaRecord);
  const bySponsor = new Map<string, number>();
  for (const p of projected) {
    const s = p.sponsor ?? 'UNKNOWN';
    bySponsor.set(s, (bySponsor.get(s) ?? 0) + 1);
  }
  const sponsorForms = [...bySponsor.entries()]
    .map(([sponsor_name, application_count]) => ({ sponsor_name, application_count }))
    .sort((a, b) => b.application_count - a.application_count);

  const limit = Math.min(200, Math.max(1, Math.floor(Number(limitArg) || 100)));

  return {
    cik,
    company_name,
    matched_token: matchedToken,
    tokens_tried: tokens.slice(0, tokens.indexOf(matchedToken) + 1),
    sponsor_name_forms: sponsorForms,
    total_applications: projected.length,
    returned: Math.min(projected.length, limit),
    truncated: total > CAP,
    note: `Drugs@FDA has no CIK/company-ID field — sponsor_name is free text, and one company can file under several forms (see sponsor_name_forms). This aggregates every application whose sponsor_name contains "${matchedToken}" (derived from SEC's registered name "${company_name}"). A legitimate form that shares no word with the SEC name would be missed — check sponsor_name_forms coverage against what you expect.`,
    applications: projected.slice(0, limit),
  };
}

/**
 * Newest original NDA/BLA approvals in a rolling window. Two things make this
 * non-trivial on the drugsfda endpoint (verified live 2026-07-21):
 * - `sort=submissions.submission_status_date:desc` is unusable: the sort reads
 *   ANY submission in the record's array, so a 1968 drug with a recent
 *   supplement outranks last week's novel approval.
 * - The search conditions each match ANY submission independently, so results
 *   must be re-filtered client-side to the SAME submission being ORIG + AP +
 *   in-window (~700 records match the window; ~12 are real NDA/BLA originals).
 */
async function fdaNovelApprovals(args: Record<string, unknown>) {
  const apiKey = apiKeyOf(args);
  const days = Math.min(365, Math.max(1, Number(args.days) || 90));
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
  const resultSkip = Math.max(0, Number(args.skip) || 0);
  const includeGenerics = args.include_generics === true;
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const startS = fmt(new Date(now.getTime() - days * 86400_000));
  const endS = fmt(now);
  const search = `submissions.submission_type:"ORIG"+AND+submissions.submission_status:"AP"+AND+submissions.submission_status_date:[${startS}+TO+${endS}]`;

  interface DrugsFdaRec {
    application_number?: string;
    sponsor_name?: string;
    submissions?: { submission_type?: string; submission_status?: string; submission_status_date?: string }[];
    products?: { brand_name?: string; active_ingredients?: { name?: string; strength?: string }[] }[];
    openfda?: { brand_name?: string[] };
  }
  const rows: {
    approval_date: string;
    application_number: string;
    application_type: string;
    brand_name: string | null;
    active_ingredients: string[];
    sponsor: string | null;
  }[] = [];
  let skip = 0;
  let total = Number.POSITIVE_INFINITY;
  while (skip < total && skip < 1000) {
    const data = await fdaFetch('/drug/drugsfda.json', `search=${search}&limit=100&skip=${skip}`, apiKey);
    total = data.meta?.results?.total ?? 0;
    for (const raw of (data.results ?? []) as DrugsFdaRec[]) {
      const appNo = raw.application_number ?? '';
      const appType = appNo.startsWith('NDA') ? 'NDA' : appNo.startsWith('BLA') ? 'BLA' : appNo.startsWith('ANDA') ? 'ANDA' : 'other';
      if (!includeGenerics && appType !== 'NDA' && appType !== 'BLA') continue;
      const origDates = (raw.submissions ?? [])
        .filter((s) => s.submission_type === 'ORIG' && s.submission_status === 'AP')
        .map((s) => s.submission_status_date ?? '')
        .filter((d) => d >= startS && d <= endS);
      if (origDates.length === 0) continue;
      const d = origDates.sort().at(-1) as string;
      const product = (raw.products ?? [])[0];
      rows.push({
        approval_date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        application_number: appNo,
        application_type: appType,
        brand_name: raw.openfda?.brand_name?.[0] ?? product?.brand_name ?? null,
        active_ingredients: (product?.active_ingredients ?? []).map((i) => i.name ?? '').filter(Boolean),
        sponsor: raw.sponsor_name ?? null,
      });
    }
    skip += 100;
  }
  rows.sort((a, b) => (a.approval_date < b.approval_date ? 1 : -1));
  const windowed = rows.slice(resultSkip, resultSkip + limit);
  return {
    window_days: days,
    from: `${startS.slice(0, 4)}-${startS.slice(4, 6)}-${startS.slice(6, 8)}`,
    to: `${endS.slice(0, 4)}-${endS.slice(4, 6)}-${endS.slice(6, 8)}`,
    skip: resultSkip,
    count: windowed.length,
    total_in_window: rows.length,
    note: includeGenerics
      ? 'Original approvals including ANDA generics, newest first.'
      : 'Original NDA/BLA approvals only (novel drugs/biologics; generics excluded), newest first. Source: FDA Drugs@FDA via openFDA.',
    approvals: windowed,
  };
}

// openFDA indexes a drug under EITHER openfda.brand_name OR openfda.generic_name
// — almost never both. Probed live against 50 top-selling drugs: 26 matched ONLY
// brand_name ("OZEMPIC", "HUMIRA", "KEYTRUDA") and 11 matched ONLY generic_name
// ("semaglutide", "pembrolizumab", "tirzepatide"). A caller who guesses the wrong
// field gets HTTP 404 NOT_FOUND, which fdaFetch() converts to an empty result set
// — a silent failure indistinguishable from "this drug has no FDA label".
//
// So: when a simple single-field name lookup comes back empty, walk the sibling
// name fields, then unfielded full text, and REPORT which rung answered so the
// caller learns the right field instead of re-guessing.
const LABEL_NAME_FIELDS = [
  'openfda.brand_name',
  'openfda.generic_name',
  'openfda.substance_name',
] as const;

// Only ladder on a query that is EXACTLY one name-field lookup. Compound queries
// (AND/OR, ranges, indications_and_usage) are left alone — rewriting those would
// change what the caller asked, and an indication with no matches is a real answer.
const SIMPLE_NAME_QUERY =
  /^\s*(openfda\.(?:brand_name|generic_name|substance_name))\s*:\s*"?([^"+()[\]:]+?)"?\s*$/i;

function parseSimpleNameQuery(query: string): { field: string; value: string } | null {
  const m = SIMPLE_NAME_QUERY.exec(query);
  if (!m) return null;
  const value = m[2].trim();
  if (!value || /\b(AND|OR|NOT)\b/i.test(value)) return null;
  return { field: m[1].toLowerCase(), value };
}

async function fdaDrugLabels(query: string, limit?: number, skip?: number, apiKey?: string) {
  const l = Math.min(100, Math.max(1, limit ?? 5));
  const s = Math.max(0, skip ?? 0);
  const run = async (q: string) =>
    fdaFetch('/drug/label.json', `search=${encodeQuery(q)}&limit=${l}&skip=${s}`, apiKey);
  const shape = (q: string, data: FdaResponse, extra: Record<string, unknown>) => ({
    query: q,
    total: data.meta?.results?.total ?? 0,
    skip: s,
    results: (data.results ?? []).map(projectLabelRecord),
    ...extra,
  });

  // Same silent term-drop applies to a bare multi-word label search; the rest of
  // this resolution ladder is untouched, since it handles field:"value" queries
  // that bareTerms() deliberately skips.
  const { data: first, query: firstQuery, mode } = await withTermFallback(query, run);
  if ((first.meta?.results?.total ?? 0) > 0) {
    return shape(firstQuery, first, {
      resolved_via: 'query_as_given',
      ...termMatchFields(firstQuery, query, mode),
    });
  }

  const simple = parseSimpleNameQuery(query);
  if (!simple) {
    return shape(query, first, {
      resolved_via: 'query_as_given',
      no_results_note:
        'Zero labels matched. openFDA indexes a drug under EITHER openfda.brand_name (e.g. "OZEMPIC") OR openfda.generic_name (e.g. "semaglutide") — rarely both — so a single-field guess often misses. Retry with one plain field:"value" lookup and this tool will automatically try the sibling name fields. For "what drugs treat <condition>", search indications_and_usage:"<condition>" instead of a drug name.',
    });
  }

  const fieldsTried: string[] = [simple.field];
  for (const field of LABEL_NAME_FIELDS) {
    if (field === simple.field) continue;
    const alt = `${field}:"${simple.value}"`;
    const data = await run(alt);
    fieldsTried.push(field);
    if ((data.meta?.results?.total ?? 0) > 0) {
      return shape(alt, data, {
        requested_query: query,
        resolved_via: `fallback:${field}`,
        fields_tried: fieldsTried,
        resolution_note: `No label is indexed under ${simple.field} for "${simple.value}" — matched on ${field} instead. Query ${alt} directly next time.`,
      });
    }
  }

  // Last rung: unfielded full text. Lower precision — this matches any label that
  // merely MENTIONS the term (a discontinued brand cited inside its generic's
  // label, say), so flag it rather than passing it off as a name match.
  const fullText = `"${simple.value}"`;
  const ftData = await run(fullText);
  if ((ftData.meta?.results?.total ?? 0) > 0) {
    return shape(fullText, ftData, {
      requested_query: query,
      resolved_via: 'fallback:full_text',
      fields_tried: [...fieldsTried, 'full_text'],
      resolution_note: `"${simple.value}" is not indexed under any openFDA name field (brand_name / generic_name / substance_name). These labels only MENTION the term somewhere in their text, so precision is lower — verify each result is actually the drug you meant before quoting it.`,
    });
  }

  return shape(query, ftData, {
    query,
    resolved_via: 'none',
    fields_tried: [...fieldsTried, 'full_text'],
    no_results_note: `No FDA label matches "${simple.value}" under any name field or anywhere in label text. Most likely: the drug has no SPL label yet (label publication trails approval by weeks), it is not marketed in the US, or the name is misspelled.`,
  });
}

// SPL labels run ~350KB each (full prescribing info with clinical studies,
// pharmacokinetics, tables, etc.). Project to the safety / usage fields an
// agent answering "what is X for / what are the side effects" actually uses.
// Each text field is capped at 5KB; set_id is preserved so callers can fetch
// the raw label out-of-band if they need clinical-studies depth.
const LABEL_TEXT_FIELDS = [
  'indications_and_usage',
  'boxed_warning',
  'warnings_and_cautions',
  'warnings',
  'adverse_reactions',
  'contraindications',
  'drug_interactions',
  'dosage_and_administration',
  'pregnancy',
  'pediatric_use',
  'geriatric_use',
  'overdosage',
] as const;
const LABEL_FIELD_CHAR_CAP = 5000;

function projectLabelRecord(raw: unknown) {
  const r = raw as Record<string, unknown>;
  const openfda = (r.openfda ?? {}) as Record<string, string[] | undefined>;
  const out: Record<string, unknown> = {
    set_id: r.set_id ?? null,
    effective_time: r.effective_time ?? null,
    brand_name: openfda.brand_name?.[0] ?? null,
    generic_name: openfda.generic_name?.[0] ?? null,
    manufacturer: openfda.manufacturer_name?.[0] ?? null,
    route: openfda.route?.[0] ?? null,
    substance_name: openfda.substance_name ?? null,
  };
  for (const f of LABEL_TEXT_FIELDS) {
    const v = r[f];
    if (!v) continue;
    const text = Array.isArray(v) ? v.join('\n\n') : String(v);
    if (text.length > LABEL_FIELD_CHAR_CAP) {
      out[f] = text.slice(0, LABEL_FIELD_CHAR_CAP);
      out[`${f}_truncated`] = true;
    } else {
      out[f] = text;
    }
  }
  return out;
}

function projectDrugRecallRecord(raw: unknown) {
  const r = raw as Record<string, unknown>;
  return {
    recall_number: r.recall_number ?? null,
    status: r.status ?? null,
    classification: r.classification ?? null,
    recalling_firm: r.recalling_firm ?? null,
    product_description: r.product_description ?? null,
    reason_for_recall: r.reason_for_recall ?? null,
    distribution_pattern: r.distribution_pattern ?? null,
    recall_initiation_date: parseFdaDate(r.recall_initiation_date),
    report_date: parseFdaDate(r.report_date),
    voluntary_mandated: r.voluntary_mandated ?? null,
    state: r.state ?? null,
    country: r.country ?? null,
  };
}

async function fdaFoodRecalls(query?: string, limit?: number, skip?: number, apiKey?: string) {
  const l = Math.min(100, Math.max(1, limit ?? 10));
  const s = Math.max(0, skip ?? 0);
  const run = (q: string) => fdaFetch('/food/enforcement.json', `${q ? `search=${encodeQuery(q)}&` : ''}limit=${l}&skip=${s}`, apiKey);
  const { data, query: used, mode } = query
    ? await withTermFallback(query, run)
    : { data: await run(''), query: '', mode: 'as_given' as TermMode };
  return {
    query: query ?? null,
    ...termMatchFields(used, query ?? '', mode),
    total: data.meta?.results?.total ?? 0,
    skip: s,
    results: (data.results ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        recall_number: r.recall_number ?? null,
        status: r.status ?? null,
        classification: r.classification ?? null,
        recalling_firm: r.recalling_firm ?? null,
        product_description: r.product_description ?? null,
        reason_for_recall: r.reason_for_recall ?? null,
        distribution_pattern: r.distribution_pattern ?? null,
        recall_initiation_date: r.recall_initiation_date ?? null,
        report_date: r.report_date ?? null,
        voluntary_mandated: r.voluntary_mandated ?? null,
        state: r.state ?? null,
        country: r.country ?? null,
      };
    }),
  };
}

async function fdaDrugRecalls(query: string, limit?: number, skip?: number, apiKey?: string) {
  const l = Math.min(100, Math.max(1, limit ?? 10));
  const s = Math.max(0, skip ?? 0);
  const { data, query: used, mode } = await withTermFallback(query, (q) =>
    fdaFetch('/drug/enforcement.json', `search=${encodeQuery(q)}&limit=${l}&skip=${s}`, apiKey));

  return {
    total: data.meta?.results?.total ?? 0,
    skip: s,
    ...termMatchFields(used, query, mode),
    results: (data.results ?? []).map(projectDrugRecallRecord),
  };
}

type ShortageRecord = Record<string, unknown> & {
  generic_name?: string;
  company_name?: string;
  status?: string;
  availability?: string;
  shortage_reason?: string;
  therapeutic_category?: string[];
  dosage_form?: string;
  presentation?: string;
  update_type?: string;
  update_date?: string;
  change_date?: string;
  initial_posting_date?: string;
  discontinued_date?: string;
  resolved_note?: string;
  related_info_link?: string;
  package_ndc?: string;
};

function projectShortage(raw: unknown) {
  const r = raw as ShortageRecord;
  const initialPostingDate = parseFdaDate(r.initial_posting_date);
  const changeDate = parseFdaDate(r.change_date);
  const updateDate = parseFdaDate(r.update_date);
  const activityDate = [initialPostingDate, changeDate, updateDate].filter((d): d is string => !!d).sort().at(-1) ?? null;
  return compactObject({
    generic_name: r.generic_name ?? null,
    manufacturer: r.company_name ?? null,
    status: r.status ?? null,
    availability: r.availability ?? null,
    shortage_reason: r.shortage_reason ?? null,
    therapeutic_categories: r.therapeutic_category ?? [],
    dosage_form: r.dosage_form ?? null,
    presentation: r.presentation ?? null,
    package_ndc: r.package_ndc ?? null,
    update_type: r.update_type ?? null,
    initial_posting_date: initialPostingDate,
    change_date: changeDate,
    update_date: updateDate,
    activity_date: activityDate,
    discontinued_date: parseFdaDate(r.discontinued_date),
    resolved_note: r.resolved_note ?? null,
    source_url: r.related_info_link ?? 'https://dps.fda.gov/drugshortages',
  });
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined && (!Array.isArray(item) || item.length > 0)),
  ) as Partial<T>;
}

async function fdaDrugShortages(args: Record<string, unknown>) {
  const apiKey = apiKeyOf(args);
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
  const skip = Math.max(0, Number(args.skip) || 0);
  const filters: string[] = [];
  const drug = typeof args.drug === 'string' ? args.drug.trim() : '';
  const manufacturer = typeof args.manufacturer === 'string' ? args.manufacturer.trim() : '';
  const status = typeof args.status === 'string' ? args.status.trim() : '';
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (drug) {
    filters.push(
      `(${fieldContains('generic_name', drug)}+OR+${fieldContains('openfda.generic_name', drug)}+OR+${fieldContains('openfda.brand_name', drug)})`,
    );
  }
  if (manufacturer) filters.push(fieldContains('company_name', manufacturer));
  if (status) filters.push(`status:${quoted(status)}`);
  if (query) filters.push(`(${query})`);
  const search = filters.length ? `search=${filters.join('+AND+')}&` : '';
  const data = await fdaFetch('/drug/shortages.json', `${search}limit=${limit}&skip=${skip}`, apiKey);
  return {
    query: { drug: drug || null, manufacturer: manufacturer || null, status: status || null, advanced: query || null },
    total: data.meta?.results?.total ?? 0,
    skip,
    returned: data.results?.length ?? 0,
    scope_note: 'FDA national shortage status; not local inventory and not medical advice.',
    data_note: 'FDA shortage fields are sparse; unavailable optional fields are omitted from each record.',
    shortages: (data.results ?? []).map(projectShortage),
  };
}

async function fdaShortageChanges(args: Record<string, unknown>) {
  const apiKey = apiKeyOf(args);
  const days = Math.min(365, Math.max(1, Number(args.days) || 30));
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
  const skip = Math.max(0, Number(args.skip) || 0);
  const status = typeof args.status === 'string' ? args.status.trim() : '';
  const updateTypesRaw = Array.isArray(args.update_type)
    ? args.update_type
    : typeof args.update_type === 'string' && args.update_type.trim()
      ? [args.update_type]
      : [];
  const updateTypes = updateTypesRaw.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim());
  const updateTypeSet = new Set(updateTypes.map((t) => t.toLowerCase()));
  const search = status ? `search=status:${quoted(status)}&` : '';
  const fetchLimit = Math.min(1000, Math.max(100, (skip + limit) * 4));
  const data = await fdaFetch('/drug/shortages.json', `${search}sort=update_date:desc&limit=${fetchLimit}`, apiKey);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rawResults = data.results ?? [];
  const inWindow = rawResults
    .map(projectShortage)
    .filter((r) => typeof r.update_date === 'string' && r.update_date >= cutoff);
  const windowTotal = inWindow.length;
  const filtered = updateTypeSet.size
    ? inWindow.filter((r) => typeof r.update_type === 'string' && updateTypeSet.has(r.update_type.toLowerCase()))
    : inWindow;
  const shortages = filtered.slice(skip, skip + limit);
  const windowTruncated = rawResults.length === fetchLimit && windowTotal === rawResults.length;
  return {
    window_days: days,
    from: cutoff,
    to: new Date().toISOString().slice(0, 10),
    status: status || null,
    update_type: updateTypes.length ? updateTypes : null,
    window_total: windowTotal,
    matched_total: filtered.length,
    window_total_is_lower_bound: windowTruncated,
    skip,
    returned: shortages.length,
    source_order: 'FDA update_date descending',
    scope_note: 'FDA national shortage status; not local inventory and not medical advice.',
    data_note: 'FDA shortage fields are sparse; unavailable optional fields are omitted from each record.',
    shortages,
  };
}

type CrlRecord = Record<string, unknown> & {
  file_name?: string;
  application_number?: string[] | string;
  letter_type?: string;
  letter_date?: string;
  company_name?: string;
  company_rep?: string;
  company_address?: string;
  approver_name?: string;
  approval_name?: string;
  approver_title?: string;
  approval_title?: string;
  approver_center?: string[] | string;
  approval_center?: string[] | string;
  approval_status?: string;
  text?: string;
};

function projectCrl(raw: unknown, includeText = false) {
  const r = raw as CrlRecord;
  const text = typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').trim() : '';
  const fileName = r.file_name ?? null;
  const applicationNumbers = Array.isArray(r.application_number)
    ? r.application_number
    : r.application_number ? [r.application_number] : [];
  return {
    application_number: applicationNumbers[0] ?? null,
    application_numbers: applicationNumbers,
    letter_type: r.letter_type ?? null,
    letter_date: parseFdaDate(r.letter_date),
    approval_status: r.approval_status ?? null,
    company: r.company_name ?? null,
    company_representative: r.company_rep ?? null,
    company_address: r.company_address ?? null,
    approver: r.approver_name ?? r.approval_name ?? null,
    approver_title: r.approver_title ?? r.approval_title ?? null,
    approver_center: r.approver_center ?? r.approval_center ?? [],
    text: includeText ? (r.text ?? null) : undefined,
    text_excerpt: includeText ? undefined : (text ? text.slice(0, 1200) : null),
    text_excerpt_truncated: includeText ? undefined : text.length > 1200,
    document_url: fileName ? `https://download.open.fda.gov/crl/${encodeURIComponent(fileName)}` : null,
    redaction_note: 'FDA may redact confidential commercial information and trade secrets before disclosure.',
  };
}

function crlSearch(args: Record<string, unknown>, requireApplication = false): string {
  const filters: string[] = [];
  const company = typeof args.company === 'string' ? args.company.trim() : '';
  const application = typeof args.application_number === 'string' ? args.application_number.trim() : '';
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const from = typeof args.from_date === 'string' ? args.from_date.trim() : '';
  const to = typeof args.to_date === 'string' ? args.to_date.trim() : '';
  if (requireApplication && !application) throw new Error('application_number is required');
  if (company) filters.push(`company_name:${quoted(company)}`);
  if (application) {
    const normalized = application.replace(/^(NDA|BLA)\s*(\d+)$/i, (_, prefix: string, digits: string) =>
      `${prefix.toUpperCase()} ${digits}`);
    filters.push(`application_number:${quoted(normalized)}`);
  }
  if (query) filters.push(query.includes(':') ? `(${query})` : `text:${quoted(query)}`);
  if (from || to) {
    const start = compactDate(from || '2000-01-01', 'from_date');
    const end = compactDate(to || new Date().toISOString().slice(0, 10), 'to_date');
    filters.push(`letter_date:[${start}+TO+${end}]`);
  }
  return filters.join('+AND+');
}

async function fdaCompleteResponseLetters(args: Record<string, unknown>) {
  const apiKey = apiKeyOf(args);
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
  const skip = Math.max(0, Number(args.skip) || 0);
  const filters = crlSearch(args);
  const includeOther = args.include_other_letter_types === true;
  const search = [filters, includeOther ? '' : `letter_type:${quoted('COMPLETE RESPONSE')}`].filter(Boolean).join('+AND+');
  const data = await fdaFetch('/transparency/crl.json', `${search ? `search=${search}&` : ''}limit=${limit}&skip=${skip}`, apiKey);
  return {
    total: data.meta?.results?.total ?? 0,
    skip,
    returned: data.results?.length ?? 0,
    scope_note: includeOther
      ? 'Includes all letter types published in the FDA CRL dataset; interpret letter_type before drawing a regulatory conclusion.'
      : 'Restricted to letter_type COMPLETE RESPONSE. approval_status is the application status reported in the current FDA dataset, not necessarily its status on the letter date.',
    letters: (data.results ?? []).map((r) => projectCrl(r)),
  };
}

async function fdaCrlDetail(args: Record<string, unknown>) {
  const apiKey = apiKeyOf(args);
  const application = String(args.application_number ?? '').trim();
  const filters = `${crlSearch({ application_number: application }, true)}+AND+letter_type:${quoted('COMPLETE RESPONSE')}`;
  const data = await fdaFetch('/transparency/crl.json', `search=${filters}&limit=100`, apiKey);
  let rows = data.results ?? [];
  const letterDate = typeof args.letter_date === 'string' ? args.letter_date.trim() : '';
  if (letterDate) {
    compactDate(letterDate, 'letter_date');
    rows = rows.filter((r) => parseFdaDate((r as CrlRecord).letter_date) === letterDate);
  }
  if (rows.length === 0) {
    return { found: false, application_number: application, letter_date: letterDate || null, message: 'No disclosed FDA Complete Response Letter matched.' };
  }
  return {
    found: true,
    application_number: application,
    count: rows.length,
    scope_note: 'approval_status is the application status reported in the current FDA dataset, not necessarily its status on the letter date.',
    letters: rows.map((r) => projectCrl(r, true)),
  };
}

async function fdaEventCounts(query: string, countField: string, apiKey?: string) {
  const params = `search=${encodeQuery(query)}&count=${encodeURIComponent(countField)}`;
  let data = await fdaFetch('/drug/event.json', params, apiKey);
  let finalQuery = query;
  let reactionNormalizedFrom: string | null = null;
  let reactionNormalizedTo: string | null = null;
  if ((data.results?.length ?? 0) === 0) {
    const match = REACTION_EXACT_RE.exec(query);
    if (match) {
      for (const candidate of reactionPermutations(match[1])) {
        const alternative = query.replace(REACTION_EXACT_RE, `patient.reaction.reactionmeddrapt.exact:"${candidate}"`);
        const alternativeData = await fdaFetch('/drug/event.json', `search=${encodeQuery(alternative)}&count=${encodeURIComponent(countField)}`, apiKey);
        if ((alternativeData.results?.length ?? 0) > 0) {
          data = alternativeData;
          finalQuery = alternative;
          reactionNormalizedFrom = match[1];
          reactionNormalizedTo = candidate;
          break;
        }
      }
    }
  }

  return {
    query: finalQuery,
    requested_query: query,
    count_field: countField,
    results: (data.results ?? []) as CountResult,
    ...(reactionNormalizedFrom ? {
      reaction_requested: reactionNormalizedFrom,
      reaction_resolved: reactionNormalizedTo,
      reaction_resolution: 'word_order_corrected' as const,
      reaction_resolution_note: `MedDRA preferred-term word order corrected: "${reactionNormalizedFrom}" → "${reactionNormalizedTo}".`,
    } : {}),
  };
}

const FAERS_NOTE = 'FAERS spontaneous reports are not validated causal events and cannot estimate incidence or compare the safety of drugs. Reports can be duplicated, stimulated by publicity, and contain multiple drugs and reactions with no pairwise causal linkage.';

function requiredText(args: Record<string, unknown>, key: string) {
  const value = typeof args[key] === 'string' ? args[key].trim() : '';
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function faersDrugSearch(drug: string) {
  const value = quoted(drug.toUpperCase());
  return `(patient.drug.openfda.brand_name:${value}+OR+patient.drug.openfda.generic_name:${value}+OR+patient.drug.openfda.substance_name:${value}+OR+patient.drug.medicinalproduct:${value})`;
}

function faersReactionSearch(reaction: string) {
  return `patient.reaction.reactionmeddrapt.exact:${quoted(reaction.toUpperCase())}`;
}

function optionalFaersDateSearch(args: Record<string, unknown>) {
  const from = typeof args.from_date === 'string' && args.from_date.trim() ? compactDate(args.from_date.trim(), 'from_date') : null;
  const to = typeof args.to_date === 'string' && args.to_date.trim() ? compactDate(args.to_date.trim(), 'to_date') : null;
  if (from && to && from > to) throw new Error('from_date must not be after to_date');
  // A zero-width window (from == to, usually today's date twice) is never what
  // anyone means — FAERS reports arrive on a lag, so it returns total_reports 0
  // as a clean success and the answer reads as "no adverse events exist"
  // (fleet #495 defect 2: the router copied the dated example's SHAPE and
  // invented same-day values). Reject with the fix in the message instead.
  if (from && to && from === to) {
    throw new Error(
      `user_error: from_date and to_date are the same day (${args.from_date}) — a zero-width window over lagged FAERS data returns 0 reports for any drug. Omit both dates for all-time counts, or pass a real window (e.g. from_date "2020-01-01").`,
    );
  }
  return from || to ? `receivedate:[${from ?? '20040101'}+TO+${to ?? new Date().toISOString().slice(0, 10).replace(/-/g, '')}]` : null;
}

function combineSearch(...parts: Array<string | null>) { return parts.filter(Boolean).join('+AND+'); }

async function faersTotal(search: string | null, apiKey?: string) {
  const params = search ? `search=${encodeQuery(search)}&limit=1` : 'limit=1';
  const data = await fdaFetch('/drug/event.json', params, apiKey);
  return data.meta?.results?.total ?? 0;
}

async function fdaFaersSignalSummary(args: Record<string, unknown>) {
  const apiKey = apiKeyOf(args);
  const drug = requiredText(args, 'drug'), reaction = requiredText(args, 'reaction');
  const resolvedReaction = await resolveFaersReaction(reaction, apiKey);
  const date = optionalFaersDateSearch(args), drugSearch = faersDrugSearch(drug), reactionSearch = faersReactionSearch(resolvedReaction.resolved);
  const [all, drugReports, reactionReports, joint] = await Promise.all([
    faersTotal(date, apiKey), faersTotal(combineSearch(drugSearch, date), apiKey), faersTotal(combineSearch(reactionSearch, date), apiKey),
    faersTotal(combineSearch(drugSearch, reactionSearch, date), apiKey),
  ]);
  const raw = { drug_and_reaction: joint, drug_without_reaction: Math.max(0, drugReports - joint),
    reaction_without_drug: Math.max(0, reactionReports - joint), neither: Math.max(0, all - drugReports - reactionReports + joint) };
  const insufficientData = all === 0 || drugReports === 0 || reactionReports === 0;
  const correctionApplied = !insufficientData && Object.values(raw).some((value) => value === 0);
  const corrected = Object.values(raw).map((value) => correctionApplied ? value + 0.5 : value);
  const [a, b, c, d] = corrected;
  const reportingOddsRatio = insufficientData ? null : (a * d) / (b * c);
  const standardError = insufficientData ? null : Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d);
  const proportionalReportingRatio = insufficientData ? null : (a / (a + b)) / (c / (c + d));
  return {
    drug, reaction: resolvedReaction.resolved, ...reactionResolutionFields(resolvedReaction), window: { from: args.from_date ?? null, to: args.to_date ?? null }, reports: { all, drug: drugReports, reaction: reactionReports },
    contingency_table: raw, sufficient_data_for_metrics: !insufficientData, continuity_correction_applied: correctionApplied,
    reporting_odds_ratio: reportingOddsRatio,
    reporting_odds_ratio_95pct_ci: insufficientData ? null : [Math.exp(Math.log(reportingOddsRatio!) - 1.96 * standardError!), Math.exp(Math.log(reportingOddsRatio!) + 1.96 * standardError!)],
    proportional_reporting_ratio: proportionalReportingRatio,
    interpretation: `${FAERS_NOTE} ROR and PRR are report-level disproportionality routing statistics only; elevated values are not proof of a safety signal and require case review and other evidence.`,
  };
}

async function fdaFaersReactionProfile(args: Record<string, unknown>) {
  const apiKey = apiKeyOf(args);
  const drug = requiredText(args, 'drug'), date = optionalFaersDateSearch(args);
  const search = combineSearch(faersDrugSearch(drug), date);
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
  const [top, serious] = await Promise.all([
    fdaFetch('/drug/event.json', `search=${encodeQuery(search)}&count=patient.reaction.reactionmeddrapt.exact`, apiKey),
    fdaFetch('/drug/event.json', `search=${encodeQuery(search)}&count=serious`, apiKey),
  ]);
  const reactions = ((top.results ?? []) as CountResult).slice(0, limit);
  const seriousCounts = Object.fromEntries(((serious.results ?? []) as CountResult).map((row) => {
    const term = String(row.term);
    return [term === '1' ? 'serious' : term === '2' ? 'non_serious' : term, row.count];
  }));
  return { drug, window: { from: args.from_date ?? null, to: args.to_date ?? null }, total_reports: Object.values(seriousCounts).reduce((a, b) => a + Number(b), 0),
    serious_counts: seriousCounts, top_co_reported_reactions: reactions, interpretation: FAERS_NOTE };
}

async function fdaFaersTrend(args: Record<string, unknown>) {
  const apiKey = apiKeyOf(args);
  const drug = requiredText(args, 'drug'), reaction = typeof args.reaction === 'string' ? args.reaction.trim() : '';
  const from = compactDate(requiredText(args, 'from_date'), 'from_date'), to = compactDate(requiredText(args, 'to_date'), 'to_date');
  if (from > to) throw new Error('from_date must not be after to_date');
  const fromTime = Date.parse(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00Z`);
  const toTime = Date.parse(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T00:00:00Z`);
  if (toTime - fromTime > 730 * 86_400_000) throw new Error('FAERS trend window may span at most 730 days');
  const resolvedReaction = reaction ? await resolveFaersReaction(reaction, apiKey) : null;
  const search = combineSearch(faersDrugSearch(drug), resolvedReaction ? faersReactionSearch(resolvedReaction.resolved) : null, `receivedate:[${from}+TO+${to}]`);
  const data = await fdaFetch('/drug/event.json', `search=${encodeQuery(search)}&count=receivedate`, apiKey);
  const months = new Map<string, number>();
  for (const row of (data.results ?? []) as CountResult) {
    const term = String(row.time ?? row.term ?? ''); if (!/^\d{8}$/.test(term)) continue;
    const month = `${term.slice(0, 4)}-${term.slice(4, 6)}`;
    months.set(month, (months.get(month) ?? 0) + row.count);
  }
  return { drug, reaction: resolvedReaction?.resolved ?? null, ...(resolvedReaction ? reactionResolutionFields(resolvedReaction) : {}), from_date: args.from_date, to_date: args.to_date,
    months: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, reports]) => ({ month, reports })),
    interpretation: `${FAERS_NOTE} Changes over time can reflect utilization, publicity, reporting practices, duplicates, and quarterly database updates rather than changes in clinical risk.` };
}

async function fdaApplicationHistory(args: Record<string, unknown>) {
  const apiKey = apiKeyOf(args);
  const raw = requiredText(args, 'application_number').toUpperCase().replace(/\s+/g, '');
  if (!/^(NDA|ANDA|BLA)\d+$/.test(raw)) throw new Error('application_number must be NDA, ANDA, or BLA followed by digits');
  const data = await fdaFetch('/drug/drugsfda.json', `search=application_number:${quoted(raw)}&limit=1`, apiKey);
  const projected = (data.results ?? []).map(projectDrugsfdaRecord)[0] as ReturnType<typeof projectDrugsfdaRecord> | undefined;
  if (!projected) return { found: false, application_number: raw, message: 'No Drugs@FDA application matched.' };
  return { found: true, ...projected,
    submissions: [...projected.submissions].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? ''))),
    interpretation: 'Submission type, status, class, and review-priority codes require regulatory context. A submission action does not by itself establish indication scope, exclusivity, patent position, current marketing, or commercial significance.' };
}

async function fdaPostmarketRiskProfile(args: Record<string, unknown>) {
  const apiKey = apiKeyOf(args);
  const drug = requiredText(args, 'drug'), date = optionalFaersDateSearch(args);
  const faersSearch = combineSearch(faersDrugSearch(drug), date);
  const name = quoted(drug.toUpperCase());
  const labelSearch = `(openfda.brand_name:${name}+OR+openfda.generic_name:${name}+OR+openfda.substance_name:${name})`;
  const recallSearch = `(openfda.brand_name:${name}+OR+openfda.generic_name:${name})`;
  const reactionLimit = Math.min(50, Math.max(1, Number(args.reaction_limit) || 20));
  const recallLimit = Math.min(25, Math.max(1, Number(args.recall_limit) || 10));
  const [reactions, serious, labels, recalls] = await Promise.all([
    fdaFetch('/drug/event.json', `search=${encodeQuery(faersSearch)}&count=patient.reaction.reactionmeddrapt.exact`, apiKey),
    fdaFetch('/drug/event.json', `search=${encodeQuery(faersSearch)}&count=serious`, apiKey),
    fdaFetch('/drug/label.json', `search=${encodeQuery(labelSearch)}&limit=5`, apiKey),
    fdaFetch('/drug/enforcement.json', `search=${encodeQuery(recallSearch)}&limit=${recallLimit}`, apiKey),
  ]);
  return {
    drug, window: { from: args.from_date ?? null, to: args.to_date ?? null },
    faers: { top_co_reported_reactions: ((reactions.results ?? []) as CountResult).slice(0, reactionLimit), seriousness: serious.results ?? [] },
    labels: (labels.results ?? []).map(projectLabelRecord), recalls: (recalls.results ?? []).map(projectDrugRecallRecord),
    scope_note: `${FAERS_NOTE} Label and recall matches can include multiple manufacturers or formulations sharing a name. This combined view is for review routing, not a validated causal assessment or comparative safety ranking.`,
  };
}

/* ── callTool dispatcher ───────────────────────────────────────────── */

// FDA warning letters aren't in openFDA (api.fda.gov) and the official Data
// Dashboard API is key-gated. The fda.gov warning-letters page serves a keyless
// Drupal-views JSON endpoint (~3,660 letters, updated daily, newest first) with
// solr fulltext via search_api_fulltext — we parse its HTML-fragment cells.
//
// That solr index covers the letter BODY as well as the recipient column, which
// is why `search` cannot be handed to it directly when the caller means "letters
// issued to X": search_api_fulltext=Merck returns exactly one letter, addressed
// to Elanco Animal Health, because Merck is named somewhere inside it. Attributing
// an enforcement action to the wrong firm is the most consequential mistake this
// pack can make, so recipient matching is the default (fleet #660).
//
// The upstream has no recipient-scoped filter, but a letter issued to X always
// contains X in its indexed text, so the fulltext hit set is a strict SUPERSET of
// the recipient matches. We page that superset and filter on the company column.
const WL_PAGE = 200;       // upstream honours length=200; 300 is not larger
const WL_SCAN_CAP = 600;   // 3 upstream requests, bounded for the CF CPU budget
// The oldest letter in the fda.gov published view, re-measured 2026-09-16 by
// paging to the end (start=3675 of 3,680). It moves forward as FDA retires old
// letters, so treat it as a floor and re-measure rather than trusting it.
const WL_PUBLISHED_FROM = '2021-01';

// Corporate suffixes carry no identifying signal — "Merck Sharp & Dohme LLC"
// should match a company recorded as "Merck Sharp & Dohme Corp".
const WL_STOP = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'plc', 'gmbh', 'ag', 'sa', 'nv', 'bv', 'as', 'ab', 'oy', 'spa',
  'srl', 'pty', 'pte', 'kk', 'usa', 'us', 'the', 'and', 'dba', 'group', 'holdings',
]);

function wlTokens(v: string): string[] {
  return v
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !WL_STOP.has(t));
}

// A recipient matches when every identifying token of the query appears in the
// company name. "Merck" matches "Merck Sharp & Dohme"; "Sun Pharmaceutical" does
// not match "Sun Foods".
function wlRecipientMatches(company: string, query: string): boolean {
  const target = wlTokens(company);
  const wanted = wlTokens(query);
  if (!wanted.length) return true;
  return wanted.every((w) => target.some((t) => t === w || t.startsWith(w)));
}

type WlRow = {
  posted_date: string | null;
  letter_issue_date: string | null;
  company: string;
  issuing_office: string;
  subject: string;
  url: string | null;
};

async function wlFetchPage(search: string, start: number, length: number) {
  const params = new URLSearchParams({
    draw: '1',
    start: String(start),
    length: String(length),
    view_display_id: 'warning_letter_solr_block',
    view_name: 'warning_letter_solr_index',
  });
  if (search) params.set('search_api_fulltext', search);

  const res = await pwFetch(`https://www.fda.gov/datatables/views/ajax?${params}`, {
    headers: { 'User-Agent': 'pipeworx-mcp-openfda/1.0 (+https://pipeworx.io)', Accept: 'application/json' },
  });
  if (!res.ok) throw await httpError(res, 'FDA warning letters');
  const data = (await res.json()) as { recordsTotal?: number; recordsFiltered?: number; data?: string[][] };

  const strip = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#039;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
  const isoDate = (h: string) => h.match(/datetime="(\d{4}-\d{2}-\d{2})/)?.[1] ?? (strip(h) || null);
  const rows: WlRow[] = (data.data ?? []).map((row) => {
    const href = (row[2] ?? '').match(/href="([^"]+)"/)?.[1];
    return {
      posted_date: isoDate(row[0] ?? ''),
      letter_issue_date: isoDate(row[1] ?? ''),
      company: strip(row[2] ?? ''),
      issuing_office: strip(row[3] ?? ''),
      subject: strip(row[4] ?? ''),
      url: href ? `https://www.fda.gov${href}` : null,
    };
  });
  return { rows, filtered: data.recordsFiltered ?? rows.length, total: data.recordsTotal ?? null };
}

// FDA publishes warning letters in two places and the difference between them
// is a DATE, not a center.
//
// www.fda.gov's warning-letter view — what wlFetchPage above reads — is a
// ROLLING window. Measured 2026-09-16: 3,680 letters spanning 2021-01-05 to
// 2026-09-15, with every center represented (CDER, CFSAN, CTP, CVM, Human
// Foods). Nothing is systematically excluded from it except age. Hospira's real
// 2017-02-14 CGMP letter answers `candidates_scanned: 0` there for that one
// reason, and this tool reported the miss as "no warning letter matches
// \"Hospira\" at all" — a confident absence about a letter that exists.
//
// The FDA Data Dashboard's compliance_actions resource carries the same
// enforcement events back to at least 2010, as ROWS rather than documents:
// firm, FEI number, place, date, ActionType. There is no subject line and no
// link to the letter text — those exist only in the published view — so these
// rows answer "did this firm get one, and when", not "what did it say". The
// response says which source each row came from rather than blending them.
//
// Consulted ONLY when the published view yields no addressed match, so every
// search that works today returns byte-identical numbers (the {"search":
// "Johnson"} and {"search":"Elanco"} controls on fleet #2123 are unchanged).
// The recipient matcher is reused UNCHANGED — #2123 is explicit that it is
// sound and that loosening it would break Johnson.
const WL_ARCHIVE_URL = 'https://api-datadashboard.fda.gov/v1/compliance_actions';
const WL_ARCHIVE_ROWS = 100;

// The Data Dashboard credential is a PAIR ("email:key"), and it is NOT the
// api.data.gov key this pack's platformKeyEnv supplies. A pack is injected only
// with what IT declares (fleet #137/#561/#629 — compound packs inherit
// nothing), so the gateway forwards PLATFORM_FDA_DASHBOARD_KEY here under the
// NAMED argument `_fdaDashboardKey`, which cannot collide with the `_apiKey`
// that means something else in this pack.
type WlArchiveResult = { rows: WlRow[] } | { error: string };

/**
 * One archive request, with a shorter deadline and a single retry.
 *
 * Measured 2026-09-16 across two gateway deploys: the FIRST call to
 * api-datadashboard.fda.gov after a worker rolls times out (2 of 2), and every
 * warm call afterwards succeeds (6 of 6, ~3s each). A cold isolate paying for a
 * fresh TLS handshake to a host nothing else in this pack talks to.
 *
 * Two attempts at 10s is strictly CHEAPER in the worst case than the single 25s
 * default this used to inherit, so the retry costs nothing and converts the
 * cold-start miss into a hit. It matters more than the latency: this leg only
 * runs when the published list found nothing, so a timeout here is the
 * difference between "no letters in either source" and a real 2017 letter.
 */
async function wlArchiveFetch(user: string, key: string, body: string): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchWithTimeout(
        WL_ARCHIVE_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'pipeworx-mcp-openfda/1.0 (+https://pipeworx.io)',
            'Authorization-User': user,
            'Authorization-Key': key,
          },
          body,
        },
        'FDA Data Dashboard',
        10_000,
      );
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function wlArchiveLookup(search: string, cred: unknown): Promise<WlArchiveResult> {
  if (typeof cred !== 'string' || !cred.includes(':')) {
    return { error: 'no FDA Data Dashboard credential is available to this call' };
  }
  const split = cred.indexOf(':');
  const body = JSON.stringify({
    start: 1,
    rows: WL_ARCHIVE_ROWS,
    sort: 'ActionTakenDate',
    sortorder: 'DESC',
    columns: ['LegalName', 'FEINumber', 'City', 'State', 'CountryName', 'ProductType', 'ActionTakenDate', 'ActionType'],
    filters: { LegalName: [search], ActionType: ['Warning Letter'] },
  });
  let res: Response;
  try {
    res = await wlArchiveFetch(cred.slice(0, split), cred.slice(split + 1), body);
  } catch (err) {
    // Only ever surfaced as a FRAGMENT embedded mid-sentence in `archive_note`
    // below, never as a top-level error at position 0 — drop, don't hoist.
    return { error: `FDA Data Dashboard unreachable (${dropClassPrefix(err instanceof Error ? err.message : String(err))})` };
  }
  if (!res.ok) return { error: `FDA Data Dashboard returned HTTP ${res.status}` };

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { error: 'FDA Data Dashboard returned a non-JSON body' };
  }
  const raw = Array.isArray(parsed) ? parsed : ((parsed as Record<string, unknown>)?.result as unknown[]) ?? [];
  if (!Array.isArray(raw)) return { error: 'FDA Data Dashboard returned an unexpected shape' };

  const rows: WlRow[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    // Re-check ActionType in OUR code rather than trusting the filter. An
    // unrecognised filter value silently returning the UNFILTERED set is the
    // single most common upstream trap in this repo (three-for-three when last
    // counted), and here it would quietly relabel recalls and seizures as
    // warning letters — a wrong answer with a clean 200.
    if (String(r.ActionType ?? '') !== 'Warning Letter') continue;
    const company = String(r.LegalName ?? '').trim();
    if (!company) continue;
    const place = [r.City, r.State, r.CountryName].filter((x) => typeof x === 'string' && x).join(', ');
    rows.push({
      posted_date: null,
      letter_issue_date: typeof r.ActionTakenDate === 'string' ? r.ActionTakenDate.slice(0, 10) : null,
      company,
      // The archive has no issuing office. Say what it DOES have rather than
      // leaving a field that reads as "we looked and there was none".
      issuing_office: r.ProductType ? `${r.ProductType} (product type; the archive does not record the issuing office)` : '',
      subject: place ? `Warning Letter — ${place}` : 'Warning Letter',
      url: null,
    });
  }
  return { rows };
}

async function fdaWarningLetters(args: Record<string, unknown>): Promise<unknown> {
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
  const search = typeof args.search === 'string' ? args.search.trim() : '';
  const mode = args.match === 'fulltext' ? 'fulltext' : 'recipient';

  // No search term, or explicit fulltext mode: one page, straight through.
  if (!search || mode === 'fulltext') {
    const { rows, filtered } = await wlFetchPage(search, 0, limit);
    return {
      total_matching: filtered,
      search: search || null,
      match: search ? 'fulltext' : null,
      returned: rows.length,
      order: 'newest posted first',
      letters: rows.map((r) => ({
        ...r,
        matched_field: !search ? null : wlRecipientMatches(r.company, search) ? 'company' : 'letter_text',
      })),
      ...(search
        ? { scope_note: 'Fulltext mode: matched_field:"letter_text" means the letter only MENTIONS the term — it was issued to the company named in `company`.' }
        : {}),
    };
  }

  // Recipient mode: page the fulltext superset, keep only addressed matches.
  const matched: WlRow[] = [];
  let scanned = 0;
  let filtered = 0;
  for (let start = 0; start < WL_SCAN_CAP; start += WL_PAGE) {
    const page = await wlFetchPage(search, start, WL_PAGE);
    filtered = page.filtered;
    scanned += page.rows.length;
    for (const r of page.rows) if (wlRecipientMatches(r.company, search)) matched.push(r);
    if (!page.rows.length || scanned >= filtered) break;
  }
  const scanComplete = scanned >= filtered;

  if (!matched.length) {
    // Nothing addressed to this firm in the published (2021+) view. Before
    // reporting an absence, ask the archive that holds the older letters.
    const archive = await wlArchiveLookup(search, args._fdaDashboardKey);
    const archiveRows = 'rows' in archive ? archive.rows.filter((r) => wlRecipientMatches(r.company, search)) : [];

    if (archiveRows.length) {
      return {
        total_matching: archiveRows.length,
        search,
        match: 'recipient',
        returned: Math.min(limit, archiveRows.length),
        order: 'newest issued first',
        letters: archiveRows.slice(0, limit).map((r) => ({ ...r, matched_field: 'company', source: 'fda-data-dashboard-archive' })),
        candidates_scanned: scanned,
        scan_complete: scanComplete,
        fulltext_matches: filtered,
        source: 'fda-data-dashboard-archive',
        scope_note: `The fda.gov published warning-letter list (${WL_PUBLISHED_FROM} onwards) holds nothing addressed to "${search}", so these come from FDA's Data Dashboard compliance-actions archive, which records older letters as rows: firm, place, product type and the date the letter was issued. There is no subject line or letter URL for them — FDA does not republish the text of letters this old. For the full record of an archive letter, ask FDA for the document by firm and date.`,
      };
    }

    return {
      found: false,
      reason: 'no_letters_to_this_recipient',
      total_matching: 0,
      search,
      match: 'recipient',
      returned: 0,
      letters: [],
      candidates_scanned: scanned,
      scan_complete: scanComplete,
      fulltext_matches: filtered,
      // Whether the archive was actually READ is part of the answer. An
      // absence found across both sources and an absence found in one of them
      // with the other unreachable are different facts, and reporting them
      // identically is how a credential outage becomes "this company is clean".
      archive_checked: !('error' in archive),
      ...('error' in archive ? { archive_note: `The pre-${WL_PUBLISHED_FROM} archive was NOT consulted: ${archive.error}. This answer covers the fda.gov published list only.` } : {}),
      hint: filtered
        ? `No warning letter was ISSUED TO a company matching "${search}", though ${filtered} letter(s) mention it somewhere in their text. Re-run with match:"fulltext" to see those — they are other firms' letters.`
        : `No warning letter matches "${search}"${'error' in archive ? ' in the fda.gov published list' : ' in either the fda.gov published list or FDA\'s older compliance-actions archive'}. Try a shorter form of the company name, or fda_drug_recalls / fda_complete_response_letters for other enforcement records.`,
    };
  }

  return {
    total_matching: matched.length,
    search,
    match: 'recipient',
    returned: Math.min(limit, matched.length),
    order: 'newest posted first',
    letters: matched.slice(0, limit).map((r) => ({ ...r, matched_field: 'company', source: 'fda-gov-published-list' })),
    candidates_scanned: scanned,
    scan_complete: scanComplete,
    fulltext_matches: filtered,
    source: 'fda-gov-published-list',
    // Said even on the SUCCESS path, deliberately. A firm with one 2024 letter
    // and ten from 2015 gets a confident "1" here, and the count is only true
    // of the window. The archive is not merged in — that would change every
    // count this tool has ever returned — so the window is disclosed instead.
    archive_note: `Counted over the fda.gov published list, which begins ${WL_PUBLISHED_FROM}. Letters older than that are not in this count; fda_compliance_actions covers them back to 2010.`,
    ...(scanComplete
      ? {}
      : {
          scope_note: `Counted over the first ${scanned} of ${filtered} fulltext candidates, so total_matching is a floor. Narrow the search term for an exact count.`,
        }),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'fda_warning_letters':
      return fdaWarningLetters(args);
    case 'fda_drug_events':
      return fdaDrugEvents(
        args.query as string,
        args.limit as number | undefined,
        args.skip as number | undefined,
        apiKeyOf(args),
      );
    case 'fda_drug_approvals':
      return fdaDrugApprovals(
        args.query as string,
        args.limit as number | undefined,
        args.skip as number | undefined,
        args.sort as string | undefined,
        apiKeyOf(args),
      );
    case 'fda_applications_by_cik':
      return fdaApplicationsByCik(
        (args.cik_or_ticker ?? args.cik ?? args.ticker) as string | undefined,
        args.limit as number | undefined,
        apiKeyOf(args),
      );
    case 'fda_novel_approvals':
      return fdaNovelApprovals(args);
    case 'fda_drug_labels':
      return fdaDrugLabels(
        args.query as string,
        args.limit as number | undefined,
        args.skip as number | undefined,
        apiKeyOf(args),
      );
    case 'fda_food_recalls':
      return fdaFoodRecalls(
        args.query as string | undefined,
        args.limit as number | undefined,
        args.skip as number | undefined,
        apiKeyOf(args),
      );
    case 'fda_drug_recalls':
      return fdaDrugRecalls(
        args.query as string,
        args.limit as number | undefined,
        args.skip as number | undefined,
        apiKeyOf(args),
      );
    case 'fda_drug_shortages':
      return fdaDrugShortages(args);
    case 'fda_shortage_changes':
      return fdaShortageChanges(args);
    case 'fda_complete_response_letters':
      return fdaCompleteResponseLetters(args);
    case 'fda_crl_detail':
      return fdaCrlDetail(args);
    case 'fda_event_counts':
      return fdaEventCounts(
        args.query as string,
        args.count_field as string,
        apiKeyOf(args),
      );
    case 'fda_faers_signal_summary':
      return fdaFaersSignalSummary(args);
    case 'fda_faers_reaction_profile':
      return fdaFaersReactionProfile(args);
    case 'fda_faers_trend':
      return fdaFaersTrend(args);
    case 'fda_application_history':
      return fdaApplicationHistory(args);
    case 'fda_postmarket_risk_profile':
      return fdaPostmarketRiskProfile(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;

# Local Backend / AI / Postman testing

This is a separate development harness, not production conversation integration.
The NestJS runner binds only to 127.0.0.1 and is never imported by AppModule or
the production start command. FastAPI uses its existing canonical route and
Groq/deterministic orchestration. Production still fails closed without its real
conversation adapter. The two repositories and their Git histories stay separate.

## Prepare an isolated fixture

Install Backend dependencies with `npm ci`, then `npm run build`. Start a disposable
local PostgreSQL server listening on 127.0.0.1:55439 with an isolated development
postgres role. Set `AI_LOCAL_PG_PORT` if your local server uses another port.
Never point this setup at a tunnel, shared database or production instance.

```sh
node dev/ai-local-setup.cjs
```

The setup creates one random `brandora_ai_local_<32-hex>` database and applies
existing checked-in migrations only to that new database. No new migration,
reset, cleanup SQL or conversation table is introduced. It creates disposable
OWNER membership and real Products/Variants/Inventory using existing services.
No account login credentials are generated or shared with AI.

Private output under ignored `.tmp/ai-local/`:

- `backend.env`: local database URL, pinned fixture identities, distinct service
  credentials and private RSA signing key.
- `ai.env`: matching service credentials and public RSA verification key only.
- `fixture.json`: fixture IDs and expected observations, without service secrets.

Setup refuses to overwrite any existing output. If the directory already exists,
use a fresh one: `node dev/ai-local-setup.cjs .tmp/ai-local-ready` and substitute
that directory in startup commands. Databases are retained; no automatic deletion
or destructive SQL runs. Keep these private files out of Git and Postman.

The fixture contains a cotton T-shirt with declared Color/Size options and only
three real combinations: Black/L at 275.00 with stock 7, Black/M inheriting
250.00 with stock 0, and White/L at 290.00 with stock 3. White/M does not exist.
A separate simple linen shirt is untracked (quantity null). Another business
contains a foreign product used to verify tenant isolation.

## Start the two services

Backend terminal, from its repository:

```sh
node --env-file=.tmp/ai-local/backend.env dev/ai-local.cjs
```

AI terminal, from its independent repository, using a Python virtual environment
with `pip install -r requirements-dev.txt`:

```sh
python -m app.local --env-file ../brandora-backend/.tmp/ai-local/ai.env
```

This relative path assumes sibling checkouts, not a particular username. You may
instead privately copy only the AI fragment into that repository's ignored
`.env.local` and pass `--env-file .env.local`. Never replace an existing private
file blindly. Do not copy Backend's private key. Neither runner loads an implicit
application .env; explicit settings must satisfy the local-only gates.

Backend requires `NODE_ENV=development`, `APP_ENV=local`, `AI_LOCAL_ENABLED=true`,
the pinned `AI_LOCAL_BUSINESS_ID`/`AI_LOCAL_OWNER_ID` and `AI_LOCAL_DATABASE_URL`.
It verifies the actual database name, fixed fixture marker and active OWNER
membership at startup and on requests. Caller-provided scope is rejected.
Non-loopback origins, other database names and Railway environment markers fail
before use. The Backend's normal `AI_INTEGRATION_ENABLED` remains false.

AI requires explicit local mode and canonical route activation in its private
local fragment. Deployed APP_ENV/markers are refused; its listener is loopback
only. Its production launcher and Railway configuration are unchanged.

## Postman

Import `postman/brandora-ai-local.postman_collection.json`. Only its baseUrl is
needed; there are no service credentials or signing keys in the collection.

```http
POST http://127.0.0.1:3099/dev/ai/respond
Content-Type: application/json
X-Brandora-Local-Test: true

{"message":"بكام التيشيرت الأسود مقاس L؟"}
```

Only `message` is accepted: nonblank text, at most 2000 code points. Do not supply
business/customer/conversation/message IDs, history, owner JWTs or service keys.
Browser cross-origin requests are refused; no CORS/proxy/tunnel exposure is
supported. At most four synthetic requests run concurrently.

Backend creates fresh synthetic IDs for this single request, signs the exact
canonical body and calls FastAPI. AI reads real NestJS tools over HTTP; those
reuse domain services and PostgreSQL. The request context expires within 60
seconds and is discarded after the response. It is not saved conversation data.

An observed rules-mode price reply may look like this; wording can vary:

```json
{
  "intent": "INQUIRY",
  "reply": "مقاس L الأسود بـ275 جنيه",
  "requiresReview": false,
  "orderCandidate": null
}
```

Inspect response headers:

| Header                      | Meaning                                                    |
| --------------------------- | ---------------------------------------------------------- |
| X-Brandora-Test-Mode        | synthetic-no-history                                       |
| X-Brandora-Backend-Source   | local-postgresql                                           |
| X-Brandora-Tool-Calls       | Successful real Backend tool callbacks during this request |
| X-AI-Understanding-Provider | Actual understanding provider, or unknown                  |
| X-AI-Reply-Provider         | Actual composition provider, or deterministic fallback     |
| X-Brandora-Live-Groq        | true only when both stages report groq                     |
| X-AI-History-Status         | not_requested, unavailable, partial or complete            |

Each request is independent: a subsequent "طب مقاس L بكام؟" has no stored history
and should clarify. Use a complete product question to inspect price or stock.
Multiple matching products/options also need clarification. Partial discovery
must not be treated as proof of catalog completeness or product absence.
No order candidate is accepted and no order or stock mutation is performed.

## Rules versus real Groq

`AI_LOCAL_PROVIDER=rules` in the AI fragment disables model requests even if a key
is otherwise configured. For an explicitly approved live local test, configure
`GROQ_API_KEY` privately, change only that local fragment to
`AI_LOCAL_PROVIDER=groq`, then restart AI. Existing `GROQ_MODELS` and `CHAT_*`
budgets apply. Never paste the key into Postman, source, screenshots or reports.
Missing Groq configuration refuses startup in Groq mode. Runtime failures may
fall back: record the actual provider headers rather than treating HTTP 200 or
the configured mode as live-model success. A greeting may legitimately need no
model; use a complete product/price question to test model stages.

Local AI deadline is at most 25 seconds; Backend waits at most 30 seconds,
including body reads, without retries. Canonical output retains the four E0-3
fields and is bounded to 20000 code points / 65536 serialized UTF-8 bytes.
Provider, database, malformed output and timeout failures are sanitized.

## Repeatable verification

```sh
npm run build
npm test
node verification/ai-local-http.cjs --ai-dir ../brandora-ai --python ../brandora-ai/.venv/Scripts/python.exe
```

On Linux/macOS use the corresponding .venv/bin/python path. Or set
`AI_LOCAL_PYTHON` to an installed Python command/path. The HTTP verifier creates
another fresh local database, starts its own NestJS and FastAPI listeners on
loopback ports, forces rules mode, tests real SQL-backed tool reads and security,
then stops only the two processes it started. It retains the fixture database
and records non-secret results in ignored `.tmp/ai-local-http-results.json`.

Jest tests are mocked/unit checks. AI's pytest tests use mocked transports.
The HTTP verifier uses real local HTTP and PostgreSQL but no real model.
None of those layers proves live Groq, inbox delivery or production readiness.

For already running local services, replay the collection with
`node verification/replay-ai-postman.cjs`. For offline cross-contract validation,
use `node verification/ai-cross-contract.cjs --ai-dir ../brandora-ai --python <python>`.
These reusable tools do not load ignored AI snapshots. Results and test-layer
distinctions are in [local verification evidence](local-verification.md).

To prepare Malak's source-only archive, use
`node dev/package-ai-handoff.cjs ../brandora-ai`. It packages only the explicit
reviewed source/documentation allowlist, with a SHA-256 manifest, into a new
ignored output ZIP. It excludes private environments, keys, database files and
Git history. Review the AI repository's docs/HANDOFF.md before sending it.

## Troubleshooting and future persistence

- Startup refused: verify explicit local flags, distinct credentials, paired keys,
  fresh fixture IDs/database and no deployed-service markers.
- Connection refused: check PostgreSQL first, then both loopback listeners and
  matching AI_BASE_URL/BACKEND_BASE_URL ports.
- 403 from Postman: include X-Brandora-Local-Test: true; do not send Origin or
  route the request through a public proxy.
- 400: send only message text; ensure UTF-8 JSON (a legacy PowerShell pipe may
  replace Arabic text with question marks). The collection sends UTF-8.
- 503: inspect only sanitized errors, configuration and provider headers; never
  log request headers, keys or full signed context tokens.
- Clarification: supply product identity/options; history is intentionally absent.

Future transition: synthetic local message -> persisted inbound message ->
authorized signed AI request -> strict on-demand historical snapshot -> atomically
persisted AI reply. Do not register the synthetic registry in production,
infer chronology from UUIDs, silently truncate stored content or enable Orders.
Production conversation persistence, chronology/length alignment, reply
idempotency, ingress verification and real end-to-end acceptance remain separate.
Product images use Cloudinary; image matching and permanent Excel storage remain deferred.

After the Product physical-name migration, use the setup command with a fresh
fixture directory/database for the current Backend. Older retained local fixture
databases may still use CatalogItem; they are preserved and are not automatically
migrated or reset by this change. Do not reuse an old private fixture configuration
with a new compiled Backend until that disposable target is explicitly upgraded.

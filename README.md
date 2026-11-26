# Brandora AI

FastAPI service that answers WhatsApp customers in Egyptian Arabic. It is **read-only**:
it never writes to the database, never calls WhatsApp and never creates orders
(`orderCandidate` is always `null`; purchases are reported as `PURCHASE_INTENT`).

```
Backend (NestJS + Neon)  --POST /v2/ai/respond-->  AI  --POST /internal/ai/data-->  Backend
   signs JWT (RS256), 5-field body                  reads products + history, calls GroqCloud
```

Canonical route: `POST /v2/ai/respond`. Contract: Backend `docs/ai-contract.md`
(+ [FINAL_BACKEND_AI_HANDOFF](docs/FINAL_BACKEND_AI_HANDOFF.md)). LLM provider: **GroqCloud**
(`GROQ_API_KEY`); without a key the service answers with deterministic Python rules.

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
make verify                                   # compile + 1598 tests + offline evaluation
GROQ_API_KEY=... python tools/test_groq_live.py
```

Full step-by-step (Groq, Backend on Neon, end-to-end): **[docs/TESTING_GUIDE_AR.md](docs/TESTING_GUIDE_AR.md)**.

## Layout

| Path | What |
|---|---|
| `app/clients`, `app/data` | Backend tool client (6 read-only tools) and retrieval |
| `app/chat`, `app/pipeline`, `app/prompts`, `app/providers` | understanding, evidence guard, Groq reply composition |
| `app/products_api.py`, `app/conversation_api.py` | authenticated `/v2/ai/*` routes |
| `app/local.py` | loopback runner for local Backend tests (`rules` or `groq`) |
| `app/server.py` | Railway launcher (`python -m app.server`) |
| `tools/` | `gen_dev_keys.py`, `check_setup.py`, `test_groq_live.py`, `e2e_whatsapp.py` |
| `tests/` | 1598 offline tests (no network, no keys) |
| `docs/` | Arabic guides, handoff, Railway readiness, Backend health patch |

`.env.example` documents every variable; never commit `.env.local`.
Status: verified offline and cross-checked against the Backend's token signing; live Groq and
Neon runs are done by you with the guide above.

"""End-to-end test: fake WhatsApp customer message -> Backend (Neon) -> AI (+LLM) -> stored reply.

Needs the Backend running with WHATSAPP_ENABLED=true, WHATSAPP_DRY_RUN=true (no real
WhatsApp send) and AI_INTEGRATION_ENABLED=true, and the AI running via `python -m app.local`.

    python tools/e2e_whatsapp.py --backend http://127.0.0.1:3000 \
        --app-secret "$WHATSAPP_APP_SECRET" --phone-number-id 106540352242922 \
        --email owner@example.com --password '...' --business-id <uuid> \
        --message "بكام التيشيرت الأسود مقاس L؟"

What it does (read-only against your data except the test message it creates):
 1. logs in as the owner, links --phone-number-id to --business-id (idempotent PUT),
 2. sends a correctly SIGNED Meta webhook with the customer message,
 3. polls the conversation until an AI message appears (or --timeout),
 4. prints the AI reply, its aiMeta (intent / requiresReview) and the verdict.
Use --message several times (same --customer) to test multi-turn history.
"""
import argparse
import hashlib
import hmac
import json
import sys
import time
import uuid

import httpx


def signed_post(client, base, secret, payload):
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    signature = "sha256=" + hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return client.post(f"{base}/webhooks/whatsapp", content=raw,
                       headers={"Content-Type": "application/json", "X-Hub-Signature-256": signature})


def webhook_payload(phone_number_id, customer, name, text):
    return {"object": "whatsapp_business_account", "entry": [{"id": "0", "changes": [{"field": "messages", "value": {
        "messaging_product": "whatsapp",
        "metadata": {"display_phone_number": "15550000000", "phone_number_id": phone_number_id},
        "contacts": [{"profile": {"name": name}, "wa_id": customer}],
        "messages": [{"from": customer, "id": "wamid.TEST" + uuid.uuid4().hex, "timestamp": str(int(time.time())),
                      "type": "text", "text": {"body": text}}]}}]}]}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--backend", default="http://127.0.0.1:3000")
    p.add_argument("--app-secret", required=True, help="the Backend's WHATSAPP_APP_SECRET")
    p.add_argument("--phone-number-id", required=True, help="6-30 digits; any test value if it is not used by another business")
    p.add_argument("--email", required=True)
    p.add_argument("--password", required=True)
    p.add_argument("--business-id", required=True)
    p.add_argument("--customer", default="201000000001", help="customer wa_id, digits only")
    p.add_argument("--customer-name", default="Test Customer")
    p.add_argument("--message", action="append", required=True)
    p.add_argument("--timeout", type=float, default=60)
    a = p.parse_args()
    base = a.backend.rstrip("/")
    ok = True
    with httpx.Client(timeout=30) as c:
        login = c.post(f"{base}/auth/login", json={"email": a.email, "password": a.password})
        if login.status_code != 200:
            print(f"FAIL login: HTTP {login.status_code} {login.text[:200]}")
            return 1
        auth = {"Authorization": "Bearer " + login.json()["accessToken"]}
        link = c.put(f"{base}/businesses/{a.business_id}/whatsapp-connection", headers=auth,
                     json={"phoneNumberId": a.phone_number_id, "isActive": True})
        if link.status_code not in (200, 201):
            print(f"FAIL link whatsapp number: HTTP {link.status_code} {link.text[:200]}")
            return 1
        print(f"[ok] business {a.business_id} linked to phone_number_id {a.phone_number_id}")
        def ai_messages():
            convs = c.get(f"{base}/businesses/{a.business_id}/conversations?limit=50", headers=auth).json().get("items", [])
            mine = [v for v in convs if ((v.get("customer") or {}).get("phone") or "").lstrip("+") == a.customer]
            if not mine:
                return []
            msgs = c.get(f"{base}/businesses/{a.business_id}/conversations/{mine[0]['id']}/messages?limit=50",
                         headers=auth).json().get("items", [])
            return [m for m in msgs if m["senderType"] == "AI"]

        for text in a.message:
            known = {m["id"] for m in ai_messages()}
            before = time.time()
            sent = signed_post(c, base, a.app_secret, webhook_payload(a.phone_number_id, a.customer, a.customer_name, text))
            print(f"\n> customer: {text}\n  webhook HTTP {sent.status_code}")
            if sent.status_code != 200:
                print("  FAIL: webhook rejected:", sent.text[:200])
                ok = False
                continue
            reply = None
            while time.time() - before < a.timeout and reply is None:
                time.sleep(2)
                fresh = [m for m in ai_messages() if m["id"] not in known]
                reply = fresh[0] if fresh else None
            if reply is None:
                print(f"  FAIL: no AI reply within {a.timeout:.0f}s. Check the Backend log and the AI log (see TESTING_GUIDE_AR.md, Troubleshooting).")
                ok = False
                continue
            meta = reply.get("aiMeta") or {}
            print(f"< AI: {reply['content']}\n  aiMeta={meta} status={reply.get('status')} ({time.time() - before:.1f}s)")
            if meta.get("source") != "ai":
                print(f"  FAIL: this reply was NOT produced by the AI service (source={meta.get('source')!r}); the Backend used its safe fallback. See the AI log.")
                ok = False
    print("\nRESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

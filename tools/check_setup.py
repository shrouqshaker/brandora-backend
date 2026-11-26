"""Preflight for the AI side: is the env file complete and are the services reachable?

    python tools/check_setup.py --env-file .env.local [--backend http://127.0.0.1:3000] [--ai http://127.0.0.1:8000]

Secrets are never printed; only OK / MISSING / WEAK. Exit code 1 on any failure.
"""
import argparse
import sys
from pathlib import Path

import httpx

REQUIRED = {
    "APP_ENV": "must be local for the local runner",
    "AI_LOCAL_ENABLED": "must be true",
    "AI_LOCAL_PROVIDER": "rules or groq",
    "BACKEND_BASE_URL": "http://127.0.0.1:3000 (loopback)",
    "AI_SERVICE_TOKEN": "Backend -> AI token, >= 32 chars, same value as the Backend's AI_SERVICE_TOKEN",
    "BACKEND_SERVICE_TOKEN": "AI -> Backend token, >= 32 chars, same value as the Backend's BACKEND_SERVICE_TOKEN",
    "BACKEND_CONTEXT_PUBLIC_KEY": "RSA public key matching the Backend's AI_CONTEXT_PRIVATE_KEY",
}


def load(path: str) -> dict[str, str]:
    values = {}
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key.strip().removeprefix("export ").strip()] = value
    return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--backend")
    parser.add_argument("--ai")
    args = parser.parse_args()
    env = load(args.env_file)
    failed = False

    def report(ok: bool, label: str, detail: str = "") -> None:
        nonlocal failed
        failed |= not ok
        print(f"[{'OK' if ok else 'FAIL'}] {label}" + (f" - {detail}" if detail else ""))

    for key, hint in REQUIRED.items():
        report(bool(env.get(key)), key, "" if env.get(key) else f"MISSING ({hint})")
    for key in ("AI_SERVICE_TOKEN", "BACKEND_SERVICE_TOKEN"):
        if env.get(key):
            report(len(env[key]) >= 32, f"{key} strength", "" if len(env[key]) >= 32 else "WEAK (< 32 chars)")
    if env.get("AI_SERVICE_TOKEN") and env.get("AI_SERVICE_TOKEN") == env.get("BACKEND_SERVICE_TOKEN"):
        report(False, "tokens distinct", "the two tokens must differ")
    report(env.get("APP_ENV") == "local", "APP_ENV=local")
    if env.get("AI_LOCAL_PROVIDER") == "groq":
        report(bool(env.get("GROQ_API_KEY")), "GROQ_API_KEY", "" if env.get("GROQ_API_KEY") else "MISSING (needed for groq mode)")
    else:
        print("[info] AI_LOCAL_PROVIDER is not groq: the LLM will NOT be called (deterministic rules only)")
    if args.ai:
        try:
            r = httpx.get(args.ai.rstrip("/") + "/health/live", timeout=5)
            report(r.status_code == 200, "AI /health/live", f"HTTP {r.status_code}")
        except httpx.HTTPError as exc:
            report(False, "AI /health/live", type(exc).__name__)
    if args.backend:
        try:
            r = httpx.get(args.backend.rstrip("/") + "/.well-known/assetlinks.json", timeout=5)
            report(r.status_code < 500, "Backend reachable", f"HTTP {r.status_code}")
        except httpx.HTTPError as exc:
            report(False, "Backend reachable", type(exc).__name__)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

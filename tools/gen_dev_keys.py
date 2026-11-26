"""Generate throw-away local credentials for a Backend <-> AI test.

Prints two ready-to-paste env fragments (nothing is written to disk unless you
pass --write-dir). Never reuse these values in staging or production.

    python tools/gen_dev_keys.py
    python tools/gen_dev_keys.py --write-dir .secrets     # writes backend.env.part + ai.env.part
"""
import argparse
import secrets
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa


def one_line(pem: bytes) -> str:
    return pem.decode("ascii").strip().replace("\n", "\\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-dir")
    args = parser.parse_args()
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    public = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    ai_token = secrets.token_urlsafe(48)       # Backend -> AI   (X-Internal-Token)
    backend_token = secrets.token_urlsafe(48)  # AI -> Backend   (Authorization: Bearer)
    backend_part = (
        "# ---- add to the BACKEND .env ----\n"
        "AI_INTEGRATION_ENABLED=true\n"
        "AI_BASE_URL=http://127.0.0.1:8000\n"
        f"AI_SERVICE_TOKEN={ai_token}\n"
        f"BACKEND_SERVICE_TOKEN={backend_token}\n"
        f'AI_CONTEXT_PRIVATE_KEY="{one_line(private)}"\n'
    )
    ai_part = (
        "# ---- add to the AI .env.local ----\n"
        f"AI_SERVICE_TOKEN={ai_token}\n"
        f"BACKEND_SERVICE_TOKEN={backend_token}\n"
        f'BACKEND_CONTEXT_PUBLIC_KEY="{one_line(public)}"\n'
    )
    if args.write_dir:
        out = Path(args.write_dir)
        out.mkdir(parents=True, exist_ok=True)
        for name, text in (("backend.env.part", backend_part), ("ai.env.part", ai_part)):
            target = out / name
            if target.exists():
                sys.exit(f"refusing to overwrite {target}")
            target.write_text(text, encoding="utf-8")
        print(f"written to {out}/ (keep it out of Git)")
    else:
        print(backend_part)
        print(ai_part)


if __name__ == "__main__":
    main()

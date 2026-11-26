"""Offline schema check or explicit operator-authorized model metadata discovery."""
import argparse
from importlib.metadata import version
from itertools import islice
import json
import re
from types import SimpleNamespace

from google.genai import models, types

from ..config import load_settings
from ..providers.structured import classify_failure, wire_json_schema
from .understanding import Meaning
from .responding import ConversationReply
from .natural import NaturalReply


def check_schemas():
    for schema in (Meaning, ConversationReply, NaturalReply):
        config = types.GenerateContentConfig(response_mime_type="application/json",
                                             response_json_schema=wire_json_schema(schema))
        request = types._GenerateContentParameters(model="schema-check", contents="synthetic", config=config)
        converted = models._GenerateContentParameters_to_mldev(SimpleNamespace(vertexai=False), request)
        if converted["generationConfig"].get("responseJsonSchema") != wire_json_schema(schema):
            raise ValueError("schema_serialization_mismatch")
    return {"sdk": version("google-genai"), "schemas": ["Meaning", "ConversationReply", "NaturalReply"],
            "sdkSerialization": "passed", "networkUsed": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--discover", action="store_true", help="List accessible generateContent model IDs; no generation")
    parser.add_argument("--allow-live", action="store_true")
    args = parser.parse_args()
    if args.discover and not args.allow_live:
        parser.error("Model discovery needs explicit --discover --allow-live.")
    try:
        print(json.dumps(check_schemas()))
        if not args.discover:
            return
        settings = load_settings()
        if not settings.gemini_api_key:
            print(json.dumps({"discovery": "blocked", "category": "missing_key_configuration"}))
            raise SystemExit(1)
        from google import genai
        # Only this explicitly authorized branch initializes an SDK client.
        names = []
        with genai.Client(api_key=settings.gemini_api_key,
                          http_options=types.HttpOptions(timeout=10000)) as client:
            for model in islice(client.models.list(config={"page_size": 100}), 500):
                name = (model.name or "").removeprefix("models/")
                if ("generateContent" in (model.supported_actions or [])
                        and re.fullmatch(r"[a-zA-Z0-9._-]{1,100}", name)):
                    names.append(name)
        print(json.dumps({"accessibleGenerateContentModels": sorted(set(names)), "limitedTo": 500,
                          "generationTested": False, "configurationChanged": False}))
    except Exception as error:
        diagnostic = classify_failure(error, "sdk")
        print(json.dumps({"category": diagnostic.category, "httpStatus": diagnostic.http_status,
                          "message": "No provider payload or credentials are displayed."}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()

"""Free-only OpenRouter JSON adapter using the existing bounded HTTP lifecycle.

Gemma documents JSON mode; Nemotron requires prompt-only JSON instructions.
Neither policy claims native JSON-schema enforcement.
The schema is explicit prompt data; strict local parsers and semantic/grounding
validators remain authoritative. No schema-to-prose downgrade or paid routing.
"""
import json
import re
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal

from .groq import GroqClient
from .structured import StructuredOutputError


@dataclass(frozen=True)
class ModelCapabilities:
    response_format: Literal["json_object"] | None


# Explicit documented policies, not inference from family names or HTTP errors.
MODEL_CAPABILITIES = MappingProxyType({
    "google/gemma-4-31b-it:free": ModelCapabilities(response_format="json_object"),
    "nvidia/nemotron-3.5-lightning:free": ModelCapabilities(response_format=None),
})


class ModelCapabilityError(StructuredOutputError):
    def __init__(self):
        super().__init__("unsupported_model_capabilities")


def capabilities_for(model):
    policy = MODEL_CAPABILITIES.get(model)
    if not isinstance(policy,ModelCapabilities) or policy.response_format not in {None,"json_object"}:
        raise ModelCapabilityError()
    return policy


def validate_free_models(models):
    if (not models or len(models) > 4 or len(set(models)) != len(models)
            or any(not isinstance(model,str) or not re.fullmatch(
                r"(?!openrouter/)[A-Za-z0-9_-]+/[A-Za-z0-9._-]+:free",model) for model in models)):
        raise ValueError("OPENROUTER_MODELS requires one to four distinct explicit vendor/model:free identifiers")
    for model in models:
        capabilities_for(model)


class OpenRouterClient(GroqClient):
    provider_name = "openrouter"
    endpoint = "https://openrouter.ai/api/v1/chat/completions"

    def __init__(self, settings, **kwargs):
        validate_free_models(settings.openrouter_models)
        super().__init__(settings,**kwargs)

    @property
    def api_key(self):
        return self.settings.openrouter_api_key

    @property
    def model_ids(self):
        return self.settings.openrouter_models

    request_levels = 1  # explicit per-model JSON policy; no schema downgrade ladder

    def request_body(self, model, system, user, schema, temperature, level=0):
        # Recheck at the request boundary: never accept a paid override, router,
        # model array, plugin, or endpoint supplied by a model/customer.
        validate_free_models((model,))
        policy = capabilities_for(model)
        body = {"model":model,
                "messages":[{"role":"system","content":system +
                    "\nReturn only a JSON object conforming exactly to this JSON Schema:\n" +
                    json.dumps(schema.model_json_schema(),ensure_ascii=False)},
                    {"role":"user","content":user}],
                "temperature":temperature,"max_tokens":2048,
                "provider":{"require_parameters":True,"allow_fallbacks":False,
                            "max_price":{"prompt":0,"completion":0,"request":0}}}
        if policy.response_format is not None:
            body["response_format"] = {"type":policy.response_format}
        return body

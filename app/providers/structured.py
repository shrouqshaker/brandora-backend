"""Strict JSON parsing and allowlisted diagnostics; never retain provider payloads."""
import asyncio
import json
from dataclasses import dataclass
from typing import ClassVar

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError


class GeminiJSONModel(BaseModel):
    """Use SDK response_json_schema, not the older OpenAPI Schema converter."""
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    __gemini_json_schema__: ClassVar[bool] = True


def wire_json_schema(schema):
    """Documented Gemini JSON Schema subset; Pydantic retains every local limit.

    maxLength/maxProperties are local validation constraints, not among the
    SDK's documented response_json_schema keywords. Do not send unknown keys.
    """
    supported = {"$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum",
                 "items", "prefixItems", "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf",
                 "properties", "additionalProperties", "required", "propertyOrdering"}
    def visit(node):
        if isinstance(node, list):
            return [visit(value) for value in node]
        if not isinstance(node, dict):
            return node
        return {key: ({name: visit(value) for name, value in values.items()}
                      if key in {"properties", "$defs"} else visit(values))
                for key, values in node.items() if key in supported}
    return visit(schema.model_json_schema())


class StructuredOutputError(ValueError):
    def __init__(self, category):
        self.category = category
        super().__init__(category)


@dataclass(frozen=True)
class ProviderDiagnostic:
    category: str
    operation: str
    http_status: int | None = None
    provider: str | None = None
    schema_hint: str | None = None


def schema_failure_hint(error):
    """Return only a fixed schema-area label, never SDK paths/descriptions."""
    payload = getattr(error,"details",None)
    if isinstance(payload,dict):
        body = payload.get("error",payload)
        details = body.get("details",[]) if isinstance(body,dict) else []
        if isinstance(details,list):
            for detail in details[:16]:
                violations = detail.get("fieldViolations",[]) if isinstance(detail,dict) else []
                if not isinstance(violations,list):
                    continue
                for violation in violations[:16]:
                    field = violation.get("field","") if isinstance(violation,dict) else ""
                    if isinstance(field,str):
                        field = field[:200].lower().replace("_","")
                        if field.startswith("generationconfig.responsejsonschema"):
                            return "response_json_schema"
                        if field.startswith("generationconfig.responseschema"):
                            return "response_schema"
    # Known SDK/API schema markers are inspected transiently, never emitted.
    message = str(error).lower()
    if "response_json_schema" in message or "responsejsonschema" in message:
        return "response_json_schema"
    if "response_schema" in message or "responseschema" in message:
        return "response_schema"
    if "additionalproperties" in message or "json schema" in message:
        return "schema_constraints"
    return None


def parse_structured(schema, text):
    if text is None or text == "":
        raise StructuredOutputError("empty_output")
    if not isinstance(text, str):
        raise StructuredOutputError("incompatible_output")
    if len(text) > 4096:
        raise StructuredOutputError("output_limit")
    # Permit one complete JSON code fence, not surrounding prose or partial JSON.
    value = text.strip()
    if value.startswith("```json\n") and value.endswith("\n```"):
        value = value[8:-4]
    try:
        def unique(pairs):
            result = {}
            for key, item in pairs:
                if key in result:
                    raise StructuredOutputError("duplicate_fields")
                result[key] = item
            return result
        json.loads(value, object_pairs_hook=unique)
    except StructuredOutputError:
        raise
    except (ValueError, TypeError):
        raise StructuredOutputError("malformed_json") from None
    try:
        return schema.model_validate_json(value)
    except ValidationError as error:
        kinds = {item["type"] for item in error.errors(include_input=False, include_context=False)}
        category = "missing_fields" if kinds == {"missing"} else "validation_error"
        raise StructuredOutputError(category) from None


def classify_failure(error, operation):
    """Inspect locally; emit only fixed categories and integer HTTP status.

    Raw SDK messages are used only for recognizing known schema/key markers.
    They are never returned, logged, stored in health, or attached to diagnostics.
    """
    code = getattr(error, "code", None)
    code = code if type(code) is int and 100 <= code <= 599 else None
    if isinstance(error, StructuredOutputError):
        return ProviderDiagnostic(error.category, operation, code)
    if isinstance(error, (asyncio.TimeoutError, TimeoutError, httpx.TimeoutException)) or code in {408, 504}:
        return ProviderDiagnostic("timeout", operation, code)
    if isinstance(error, ValidationError):
        return ProviderDiagnostic("validation_error" if operation == "parse" else "sdk_configuration_error", operation, code)
    message = str(error).lower()
    schema_hint = schema_failure_hint(error)
    if code == 401 or (code == 400 and any(w in message for w in ("api key", "api_key_invalid"))):
        category = "authentication"
    elif code == 403:
        category = "permission_denied"
    elif code == 404:
        category = "model_unavailable"
    elif code == 429:
        category = "rate_limit_or_quota"
    elif code == 400 and schema_hint is not None:
        category = "api_schema_error"
    elif code is not None:
        category = "api_unavailable" if code >= 500 else "api_request_error"
    elif operation == "parse":
        category = "malformed_json" if isinstance(error, json.JSONDecodeError) else "validation_error"
    elif isinstance(error, ValueError):
        category = "sdk_schema_error" if schema_hint is not None else "sdk_configuration_error"
    else:
        category = "transport_or_sdk_error"
    return ProviderDiagnostic(category, operation, code,
                              schema_hint=schema_hint if category in {"api_schema_error","sdk_schema_error"} else None)

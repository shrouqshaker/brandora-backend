"""Regression tests at the real SDK serialization boundary; no network."""
import asyncio
import json
from types import SimpleNamespace

import pytest
import httpx
from google.genai import errors, models, types

from app.chat.__main__ import build
from app.chat.application import ChatSession
from app.chat.responding import ConversationReply, ConversationalResponder
from app.chat.understanding import Meaning
from app.providers.gemini import GeminiClient
from app.providers.structured import parse_structured, StructuredOutputError, wire_json_schema
from tests.fake_gemini import FakeGemini, api_error, gemini_settings


@pytest.fixture
def anyio_backend():
    return "asyncio"


MEANING = dict(act="price", product_handle=None, search="tshirt", options={"size": "L"}, quantity=None, language="en")
REPLY = {"tone": "friendly", "acts": [{"fact_id": "f0", "phrase": 0}]}


@pytest.mark.parametrize("schema,payload", [(Meaning, MEANING), (ConversationReply, REPLY)])
def test_exact_schema_serializes_through_installed_developer_api_sdk(schema, payload):
    # The previous response_schema path raises on Meaning.options. Test the
    # actual SDK request converter rather than only a fake _generate override.
    config = types.GenerateContentConfig(response_mime_type="application/json",
                                         response_json_schema=wire_json_schema(schema))
    params = types._GenerateContentParameters(model="test-model", contents="synthetic", config=config)
    converted = models._GenerateContentParameters_to_mldev(SimpleNamespace(vertexai=False), params)
    assert converted["generationConfig"]["responseJsonSchema"] == wire_json_schema(schema)
    assert isinstance(parse_structured(schema, json.dumps(payload)), schema)


@pytest.mark.parametrize("schema,payload", [(Meaning, MEANING), (ConversationReply, REPLY)])
@pytest.mark.parametrize("kind", ["missing", "malformed", "null", "wrong", "extra", "empty", "oversized"])
def test_strict_structured_parsing(schema, payload, kind):
    text = json.dumps(payload)
    expected = "validation_error"
    if kind == "missing":
        text, expected = "{}", "missing_fields"
    elif kind == "malformed":
        text, expected = "{broken", "malformed_json"
    elif kind == "null":
        text = "null"
    elif kind == "wrong":
        text = '[]'
    elif kind == "extra":
        text = json.dumps({**payload, "reply": "secret customer content"})
    elif kind == "empty":
        text, expected = None, "empty_output"
    elif kind == "oversized":
        text, expected = "x" * 4097, "output_limit"
    with pytest.raises(StructuredOutputError) as error:
        parse_structured(schema, text)
    assert error.value.category == expected
    assert "secret" not in str(error.value)


@pytest.mark.anyio
@pytest.mark.parametrize("schema,payload", [(Meaning, MEANING), (ConversationReply, REPLY)])
async def test_real_generate_uses_json_schema_and_strict_parser(schema, payload):
    client = GeminiClient(gemini_settings())
    seen = []
    async def generate_content(**kwargs):
        seen.append(kwargs["config"])
        return types.GenerateContentResponse(candidates=[types.Candidate(content=types.Content(
            parts=[types.Part(text=json.dumps(payload))]), finish_reason="STOP")])
    client._client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate_content)))
    result, _ = await client.call(stage="test", models=("test-model",), system="s", user="synthetic",
                                  schema=schema, parse=lambda s: parse_structured(schema, s))
    assert isinstance(result, schema)
    assert seen[0].response_schema is None
    assert seen[0].response_json_schema == wire_json_schema(schema)


@pytest.mark.anyio
@pytest.mark.parametrize("code,category", [(400,"api_request_error"),(401,"authentication"),
    (403,"permission_denied"),(404,"model_unavailable"),(429,"rate_limit_or_quota"),(503,"api_unavailable")])
async def test_api_failure_categories_are_safe_and_call_local(code, category, caplog):
    from app.providers.base import ProviderUnavailable
    error = api_error(errors.ClientError if code < 500 else errors.ServerError, code,
                      "PRIVATE_CUSTOMER_TEXT Authorization: Bearer SECRET", "UNKNOWN")
    fake = FakeGemini({"r-a": error}, gemini_max_retries=1)
    with pytest.raises(ProviderUnavailable) as caught:
        await fake.call(stage="conversation-understanding", models=("r-a",), system="s", user="private",
                        schema=Meaning, parse=lambda s: parse_structured(Meaning, s))
    assert caught.value.diagnostics[-1].category == category
    assert caught.value.diagnostics[-1].http_status == code
    combined = caplog.text + str(fake.health) + str(caught.value.diagnostics) + str(caught.value)
    assert "PRIVATE_CUSTOMER_TEXT" not in combined and "SECRET" not in combined
    assert not hasattr(fake, "last_diagnostics")


@pytest.mark.anyio
async def test_reported_arabic_preference_regression():
    for mode in ("rules", "fake"):
        backend, interpreter, responder = build(mode)
        scope = backend.scope()
        chat = ChatSession(backend.data(), scope, interpreter, responder)
        for message in ("عندكم تيشيرت أسود؟", "طب مقاس L بكام؟", "عايزة اتنين منه",
                        "طب غيرت رأيي عايزة الأبيض"):
            await chat.send(message, context_token=backend.token(scope))
        last = await chat.send("أنا محتارة بين الأسود والأبيض، وعايزة مقاس L بس مش عارفة أنهي لون أحسن",
                               context_token=backend.token(scope))
        assert last.understanding.meaning.act == "compare"
        assert last.understanding.inquiry.product_ids
        assert last.response.intent.value == "INQUIRY"
        assert last.execution.plan.requested_quantity is None
        assert len(last.execution.plan.matching_variant_ids) == 2
        assert "275 جنيه" in last.response.reply and "285 جنيه" in last.response.reply
        assert "لون" in last.response.reply and "أفضل" not in last.response.reply
        assert "أنهي منتج" not in last.response.reply
        assert last.response.orderCandidate is None


@pytest.mark.anyio
@pytest.mark.parametrize("text", ["never mind", "مش عايزة خلاص", "cancel"])
async def test_cancellation_never_executes_order_and_clears_provisional_purchase(text):
    backend, interpreter, responder = build("fake")
    scope = backend.scope()
    chat = ChatSession(backend.data(), scope, interpreter, responder)
    await chat.send("I want two black tshirt size L", context_token=backend.token(scope))
    cancelled = await chat.send(text, context_token=backend.token(scope))
    assert cancelled.response.orderCandidate is None
    assert cancelled.response.intent.value == "OTHER"
    assert "leave that option" in cancelled.response.reply or "نسيب الاختيار" in cancelled.response.reply
    assert "cancelled your order" not in cancelled.response.reply
    assert not chat.selection.products
    assert chat.selection.quantity is None
    fresh = await chat.send("I want three white tshirt size M", context_token=backend.token(scope))
    assert fresh.response.intent.value == "PURCHASE_INTENT"
    assert fresh.execution.plan.requested_quantity == 3
    assert "225.00 EGP" in fresh.response.reply


@pytest.mark.anyio
async def test_new_unrelated_product_does_not_inherit_purchase_or_quantity():
    backend, interpreter, responder = build("rules")
    scope = backend.scope()
    chat = ChatSession(backend.data(), scope, interpreter, responder)
    await chat.send("I want two black tshirt size L", context_token=backend.token(scope))
    turn = await chat.send("What about a red mug?", context_token=backend.token(scope))
    assert turn.response.intent.value != "PURCHASE_INTENT"
    assert not turn.understanding.inquiry.product_ids
    assert turn.execution.plan.requested_quantity is None
    assert not chat.selection.products and chat.selection.quantity is None


@pytest.mark.anyio
@pytest.mark.parametrize("patch", [{"stockQuantity": 0}, {"isActive": False}, {"unitPrice": None,"effectivePrice": None}])
async def test_comparison_revalidates_changed_evidence(patch):
    backend, interpreter, responder = build("rules")
    scope = backend.scope()
    chat = ChatSession(backend.data(), scope, interpreter, responder)
    await chat.send("black tshirt size L price", context_token=backend.token(scope))
    backend.products[1][0]["variants"][2].update(patch)
    turn = await chat.send("Compare black and white size L", context_token=backend.token(scope))
    assert turn.response.intent.value == "INQUIRY"
    assert "275.00 EGP" in turn.response.reply
    if patch.get("isActive") is False:
        assert "285.00 EGP" not in turn.response.reply
        assert "Not all requested alternatives" in turn.response.reply
    elif "unitPrice" in patch:
        assert "285.00 EGP" not in turn.response.reply
        assert "price unconfirmed" in turn.response.reply
    else:
        assert "out of stock" in turn.response.reply and "recorded stock" not in turn.response.reply


@pytest.mark.anyio
async def test_schema_errors_and_timeouts_distinguished_without_retrying_local_conversion():
    from app.providers.base import ProviderUnavailable
    for error, category in [(ValueError("additionalProperties SECRET unsupported"), "sdk_schema_error"),
                            (asyncio.TimeoutError(), "timeout"),
                            (httpx.ReadTimeout("SECRET"), "timeout"),
                            (api_error(errors.ClientError,400,"Invalid response_json_schema SECRET"), "api_schema_error")]:
        fake = FakeGemini({"r-a": error}, gemini_max_retries=1)
        with pytest.raises(ProviderUnavailable) as caught:
            await fake.call(stage="conversation-understanding", models=("r-a",), system="s", user="u",
                            schema=Meaning, parse=lambda s: parse_structured(Meaning,s))
        assert caught.value.diagnostics[-1].category == category
        assert len(fake.calls) == 1 and not fake.sleeps
        assert "SECRET" not in str(caught.value.diagnostics)
        assert fake._use_schema  # no silent schema disabling for conversational calls


@pytest.mark.anyio
async def test_sdk_blocked_or_truncated_responses_are_not_parsed():
    from app.providers.base import ProviderUnavailable
    for reason, category in [("SAFETY","output_blocked"),("MAX_TOKENS","output_truncated")]:
        client = GeminiClient(gemini_settings(gemini_max_retries=1))
        async def generate_content(**kwargs):
            return types.GenerateContentResponse(candidates=[types.Candidate(finish_reason=reason)])
        client._client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate_content)))
        with pytest.raises(ProviderUnavailable) as caught:
            await client.call(stage="conversation-reply", models=("test-model",), system="s",user="u",
                              schema=ConversationReply,parse=lambda s: parse_structured(ConversationReply,s))
        assert caught.value.diagnostics[-1].category == category


@pytest.mark.anyio
async def test_reply_failure_diagnostics_do_not_hide_behind_understanding_failure():
    backend, interpreter, responder = build("rules")
    fake = FakeGemini({"r-a": "not json", "r-b": "not json",
                       "g-a": api_error(errors.ClientError,400,"Invalid request SECRET"),
                       "g-b": api_error(errors.ClientError,400,"Invalid request SECRET")}, gemini_max_retries=1)
    from app.chat.understanding import ConversationInterpreter
    chat = ChatSession(backend.data(),backend.scope(),ConversationInterpreter(fake,fake.settings),
                       ConversationalResponder(fake,fake.settings))
    turn = await chat.send("black tshirt size L price",context_token=backend.token(backend.scope()))
    diagnostics = turn.diagnostics()
    assert diagnostics["providerFailures"]["understanding"][0]["category"] == "malformed_json"
    assert diagnostics["providerFailures"]["reply"][0]["category"] == "api_request_error"
    assert diagnostics["understandingFailure"] and diagnostics["replyFailure"]
    assert "SECRET" not in json.dumps(diagnostics)
    assert "275.00 EGP" in turn.response.reply


def test_duplicate_json_fields_are_rejected():
    with pytest.raises(StructuredOutputError, match="duplicate_fields"):
        parse_structured(ConversationReply, '{"tone":"direct","tone":"friendly","acts":[]}')


def test_discovery_requires_explicit_live_flag(monkeypatch):
    from app.chat.diagnose import main
    monkeypatch.setattr("sys.argv",["diagnose","--discover"])
    with pytest.raises(SystemExit) as caught:
        main()
    assert caught.value.code == 2


def test_operator_discovery_uses_fake_metadata_only_and_redacts_everything_else(monkeypatch, capsys):
    from google import genai
    from app.chat import diagnose
    monkeypatch.setattr("sys.argv",["diagnose","--discover","--allow-live"])
    monkeypatch.setattr(diagnose,"load_settings",lambda: gemini_settings(gemini_api_key="PRIVATE_KEY"))
    class Client:
        def __init__(self, **kwargs):
            assert kwargs["api_key"] == "PRIVATE_KEY"
            self.models = self
        def __enter__(self):
            return self
        def __exit__(self,*args):
            pass
        def list(self,config):
            assert config == {"page_size":100}
            return iter([types.Model(name="models/gemini-accessible",supported_actions=["generateContent"],description="PRIVATE_PAYLOAD"),
                         types.Model(name="models/embedding-only",supported_actions=["embedContent"])])
    monkeypatch.setattr(genai,"Client",Client)
    diagnose.main()
    output = capsys.readouterr().out
    assert "gemini-accessible" in output and '"generationTested": false' in output
    assert "PRIVATE_KEY" not in output and "PRIVATE_PAYLOAD" not in output and "embedding-only" not in output


def test_retired_model_preflight_does_not_replace_ids_or_initialize_sdk(monkeypatch):
    from app.chat import __main__ as cli
    settings = gemini_settings(router_models=("gemini-2.0-flash",))
    monkeypatch.setattr(cli,"load_settings",lambda: settings)
    with pytest.raises(cli.ChatConfigurationError,match="retired"):
        cli.build("gemini")
    assert settings.router_models == ("gemini-2.0-flash",)


def test_wire_schema_uses_documented_subset_without_weakening_python_validation():
    wire = wire_json_schema(Meaning)
    assert "maxProperties" not in wire["properties"]["options"]
    assert wire["properties"]["options"]["additionalProperties"] == {"type":"string"}
    assert wire["additionalProperties"] is False
    assert wire["required"] == Meaning.model_json_schema()["required"]
    with pytest.raises(StructuredOutputError,match="validation_error"):
        parse_structured(Meaning,json.dumps({**MEANING,"search":"x" * 161}))


@pytest.mark.anyio
async def test_changing_mind_changes_selection_without_inheriting_purchase_intent():
    backend, interpreter, responder = build("fake")
    scope = backend.scope()
    chat = ChatSession(backend.data(),scope,interpreter,responder)
    await chat.send("I want two black tshirt size L",context_token=backend.token(scope))
    turn = await chat.send("Actually I changed my mind, make it white",context_token=backend.token(scope))
    assert turn.understanding.inquiry.product_ids
    assert "285.00 EGP" in turn.response.reply and "275.00 EGP" not in turn.response.reply
    assert turn.response.intent.value == "INQUIRY"
    assert turn.execution.plan.requested_quantity is None

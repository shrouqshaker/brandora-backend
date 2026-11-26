"""Free-only OpenRouter transport and existing grounded chain. No network."""
import asyncio
from dataclasses import replace
import json

import httpx
import pytest

from app.config import Settings, load_settings
from app.providers.base import ProviderUnavailable
from app.providers.failover import ProviderChain
from app.providers.groq import GroqClient
from app.providers.openrouter import OpenRouterClient, validate_free_models
from app.providers.structured import parse_structured
from app.chat.understanding import Meaning, ConversationInterpreter
from app.chat.natural import NaturalReply, NaturalResponder
from app.chat.application import ChatSession
from app.chat.synthetic import SyntheticBackend
from tests.test_named_comparison_regression import NAMED, meaning, composition, assert_pair


@pytest.fixture
def anyio_backend():
    return "asyncio"


def settings(**changes):
    return Settings(openrouter_api_key="PRIVATE_SYNTHETIC_KEY",groq_api_key="synthetic-groq",**changes)


def response(content=None, **patch):
    return httpx.Response(200,json={"choices":[{"finish_reason":"stop","message":{
        "content":json.dumps(meaning()) if content is None else content}}],**patch})


async def call(client,schema=Meaning):
    return await client.call(stage="synthetic",models=("paid/override",),system="synthetic",user="synthetic",
                             schema=schema,parse=lambda value:parse_structured(schema,value))


@pytest.mark.anyio
@pytest.mark.parametrize("model",["google/gemma-4-31b-it:free","nvidia/nemotron-3.5-lightning:free"])
@pytest.mark.parametrize("schema,content",[(Meaning,json.dumps(meaning())),(NaturalReply,composition())])
async def test_request_format_free_caps_and_strict_application_schema(schema,content,model):
    requests=[]
    def handler(request):
        requests.append(request)
        assert str(request.url)=="https://openrouter.ai/api/v1/chat/completions"
        assert request.headers["authorization"]=="Bearer PRIVATE_SYNTHETIC_KEY"
        body=json.loads(request.content)
        assert body["model"]==model
        if model.startswith("nvidia/"):
            assert "response_format" not in body
        else:
            assert body["response_format"]=={"type":"json_object"}
        assert body["provider"]=={"require_parameters":True,"allow_fallbacks":False,
                                  "max_price":{"prompt":0,"completion":0,"request":0}}
        assert body["max_tokens"]==2048
        assert json.loads(body["messages"][0]["content"].split("JSON Schema:\n")[1])==schema.model_json_schema()
        assert body["messages"][1]=={"role":"user","content":"synthetic"}
        assert not set(body) & {"models","route","tools","plugins"}
        return response(content)
    value,selected=await call(OpenRouterClient(settings(openrouter_models=(model,)),transport=httpx.MockTransport(handler)),schema)
    assert isinstance(value,schema) and selected==model and len(requests)==1


@pytest.mark.parametrize("models",[(),("vendor/paid",),("openrouter/free",),("openrouter/auto",),
    ("openrouter/auto:free",),("vendor/model:free:online",),("https://evil/model:free",),
    ("vendor/paid","google/gemma-4-31b-it:free"),("vendor/model:free",)*2,
    tuple(f"vendor/model{i}:free" for i in range(5))])
def test_paid_router_or_invalid_config_rejected_before_any_http(models):
    with pytest.raises(ValueError,match="vendor/model:free"):
        OpenRouterClient(settings(openrouter_models=models))


def test_free_config_and_secret_repr(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY","PRIVATE_SYNTHETIC_KEY")
    monkeypatch.setenv("OPENROUTER_MODELS","google/gemma-4-31b-it:free")
    monkeypatch.setenv("CHAT_PROVIDER_ORDER","")
    monkeypatch.setenv("GROQ_MODELS","")
    loaded=load_settings()
    assert loaded.chat_provider_order==("groq","openrouter")
    assert loaded.groq_models==("openai/gpt-oss-120b",)
    assert loaded.openrouter_api_key=="PRIVATE_SYNTHETIC_KEY"
    assert "PRIVATE" not in repr(loaded)


@pytest.mark.anyio
@pytest.mark.parametrize("model",["google/gemma-4-31b-it:free","nvidia/nemotron-3.5-lightning:free"])
@pytest.mark.parametrize("status",[400,401,402,403,404,429,503,307])
async def test_http_errors_no_redirect_or_paid_retry_and_sanitized(status,model):
    requests=[]
    def handler(request):
        requests.append(request)
        return httpx.Response(status,headers={"Location":"https://evil.invalid"},text="PRIVATE_PROVIDER_PAYLOAD")
    with pytest.raises(ProviderUnavailable) as caught:
        await call(OpenRouterClient(settings(openrouter_models=(model,)),transport=httpx.MockTransport(handler)))
    assert len(requests)==1
    assert caught.value.diagnostics[0].http_status==status
    assert "PRIVATE" not in str(caught.value)+str(caught.value.diagnostics)


@pytest.mark.anyio
@pytest.mark.parametrize("model",["google/gemma-4-31b-it:free","nvidia/nemotron-3.5-lightning:free"])
@pytest.mark.parametrize("content",["bad JSON","{}","null",composition().replace('"neutral"','"PRIVATE_INVALID"')])
async def test_invalid_reply_never_passes_strict_parser(content,model):
    with pytest.raises(ProviderUnavailable):
        await call(OpenRouterClient(settings(openrouter_models=(model,)),transport=httpx.MockTransport(lambda _:response(content))),NaturalReply)


@pytest.mark.anyio
@pytest.mark.parametrize("finish,refusal",[("length",None),("stop","PRIVATE_REFUSAL")])
async def test_incomplete_or_refused_output_is_not_accepted(finish,refusal):
    result=httpx.Response(200,json={"choices":[{"finish_reason":finish,"message":{
        "content":json.dumps(meaning()),"refusal":refusal}}]})
    with pytest.raises(ProviderUnavailable):
        await call(OpenRouterClient(settings(),transport=httpx.MockTransport(lambda _:result)))


@pytest.mark.anyio
@pytest.mark.parametrize("failure",[429,503,"timeout","malformed","semantic"])
async def test_both_stages_fail_over_with_verified_decimal_comparison(failure):
    seen=[]
    def primary(request):
        if failure=="timeout":
            raise httpx.ReadTimeout("PRIVATE",request=request)
        if isinstance(failure,int):
            return httpx.Response(failure,text="PRIVATE")
        if failure=="semantic":
            return response(json.dumps(meaning(search="invented hoodie")))
        return response("malformed")
    def secondary(request):
        body=json.loads(request.content)
        seen.append(body)
        schema=json.loads(body["messages"][0]["content"].split("JSON Schema:\n")[1])
        return response(json.dumps(meaning()) if schema["title"]=="Meaning" else composition())
    config=settings()
    chain=ProviderChain([("groq",GroqClient(config,transport=httpx.MockTransport(primary))),
                         ("openrouter",OpenRouterClient(config,transport=httpx.MockTransport(secondary)))],config)
    b=SyntheticBackend()
    turn=await ChatSession(b.data(),b.scope(),ConversationInterpreter(chain,config),NaturalResponder(chain,config)).send(
        NAMED,context_token=b.token(b.scope()))
    assert_pair(turn)
    assert turn.diagnostics()["understandingProvider"]=="openrouter"
    assert turn.diagnostics()["replyProvider"]=="openrouter"
    assert len(seen)==2 and turn.understanding.provider_diagnostics[0].provider=="groq"


@pytest.mark.anyio
async def test_reply_only_failover_checks_composition_guard():
    def primary(request):
        body=json.loads(request.content)
        return response(json.dumps(meaning()) if body["response_format"]["json_schema"]["name"]=="Meaning"
                        else composition(("invented-fact",)))
    config=settings()
    chain=ProviderChain([("groq",GroqClient(config,transport=httpx.MockTransport(primary))),
        ("openrouter",OpenRouterClient(config,transport=httpx.MockTransport(lambda _:response(composition()))))],config)
    b=SyntheticBackend()
    turn=await ChatSession(b.data(),b.scope(),ConversationInterpreter(chain,config),NaturalResponder(chain,config)).send(
        NAMED,context_token=b.token(b.scope()))
    assert_pair(turn)
    assert turn.diagnostics()["understandingProvider"]=="groq"
    assert turn.diagnostics()["replyProvider"]=="openrouter"
    assert turn.execution.generation.provider_diagnostics[0].category=="grounding_guard_rejected"


@pytest.mark.anyio
async def test_exhaustion_is_deterministic_not_a_paid_model():
    config=settings()
    transport=httpx.MockTransport(lambda _:httpx.Response(503))
    chain=ProviderChain([("groq",GroqClient(config,transport=transport)),
                         ("openrouter",OpenRouterClient(config,transport=transport))],config)
    b=SyntheticBackend()
    turn=await ChatSession(b.data(),b.scope(),ConversationInterpreter(chain,config),NaturalResponder(chain,config)).send(
        NAMED,context_token=b.token(b.scope()))
    assert_pair(turn)
    assert turn.understanding.source=="rules" and turn.diagnostics()["replyProvider"]=="deterministic"


def test_cli_modes_default_order_and_optional_gemini(monkeypatch):
    from app.chat import __main__ as cli
    config=replace(settings(),gemini_api_key="synthetic")
    monkeypatch.setattr(cli,"load_settings",lambda:config)
    assert [name for name,_ in cli.build("auto")[1].client.providers]==["groq","openrouter"]
    assert [name for name,_ in cli.build("openrouter")[1].client.providers]==["openrouter"]
    assert [name for name,_ in cli.build("gemini")[1].client.providers]==["gemini","groq","openrouter"]


def test_invalid_cost_config_stops_cli_without_exposing_values(monkeypatch):
    from app.chat import __main__ as cli
    monkeypatch.setattr(cli,"load_settings",lambda:settings(openrouter_models=("PRIVATE/paid",)))
    with pytest.raises(cli.ChatConfigurationError) as caught:
        cli.build("auto")
    assert "PRIVATE" not in str(caught.value)


@pytest.mark.anyio
async def test_operator_outage_simulation_only_replaces_groq_http():
    from app.chat.evaluate import simulate_groq_outage
    config=settings()
    secondary=OpenRouterClient(config,transport=httpx.MockTransport(lambda _:response()))
    chain=ProviderChain([("groq",GroqClient(config)),("openrouter",secondary)],config)
    interpreter=ConversationInterpreter(chain,config)
    responder=NaturalResponder(chain,config)
    simulate_groq_outage(interpreter,responder)
    assert interpreter.client is responder.client
    assert interpreter.client.providers[1][1] is secondary
    result=await call(interpreter.client)
    assert result.provider=="openrouter" and result.failures[0].http_status==503


@pytest.mark.anyio
async def test_openrouter_circuit_and_recovery_probe():
    now=[0.0]
    count=[]
    def handler(request):
        count.append(1)
        return httpx.Response(503) if len(count)==1 else response()
    config=settings(chat_circuit_seconds=5)
    chain=ProviderChain([("openrouter",OpenRouterClient(config,transport=httpx.MockTransport(handler),clock=lambda:now[0]))],
                        config,clock=lambda:now[0])
    with pytest.raises(ProviderUnavailable):
        await call(chain)
    with pytest.raises(ProviderUnavailable):
        await call(chain)
    assert len(count)==1
    now[0]=6
    assert (await call(chain)).provider=="openrouter" and len(count)==2


@pytest.mark.parametrize("model",["PRIVATE/unknown:free","nvidia/nemotron-3-super-120b-a12b:free"])
def test_unknown_capability_is_safely_rejected_before_http(model,monkeypatch):
    from app.providers.openrouter import ModelCapabilityError
    from app.chat import __main__ as cli
    config=settings(openrouter_models=(model,))
    with pytest.raises(ModelCapabilityError) as caught:
        OpenRouterClient(config)
    assert str(caught.value)=="unsupported_model_capabilities"
    monkeypatch.setattr(cli,"load_settings",lambda:config)
    with pytest.raises(cli.ChatConfigurationError,match="unsupported_model_capabilities") as error:
        cli.build("openrouter")
    assert "PRIVATE" not in str(error.value)


def test_unknown_policy_state_cannot_silently_omit_format(monkeypatch):
    from app.providers import openrouter
    model="google/gemma-4-31b-it:free"
    with pytest.raises(TypeError):
        openrouter.MODEL_CAPABILITIES[model]=openrouter.ModelCapabilities(None)
    monkeypatch.setattr(openrouter,"MODEL_CAPABILITIES",{model:openrouter.ModelCapabilities("unknown")})
    with pytest.raises(openrouter.ModelCapabilityError):
        OpenRouterClient(settings())


@pytest.mark.anyio
async def test_nemotron_old_required_format_reproduces_endpoint_exclusion_offline():
    """Simulate documented router filtering, without asserting a live 404 cause."""
    def handler(request):
        body=json.loads(request.content)
        if body.get("provider",{}).get("require_parameters") and "response_format" in body:
            return httpx.Response(404,json={"error":{"message":"No compatible endpoint"}})
        return response()
    transport=httpx.MockTransport(handler)
    config=settings(openrouter_models=("nvidia/nemotron-3.5-lightning:free",))
    client=OpenRouterClient(config,transport=transport)
    body=client.request_body(config.openrouter_models[0],"synthetic","synthetic",Meaning,0)
    async with httpx.AsyncClient(transport=transport) as http:
        old=await http.post(client.endpoint,json={**body,"response_format":{"type":"json_object"}})
        assert old.status_code==404
    assert isinstance((await call(client))[0],Meaning)


@pytest.mark.anyio
@pytest.mark.parametrize("failure",[404,429,"json","semantic"])
async def test_nemotron_failure_to_gemma_retains_each_explicit_policy_and_guard(failure):
    requests=[]
    def handler(request):
        body=json.loads(request.content)
        requests.append(body)
        schema=json.loads(body["messages"][0]["content"].split("JSON Schema:\n")[1])
        if body["model"].startswith("nvidia/"):
            assert "response_format" not in body
            if isinstance(failure,int):
                return httpx.Response(failure,text="PRIVATE_PAYLOAD")
            return response("invalid JSON" if failure=="json" else json.dumps(meaning(search="invented hoodie")))
        assert body["response_format"]=={"type":"json_object"}
        return response(json.dumps(meaning()) if schema["title"]=="Meaning" else composition())
    config=settings(openrouter_models=("nvidia/nemotron-3.5-lightning:free","google/gemma-4-31b-it:free"))
    chain=ProviderChain([("openrouter",OpenRouterClient(config,transport=httpx.MockTransport(handler)))],config)
    b=SyntheticBackend()
    turn=await ChatSession(b.data(),b.scope(),ConversationInterpreter(chain,config),NaturalResponder(chain,config)).send(
        NAMED,context_token=b.token(b.scope()))
    assert_pair(turn)
    assert turn.diagnostics()["replyProvider"]=="openrouter"
    assert [body["model"] for body in requests]==[config.openrouter_models[0],config.openrouter_models[1],config.openrouter_models[1]]
    assert all(body["provider"]=={"require_parameters":True,"allow_fallbacks":False,
               "max_price":{"prompt":0,"completion":0,"request":0}} for body in requests)

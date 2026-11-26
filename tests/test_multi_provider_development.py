"""Offline provider failover, natural grounding and authenticated dev contracts."""
import asyncio
from dataclasses import replace
import json
from decimal import Decimal

import httpx
import pytest

from app.config import Settings,load_settings
from app.providers.base import ProviderUnavailable
from app.providers.failover import ProviderChain
from app.providers.groq import GroqClient,groq_schema
from app.providers.structured import ProviderDiagnostic,parse_structured,StructuredOutputError
from app.chat.__main__ import build,run,ChatConfigurationError
from app.chat.application import ChatSession
from app.chat.understanding import Meaning,ConversationInterpreter,Selection
from app.chat.natural import NaturalReply,NaturalResponder,clauses_for,validate_composition
from app.chat.synthetic import SyntheticBackend,identifier
from app.clients.development_backend import DevelopmentBackendClient,MAIN_REVISION,validate_pending_history_contract
from app.clients.backend_client import BackendAuthenticationError,BackendClientError,BackendResponseError
from app.data.backend import BackendDataAccess


@pytest.fixture
def anyio_backend():
    return "asyncio"


class ScriptedProvider:
    def __init__(self,results):
        self.results=list(results)
        self.calls=0
    async def call(self,**kwargs):
        self.calls+=1
        result=self.results.pop(0) if len(self.results)>1 else self.results[0]
        if isinstance(result,Exception):
            raise result
        return kwargs["parse"](result),"synthetic-model"


def meaning_json(**patch):
    return json.dumps(dict(act="price",product_handle=None,search="tshirt",options={"color":"Black","size":"L"},quantity=None,language="en",**patch))


@pytest.mark.anyio
@pytest.mark.parametrize("category",["rate_limit_or_quota","api_unavailable","timeout","malformed_json","authentication"])
async def test_provider_failover_and_circuit_recovery(category):
    now=[0.0]
    settings=Settings(chat_circuit_seconds=5)
    primary=ScriptedProvider([ProviderUnavailable("safe",diagnostics=(ProviderDiagnostic(category,"sdk"),)),meaning_json()])
    secondary=ScriptedProvider([meaning_json()])
    chain=ProviderChain([("gemini",primary),("groq",secondary)],settings,clock=lambda:now[0])
    async def call():
        return await chain.call(stage="conversation-understanding",models=(),system="s",user="synthetic",schema=Meaning,parse=lambda s:parse_structured(Meaning,s))
    result=await call()
    assert result.provider=="groq" and result.failures[0].provider=="gemini"
    assert (await call()).provider=="groq" and primary.calls==1
    now[0]=6
    assert (await call()).provider=="gemini" and primary.calls==2
    assert not hasattr(chain,"last_plan") and not hasattr(chain,"last_response")


@pytest.mark.anyio
async def test_timeout_leaves_budget_for_secondary():
    class Slow:
        async def call(self,**kwargs):
            await asyncio.sleep(10)
    settings=Settings(chat_provider_timeout_seconds=.01,chat_total_timeout_seconds=.1)
    secondary=ScriptedProvider([meaning_json()])
    result=await ProviderChain([("gemini",Slow()),("groq",secondary)],settings).call(
        stage="u",models=(),system="s",user="synthetic",schema=Meaning,parse=lambda s:parse_structured(Meaning,s))
    assert result.provider=="groq" and result.failures[0].category=="timeout"


@pytest.mark.anyio
async def test_groq_actual_http_schema_and_credentials_are_isolated():
    seen=[]
    def handler(request):
        body=json.loads(request.content)
        seen.append(body)
        assert request.url.host=="api.groq.com"
        assert request.headers["Authorization"]=="Bearer synthetic-groq"
        return httpx.Response(200,json={"choices":[{"finish_reason":"stop","message":{"content":meaning_json()}}]})
    client=GroqClient(Settings(groq_api_key="synthetic-groq"),transport=httpx.MockTransport(handler))
    value,model=await client.call(stage="u",models=(),system="s",user="synthetic",schema=Meaning,
                                 parse=lambda s:parse_structured(Meaning,s))
    assert value.options["size"]=="L" and model=="openai/gpt-oss-120b"
    assert seen[0]["response_format"]["json_schema"]["strict"] is False
    assert groq_schema(NaturalReply)["json_schema"]["strict"] is True
    assert "tools" not in seen[0]


@pytest.mark.anyio
@pytest.mark.parametrize("status",[400,401,403,404,429,503,307])
async def test_groq_http_failures_are_sanitized(status):
    count=[]
    def handler(request):
        count.append(1)
        return httpx.Response(status,headers={"Location":"https://other.invalid"},text="PRIVATE_PROVIDER_PAYLOAD")
    client=GroqClient(Settings(groq_api_key="PRIVATE_KEY",groq_models=("openai/gpt-oss-120b","openai/gpt-oss-20b")),transport=httpx.MockTransport(handler))
    with pytest.raises(ProviderUnavailable) as caught:
        await client.call(stage="u",models=(),system="s",user="sensitive",schema=Meaning,parse=lambda s:parse_structured(Meaning,s))
    assert "PRIVATE" not in str(caught.value)+str(caught.value.diagnostics)
    assert len(count)==(1 if status in {401,403} else 6 if status==400 else 2)  # 400: strict, non-strict, json_object per model


@pytest.mark.anyio
@pytest.mark.parametrize("content",["bad JSON","{}",'{"act":"execute_order"}',"null"])
async def test_groq_malformed_results_fail_closed(content):
    def handler(request):
        return httpx.Response(200,json={"choices":[{"finish_reason":"stop","message":{"content":content}}]})
    client=GroqClient(Settings(groq_api_key="synthetic"),transport=httpx.MockTransport(handler))
    with pytest.raises(ProviderUnavailable):
        await client.call(stage="u",models=(),system="s",user="synthetic",schema=Meaning,parse=lambda s:parse_structured(Meaning,s))


def test_missing_groq_preserves_gemini_only_and_no_env_modification(monkeypatch):
    from app.chat import __main__ as cli
    monkeypatch.setattr(cli,"load_settings",lambda:Settings(gemini_api_key="synthetic"))
    _,interpreter,_=cli.build("gemini")
    assert [name for name,_ in interpreter.client.providers]==["gemini"]
    monkeypatch.setenv("GROQ_API_KEY","synthetic-loaded")
    assert load_settings().groq_api_key=="synthetic-loaded"


@pytest.mark.anyio
async def test_both_providers_fail_safe_grounded_reply_and_diagnostics():
    b,_,_=build("rules")
    failure=ProviderUnavailable("safe",diagnostics=(ProviderDiagnostic("api_unavailable","sdk",503),))
    chain=ProviderChain([("gemini",ScriptedProvider([failure])),("groq",ScriptedProvider([failure]))],Settings())
    chat=ChatSession(b.data(),b.scope(),ConversationInterpreter(chain,Settings()),NaturalResponder(chain,Settings()))
    turn=await chat.send("black tshirt size L price",context_token=b.token(b.scope()))
    assert "275.00 EGP" in turn.response.reply and turn.response.orderCandidate is None
    assert turn.execution.generation.source=="conversational_rules"
    assert {d.provider for d in turn.understanding.provider_diagnostics}=={"gemini","groq"}


@pytest.mark.anyio
async def test_natural_price_and_comparison_without_stock_noise():
    b,i,r=build("fake")
    chat=ChatSession(b.data(),b.scope(),i,r)
    await chat.send("عندكم تيشيرت أسود؟",context_token=b.token(b.scope()))
    turn=await chat.send("طب مقاس L بكام؟",context_token=b.token(b.scope()))
    assert "275 جنيه" in turn.response.reply
    assert all(word not in turn.response.reply for word in ("color:","size:","المخزون","حجز","Cotton"))
    comparison=await chat.send("أنا محتارة بين الأسود والأبيض، وعايزة مقاس L بس مش عارفة أنهي لون أحسن",context_token=b.token(b.scope()))
    assert "275 جنيه" in comparison.response.reply and "285 جنيه" in comparison.response.reply
    assert len(comparison.response.reply)<150 and "بنفس المقاس" in comparison.response.reply
    assert comparison.response.intent.value=="INQUIRY" and comparison.response.orderCandidate is None
    assert "أفضل" not in comparison.response.reply  # no invented preference/quality


@pytest.mark.anyio
async def test_natural_grounding_rejects_plausible_extra_prose_and_missing_facts():
    b,i,r=build("rules")
    turn=await ChatSession(b.data(),b.scope(),i,r).send("black tshirt size L price",context_token=b.token(b.scope()))
    facts,_=clauses_for(turn.execution.plan)
    for payload in [dict(sentences=[],warmth="friendly",question_style="direct"),
                    dict(sentences=[dict(fact_ids=["fake"],join="and")],warmth="friendly",question_style="direct"),
                    dict(sentences=[dict(fact_ids=[f.id for f in facts],join="and")],warmth="friendly",question_style="direct",reply="Price 1, free delivery")]:
        with pytest.raises((StructuredOutputError,ValueError)):
            validate_composition(parse_structured(NaturalReply,json.dumps(payload)),facts)


def dev_client(backend,handler=None):
    def wrapped(request):
        if request.url.path=="/auth/me":
            return httpx.Response(200,json={"id":identifier(9,1),"businesses":[{"id":str(backend.scope().business_id),"role":"OWNER"}]})
        return handler(request) if handler else httpx.Response(500)
    transport=httpx.MockTransport(wrapped)
    return DevelopmentBackendClient("http://127.0.0.1:3000","synthetic-owner",backend.scope().business_id,
                                    revision=MAIN_REVISION,transport=transport)


@pytest.mark.anyio
async def test_development_adapter_actual_get_contract_through_chat():
    b=SyntheticBackend()
    seen=[]
    def handler(request):
        seen.append(request)
        assert request.method=="GET" and request.headers["Authorization"]=="Bearer synthetic-owner"
        assert "X-AI-Context" not in request.headers
        path=request.url.path
        product=b.products[1][0]
        if path.endswith("/products"):
            from app.chat.synthetic import page
            data=page(b.products[1],int(request.url.params["limit"]),int(request.url.params["offset"]))
        elif "/variants/" in path:
            data=next(v for v in product["variants"] if v["id"]==path.split("/")[-1])
        else:
            data=product
        return httpx.Response(200,json=data)
    client=dev_client(b,handler)
    _,i,r=build("rules")
    turn=await ChatSession(BackendDataAccess(client),b.scope(),i,r).send("black tshirt size L price",context_token=client.local_context_token())
    assert "275.00 EGP" in turn.response.reply and seen
    assert "synthetic-owner" not in str(turn.diagnostics())


@pytest.mark.anyio
async def test_development_scope_and_missing_history_fail_closed():
    b=SyntheticBackend()
    calls=[]
    client=dev_client(b,lambda r:calls.append(r))
    with pytest.raises(BackendAuthenticationError):
        await client.get_products(context_token="another-session")
    with pytest.raises(BackendClientError,match="history contract unavailable"):
        await client.get_conversation_history(str(b.scope().conversation_id),context_token=client.local_context_token())
    assert not calls


@pytest.mark.parametrize("url",["https://production.up.railway.app","https://neon.tech","http://example.com","http://user:pass@localhost","http://localhost/?token=secret"])
def test_development_adapter_blocks_production_and_unsafe_origins(url):
    with pytest.raises(ValueError):
        DevelopmentBackendClient(url,"synthetic",identifier(1,1),revision=MAIN_REVISION)


def test_pending_pr_history_mapping_checks_customer_conversation_and_business():
    scope=SyntheticBackend().scope()
    conversation={"id":str(scope.conversation_id),"businessId":str(scope.business_id),"customerId":str(scope.customer_id)}
    from app.chat.synthetic import page
    rows=page([{"id":identifier(6,1),"conversationId":str(scope.conversation_id),"senderType":"CUSTOMER","content":"synthetic","messageType":"TEXT","createdAt":"2026-11-04T12:00:00Z"}])
    assert validate_pending_history_contract(conversation,rows,scope)["tool"]=="get_conversation_history"
    conversation["customerId"]=identifier(2,2)
    with pytest.raises(ValueError):
        validate_pending_history_contract(conversation,rows,scope)


@pytest.mark.anyio
async def test_development_cli_requires_explicit_approval_before_http():
    with pytest.raises(ChatConfigurationError,match="allow-development-backend"):
        await run("rules",[],development=True)


@pytest.mark.anyio
async def test_full_chat_gemini_503_to_actual_mocked_groq_completions():
    from tests.fake_gemini import FakeGemini,api_error
    from google.genai import errors
    primary=FakeGemini({"r-a":api_error(errors.ServerError,503),"r-b":api_error(errors.ServerError,503)},gemini_max_retries=1)
    settings=replace(primary.settings,groq_api_key="synthetic-groq")
    seen=[]
    def handler(request):
        body=json.loads(request.content)
        seen.append(body["response_format"]["json_schema"]["name"])
        data=json.loads(body["messages"][1]["content"])
        if seen[-1]=="Meaning":
            content=json.dumps(data["rulesHint"])
        else:
            content=json.dumps({"sentences":[{"fact_ids":[f["id"] for f in data["facts"]],"join":"and"}],
                                "warmth":"neutral","question_style":"direct"})
        return httpx.Response(200,json={"choices":[{"finish_reason":"stop","message":{"content":content}}]})
    chain=ProviderChain([("gemini",primary),("groq",GroqClient(settings,transport=httpx.MockTransport(handler)))],settings)
    backend=SyntheticBackend()
    turn=await ChatSession(backend.data(),backend.scope(),ConversationInterpreter(chain,settings),NaturalResponder(chain,settings)).send(
        "black tshirt size L price",context_token=backend.token(backend.scope()))
    assert seen==["Meaning","NaturalReply"]
    assert turn.understanding.source=="groq_understanding"
    assert turn.execution.generation.source=="groq_conversation"
    assert "275.00 EGP" in turn.response.reply and turn.response.orderCandidate is None
    assert turn.diagnostics()["providerFailures"]["understanding"][0]["provider"]=="gemini"


@pytest.mark.anyio
async def test_semantically_invalid_primary_selection_fails_over_before_retrieval():
    payload=json.loads(meaning_json())
    payload["product_handle"]="p99"
    settings=Settings()
    chain=ProviderChain([("gemini",ScriptedProvider([json.dumps(payload)])),("groq",ScriptedProvider([meaning_json()]))],settings)
    understood=await ConversationInterpreter(chain,settings).understand("black tshirt size L price",Selection())
    assert understood.source=="groq_understanding"
    assert not understood.inquiry.product_ids


@pytest.mark.anyio
async def test_model_guard_rejection_fails_over_to_secondary_composition():
    b,i,r=build("rules")
    plan=(await ChatSession(b.data(),b.scope(),i,r).send("black tshirt size L price",context_token=b.token(b.scope()))).execution.plan
    facts,_=clauses_for(plan)
    valid={"sentences":[{"fact_ids":[f.id for f in facts],"join":"and"}],"warmth":"neutral","question_style":"direct"}
    bad={**valid,"sentences":[{"fact_ids":["unverified"],"join":"and"}]}
    chain=ProviderChain([("gemini",ScriptedProvider([json.dumps(bad)])),("groq",ScriptedProvider([json.dumps(valid)]))],Settings())
    # A provider implementation must enforce the supplied parser. Groq and
    # Gemini do; the chain also classifies unexpected provider parser errors.
    reply=await NaturalResponder(chain,Settings()).generate(plan)
    assert reply.source=="groq_conversation" and "275.00 EGP" in reply.response.reply


@pytest.mark.anyio
async def test_half_open_probe_does_not_block_other_customers():
    now=[0]
    entered=asyncio.Event()
    release=asyncio.Event()
    class Primary:
        calls=0
        async def call(self,**kwargs):
            self.calls+=1
            if self.calls==1:
                raise ProviderUnavailable("safe")
            entered.set()
            await release.wait()
            return kwargs["parse"](meaning_json()),"primary"
    primary=Primary()
    chain=ProviderChain([("gemini",primary),("groq",ScriptedProvider([meaning_json()]))],Settings(chat_circuit_seconds=1),clock=lambda:now[0])
    args=dict(stage="u",models=(),system="s",user="synthetic",schema=Meaning,parse=lambda s:parse_structured(Meaning,s))
    await chain.call(**args)
    now[0]=2
    probing=asyncio.create_task(chain.call(**args))
    await entered.wait()
    other=await chain.call(**args)
    assert other.provider=="groq" and primary.calls==2
    release.set()
    assert (await probing).provider=="gemini"


@pytest.mark.anyio
async def test_same_guard_and_actual_prices_for_stock_unknown_and_qty_shortfall():
    b,i,r=build("rules")
    chat=ChatSession(b.data(),b.scope(),i,r)
    price=await chat.send("white tshirt size M price",context_token=b.token(b.scope()))
    assert "225.00 EGP" in price.response.reply and "stock" not in price.response.reply
    purchase=await chat.send("I want two of it",context_token=b.token(b.scope()))
    assert "availability needs confirmation" in purchase.response.reply and purchase.response.orderCandidate is None
    await chat.send("black tshirt size L price",context_token=b.token(b.scope()))
    too_many=await chat.send("I want 9 of it",context_token=b.token(b.scope()))
    assert "full requested quantity is not currently available" in too_many.response.reply
    assert "4" not in too_many.response.reply and too_many.response.requiresReview
    assert "review availability" in too_many.response.reply


@pytest.mark.anyio
@pytest.mark.parametrize("status",[401,403,404,500,302])
async def test_development_adapter_errors_no_redirects_and_no_secret_leak(status):
    b=SyntheticBackend()
    client=dev_client(b,lambda req:httpx.Response(status,headers={"Location":"https://production.invalid"},text="PRIVATE_PAYLOAD"))
    with pytest.raises(BackendClientError) as caught:
        await client.get_products(context_token=client.local_context_token())
    assert "PRIVATE" not in str(caught.value) and "synthetic-owner" not in str(caught.value)


@pytest.mark.anyio
async def test_development_wrong_tenant_response_is_rejected_by_shared_data_layer():
    b=SyntheticBackend()
    from copy import deepcopy
    from app.chat.synthetic import page
    products=deepcopy(b.products[1])
    products[0]["businessId"]=identifier(1,2)
    client=dev_client(b,lambda req:httpx.Response(200,json=page(products)))
    outcome=await BackendDataAccess(client).get_products(scope=b.scope(),context_token=client.local_context_token())
    assert outcome.status.value=="scope_mismatch" and outcome.envelope is None


@pytest.mark.anyio
@pytest.mark.parametrize("identity,status",[({},200),([],200),({"businesses":[]},200),({},404),({},401)])
async def test_missing_authentication_capability_blocks_all_catalog_reads(identity,status):
    seen=[]
    def handler(request):
        seen.append(request.url.path)
        return httpx.Response(status,json=identity)
    b=SyntheticBackend()
    client=DevelopmentBackendClient("http://localhost:3000","synthetic",b.scope().business_id,revision=MAIN_REVISION,
                                    transport=httpx.MockTransport(handler))
    with pytest.raises(BackendClientError):
        await client.get_products(context_token=client.local_context_token())
    assert seen==["/auth/me"]


@pytest.mark.anyio
async def test_franco_script_is_preserved_and_exact_stock_is_only_when_requested():
    b,i,r=build("fake")
    from dataclasses import replace
    i.settings=replace(i.settings,stock_quantity_disclosure_businesses=(str(b.scope().business_id),))
    chat=ChatSession(b.data(),b.scope(),i,r)
    await chat.send("3andkom tshirt eswed",context_token=b.token(b.scope()))
    franco=await chat.send("bekam size L",context_token=b.token(b.scope()))
    assert "275 geneh" in franco.response.reply and "el eswed" in franco.response.reply
    assert "stock" not in franco.response.reply and "makhzoon" not in franco.response.reply
    stock=await chat.send("How many left in stock?",context_token=b.token(b.scope()))
    assert "latest availability: 4 units" in stock.response.reply
    assert "final availability needs confirmation" in stock.response.reply


@pytest.mark.anyio
async def test_changed_current_price_is_disclosed_on_quantity_only_purchase():
    b,i,r=build("rules")
    chat=ChatSession(b.data(),b.scope(),i,r)
    await chat.send("black tshirt size L price",context_token=b.token(b.scope()))
    b.products[1][0]["variants"][1].update(unitPrice="300.50",effectivePrice="300.50")
    turn=await chat.send("I want two of it",context_token=b.token(b.scope()))
    assert "300.50 EGP" in turn.response.reply and "275.00 EGP" not in turn.response.reply


@pytest.mark.anyio
async def test_missing_all_provider_keys_is_explicit_and_deterministic():
    b=SyntheticBackend()
    chain=ProviderChain([],Settings())
    turn=await ChatSession(b.data(),b.scope(),ConversationInterpreter(chain,Settings()),NaturalResponder(chain,Settings())).send(
        "black tshirt size L price",context_token=b.token(b.scope()))
    assert turn.understanding.provider_diagnostics[0].category=="missing_key_configuration"
    assert turn.execution.generation.source=="conversational_rules"
    assert "275.00 EGP" in turn.response.reply


@pytest.mark.anyio
async def test_franco_comparison_uses_two_actual_variants():
    b,i,r=build("fake")
    chat=ChatSession(b.data(),b.scope(),i,r)
    await chat.send("3andkom tshirt eswed size L",context_token=b.token(b.scope()))
    turn=await chat.send("ana me7tar ben eswed abyad size L",context_token=b.token(b.scope()))
    assert turn.response.intent.value=="INQUIRY"
    assert "275 geneh" in turn.response.reply and "285 geneh" in turn.response.reply
    assert len(turn.execution.plan.matching_variant_ids)==2 and turn.response.orderCandidate is None


@pytest.mark.anyio
async def test_groq_400_degrades_schema_then_succeeds_and_never_leaks_payload():
    """Groq rejects the strict reply schema (HTTP 400): retry non-strict, then JSON mode, same model."""
    from app.chat.natural import NaturalReply
    seen=[]
    good='{"sentences":[{"fact_ids":["f0"],"join":"and"}],"warmth":"neutral","question_style":"direct"}'
    def handler(request):
        body=json.loads(request.content)
        seen.append(body)
        if body["response_format"].get("type")=="json_schema" and body["response_format"]["json_schema"]["strict"]:
            return httpx.Response(400,json={"error":{"message":"PRIVATE_DETAIL","type":"invalid_request_error"}})
        return httpx.Response(200,json={"choices":[{"finish_reason":"stop","message":{"content":good}}]})
    client=GroqClient(Settings(groq_api_key="synthetic"),transport=httpx.MockTransport(handler))
    value,model=await client.call(stage="r",models=(),system="s",user="u",schema=NaturalReply,
                                  parse=lambda s:parse_structured(NaturalReply,s))
    assert value.sentences[0].fact_ids==["f0"] and len(seen)==2
    assert seen[0]["response_format"]["json_schema"]["strict"] is True and seen[0].get("reasoning_effort")=="low"
    assert seen[1]["response_format"]["json_schema"]["strict"] is False and "reasoning_effort" not in seen[1]
    # wire schema is plain: no $ref/$defs and no array bounds
    wire=json.dumps(seen[0]["response_format"]["json_schema"]["schema"])
    assert "$ref" not in wire and "$defs" not in wire and "minItems" not in wire and "maxItems" not in wire


@pytest.mark.anyio
async def test_groq_400_hint_is_allowlisted_only():
    def handler(request):
        return httpx.Response(400,json={"error":{"message":"PRIVATE_DETAIL","code":"json_validate_failed"}})
    client=GroqClient(Settings(groq_api_key="k"),transport=httpx.MockTransport(handler))
    with pytest.raises(ProviderUnavailable) as caught:
        await client.call(stage="u",models=(),system="s",user="u",schema=Meaning,parse=lambda s:parse_structured(Meaning,s))
    assert any(d.schema_hint=="json_validate_failed" for d in caught.value.diagnostics)
    assert "PRIVATE" not in str(caught.value.diagnostics)

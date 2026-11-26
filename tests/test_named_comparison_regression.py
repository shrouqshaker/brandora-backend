"""Named-product semantic and exact NaturalReply SDK regressions. No network."""
import asyncio
from dataclasses import replace
from decimal import Decimal,localcontext
import json
from types import SimpleNamespace

import httpx
import pytest
from google.genai import models,types,errors

from app.chat.__main__ import build
from app.chat.application import ChatSession
from app.chat.understanding import ConversationInterpreter,Meaning,Selection,rules_meaning
from app.chat.natural import NaturalReply,NaturalResponder
from app.chat.synthetic import SyntheticBackend
from app.data.search import search_terms,canonical_search
from app.pipeline.price_comparison import compare_verified_pair
from app.providers.failover import ProviderChain
from app.providers.groq import GroqClient
from app.providers.gemini import GeminiClient
from app.providers.structured import parse_structured,wire_json_schema,classify_failure,StructuredOutputError
from tests.fake_gemini import FakeGemini,gemini_settings


FIRST="أنا محتارة بين الأسود والأبيض، وعايزة مقاس L، أنهي واحد عندكم أرخص؟"
NAMED="قصدي التيشيرت القطن، الأسود والأبيض مقاس L، أنهي أرخص؟"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def meaning(search="تيشيرت القطن",**changes):
    return {**dict(act="compare",search=search,product_handle=None,options={"size":"L"},
                  option_alternatives={"color":["Black","White"]},quantity=None,language="ar"),**changes}


def composition(ids=("f0","f1","f2")):
    return json.dumps(dict(sentences=[dict(fact_ids=list(ids),join="and")],warmth="neutral",question_style="direct"))


def assert_pair(turn):
    assert turn.response.intent.value=="INQUIRY" and turn.response.orderCandidate is None
    assert turn.understanding.inquiry.option_values["size"]=="L"
    assert len(turn.understanding.inquiry.option_alternatives["color"])==2
    assert len(turn.execution.plan.matching_variant_ids)==2
    assert "275 جنيه" in turn.response.reply and "285 جنيه" in turn.response.reply
    assert "أرخص بـ10 جنيه" in turn.response.reply
    assert not turn.execution.plan.requires_clarification
    comparison=compare_verified_pair(turn.execution.plan)
    assert comparison.difference==Decimal("10.00")


@pytest.mark.parametrize("text",["تيشيرت","التيشيرت","تيشرت","tshirt","tee","T-Shirt"])
def test_product_synonyms_and_definite_articles(text):
    assert "تيشيرت" in search_terms(text)
    assert rules_meaning(text,Selection()).act=="product"


def test_comparison_words_and_option_values_do_not_become_name_terms():
    assert search_terms(NAMED)==("تيشيرت","قطن")
    assert search_terms(FIRST)==()
    assert canonical_search("cotton T-Shirt, which is cheaper?")=="قطن تيشيرت"
    assert rules_meaning(NAMED,Selection()).option_alternatives["color"]==["اسود","ابيض"]


@pytest.mark.anyio
@pytest.mark.parametrize("mode",["rules","fake"])
async def test_exact_two_turn_live_regression(mode):
    b,i,r=build(mode)
    chat=ChatSession(b.data(),b.scope(),i,r)
    first=await chat.send(FIRST,context_token=b.token(b.scope()))
    assert first.response.intent.value=="INQUIRY"
    assert not first.execution.plan.products and "منتج" in first.response.reply
    last=await chat.send(NAMED,context_token=b.token(b.scope()))
    assert_pair(last)
    assert last.tools==("get_products","get_product_details")


@pytest.mark.anyio
async def test_gemini_compatible_structured_fields_and_raw_noisy_search():
    payload=meaning(search=NAMED)
    fake=FakeGemini({"r-a":json.dumps(payload),"g-a":composition()},gemini_max_retries=1)
    b=SyntheticBackend()
    turn=await ChatSession(b.data(),b.scope(),ConversationInterpreter(fake,fake.settings),NaturalResponder(fake,fake.settings)).send(
        NAMED,context_token=b.token(b.scope()))
    assert turn.understanding.source=="gemini_understanding"
    assert turn.understanding.meaning.search==NAMED  # valid parsed search, not logged at runtime
    assert turn.understanding.meaning.product_handle is None
    assert turn.understanding.meaning.options=={"size":"L"}
    assert turn.understanding.meaning.option_alternatives=={"color":["Black","White"]}
    assert turn.understanding.inquiry.text=="price تيشيرت قطن منتج"
    assert_pair(turn)


@pytest.mark.anyio
async def test_groq_compatible_http_understanding_and_reply():
    seen=[]
    def handler(request):
        payload=json.loads(request.content)
        name=payload["response_format"]["json_schema"]["name"]
        seen.append(name)
        content=json.dumps(meaning(search="cotton t-shirt")) if name=="Meaning" else composition()
        return httpx.Response(200,json={"choices":[{"finish_reason":"stop","message":{"content":content}}]})
    settings=replace(gemini_settings(),groq_api_key="synthetic")
    chain=ProviderChain([("groq",GroqClient(settings,transport=httpx.MockTransport(handler)))],settings)
    b=SyntheticBackend()
    turn=await ChatSession(b.data(),b.scope(),ConversationInterpreter(chain,settings),NaturalResponder(chain,settings)).send(
        NAMED,context_token=b.token(b.scope()))
    assert seen==["Meaning","NaturalReply"] and turn.understanding.source=="groq_understanding"
    assert turn.understanding.meaning.search=="cotton t-shirt"
    assert_pair(turn)


@pytest.mark.anyio
@pytest.mark.parametrize("bad",[meaning(search="luxury hoodie"),meaning(search=""),meaning(product_handle="p0"),
    meaning(option_alternatives={}),meaning(options={"size":"M"})])
async def test_unusable_primary_semantics_trigger_controlled_provider_attempt(bad):
    primary=FakeGemini({"r-a":json.dumps(bad),"r-b":json.dumps(bad)},gemini_max_retries=1)
    secondary=FakeGemini({"r-a":json.dumps(meaning()),"g-a":composition()},gemini_max_retries=1)
    settings=primary.settings
    chain=ProviderChain([("gemini",primary),("groq",secondary)],settings)
    b=SyntheticBackend()
    turn=await ChatSession(b.data(),b.scope(),ConversationInterpreter(chain,settings),NaturalResponder(chain,settings)).send(
        NAMED,context_token=b.token(b.scope()))
    assert turn.understanding.source=="groq_understanding"
    assert turn.understanding.provider_diagnostics and turn.execution.diagnostics.backend_calls==2
    assert_pair(turn)


@pytest.mark.anyio
async def test_known_context_and_changed_selections_remain_fresh():
    b,i,r=build("fake")
    chat=ChatSession(b.data(),b.scope(),i,r)
    await chat.send("عايزة اتنين تيشيرت أسود مقاس L",context_token=b.token(b.scope()))
    comparison=await chat.send(FIRST,context_token=b.token(b.scope()))
    assert comparison.understanding.inquiry.product_ids
    assert comparison.execution.plan.requested_quantity is None
    assert_pair(comparison)
    changed=await chat.send("طب عايزة الأبيض مقاس M",context_token=b.token(b.scope()))
    assert "225 جنيه" in changed.response.reply and "285 جنيه" not in changed.response.reply
    unrelated=await chat.send("hoodie price",context_token=b.token(b.scope()))
    assert not unrelated.execution.plan.matching_variant_ids and not chat.selection.products


@pytest.mark.anyio
async def test_franco_comparative_price_difference():
    b,i,r=build("fake")
    turn=await ChatSession(b.data(),b.scope(),i,r).send("tshirt cotton eswed abyad size L anhi arkhas?",context_token=b.token(b.scope()))
    assert turn.response.intent.value=="INQUIRY"
    assert "275 geneh" in turn.response.reply and "285 geneh" in turn.response.reply
    assert "arkhas b 10 geneh" in turn.response.reply


@pytest.mark.anyio
@pytest.mark.parametrize("name",["Cotton T-Shirt","تيشيرت القطن","تيشيرت قطن Cotton T-Shirt"])
async def test_catalog_name_language_does_not_change_the_comparison(name):
    b,i,r=build("rules")
    b.products[1][0]["name"]=name
    turn=await ChatSession(b.data(),b.scope(),i,r).send(NAMED,context_token=b.token(b.scope()))
    assert_pair(turn)


@pytest.mark.anyio
async def test_substantive_qualifier_cannot_be_discarded_to_find_another_product():
    b,i,r=build("rules")
    b.products[1][0]["name"]="Polyester T-Shirt"
    turn=await ChatSession(b.data(),b.scope(),i,r).send(NAMED,context_token=b.token(b.scope()))
    assert not turn.execution.plan.products
    assert "275" not in turn.response.reply and "285" not in turn.response.reply


@pytest.mark.anyio
@pytest.mark.parametrize("duplicate",[True,False])
async def test_two_matching_variants_must_cover_both_requested_colors(duplicate):
    b,i,r=build("rules")
    variants=b.products[1][0]["variants"]
    if duplicate:
        variants[2]["optionValues"]["color"]="Black"
        message=NAMED
    else:
        variants[2]["isActive"]=variants[3]["isActive"]=False
        message=NAMED.replace("مقاس L","")
    turn=await ChatSession(b.data(),b.scope(),i,r).send(message,context_token=b.token(b.scope()))
    assert len(turn.execution.plan.matching_variant_ids)==2
    assert compare_verified_pair(turn.execution.plan) is None
    assert "أرخص بـ" not in turn.response.reply


@pytest.mark.anyio
async def test_equal_and_unconfirmed_prices_do_not_invent_difference():
    for price in ("275.00",None):
        b,i,r=build("rules")
        b.products[1][0]["variants"][2].update(unitPrice=price,effectivePrice=price)
        turn=await ChatSession(b.data(),b.scope(),i,r).send(NAMED,context_token=b.token(b.scope()))
        if price is None:
            assert compare_verified_pair(turn.execution.plan) is None and "أرخص بـ" not in turn.response.reply
        else:
            assert "بنفس السعر" in turn.response.reply and compare_verified_pair(turn.execution.plan).difference==0


@pytest.mark.anyio
async def test_decimal_difference_is_exact_even_with_small_external_context():
    b,i,r=build("rules")
    b.products[1][0]["variants"][1].update(unitPrice="9999999999.98",effectivePrice="9999999999.98")
    b.products[1][0]["variants"][2].update(unitPrice="9999999999.99",effectivePrice="9999999999.99")
    turn=await ChatSession(b.data(),b.scope(),i,r).send(NAMED,context_token=b.token(b.scope()))
    with localcontext() as context:
        context.prec=4
        assert compare_verified_pair(turn.execution.plan).difference==Decimal("0.01")


def test_exact_natural_reply_schema_serializes_through_installed_sdk():
    config=types.GenerateContentConfig(system_instruction="synthetic",temperature=.3,response_mime_type="application/json",
                                       response_json_schema=wire_json_schema(NaturalReply))
    params=types._GenerateContentParameters(model="synthetic-model",contents="synthetic",config=config)
    wire=models._GenerateContentParameters_to_mldev(SimpleNamespace(vertexai=False),params)
    generation=wire["generationConfig"]
    assert generation["responseMimeType"]=="application/json" and "responseSchema" not in generation
    schema=generation["responseJsonSchema"]
    assert set(schema["required"])=={"sentences","warmth","question_style"}
    assert schema["additionalProperties"] is False
    assert schema["properties"]["sentences"]["items"]["$ref"]=="#/$defs/Sentence"
    assert schema["$defs"]["Sentence"]["additionalProperties"] is False
    assert isinstance(parse_structured(NaturalReply,composition()),NaturalReply)


@pytest.mark.anyio
async def test_actual_gemini_generate_config_for_natural_reply():
    client=GeminiClient(gemini_settings())
    configs=[]
    async def generate_content(**kwargs):
        configs.append(kwargs["config"])
        return types.GenerateContentResponse(candidates=[types.Candidate(content=types.Content(parts=[types.Part(text=composition())]),finish_reason="STOP")])
    client._client=SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate_content)))
    parsed,_=await client.call(stage="conversation-reply",models=("synthetic-model",),system="synthetic",user="synthetic",
                              schema=NaturalReply,parse=lambda s:parse_structured(NaturalReply,s),temperature=.3)
    assert isinstance(parsed,NaturalReply)
    assert configs[0].response_schema is None and configs[0].response_json_schema==wire_json_schema(NaturalReply)


@pytest.mark.parametrize("field,category,hint",[
    ("generation_config.response_json_schema.properties.PRIVATE_FIELD","api_schema_error","response_json_schema"),
    ("generationConfig.responseSchema","api_schema_error","response_schema"),
    ("contents.PRIVATE_FIELD","api_request_error",None)])
def test_http400_field_violations_only_expose_fixed_schema_hint(field,category,hint):
    error=errors.ClientError(400,{"error":{"code":400,"message":"Invalid argument PRIVATE_CUSTOMER", "details":[
        {"@type":"type.googleapis.com/google.rpc.BadRequest","fieldViolations":[{"field":field,"description":"PRIVATE_PAYLOAD"}]}]}})
    result=classify_failure(error,"sdk")
    assert result.category==category and result.schema_hint==hint
    assert "PRIVATE" not in str(result)


def test_generic_http400_remains_unresolved_not_automatically_schema_error():
    error=errors.ClientError(400,{"error":{"message":"Invalid argument"}})
    result=classify_failure(error,"sdk")
    assert result.category=="api_request_error" and result.schema_hint is None

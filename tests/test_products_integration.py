"""Real FastAPI + signed synthetic contexts + mocked internal Backend. Offline."""
import asyncio
from dataclasses import replace
import json
import time

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from google.auth import crypt, jwt

from main import create_app
from app.config import ConfigError, Settings
from app.clients.backend_client import BackendClient, PRODUCT_TOOLS
from app.chat.synthetic import SyntheticBackend, identifier


@pytest.fixture(scope="module")
def keys():
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    private=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())
    public=key.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    return crypt.RSASigner.from_string(private),public


@pytest.fixture
def setup(keys):
    signer,public=keys
    backend=SyntheticBackend()
    calls=[]
    now=int(time.time())
    claims=dict(iss="brandora-backend",aud="brandora-ai-products",scope="products:read",
        businessId=identifier(1,1),messageId=identifier(9,1),iat=now,exp=now+120)
    def token(**patch):
        return jwt.encode(signer,{**claims,**patch}).decode()
    def handler(request):
        body=json.loads(request.content)
        calls.append((body,request.headers["X-AI-Context"]))
        assert body["tool"] in PRODUCT_TOOLS and "businessId" not in body["arguments"]
        assert request.headers["Authorization"]=="Bearer " + "synthetic-outbound-credential-32-chars"
        # Mock server authenticates the signed context, then uses scoped fixtures.
        verified=jwt.decode(request.headers["X-AI-Context"],certs=public,audience="brandora-ai-products")
        selected=1 if verified["businessId"]==identifier(1,1) else 2
        raw=httpx.Request("POST","https://synthetic.invalid/internal/ai/data",json=body,headers={
            "Authorization":"Bearer synthetic-service","X-AI-Context":backend.token(backend.scope(selected))})
        return backend._handle(raw)
    config=Settings(ai_provider="rules",legacy_api_enabled=True,app_env="local",
                 ai_service_token="synthetic-inbound-credential-32-chars",
        products_integration_enabled=True,backend_base_url="https://backend.invalid",
        backend_service_token="synthetic-outbound-credential-32-chars",backend_context_public_key=public)
    def client(handler_override=None,*,model_client=None,**patch):
        return TestClient(create_app(replace(config,**patch),products_transport=httpx.MockTransport(handler_override or handler),
                                    products_model_client=model_client))
    return backend,calls,claims,token,config,client


PATH="/v2/ai/products/respond"


def send(setup,client=None,*,headers_patch=None,body_patch=None,token_patch=None,message="black tshirt size L price"):
    backend,calls,claims,token,config,factory=setup
    headers={"X-Internal-Token":config.ai_service_token,"X-AI-Context":token(**(token_patch or {}))}
    headers.update(headers_patch or {})
    body={"businessId":claims["businessId"],"messageId":claims["messageId"],"message":message}
    body.update(body_patch or {})
    return (client or factory()).post(PATH,json=body,headers=headers)


def test_success_current_effective_price_and_exact_e03_contract(setup):
    result=send(setup)
    assert result.status_code==200
    body=result.json()
    assert set(body)=={"intent","reply","requiresReview","orderCandidate"}
    assert body["intent"]=="INQUIRY" and "275.00 EGP" in body["reply"] and body["orderCandidate"] is None
    assert {call[0]["tool"] for call in setup[1]}=={"get_products","get_product_details","get_variant_details"}


@pytest.mark.parametrize("headers",[{"X-Internal-Token":""},{"X-Internal-Token":"bad"},
    {"X-AI-Context":""},{"X-AI-Context":"arbitrary-uuid-is-not-auth"},{"X-AI-Context":"bad.jwt.signature"}])
def test_missing_invalid_auth_and_context_do_not_read_backend(setup,headers):
    result=send(setup,headers_patch=headers)
    assert result.status_code==401 and not setup[1]


@pytest.mark.parametrize("patch",[{"iss":"wrong"},{"aud":"wrong"},{"scope":"orders:write"},
    {"exp":1},{"iat":int(time.time())+500},{"exp":int(time.time())+1000},
    {"iat":True},{"nbf":int(time.time())+500},{"businessId":identifier(1,2)},{"messageId":identifier(9,2)}])
def test_signed_claim_constraints_and_binding(setup,patch):
    result=send(setup,token_patch=patch)
    assert result.status_code in {401,403} and not setup[1]


def test_signature_tampering_and_wrong_algorithm_are_rejected(setup,keys):
    token=setup[3]()
    parts=token.split(".")
    parts[1]=parts[1][:-2]+("AA" if not parts[1].endswith("AA") else "BB")
    assert send(setup,headers_patch={"X-AI-Context":".".join(parts)}).status_code==401
    wrong=jwt.encode(keys[0],setup[2],header={"alg":"HS256"}).decode()
    assert send(setup,headers_patch={"X-AI-Context":wrong}).status_code==401
    assert not setup[1]


@pytest.mark.parametrize("status",[401,403,404,500,503])
def test_backend_errors_never_invent_a_product_answer(setup,status):
    def handler(_):
        return httpx.Response(status,text="PRIVATE_PROVIDER_PAYLOAD")
    result=send(setup,client=setup[5](handler))
    assert result.status_code==(403 if status in {401,403} else 200)
    assert "PRIVATE" not in result.text and "275" not in result.text
    if result.status_code==200:
        assert result.json()["orderCandidate"] is None


@pytest.mark.parametrize("failure",["timeout","json","shape","tenant"])
def test_invalid_backend_evidence_and_timeouts_are_safe(setup,failure):
    def handler(request):
        if failure=="timeout":
            raise httpx.ReadTimeout("PRIVATE_TOKEN",request=request)
        if failure=="json":
            return httpx.Response(200,text="PRIVATE_NON_JSON")
        if failure=="shape":
            return httpx.Response(200,json={"tool":"get_products","data":{}})
        args=json.loads(request.content)["arguments"]
        return httpx.Response(200,json={"tool":"get_products","data":{
            "items":setup[0].products[2],"pagination":{"limit":args["limit"],"offset":args["offset"],"totalCount":2,"hasMore":False,"nextOffset":None}}})
    result=send(setup,client=setup[5](handler))
    assert result.status_code==(403 if failure=="tenant" else 200)
    assert "275" not in result.text and "PRIVATE" not in result.text


@pytest.mark.parametrize("withdraw",["product","variant"])
def test_inactive_records_do_not_quote_withdrawn_price(setup,withdraw):
    product=setup[0].products[1][0]
    if withdraw=="product":
        product["isActive"]=product["isSellable"]=False
    else:
        product["variants"][1]["isActive"]=False
    response=send(setup)
    assert response.status_code==200 and "275" not in response.text
    assert response.json()["orderCandidate"] is None


def test_quantities_stock_limitations_no_orders(setup):
    response=send(setup,message="I want 10 black tshirt size L")
    assert response.status_code==200
    assert response.json()["intent"]=="PURCHASE_INTENT" and response.json()["orderCandidate"] is None
    assert "4" not in response.json()["reply"] and "10" in response.json()["reply"]
    assert "not currently available" in response.json()["reply"]
    assert "review availability" in response.json()["reply"] and response.json()["requiresReview"]


def test_business_info_cannot_escape_four_product_tools(setup):
    result=send(setup,message="what is your business name")
    assert result.status_code==200 and not setup[1]


def test_stateless_followup_cannot_read_conversations(setup):
    result=send(setup,message="how much for that one?")
    assert result.status_code==200
    assert all(call[0]["tool"] in PRODUCT_TOOLS for call in setup[1])
    assert result.json()["orderCandidate"] is None


@pytest.mark.parametrize("patch",[{"backend_service_token":None},{"ai_service_token":None},
    {"backend_context_public_key":None},{"backend_base_url":"http://nonlocal.invalid"},
    {"backend_base_url":"https://user:PRIVATE@backend.invalid"},
    {"backend_service_token":"synthetic-inbound-credential-32-chars"}])
def test_incomplete_or_unsafe_configuration_fails_closed(setup,patch):
    with pytest.raises(ConfigError) as error:
        setup[5](**patch)
    assert "PRIVATE" not in str(error.value)


@pytest.mark.parametrize("env",["staging","production"])
def test_environment_rejects_open_legacy_auth_and_dev_endpoints(env):
    with pytest.raises(ConfigError):
        create_app(Settings(ai_provider="rules",app_env=env))
    with pytest.raises(ConfigError):
        create_app(Settings(ai_provider="rules",app_env=env,ai_service_token="synthetic-strong-inbound-credential",enable_dev_endpoints=True))


def test_new_endpoint_disabled_by_default_and_v1_contract_untouched():
    client=TestClient(create_app(Settings(ai_provider="rules", app_env="local", legacy_api_enabled=True)))
    assert client.post(PATH,json={}).status_code==404
    schema=client.get("/openapi.json").json()
    assert "/v1/ai/respond" in schema["paths"]
    assert schema["paths"]["/v1/ai/respond"]["post"]["requestBody"]["content"]["application/json"]["schema"]["$ref"].endswith("AIRespondRequest")


def test_client_https_and_product_only_allowlist_before_http():
    with pytest.raises(ValueError,match="HTTPS"):
        BackendClient("http://backend.invalid","synthetic")
    client=BackendClient("https://backend.invalid","synthetic",allowed_tools=PRODUCT_TOOLS,
        transport=httpx.MockTransport(lambda _:pytest.fail("Unexpected HTTP")))
    with pytest.raises(ValueError):
        asyncio.run(client.get_business_info(context_token="synthetic"))


def test_tokens_and_scope_are_isolated_across_http_requests(setup):
    from concurrent.futures import ThreadPoolExecutor
    setup[0].products[2][0]["variants"][1].update(unitPrice="900.00",effectivePrice="900.00")
    client=setup[5]()
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending=pool.submit(send,setup,client)
        other=pool.submit(send,setup,client,token_patch={"businessId":identifier(1,2),"messageId":identifier(9,2)},
                        body_patch={"businessId":identifier(1,2),"messageId":identifier(9,2)})
        first,second=pending.result(),other.result()
    assert first.status_code==second.status_code==200
    assert "275.00 EGP" in first.json()["reply"] and "900" not in first.json()["reply"]
    assert "900.00 EGP" in second.json()["reply"] and "275" not in second.json()["reply"]
    observed={token for _,token in setup[1]}
    assert len(observed)==2


def test_product_and_embedded_variant_pagination_are_retrieved(setup):
    from copy import deepcopy
    from app.chat.synthetic import page
    tools=[]
    b=setup[0]
    def handler(request):
        body=json.loads(request.content)
        tool,args=body["tool"],body["arguments"]
        tools.append(tool)
        product=deepcopy(b.products[1][0])
        product["variants"]=product["variants"][:1]
        product["variantsPagination"]={"limit":1,"offset":0,"totalCount":6,"hasMore":True,"nextOffset":1}
        if tool=="get_products":
            items=[b.products[1][1]] if args["offset"]==0 else [product]
            data={"items":items,"pagination":{"limit":args["limit"],"offset":args["offset"],"totalCount":2,
                "hasMore":args["offset"]==0,"nextOffset":1 if args["offset"]==0 else None}}
            return httpx.Response(200,json={"tool":tool,"data":data})
        if tool=="get_product_details":
            return httpx.Response(200,json={"tool":tool,"data":product})
        raw=httpx.Request("POST","https://synthetic.invalid/internal/ai/data",json=body,headers={
            "Authorization":"Bearer synthetic-service","X-AI-Context":b.token(b.scope())})
        return b._handle(raw)
    result=send(setup,client=setup[5](handler))
    assert result.status_code==200 and "275.00 EGP" in result.json()["reply"]
    assert tools.count("get_products")==2 and "get_product_variants" in tools


def test_new_http_path_reuses_groq_and_guard_for_named_comparison(setup):
    from app.providers.failover import ProviderChain
    from app.providers.groq import GroqClient
    from tests.test_named_comparison_regression import NAMED, meaning, composition
    stages=[]
    def handler(request):
        body=json.loads(request.content)
        name=body["response_format"]["json_schema"]["name"]
        stages.append(name)
        content=json.dumps(meaning()) if name=="Meaning" else composition()
        return httpx.Response(200,json={"choices":[{"finish_reason":"stop","message":{"content":content}}]})
    config=replace(setup[4],groq_api_key="synthetic-groq-test")
    chain=ProviderChain([("groq",GroqClient(config,transport=httpx.MockTransport(handler)))],config)
    result=send(setup,client=setup[5](model_client=chain),message=NAMED)
    assert result.status_code==200 and stages==["Meaning","NaturalReply"]
    assert all(price in result.json()["reply"] for price in ("275","285","10"))
    assert result.json()["intent"]=="INQUIRY" and result.json()["orderCandidate"] is None


def test_production_products_requires_https_inbound(setup):
    response=send(setup,client=setup[5](app_env="production",legacy_api_enabled=False,
                                       ai_service_token="synthetic-strong-inbound-credential"))
    assert response.status_code==400 and not setup[1]

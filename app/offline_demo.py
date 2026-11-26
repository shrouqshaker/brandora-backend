"""Explicit synthetic HTTP harness. Never imported by the release service.

Interactive: python -m app.offline_demo
Local server: python -m app.offline_demo --serve (127.0.0.1 only)
"""
import os
os.environ["PYTHON_DOTENV_DISABLED"]="1"

import argparse
import json
import hashlib
import time
import asyncio
from datetime import datetime,timedelta,timezone
from copy import deepcopy

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from google.auth import crypt,jwt

from .config import Settings
from .http import create_app
from .chat.synthetic import SyntheticBackend,identifier
from .providers.groq import GroqClient
from .providers.failover import ProviderChain


class OfflineHarness:
    """Mock Backend identity/data ownership. No network transports or real keys."""
    def __init__(self,**settings_patch):
        key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        private=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())
        public=key.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        self.signer=crypt.RSASigner.from_string(private)
        self.backend=SyntheticBackend()
        self.backend_failure=None
        self.model_failure=None
        self.calls=[]
        self.model_calls=[]
        self.counter=0
        self.timeline=0
        self.messages={}
        self.history_status={}
        self.history_patch=None
        self.history_chunk_size=20
        self.history_delay=0
        self.settings=Settings(**{**dict(ai_provider="rules",ai_service_token="offline-inbound-not-a-real-credential",
            backend_service_token="offline-outbound-not-a-real-credential",backend_context_public_key=public,
            backend_base_url="https://synthetic.invalid",ai_integration_enabled=True,
            products_integration_enabled=True,groq_api_key="offline-model-not-a-real-key"),**settings_patch})
        chain=ProviderChain([("groq",GroqClient(self.settings,transport=httpx.MockTransport(self._model)))],self.settings)
        self.app=create_app(self.settings,products_transport=httpx.MockTransport(self._backend),products_model_client=chain)

    async def _backend(self,request):
        if request.headers.get("Authorization") != "Bearer " + self.settings.backend_service_token:
            return httpx.Response(401)
        if request.method == "GET" and request.url.path == "/internal/ai/health":
            # Health is a service-only read: no context token and no tenant data.
            return httpx.Response(200, json={"status":"ready", "database":"up",
                                             "contract":"conversation-tools-v1"})
        claims=jwt.decode(request.headers["X-AI-Context"],certs=self.settings.backend_context_public_key,
                          audience=["brandora-ai-tools-v1","brandora-ai"])
        business=next((b for b in (1,2) if claims["businessId"]==identifier(1,b)),None)
        if business is None:
            return httpx.Response(403)
        body=json.loads(request.content)
        self.calls.append({"tool":body["tool"],"businessId":claims["businessId"],
                           "customerId":claims["customerId"],"conversationId":claims["conversationId"]})
        scope=tuple(claims[k] for k in ("businessId","customerId","conversationId"))
        permitted={(str(s.business_id),str(s.customer_id),str(s.conversation_id))
                   for b in (1,2) for c in (1,2) for s in (self.backend.scope(b,c),)}
        if scope not in permitted:
            return httpx.Response(403)
        if self.backend_failure=="timeout":
            raise httpx.ReadTimeout("Synthetic timeout",request=request)
        if type(self.backend_failure) is int:
            return httpx.Response(self.backend_failure)
        if self.backend_failure=="json":
            return httpx.Response(200,text="not JSON")
        if body["tool"]=="get_conversation_history":
            if self.history_delay:
                await asyncio.sleep(self.history_delay)
            if claims["scope"]!="products:read conversations:read":
                return httpx.Response(403)
            if body["arguments"]["conversationId"] != claims["conversationId"]:
                return httpx.Response(403)
            if self.history_status.get(scope)=="unavailable":
                return httpx.Response(404)
            rows=self.messages.get(scope,[])
            anchor=next((r for r in rows if r["id"]==claims["messageId"]),None)
            if anchor is None:
                return httpx.Response(404)
            prior=sorted([r for r in rows if r["createdAt"]<anchor["createdAt"]],
                         key=lambda r:(r["createdAt"],r["id"]),reverse=True)
            limit,offset=body["arguments"]["limit"],body["arguments"]["offset"]
            items=prior[offset:offset+min(limit,self.history_chunk_size)]
            end=offset+len(items)
            data={"businessId":claims["businessId"],"customerId":claims["customerId"],
                "conversationId":claims["conversationId"],"beforeMessageId":claims["messageId"],
                "beforeMessageCreatedAt":anchor["createdAt"],"order":"createdAt_desc_id_desc",
                "snapshot":hashlib.sha256(json.dumps(prior,sort_keys=True).encode()).hexdigest(),
                "complete":self.history_status.get(scope,"complete")=="complete",
                "items":deepcopy(items),"pagination":{"limit":limit,"offset":offset,"totalCount":len(prior),
                    "hasMore":end<len(prior),"nextOffset":end if end<len(prior) else None}}
            if self.history_patch:
                self.history_patch(data,body["arguments"])
            return httpx.Response(200,json={"tool":"get_conversation_history","data":data})
        raw=httpx.Request("POST",str(request.url),json=body,headers={"Authorization":"Bearer synthetic-service",
            "X-AI-Context":self.backend.token(self.backend.scope(business))})
        return self.backend._handle(raw)

    async def _model(self,request):
        body=json.loads(request.content)
        name=body["response_format"]["json_schema"]["name"]
        self.model_calls.append(name)
        if self.model_failure=="slow":
            await asyncio.sleep(.2)
        if self.model_failure=="timeout":
            raise httpx.ReadTimeout("Synthetic timeout",request=request)
        if type(self.model_failure) is int:
            return httpx.Response(self.model_failure)
        payload=json.loads(body["messages"][1]["content"])
        value=payload["rulesHint"] if name=="Meaning" else {
            "sentences":[{"fact_ids":[f["id"] for f in payload["facts"]],"join":"and"}],
            "warmth":"friendly","question_style":"gentle"}
        if self.model_failure=="reverse_alternatives" and name=="Meaning":
            value={**value,"option_alternatives":{k:list(reversed(v)) for k,v in value["option_alternatives"].items()}}
        if self.model_failure=="semantic" and name=="Meaning":
            value={**value,"product_handle":"invented"}
        if self.model_failure=="guard" and name=="NaturalReply":
            value={**value,"sentences":[{"fact_ids":["invented"],"join":"and"}]}
        content="not JSON" if self.model_failure=="json" else json.dumps(value,ensure_ascii=False)
        return httpx.Response(200,json={"choices":[{"finish_reason":"stop","message":{"content":content}}]})

    def body(self,message,history=(),*,business=1,customer=1,message_id=None,history_status="complete"):
        self.counter+=1
        scope=self.backend.scope(business,customer)
        body={"businessId":str(scope.business_id),"customerId":str(scope.customer_id),
            "conversationId":str(scope.conversation_id),"messageId":message_id or identifier(9,self.counter),
            "message":message}
        key=tuple(body[k] for k in ("businessId","customerId","conversationId"))
        self.history_status[key]=history_status
        for row in history:  # Fixture setup only: never included in HTTP JSON.
            self.store(key,row)
        return body

    def store(self,scope,row):
        rows=self.messages.setdefault(scope,[])
        if any(r["id"]==row["id"] for r in rows):
            return
        self.timeline+=1
        stamp=(datetime(2026,10,16,tzinfo=timezone.utc)+timedelta(seconds=self.timeline)).isoformat()
        rows.append({"conversationId":scope[2],"messageType":"TEXT","createdAt":stamp,
                     "externalMessageId":None,**row})

    def persist_current(self,body):
        key=tuple(body[k] for k in ("businessId","customerId","conversationId"))
        self.store(key,{"id":body["messageId"],"senderType":"CUSTOMER","content":body["message"]})

    def encode(self,body,**claims_patch):
        raw=json.dumps(body,ensure_ascii=False,separators=(",",":")).encode("utf-8")
        now=int(time.time())
        claims={"iss":"brandora-backend","aud":"brandora-ai-tools-v1","scope":"products:read conversations:read",
            **{k:body[k] for k in ("businessId","customerId","conversationId","messageId")},
            "iat":now,"exp":now+120,"requestHash":hashlib.sha256(raw).hexdigest(),**claims_patch}
        token=jwt.encode(self.signer,claims).decode()
        return raw,{"X-Internal-Token":self.settings.ai_service_token,"X-AI-Context":token,"Content-Type":"application/json"}

    def send(self,body,**claims_patch):
        from fastapi.testclient import TestClient
        raw,headers=self.encode(body,**claims_patch)
        self.persist_current(body)
        return TestClient(self.app).post("/v2/ai/respond",content=raw,headers=headers)


def demo_app():
    from fastapi import Request,HTTPException
    harness=OfflineHarness()
    @harness.app.post("/demo/context",include_in_schema=False)
    async def context(request: Request):
        if not request.client or request.client.host not in {"127.0.0.1","::1"}:
            raise HTTPException(403,"Loopback demo only")
        body=await request.json()
        scope=(body.get("businessId"),body.get("customerId"),body.get("conversationId"))
        permitted={(str(s.business_id),str(s.customer_id),str(s.conversation_id))
                   for b in (1,2) for c in (1,2) for s in (harness.backend.scope(b,c),)}
        if scope not in permitted:
            raise HTTPException(403,"Synthetic scope only")
        harness.persist_current(body)
        raw,headers=harness.encode(body)
        # Synthetic credentials/context only. Return exact bytes for hash binding.
        return {"body":raw.decode(),"headers":headers}
    return harness.app


SCENARIOS=(
    ("comparison",("عندكم تيشيرت أسود؟","طب مقاس L بكام؟","عايزة اتنين منه",
        "طب غيرت رأيي عايزة الأبيض","أنا محتارة بين الأسود والأبيض مقاس L أنهي أرخص؟"),("275","285","10")),
    ("size_change",("عندكم تيشيرت أبيض مقاس L؟","طب مقاس M بكام؟"),("225",)),
    ("price_followup",("عندكم تيشيرت أسود؟","طب مقاس L بكام؟"),("275",)),
    ("franco",("3andkom tshirt eswed","bekam size L"),("275",)),
    ("quantity",("عايزة 10 تيشيرت أسود مقاس L",),("10","مش متاحة بالكامل","المسؤول")),
    ("selection_correction",("عندكم تيشيرت أسود؟","طب مقاس L بكام؟","طب عايزة 10 قطع من مقاس L",
        "طب خلاص، خليهم 3 قطع من الأبيض مقاس L بدل الأسود"),("285","3","الأبيض","L")),
    ("named_comparison",("قصدي التيشيرت القطن الأسود والأبيض مقاس L أنهي أرخص؟",),("275","285","10")),
    ("stock_zero",("عندكم تيشيرت أزرق مقاس M؟",),("0",)),
    ("untracked",("عندكم تيشيرت أبيض مقاس M؟",),("225",)),
    ("missing_price",("عندكم كاب بكام؟",),("مؤكد",)),
    ("cancel",("عايزة اتنين تيشيرت أسود مقاس L","خلاص مش عايزة"),("الاختيار",)),
    ("greeting",("أهلا",),("أساعدك",)),
)


def evaluate():
    failures=[]
    for name,messages,expected in SCENARIOS:
        harness=OfflineHarness()
        for message in messages:
            body=harness.body(message)
            start=len(harness.calls)
            result=harness.send(body)
            tools=[c["tool"] for c in harness.calls[start:]]
            print(json.dumps({"scenario":name,"message":message,"tools":tools,"syntheticGroq":True},ensure_ascii=False))
            if result.status_code != 200 or result.json().get("orderCandidate") is not None:
                failures.append(name)
        passed=result.status_code==200 and all(fragment in result.json().get("reply","") for fragment in expected)
        if not passed:
            failures.append(name)
        print(json.dumps({"scenario":name,"passed":passed,"reply":result.json()},ensure_ascii=False))
    print(json.dumps({"offline":True,"scenarios":len(SCENARIOS),"turns":sum(len(messages) for _,messages,_ in SCENARIOS),
                      "failed":sorted(set(failures)),"liveBackendTested":False,"endpoint":"/v2/ai/respond"}))
    return not failures


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve",action="store_true")
    parser.add_argument("--evaluate",action="store_true")
    args=parser.parse_args()
    if args.evaluate:
        raise SystemExit(0 if evaluate() else 1)
    if args.serve:
        import uvicorn
        uvicorn.run(demo_app(),host="127.0.0.1",port=8787,proxy_headers=False,access_log=False)
        return
    harness=OfflineHarness()
    print("OFFLINE synthetic Backend + Groq-compatible HTTP stub. /reset or /quit")
    while True:
        try:
            message=input("You> ")
        except EOFError:
            break
        if message=="/quit":
            break
        if message=="/reset":
            harness=OfflineHarness()
            continue
        body=harness.body(message)
        start=len(harness.calls)
        result=harness.send(body)
        print("AI>",result.json())
        print("Tools>",[c["tool"] for c in harness.calls[start:]],"| synthetic Groq-compatible stub, not live inference")


if __name__ == "__main__":
    main()

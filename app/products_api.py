"""Shared authenticated boundary: canonical conversations and compatible Products.

RS256 context claims are a proposed Backend handoff contract, not an assertion
that Backend main currently issues them. No token signing or key discovery here.
"""
import hmac
import time
import asyncio
import hashlib
import math
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from google.auth import crypt, jwt
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, field_validator

from .config import ConfigError
from .clients.backend_client import BackendClient, PRODUCT_TOOLS,CONVERSATION_TOOLS
from .data.backend import BackendDataAccess
from .chat.application import ConversationPlanner
from .chat.understanding import ConversationInterpreter, Selection, asks_stock_quantity
from .chat.natural import NaturalResponder
from .pipeline.standalone import StandalonePipeline
from .providers.failover import ProviderChain
from .providers.groq import GroqClient
from .schemas.backend import ExpectedScope, Identifier, RetrievalStatus
from .schemas.response import AiResponse
from .conversation_api import ConversationFields,ConversationIdentityFields, execute_conversation,execute_supplied_conversation


# Backend and AI run on different hosts; tolerate a few seconds of clock drift on `iat` only.
CLOCK_SKEW_SECONDS = 10


class ProductRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    businessId: Identifier
    messageId: Identifier
    message: StrictStr = Field(min_length=1,max_length=2000,repr=False)

    @field_validator("message")
    @classmethod
    def nonblank(cls,value):
        if not value.strip():
            raise ValueError("Message must not be blank")
        return value.strip()


class ContextClaims(BaseModel):
    model_config = ConfigDict(extra="forbid",frozen=True)
    iss: Literal["brandora-backend"]
    aud: Literal["brandora-ai-products"]
    scope: Literal["products:read"]
    businessId: Identifier
    messageId: Identifier
    iat: StrictInt
    exp: StrictInt
    nbf: StrictInt | None = None


class SuppliedConversationRequest(ProductRequest,ConversationFields):
    model_config = ConfigDict(extra="forbid",frozen=True)


class SuppliedConversationClaims(ContextClaims):
    aud: Literal["brandora-ai"]
    customerId: Identifier
    conversationId: Identifier
    requestHash: StrictStr = Field(pattern=r"^[0-9a-f]{64}$")


class ConversationRequest(ProductRequest,ConversationIdentityFields):
    model_config = ConfigDict(extra="forbid",frozen=True)


class ConversationClaims(SuppliedConversationClaims):
    aud: Literal["brandora-ai-tools-v1"]
    scope: Literal["products:read conversations:read"]


def build_products_router(settings, *, transport=None, model_client=None):
    """Only called when explicitly enabled; injected transports are test seams."""
    inbound = settings.ai_service_token
    outbound = settings.backend_service_token
    public_key = settings.backend_context_public_key
    if (not inbound or len(inbound) < 32 or not inbound.isascii() or not inbound.isprintable()
            or not outbound or len(outbound) < 32 or not outbound.isascii() or not outbound.isprintable()
            or inbound.strip() != inbound or outbound.strip() != outbound
            or hmac.compare_digest(inbound,outbound) or not public_key or not settings.backend_base_url):
        raise ConfigError("Products integration requires distinct service credentials, Backend origin and context public key")
    try:
        key=load_pem_public_key(public_key.encode("ascii"))
        if not isinstance(key,RSAPublicKey) or key.key_size < 2048:
            raise ValueError()
        crypt.RSAVerifier.from_string(public_key)
        client = BackendClient(settings.backend_base_url,outbound,timeout=settings.backend_timeout_seconds,
                               max_response_bytes=settings.backend_max_response_bytes,
                               allowed_tools=PRODUCT_TOOLS,transport=transport)
        if settings.app_env != "local" and not settings.backend_base_url.startswith("https://"):
            raise ValueError()
    except Exception:
        raise ConfigError("Invalid Products integration public key, HTTPS origin or timeout configuration") from None
    data = BackendDataAccess(client)
    if (not math.isfinite(settings.integration_timeout_seconds)
            or not 0 < settings.integration_timeout_seconds <= 60):
        raise ConfigError("Integration deadline must be positive and at most 60 seconds")
    if model_client is None:
        model_client = ProviderChain([("groq",GroqClient(settings))] if settings.groq_api_key else [],settings)
    interpreter = ConversationInterpreter(model_client,settings)
    responder = NaturalResponder(model_client,settings)
    router = APIRouter()

    def authenticate(request,x_internal_token,x_ai_context,*,claim_type=ContextClaims,audience="brandora-ai-products"):
        if settings.app_env != "local" and request.url.scheme != "https":
            raise HTTPException(400,"HTTPS required")
        if (not x_internal_token or len(x_internal_token) > 4096
                or not hmac.compare_digest(x_internal_token.encode("utf-8"),inbound.encode("utf-8"))):
            raise HTTPException(401,"Invalid service authentication")
        try:
            if not x_ai_context or len(x_ai_context) > 8192:
                raise ValueError()
            header = jwt.decode_header(x_ai_context)
            if (header.get("alg") != "RS256" or header.get("typ") != "JWT"
                    or set(header) - {"alg","typ","kid"}
                    or ("kid" in header and (not isinstance(header["kid"],str) or len(header["kid"]) > 100))):
                raise ValueError()
            claims = claim_type.model_validate(jwt.decode(x_ai_context,certs=public_key,
                audience=audience,verify=True,clock_skew_in_seconds=CLOCK_SKEW_SECONDS))
            now = time.time()
            if not (0 <= claims.iat <= now + CLOCK_SKEW_SECONDS and now < claims.exp <= claims.iat + 300):
                raise ValueError()
            if claims.nbf is not None and claims.nbf > now:
                raise ValueError()
        except Exception:
            raise HTTPException(401,"Invalid Backend context") from None
        # Token remains a per-call header, never a shared field or model input.
        return claims,x_ai_context

    def authenticate_products(request: Request,x_internal_token: str | None = Header(default=None),
                     x_ai_context: str | None = Header(default=None)):
        return authenticate(request,x_internal_token,x_ai_context)

    async def respond(body: ProductRequest, verified=Depends(authenticate_products)):
        claims,token = verified
        if claims.businessId != body.businessId or claims.messageId != body.messageId:
            raise HTTPException(403,"Backend context binding mismatch")
        scope = ExpectedScope(business_id=claims.businessId)
        try:
            understood = await interpreter.understand(body.message,Selection())
            execution = await StandalonePipeline(data,responder,planner=ConversationPlanner(understood,
                allow_stock_quantity_disclosure=(asks_stock_quantity(body.message) and
                    str(scope.business_id) in settings.stock_quantity_disclosure_businesses))).execute(
                understood.inquiry,scope=scope,message_id=claims.messageId,context_token=token,
                prepare_history=False,products_only=True)
            if execution.retrieval.failure in {RetrievalStatus.AUTHORIZATION_FAILED,RetrievalStatus.SCOPE_MISMATCH}:
                raise HTTPException(403,"Backend authorization rejected")
            result = execution.response
            if result.orderCandidate is not None or result.intent.value == "CONFIRMED_ORDER":
                raise ValueError()
            return result
        except HTTPException:
            raise
        except Exception:
            # No traceback/payload reaches global logging or the caller.
            raise HTTPException(503,"Products response unavailable") from None

    if settings.products_integration_enabled:
        router.add_api_route("/v2/ai/products/respond",respond,methods=["POST"],response_model=AiResponse,tags=["products"])

    # The completed Products route remains compatible. Canonical requests share
    # its exact data/provider/security assembly, not a second processing system.
    if settings.ai_integration_enabled:
        canonical_data=BackendDataAccess(BackendClient(settings.backend_base_url,outbound,timeout=settings.backend_timeout_seconds,
                                   max_response_bytes=settings.backend_max_response_bytes,
                                   allowed_tools=CONVERSATION_TOOLS,transport=transport))
        async def authenticate_conversation(request: Request,x_internal_token: str | None = Header(default=None),
                         x_ai_context: str | None = Header(default=None)):
            claims,token=authenticate(request,x_internal_token,x_ai_context,
                                      claim_type=ConversationClaims,audience="brandora-ai-tools-v1")
            if not hmac.compare_digest(claims.requestHash,hashlib.sha256(await request.body()).hexdigest()):
                raise HTTPException(403,"Backend context body binding mismatch")
            return claims,token

        @router.post("/v2/ai/respond",response_model=AiResponse,tags=["ai-integration"])
        async def conversation(body: ConversationRequest,response: Response,verified=Depends(authenticate_conversation)):
            claims,token=verified
            if any(getattr(claims,key) != getattr(body,key) for key in
                   ("businessId","customerId","conversationId","messageId")):
                raise HTTPException(403,"Backend context binding mismatch")
            try:
                turn,history_status=await asyncio.wait_for(execute_conversation(body,token,canonical_data,interpreter,responder,settings),
                                            timeout=settings.integration_timeout_seconds)
                result=turn.response
                if result.orderCandidate is not None or result.intent.value == "CONFIRMED_ORDER":
                    raise ValueError()
                response.headers["X-AI-History-Status"]=history_status
                response.headers["X-AI-Contract"]="conversation-tools-v1"
                response.headers["X-AI-Understanding-Provider"]=turn.understanding.source.split("_")[0]
                response.headers["X-AI-Reply-Provider"]=turn.diagnostics()["replyProvider"]
                response.headers["X-AI-Message-Id"]=str(body.messageId)
                return result
            except HTTPException:
                raise
            except asyncio.TimeoutError:
                raise HTTPException(503,"AI request deadline exceeded") from None
            except Exception:
                raise HTTPException(503,"AI response unavailable") from None

        if settings.supplied_context_compat_enabled:
            async def authenticate_supplied(request: Request,x_internal_token: str | None = Header(default=None),
                             x_ai_context: str | None = Header(default=None)):
                claims,token=authenticate(request,x_internal_token,x_ai_context,
                    claim_type=SuppliedConversationClaims,audience="brandora-ai")
                if not hmac.compare_digest(claims.requestHash,hashlib.sha256(await request.body()).hexdigest()):
                    raise HTTPException(403,"Backend context body binding mismatch")
                return claims,token

            @router.post("/v2/ai/respond-with-context",response_model=AiResponse,tags=["compatibility"],deprecated=True)
            async def supplied(body: SuppliedConversationRequest,response: Response,verified=Depends(authenticate_supplied)):
                claims,token=verified
                if any(getattr(claims,k)!=getattr(body,k) for k in ("businessId","customerId","conversationId","messageId")):
                    raise HTTPException(403,"Backend context binding mismatch")
                try:
                    turn=await asyncio.wait_for(execute_supplied_conversation(body,token,data,interpreter,responder,settings),
                                               timeout=settings.integration_timeout_seconds)
                    response.headers["X-AI-Contract"]="supplied-context-v1"
                    response.headers["Deprecation"]="true"
                    return turn.response
                except HTTPException:
                    raise
                except Exception:
                    raise HTTPException(503,"AI response unavailable") from None

    return router

"""Developer playground (mock data). Mounted ONLY when ENABLE_DEV_ENDPOINTS=true; never part of the production path."""
from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator

from .pipeline.orchestrator import Orchestrator
from .schemas import AIRespondRequest


class DevRequest(BaseModel):
    customerWaId: str = Field(examples=["201000000001"])
    message: str = Field(examples=["عايز تيشيرت"])
    includeRequest: bool = False

    @field_validator("message")
    @classmethod
    def _clean(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("message must not be empty")
        return value[:2000]


def build_dev_router(orchestrator: Orchestrator, require_token: Callable) -> APIRouter:
    import mock_data  # root-level dev fixture, imported lazily so the production path never loads it

    router = APIRouter(dependencies=[Depends(require_token)])

    @router.get("/customers")
    async def customers() -> list[dict[str, Any]]:
        biz = {b["id"]: b["name"] for b in mock_data.BUSINESSES.values()}
        return [{"waId": c["waId"], "name": c["name"], "business": biz[c["businessId"]]} for c in mock_data.CUSTOMERS]

    @router.post("/respond-with-mock")
    async def respond_with_mock(body: DevRequest) -> dict[str, Any]:
        payload = mock_data.build_request(body.customerWaId, body.message)
        execution = await orchestrator.respond(AIRespondRequest.model_validate(payload))
        response, trace = execution.response, execution.trace
        out: dict[str, Any] = {"response": response.model_dump(mode="json"), "trace": trace.__dict__}
        if body.includeRequest:
            out["request"] = payload
        return out

    return router

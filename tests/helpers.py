"""Shared test helpers: run the real pipeline on mock-data requests and expose both the E0-3 body and the internals."""
from __future__ import annotations

import asyncio
import copy
import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import jsonschema

import mock_data
from app.config import Settings
from app.pipeline.orchestrator import Orchestrator, Trace
from app.providers import build_providers
from app.schemas import AiResponse, AIRespondRequest, Intent, Plan

C1, C2, C3, C4, C5, C6, C7, C8, C9, C10 = (f"2010000000{n:02d}" for n in range(1, 11))

SCHEMA = json.loads((Path(__file__).parent / "e03_schema.json").read_text(encoding="utf-8"))
VALIDATOR = jsonschema.Draft202012Validator(SCHEMA, format_checker=jsonschema.FormatChecker())


def rules_settings(**kw) -> Settings:
    return Settings(ai_provider="rules", **kw)


def rules_orchestrator(**kw) -> Orchestrator:
    s = rules_settings(**kw)
    return Orchestrator(s, build_providers(s))


@dataclass
class R:
    """One pipeline run: the E0-3 response + the planner's internals."""

    response: AiResponse
    plan: Plan
    trace: Trace
    request: dict

    @property
    def body(self) -> dict:
        return self.response.model_dump(mode="json")

    @property
    def intent(self) -> Intent:          # fine-grained internal intent
        return self.plan.detailed_intent

    @property
    def e03(self) -> str:
        return self.response.intent.value

    @property
    def reply(self) -> str:
        return self.response.reply

    @property
    def clarification(self) -> bool:
        return self.plan.clarification

    @property
    def candidate(self):
        return self.response.orderCandidate

    @property
    def secondary(self):
        return self.plan.secondary


def build(wa: str, text: str, mutate: Callable[[dict], None] | None = None) -> dict:
    payload = mock_data.build_request(wa, text)
    if mutate:
        mutate(payload)
    return payload


def run_payload(orch: Orchestrator, payload: dict) -> R:
    request = AIRespondRequest.model_validate(copy.deepcopy(payload))
    execution = asyncio.run(orch.respond(request))
    response, trace = execution.response, execution.trace
    VALIDATOR.validate(response.model_dump(mode="json"))   # EVERY response must satisfy the official E0-3 schema
    return R(response, execution.plan, trace, payload)


def run(orch: Orchestrator, wa: str, text: str, mutate: Callable[[dict], None] | None = None) -> R:
    return run_payload(orch, build(wa, text, mutate))


def add_history(*turns: tuple[str, str]) -> Callable[[dict], None]:
    """Replace the conversation with (who, text) turns, who in {"c", "a"}; newest-first like the real messages API."""
    def mutate(payload: dict) -> None:
        conv = [{"id": str(uuid.uuid4()), "senderType": "CUSTOMER" if who == "c" else "AI", "content": text,
                 "messageType": "TEXT", "createdAt": f"2026-10-21T10:{i:02d}:00Z"} for i, (who, text) in enumerate(turns)]
        payload["conversation"] = list(reversed(conv))
    return mutate

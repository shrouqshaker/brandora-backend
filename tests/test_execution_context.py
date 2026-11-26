"""Request ownership with genuinely overlapping provider awaits; no live APIs."""
import asyncio
from dataclasses import FrozenInstanceError
from decimal import Decimal
import gc
import json
import weakref

from google.genai import errors
import pytest

from app.pipeline.execution import ExecutionResult
from app.pipeline.orchestrator import AIUnavailable, Orchestrator
from app.providers import build_providers
from app.providers.base import Providers
from app.providers.gemini import GeminiClient
from app.providers.rules import RulesRouter
from app.schemas import AIRespondRequest, Intent, RouterResult
from tests.backend_contract_fixtures import BUSINESS_A, BUSINESS_B, CUSTOMER_A, CUSTOMER_B
from tests.fake_gemini import FakeGemini, api_error, gemini_settings, router_json
from tests.helpers import C1, VALIDATOR, build


def request(label="Alpha", *, same_business=False):
    payload = build(C1, "how much is the T-Shirt?")
    alpha = label == "Alpha"
    payload["business"].update(id=BUSINESS_A if alpha or same_business else BUSINESS_B, name=label)
    payload["customer"] = {"id": CUSTOMER_A if alpha else CUSTOMER_B}
    payload["messageId"] = f"60000000-0000-4000-8000-{1 if alpha else 2:012d}"
    payload["catalog"] = [{"id": f"40000000-0000-4000-8000-{1 if alpha else 2:012d}",
                            "name": label + " T-Shirt", "basePrice": "111.00" if alpha else "999.00",
                            "isActive": True, "attributes": {"material": label}}]
    payload["conversation"] = [{"id": f"70000000-0000-4000-8000-{1 if alpha else 2:012d}",
                                "senderType": "CUSTOMER", "content": label + " private history",
                                "messageType": "TEXT", "createdAt": "2026-11-03T10:00:00Z"}]
    payload["businessKnowledge"] = {"faqs": [{"question": label, "answer": label + " answer"}]}
    payload["customerOrders"] = []
    return AIRespondRequest.model_validate(payload)


class OverlappingGemini(GeminiClient):
    """Real parsing/retry policy with only the network method replaced.

    Synchronization counters are test instrumentation, never request content.
    """
    def __init__(self, failure):
        super().__init__(gemini_settings(router_models=("router",), generator_models=("generator",),
                                        gemini_max_retries=1))
        self.failure = failure
        self.router_arrivals = 0
        self.both_routing = asyncio.Event()

    async def _generate(self, model, system, user, **kwargs):
        if model == "router":
            self.router_arrivals += 1
            if self.router_arrivals == 2:
                self.both_routing.set()
            await asyncio.wait_for(self.both_routing.wait(), timeout=2)
            await asyncio.sleep(0)
            if "Business: Alpha" in user and self.failure == "router":
                raise api_error(errors.ServerError, 503, "unavailable")
            return router_json(["PRICE_INQUIRY"], product_query="T-Shirt")
        await asyncio.sleep(0)
        payload = json.loads(user)
        if payload["business_name"] == "Alpha":
            if self.failure == "generator":
                raise api_error(errors.ServerError, 503, "unavailable")
            if self.failure == "guard":
                return "Alpha T-Shirt is 1 EGP."
        return payload["draft"]


@pytest.mark.parametrize("same_business", [True, False])
@pytest.mark.parametrize("failure", [None, "router", "generator", "guard"])
def test_overlapping_customers_keep_context_routing_plans_and_fallbacks_local(same_business, failure):
    async def run():
        client = OverlappingGemini(failure)
        orch = Orchestrator(client.settings, build_providers(client.settings, client=client))
        requests = [request(), request("Beta", same_business=same_business)]
        before = [r.model_dump() for r in requests]
        first, second = await asyncio.gather(*(orch.respond(r) for r in requests))
        assert client.router_arrivals == 2  # both requests suspended in routing
        assert set(vars(orch)) == {"settings", "providers"}
        assert not hasattr(orch, "last_plan")
        assert [r.model_dump() for r in requests] == before
        assert first.customer_id == requests[0].customer.id
        assert second.customer_id == requests[1].customer.id
        for result, source, label, price in zip((first, second), requests, ("Alpha", "Beta"), ("111", "999")):
            assert isinstance(result, ExecutionResult)
            assert result.business_id == source.business.id and result.message_id == source.messageId
            assert result.context.history[0].text == label + " private history"
            expected_intents = ([Intent.PRICE_INQUIRY, Intent.PRODUCT_INQUIRY]
                                if label == "Alpha" and failure == "router"
                                else [Intent.PRICE_INQUIRY])
            assert result.routing.intents == expected_intents
            assert result.plan.reply == result.response.reply == f"{label} T-Shirt is {price} EGP."
            VALIDATOR.validate(result.response.model_dump(mode="json"))
        assert first.context is not second.context and first.plan is not second.plan
        assert first.trace is not second.trace and first.routing is not second.routing
        assert first.context.knowledge is not requests[0].businessKnowledge
        if failure == "router":
            assert first.trace.router_source == "rules" and first.trace.fallback_reason
            assert first.trace.generator_model is None
        elif failure in {"generator", "guard"}:
            assert first.trace.guard_violations and first.trace.generator_model is None
        assert second.trace.router_source == "gemini" and not second.trace.guard_violations
        assert second.trace.generator_model == "generator"
        # Mutating request-owned nested state must not touch another execution
        # or the original caller's models.
        first.context.history[0].text = "changed"
        first.context.products[0].attributes["material"] = "changed"
        first.context.knowledge.faqs[0]["answer"] = "changed"
        first.routing.intents.append(Intent.UNKNOWN)
        first.trace.guard_violations.append("local only")
        assert second.context.history[0].text == "Beta private history"
        assert second.context.products[0].attributes["material"] == "Beta"
        assert second.routing.intents == [Intent.PRICE_INQUIRY]
        assert not second.trace.guard_violations
        assert [r.model_dump() for r in requests] == before
    asyncio.run(run())


def test_reused_input_and_provider_result_are_detached_per_execution():
    shared_routing = RouterResult(intents=[Intent.PRICE_INQUIRY, Intent.PRICE_INQUIRY], confidence=4,
                                  product_query="  T-Shirt  ")
    class ReusingRouter:
        async def route(self, ctx):
            await asyncio.sleep(0)
            return shared_routing, None
    async def run():
        source = request()
        orch = Orchestrator(gemini_settings(), Providers("rules", ReusingRouter(), RulesRouter()))
        first, second = await asyncio.gather(orch.respond(source), orch.respond(source))
        assert first.routing.confidence == second.routing.confidence == 1.0
        assert shared_routing.confidence == 4 and len(shared_routing.intents) == 2
        assert shared_routing.product_query == "  T-Shirt  "
        first.context.products[0].basePrice = Decimal("1.00")
        first.context.history.clear()
        assert second.context.products[0].basePrice == source.catalog[0].basePrice == Decimal("111.00")
        assert second.context.history and source.conversation
        with pytest.raises(FrozenInstanceError):
            first.customer_id = CUSTOMER_B
    asyncio.run(run())


def test_hard_rule_decline_has_no_router_and_no_retained_result():
    source = build(C1, "لا خلاص الغي")
    source["conversation"] = [{"senderType": "AI", "content": "تحب تأكد الطلب؟"}]
    fake = FakeGemini({})
    orch = Orchestrator(fake.settings, build_providers(fake.settings, client=fake))
    result = asyncio.run(orch.respond(AIRespondRequest.model_validate(source)))
    assert result.routing is None and result.trace.router_source == "hard-rule"
    assert result.plan.candidate is None and fake.calls == []
    context_ref = weakref.ref(result.context)
    del result
    gc.collect()
    assert context_ref() is None
    assert set(vars(orch)) == {"settings", "providers"}


def test_failed_execution_does_not_replace_or_retain_previous_request_state():
    fake = FakeGemini({"r-a": api_error(errors.ServerError, 503),
                       "r-b": api_error(errors.ServerError, 503)}, fallback_to_rules=False)
    orch = Orchestrator(fake.settings, build_providers(fake.settings, client=fake))
    greeting = request()
    greeting.message.text = "hi"
    previous = asyncio.run(orch.respond(greeting))
    with pytest.raises(AIUnavailable):
        asyncio.run(orch.respond(request("Beta")))
    assert previous.response.reply.startswith("Hi!")
    assert previous.context.text == "hi" and not previous.trace.fallback_reason
    assert set(vars(orch)) == {"settings", "providers"}


@pytest.mark.parametrize("outcome", [
    '{"intents":["PRIVATE_CUSTOMER_CONTENT"],"confidence":0.9}',
    RuntimeError("PRIVATE_CUSTOMER_CONTENT fixture-secret"),
])
def test_shared_provider_health_does_not_retain_customer_error_content(outcome):
    fake = FakeGemini({"r-a": outcome}, gemini_max_retries=1)
    async def run():
        from app.providers.gemini import parse_router
        from app.providers import ProviderUnavailable
        with pytest.raises(ProviderUnavailable):
            await fake.call(stage="router", models=("r-a",), system="s", user="u", parse=parse_router)
    asyncio.run(run())
    assert "PRIVATE_CUSTOMER_CONTENT" not in str(fake.snapshot())
    assert "fixture-secret" not in str(fake.health)

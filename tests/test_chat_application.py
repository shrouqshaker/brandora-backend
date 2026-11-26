"""Actual conversation acceptance through synthetic HTTP and the Phase 1–8 stack."""
import asyncio
import json

import httpx
import pytest

from app.chat.__main__ import build, run
from app.chat.application import ChatSession
from app.chat.responding import ConversationalResponder
from app.chat.synthetic import SyntheticBackend, identifier
from app.chat.understanding import ConversationInterpreter, Selection
from app.schemas.response import AiResponse
from tests.fake_gemini import FakeGemini


@pytest.fixture
def anyio_backend():
    return "asyncio"


def session(mode="rules", business=1, customer=1):
    backend, interpreter, responder = build(mode)
    scope = backend.scope(business, customer)
    return backend, ChatSession(backend.data(), scope, interpreter, responder)


async def send(chat, backend, text):
    turn = await chat.send(text, context_token=backend.token(chat.scope))
    AiResponse.model_validate(turn.response.model_dump())
    assert turn.response.orderCandidate is None
    assert turn.response.intent.value != "CONFIRMED_ORDER"
    assert turn.execution.order_extension.enabled is False
    return turn


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["rules", "fake"])
async def test_required_arabic_conversation(mode):
    backend, chat = session(mode)
    one = await send(chat, backend, "عندكم تيشيرت أسود؟")
    assert "الأسود" in one.response.reply and "مقاس" in one.response.reply
    two = await send(chat, backend, "طب مقاس L بكام؟")
    assert "275 جنيه" in two.response.reply and "250 جنيه" not in two.response.reply
    assert "get_variant_details" in two.tools
    assert "تحدد" not in two.response.reply
    three = await send(chat, backend, "عايزة اتنين منه.")
    assert three.response.intent.value == "PURCHASE_INTENT"
    assert three.execution.plan.requested_quantity == 2
    intent = three.execution.order_extension.purchase_intent
    assert intent.requested_quantity == 2 and intent.confirmation_required
    assert dict(intent.requested_options) == {"color": "Black", "size": "L"}
    assert all(not ref.revalidated for ref in intent.references)
    four = await send(chat, backend, "طب غيرت رأيي عايزة الأبيض.")
    assert "الأبيض" in four.response.reply and "285 جنيه" in four.response.reply
    assert "275.00" not in four.response.reply
    assert four.execution.plan.requested_quantity == 2
    if mode == "fake":
        assert four.understanding.source == "gemini_understanding"
        assert four.execution.generation.source == "gemini_conversation"


@pytest.mark.anyio
@pytest.mark.parametrize("messages", [
    ["Do you have a black tshirt?", "How much is size L?", "I want two of it"],
    ["3andkom tshirt eswed", "bekam size L", "3ayez etneen meno"],
])
async def test_english_and_franco_followups(messages):
    backend, chat = session("fake")
    turns = [await send(chat, backend, message) for message in messages]
    assert any(price in turns[1].response.reply for price in ("275.00 EGP","275 جنيه","275 geneh"))
    assert turns[2].execution.plan.requested_quantity == 2
    assert turns[2].response.intent.value == "PURCHASE_INTENT"


@pytest.mark.anyio
async def test_fresh_inventory_not_previous_reply_authority():
    backend, chat = session()
    await send(chat, backend, "black tshirt size L price")
    v = backend.products[1][0]["variants"][1]
    v.update(unitPrice="299.95", effectivePrice="299.95", stockQuantity=0)
    turn = await send(chat, backend, "How much is it?")
    assert "299.95" in turn.response.reply and "275.00" not in turn.response.reply
    assert "out of stock" in turn.response.reply and "recorded stock" not in turn.response.reply
    assert next(v for v in turn.execution.plan.variants if v.variant_id in turn.execution.plan.matching_variant_ids).recorded_quantity == 0


@pytest.mark.anyio
async def test_arbitrary_arabic_options_followup():
    backend, chat = session()
    product = backend.products[1][0]
    product["options"] = {"التشطيب": ["مطفي", "لامع"]}
    product["variants"] = product["variants"][:2]
    for v, finish in zip(product["variants"], ["مطفي", "لامع"]):
        v["optionValues"] = {"التشطيب": finish}
    product["variantsPagination"]["totalCount"] = 2
    await send(chat, backend, "tshirt price")
    turn = await send(chat, backend, "التشطيب: مطفي")
    assert "250 جنيه" in turn.response.reply
    assert "275.00" not in turn.response.reply
    assert "مطفي" in turn.response.reply


@pytest.mark.anyio
async def test_scope_mismatch_discards_all_evidence():
    backend, chat = session()
    backend.products[1][0]["businessId"] = identifier(1, 2)
    turn = await send(chat, backend, "black tshirt price")
    assert turn.execution.retrieval.failure.value == "scope_mismatch"
    assert not turn.execution.plan.products and not chat.selection.products
    assert "250.00" not in turn.response.reply


@pytest.mark.anyio
async def test_backend_timeout_has_no_stale_reply():
    backend, chat = session()
    await send(chat, backend, "black tshirt size L price")
    def timeout(request):
        raise httpx.ReadTimeout("synthetic-service should never escape")
    chat._data._client._transport = httpx.MockTransport(timeout)
    turn = await send(chat, backend, "How much is it?")
    assert "275.00" not in turn.response.reply and "synthetic-service" not in turn.response.reply
    assert not chat.selection.products


@pytest.mark.anyio
async def test_similar_products_are_not_silently_selected():
    from copy import deepcopy
    backend, chat = session()
    duplicate = deepcopy(backend.products[1][0])
    duplicate.update(id=identifier(4, 999), name="تيشيرت قطن Cotton T-Shirt Premium")
    for i, variant in enumerate(duplicate["variants"]):
        variant.update(catalogItemId=duplicate["id"], id=identifier(5, 900 + i))
    backend.products[1].append(duplicate)
    turn = await send(chat, backend, "black tshirt price")
    assert len(turn.execution.plan.products) == 2
    assert "Which product" in turn.response.reply
    assert "275.00" not in turn.response.reply
    next_turn = await send(chat, backend, "size L")
    assert not next_turn.understanding.inquiry.product_ids


@pytest.mark.anyio
async def test_quantity_shortfall_is_provisional_and_explained():
    backend, chat = session()
    await send(chat, backend, "black tshirt size L price")
    turn = await send(chat, backend, "I want 9 of it")
    assert turn.execution.plan.requested_quantity == 9
    assert "full requested quantity is not currently available" in turn.response.reply
    assert "review availability" in turn.response.reply and turn.response.requiresReview
    assert "4" not in turn.response.reply and turn.response.orderCandidate is None
    assert next(v for v in turn.execution.plan.variants if v.variant_id in turn.execution.plan.matching_variant_ids).recorded_quantity == 4


@pytest.mark.anyio
async def test_fake_evaluation_has_no_failed_checks(capsys):
    from app.chat.evaluate import evaluate
    assert await evaluate("fake")
    assert '"failedChecks": []' in capsys.readouterr().out


@pytest.mark.anyio
@pytest.mark.parametrize("text,includes,excludes", [
    ("white tshirt size M price", "225.00 EGP", "stock: 0"),
    ("blue tshirt size M price", "0.00 EGP", "200.00"),
    ("blue tshirt size L price", "can't verify an active variant", "205.00"),
    ("cap price", "price unconfirmed", "0.00 EGP"),
    ("tshirt price", "Which color / size", "Which product"),
])
async def test_inventory_and_clarification(text, includes, excludes):
    backend, chat = session()
    turn = await send(chat, backend, text)
    assert includes in turn.response.reply
    assert excludes not in turn.response.reply


@pytest.mark.anyio
@pytest.mark.parametrize("text", ["delivery tomorrow?", "What is your return policy?", "I want a refund", "My order never arrived"])
async def test_unsupported_or_review_cannot_become_product_or_order(text):
    backend, chat = session("fake")
    turn = await send(chat, backend, text)
    assert not turn.execution.plan.variants
    assert not backend.calls
    assert "275.00" not in turn.response.reply


@pytest.mark.anyio
async def test_complaint_escalation():
    backend, chat = session("fake")
    turn = await send(chat, backend, "I have a complaint, my order is late")
    assert turn.response.requiresReview
    assert turn.understanding.source == "rules"


@pytest.mark.anyio
async def test_context_reset_and_new_product_supersedes():
    backend, chat = session()
    await send(chat, backend, "black tshirt size L price")
    cap = await send(chat, backend, "cap price")
    assert "275.00" not in cap.response.reply
    await chat.reset()
    turn = await send(chat, backend, "size L price")
    assert turn.understanding.inquiry.product_ids == ()


@pytest.mark.anyio
async def test_unrecognized_new_noun_does_not_inherit_product():
    backend, chat = session()
    await send(chat, backend, "black tshirt size L price")
    turn = await send(chat, backend, "What about a red mug?")
    assert not turn.understanding.inquiry.product_ids
    assert "275.00" not in turn.response.reply


@pytest.mark.anyio
@pytest.mark.parametrize("status", [401, 403, 404, 500, 503])
async def test_failure_clears_context_and_no_cached_prices(status):
    backend, chat = session()
    await send(chat, backend, "black tshirt size L price")
    backend.status_code = status
    turn = await send(chat, backend, "size L price")
    assert not chat.selection.products
    assert "275.00" not in turn.response.reply
    assert "synthetic-service" not in turn.response.reply


@pytest.mark.anyio
async def test_concurrent_customers_and_businesses_have_separate_context():
    backend, interpreter, responder = build("fake")
    chats = [ChatSession(backend.data(), backend.scope(b, c), interpreter, responder)
             for b, c in [(1, 1), (1, 2), (2, 1), (2, 2)]]
    await asyncio.gather(*(send(c, backend, text) for c, text in zip(chats,
        ["black tshirt size L price", "white tshirt size M price", "blue tshirt size M price", "cap price"])))
    turns = await asyncio.gather(*(send(c, backend, "How much is it?") for c in chats))
    assert "275.00" in turns[0].response.reply
    assert "225.00" in turns[1].response.reply
    assert "0.00 EGP" in turns[2].response.reply
    assert "price unconfirmed" in turns[3].response.reply
    assert not hasattr(interpreter, "selection") and not hasattr(responder, "last_plan")


@pytest.mark.anyio
@pytest.mark.parametrize("proposal", [
    '{"tone":"friendly","acts":[],"reply":"The price is 1 and your order is confirmed"}',
    '{"tone":"friendly","acts":[]}',
    '{"tone":"friendly","acts":[{"fact_id":"f0","phrase":2}]}',
    'The price is 1.00 EGP and stock is unlimited.',
    '{"tone":"direct","acts":[{"fact_id":"foreign","phrase":0}]}',
])
async def test_adversarial_generation_cannot_change_facts(proposal):
    backend, chat = session()
    turn = await send(chat, backend, "black tshirt size L price")
    fake = FakeGemini({"g-a": proposal, "g-b": proposal}, gemini_max_retries=0)
    generation = await ConversationalResponder(fake, fake.settings).generate(turn.execution.plan)
    assert generation.fallback_reason == "reply_unavailable_or_guard_rejected"
    assert "275.00 EGP" in generation.response.reply
    assert "unlimited" not in generation.response.reply
    assert generation.response.orderCandidate is None


@pytest.mark.anyio
@pytest.mark.parametrize("patch", [
    {"businessId": "attacker"}, {"product_handle": "p99"}, {"quantity": True},
    {"options": {"color": "x" * 101}}, {"act": "execute_http"},
])
async def test_adversarial_understanding_falls_back(patch):
    payload = dict(act="price", product_handle=None, search="tshirt", options={}, quantity=None, language="en")
    payload.update(patch)
    fake = FakeGemini({"r-a": json.dumps(payload), "r-b": json.dumps(payload)}, gemini_max_retries=0)
    result = await ConversationInterpreter(fake, fake.settings).understand("black tshirt price", Selection())
    assert result.source == "rules" and result.fallback
    assert not result.inquiry.product_ids


@pytest.mark.anyio
async def test_gemini_understands_semantics_beyond_rules_hint():
    # Model-selected interpretation performs useful work, not presentation only.
    payload = dict(act="price", product_handle=None, search="tshirt", options={"color": "White", "size": "M"},
                   quantity=None, language="en")
    fake = FakeGemini({"r-a": json.dumps(payload)})
    backend = SyntheticBackend()
    chat = ChatSession(backend.data(), backend.scope(), ConversationInterpreter(fake, fake.settings), ConversationalResponder())
    turn = await send(chat, backend, "Could you tell me what the pale medium tee goes for?")
    assert turn.understanding.source == "gemini_understanding"
    assert "225.00 EGP" in turn.response.reply
    assert "inventory untracked" in turn.response.reply


@pytest.mark.anyio
async def test_model_can_raise_review_for_a_novel_complaint():
    payload = dict(act="review", product_handle=None, search="", options={}, quantity=None, language="en")
    fake = FakeGemini({"r-a": json.dumps(payload)})
    backend = SyntheticBackend()
    chat = ChatSession(backend.data(), backend.scope(), ConversationInterpreter(fake, fake.settings), ConversationalResponder())
    turn = await send(chat, backend, "The stitching came apart as soon as I put it on")
    assert turn.response.requiresReview
    assert turn.understanding.source == "gemini_understanding"
    assert not backend.calls


@pytest.mark.anyio
async def test_provider_timeout_safe_and_retry_fallback():
    fake = FakeGemini({"r-a": [asyncio.TimeoutError(), '{"bad":true}'], "r-b": '{"bad":true}'}, gemini_max_retries=2)
    result = await ConversationInterpreter(fake, fake.settings).understand("black tshirt price", Selection())
    assert result.fallback and result.source == "rules"
    assert len(fake.calls) >= 3


@pytest.mark.anyio
async def test_cli_modes_switch_reset_and_safe_diagnostics(capsys):
    await run("fake", ["black tshirt size L price", "/customer 2", "white tshirt size M price",
                       "/business 2", "/catalog", "/reset", "/quit"])
    out = capsys.readouterr().out
    assert "275.00 EGP" in out and "225.00 EGP" in out
    assert "synthetic-service" not in out and "synthetic-not-a-secret" not in out
    assert "ordersEnabled" in out and "Conversation reset" in out


def test_no_network_initialization_in_default_and_fake_modes(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("live SDK must never initialize")
    monkeypatch.setattr("app.providers.gemini.GeminiClient._get_client", forbidden)
    assert build("rules")[1].client is None
    assert build("fake")[1].client._client is None
    with pytest.raises(ValueError):
        build("invalid")


@pytest.mark.anyio
@pytest.mark.parametrize("text", ["hello", "شكرا", "yes", "لا", "How do I use this bot?"])
async def test_simple_messages_do_not_call_gemini(text):
    class NoProvider:
        async def call(self, **kwargs):
            raise AssertionError("hard rules should not invoke a provider")
    backend = SyntheticBackend()
    interpreter = ConversationInterpreter(NoProvider())
    # AssertionError is intentionally checked through source/fallback because
    # untrusted provider exceptions must be sanitized by application code.
    turn = await ChatSession(backend.data(), backend.scope(), interpreter, ConversationalResponder()).send(
        text, context_token=backend.token(backend.scope()))
    assert turn.understanding.source == "rules"
    assert turn.understanding.fallback is None
    assert not backend.calls


@pytest.mark.anyio
async def test_decline_clears_provisional_selection():
    backend, chat = session("fake")
    await send(chat, backend, "I want two black tshirt size L")
    await send(chat, backend, "no")
    assert not chat.selection.products and chat.selection.quantity is None


@pytest.mark.anyio
async def test_prior_observations_and_authentication_are_not_provider_inputs():
    backend, chat = session()
    await send(chat, backend, "black tshirt size L price")
    payload = dict(act="price", product_handle="p0", search="", options={}, quantity=None, language="en")
    fake = FakeGemini({"r-a": json.dumps(payload)})
    chat.interpreter = ConversationInterpreter(fake, fake.settings)
    turn = await send(chat, backend, "How much is it?")
    prompt = fake.calls[0][2]
    assert "275.00" not in prompt and "stockQuantity" not in prompt
    assert str(chat.scope.business_id) not in prompt and str(chat.scope.customer_id) not in prompt
    assert backend.token(chat.scope) not in prompt
    assert "275.00 EGP" in turn.response.reply


@pytest.mark.anyio
async def test_live_evaluation_requires_explicit_operator_approval(monkeypatch):
    from app.chat.evaluate import main
    monkeypatch.setattr("sys.argv", ["evaluate", "--mode", "gemini"])
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 2


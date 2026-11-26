"""Synthetic conversation acceptance. Live usage requires two explicit flags."""
import argparse
import asyncio
import json

from .__main__ import build, ChatConfigurationError
from .application import ChatSession
from .natural import money
from decimal import Decimal


SCENARIOS = (
    ("arabic", ("عندكم تيشيرت أسود؟", "طب مقاس L بكام؟", "عايزة اتنين منه.", "طب غيرت رأيي عايزة الأبيض.",
                "أنا محتارة بين الأسود والأبيض، وعايزة مقاس L بس مش عارفة أنهي لون أحسن")),
    ("english", ("Do you have a black tshirt?", "How much is size L?", "I want two of it")),
    ("franco", ("3andkom tshirt eswed", "bekam size L", "3ayez etneen meno")),
    ("unknowns", ("white tshirt size M price", "cap price", "Can you guarantee delivery tomorrow?")),
    ("review", ("I have a complaint, my order is late",)),
    ("named_price_comparison", (
        "أنا محتارة بين الأسود والأبيض، وعايزة مقاس L، أنهي واحد عندكم أرخص؟",
        "قصدي التيشيرت القطن، الأسود والأبيض مقاس L، أنهي أرخص؟")),
)


def simulate_groq_outage(interpreter,responder):
    """Synthetic evaluator only: replace primary HTTP with local 503 responses."""
    import httpx
    from ..providers.failover import ProviderChain
    from ..providers.groq import GroqClient
    providers = interpreter.client.providers
    if [name for name,_ in providers] != ["groq","openrouter"]:
        raise ChatConfigurationError("Failover evaluation requires configured groq,openrouter with both keys.")
    transport = httpx.MockTransport(lambda _:httpx.Response(503))
    chain = ProviderChain([("groq",GroqClient(interpreter.settings,transport=transport)),providers[1]],interpreter.settings)
    interpreter.client = responder.client = chain


async def evaluate(mode, *, simulate_groq_failure=False):
    backend, interpreter, responder = build(mode)
    if simulate_groq_failure:
        if mode != "auto":
            raise ChatConfigurationError("Groq outage simulation is available only in auto evaluation.")
        simulate_groq_outage(interpreter,responder)
    failures = []
    for name, messages in SCENARIOS:
        scope = backend.scope()
        chat = ChatSession(backend.data(), scope, interpreter, responder)
        for index, message in enumerate(messages):
            turn = await chat.send(message, context_token=backend.token(scope))
            checks = {"readOnly": turn.response.orderCandidate is None,
                      "notConfirmed": turn.response.intent.value != "CONFIRMED_ORDER",
                      "replyPresent": bool(turn.response.reply.strip())}
            if name in {"arabic", "english", "franco"} and index == 1:
                checks["currentVariantPrice"] = money(Decimal("275.00"),turn.execution.plan.language,turn.execution.plan.reply_script) in turn.response.reply
            if name == "arabic" and index == 3:
                checks["changedVariantPrice"] = money(Decimal("285.00"),turn.execution.plan.language) in turn.response.reply and "275.00" not in turn.response.reply
            if name == "arabic" and index == 4:
                checks["comparisonIntent"] = turn.response.intent.value == "INQUIRY"
                checks["bothCurrentVariants"] = all(money(Decimal(price),turn.execution.plan.language) in turn.response.reply for price in ("275.00", "285.00"))
                checks["noInheritedPurchaseQuantity"] = turn.execution.plan.requested_quantity is None
            if name in {"arabic", "english", "franco"} and index == 2:
                checks["requestedQuantity"] = turn.execution.plan.requested_quantity == 2
                checks["purchaseIntent"] = turn.response.intent.value == "PURCHASE_INTENT"
            if name == "review":
                checks["ownerReview"] = turn.response.requiresReview
            if name == "named_price_comparison" and index == 1:
                from ..pipeline.price_comparison import compare_verified_pair
                comparison = compare_verified_pair(turn.execution.plan)
                checks["comparisonIntent"] = turn.response.intent.value == "INQUIRY"
                checks["bothVerifiedPrices"] = all(money(Decimal(price),turn.execution.plan.language) in turn.response.reply for price in ("275.00","285.00"))
                checks["exactDifference"] = comparison is not None and comparison.difference == Decimal("10.00")
                checks["differencePresented"] = money(Decimal("10.00"),turn.execution.plan.language) in turn.response.reply
            if mode in {"gemini","groq","openrouter","auto"} and turn.understanding.meaning.act != "other":
                checks["liveUnderstandingUsed"] = turn.understanding.source in {"gemini_understanding","groq_understanding","openrouter_understanding"}
                if turn.execution.plan.products:
                    checks["liveGenerationUsed"] = turn.execution.generation.source in {"gemini_conversation","groq_conversation","openrouter_conversation"}
                if simulate_groq_failure:
                    checks["openrouterUnderstandingAfterOutage"] = turn.understanding.source == "openrouter_understanding"
                    if turn.execution.plan.products:
                        checks["openrouterReplyAfterOutage"] = turn.execution.generation.source == "openrouter_conversation"
            failures.extend(f"{name}:{index}:{k}" for k, ok in checks.items() if not ok)
            print(json.dumps({"scenario": name, "customer": message, "reply": turn.response.reply,
                              # This evaluator uses only fixed synthetic messages/catalogs.
                              # Runtime diagnostics deliberately exclude these fields.
                              "interpretation": turn.understanding.meaning.model_dump(),
                              "preparedSearch": turn.understanding.inquiry.text,
                              "checks": checks, "diagnostics": turn.diagnostics()}, ensure_ascii=False))
    print(json.dumps({"mode": mode, "failedChecks": failures,
                      "simulatedGroqOutage":simulate_groq_failure,
                      "humanReviewRequired": ["naturalness", "clarification quality", "understanding fidelity", "localization"],
                      "liveBackendTested": False}, ensure_ascii=False))
    return not failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("rules", "fake", "gemini", "groq", "openrouter", "auto"), default="fake")
    parser.add_argument("--allow-live", action="store_true")
    parser.add_argument("--simulate-groq-failure",action="store_true",
                        help="auto evaluation only: local Groq 503, live OpenRouter still needs --allow-live")
    args = parser.parse_args()
    if args.mode in {"gemini","groq","openrouter","auto"} and not args.allow_live:
        parser.error("Real providers spend API quota. Explicitly supply --allow-live with the chosen mode.")
    if args.simulate_groq_failure and args.mode != "auto":
        parser.error("--simulate-groq-failure requires --mode auto --allow-live")
    try:
        succeeded = asyncio.run(evaluate(args.mode,simulate_groq_failure=args.simulate_groq_failure))
    except ChatConfigurationError as error:
        print(str(error))
        raise SystemExit(1) from None
    except Exception:
        print("Evaluation could not complete; check local configuration. No credentials are displayed.")
        raise SystemExit(1) from None
    raise SystemExit(0 if succeeded else 1)


if __name__ == "__main__":
    main()

"""Standalone grounded presentation using the existing injected GeminiClient."""
import asyncio
from dataclasses import dataclass, field
from typing import Protocol

from ..config import Settings
from ..pipeline.evidence_guard import (
    GroundingLimits, InvalidEvidencePlan, Presentation, compile_manifest,
    deterministic_fallback, guard_presentation, parse_presentation, render_presentation,
)
from ..pipeline.evidence_planner import EvidencePlan, Resolution
from ..prompts.evidence import EVIDENCE_SYSTEM_PROMPT, build_evidence_prompt
from ..schemas.response import AiResponse
from .base import ProviderUnavailable
from .gemini import GeminiClient
from .structured import ProviderDiagnostic


@dataclass(frozen=True)
class GroundedGeneration:
    response: AiResponse = field(repr=False)
    source: str
    model: str | None = None
    fallback_reason: str | None = None
    guard_violations: tuple[str, ...] = ()
    provider_diagnostics: tuple[ProviderDiagnostic, ...] = ()


class EvidenceResponder(Protocol):
    """Stable plan/response boundary for future multilingual conversation.

    Implementations must retain evidence validation, required clarification/review,
    read-only output and deterministic fallback. This interface enables no new
    generation mode by itself. GroundedGenerator remains the presentation baseline;
    the local conversational application supplies its guarded speech-act responder.
    """
    async def generate(self, plan: EvidencePlan) -> GroundedGeneration: ...

    def fallback(self, plan: EvidencePlan, reason: str, violations=()) -> GroundedGeneration: ...


class GroundedGenerator:
    def __init__(self, client: GeminiClient, settings: Settings, limits: GroundingLimits | None = None):
        self._client = client
        self._settings = settings
        self._limits = limits or GroundingLimits()

    def fallback(self, plan: EvidencePlan, reason: str, violations=()) -> GroundedGeneration:
        """Public deterministic guarded path for an exhausted execution budget."""
        return GroundedGeneration(deterministic_fallback(plan, self._limits), "deterministic",
                                  fallback_reason=reason, guard_violations=violations)

    async def generate(self, plan: EvidencePlan) -> GroundedGeneration:
        def fallback(reason, violations=()):
            return self.fallback(plan, reason, violations)
        try:
            manifest = compile_manifest(plan, self._limits)
        except (InvalidEvidencePlan, ValueError, TypeError, AttributeError):
            return fallback("invalid_or_bounded_plan")
        if plan.requires_review or plan.resolution in {
                Resolution.AUTHORIZATION_FAILED, Resolution.SCOPE_MISMATCH, Resolution.UNAVAILABLE,
                Resolution.INVALID, Resolution.UNSUPPORTED, Resolution.SIMPLE_RESPONSE}:
            return fallback("protected_plan")
        if not self._settings.llm_enabled or not self._settings.generator_enabled:
            return fallback("generation_disabled")
        try:
            prompt = build_evidence_prompt(plan, manifest, self._limits)
        except InvalidEvidencePlan:
            return fallback("prompt_limit")
        except (ValueError, TypeError, AttributeError, KeyError):
            return fallback("invalid_or_bounded_plan")
        try:
            proposal, model = await asyncio.wait_for(self._client.call(
                stage="evidence-presentation", models=self._settings.generator_models,
                system=EVIDENCE_SYSTEM_PROMPT, user=prompt, schema=Presentation,
                parse=lambda text: parse_presentation(text, self._limits.max_proposal_characters),
                temperature=self._settings.generator_temperature, mime="application/json"),
                timeout=min(self._limits.max_elapsed_seconds, self._settings.gemini_total_timeout_seconds))
        except asyncio.TimeoutError:
            return fallback("timeout")
        except ProviderUnavailable:
            return fallback("provider_unavailable")
        except Exception:
            # No raw provider/customer/model content enters diagnostics.
            return fallback("provider_error")
        violations = guard_presentation(proposal, manifest)
        if violations:
            return fallback("guard_rejected", violations)
        try:
            response = render_presentation(plan, proposal, manifest, self._limits)
        except (ValueError, TypeError, KeyError):
            return fallback("guard_rejected", ("invalid_presentation",))
        return GroundedGeneration(response, "gemini_presentation", model=model)

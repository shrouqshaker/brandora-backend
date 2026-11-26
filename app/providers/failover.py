"""Stage-local provider failover with bounded attempts and half-open recovery."""
import asyncio
from dataclasses import dataclass, replace
import math
import time

from .base import ProviderUnavailable
from .structured import ProviderDiagnostic, classify_failure


@dataclass(frozen=True)
class ProviderResult:
    value: object
    model: str
    provider: str
    failures: tuple

    def __iter__(self):
        yield self.value
        yield self.model


class ProviderChain:
    def __init__(self, providers, settings, *, clock=time.monotonic):
        self.providers = tuple(providers)
        self.settings, self.clock = settings, clock
        for value in (settings.chat_provider_timeout_seconds, settings.chat_total_timeout_seconds, settings.chat_circuit_seconds):
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Provider budgets must be positive and finite")
        self._circuits = {}  # provider health only
        self._probing = set()

    async def call(self, **kwargs):
        if not self.providers:
            raise ProviderUnavailable("No providers configured",diagnostics=(ProviderDiagnostic("missing_key_configuration","configuration"),))
        failures = []
        deadline = self.clock() + self.settings.chat_total_timeout_seconds
        for name, provider in self.providers:
            if self.clock() < self._circuits.get(name, 0) or name in self._probing:
                failures.append((name, ProviderDiagnostic("circuit_open", "circuit")))
                continue
            remaining = deadline - self.clock()
            if remaining <= 0:
                failures.append((name, ProviderDiagnostic("timeout", "deadline")))
                break
            half_open = name in self._circuits
            if half_open:
                self._probing.add(name)
            try:
                result, model = await asyncio.wait_for(provider.call(**kwargs),
                    timeout=remaining if len(self.providers) == 1 else min(remaining, self.settings.chat_provider_timeout_seconds))
                self._circuits.pop(name, None)
                return ProviderResult(result,model,name,tuple(replace(d,provider=p) for p,d in failures))
            except asyncio.TimeoutError:
                failures.append((name, ProviderDiagnostic("timeout", "deadline")))
            except ProviderUnavailable as error:
                failures.extend((name, d) for d in error.diagnostics or (ProviderDiagnostic("provider_unavailable", "sdk"),))
            except Exception as error:
                failures.append((name, classify_failure(error,"parse") if isinstance(error,ValueError)
                                 else ProviderDiagnostic("provider_error", "sdk")))
            finally:
                if half_open:
                    self._probing.discard(name)
            self._circuits[name] = self.clock() + self.settings.chat_circuit_seconds
        raise ProviderUnavailable("Configured providers unavailable", diagnostics=tuple(replace(d,provider=p) for p,d in failures)) from None

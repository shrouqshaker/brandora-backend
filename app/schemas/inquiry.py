"""One immutable internal selection contract for standalone retrieval/planning.

These fields are customer selectors, not authorization or Backend wire arguments.
"""
from types import MappingProxyType
from typing import Mapping

from pydantic import Field, StrictStr, field_serializer, field_validator

from .backend import BackendModel, Identifier


class VariantReference(BackendModel):
    product_id: Identifier = Field(repr=False)
    variant_id: Identifier = Field(repr=False)


class Inquiry(BackendModel):
    text: StrictStr = Field(min_length=1, max_length=2000, repr=False)
    product_ids: tuple[Identifier, ...] = Field(default=(), max_length=100, repr=False)
    variant_references: tuple[VariantReference, ...] = Field(default=(), max_length=100, repr=False)
    option_values: Mapping[StrictStr, StrictStr] = Field(default_factory=dict, max_length=100, repr=False, validate_default=True)
    option_alternatives: Mapping[StrictStr, tuple[StrictStr, ...]] = Field(default_factory=dict, max_length=2, repr=False, validate_default=True)

    @field_validator("text")
    @classmethod
    def text_not_blank(cls, value):
        if not value.strip():
            raise ValueError("Inquiry must not be blank")
        return value.strip()

    @field_validator("option_values")
    @classmethod
    def freeze_options(cls, value):
        if any(not key.strip() or not selected.strip() for key, selected in value.items()):
            raise ValueError("Option keys and values must not be blank")
        return MappingProxyType(dict(value))

    @field_serializer("option_values")
    def serialize_options(self, value):
        return dict(value)

    @field_validator("option_alternatives")
    @classmethod
    def freeze_alternatives(cls, value):
        if any(not key.strip() or len(key) > 100 or not 2 <= len(values) <= 4 or len(set(values)) != len(values)
               or any(not v.strip() or len(v) > 100 for v in values) for key, values in value.items()):
            raise ValueError("Comparison needs two to four distinct bounded values per option")
        return MappingProxyType(dict(value))

    @field_serializer("option_alternatives")
    def serialize_alternatives(self, value):
        return dict(value)

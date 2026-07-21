#!/usr/bin/env python3
"""Single-file synthetic document generator with a stable discovery contract.

GPT QUICK INSTRUCTIONS
1. Edit only the section marked GPT TEMPLATE EDIT ZONE.
2. Keep canonical keys unchanged when the same business fact already exists.
3. Use ``common.*`` for facts shared across document types and ``cmr.*`` only
   for CMR-specific facts.
4. Run ``python this_file.py self-test`` after every edit.
5. Run ``python this_file.py audit ...`` after adapting a template.
6. Production renders always emit both OTSL and table text-bbox labels.
7. For scanned templates, set TEMPLATE_CONTENT_MODE and STATIC_TEXT_MODE, then
   transcribe static lines into STATIC_TEXT_CATALOG. Do not treat the full scan as an image label.
8. Use local_median or clone erase methods when white rectangles would damage scan texture.
9. Keep debug images temporary; persistent outputs are machine-readable only.
10. A first audit creates review artifacts and returns status 60; rerun with
    --visual-review after independent full-resolution review.

The future orchestrator can import this file and call the public functions in
``PUBLIC_API``. No runner dependency is required.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import shutil
import tempfile
import traceback
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Literal, Mapping, Sequence

import fitz
from PIL import Image, ImageDraw, ImageFont

try:
    import numpy as np
except Exception:  # Quality checks still work without NumPy, but border scans are skipped.
    np = None

ContractVersion = Literal["synthetic-document-generator/2.0"]
Presence = Literal["required", "recommended", "optional"]
MissingPolicy = Literal["error", "omit", "blank", "synthesize", "derive"]
ItemStrategy = Literal["first", "join"]
TemplateContentMode = Literal["digital", "scanned", "hybrid"]
StaticTextMode = Literal["pdf", "manual", "hybrid"]
EraseMethod = Literal["none", "solid_white", "local_median", "clone"]
BorderDetectionMode = Literal["red_guides", "dark_ink", "disabled"]
SemanticType = Literal[
    "text", "identifier", "code", "address", "country", "date", "time",
    "uri", "integer", "measurement", "money", "currency", "boolean"
]

GENERATOR_CONTRACT_VERSION: ContractVersion = "synthetic-document-generator/2.0"
CANONICAL_SCHEMA_VERSION = "trade-documents/2.0"


@dataclass(frozen=True, slots=True)
class CanonicalFieldSpec:
    key: str
    semantic_type: SemanticType
    cardinality: Literal["one", "many"] = "one"
    description: str = ""


@dataclass(frozen=True, slots=True)
class FieldSpec:
    """One visible template field and its explicit business-semantic binding."""
    local_key: str
    canonical_key: str
    semantic_type: SemanticType
    box: str
    bbox: tuple[int, int, int, int]
    max_chars: int
    max_lines: int = 1
    font_size: int = 25
    min_font_size: int = 12
    bold: bool = True
    align: Literal["left", "center", "right"] = "left"
    placement: Literal["random", "fixed"] = "random"
    padding: int = 4
    presence: Presence = "optional"
    missing_policy: MissingPolicy = "omit"
    item_strategy: ItemStrategy | None = None
    source_candidates: tuple[str, ...] = ()
    derivation: str | None = None
    derived_from: tuple[str, ...] = ()
    description: str = ""


@dataclass(frozen=True, slots=True)
class TableSpec:
    """One top-level table region in BASE_SIZE pixel coordinates."""
    table_id: str
    bbox: tuple[int, int, int, int]
    rows: int
    columns: int


@dataclass(frozen=True, slots=True)
class CellSpec:
    """One logical OTSL cell. GPT edits these only when table geometry changes."""
    row: int
    column: int
    row_span: int
    column_span: int
    bbox: tuple[int, int, int, int]
    cell_id: str


@dataclass(frozen=True, slots=True)
class StaticTextSpec:
    """One manually transcribed static text line in BASE_SIZE pixel coordinates."""
    text: str
    bbox: tuple[int, int, int, int]
    angle: Literal[0, 90, 180, 270] = 0
    source: Literal["manual", "ocr_verified"] = "manual"


@dataclass(frozen=True, slots=True)
class EraseSpec:
    """How to remove an original value while preserving a scanned background."""
    bbox: tuple[int, int, int, int]
    method: EraseMethod = "solid_white"
    source_bbox: tuple[int, int, int, int] | None = None
    fill_rgb: tuple[int, int, int] = (255, 255, 255)
    sample_margin: int = 12


OUTPUT_CONTRACT_VERSION = "synthetic-document-labels/1.0"
STATUS_CODES: dict[int, str] = {
    0: "success",
    10: "input_failure",
    20: "implementation_failure",
    30: "contract_failure",
    40: "rendering_failure",
    50: "annotation_failure",
    60: "quality_failure",
    70: "output_failure",
    80: "partial_result",
    99: "unexpected_failure",
}
OTSL_TOKENS = ("<fcel>", "<ecel>", "<lcel>", "<ucel>", "<xcel>", "<nl>")
OTSL_TOKEN_RE = re.compile("(" + "|".join(map(re.escape, OTSL_TOKENS)) + ")")


def F(
    local_key: str,
    canonical_key: str,
    semantic_type: SemanticType,
    box: int | str,
    bbox: tuple[int, int, int, int],
    max_chars: int,
    *,
    max_lines: int = 1,
    font_size: int = 25,
    min_font_size: int = 12,
    bold: bool = True,
    align: Literal["left", "center", "right"] = "left",
    placement: Literal["random", "fixed"] = "random",
    padding: int = 4,
    presence: Presence = "optional",
    missing_policy: MissingPolicy = "omit",
    item_strategy: ItemStrategy | None = None,
    source_candidates: tuple[str, ...] = (),
    derivation: str | None = None,
    derived_from: tuple[str, ...] = (),
    description: str = "",
) -> FieldSpec:
    return FieldSpec(
        local_key=local_key, canonical_key=canonical_key,
        semantic_type=semantic_type, box=str(box), bbox=bbox,
        max_chars=max_chars, max_lines=max_lines, font_size=font_size,
        min_font_size=min_font_size, bold=bold, align=align,
        placement=placement, padding=padding, presence=presence,
        missing_policy=missing_policy, item_strategy=item_strategy,
        source_candidates=source_candidates, derivation=derivation,
        derived_from=derived_from, description=description,
    )


def S(
    text: str,
    bbox: tuple[int, int, int, int],
    *,
    angle: Literal[0, 90, 180, 270] = 0,
    source: Literal["manual", "ocr_verified"] = "manual",
) -> StaticTextSpec:
    return StaticTextSpec(text=text, bbox=bbox, angle=angle, source=source)


def E(
    bbox: tuple[int, int, int, int],
    *,
    method: EraseMethod = "solid_white",
    source_bbox: tuple[int, int, int, int] | None = None,
    fill_rgb: tuple[int, int, int] = (255, 255, 255),
    sample_margin: int = 12,
) -> EraseSpec:
    return EraseSpec(
        bbox=bbox, method=method, source_bbox=source_bbox,
        fill_rgb=fill_rgb, sample_margin=sample_margin,
    )


# =============================================================================
# GPT TEMPLATE EDIT ZONE
# GPT: change metadata, coordinates, FIELD_CATALOG, ERASE_SPECS, static text, and sample data.
# GPT: never invent a synonym for an existing canonical key.
# GPT: use document-specific keys only when no ``common.*`` concept fits.
# =============================================================================
GENERATOR_ID = "cmr.full_coverage.layout_001"
DOCUMENT_TYPE = "cmr"
TEMPLATE_VERSION = "2.0.0"
SOURCE_PAGE_INDEX = 0
BASE_DPI = 200
BASE_SIZE = (1654, 2339)  # Width, height of the normalized reference render in pixels.
TEMPLATE_CONTENT_MODE: TemplateContentMode = "scanned"
STATIC_TEXT_MODE: StaticTextMode = "manual"
BORDER_DETECTION_MODE: BorderDetectionMode = "dark_ink"
DARK_INK_THRESHOLD = 105
BORDER_PROXIMITY_PX_AT_BASE_DPI = 1
FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"

# GPT: each F(...) is one rendered value. The canonical key must be explicit.
# GPT: presence controls matching weight; missing_policy controls absent data.
# GPT: wildcard keys ending in [] require item_strategy="first" or "join".
FIELD_CATALOG: tuple[FieldSpec, ...] = (
    F('document.number', 'common.document.number', 'identifier', 'header', (1280, 194, 1515, 242), 36, font_size=30, min_font_size=15, align='center', presence='required', missing_policy='synthesize', description='Document identifier beside the CMR logo'),
    F('sender.name', 'common.roles.shipper.name', 'text', '1', (90, 225, 815, 258), 80, font_size=27, min_font_size=15, presence='required', missing_policy='synthesize'),
    F('sender.tax_id', 'common.roles.shipper.tax_id', 'identifier', '1', (90, 262, 815, 294), 55, min_font_size=14, presence='recommended', missing_policy='synthesize'),
    F('sender.address', 'common.roles.shipper.address.full', 'address', '1', (90, 298, 815, 335), 110, max_lines=2, font_size=24, min_font_size=13, presence='required', missing_policy='synthesize'),
    F('sender.country', 'common.roles.shipper.country', 'country', '1', (90, 340, 815, 378), 55, font_size=24, min_font_size=14, presence='required', missing_policy='synthesize'),
    F('consignee.name', 'common.roles.consignee.name', 'text', '2', (90, 439, 815, 469), 85, min_font_size=14, presence='required', missing_policy='synthesize'),
    F('consignee.address', 'common.roles.consignee.address.full', 'address', '2', (90, 473, 815, 506), 110, max_lines=2, font_size=23, presence='required', missing_policy='synthesize'),
    F('consignee.country', 'common.roles.consignee.country', 'country', '2', (90, 510, 500, 538), 55, font_size=22, min_font_size=13, presence='required', missing_policy='synthesize'),
    F('consignee.tax_id', 'common.roles.consignee.tax_id', 'identifier', '2', (510, 510, 815, 538), 45, font_size=21, presence='recommended', missing_policy='synthesize'),
    F('delivery.place', 'common.shipment.delivery.place', 'text', '3', (205, 610, 815, 650), 85, font_size=24, min_font_size=13, presence='required', missing_policy='synthesize'),
    F('delivery.country', 'common.shipment.delivery.country', 'country', '3', (205, 657, 815, 696), 55, font_size=24, min_font_size=13, presence='required', missing_policy='synthesize'),
    F('taking_over.place', 'common.shipment.pickup.place', 'text', '4', (205, 751, 815, 780), 80, font_size=23, min_font_size=13, presence='required', missing_policy='synthesize'),
    F('taking_over.country', 'common.shipment.pickup.country', 'country', '4', (205, 786, 815, 815), 55, font_size=23, min_font_size=13, presence='required', missing_policy='synthesize'),
    F('taking_over.date', 'common.shipment.pickup.date', 'date', '4', (205, 821, 815, 849), 32, font_size=23, min_font_size=13, presence='required', missing_policy='synthesize'),
    F('invoice.number', 'common.commercial.invoice.number', 'identifier', '5', (100, 895, 350, 923), 40, font_size=22, presence='recommended', missing_policy='synthesize'),
    F('invoice.date', 'common.commercial.invoice.date', 'date', '5', (100, 927, 350, 954), 32, font_size=22, presence='recommended', missing_policy='derive', derivation='copy_first', derived_from=('common.document.issue.date', 'common.shipment.pickup.date')),
    F('attached_documents.references', 'common.document.attachments.references', 'text', '5', (370, 895, 815, 954), 150, max_lines=2, font_size=20, min_font_size=11, presence='recommended', missing_policy='synthesize'),
    F('packages.marks_and_numbers', 'common.shipment.packages.marks_and_numbers', 'text', '6', (90, 1008, 320, 1038), 45, font_size=21, min_font_size=11, presence='recommended', missing_policy='synthesize'),
    F('packages.count', 'common.shipment.packages.count', 'integer', '7', (330, 1008, 500, 1038), 18, font_size=21, min_font_size=11, align='center', presence='required', missing_policy='synthesize'),
    F('packages.type', 'common.shipment.packages.type', 'text', '8', (510, 1008, 730, 1038), 35, font_size=21, min_font_size=11, align='center', presence='required', missing_policy='synthesize'),
    F('goods.description', 'common.goods.items[].description', 'text', '9', (90, 1044, 1015, 1085), 150, max_lines=2, font_size=23, presence='required', missing_policy='synthesize', item_strategy='first'),
    F('goods.item_number', 'common.goods.items[].item_number', 'identifier', '9', (90, 1092, 300, 1121), 36, font_size=20, min_font_size=11, presence='optional', missing_policy='omit', item_strategy='first'),
    F('goods.country_of_origin', 'common.goods.items[].country_of_origin', 'country', '9', (310, 1092, 560, 1121), 50, font_size=20, min_font_size=11, presence='optional', missing_policy='omit', item_strategy='first'),
    F('goods.placement_note', 'common.goods.items[].placement_note', 'text', '9', (570, 1092, 1015, 1121), 80, font_size=20, min_font_size=11, presence='optional', missing_policy='omit', item_strategy='first'),
    F('goods.hs_code', 'common.goods.items[].hs_code', 'code', '10', (1038, 1008, 1194, 1046), 24, font_size=21, min_font_size=11, align='center', presence='recommended', missing_policy='synthesize', item_strategy='first'),
    F('weight.gross.total', 'common.shipment.weight.gross.total', 'measurement', '11', (1214, 1008, 1397, 1046), 30, font_size=21, min_font_size=11, align='center', presence='required', missing_policy='synthesize'),
    F('weight.net.total', 'common.shipment.weight.net.total', 'measurement', '11', (1214, 1052, 1397, 1090), 30, font_size=21, min_font_size=11, align='center', presence='recommended', missing_policy='synthesize'),
    F('quantity.value_and_unit', 'common.shipment.quantity.value_and_unit', 'measurement', '12', (1417, 1008, 1588, 1046), 30, font_size=21, min_font_size=11, align='center', presence='recommended', missing_policy='synthesize'),
    F('goods.class', 'common.goods.items[].class', 'code', '9', (90, 1238, 220, 1265), 18, font_size=18, min_font_size=10, presence='optional', missing_policy='omit', item_strategy='first'),
    F('goods.dangerous_goods.number', 'common.goods.items[].dangerous_goods.number', 'code', '9', (325, 1238, 480, 1265), 18, font_size=18, min_font_size=10, presence='optional', missing_policy='omit', item_strategy='first'),
    F('goods.dangerous_goods.letter', 'common.goods.items[].dangerous_goods.letter', 'code', '9', (535, 1238, 775, 1265), 20, font_size=18, min_font_size=10, presence='optional', missing_policy='omit', item_strategy='first'),
    F('goods.dangerous_goods.adr', 'common.goods.items[].dangerous_goods.adr', 'code', '9', (805, 1238, 1015, 1265), 20, font_size=18, min_font_size=10, presence='optional', missing_policy='omit', item_strategy='first'),
    F('sender.instructions', 'cmr.sender.instructions', 'text', '13', (95, 1320, 785, 1460), 360, max_lines=6, font_size=21, min_font_size=11, bold=False, presence='optional', missing_policy='omit'),
    F('sender.instructions.amount', 'cmr.sender.instructions.amount', 'money', '13', (95, 1470, 370, 1510), 35, font_size=20, min_font_size=11, presence='optional', missing_policy='omit'),
    F('sender.instructions.date', 'cmr.sender.instructions.date', 'date', '13', (400, 1470, 785, 1510), 32, font_size=20, min_font_size=11, presence='optional', missing_policy='omit'),
    F('refund.terms', 'cmr.refund.terms', 'text', '14', (165, 1577, 1586, 1600), 160, font_size=18, min_font_size=10, bold=False, presence='optional', missing_policy='omit'),
    F('incoterm', 'common.trade.incoterm', 'code', '15', (95, 1654, 300, 1683), 28, font_size=20, min_font_size=11, presence='recommended', missing_policy='synthesize'),
    F('freight.payment_instruction', 'cmr.freight.payment_instruction', 'text', '15', (315, 1654, 815, 1710), 120, max_lines=2, font_size=20, min_font_size=11, bold=False, presence='optional', missing_policy='omit'),
    F('carrier.name', 'common.roles.carrier.primary.name', 'text', '16', (842, 439, 1586, 469), 90, min_font_size=14, presence='required', missing_policy='synthesize'),
    F('carrier.address', 'common.roles.carrier.primary.address.full', 'address', '16', (842, 473, 1586, 504), 115, max_lines=2, font_size=22, presence='required', missing_policy='synthesize'),
    F('carrier.country', 'common.roles.carrier.primary.country', 'country', '16', (842, 508, 1095, 536), 55, font_size=20, min_font_size=11, presence='required', missing_policy='synthesize'),
    F('carrier.tax_id', 'common.roles.carrier.primary.tax_id', 'identifier', '16', (1105, 508, 1325, 536), 42, font_size=19, min_font_size=10, presence='optional', missing_policy='omit'),
    F('carrier.trade_registry_number', 'common.roles.carrier.primary.trade_registry_number', 'identifier', '16', (1335, 508, 1586, 536), 48, font_size=19, min_font_size=10, presence='optional', missing_policy='omit'),
    F('carrier.website', 'common.roles.carrier.primary.website', 'uri', '16', (842, 540, 1586, 560), 70, font_size=17, min_font_size=9, bold=False, presence='optional', missing_policy='omit'),
    F('successive_carrier.name', 'common.roles.carrier.successive.name', 'text', '17', (842, 610, 1586, 640), 90, font_size=24, min_font_size=13, presence='optional', missing_policy='omit'),
    F('successive_carrier.address', 'common.roles.carrier.successive.address.full', 'address', '17', (842, 645, 1586, 681), 115, max_lines=2, font_size=22, presence='optional', missing_policy='omit'),
    F('successive_carrier.country', 'common.roles.carrier.successive.country', 'country', '17', (842, 686, 1095, 714), 55, font_size=20, min_font_size=11, presence='optional', missing_policy='omit'),
    F('successive_carrier.tax_id', 'common.roles.carrier.successive.tax_id', 'identifier', '17', (1105, 686, 1330, 714), 42, font_size=19, min_font_size=10, presence='optional', missing_policy='omit'),
    F('successive_carrier.registration_number', 'common.roles.carrier.successive.trade_registry_number', 'identifier', '17', (1340, 686, 1586, 714), 48, font_size=19, min_font_size=10, presence='optional', missing_policy='omit'),
    F('successive_carrier.website', 'common.roles.carrier.successive.website', 'uri', '17', (842, 720, 1586, 748), 70, font_size=18, min_font_size=10, bold=False, presence='optional', missing_policy='omit'),
    F('carrier.reservations', 'cmr.carrier.reservations', 'text', '18', (842, 828, 1586, 950), 320, max_lines=5, font_size=21, min_font_size=11, bold=False, presence='optional', missing_policy='omit'),
    F('charges.freight.sender', 'cmr.charges.freight.sender', 'money', '19', (1038, 1320, 1194, 1352), 24, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.freight.currency', 'cmr.charges.freight.currency', 'currency', '19', (1214, 1320, 1302, 1352), 8, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.freight.consignee', 'cmr.charges.freight.consignee', 'money', '19', (1417, 1320, 1586, 1352), 24, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.discounts.sender', 'cmr.charges.discounts.sender', 'money', '19', (1038, 1357, 1194, 1389), 24, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.discounts.currency', 'cmr.charges.discounts.currency', 'currency', '19', (1214, 1357, 1302, 1389), 8, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.discounts.consignee', 'cmr.charges.discounts.consignee', 'money', '19', (1417, 1357, 1586, 1389), 24, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.subtotal.sender', 'cmr.charges.subtotal.sender', 'money', '19', (1038, 1394, 1194, 1426), 24, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.subtotal.currency', 'cmr.charges.subtotal.currency', 'currency', '19', (1214, 1394, 1302, 1426), 8, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.subtotal.consignee', 'cmr.charges.subtotal.consignee', 'money', '19', (1417, 1394, 1586, 1426), 24, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.surcharges.sender', 'cmr.charges.surcharges.sender', 'money', '19', (1038, 1431, 1194, 1463), 24, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.surcharges.currency', 'cmr.charges.surcharges.currency', 'currency', '19', (1214, 1431, 1302, 1463), 8, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.surcharges.consignee', 'cmr.charges.surcharges.consignee', 'money', '19', (1417, 1431, 1586, 1463), 24, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.additional.sender', 'cmr.charges.additional.sender', 'money', '19', (1038, 1468, 1194, 1500), 24, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.additional.currency', 'cmr.charges.additional.currency', 'currency', '19', (1214, 1468, 1302, 1500), 8, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.additional.consignee', 'cmr.charges.additional.consignee', 'money', '19', (1417, 1468, 1586, 1500), 24, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.other.sender', 'cmr.charges.other.sender', 'money', '19', (1038, 1505, 1194, 1537), 24, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.other.currency', 'cmr.charges.other.currency', 'currency', '19', (1214, 1505, 1302, 1537), 8, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.other.consignee', 'cmr.charges.other.consignee', 'money', '19', (1417, 1505, 1586, 1537), 24, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('charges.total.sender', 'cmr.charges.total.sender', 'money', '19', (1038, 1542, 1194, 1565), 24, font_size=17, min_font_size=9, align='center', presence='optional', missing_policy='omit'),
    F('charges.total.currency', 'cmr.charges.total.currency', 'currency', '19', (1214, 1542, 1302, 1565), 8, font_size=17, min_font_size=9, align='center', presence='optional', missing_policy='omit'),
    F('charges.total.consignee', 'cmr.charges.total.consignee', 'money', '19', (1417, 1542, 1586, 1565), 24, font_size=17, min_font_size=9, align='center', presence='optional', missing_policy='omit'),
    F('special_agreement', 'cmr.special_agreement', 'text', '20', (842, 1654, 1586, 1710), 180, max_lines=2, font_size=20, min_font_size=11, bold=False, presence='optional', missing_policy='omit'),
    F('document.issue_place', 'common.document.issue.place', 'text', '21', (300, 1734, 620, 1759), 55, font_size=20, min_font_size=11, align='center', presence='recommended', missing_policy='derive', derivation='copy_first', derived_from=('common.shipment.pickup.place',)),
    F('document.issue_country', 'common.document.issue.country', 'country', '21', (300, 1760, 620, 1783), 55, font_size=20, min_font_size=11, align='center', presence='recommended', missing_policy='derive', derivation='copy_first', derived_from=('common.shipment.pickup.country',)),
    F('document.issue_date', 'common.document.issue.date', 'date', '21', (690, 1738, 1138, 1778), 32, font_size=22, align='center', presence='recommended', missing_policy='derive', derivation='copy_first', derived_from=('common.shipment.pickup.date',)),
    F('sender.signature_block_name', 'common.roles.shipper.signature_block.name', 'text', '22', (100, 1840, 595, 1900), 90, max_lines=2, font_size=23, align='center', presence='optional', missing_policy='derive', derivation='copy_first', derived_from=('common.roles.shipper.name',)),
    F('sender.signature_block_details', 'common.roles.shipper.signature_block.details', 'text', '22', (100, 1908, 595, 1995), 150, max_lines=3, font_size=19, min_font_size=10, bold=False, align='center', presence='optional', missing_policy='omit'),
    F('driver.name', 'common.roles.driver.name', 'text', '23', (640, 1840, 1135, 1890), 90, max_lines=2, font_size=23, align='center', presence='recommended', missing_policy='synthesize'),
    F('driver.identification', 'common.roles.driver.identification', 'identifier', '23', (640, 1895, 1135, 1932), 55, font_size=21, min_font_size=11, align='center', presence='recommended', missing_policy='synthesize'),
    F('carrier.signature_block_details', 'common.roles.carrier.primary.signature_block.details', 'text', '23', (640, 1940, 1135, 1998), 120, max_lines=2, font_size=18, min_font_size=10, bold=False, align='center', presence='optional', missing_policy='omit'),
    F('consignee.receipt.date', 'cmr.receipt.date', 'date', '24', (1395, 1736, 1586, 1772), 32, font_size=20, min_font_size=11, align='center', presence='optional', missing_policy='omit'),
    F('consignee.receipt.time', 'cmr.receipt.time', 'time', '24', (1300, 1790, 1586, 1822), 24, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('consignee.receipt.arrival_hour', 'cmr.receipt.arrival.hour', 'integer', '24', (1340, 1843, 1450, 1872), 8, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('consignee.receipt.arrival_minute', 'cmr.receipt.arrival.minute', 'integer', '24', (1460, 1843, 1586, 1872), 8, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('consignee.receipt.departure_hour', 'cmr.receipt.departure.hour', 'integer', '24', (1340, 1892, 1450, 1921), 8, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('consignee.receipt.departure_minute', 'cmr.receipt.departure.minute', 'integer', '24', (1460, 1892, 1586, 1921), 8, font_size=18, min_font_size=10, align='center', presence='optional', missing_policy='omit'),
    F('consignee.signature_block_name', 'common.roles.consignee.signature_block.name', 'text', '24', (1170, 1938, 1586, 1983), 90, max_lines=2, font_size=20, min_font_size=11, align='center', presence='optional', missing_policy='derive', derivation='copy_first', derived_from=('common.roles.consignee.name',)),
    F('vehicle.truck.registration_number', 'common.transport.vehicle.truck.registration_number', 'identifier', '25', (90, 2067, 340, 2098), 30, font_size=21, min_font_size=11, align='center', presence='recommended', missing_policy='synthesize'),
    F('vehicle.trailer.registration_number', 'common.transport.vehicle.trailer.registration_number', 'identifier', '25', (350, 2067, 605, 2098), 30, font_size=21, min_font_size=11, align='center', presence='recommended', missing_policy='synthesize'),
    F('vehicle.truck.make_type', 'common.transport.vehicle.truck.make_type', 'text', '26', (625, 2067, 880, 2098), 38, font_size=20, min_font_size=10, align='center', presence='recommended', missing_policy='synthesize'),
    F('vehicle.trailer.make_type', 'common.transport.vehicle.trailer.make_type', 'text', '26', (890, 2067, 1145, 2098), 38, font_size=20, min_font_size=10, align='center', presence='recommended', missing_policy='synthesize'),
)

# GPT: erase only original variable values. Never erase static labels or borders.
# GPT: for scans, prefer local_median or clone; clone needs a same-size clean source_bbox.
ERASE_SPECS: tuple[EraseSpec, ...] = tuple(
    E(region, method="solid_white")
    for region in ((1268, 188, 1525, 247), (86, 222, 820, 389), (86, 436, 820, 562), (195, 607, 820, 704), (195, 748, 820, 850), (86, 892, 820, 956), (86, 1004, 1018, 1125), (1033, 1004, 1199, 1050), (1209, 1004, 1399, 1125), (86, 1236, 240, 1267), (290, 1728, 1140, 1784), (630, 1830, 1140, 1940), (86, 2064, 1148, 2102))
)
# Backward-compatible view used by existing geometry and extraction code.
ERASE_REGIONS: tuple[tuple[int, int, int, int], ...] = tuple(spec.bbox for spec in ERASE_SPECS)

def make_weird_data() -> dict[str, str]:
    data: dict[str, str] = {
        "document.number": "CMR-GLORP-24-ZX9",
        "sender.name": "COSMIC NOODLE EXPORTERS LLC",
        "sender.tax_id": "TIN-ZORK-2906061681",
        "sender.address": "404 Wormhole Avenue, Warehouse NULL, Sector BEEP",
        "sender.country": "Bananastan",
        "consignee.name": "MECHA GOBLIN METALS LTD",
        "consignee.address": "Dock 9 3/4, Purple Volcano Industrial Ring",
        "consignee.country": "Parallel Georgia",
        "consignee.tax_id": "TAX-OMEGA-7788",
        "delivery.place": "Snargleport Singing Warehouse",
        "delivery.country": "Freedonia++",
        "taking_over.place": "Crate Volcano Prime",
        "taking_over.country": "Moonland",
        "taking_over.date": "31.13.2099",
        "invoice.number": "INV-WEIRD-404",
        "invoice.date": "00.00.0000",
        "attached_documents.references": "MOON PERMIT MP-77; GOBLIN CERTIFICATE GC-9",
        "packages.marks_and_numbers": "GLORP-ZX-77",
        "packages.count": "777",
        "packages.type": "COSMIC BUNDLES",
        "goods.description": "Anti-gravity spaghetti reinforcement rods with haunted coating",
        "goods.item_number": "ITEM-NOODLE-42",
        "goods.country_of_origin": "Outer Ring",
        "goods.placement_note": "KEEP AWAY FROM SINGING FORKLIFTS",
        "goods.hs_code": "7214ZORK00",
        "weight.gross.total": "99999 kg",
        "weight.net.total": "98765 kg",
        "quantity.value_and_unit": "42.5 m3",
        "goods.class": "Z9",
        "goods.dangerous_goods.number": "404",
        "goods.dangerous_goods.letter": "Q",
        "goods.dangerous_goods.adr": "ADR-BEEP",
        "sender.instructions": "Customs must ask the purple octopus for permission. Do not rotate the moon crates counter-clockwise. Release only after three ceremonial beeps.",
        "sender.instructions.amount": "FEE 1234 ZORK",
        "sender.instructions.date": "NEXT TUESDAY",
        "refund.terms": "Refund payable in polished buttons after successful teleportation.",
        "incoterm": "FCA-MOON",
        "freight.payment_instruction": "Sender pays 73 percent; consignee pays the remaining noodles.",
        "carrier.name": "INTERDIMENSIONAL TRUCKATRON CARRIERS",
        "carrier.address": "88 Infinite Highway, Garage 404, Blip City",
        "carrier.country": "Cloud Republic",
        "carrier.tax_id": "TAX-BEEP-16",
        "carrier.trade_registry_number": "REG-TRUCK-9001",
        "carrier.website": "www.truckatron.example",
        "successive_carrier.name": "SECONDARY WORMHOLE HAULAGE CO",
        "successive_carrier.address": "Tunnel 12, Under the Suspicious Mountain",
        "successive_carrier.country": "Bizarrostan",
        "successive_carrier.tax_id": "TAX-GOBLIN-17",
        "successive_carrier.registration_number": "REG-SNEEZE-17",
        "successive_carrier.website": "www.wormhole-haul.example",
        "carrier.reservations": "Carrier accepts no responsibility for singing crates, temporal duplication, spontaneous banana formation, or dragons hiding in the trailer.",
        "special_agreement": "Deliver before the third moonrise. Honk exactly twice at the portal.",
        "document.issue_place": "BLIPTOWN",
        "document.issue_country": "MOONLAND",
        "document.issue_date": "88.88.2088",
        "sender.signature_block_name": "DR. GLORP VON EXPORT",
        "sender.signature_block_details": "Chief Noodle Officer\nID SENDER-404",
        "driver.name": "CAPTAIN BEEP NOODLE",
        "driver.identification": "ID-DRIVER-ZX-42",
        "carrier.signature_block_details": "Licensed Wormhole Driver\nShift 25:61",
        "consignee.receipt.date": "99.99.2999",
        "consignee.receipt.time": "25:61:61",
        "consignee.receipt.arrival_hour": "25",
        "consignee.receipt.arrival_minute": "61",
        "consignee.receipt.departure_hour": "26",
        "consignee.receipt.departure_minute": "99",
        "consignee.signature_block_name": "PROF. SNARGLE RECEIVER",
        "vehicle.truck.registration_number": "XX-404-WUT",
        "vehicle.trailer.registration_number": "YY-505-HUH",
        "vehicle.truck.make_type": "TRUCKATRON GX",
        "vehicle.trailer.make_type": "SNEEZE TRAILER",
    }
    charge_rows = ["freight", "discounts", "subtotal", "surcharges", "additional", "other", "total"]
    for index, row in enumerate(charge_rows, start=1):
        data[f"charges.{row}.sender"] = f"{index}11.11"
        data[f"charges.{row}.currency"] = "ZRK"
        data[f"charges.{row}.consignee"] = f"{index}22.22"
    expected = {field.local_key for field in FIELD_CATALOG}
    missing = expected - set(data)
    extra = set(data) - expected
    if missing or extra:
        raise RuntimeError(f"Weird data mismatch. Missing={sorted(missing)} extra={sorted(extra)}")
    return data



# GPT: define every visually independent table once. A continuous form grid is one table.
TABLE_CATALOG: tuple[TableSpec, ...] = (
    TableSpec("cmr_form", (79, 177, 1599, 2106), 24, 11),
)

# GPT: scanned pages usually have no PDF text layer. In manual or hybrid mode,
# transcribe every static text line needed by OTSL/table text-bbox labels here.
# Use one S(...) entry per visually contiguous line, in BASE_SIZE coordinates.
STATIC_TEXT_CATALOG: tuple[StaticTextSpec, ...] = ()

# GPT: set this to True only after every readable static table-text line has
# been visually transcribed and independently reviewed. Machine checks cannot
# infer missing scan text without OCR, so audit status 0 is forbidden while False.
STATIC_TEXT_CATALOG_COMPLETE = False

# GPT: top-level text is text outside all table boxes. Only bbox and angle are
# needed because layout.json intentionally carries no text content.
TOP_LEVEL_TEXT_REGIONS: tuple[tuple[tuple[int, int, int, int], int], ...] = ()

# GPT: include only real semantic images outside tables. Never include the page
# background, the scanned form layer, rasterized text, or decorative lines.
SEMANTIC_IMAGE_REGIONS: tuple[tuple[tuple[int, int, int, int], int], ...] = ()

# GPT: optional per-field runtime refinements. Supported keys are:
# reference_bbox, container_bbox, collision_group, anchor, jitter_x, jitter_y,
# line_spacing, allow_character_wrap, and legibility_min_px_at_base_dpi.
FIELD_RUNTIME_OVERRIDES: dict[str, dict[str, Any]] = {}

# GPT: list canonical keys that intentionally bind to more than one local field.
# Example: {"common.document.number": ("header.number", "footer.number")}
DECLARED_CANONICAL_ALIASES: dict[str, tuple[str, ...]] = {}

# GPT: map raster image XObjects that are actually text in digital/hybrid PDFs.
# A full-page scan is not mapped here; use STATIC_TEXT_CATALOG for it.
# Multiline strings are split uniformly across the XObject bbox for text-bbox labels.
RASTER_TEXT_XREFS: dict[int, str] = {}

# GPT: small anti-alias contacts with red guide pixels are tolerated. Keep this low.
BORDER_OVERLAP_TOLERANCE_PX_AT_BASE_DPI = 400

# GPT: edit this logical grid when adapting another CMR layout.
def make_table_cells() -> dict[str, tuple[CellSpec, ...]]:
    cells: list[CellSpec] = []
    def C(r: int, c: int, rs: int, cs: int, bbox: tuple[int, int, int, int], ident: str) -> None:
        cells.append(CellSpec(r, c, rs, cs, bbox, ident))

    C(0, 0, 1, 5, (79, 177, 827, 393), "box_1")
    C(0, 5, 1, 6, (827, 177, 1599, 393), "title_cell")
    C(1, 0, 1, 5, (79, 393, 827, 567), "box_2")
    C(1, 5, 1, 6, (827, 393, 1599, 567), "box_16")
    C(2, 0, 1, 5, (79, 567, 827, 708), "box_3")
    C(2, 5, 2, 6, (827, 567, 1599, 819), "box_17")
    C(3, 0, 2, 5, (79, 708, 827, 889), "box_4")
    C(4, 5, 2, 6, (827, 819, 1599, 959), "box_18")
    C(5, 0, 1, 5, (79, 889, 827, 959), "box_5")

    C(6, 0, 1, 1, (79, 959, 316, 999), "box_6_header")
    C(6, 1, 1, 1, (316, 959, 553, 999), "box_7_header")
    C(6, 2, 1, 2, (553, 959, 790, 999), "box_8_header")
    C(6, 4, 1, 2, (790, 959, 1027, 999), "box_9_header")
    C(6, 6, 1, 2, (1027, 959, 1203, 999), "box_10_header")
    C(6, 8, 1, 2, (1203, 959, 1406, 999), "box_11_header")
    C(6, 10, 1, 1, (1406, 959, 1599, 999), "box_12_header")
    C(7, 0, 1, 6, (79, 999, 1027, 1233), "boxes_6_9_values")
    C(7, 6, 1, 2, (1027, 999, 1203, 1233), "box_10_values")
    C(7, 8, 1, 2, (1203, 999, 1406, 1233), "box_11_values")
    C(7, 10, 1, 1, (1406, 999, 1599, 1233), "box_12_values")
    C(8, 0, 1, 1, (79, 1233, 316, 1270), "class")
    C(8, 1, 1, 1, (316, 1233, 553, 1270), "danger_number")
    C(8, 2, 1, 2, (553, 1233, 790, 1270), "danger_letter")
    C(8, 4, 1, 2, (790, 1233, 1027, 1270), "adr")
    C(8, 6, 1, 2, (1027, 1233, 1203, 1270), "empty_10")
    C(8, 8, 1, 2, (1203, 1233, 1406, 1270), "empty_11")
    C(8, 10, 1, 1, (1406, 1233, 1599, 1270), "empty_12")

    C(9, 0, 1, 4, (79, 1270, 790, 1309), "box_13_header")
    C(9, 4, 1, 2, (790, 1270, 1027, 1309), "box_19_title")
    C(9, 6, 1, 2, (1027, 1270, 1203, 1309), "charges_sender_header")
    C(9, 8, 1, 2, (1203, 1270, 1406, 1309), "charges_currency_header")
    C(9, 10, 1, 1, (1406, 1270, 1599, 1309), "charges_consignee_header")
    C(10, 0, 7, 4, (79, 1309, 790, 1567), "box_13_values")
    charge_y = [1309, 1346, 1383, 1420, 1457, 1494, 1531, 1567]
    for i in range(7):
        y0, y1 = charge_y[i], charge_y[i + 1]
        row = 10 + i
        C(row, 4, 1, 2, (790, y0, 1027, y1), f"charge_label_{i}")
        C(row, 6, 1, 2, (1027, y0, 1203, y1), f"charge_sender_{i}")
        C(row, 8, 1, 1, (1203, y0, 1310, y1), f"charge_currency_{i}")
        C(row, 9, 1, 1, (1310, y0, 1406, y1), f"charge_blank_{i}")
        C(row, 10, 1, 1, (1406, y0, 1599, y1), f"charge_consignee_{i}")

    C(17, 0, 1, 11, (79, 1567, 1599, 1606), "box_14")
    C(18, 0, 1, 5, (79, 1606, 827, 1647), "box_15_header")
    C(18, 5, 1, 6, (827, 1606, 1599, 1647), "box_20_header")
    C(19, 0, 1, 5, (79, 1647, 827, 1720), "box_15_values")
    C(19, 5, 1, 6, (827, 1647, 1599, 1720), "box_20_values")
    C(20, 0, 1, 7, (79, 1720, 1152, 1787), "box_21")
    C(20, 7, 4, 4, (1152, 1720, 1599, 2106), "box_24")
    C(21, 0, 1, 3, (79, 1787, 614, 2023), "box_22")
    C(21, 3, 1, 4, (614, 1787, 1152, 2023), "box_23")
    C(22, 0, 1, 3, (79, 2023, 614, 2062), "box_25_header")
    C(22, 3, 1, 4, (614, 2023, 1152, 2062), "box_26_header")
    C(23, 0, 1, 3, (79, 2062, 614, 2106), "box_25_values")
    C(23, 3, 1, 4, (614, 2062, 1152, 2106), "box_26_values")
    return {"cmr_form": tuple(cells)}

# =============================================================================
# END GPT TEMPLATE EDIT ZONE
# Runtime below is intentionally template-agnostic.
# =============================================================================

PARTY_ROLES = (
    "shipper", "consignee", "exporter", "importer", "seller", "buyer",
    "manufacturer", "producer", "declaration_unit", "production_sales_unit",
    "carrier.primary", "carrier.successive", "driver",
)


def _build_canonical_schema() -> dict[str, CanonicalFieldSpec]:
    """Stable shared vocabulary copied into every generator script."""
    schema: dict[str, CanonicalFieldSpec] = {}

    def add(key: str, semantic_type: SemanticType, cardinality: str = "one", description: str = "") -> None:
        if key in schema:
            raise RuntimeError(f"Duplicate canonical schema key: {key}")
        schema[key] = CanonicalFieldSpec(key, semantic_type, cardinality, description)  # type: ignore[arg-type]

    role_attrs: tuple[tuple[str, SemanticType], ...] = (
        ("name", "text"), ("address.full", "address"), ("country", "country"),
        ("tax_id", "identifier"), ("trade_registry_number", "identifier"),
        ("website", "uri"), ("identification", "identifier"),
        ("signature_block.name", "text"), ("signature_block.details", "text"),
    )
    for role in PARTY_ROLES:
        for suffix, semantic_type in role_attrs:
            add(f"common.roles.{role}.{suffix}", semantic_type)

    exact: tuple[tuple[str, SemanticType, str], ...] = (
        ("common.document.number", "identifier", "one"),
        ("common.document.issue.date", "date", "one"),
        ("common.document.issue.place", "text", "one"),
        ("common.document.issue.country", "country", "one"),
        ("common.document.attachments.references", "text", "one"),
        ("common.shipment.pickup.place", "text", "one"),
        ("common.shipment.pickup.country", "country", "one"),
        ("common.shipment.pickup.date", "date", "one"),
        ("common.shipment.delivery.place", "text", "one"),
        ("common.shipment.delivery.country", "country", "one"),
        ("common.shipment.destination.country", "country", "one"),
        ("common.shipment.destination.final_country", "country", "one"),
        ("common.shipment.destination.port", "text", "one"),
        ("common.shipment.exit.port", "text", "one"),
        ("common.shipment.exit.customs_office", "text", "one"),
        ("common.shipment.domestic_source_location", "text", "one"),
        ("common.shipment.trade.country", "country", "one"),
        ("common.shipment.transport.mode", "code", "one"),
        ("common.shipment.packages.count", "integer", "one"),
        ("common.shipment.packages.type", "text", "one"),
        ("common.shipment.packages.marks_and_numbers", "text", "one"),
        ("common.shipment.weight.gross.total", "measurement", "one"),
        ("common.shipment.weight.net.total", "measurement", "one"),
        ("common.shipment.quantity.value_and_unit", "measurement", "one"),
        ("common.commercial.invoice.number", "identifier", "one"),
        ("common.commercial.invoice.date", "date", "one"),
        ("common.commercial.contract.number", "identifier", "one"),
        ("common.commercial.waybill.number", "identifier", "one"),
        ("common.trade.incoterm", "code", "one"),
        ("common.transport.vehicle.truck.registration_number", "identifier", "one"),
        ("common.transport.vehicle.truck.make_type", "text", "one"),
        ("common.transport.vehicle.trailer.registration_number", "identifier", "one"),
        ("common.transport.vehicle.trailer.make_type", "text", "one"),
        ("common.transport.conveyance.name_and_voyage_number", "text", "one"),
        ("common.customs.number", "identifier", "one"),
        ("common.customs.pre_entry_number", "identifier", "one"),
        ("common.customs.declarant_certificate_number", "identifier", "one"),
        ("common.customs.supervision_mode", "code", "one"),
        ("common.customs.tax_exemption_nature", "text", "one"),
        ("common.customs.tax_treatment", "text", "one"),
        ("common.price.unit", "money", "one"),
        ("common.price.total", "money", "one"),
        ("common.price.currency", "currency", "one"),
        ("common.price.influence_confirmation", "text", "one"),
        ("common.price.royalty_payment_confirmation", "text", "one"),
        ("common.price.special_relationship_confirmation", "text", "one"),
        ("coo.certificate.number", "identifier", "one"),
        ("coo.issuing_authority.name", "text", "one"),
        ("coo.origin_criterion", "code", "one"),
        ("coo.certification_statement", "text", "one"),
        ("cmr.sender.instructions", "text", "one"),
        ("cmr.sender.instructions.amount", "money", "one"),
        ("cmr.sender.instructions.date", "date", "one"),
        ("cmr.refund.terms", "text", "one"),
        ("cmr.freight.payment_instruction", "text", "one"),
        ("cmr.carrier.reservations", "text", "one"),
        ("cmr.special_agreement", "text", "one"),
        ("cmr.receipt.date", "date", "one"),
        ("cmr.receipt.time", "time", "one"),
        ("cmr.receipt.arrival.hour", "integer", "one"),
        ("cmr.receipt.arrival.minute", "integer", "one"),
        ("cmr.receipt.departure.hour", "integer", "one"),
        ("cmr.receipt.departure.minute", "integer", "one"),
    )
    for key, semantic_type, cardinality in exact:
        add(key, semantic_type, cardinality)

    item_attrs: tuple[tuple[str, SemanticType], ...] = (
        ("description", "text"), ("hs_code", "code"), ("class", "code"),
        ("item_number", "identifier"), ("country_of_origin", "country"),
        ("placement_note", "text"), ("dangerous_goods.number", "code"),
        ("dangerous_goods.letter", "code"), ("dangerous_goods.adr", "code"),
        ("declared_value", "money"),
    )
    for suffix, semantic_type in item_attrs:
        add(f"common.goods.items[].{suffix}", semantic_type, "many")

    charge_rows = ("freight", "discounts", "subtotal", "surcharges", "additional", "other", "total")
    for row in charge_rows:
        add(f"cmr.charges.{row}.sender", "money")
        add(f"cmr.charges.{row}.currency", "currency")
        add(f"cmr.charges.{row}.consignee", "money")
    return schema


CANONICAL_SCHEMA = _build_canonical_schema()
VALID_PRESENCE = {"required", "recommended", "optional"}
VALID_MISSING_POLICIES = {"error", "omit", "blank", "synthesize", "derive"}
VALID_ITEM_STRATEGIES = {None, "first", "join"}


def get_canonical_schema() -> dict[str, dict[str, Any]]:
    """Return the shared schema understood by this generator."""
    return {key: asdict(value) for key, value in sorted(CANONICAL_SCHEMA.items())}


def _schema_digest() -> str:
    payload = json.dumps(get_canonical_schema(), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _get_dotted(record: Mapping[str, Any], path: str) -> tuple[bool, Any]:
    if path in record:  # Flat dotted records are supported.
        return True, record[path]
    current: Any = record
    for part in path.split("."):
        if isinstance(current, Mapping) and part in current:
            current = current[part]
        elif isinstance(current, Sequence) and not isinstance(current, (str, bytes)) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            return False, None
    return True, current


def _walk_wildcard(current: Any, parts: list[str]) -> list[Any]:
    if not parts:
        return [current]
    part = parts[0]
    rest = parts[1:]
    if part.endswith("[]"):
        key = part[:-2]
        if not isinstance(current, Mapping) or key not in current or not isinstance(current[key], Sequence) or isinstance(current[key], (str, bytes)):
            return []
        values: list[Any] = []
        for item in current[key]:
            values.extend(_walk_wildcard(item, rest))
        return values
    if isinstance(current, Mapping) and part in current:
        return _walk_wildcard(current[part], rest)
    return []


def _role_entity_values(record: Mapping[str, Any], canonical_key: str) -> list[Any]:
    """Resolve normalized party entities when direct role snapshots are absent."""
    prefix = "common.roles."
    if not canonical_key.startswith(prefix):
        return []
    remainder = canonical_key[len(prefix):]
    role = next((r for r in sorted(PARTY_ROLES, key=len, reverse=True) if remainder == r or remainder.startswith(r + ".")), None)
    if role is None:
        return []
    suffix = remainder[len(role):].lstrip(".")
    found, party_id = _get_dotted(record, f"common.role_assignments.{role}")
    if not found or party_id is None:
        return []
    found, value = _get_dotted(record, f"common.entities.parties.{party_id}.{suffix}")
    return [value] if found and value is not None else []


def _get_values(record: Mapping[str, Any], path: str) -> list[Any]:
    found, value = _get_dotted(record, path)
    if found:
        return list(value) if isinstance(value, list) and "[]" in path else [value]
    if "[]" in path:
        values = _walk_wildcard(record, path.split("."))
        if values:
            return [v for v in values if v is not None]
    return _role_entity_values(record, path)


def _collapse_values(values: list[Any], strategy: ItemStrategy | None) -> str:
    cleaned = [str(v).strip() for v in values if v is not None and str(v).strip()]
    if not cleaned:
        return ""
    if strategy in (None, "first"):
        return cleaned[0]
    if strategy == "join":
        return " | ".join(cleaned)
    raise ValueError(f"Unsupported item strategy: {strategy}")


def _field_rng(seed: int, field_key: str) -> random.Random:
    digest = hashlib.sha256(f"{seed}:{field_key}".encode("utf-8")).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def _resolve_font_path(bold: bool) -> str:
    requested = FONT_BOLD if bold else FONT_REGULAR
    fallbacks = (
        requested,
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    )
    for path in fallbacks:
        if Path(path).is_file():
            return path
    raise FileNotFoundError(f"No usable font found. Tried: {fallbacks}")


@lru_cache(maxsize=256)
def _font(size: int, bold: bool) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(_resolve_font_path(bold), size=size)


def _text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont) -> int:
    if not text:
        return 0
    box = draw.textbbox((0, 0), text, font=font, anchor="lt")
    return box[2] - box[0]


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_width: int, max_lines: int) -> list[str] | None:
    text = str(text).strip()
    if not text:
        return [""]
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        if _text_width(draw, candidate, font) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ""
        token = word
        while token and _text_width(draw, token, font) > max_width:
            cut = len(token)
            while cut > 1 and _text_width(draw, token[:cut], font) > max_width:
                cut -= 1
            lines.append(token[:cut])
            token = token[cut:]
            if len(lines) > max_lines:
                return None
        current = token
    if current or not lines:
        lines.append(current)
    return lines if len(lines) <= max_lines else None


def _scale_box(box: tuple[int, int, int, int], sx: float, sy: float) -> tuple[int, int, int, int]:
    return tuple(int(round(v * (sx if index % 2 == 0 else sy))) for index, v in enumerate(box))  # type: ignore[return-value]






def _median_fill_from_margin(
    image: Image.Image, target: tuple[int, int, int, int], margin: int
) -> tuple[int, int, int]:
    """Estimate local paper color from a ring around an erase target."""
    x0, y0, x1, y1 = target
    width, height = image.size
    m = max(1, margin)
    samples: list[tuple[int, int, int]] = []
    strips = [
        (max(0, x0 - m), max(0, y0 - m), min(width, x1 + m), y0),
        (max(0, x0 - m), y1, min(width, x1 + m), min(height, y1 + m)),
        (max(0, x0 - m), y0, x0, y1),
        (x1, y0, min(width, x1 + m), y1),
    ]
    for box in strips:
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        samples.extend(image.crop(box).convert("RGB").getdata())
    if not samples:
        return (255, 255, 255)
    if np is not None:
        values = np.asarray(samples, dtype=np.uint8)
        median = np.median(values, axis=0)
        return tuple(int(round(value)) for value in median)  # type: ignore[return-value]
    channels = list(zip(*samples))
    ordered = [sorted(channel) for channel in channels]
    middle = len(samples) // 2
    return tuple(int(channel[middle]) for channel in ordered)  # type: ignore[return-value]


def _apply_erase_spec(image: Image.Image, spec: EraseSpec, sx: float, sy: float) -> None:
    target = _scale_box(spec.bbox, sx, sy)
    if spec.method == "none":
        return
    if spec.method == "clone":
        if spec.source_bbox is None:
            raise ValueError(f"clone erase requires source_bbox for {spec.bbox}")
        source = _scale_box(spec.source_bbox, sx, sy)
        patch = image.crop(source)
        target_size = (target[2] - target[0], target[3] - target[1])
        if patch.size != target_size:
            patch = patch.resize(target_size, Image.Resampling.BICUBIC)
        image.paste(patch, target[:2])
        return
    draw = ImageDraw.Draw(image)
    if spec.method == "local_median":
        margin = max(1, int(round(spec.sample_margin * (sx + sy) / 2.0)))
        fill = _median_fill_from_margin(image, target, margin)
    elif spec.method == "solid_white":
        fill = spec.fill_rgb
    else:
        raise ValueError(f"Unsupported erase method: {spec.method}")
    draw.rectangle(target, fill=fill)


def _prepare_background(pdf_path: Path, dpi: int) -> Image.Image:
    image = _render_pdf_page(pdf_path, dpi)
    sx, sy = image.width / BASE_SIZE[0], image.height / BASE_SIZE[1]
    for spec in ERASE_SPECS:
        _apply_erase_spec(image, spec, sx, sy)
    return image


def _derive_value(spec: FieldSpec, record: Mapping[str, Any]) -> tuple[bool, str, str | None]:
    if spec.derivation == "copy_first":
        for source in spec.derived_from:
            values = _get_values(record, source)
            value = _collapse_values(values, "first")
            if value:
                return True, value, source
        return False, "", None
    if spec.derivation is None:
        return False, "", None
    raise ValueError(f"{spec.local_key}: unknown derivation={spec.derivation}")


def _synthetic_value(spec: FieldSpec, seed: int, scenario: str) -> str:
    """Deterministic fallback for tests. The orchestrator should normally fill proposals once."""
    rng = _field_rng(seed, spec.canonical_key)
    token = rng.randint(1000, 999999)
    templates: dict[str, str] = {
        "identifier": f"ID-{token}", "code": f"C{token % 100000}",
        "country": f"Testland-{token % 97}", "date": f"{1 + token % 28:02d}.{1 + token % 12:02d}.{2020 + token % 15}",
        "time": f"{token % 24:02d}:{token % 60:02d}", "integer": str(1 + token % 999),
        "uri": f"https://example-{token}.test", "measurement": f"{1 + token % 9999} kg",
        "money": f"{token % 100000}.{token % 100:02d}", "currency": "USD",
        "address": f"{1 + token % 999} Synthetic Street, Test City", "text": f"{scenario.upper()} VALUE {token}",
        "boolean": "true",
    }
    return templates[spec.semantic_type][:spec.max_chars]


def _resolve_one_field(
    spec: FieldSpec,
    record: Mapping[str, Any],
    *,
    input_mode: Literal["canonical", "local"],
    key_map: Mapping[str, str],
    allow_synthesis: bool,
    seed: int,
    scenario: str,
) -> dict[str, Any]:
    external_key = key_map.get(spec.local_key, spec.local_key if input_mode == "local" else spec.canonical_key)
    candidates = (external_key,) + (() if input_mode == "local" else spec.source_candidates)
    for index, key in enumerate(candidates):
        values = _get_values(record, key)
        value = _collapse_values(values, spec.item_strategy)
        if value:
            return {"status": "exact" if index == 0 else "candidate", "value": value, "source_key": key}
    if input_mode == "canonical" and spec.missing_policy == "derive":
        found, value, source = _derive_value(spec, record)
        if found:
            return {"status": "derived", "value": value, "source_key": source}
    if spec.missing_policy == "blank":
        return {"status": "blank", "value": "", "source_key": None}
    if spec.missing_policy == "synthesize" and allow_synthesis:
        return {"status": "synthesized", "value": _synthetic_value(spec, seed, scenario), "source_key": None}
    return {"status": "missing", "value": None, "source_key": None}


def resolve_record(
    record: Mapping[str, Any],
    *,
    input_mode: Literal["canonical", "local"] = "canonical",
    key_map: Mapping[str, str] | None = None,
    allow_synthesis: bool = False,
    seed: int = 0,
    scenario: str = "synthetic",
) -> dict[str, Any]:
    """Resolve shared canonical data to local fields without rejecting unrelated keys."""
    if input_mode not in {"canonical", "local"}:
        raise ValueError("input_mode must be canonical or local")
    bindings = key_map or {}
    local_record: dict[str, str] = {}
    fields: list[dict[str, Any]] = []
    for spec in FIELD_CATALOG:
        result = _resolve_one_field(
            spec, record, input_mode=input_mode, key_map=bindings,
            allow_synthesis=allow_synthesis, seed=seed, scenario=scenario,
        )
        item = {
            "local_key": spec.local_key, "canonical_key": spec.canonical_key,
            "presence": spec.presence, "missing_policy": spec.missing_policy,
            **result,
        }
        if result["value"] is not None and (result["value"] != "" or spec.missing_policy == "blank"):
            local_record[spec.local_key] = str(result["value"])
        fields.append(item)
    unresolved_error = [f for f in fields if f["status"] == "missing" and next(s for s in FIELD_CATALOG if s.local_key == f["local_key"]).missing_policy == "error"]
    unresolved_required = [f for f in fields if f["status"] == "missing" and f["presence"] == "required"]
    return {
        "local_record": local_record,
        "fields": fields,
        "unresolved_error": unresolved_error,
        "unresolved_required": unresolved_required,
        "resolved_field_count": len(local_record),
    }


def validate_record(
    record: Mapping[str, Any],
    *,
    input_mode: Literal["canonical", "local"] = "canonical",
    key_map: Mapping[str, str] | None = None,
    allow_synthesis: bool = False,
    require_required: bool = True,
    seed: int = 0,
    scenario: str = "synthetic",
) -> dict[str, Any]:
    resolution = resolve_record(
        record, input_mode=input_mode, key_map=key_map,
        allow_synthesis=allow_synthesis, seed=seed, scenario=scenario,
    )
    errors: list[str] = []
    if resolution["unresolved_error"]:
        errors.append(f"Fields with missing_policy=error are unresolved: {resolution['unresolved_error']}")
    if require_required and resolution["unresolved_required"]:
        errors.append(f"Required fields are unresolved: {resolution['unresolved_required']}")
    specs = {spec.local_key: spec for spec in FIELD_CATALOG}
    for key, value in resolution["local_record"].items():
        spec = specs[key]
        if len(value) > spec.max_chars:
            errors.append(f"{key}: {len(value)} chars exceeds max_chars={spec.max_chars}")
    return {"valid": not errors, "errors": errors, **resolution}


def _available_for_key_set(keys: set[str], spec: FieldSpec, key_map: Mapping[str, str]) -> str:
    external = key_map.get(spec.local_key, spec.canonical_key)
    if external in keys:
        return "exact"
    if any(key in keys for key in spec.source_candidates):
        return "candidate"
    if spec.missing_policy == "derive" and any(key in keys for key in spec.derived_from):
        return "derived"
    if spec.missing_policy == "synthesize":
        return "synthesizable"
    return "missing"


def assess_compatibility(
    record_or_keys: Mapping[str, Any] | Iterable[str],
    *,
    key_map: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Score partial compatibility before rendering or choosing a document set."""
    bindings = key_map or {}
    is_record = isinstance(record_or_keys, Mapping)
    keys = set(record_or_keys.keys()) if is_record else set(record_or_keys)
    statuses: list[dict[str, Any]] = []
    weight_by_presence = {"required": 5.0, "recommended": 2.0, "optional": 0.5}
    multiplier = {"exact": 1.0, "candidate": 0.9, "derived": 0.8, "synthesizable": 0.4, "missing": 0.0}
    earned = 0.0
    possible = 0.0
    hard_missing: list[str] = []
    for spec in FIELD_CATALOG:
        if is_record:
            result = _resolve_one_field(spec, record_or_keys, input_mode="canonical", key_map=bindings, allow_synthesis=False, seed=0, scenario="compatibility")
            status = result["status"]
            if status == "missing" and spec.missing_policy == "synthesize":
                status = "synthesizable"
        else:
            status = _available_for_key_set(keys, spec, bindings)
        weight = weight_by_presence[spec.presence]
        if spec.presence != "optional":
            possible += weight
            earned += weight * multiplier[status]
        elif status in {"exact", "candidate", "derived"}:
            earned += 0.1 * multiplier[status]
        if status == "missing" and spec.missing_policy == "error":
            hard_missing.append(spec.canonical_key)
        statuses.append({"local_key": spec.local_key, "canonical_key": spec.canonical_key, "presence": spec.presence, "status": status})
    score = min(1.0, earned / possible) if possible else 1.0
    counts: dict[str, int] = {}
    for item in statuses:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    return {
        "compatible": not hard_missing,
        "score": round(score, 6),
        "counts": counts,
        "hard_missing": sorted(set(hard_missing)),
        "fields": statuses,
    }


def _generation_hint(semantic_type: SemanticType) -> str:
    hints = {
        "text": "Generate a concise, theme-consistent text value.",
        "identifier": "Generate a realistic identifier with stable formatting.",
        "code": "Generate a valid-looking domain code.",
        "address": "Generate one compact postal address.",
        "country": "Use a country name consistent with the shipment theme.",
        "date": "Use one consistent document date format.",
        "time": "Use HH:MM unless the template requires another format.",
        "uri": "Generate a plausible website URL.",
        "integer": "Generate digits only unless the field definition says otherwise.",
        "measurement": "Include a numeric value and unit.",
        "money": "Use a numeric amount; keep currency in its separate field when available.",
        "currency": "Use one ISO-like three-letter currency code.",
        "boolean": "Use true or false.",
    }
    return hints[semantic_type]


def propose_missing_values(
    record: Mapping[str, Any],
    *,
    key_map: Mapping[str, str] | None = None,
    seed: int = 0,
    scenario: str = "synthetic",
    include_suggestions: bool = True,
) -> dict[str, Any]:
    """Return deduplicated canonical requirements for one shared themed record."""
    resolution = resolve_record(record, key_map=key_map, allow_synthesis=False)
    by_key: dict[str, dict[str, Any]] = {}
    specs = {spec.local_key: spec for spec in FIELD_CATALOG}
    for item in resolution["fields"]:
        if item["status"] != "missing":
            continue
        spec = specs[item["local_key"]]
        if spec.missing_policy not in {"synthesize", "derive"}:
            continue
        proposal = by_key.setdefault(spec.canonical_key, {
            "canonical_key": spec.canonical_key,
            "semantic_type": spec.semantic_type,
            "presence": spec.presence,
            "max_chars": spec.max_chars,
            "used_by": [],
            "generation_hint": _generation_hint(spec.semantic_type),
            "source_candidates": list(spec.source_candidates),
            "derived_from": list(spec.derived_from),
        })
        proposal["used_by"].append(spec.local_key)
        proposal["max_chars"] = min(proposal["max_chars"], spec.max_chars)
        if include_suggestions and spec.missing_policy == "synthesize":
            proposal["suggested_value"] = _synthetic_value(spec, seed, scenario)
    return {"generator_id": GENERATOR_ID, "proposals": list(by_key.values())}










def _bbox_overlap(a: list[int], b: list[int]) -> int:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    return max(0, x1 - x0) * max(0, y1 - y0)




def _bbox_area(box: Sequence[float]) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def _cover_ratio(inner: Sequence[float], outer: Sequence[float]) -> float:
    area = _bbox_area(inner)
    return 0.0 if area <= 0 else _bbox_overlap([int(v) for v in inner], [int(v) for v in outer]) / area


def _union_boxes(boxes: Sequence[Sequence[float]]) -> list[float]:
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _to_1000(box: Sequence[float], width: int, height: int) -> list[int]:
    values = [
        round(1000 * box[0] / width), round(1000 * box[1] / height),
        round(1000 * box[2] / width), round(1000 * box[3] / height),
    ]
    values = [max(0, min(1000, int(v))) for v in values]
    if values[2] <= values[0]: values[2] = min(1000, values[0] + 1)
    if values[3] <= values[1]: values[3] = min(1000, values[1] + 1)
    return values


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")




def _extract_manual_static_text(image_size: tuple[int, int]) -> list[dict[str, Any]]:
    width, height = image_size
    sx, sy = width / BASE_SIZE[0], height / BASE_SIZE[1]
    output: list[dict[str, Any]] = []
    for item in STATIC_TEXT_CATALOG:
        if not item.text.strip():
            continue
        output.append({
            "text": " ".join(item.text.split()),
            "bbox_px": [float(v) for v in _scale_box(item.bbox, sx, sy)],
            "source": "manual_static",
            "angle": item.angle,
        })
    return output




def _generated_text_lines(annotations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for field in annotations:
        for line, box in zip(field.get("lines", []), field.get("line_boxes", [])):
            if line.strip():
                items.append({"text": line, "bbox_px": [float(v) for v in box], "source": "generated", "local_key": field["local_key"]})
    return items


def _deduplicate_text_items(items: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove duplicate text layers, preferring generated text and PDF text over raster fallbacks."""
    priority = {"generated": 0, "manual_static": 1, "pdf_text": 2, "raster_text": 3}
    ordered = sorted(items, key=lambda item: (priority.get(item.get("source", ""), 9), item["bbox_px"][1], item["bbox_px"][0]))
    kept: list[dict[str, Any]] = []
    for item in ordered:
        text = " ".join(item["text"].lower().split())
        box = item["bbox_px"]
        duplicate = False
        for existing in kept:
            other_text = " ".join(existing["text"].lower().split())
            other_box = existing["bbox_px"]
            overlap = _bbox_overlap([int(v) for v in box], [int(v) for v in other_box])
            if overlap <= 0:
                continue
            smaller = min(_bbox_area(box), _bbox_area(other_box))
            text_related = text == other_text or (len(text) >= 4 and text in other_text) or (len(other_text) >= 4 and other_text in text)
            if smaller > 0 and overlap / smaller >= 0.65 and text_related:
                duplicate = True
                break
            # A raster fallback often contains several PDF text lines in one large box.
            cx = (other_box[0] + other_box[2]) / 2.0
            cy = (other_box[1] + other_box[3]) / 2.0
            shared_words = set(text.split()) & set(other_text.split())
            if item.get("source") == "raster_text" and box[0] <= cx <= box[2] and box[1] <= cy <= box[3] and shared_words:
                duplicate = True
                break
        if not duplicate:
            kept.append(item)
    return sorted(kept, key=lambda item: (item["bbox_px"][1], item["bbox_px"][0], item["text"]))


def _clean_cell_text(text: str) -> str:
    text = " ".join(text.split())
    for token in OTSL_TOKENS:
        text = text.replace(token, token.replace("<", "[").replace(">", "]"))
    return text


def _text_for_cell(all_text: Sequence[dict[str, Any]], bbox: Sequence[float]) -> str:
    selected: list[dict[str, Any]] = []
    for item in all_text:
        b = item["bbox_px"]
        cx, cy = (b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0
        if bbox[0] <= cx <= bbox[2] and bbox[1] <= cy <= bbox[3]:
            selected.append(item)
    selected.sort(key=lambda item: (item["bbox_px"][1], item["bbox_px"][0], item["text"]))
    return _clean_cell_text(" ".join(item["text"] for item in selected if item["text"].strip()))






def _save_pdf_from_image(image_path: Path, output_pdf: Path, dpi: int) -> None:
    image = Image.open(image_path)
    width_pt, height_pt = image.width * 72 / dpi, image.height * 72 / dpi
    doc = fitz.open()
    page = doc.new_page(width=width_pt, height=height_pt)
    page.insert_image(page.rect, filename=str(image_path))
    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    doc.save(output_pdf)










def _canonical_weird_record() -> dict[str, Any]:
    record: dict[str, Any] = {}
    specs = {spec.local_key: spec for spec in FIELD_CATALOG}
    for local_key, value in make_weird_data().items():
        record[specs[local_key].canonical_key] = value
    return record


EDGE_STRESS_KEYS = {
    "document.number", "sender.name", "sender.address", "consignee.name",
    "consignee.address", "attached_documents.references", "goods.description",
    "sender.instructions", "carrier.name", "carrier.address",
    "carrier.reservations", "special_agreement",
    "sender.signature_block_details", "carrier.signature_block_details",
}


def _fast_stress_text(spec: FieldSpec, token: str, width_factor: float) -> str:
    usable_width = max(1, spec.bbox[2] - spec.bbox[0] - 2 * spec.padding)
    chars_per_line = max(1, int(usable_width / max(1.0, spec.font_size * width_factor)))
    target = min(spec.max_chars, max(1, int(chars_per_line * spec.max_lines * 0.78)))
    return (token * ((target // len(token)) + 1))[:target]


def _edge_record(profile: str) -> dict[str, Any]:
    local = make_weird_data()
    profiles = {
        "wide_exact_fit": ("W", 0.95), "unbroken_tokens": ("ZX9_", 0.62),
        "multilingual_punctuation": ("ΩЖĄéß№42/", 1.20),
    }
    if profile in profiles:
        token, factor = profiles[profile]
        for spec in FIELD_CATALOG:
            if spec.local_key in EDGE_STRESS_KEYS:
                local[spec.local_key] = _fast_stress_text(spec, token, factor)
    elif profile == "dense_multiline":
        for spec in FIELD_CATALOG:
            if spec.local_key in EDGE_STRESS_KEYS and spec.max_lines > 1:
                local[spec.local_key] = _fast_stress_text(spec, "WEIRD WORD ", 0.62)
    elif profile != "baseline":
        raise ValueError(f"Unknown edge profile={profile}")
    specs = {spec.local_key: spec for spec in FIELD_CATALOG}
    return {specs[key].canonical_key: value for key, value in local.items()}





# =============================================================================
# AGENTIC AUDIT HARDENING LAYER
#
# This layer intentionally overrides the shallow template-agnostic helpers
# above while preserving the public API and template edit zone. It adds:
# scan-only safety, explicit effective field constraints, natural placement,
# container and collision enforcement, strict labels, the complete edge suite,
# deterministic regression checks, and an external visual-review handshake.
# =============================================================================

import os
import sys
import unicodedata
from collections import defaultdict
from dataclasses import replace

try:
    from fontTools.ttLib import TTFont
except Exception:  # Optional. Pillow fallback remains available.
    TTFont = None  # type: ignore[assignment]

VISUAL_REVIEW_SCHEMA_VERSION = "synthetic-document-visual-review/1.0"
VISUAL_REVIEW_REQUIRED_CHECKS = (
    "template_geometry",
    "background_reconstruction",
    "normal_render",
    "weird_render",
    "visible_text_coverage",
    "natural_placement",
    "no_source_residue",
)

EDGE_CASE_NAMES = (
    "normal_random_placement",
    "top_left_placement",
    "bottom_right_placement",
    "wide_glyph_pressure",
    "narrow_glyph_pressure",
    "long_unbroken_strings",
    "punctuation",
    "multilingual_text",
    "dense_multiline_text",
    "minimum_font_size",
    "maximum_permitted_character_length",
    "low_dpi",
    "high_dpi",
    "text_near_field_edges",
    "shared_collision_groups",
    "expected_max_chars_failure",
    "expected_impossible_fit_failure",
)


EDGE_REPRESENTATIVE_KEYS = (
    "document.number",
    "sender.name",
    "sender.address",
    "attached_documents.references",
    "goods.description",
    "goods.hs_code",
    "weight.gross.total",
    "sender.instructions",
    "carrier.name",
    "carrier.address",
    "charges.freight.sender",
    "charges.freight.currency",
    "document.issue_date",
    "driver.name",
)

REQUIRED_SAMPLE_CHECKS = (
    "input_validation",
    "rendering",
    "layout_generation",
    "layout_validation",
    "table_otsl_generation",
    "table_otsl_validation",
    "table_text_bbox_generation",
    "table_text_bbox_validation",
    "key_information_generation",
    "key_information_validation",
    "boundary_validation",
    "container_validation",
    "collision_validation",
    "border_intersection_validation",
)

REQUIRED_SAMPLE_METRICS = (
    "rendered_fields",
    "omitted_optional_fields",
    "table_count",
    "otsl_files",
    "table_text_bbox_files",
    "boundary_violations",
    "container_violations",
    "text_collisions",
    "border_intersections",
)

REQUIRED_GENERATOR_CHECKS = (
    "syntax_import",
    "self_test",
    "normal_render",
    "weird_render",
    "edge_cases",
    "determinism",
    "output_contract",
    "layout_labels",
    "table_otsl",
    "table_text_bbox",
    "key_information",
    "visual_quality",
)

REQUIRED_GENERATOR_METRICS = (
    "field_count",
    "required_fields",
    "recommended_fields",
    "optional_fields",
    "derived_fields",
    "synthesizable_fields",
    "table_count",
    "edge_cases_total",
    "edge_cases_passed",
    "boundary_violations",
    "container_violations",
    "text_collisions",
    "border_intersections",
)

ALLOWED_PLACEMENT_PROFILES = {
    "natural",
    "random",
    "top_left",
    "top_right",
    "bottom_left",
    "bottom_right",
    "center",
}


@lru_cache(maxsize=8)
def _render_pdf_page_cached(
    path_text: str,
    modified_ns: int,
    size_bytes: int,
    dpi: int,
    page_index: int,
) -> Image.Image:
    """Cache immutable source-page rasters across audit cases."""
    del modified_ns, size_bytes
    path = Path(path_text)
    with fitz.open(path) as document:
        if page_index < 0 or page_index >= document.page_count:
            raise IndexError(f"SOURCE_PAGE_INDEX={page_index} but PDF has {document.page_count} pages")
        page = document[page_index]
        pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72.0, dpi / 72.0), alpha=False)
        return Image.frombytes("RGB", [pix.width, pix.height], pix.samples)


def _render_pdf_page(pdf_path: Path, dpi: int) -> Image.Image:
    pdf_path = Path(pdf_path)
    stat = pdf_path.stat()
    cached = _render_pdf_page_cached(str(pdf_path.resolve()), stat.st_mtime_ns, stat.st_size, dpi, SOURCE_PAGE_INDEX)
    return cached.copy()


class GeneratorError(Exception):
    """Typed failure routed into the shared report envelope."""

    def __init__(
        self,
        status_code: int,
        code: str,
        stage: str,
        message: str,
        *,
        artifact: str | None = None,
        field: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.stage = stage
        self.message = message
        self.artifact = artifact
        self.field = field

    def as_error(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "stage": self.stage,
            "message": self.message,
            "artifact": self.artifact,
            "field": self.field,
        }


def _error(
    code: str,
    stage: str,
    message: str,
    *,
    artifact: str | None = None,
    field: str | None = None,
) -> dict[str, Any]:
    return {
        "code": code,
        "stage": stage,
        "message": message,
        "artifact": artifact,
        "field": field,
    }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _same_file_bytes(a: Path, b: Path) -> bool:
    return a.is_file() and b.is_file() and a.stat().st_size == b.stat().st_size and _sha256_file(a) == _sha256_file(b)


def _json_load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _safe_relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except Exception:
        return path.as_posix()


def _effective_field(spec: FieldSpec) -> dict[str, Any]:
    override = FIELD_RUNTIME_OVERRIDES.get(spec.local_key, {})
    allowed = {
        "reference_bbox",
        "container_bbox",
        "collision_group",
        "anchor",
        "jitter_x",
        "jitter_y",
        "line_spacing",
        "allow_character_wrap",
        "legibility_min_px_at_base_dpi",
    }
    unknown = set(override) - allowed
    if unknown:
        raise GeneratorError(
            30,
            "INVALID_FIELD_OVERRIDE",
            "self_test",
            f"{spec.local_key}: unsupported runtime override keys {sorted(unknown)}",
            field=spec.local_key,
        )
    anchor_default = "center" if spec.align == "center" else ("top_right" if spec.align == "right" else "top_left")
    reference_bbox = tuple(override.get("reference_bbox", spec.bbox))
    container_bbox = tuple(override.get("container_bbox", spec.bbox))
    collision_group = override.get("collision_group")
    anchor = str(override.get("anchor", anchor_default))
    jitter_x = int(override.get("jitter_x", min(8, max(0, spec.padding))))
    jitter_y = int(override.get("jitter_y", min(5, max(0, spec.padding))))
    line_spacing = float(override.get("line_spacing", 1.12))
    allow_character_wrap = bool(override.get("allow_character_wrap", False))
    legibility_min = int(override.get("legibility_min_px_at_base_dpi", spec.min_font_size))
    return {
        "local_key": spec.local_key,
        "canonical_key": spec.canonical_key,
        "semantic_type": spec.semantic_type,
        "box": spec.box,
        "presence": spec.presence,
        "missing_policy": spec.missing_policy,
        "boundary_bbox": tuple(spec.bbox),
        "reference_bbox": reference_bbox,
        "container_bbox": container_bbox,
        "max_chars": spec.max_chars,
        "max_lines": spec.max_lines,
        "font_size": spec.font_size,
        "min_font_size": spec.min_font_size,
        "font_family": FONT_BOLD if spec.bold else FONT_REGULAR,
        "font_weight": "bold" if spec.bold else "regular",
        "bold": spec.bold,
        "alignment": spec.align,
        "placement_strategy": "anchored_jitter" if spec.placement == "random" else spec.placement,
        "anchor": anchor,
        "jitter_x": jitter_x,
        "jitter_y": jitter_y,
        "line_spacing": line_spacing,
        "padding": spec.padding,
        "collision_group": collision_group,
        "allow_character_wrap": allow_character_wrap,
        "legibility_min_px_at_base_dpi": legibility_min,
        "item_strategy": spec.item_strategy,
        "source_candidates": list(spec.source_candidates),
        "derivation": spec.derivation,
        "derivation_sources": list(spec.derived_from),
        "description": spec.description,
    }


def _field_spec_map() -> dict[str, FieldSpec]:
    return {spec.local_key: spec for spec in FIELD_CATALOG}


def _effective_map() -> dict[str, dict[str, Any]]:
    return {spec.local_key: _effective_field(spec) for spec in FIELD_CATALOG}


def _box_inside(inner: Sequence[int | float], outer: Sequence[int | float]) -> bool:
    return outer[0] <= inner[0] < inner[2] <= outer[2] and outer[1] <= inner[1] < inner[3] <= outer[3]


def _boxes_intersect(a: Sequence[int | float], b: Sequence[int | float]) -> bool:
    return min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])


def _normalized_sort_key(item: Mapping[str, Any]) -> tuple[Any, ...]:
    box = item["bbox"]
    return (box[1], box[0], box[3], box[2], item.get("type", ""))


def _font_supported_characters(path: str) -> set[int] | None:
    if TTFont is None or not Path(path).is_file():
        return None
    try:
        font = TTFont(path, lazy=True)
        codepoints: set[int] = set()
        for table in font["cmap"].tables:
            codepoints.update(table.cmap)
        font.close()
        return codepoints
    except Exception:
        return None


@lru_cache(maxsize=8)
def _font_cmap(path: str) -> frozenset[int] | None:
    values = _font_supported_characters(path)
    return None if values is None else frozenset(values)


def _assert_font_supports_text(spec: FieldSpec, value: str) -> None:
    path = _resolve_font_path(spec.bold)
    cmap = _font_cmap(path)
    if cmap is None:
        return
    missing = sorted({ord(char) for char in value if not char.isspace() and ord(char) not in cmap})
    if missing:
        examples = " ".join(f"U+{code:04X}" for code in missing[:8])
        raise GeneratorError(
            40,
            "MISSING_GLYPH",
            "rendering",
            f"{spec.local_key}: configured font does not cover {examples}",
            field=spec.local_key,
        )


def _split_token_to_width(
    draw: ImageDraw.ImageDraw,
    token: str,
    font: ImageFont.FreeTypeFont,
    max_width: int,
) -> list[str] | None:
    if not token:
        return [""]
    parts: list[str] = []
    remaining = token
    while remaining:
        if _text_width(draw, remaining, font) <= max_width:
            parts.append(remaining)
            break
        low, high = 1, len(remaining)
        best = 0
        while low <= high:
            mid = (low + high) // 2
            if _text_width(draw, remaining[:mid], font) <= max_width:
                best = mid
                low = mid + 1
            else:
                high = mid - 1
        if best <= 0:
            return None
        parts.append(remaining[:best])
        remaining = remaining[best:]
    return parts


def _wrap_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: int,
    max_lines: int,
    *,
    allow_character_wrap: bool,
) -> list[str] | None:
    text = str(text).strip()
    if not text:
        return [""]
    explicit_lines = text.splitlines() or [text]
    if len(explicit_lines) > max_lines:
        return None
    output: list[str] = []
    for explicit in explicit_lines:
        if not explicit:
            output.append("")
            if len(output) > max_lines:
                return None
            continue
        words = explicit.split()
        current = ""
        for word in words:
            candidate = word if not current else f"{current} {word}"
            if _text_width(draw, candidate, font) <= max_width:
                current = candidate
                continue
            if current:
                output.append(current)
                current = ""
                if len(output) >= max_lines:
                    return None
            if _text_width(draw, word, font) <= max_width:
                current = word
                continue
            if not allow_character_wrap:
                return None
            pieces = _split_token_to_width(draw, word, font, max_width)
            if not pieces:
                return None
            for piece in pieces[:-1]:
                output.append(piece)
                if len(output) >= max_lines:
                    return None
            current = pieces[-1]
        output.append(current)
        if len(output) > max_lines:
            return None
    return output


def _fit_text(
    draw: ImageDraw.ImageDraw,
    spec: FieldSpec,
    value: str,
    boundary: tuple[int, int, int, int],
    scale: float,
) -> tuple[ImageFont.FreeTypeFont, list[str], int, int, int]:
    effective = _effective_field(spec)
    x0, y0, x1, y1 = boundary
    pad = max(1, int(round(spec.padding * scale)))
    max_width = max(1, x1 - x0 - 2 * pad)
    max_height = max(1, y1 - y0 - 2 * pad)
    start = max(1, int(round(spec.font_size * scale)))
    minimum = max(1, int(round(spec.min_font_size * scale)))
    for size in range(start, minimum - 1, -1):
        font = _font(size, spec.bold)
        lines = _wrap_text(
            draw,
            value,
            font,
            max_width,
            spec.max_lines,
            allow_character_wrap=effective["allow_character_wrap"],
        )
        if lines is None:
            continue
        line_boxes = [draw.textbbox((0, 0), line or " ", font=font, anchor="lt") for line in lines]
        widths = [box[2] - box[0] for box in line_boxes]
        heights = [box[3] - box[1] for box in line_boxes]
        spacing = max(1, int(round(size * max(0.0, effective["line_spacing"] - 1.0))))
        block_width = max(widths, default=0)
        block_height = sum(heights) + spacing * max(0, len(lines) - 1)
        if block_width <= max_width and block_height <= max_height:
            return font, lines, block_width, block_height, spacing
    raise GeneratorError(
        40,
        "TEXT_CANNOT_FIT",
        "rendering",
        f"{spec.local_key}: complete value cannot fit at or above min_font_size={spec.min_font_size}",
        field=spec.local_key,
    )


def _line_layout(
    draw: ImageDraw.ImageDraw,
    lines: Sequence[str],
    font: ImageFont.FreeTypeFont,
    block_width: int,
    origin_x: int,
    origin_y: int,
    align: str,
    spacing: int,
) -> tuple[list[list[int]], list[tuple[int, int, str]]]:
    boxes: list[list[int]] = []
    positions: list[tuple[int, int, str]] = []
    cursor_y = origin_y
    for line in lines:
        raw = draw.textbbox((0, 0), line or " ", font=font, anchor="lt")
        line_w, line_h = raw[2] - raw[0], raw[3] - raw[1]
        line_x = origin_x
        if align == "center":
            line_x += max(0, (block_width - line_w) // 2)
        elif align == "right":
            line_x += max(0, block_width - line_w)
        if line:
            actual = draw.textbbox((line_x, cursor_y), line, font=font, anchor="lt")
            boxes.append(list(actual))
            positions.append((line_x, cursor_y, line))
        cursor_y += line_h + spacing
    return boxes, positions


def _natural_origin_candidates(
    effective: Mapping[str, Any],
    left: int,
    top: int,
    right: int,
    bottom: int,
    *,
    seed: int,
    field_key: str,
    profile: str,
) -> list[tuple[int, int]]:
    placements = {
        "top_left": (left, top),
        "top_right": (right, top),
        "bottom_left": (left, bottom),
        "bottom_right": (right, bottom),
        "center": ((left + right) // 2, (top + bottom) // 2),
    }
    if profile in placements:
        return [placements[profile]]
    if profile not in {"natural", "random"}:
        raise GeneratorError(10, "INVALID_PLACEMENT_PROFILE", "input_validation", f"Unknown placement_profile={profile}")
    anchor = str(effective["anchor"])
    base = placements.get(anchor, placements["top_left"])
    rng = _field_rng(seed, field_key)
    max_jx = min(max(0, int(effective["jitter_x"])), max(0, right - left))
    max_jy = min(max(0, int(effective["jitter_y"])), max(0, bottom - top))
    candidates = [base]
    for _ in range(12):
        dx = rng.randint(-max_jx, max_jx) if max_jx else 0
        dy = rng.randint(-max_jy, max_jy) if max_jy else 0
        candidates.append((min(right, max(left, base[0] + dx)), min(bottom, max(top, base[1] + dy))))
    # Deterministic fallback positions remain visually constrained.
    candidates.extend([placements["top_left"], placements["top_right"], placements["bottom_left"], placements["bottom_right"], placements["center"]])
    unique: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    for candidate in candidates:
        if candidate not in seen:
            seen.add(candidate)
            unique.append(candidate)
    return unique


def _draw_field(
    image: Image.Image,
    spec: FieldSpec,
    value: str,
    *,
    seed: int,
    sx: float,
    sy: float,
    placement_profile: str,
    source_key: str | None,
    provenance: str,
    occupied: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    value = str(value)
    if len(value) > spec.max_chars:
        raise GeneratorError(
            10,
            "MAX_CHARS_EXCEEDED",
            "input_validation",
            f"{spec.local_key}: {len(value)} characters exceeds max_chars={spec.max_chars}",
            field=spec.local_key,
        )
    _assert_font_supports_text(spec, value)
    effective = _effective_field(spec)
    boundary = _scale_box(tuple(effective["boundary_bbox"]), sx, sy)
    reference = _scale_box(tuple(effective["reference_bbox"]), sx, sy)
    container = _scale_box(tuple(effective["container_bbox"]), sx, sy)
    scale = (sx + sy) / 2.0
    draw = ImageDraw.Draw(image)
    font, lines, block_width, block_height, spacing = _fit_text(draw, spec, value, boundary, scale)
    x0, y0, x1, y1 = boundary
    pad = max(1, int(round(spec.padding * scale)))
    left, top = x0 + pad, y0 + pad
    right, bottom = x1 - pad - block_width, y1 - pad - block_height
    if right < left or bottom < top:
        raise GeneratorError(40, "TEXT_CANNOT_FIT", "rendering", f"{spec.local_key}: no legal placement remains", field=spec.local_key)

    candidates = _natural_origin_candidates(effective, left, top, right, bottom, seed=seed, field_key=spec.local_key, profile=placement_profile)
    selected_boxes: list[list[int]] | None = None
    selected_positions: list[tuple[int, int, str]] | None = None
    selected_origin: tuple[int, int] | None = None
    group = effective["collision_group"]
    for origin_x, origin_y in candidates:
        line_boxes, positions = _line_layout(draw, lines, font, block_width, origin_x, origin_y, spec.align, spacing)
        if not line_boxes:
            continue
        union = [
            min(box[0] for box in line_boxes),
            min(box[1] for box in line_boxes),
            max(box[2] for box in line_boxes),
            max(box[3] for box in line_boxes),
        ]
        if not _box_inside(union, boundary) or not _box_inside(union, container):
            continue
        conflict = False
        if group:
            for other in occupied:
                if other.get("collision_group") == group and _bbox_overlap(union, list(other["text_bbox"])) > 0:
                    conflict = True
                    break
        if conflict:
            continue
        selected_boxes = line_boxes
        selected_positions = positions
        selected_origin = (origin_x, origin_y)
        break
    if selected_boxes is None or selected_positions is None or selected_origin is None:
        code = "COLLISION_GROUP_NO_PLACEMENT" if group else "TEXT_CANNOT_FIT"
        raise GeneratorError(40, code, "rendering", f"{spec.local_key}: no valid placement candidate", field=spec.local_key)

    for line_x, line_y, line in selected_positions:
        draw.text((line_x, line_y), line, font=font, fill=(0, 0, 0), anchor="lt")
    actual_bbox = [
        min(box[0] for box in selected_boxes),
        min(box[1] for box in selected_boxes),
        max(box[2] for box in selected_boxes),
        max(box[3] for box in selected_boxes),
    ]
    if not _box_inside(actual_bbox, boundary):
        raise GeneratorError(40, "TEXT_OUTSIDE_BOUNDARY", "quality_validation", f"{spec.local_key}: rendered glyphs escaped boundary", field=spec.local_key)
    if not _box_inside(actual_bbox, container):
        raise GeneratorError(40, "TEXT_OUTSIDE_CONTAINER", "quality_validation", f"{spec.local_key}: rendered glyphs escaped container", field=spec.local_key)
    rendered_value = "\n".join(lines)
    return {
        "local_key": spec.local_key,
        "canonical_key": spec.canonical_key,
        "semantic_type": spec.semantic_type,
        "presence": spec.presence,
        "cmr_box": spec.box,
        "source_value": value,
        "value": rendered_value,
        "source_key": source_key,
        "provenance": provenance,
        "boundary_bbox": list(boundary),
        "reference_bbox": list(reference),
        "container_bbox": list(container),
        "text_bbox": actual_bbox,
        "line_boxes": selected_boxes,
        "lines": list(lines),
        "font_path": _resolve_font_path(spec.bold),
        "font_size_px": font.size,
        "min_font_size_px": max(1, int(round(spec.min_font_size * scale))),
        "legibility_min_px": max(1, int(round(int(effective["legibility_min_px_at_base_dpi"]) * scale))),
        "max_chars": spec.max_chars,
        "max_lines": spec.max_lines,
        "placement_seed": seed,
        "placement_profile": placement_profile,
        "placement_origin": list(selected_origin),
        "anchor": effective["anchor"],
        "collision_group": group,
    }


def analyze_quality(
    base_image: Image.Image,
    rendered_image: Image.Image,
    annotations: list[dict[str, Any]],
    *,
    debug_overlay: Path | None = None,
) -> dict[str, Any]:
    field_reports: list[dict[str, Any]] = []
    collisions: list[dict[str, Any]] = []
    for index, item in enumerate(annotations):
        boundary = item["boundary_bbox"]
        container = item["container_bbox"]
        text = item["text_bbox"]
        boundary_margins = [text[0] - boundary[0], text[1] - boundary[1], boundary[2] - text[2], boundary[3] - text[3]]
        container_margins = [text[0] - container[0], text[1] - container[1], container[2] - text[2], container[3] - text[3]]
        field_reports.append({
            "local_key": item["local_key"],
            "inside_boundary": min(boundary_margins) >= 0,
            "inside_container": min(container_margins) >= 0,
            "minimum_boundary_margin_px": min(boundary_margins),
            "minimum_container_margin_px": min(container_margins),
            "at_minimum_font_size": item["font_size_px"] <= item["min_font_size_px"],
            "below_legibility_threshold": item["font_size_px"] < item["legibility_min_px"],
        })
        for other in annotations[index + 1:]:
            area = _bbox_overlap(text, other["text_bbox"])
            if area > 0:
                collisions.append({"a": item["local_key"], "b": other["local_key"], "overlap_px": area})

    border_intersections = 0
    border_fields: list[str] = []
    if np is not None and BORDER_DETECTION_MODE != "disabled":
        scale = rendered_image.width / BASE_SIZE[0]
        proximity = max(1, int(round(BORDER_PROXIMITY_PX_AT_BASE_DPI * scale)))
        width, height = rendered_image.size
        for item in annotations:
            x0, y0, x1, y1 = item["boundary_bbox"]
            x0, x1 = max(0, x0), min(width, x1)
            y0, y1 = max(0, y0), min(height, y1)
            if x1 <= x0 or y1 <= y0:
                continue
            base_crop = np.asarray(base_image.crop((x0, y0, x1, y1)).convert("RGB"), dtype=np.int16)
            rendered_crop = np.asarray(rendered_image.crop((x0, y0, x1, y1)).convert("RGB"), dtype=np.int16)
            changed = np.max(np.abs(rendered_crop - base_crop), axis=2) > 25
            generated_ink = changed & (rendered_crop.mean(axis=2) < 180)
            dark_base = base_crop.mean(axis=2) < DARK_INK_THRESHOLD
            ring = np.zeros(dark_base.shape, dtype=bool)
            p = min(proximity, max(1, min(ring.shape) // 2))
            ring[:p, :] = True
            ring[-p:, :] = True
            ring[:, :p] = True
            ring[:, -p:] = True
            overlap = ring & dark_base & generated_ink
            count = int(overlap.sum())
            if count:
                border_intersections += count
                border_fields.append(item["local_key"])

    boundary_count = sum(not item["inside_boundary"] for item in field_reports)
    container_count = sum(not item["inside_container"] for item in field_reports)
    below_legibility = [item["local_key"] for item in field_reports if item["below_legibility_threshold"]]
    result = {
        "valid": boundary_count == 0 and container_count == 0 and not collisions and border_intersections == 0 and not below_legibility,
        "boundary_violation_count": boundary_count,
        "container_violation_count": container_count,
        "text_collision_count": len(collisions),
        "border_intersection_count": border_intersections,
        "fields_touching_borders": sorted(set(border_fields)),
        "fields_at_minimum_font_size": [item["local_key"] for item in field_reports if item["at_minimum_font_size"]],
        "fields_below_legibility_threshold": below_legibility,
        "field_reports": field_reports,
        "text_collisions": collisions,
    }
    if debug_overlay is not None:
        overlay = rendered_image.copy()
        draw = ImageDraw.Draw(overlay)
        risky = set(border_fields) | set(below_legibility)
        for item in annotations:
            draw.rectangle(item["container_bbox"], outline=(255, 140, 0), width=2)
            draw.rectangle(item["boundary_bbox"], outline=(0, 90, 255), width=2)
            draw.rectangle(item["text_bbox"], outline=(255, 0, 0) if item["local_key"] in risky else (0, 170, 70), width=2)
            draw.text((item["boundary_bbox"][0] + 2, item["boundary_bbox"][1] + 2), item["local_key"], fill=(180, 0, 180), font=_font(max(9, round(10 * rendered_image.width / BASE_SIZE[0])), True))
        debug_overlay.parent.mkdir(parents=True, exist_ok=True)
        overlay.save(debug_overlay)
    return result


def _manual_static_text(image_size: tuple[int, int]) -> list[dict[str, Any]]:
    width, height = image_size
    sx, sy = width / BASE_SIZE[0], height / BASE_SIZE[1]
    items: list[dict[str, Any]] = []
    for index, item in enumerate(STATIC_TEXT_CATALOG):
        items.append({
            "text": item.text,
            "bbox_px": [float(value) for value in _scale_box(item.bbox, sx, sy)],
            "source": "manual_static",
            "angle": item.angle,
            "static_id": f"static_{index:04d}",
        })
    return items


def _extract_static_text(source_pdf: Path, image_size: tuple[int, int], dpi: int) -> list[dict[str, Any]]:
    """Return only manually verified scan text. Never inspect PDF text layers."""
    del source_pdf, dpi
    return _manual_static_text(image_size)


def _extract_raster_text(source_pdf: Path, image_size: tuple[int, int]) -> list[dict[str, Any]]:
    del source_pdf, image_size
    return []


def _layout_payload(image_size: tuple[int, int]) -> list[dict[str, Any]]:
    width, height = image_size
    sx, sy = width / BASE_SIZE[0], height / BASE_SIZE[1]
    payload: list[dict[str, Any]] = []
    for table in TABLE_CATALOG:
        payload.append({"type": "table", "bbox": _to_1000(_scale_box(table.bbox, sx, sy), width, height), "angle": 0})
    for bbox, angle in TOP_LEVEL_TEXT_REGIONS:
        payload.append({"type": "text", "bbox": _to_1000(_scale_box(tuple(bbox), sx, sy), width, height), "angle": int(angle)})
    for bbox, angle in SEMANTIC_IMAGE_REGIONS:
        payload.append({"type": "image", "bbox": _to_1000(_scale_box(tuple(bbox), sx, sy), width, height), "angle": int(angle)})
    payload.sort(key=_normalized_sort_key)
    return payload


def _validate_layout_payload(payload: Any) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    if not isinstance(payload, list):
        return [_error("LAYOUT_SCHEMA_INVALID", "layout_validation", "layout.json must be a JSON array", artifact="labels/layout.json")]
    previous: tuple[Any, ...] | None = None
    table_count = 0
    for item in payload:
        if not isinstance(item, dict) or set(item) != {"type", "bbox", "angle"}:
            errors.append(_error("LAYOUT_SCHEMA_INVALID", "layout_validation", "Every layout item must contain exactly type, bbox, and angle", artifact="labels/layout.json"))
            continue
        if item["type"] not in {"table", "text", "image"} or item["angle"] not in {0, 90, 180, 270}:
            errors.append(_error("LAYOUT_VALUE_INVALID", "layout_validation", "Invalid layout type or angle", artifact="labels/layout.json"))
        box = item["bbox"]
        if not isinstance(box, list) or len(box) != 4 or not all(isinstance(value, int) for value in box) or not (0 <= box[0] < box[2] <= 1000 and 0 <= box[1] < box[3] <= 1000):
            errors.append(_error("INVALID_BBOX", "layout_validation", "Invalid normalized layout bbox", artifact="labels/layout.json"))
            continue
        key = _normalized_sort_key(item)
        if previous is not None and key < previous:
            errors.append(_error("LAYOUT_SORT_INVALID", "layout_validation", "Layout items are not in required visual order", artifact="labels/layout.json"))
        previous = key
        table_count += item["type"] == "table"
    if table_count != len(TABLE_CATALOG):
        errors.append(_error("LAYOUT_TABLE_COUNT", "layout_validation", f"Expected {len(TABLE_CATALOG)} table items, found {table_count}", artifact="labels/layout.json"))
    return errors


def _validate_key_information(payload: Any) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    if not isinstance(payload, list):
        return [_error("KEY_INFORMATION_SCHEMA", "key_information_validation", "key_information.json must be a JSON array", artifact="labels/key_information.json")]
    known = _field_spec_map()
    previous: tuple[Any, ...] | None = None
    for item in payload:
        if not isinstance(item, dict) or set(item) != {"key", "canonical_key", "value", "location"}:
            errors.append(_error("KEY_INFORMATION_SCHEMA", "key_information_validation", "Invalid key-information item schema", artifact="labels/key_information.json"))
            continue
        key = item["key"]
        if key not in known:
            errors.append(_error("KEY_INFORMATION_UNKNOWN_KEY", "key_information_validation", f"Unknown local key {key}", artifact="labels/key_information.json", field=key))
        elif item["canonical_key"] != known[key].canonical_key:
            errors.append(_error("CANONICAL_KEY_MISMATCH", "key_information_validation", f"Wrong canonical key for {key}", artifact="labels/key_information.json", field=key))
        if not isinstance(item["value"], str) or not item["value"]:
            errors.append(_error("KEY_INFORMATION_EMPTY_VALUE", "key_information_validation", f"Empty value for {key}", artifact="labels/key_information.json", field=key))
        box = item["location"]
        if not isinstance(box, list) or len(box) != 4 or not all(isinstance(value, int) for value in box) or not (0 <= box[0] < box[2] <= 1000 and 0 <= box[1] < box[3] <= 1000):
            errors.append(_error("INVALID_BBOX", "key_information_validation", f"Invalid location for {key}", artifact="labels/key_information.json", field=key))
            continue
        order = (box[1], box[0], key, item["canonical_key"])
        if previous is not None and order < previous:
            errors.append(_error("KEY_INFORMATION_SORT_INVALID", "key_information_validation", "Key-information items are not sorted", artifact="labels/key_information.json"))
        previous = order
    return errors


def _build_otsl(
    table: TableSpec,
    cells: Sequence[CellSpec],
    all_text: Sequence[dict[str, Any]],
    sx: float,
    sy: float,
) -> str:
    """Serialize the logical grid while preserving empty merged-cell anchors."""
    grid: list[list[str | None]] = [[None for _ in range(table.columns)] for _ in range(table.rows)]
    for cell in cells:
        bbox = _scale_box(cell.bbox, sx, sy)
        text = _text_for_cell(all_text, bbox)
        merged = cell.row_span > 1 or cell.column_span > 1
        for row in range(cell.row, cell.row + cell.row_span):
            for column in range(cell.column, cell.column + cell.column_span):
                if grid[row][column] is not None:
                    raise ValueError(f"{table.table_id}: overlapping OTSL cells at {row},{column}")
                if row == cell.row and column == cell.column:
                    if text:
                        grid[row][column] = "<fcel>" + text
                    else:
                        grid[row][column] = "<fcel>" if merged else "<ecel>"
                elif row == cell.row:
                    grid[row][column] = "<lcel>"
                elif column == cell.column:
                    grid[row][column] = "<ucel>"
                else:
                    grid[row][column] = "<xcel>"
    missing = [(row, column) for row in range(table.rows) for column in range(table.columns) if grid[row][column] is None]
    if missing:
        raise ValueError(f"{table.table_id}: uncovered OTSL positions {missing[:10]}")
    return "".join("".join(value or "<ecel>" for value in row) + "<nl>" for row in grid)


def validate_otsl(otsl: str) -> dict[str, Any]:
    if not isinstance(otsl, str) or not otsl.strip():
        raise ValueError("OTSL must be nonempty")
    if otsl.lstrip().startswith(("{", "[", "<html", "<!DOCTYPE")):
        raise ValueError("OTSL must not contain JSON or HTML wrappers")
    if not otsl.endswith("<nl>"):
        raise ValueError("OTSL must end with <nl>")
    unknown = [token for token in re.findall(r"<[^>]+>", otsl) if token not in OTSL_TOKENS]
    if unknown:
        raise ValueError(f"Unsupported OTSL tokens: {unknown[:10]}")
    if re.search(r"\[[0-9]+\s*,\s*[0-9]+\s*,", otsl):
        raise ValueError("OTSL must not contain bbox data")
    raw_rows = otsl[:-4].split("<nl>")
    if not raw_rows or any(row == "" for row in raw_rows):
        raise ValueError("OTSL contains an empty logical row")
    token_pattern = re.compile(r"<fcel>|<ecel>|<lcel>|<ucel>|<xcel>")
    rows: list[list[str]] = []
    for raw in raw_rows:
        matches = list(token_pattern.finditer(raw))
        if not matches or matches[0].start() != 0:
            raise ValueError("Every OTSL cell must begin with a supported token")
        rows.append([match.group(0) for match in matches])
    width = len(rows[0])
    if width == 0 or any(len(row) != width for row in rows):
        raise ValueError("OTSL expanded row widths differ")
    for row_index, row in enumerate(rows):
        for column_index, token in enumerate(row):
            if token == "<lcel>":
                if column_index == 0 or row[column_index - 1] == "<ecel>":
                    raise ValueError("Invalid <lcel> continuation")
            elif token == "<ucel>":
                if row_index == 0 or rows[row_index - 1][column_index] == "<ecel>":
                    raise ValueError("Invalid <ucel> continuation")
            elif token == "<xcel>":
                if row_index == 0 or column_index == 0:
                    raise ValueError("Invalid <xcel> continuation")
                if row[column_index - 1] == "<ecel>" or rows[row_index - 1][column_index] == "<ecel>":
                    raise ValueError("Invalid <xcel> anchor context")
    return {"valid": True, "rows": len(rows), "columns": width, "token_count": sum(len(row) for row in rows)}


def _validate_table_text_payload(payload: Any, table_index: int) -> list[dict[str, Any]]:
    artifact = f"labels/tables/table_{table_index:03d}.text_bbox.json"
    errors: list[dict[str, Any]] = []
    if not isinstance(payload, list):
        return [_error("TABLE_TEXT_BBOX_SCHEMA", "table_text_bbox_validation", "Table text-bbox output must be an array", artifact=artifact)]
    table_box = _to_1000(TABLE_CATALOG[table_index].bbox, BASE_SIZE[0], BASE_SIZE[1])
    previous: tuple[Any, ...] | None = None
    seen: set[tuple[str, tuple[int, int, int, int]]] = set()
    for item in payload:
        if not isinstance(item, dict) or set(item) != {"text", "bbox"}:
            errors.append(_error("TABLE_TEXT_BBOX_SCHEMA", "table_text_bbox_validation", "Invalid table text-bbox item schema", artifact=artifact))
            continue
        text = item["text"]
        box = item["bbox"]
        if not isinstance(text, str) or not text.strip():
            errors.append(_error("TABLE_TEXT_BBOX_EMPTY", "table_text_bbox_validation", "Table text-bbox item has empty text", artifact=artifact))
        if not isinstance(box, list) or len(box) != 4 or not all(isinstance(value, int) for value in box) or not (0 <= box[0] < box[2] <= 1000 and 0 <= box[1] < box[3] <= 1000):
            errors.append(_error("INVALID_BBOX", "table_text_bbox_validation", "Invalid table text bbox", artifact=artifact))
            continue
        if not _box_inside(box, table_box):
            errors.append(_error("TABLE_TEXT_BBOX_OUTSIDE_TABLE", "table_text_bbox_validation", "Table text bbox lies outside its table", artifact=artifact))
        identity = (text, tuple(box))
        if identity in seen:
            errors.append(_error("TABLE_TEXT_BBOX_DUPLICATE", "table_text_bbox_validation", "Duplicate table text line", artifact=artifact))
        seen.add(identity)
        order = (box[1], box[0], box[3], box[2], text)
        if previous is not None and order < previous:
            errors.append(_error("TABLE_TEXT_BBOX_SORT_INVALID", "table_text_bbox_validation", "Table text items are not sorted", artifact=artifact))
        previous = order
    return errors


def _draw_master_overlay(source_pdf: Path, output: Path, dpi: int = BASE_DPI) -> None:
    image = _render_pdf_page(source_pdf, dpi).convert("RGB")
    sx, sy = image.width / BASE_SIZE[0], image.height / BASE_SIZE[1]
    draw = ImageDraw.Draw(image)
    label_font = _font(max(10, round(11 * image.width / BASE_SIZE[0])), True)
    for table in TABLE_CATALOG:
        box = _scale_box(table.bbox, sx, sy)
        draw.rectangle(box, outline=(0, 100, 255), width=4)
        draw.text((box[0] + 3, box[1] + 3), f"table:{table.table_id}", fill=(0, 70, 220), font=label_font)
    cells_by_table = make_table_cells()
    for table in TABLE_CATALOG:
        for cell in cells_by_table.get(table.table_id, ()):
            box = _scale_box(cell.bbox, sx, sy)
            draw.rectangle(box, outline=(255, 120, 0), width=2)
            draw.text((box[0] + 2, box[1] + 2), cell.cell_id, fill=(180, 70, 0), font=label_font)
    for spec in FIELD_CATALOG:
        effective = _effective_field(spec)
        boundary = _scale_box(tuple(effective["boundary_bbox"]), sx, sy)
        container = _scale_box(tuple(effective["container_bbox"]), sx, sy)
        draw.rectangle(container, outline=(120, 120, 120), width=1)
        draw.rectangle(boundary, outline=(220, 0, 180), width=2)
        draw.text((boundary[0] + 2, boundary[1] + 2), spec.local_key, fill=(170, 0, 140), font=label_font)
    for erase in ERASE_SPECS:
        box = _scale_box(erase.bbox, sx, sy)
        draw.rectangle(box, outline=(220, 0, 0), width=2)
    for bbox, angle in TOP_LEVEL_TEXT_REGIONS:
        box = _scale_box(tuple(bbox), sx, sy)
        draw.rectangle(box, outline=(0, 170, 170), width=3)
        draw.text((box[0] + 2, box[1] + 2), f"text:{angle}", fill=(0, 120, 120), font=label_font)
    for bbox, angle in SEMANTIC_IMAGE_REGIONS:
        box = _scale_box(tuple(bbox), sx, sy)
        draw.rectangle(box, outline=(0, 160, 0), width=3)
        draw.text((box[0] + 2, box[1] + 2), f"image:{angle}", fill=(0, 120, 0), font=label_font)
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output)


def _draw_layout_overlay(document: Image.Image, layout: Sequence[Mapping[str, Any]], output: Path) -> None:
    overlay = document.copy().convert("RGB")
    draw = ImageDraw.Draw(overlay)
    font = _font(max(10, round(12 * document.width / BASE_SIZE[0])), True)
    colors = {"table": (0, 100, 255), "text": (0, 170, 170), "image": (0, 160, 0)}
    for index, item in enumerate(layout):
        box = item["bbox"]
        px = [round(box[0] * document.width / 1000), round(box[1] * document.height / 1000), round(box[2] * document.width / 1000), round(box[3] * document.height / 1000)]
        color = colors[item["type"]]
        draw.rectangle(px, outline=color, width=4)
        draw.text((px[0] + 3, px[1] + 3), f"{item['type']}:{index}", fill=color, font=font)
    output.parent.mkdir(parents=True, exist_ok=True)
    overlay.save(output)


def _make_report(
    status_code: int,
    stage: str | None,
    message: str,
    checks: Mapping[str, bool],
    metrics: Mapping[str, Any],
    errors: Sequence[Mapping[str, Any]] = (),
    warnings: Sequence[Any] = (),
    outputs: Mapping[str, str] | None = None,
    *,
    scope: str = "sample_generation",
) -> dict[str, Any]:
    return {
        "scope": scope,
        "status_code": status_code,
        "status": STATUS_CODES[status_code],
        "failed_stage": stage,
        "generator_id": GENERATOR_ID,
        "checks": dict(checks),
        "metrics": dict(metrics),
        "errors": [dict(item) for item in errors],
        "warnings": list(warnings),
        "outputs": dict(outputs or {}),
        "message": message,
    }


def _render_document_impl(
    source_pdf: str | Path,
    record: Mapping[str, Any],
    output_dir: Path,
    *,
    output_pdf: bool,
    input_mode: Literal["canonical", "local"],
    key_map: Mapping[str, str] | None,
    allow_synthesis: bool,
    require_required: bool,
    dpi: int,
    seed: int,
    scenario: str,
    placement_profile: str,
    debug_dir: Path | None = None,
) -> dict[str, Any]:
    source_pdf = Path(source_pdf)
    if not source_pdf.is_file():
        raise GeneratorError(10, "INPUT_NOT_FOUND", "input_validation", f"Source PDF not found: {source_pdf}")
    if dpi < 72 or dpi > 600:
        raise GeneratorError(10, "DPI_OUT_OF_RANGE", "input_validation", "dpi must be between 72 and 600")
    if placement_profile not in ALLOWED_PLACEMENT_PROFILES:
        raise GeneratorError(10, "INVALID_PLACEMENT_PROFILE", "input_validation", f"Unknown placement_profile={placement_profile}")
    try:
        with fitz.open(source_pdf) as document:
            if SOURCE_PAGE_INDEX < 0 or SOURCE_PAGE_INDEX >= document.page_count:
                raise GeneratorError(10, "PAGE_INDEX_OUT_OF_RANGE", "input_validation", f"SOURCE_PAGE_INDEX={SOURCE_PAGE_INDEX}, page_count={document.page_count}")
    except GeneratorError:
        raise
    except Exception as exc:
        raise GeneratorError(10, "INVALID_PDF", "input_validation", f"Cannot open source PDF: {exc}") from exc

    validation = validate_record(
        record,
        input_mode=input_mode,
        key_map=key_map,
        allow_synthesis=allow_synthesis,
        require_required=require_required,
        seed=seed,
        scenario=scenario,
    )
    if not validation["valid"]:
        message = "; ".join(validation["errors"])
        code = "MAX_CHARS_EXCEEDED" if "max_chars" in message else "INVALID_RECORD"
        field = None
        match = re.search(r"([A-Za-z0-9_.]+):", message)
        if match:
            field = match.group(1)
        raise GeneratorError(10, code, "input_validation", message, field=field)

    output_dir.mkdir(parents=True, exist_ok=True)
    labels_dir = output_dir / "labels"
    tables_dir = labels_dir / "tables"
    tables_dir.mkdir(parents=True, exist_ok=True)
    document_png = output_dir / "document.png"

    base = _prepare_background(source_pdf, dpi).convert("RGB")
    image = base.copy()
    sx, sy = image.width / BASE_SIZE[0], image.height / BASE_SIZE[1]
    resolution_by_local = {item["local_key"]: item for item in validation["fields"]}
    annotations: list[dict[str, Any]] = []
    for spec in FIELD_CATALOG:
        if spec.local_key not in validation["local_record"]:
            continue
        value = str(validation["local_record"][spec.local_key])
        if not value:
            continue
        resolved = resolution_by_local[spec.local_key]
        annotations.append(_draw_field(
            image,
            spec,
            value,
            seed=seed,
            sx=sx,
            sy=sy,
            placement_profile=placement_profile,
            source_key=resolved["source_key"],
            provenance=resolved["status"],
            occupied=annotations,
        ))

    image.save(document_png)
    if output_pdf:
        _save_pdf_from_image(document_png, output_dir / "document.pdf", dpi)

    field_overlay = debug_dir / "field_glyph_overlay.png" if debug_dir else None
    quality = analyze_quality(base, image, annotations, debug_overlay=field_overlay)
    static_text = _manual_static_text(image.size)
    generated_text = _generated_text_lines(annotations)
    all_text = _deduplicate_text_items(static_text + generated_text)

    layout = _layout_payload(image.size)
    layout_errors = _validate_layout_payload(layout)
    _write_json(labels_dir / "layout.json", layout)

    key_information = [
        {
            "key": item["local_key"],
            "canonical_key": item["canonical_key"],
            "value": item["value"],
            "location": _to_1000(item["text_bbox"], image.width, image.height),
        }
        for item in annotations
        if item["value"]
    ]
    key_information.sort(key=lambda item: (item["location"][1], item["location"][0], item["key"], item["canonical_key"]))
    key_errors = _validate_key_information(key_information)
    _write_json(labels_dir / "key_information.json", key_information)

    cells_by_table = make_table_cells()
    otsl_errors: list[dict[str, Any]] = []
    table_text_errors: list[dict[str, Any]] = []
    table_text_counts: list[int] = []
    for index, table in enumerate(TABLE_CATALOG):
        table_box_px = _scale_box(table.bbox, sx, sy)
        inside = [item for item in all_text if _box_inside(item["bbox_px"], table_box_px)]
        inside.sort(key=lambda item: (item["bbox_px"][1], item["bbox_px"][0], item["bbox_px"][3], item["bbox_px"][2], item["text"]))
        text_payload = [
            {"text": item["text"], "bbox": _to_1000(item["bbox_px"], image.width, image.height)}
            for item in inside
            if str(item["text"]).strip()
        ]
        text_payload.sort(key=lambda item: (item["bbox"][1], item["bbox"][0], item["bbox"][3], item["bbox"][2], item["text"]))
        text_path = tables_dir / f"table_{index:03d}.text_bbox.json"
        _write_json(text_path, text_payload)
        table_text_counts.append(len(text_payload))
        table_text_errors.extend(_validate_table_text_payload(text_payload, index))

        otsl_path = tables_dir / f"table_{index:03d}.otsl.txt"
        try:
            otsl = _build_otsl(table, cells_by_table[table.table_id], all_text, sx, sy)
            validate_otsl(otsl)
            otsl_path.write_text(otsl, encoding="utf-8")
        except Exception as exc:
            otsl_errors.append(_error("OTSL_INVALID", "table_otsl_validation", str(exc), artifact=f"labels/tables/table_{index:03d}.otsl.txt"))

    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        _draw_layout_overlay(image, layout, debug_dir / "layout_overlay.png")
        _write_json(debug_dir / "render_metadata.json", annotations)

    checks = {
        "input_validation": True,
        "rendering": True,
        "layout_generation": (labels_dir / "layout.json").is_file(),
        "layout_validation": not layout_errors,
        "table_otsl_generation": all((tables_dir / f"table_{index:03d}.otsl.txt").is_file() for index in range(len(TABLE_CATALOG))),
        "table_otsl_validation": not otsl_errors,
        "table_text_bbox_generation": all((tables_dir / f"table_{index:03d}.text_bbox.json").is_file() for index in range(len(TABLE_CATALOG))),
        "table_text_bbox_validation": not table_text_errors,
        "key_information_generation": (labels_dir / "key_information.json").is_file(),
        "key_information_validation": not key_errors and len(key_information) == len(annotations),
        "boundary_validation": quality["boundary_violation_count"] == 0,
        "container_validation": quality["container_violation_count"] == 0,
        "collision_validation": quality["text_collision_count"] == 0,
        "border_intersection_validation": quality["border_intersection_count"] == 0,
    }
    annotation_errors = layout_errors + key_errors + otsl_errors + table_text_errors
    quality_errors: list[dict[str, Any]] = []
    for report in quality["field_reports"]:
        if not report["inside_boundary"]:
            quality_errors.append(_error("TEXT_OUTSIDE_BOUNDARY", "quality_validation", f"{report['local_key']} escaped its boundary", artifact="document.png", field=report["local_key"]))
        if not report["inside_container"]:
            quality_errors.append(_error("TEXT_OUTSIDE_CONTAINER", "quality_validation", f"{report['local_key']} escaped its container", artifact="document.png", field=report["local_key"]))
        if report["below_legibility_threshold"]:
            quality_errors.append(_error("FONT_BELOW_LEGIBILITY_THRESHOLD", "quality_validation", f"{report['local_key']} is below its configured legibility threshold", artifact="document.png", field=report["local_key"]))
    for collision in quality["text_collisions"]:
        quality_errors.append(_error("TEXT_COLLISION", "quality_validation", f"{collision['a']} overlaps {collision['b']}", artifact="document.png", field=collision["a"]))
    for field in quality["fields_touching_borders"]:
        quality_errors.append(_error("BORDER_INTERSECTION", "quality_validation", f"{field} intersects a detected form border", artifact="document.png", field=field))

    status_code = 50 if annotation_errors else (60 if quality_errors else 0)
    failed_stage = None if status_code == 0 else ("annotation_validation" if annotation_errors else "quality_validation")
    # Report output paths relative to the sample directory. Absolute paths
    # make otherwise identical renders appear nondeterministic and are not
    # portable across machines.
    outputs = {
        "document_png": "document.png",
        "layout": "labels/layout.json",
        "key_information": "labels/key_information.json",
        "tables_dir": "labels/tables",
    }
    if output_pdf:
        outputs["document_pdf"] = "document.pdf"
    metrics = {
        "rendered_fields": len(annotations),
        "omitted_optional_fields": sum(spec.presence == "optional" and spec.local_key not in validation["local_record"] for spec in FIELD_CATALOG),
        "table_count": len(TABLE_CATALOG),
        "otsl_files": sum((tables_dir / f"table_{index:03d}.otsl.txt").is_file() for index in range(len(TABLE_CATALOG))),
        "table_text_bbox_files": sum((tables_dir / f"table_{index:03d}.text_bbox.json").is_file() for index in range(len(TABLE_CATALOG))),
        "boundary_violations": quality["boundary_violation_count"],
        "container_violations": quality["container_violation_count"],
        "text_collisions": quality["text_collision_count"],
        "border_intersections": quality["border_intersection_count"],
    }
    warnings = [f"{field}: rendered at configured minimum font size" for field in quality["fields_at_minimum_font_size"]]
    report = _make_report(
        status_code,
        failed_stage,
        "All mandatory machine checks passed." if status_code == 0 else "One or more mandatory checks failed.",
        checks,
        metrics,
        errors=annotation_errors + quality_errors,
        warnings=warnings,
        outputs=outputs,
    )
    _write_json(output_dir / "report.json", report)
    return report


def render_document(
    source_pdf: str | Path,
    record: Mapping[str, Any],
    output_dir: str | Path,
    *,
    output_pdf: bool = False,
    input_mode: Literal["canonical", "local"] = "canonical",
    key_map: Mapping[str, str] | None = None,
    allow_synthesis: bool = False,
    require_required: bool = True,
    dpi: int = BASE_DPI,
    seed: int = 0,
    scenario: str = "synthetic",
    placement_profile: str = "natural",
) -> dict[str, Any]:
    output_path = Path(output_dir)
    try:
        if TEMPLATE_CONTENT_MODE == "scanned" and not STATIC_TEXT_CATALOG_COMPLETE:
            raise GeneratorError(
                50,
                "STATIC_TEXT_CATALOG_INCOMPLETE",
                "table_text_bbox_validation",
                "Scan-only rendering is locked until every readable static table-text line is visually cataloged and independently reviewed.",
            )
        return _render_document_impl(
            source_pdf,
            record,
            output_path,
            output_pdf=output_pdf,
            input_mode=input_mode,
            key_map=key_map,
            allow_synthesis=allow_synthesis,
            require_required=require_required,
            dpi=dpi,
            seed=seed,
            scenario=scenario,
            placement_profile=placement_profile,
            debug_dir=None,
        )
    except GeneratorError as exc:
        report = _make_report(exc.status_code, exc.stage, exc.message, {}, {}, errors=[exc.as_error()])
    except (SyntaxError, ImportError, ModuleNotFoundError) as exc:
        report = _make_report(20, "implementation", str(exc), {}, {}, errors=[_error("IMPLEMENTATION_ERROR", "implementation", str(exc))])
    except PermissionError as exc:
        report = _make_report(70, "persistent_output", str(exc), {}, {}, errors=[_error("PERSISTENT_OUTPUT_WRITE_FAILED", "persistent_output", str(exc))])
    except Exception as exc:
        report = _make_report(99, "unexpected", str(exc), {}, {}, errors=[_error("UNEXPECTED_ERROR", "unexpected", str(exc))])
    try:
        _write_json(output_path / "report.json", report)
    except Exception:
        pass
    return report


def validate_output_contract(output_dir: str | Path) -> dict[str, Any]:
    root = Path(output_dir)
    errors: list[dict[str, Any]] = []
    warnings: list[str] = []
    required = {
        "document.png",
        "labels/layout.json",
        "labels/key_information.json",
        "report.json",
    }
    for index in range(len(TABLE_CATALOG)):
        required.add(f"labels/tables/table_{index:03d}.otsl.txt")
        required.add(f"labels/tables/table_{index:03d}.text_bbox.json")
    for relative in sorted(required):
        if not (root / relative).is_file():
            errors.append(_error("MISSING_OUTPUT", "output_validation", f"Missing required file: {relative}", artifact=relative))

    allowed = set(required) | {"document.pdf"}
    if root.is_dir():
        actual = {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}
        forbidden = sorted(actual - allowed)
        for relative in forbidden:
            errors.append(_error("FORBIDDEN_OUTPUT", "output_validation", f"Unexpected production output: {relative}", artifact=relative))

    layout: Any = []
    key_information: Any = []
    report: Any = {}
    if (root / "labels/layout.json").is_file():
        try:
            layout = _json_load(root / "labels/layout.json")
            errors.extend(_validate_layout_payload(layout))
        except Exception as exc:
            errors.append(_error("INVALID_JSON", "layout_validation", str(exc), artifact="labels/layout.json"))
    if (root / "labels/key_information.json").is_file():
        try:
            key_information = _json_load(root / "labels/key_information.json")
            errors.extend(_validate_key_information(key_information))
        except Exception as exc:
            errors.append(_error("INVALID_JSON", "key_information_validation", str(exc), artifact="labels/key_information.json"))
    for index in range(len(TABLE_CATALOG)):
        otsl_path = root / f"labels/tables/table_{index:03d}.otsl.txt"
        if otsl_path.is_file():
            try:
                validate_otsl(otsl_path.read_text(encoding="utf-8"))
            except Exception as exc:
                errors.append(_error("OTSL_INVALID", "table_otsl_validation", str(exc), artifact=f"labels/tables/table_{index:03d}.otsl.txt"))
        text_path = root / f"labels/tables/table_{index:03d}.text_bbox.json"
        if text_path.is_file():
            try:
                errors.extend(_validate_table_text_payload(_json_load(text_path), index))
            except Exception as exc:
                errors.append(_error("INVALID_JSON", "table_text_bbox_validation", str(exc), artifact=f"labels/tables/table_{index:03d}.text_bbox.json"))
    if (root / "report.json").is_file():
        try:
            report = _json_load(root / "report.json")
            expected_top = {"scope", "status_code", "status", "failed_stage", "generator_id", "checks", "metrics", "errors", "warnings", "outputs", "message"}
            if not isinstance(report, dict) or set(report) != expected_top:
                errors.append(_error("REPORT_SCHEMA_INVALID", "output_validation", "report.json has an invalid top-level schema", artifact="report.json"))
            else:
                if report["scope"] != "sample_generation" or report["generator_id"] != GENERATOR_ID:
                    errors.append(_error("REPORT_IDENTITY_MISMATCH", "output_validation", "Wrong report scope or generator_id", artifact="report.json"))
                if report["status_code"] not in STATUS_CODES or report["status"] != STATUS_CODES.get(report["status_code"]):
                    errors.append(_error("STATUS_CODE_MISMATCH", "output_validation", "Report status does not match status code", artifact="report.json"))
                for check in REQUIRED_SAMPLE_CHECKS:
                    if check not in report["checks"] or not isinstance(report["checks"][check], bool):
                        errors.append(_error("REPORT_MISSING_CHECK", "output_validation", f"Missing or invalid check: {check}", artifact="report.json"))
                for metric in REQUIRED_SAMPLE_METRICS:
                    if metric not in report["metrics"]:
                        errors.append(_error("REPORT_MISSING_METRIC", "output_validation", f"Missing metric: {metric}", artifact="report.json"))
                for item in report["errors"]:
                    if not isinstance(item, dict) or set(item) != {"code", "stage", "message", "artifact", "field"}:
                        errors.append(_error("ERROR_SCHEMA_INVALID", "output_validation", "Report error has wrong schema", artifact="report.json"))
                        break
        except Exception as exc:
            errors.append(_error("INVALID_JSON", "output_validation", str(exc), artifact="report.json"))

    status_code = 0 if not errors else 50
    return {
        "scope": "sample_generation",
        "status_code": status_code,
        "status": STATUS_CODES[status_code],
        "failed_stage": None if not errors else "output_validation",
        "generator_id": GENERATOR_ID,
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
    }


def get_available_fields() -> list[dict[str, Any]]:
    return [_effective_field(spec) for spec in FIELD_CATALOG]


def get_generator_manifest() -> dict[str, Any]:
    fields = get_available_fields()
    grouped: dict[str, set[str]] = {"required": set(), "recommended": set(), "optional": set()}
    for field in fields:
        grouped[field["presence"]].add(field["canonical_key"])
    synthesizable = sorted({field["canonical_key"] for field in fields if field["missing_policy"] == "synthesize"})
    derived = sorted({field["canonical_key"] for field in fields if field["missing_policy"] == "derive"})
    cells_by_table = make_table_cells()
    tables = []
    for table in TABLE_CATALOG:
        tables.append({
            "table_id": table.table_id,
            "bbox": list(table.bbox),
            "rows": table.rows,
            "columns": table.columns,
            "cells": [asdict(cell) for cell in cells_by_table.get(table.table_id, ())],
        })
    mappings = {field["local_key"]: field["canonical_key"] for field in fields}
    manifest = {
        "contract_version": GENERATOR_CONTRACT_VERSION,
        "output_contract_version": OUTPUT_CONTRACT_VERSION,
        "canonical_schema_version": CANONICAL_SCHEMA_VERSION,
        "canonical_schema_digest": _schema_digest(),
        "generator_id": GENERATOR_ID,
        "document_type": DOCUMENT_TYPE,
        "template_version": TEMPLATE_VERSION,
        "page_index": SOURCE_PAGE_INDEX,
        "reference_page_size": list(BASE_SIZE),
        "reference_dpi": BASE_DPI,
        "supported_input_modes": ["canonical", "local"],
        "supported_output_formats": ["png", "pdf"],
        "pdf_support": {"supported": True, "default_enabled": False},
        "local_fields": fields,
        "local_to_canonical_mappings": mappings,
        "field_constraints": {field["local_key"]: {key: field[key] for key in ("boundary_bbox", "reference_bbox", "container_bbox", "max_chars", "max_lines", "font_size", "min_font_size", "font_family", "font_weight", "alignment", "placement_strategy", "anchor", "jitter_x", "jitter_y", "line_spacing", "padding", "collision_group", "allow_character_wrap")} for field in fields},
        "required_canonical_keys": sorted(grouped["required"]),
        "recommended_canonical_keys": sorted(grouped["recommended"]),
        "optional_canonical_keys": sorted(grouped["optional"]),
        "synthesizable_keys": synthesizable,
        "derived_keys": derived,
        "table_definitions": tables,
        "supported_annotation_formats": ["layout", "otsl", "table_text_bbox", "key_information"],
        "otsl_tokens": list(OTSL_TOKENS),
        "status_codes": {str(code): name for code, name in STATUS_CODES.items()},
        "public_api": list(PUBLIC_API),
        "scan_only": True,
        "uses_ocr": False,
        "uses_pdf_text_layer": False,
        "static_text_catalog_complete": STATIC_TEXT_CATALOG_COMPLETE,
        "requires_external_visual_review": True,
        "visual_review_schema_version": VISUAL_REVIEW_SCHEMA_VERSION,
    }
    return manifest


def self_test() -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    specs = list(FIELD_CATALOG)
    effective_by_key: dict[str, dict[str, Any]] = {}
    seen_local: set[str] = set()
    canonical_bindings: dict[str, list[str]] = defaultdict(list)

    required_functions = (
        "get_canonical_schema",
        "get_generator_manifest",
        "get_available_fields",
        "assess_compatibility",
        "propose_missing_values",
        "resolve_record",
        "validate_record",
        "render_document",
        "validate_output_contract",
        "generate_edge_cases",
        "self_test",
        "audit_generator",
    )
    module = sys.modules.get(__name__)
    for name in required_functions:
        if module is None or not callable(getattr(module, name, None)):
            errors.append(f"Missing public API function: {name}")

    for spec in specs:
        if spec.local_key in seen_local:
            errors.append(f"Duplicate local key: {spec.local_key}")
        seen_local.add(spec.local_key)
        canonical_bindings[spec.canonical_key].append(spec.local_key)
        schema = CANONICAL_SCHEMA.get(spec.canonical_key)
        if schema is None:
            errors.append(f"{spec.local_key}: unknown canonical key {spec.canonical_key}")
        elif schema.semantic_type != spec.semantic_type:
            errors.append(f"{spec.local_key}: semantic_type={spec.semantic_type}, expected {schema.semantic_type}")
        if spec.presence not in VALID_PRESENCE:
            errors.append(f"{spec.local_key}: invalid presence={spec.presence}")
        if spec.missing_policy not in VALID_MISSING_POLICIES:
            errors.append(f"{spec.local_key}: invalid missing_policy={spec.missing_policy}")
        if spec.item_strategy not in VALID_ITEM_STRATEGIES:
            errors.append(f"{spec.local_key}: invalid item_strategy={spec.item_strategy}")
        if "[]" in spec.canonical_key and spec.item_strategy is None:
            errors.append(f"{spec.local_key}: wildcard canonical key requires item_strategy")
        if spec.missing_policy == "derive" and (not spec.derivation or not spec.derived_from):
            errors.append(f"{spec.local_key}: derive policy requires derivation and derivation sources")
        for source in (*spec.source_candidates, *spec.derived_from):
            if source not in CANONICAL_SCHEMA:
                errors.append(f"{spec.local_key}: unknown source key {source}")
        try:
            effective = _effective_field(spec)
            effective_by_key[spec.local_key] = effective
        except GeneratorError as exc:
            errors.append(exc.message)
            continue
        for name in ("boundary_bbox", "reference_bbox", "container_bbox"):
            box = effective[name]
            if len(box) != 4 or not (0 <= box[0] < box[2] <= BASE_SIZE[0] and 0 <= box[1] < box[3] <= BASE_SIZE[1]):
                errors.append(f"{spec.local_key}: invalid {name}={box}")
        if not _box_inside(effective["boundary_bbox"], effective["container_bbox"]):
            errors.append(f"{spec.local_key}: boundary_bbox is outside container_bbox")
        if spec.max_chars < 1 or spec.max_lines < 1 or spec.min_font_size < 1 or spec.font_size < spec.min_font_size:
            errors.append(f"{spec.local_key}: invalid text constraints")
        if effective["anchor"] not in {"top_left", "top_right", "bottom_left", "bottom_right", "center"}:
            errors.append(f"{spec.local_key}: invalid anchor={effective['anchor']}")
        if effective["jitter_x"] < 0 or effective["jitter_y"] < 0 or effective["line_spacing"] < 1.0:
            errors.append(f"{spec.local_key}: invalid placement settings")
        if spec.presence == "required" and spec.missing_policy in {"omit", "blank"}:
            warnings.append(f"{spec.local_key}: required field uses missing_policy={spec.missing_policy}")

    for canonical_key, locals_ in canonical_bindings.items():
        if len(locals_) <= 1:
            continue
        declared = set(DECLARED_CANONICAL_ALIASES.get(canonical_key, ()))
        if set(locals_) != declared:
            errors.append(f"Undeclared duplicate canonical binding {canonical_key}: {sorted(locals_)}")

    if TEMPLATE_CONTENT_MODE != "scanned" or STATIC_TEXT_MODE != "manual":
        errors.append("Scan-only workflow requires TEMPLATE_CONTENT_MODE='scanned' and STATIC_TEXT_MODE='manual'")
    if RASTER_TEXT_XREFS:
        warnings.append("RASTER_TEXT_XREFS is ignored for scan-only templates")
    if not STATIC_TEXT_CATALOG_COMPLETE:
        errors.append("STATIC_TEXT_CATALOG_COMPLETE is False; visual static-text coverage is not locked")
    if STATIC_TEXT_CATALOG_COMPLETE and not STATIC_TEXT_CATALOG:
        errors.append("Static-text catalog is marked complete but contains no lines")
    for item in STATIC_TEXT_CATALOG:
        if not item.text.strip():
            errors.append("STATIC_TEXT_CATALOG contains an empty text line")
        if not (0 <= item.bbox[0] < item.bbox[2] <= BASE_SIZE[0] and 0 <= item.bbox[1] < item.bbox[3] <= BASE_SIZE[1]):
            errors.append(f"Static text bbox outside reference page: {item.bbox}")
        if item.angle not in {0, 90, 180, 270}:
            errors.append(f"Invalid static text angle: {item.angle}")

    table_ids = [table.table_id for table in TABLE_CATALOG]
    if len(table_ids) != len(set(table_ids)):
        errors.append("Duplicate table_id")
    cells_by_table = make_table_cells()
    for table in TABLE_CATALOG:
        if not (0 <= table.bbox[0] < table.bbox[2] <= BASE_SIZE[0] and 0 <= table.bbox[1] < table.bbox[3] <= BASE_SIZE[1]):
            errors.append(f"{table.table_id}: invalid table bbox")
        cells = cells_by_table.get(table.table_id)
        if not cells:
            errors.append(f"{table.table_id}: missing cell definitions")
            continue
        occupied: set[tuple[int, int]] = set()
        cell_ids: set[str] = set()
        for cell in cells:
            if cell.cell_id in cell_ids:
                errors.append(f"{table.table_id}: duplicate cell_id={cell.cell_id}")
            cell_ids.add(cell.cell_id)
            if cell.row_span < 1 or cell.column_span < 1:
                errors.append(f"{table.table_id}/{cell.cell_id}: invalid span")
            if cell.row < 0 or cell.column < 0 or cell.row + cell.row_span > table.rows or cell.column + cell.column_span > table.columns:
                errors.append(f"{table.table_id}/{cell.cell_id}: outside logical grid")
            if not _box_inside(cell.bbox, table.bbox):
                errors.append(f"{table.table_id}/{cell.cell_id}: bbox outside table")
            for row in range(cell.row, cell.row + cell.row_span):
                for column in range(cell.column, cell.column + cell.column_span):
                    if (row, column) in occupied:
                        errors.append(f"{table.table_id}: overlapping cell at {row},{column}")
                    occupied.add((row, column))
        if len(occupied) != table.rows * table.columns:
            errors.append(f"{table.table_id}: incomplete logical grid")

    for bbox, angle in (*TOP_LEVEL_TEXT_REGIONS, *SEMANTIC_IMAGE_REGIONS):
        if not (0 <= bbox[0] < bbox[2] <= BASE_SIZE[0] and 0 <= bbox[1] < bbox[3] <= BASE_SIZE[1]):
            errors.append(f"Invalid top-level layout bbox: {bbox}")
        if angle not in {0, 90, 180, 270}:
            errors.append(f"Invalid top-level layout angle: {angle}")
        if any(_boxes_intersect(bbox, table.bbox) for table in TABLE_CATALOG):
            errors.append(f"Top-level layout region overlaps a table: {bbox}")

    for erase in ERASE_SPECS:
        if not (0 <= erase.bbox[0] < erase.bbox[2] <= BASE_SIZE[0] and 0 <= erase.bbox[1] < erase.bbox[3] <= BASE_SIZE[1]):
            errors.append(f"Invalid erase bbox: {erase.bbox}")
        if erase.method == "clone" and erase.source_bbox is None:
            errors.append(f"Clone erase requires source_bbox: {erase.bbox}")

    try:
        manifest = get_generator_manifest()
        required_manifest = {
            "contract_version", "output_contract_version", "canonical_schema_version", "canonical_schema_digest",
            "generator_id", "document_type", "template_version", "page_index", "reference_page_size",
            "reference_dpi", "supported_input_modes", "supported_output_formats", "pdf_support", "local_fields",
            "local_to_canonical_mappings", "field_constraints", "required_canonical_keys", "recommended_canonical_keys",
            "optional_canonical_keys", "synthesizable_keys", "derived_keys", "table_definitions",
            "supported_annotation_formats", "otsl_tokens", "status_codes",
        }
        missing_manifest = required_manifest - set(manifest)
        if missing_manifest:
            errors.append(f"Manifest missing fields: {sorted(missing_manifest)}")
        first = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        second = json.dumps(get_generator_manifest(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if first != second:
            errors.append("Manifest serialization is nondeterministic")
        compatibility = assess_compatibility(_canonical_weird_record())
        if not compatibility.get("compatible"):
            errors.append("Canonical fully populated record is unexpectedly incompatible")
        proposal_a = propose_missing_values({}, seed=17, scenario="self_test")
        proposal_b = propose_missing_values({}, seed=17, scenario="self_test")
        if proposal_a != proposal_b:
            errors.append("Missing-value proposals are nondeterministic")
    except Exception as exc:
        errors.append(f"Structural smoke test failed: {exc}")

    for font_path in (FONT_REGULAR, FONT_BOLD):
        if not Path(font_path).is_file():
            warnings.append(f"Configured font not found; fallback will be used: {font_path}")

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "field_count": len(FIELD_CATALOG),
        "table_count": len(TABLE_CATALOG),
    }


def _local_normal_record() -> dict[str, str]:
    values: dict[str, str] = {}
    examples = {
        "identifier": "REF-2026-1042",
        "code": "A12",
        "address": "14 Market Street, Test City",
        "country": "Germany",
        "date": "21.07.2026",
        "time": "14:30",
        "uri": "https://example.test",
        "integer": "12",
        "measurement": "1250 kg",
        "money": "1250.00",
        "currency": "EUR",
        "boolean": "true",
        "text": "Standard test value",
    }
    for spec in FIELD_CATALOG:
        if spec.presence == "optional" and int.from_bytes(hashlib.sha256(spec.local_key.encode()).digest()[:2], "big") % 3:
            continue
        base = examples[spec.semantic_type]
        if spec.semantic_type == "text":
            base = spec.local_key.replace(".", " ").title()
        values[spec.local_key] = base[:spec.max_chars]
    return values


def _canonical_from_local(local: Mapping[str, str]) -> dict[str, Any]:
    specs = _field_spec_map()
    result: dict[str, Any] = {}
    for local_key, value in local.items():
        canonical = specs[local_key].canonical_key
        # Flat dotted canonical records are intentionally supported. For aliases,
        # identical values are required; the template author must declare them.
        if canonical in result and result[canonical] != value:
            raise GeneratorError(30, "ALIAS_VALUE_CONFLICT", "schema_validation", f"Conflicting values for {canonical}")
        result[canonical] = value
    return result


def _candidate_pattern(profile: str) -> str:
    return {
        "wide": "W M Ж Ω ",
        "narrow": "i l 1 . , ",
        "unbroken": "ZX9_",
        "punctuation": "A/B-C:(D) 'E' €1.20; ",
        "multilingual": "Ångström Žluťoučký Ελληνικά Кириллица ",
        "dense": "dense multiline value ",
    }[profile]


def _largest_fitting_stress_value(spec: FieldSpec, profile: str) -> str:
    """Create a pressure value that remains valid for success-oriented cases."""
    pattern = _candidate_pattern(profile)
    canvas = Image.new("RGB", BASE_SIZE, "white")
    draw = ImageDraw.Draw(canvas)
    minimum_length = min(spec.max_chars, 2)
    for target in range(spec.max_chars, minimum_length - 1, -1):
        if profile == "dense" and spec.max_lines > 1:
            available = max(1, target - (spec.max_lines - 1))
            words = (pattern * ((available // len(pattern)) + 2))[:available].strip()
            chunks = []
            step = max(1, len(words) // spec.max_lines)
            for index in range(spec.max_lines):
                start = index * step
                stop = len(words) if index == spec.max_lines - 1 else (index + 1) * step
                chunks.append(words[start:stop].strip())
            value = "\n".join(chunk for chunk in chunks if chunk)[:spec.max_chars]
        else:
            value = (pattern * ((target // len(pattern)) + 2))[:target].rstrip()
        if not value:
            continue
        try:
            _assert_font_supports_text(spec, value)
            _fit_text(draw, spec, value, spec.bbox, 1.0)
            return value
        except Exception:
            continue
    # Fall back to one visible token; the caller will expose a real field-spec
    # defect if even this cannot fit.
    return pattern.strip()[:spec.max_chars]


def _edge_local_record(profile: str) -> dict[str, str]:
    record = make_weird_data().copy()
    stress_keys = set(EDGE_STRESS_KEYS)
    for spec in FIELD_CATALOG:
        if spec.local_key not in stress_keys:
            continue
        if profile in {"wide", "narrow", "punctuation", "multilingual"}:
            record[spec.local_key] = _largest_fitting_stress_value(spec, profile)
        elif profile == "unbroken":
            # This case intentionally probes explicit token policy.
            record[spec.local_key] = (_candidate_pattern(profile) * ((spec.max_chars // 4) + 2))[:spec.max_chars]
        elif profile == "dense" and spec.max_lines > 1:
            record[spec.local_key] = _largest_fitting_stress_value(spec, profile)
    return record


def _field_fit_coverage() -> tuple[list[str], list[dict[str, Any]], tuple[str, str] | None]:
    """Check off-by-one acceptance for all fields and find one exact-max render."""
    accepted: list[str] = []
    failures: list[dict[str, Any]] = []
    render_case: tuple[str, str] | None = None
    canvas = Image.new("RGB", BASE_SIZE, "white")
    draw = ImageDraw.Draw(canvas)
    for spec in FIELD_CATALOG:
        # Input acceptance is the universal max_chars contract. Use narrow text
        # so this check does not incorrectly redefine max_chars as a worst-case
        # glyph-width guarantee.
        value = ("1" * spec.max_chars)[:spec.max_chars]
        validation = validate_record({spec.local_key: value}, input_mode="local", require_required=False)
        if validation["valid"]:
            accepted.append(spec.local_key)
        else:
            failures.append(_error("MAX_CHARS_OFF_BY_ONE", "edge_case_validation", f"{spec.local_key}: exactly max_chars was rejected", field=spec.local_key))
        if render_case is None:
            candidates = [
                value,
                ("i" * spec.max_chars)[:spec.max_chars],
                ("1 " * spec.max_chars)[:spec.max_chars],
            ]
            for candidate in candidates:
                try:
                    _fit_text(draw, spec, candidate, spec.bbox, 1.0)
                    render_case = (spec.local_key, candidate)
                    break
                except Exception:
                    continue
    return accepted, failures, render_case


def _find_minimum_font_case() -> tuple[str, str] | None:
    canvas = Image.new("RGB", BASE_SIZE, "white")
    draw = ImageDraw.Draw(canvas)
    for spec in sorted(FIELD_CATALOG, key=lambda item: (item.font_size - item.min_font_size, -item.max_chars), reverse=True):
        for length in range(max(2, spec.max_chars // 4), spec.max_chars + 1):
            value = ("W " * length)[:length]
            try:
                font, _, _, _, _ = _fit_text(draw, spec, value, spec.bbox, 1.0)
            except Exception:
                continue
            if font.size == spec.min_font_size:
                return spec.local_key, value
    return None


def _render_edge_case(
    source_pdf: Path,
    case_root: Path,
    *,
    record: Mapping[str, Any],
    input_mode: Literal["canonical", "local"],
    placement: str,
    dpi: int,
    seed: int,
) -> dict[str, Any]:
    return _render_document_impl(
        source_pdf,
        record,
        case_root / "sample",
        output_pdf=False,
        input_mode=input_mode,
        key_map=None,
        allow_synthesis=False,
        require_required=False,
        dpi=dpi,
        seed=seed,
        scenario="edge_case",
        placement_profile=placement,
        debug_dir=case_root / "debug",
    )


def _safe_render_edge_case(
    source_pdf: Path,
    case_root: Path,
    *,
    record: Mapping[str, Any],
    input_mode: Literal["canonical", "local"],
    placement: str,
    dpi: int,
    seed: int,
) -> dict[str, Any]:
    try:
        return _render_edge_case(
            source_pdf,
            case_root,
            record=record,
            input_mode=input_mode,
            placement=placement,
            dpi=dpi,
            seed=seed,
        )
    except GeneratorError as exc:
        report = _make_report(exc.status_code, exc.stage, exc.message, {}, {}, errors=[exc.as_error()])
    except Exception as exc:
        report = _make_report(99, "edge_case_validation", str(exc), {}, {}, errors=[_error("EDGE_CASE_EXCEPTION", "edge_case_validation", str(exc))])
    sample_dir = case_root / "sample"
    try:
        _write_json(sample_dir / "report.json", report)
    except Exception:
        pass
    return report


def generate_edge_cases(
    source_pdf: str | Path,
    output_dir: str | Path | None = None,
    *,
    seed: int = 0,
    keep_artifacts: bool = False,
) -> dict[str, Any]:
    source = Path(source_pdf)
    if TEMPLATE_CONTENT_MODE == "scanned" and not STATIC_TEXT_CATALOG_COMPLETE:
        error = _error(
            "STATIC_TEXT_CATALOG_INCOMPLETE",
            "table_text_bbox_validation",
            "Edge-case generation is locked until the manual static-text catalog is complete.",
        )
        return _make_report(
            50,
            "table_text_bbox_validation",
            error["message"],
            {"edge_cases": False},
            {"edge_cases_total": len(EDGE_CASE_NAMES), "edge_cases_passed": 0},
            errors=[error],
            scope="generator_validation",
        )
    owner_created = output_dir is None
    owner = Path(output_dir) if output_dir is not None else Path(tempfile.mkdtemp(prefix="generator_edge_cases_"))
    owner.mkdir(parents=True, exist_ok=True)
    artifacts = owner / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    def record_case(name: str, passed: bool, report: Mapping[str, Any] | None = None, case_errors: Sequence[Mapping[str, Any]] = (), *, expected: str = "success") -> None:
        results.append({
            "name": name,
            "expected": expected,
            "passed": passed,
            "status_code": None if report is None else report.get("status_code"),
            "errors": [dict(item) for item in case_errors],
        })
        if not passed:
            errors.extend(dict(item) for item in case_errors)

    representative_keys = [key for key in EDGE_REPRESENTATIVE_KEYS if key in _field_spec_map()]

    def subset(record: Mapping[str, str], keys: Sequence[str] = representative_keys) -> dict[str, str]:
        return {key: record[key] for key in keys if key in record}

    normal_subset = subset(_local_normal_record())
    weird_subset = subset(make_weird_data())
    wide_subset = subset(_edge_local_record("wide"))
    narrow_subset = subset(_edge_local_record("narrow"))
    punctuation_subset = subset(_edge_local_record("punctuation"))
    multilingual_subset = subset(_edge_local_record("multilingual"))
    dense_keys = [key for key in representative_keys if _field_spec_map()[key].max_lines > 1]
    dense_subset = subset(_edge_local_record("dense"), dense_keys)

    common_cases = [
        ("normal_random_placement", normal_subset, "local", "natural", BASE_DPI),
        ("top_left_placement", weird_subset, "local", "top_left", BASE_DPI),
        ("bottom_right_placement", weird_subset, "local", "bottom_right", BASE_DPI),
        ("wide_glyph_pressure", wide_subset, "local", "natural", BASE_DPI),
        ("narrow_glyph_pressure", narrow_subset, "local", "natural", BASE_DPI),
        ("punctuation", punctuation_subset, "local", "natural", BASE_DPI),
        ("multilingual_text", multilingual_subset, "local", "natural", BASE_DPI),
        ("dense_multiline_text", dense_subset, "local", "natural", BASE_DPI),
        ("low_dpi", weird_subset, "local", "natural", max(72, round(BASE_DPI / 2))),
        ("high_dpi", weird_subset, "local", "natural", min(600, max(BASE_DPI + 100, round(BASE_DPI * 1.5)))) ,
    ]
    for index, (name, record, mode, placement, dpi) in enumerate(common_cases):
        case_root = artifacts / name
        try:
            report = _safe_render_edge_case(source, case_root, record=record, input_mode=mode, placement=placement, dpi=dpi, seed=seed + index)
            if report.get("status_code") == 0:
                contract = validate_output_contract(case_root / "sample")
                case_errors = list(contract.get("errors", []))
                record_case(name, contract.get("valid") is True, report, case_errors)
            else:
                record_case(name, False, report, report.get("errors", []))
        except Exception as exc:
            err = _error("EDGE_CASE_EXCEPTION", "edge_case_validation", f"{name}: {exc}", artifact=_safe_relative(case_root, owner))
            record_case(name, False, None, [err])

    # Long unbroken strings: fields that forbid character wrapping must reject
    # an over-wide token cleanly; fields that allow it must render completely.
    name = "long_unbroken_strings"
    case_root = artifacts / name
    unbroken = subset(_edge_local_record("unbroken"))
    report = _safe_render_edge_case(source, case_root, record=unbroken, input_mode="local", placement="natural", dpi=BASE_DPI, seed=seed + 20)
    if report["status_code"] == 0:
        contract = validate_output_contract(case_root / "sample")
        record_case(name, contract.get("valid") is True, report, contract.get("errors", []))
    else:
        expected_codes = {item.get("code") for item in report.get("errors", [])}
        passed = "TEXT_CANNOT_FIT" in expected_codes
        record_case(name, passed, report, [] if passed else report.get("errors", []), expected="success_or_explicit_fit_failure")

    # Minimum font size uses a searched field/value pair that actually resolves
    # to the configured minimum. Absence of such a pair is a specification failure.
    name = "minimum_font_size"
    minimum_case = _find_minimum_font_case()
    if minimum_case is None:
        err = _error("MINIMUM_FONT_CASE_NOT_FOUND", "edge_case_validation", "No field could be exercised exactly at min_font_size")
        record_case(name, False, None, [err])
    else:
        field_key, value = minimum_case
        record = {field_key: value}
        case_root = artifacts / name
        report = _safe_render_edge_case(source, case_root, record=record, input_mode="local", placement="natural", dpi=BASE_DPI, seed=seed + 21)
        metadata_path = case_root / "debug/render_metadata.json"
        actual_minimum = False
        if metadata_path.is_file():
            metadata = _json_load(metadata_path)
            actual_minimum = any(item["local_key"] == field_key and item["font_size_px"] == item["min_font_size_px"] for item in metadata)
        case_errors = [] if report["status_code"] == 0 and actual_minimum else report.get("errors", []) or [_error("MINIMUM_FONT_NOT_REACHED", "edge_case_validation", f"{field_key} did not render at min_font_size", field=field_key)]
        record_case(name, report["status_code"] == 0 and actual_minimum, report, case_errors)

    # Exactly max_chars for every field is tested with the fit engine rather
    # than dozens of redundant full-page renders.
    name = "maximum_permitted_character_length"
    covered, coverage_errors, render_case = _field_fit_coverage()
    render_errors: list[dict[str, Any]] = []
    render_report: dict[str, Any] | None = None
    if render_case is None:
        render_errors.append(_error("MAX_CHARS_RENDER_CASE_NOT_FOUND", "edge_case_validation", "No field could render a value of exactly max_chars"))
    else:
        field_key, exact_value = render_case
        case_root = artifacts / name
        render_report = _safe_render_edge_case(source, case_root, record={field_key: exact_value}, input_mode="local", placement="natural", dpi=BASE_DPI, seed=seed + 22)
        if render_report.get("status_code") != 0:
            render_errors.extend(render_report.get("errors", []))
    all_errors = coverage_errors + render_errors
    _write_json(artifacts / name / "coverage.json", {"accepted_fields": covered, "render_case": render_case, "errors": all_errors})
    record_case(name, len(covered) == len(FIELD_CATALOG) and not all_errors, render_report, all_errors)

    # Near-edge checks exercise all four legal extremes as one required case.
    name = "text_near_field_edges"
    edge_reports: list[dict[str, Any]] = []
    edge_errors: list[dict[str, Any]] = []
    edge_probe_keys = representative_keys[:4]
    for offset, placement in enumerate(("top_left", "top_right", "bottom_left", "bottom_right")):
        case_root = artifacts / name / placement
        probe_key = edge_probe_keys[offset % len(edge_probe_keys)]
        report = _safe_render_edge_case(source, case_root, record={probe_key: make_weird_data()[probe_key]}, input_mode="local", placement=placement, dpi=BASE_DPI, seed=seed + 30 + offset)
        edge_reports.append(report)
        edge_errors.extend(report.get("errors", []))
    record_case(name, all(report["status_code"] == 0 for report in edge_reports), {"status_code": 0 if not edge_errors else 60}, edge_errors)

    # Shared collision groups are exercised only when declared. No groups is a
    # legitimate not-applicable pass, recorded explicitly.
    name = "shared_collision_groups"
    groups: dict[str, list[str]] = defaultdict(list)
    for spec in FIELD_CATALOG:
        group = _effective_field(spec)["collision_group"]
        if group:
            groups[str(group)].append(spec.local_key)
    if not groups:
        results.append({"name": name, "expected": "not_applicable", "passed": True, "status_code": 0, "errors": []})
    else:
        collision_record = {key: make_weird_data()[key] for members in groups.values() for key in members}
        case_root = artifacts / name
        report = _safe_render_edge_case(source, case_root, record=collision_record, input_mode="local", placement="natural", dpi=BASE_DPI, seed=seed + 40)
        record_case(name, report["status_code"] == 0, report, report.get("errors", []))

    # Expected max_chars failure.
    name = "expected_max_chars_failure"
    first = FIELD_CATALOG[0]
    report = render_document(source, {first.local_key: "X" * (first.max_chars + 1)}, artifacts / name / "sample", input_mode="local", require_required=False)
    codes = {item.get("code") for item in report.get("errors", [])}
    passed = report.get("status_code") == 10 and "MAX_CHARS_EXCEEDED" in codes and not (artifacts / name / "sample/document.png").exists()
    record_case(name, passed, report, [] if passed else report.get("errors", []), expected="MAX_CHARS_EXCEEDED")

    # Expected impossible-fit failure: explicit line count exceeds max_lines
    # while remaining within max_chars, guaranteeing a true fit failure.
    name = "expected_impossible_fit_failure"
    fit_field = next(spec for spec in FIELD_CATALOG if spec.max_lines == 1 and spec.max_chars >= 3)
    report = render_document(source, {fit_field.local_key: "A\nB"}, artifacts / name / "sample", input_mode="local", require_required=False)
    codes = {item.get("code") for item in report.get("errors", [])}
    passed = report.get("status_code") == 40 and "TEXT_CANNOT_FIT" in codes and not (artifacts / name / "sample/document.png").exists()
    record_case(name, passed, report, [] if passed else report.get("errors", []), expected="TEXT_CANNOT_FIT")

    names = [item["name"] for item in results]
    missing_cases = sorted(set(EDGE_CASE_NAMES) - set(names))
    for missing in missing_cases:
        err = _error("EDGE_CASE_MISSING", "edge_case_validation", f"Required edge case missing: {missing}")
        errors.append(err)
        results.append({"name": missing, "expected": "required", "passed": False, "status_code": None, "errors": [err]})

    passed_count = sum(bool(item["passed"]) for item in results)
    valid = len(results) == len(EDGE_CASE_NAMES) and passed_count == len(EDGE_CASE_NAMES)
    status_code = 0 if valid else 60
    report = {
        "scope": "generator_validation",
        "status_code": status_code,
        "status": STATUS_CODES[status_code],
        "failed_stage": None if valid else "edge_case_validation",
        "generator_id": GENERATOR_ID,
        "valid": valid,
        "checks": {"edge_cases_complete": len(results) == len(EDGE_CASE_NAMES), "edge_cases_passed": valid},
        "metrics": {"edge_cases_total": len(results), "edge_cases_passed": passed_count},
        "cases": sorted(results, key=lambda item: EDGE_CASE_NAMES.index(item["name"])),
        "errors": errors,
        "warnings": [],
    }
    _write_json(owner / "edge_case_report.json", report)
    if owner_created and not keep_artifacts:
        shutil.rmtree(owner, ignore_errors=True)
    elif not keep_artifacts and valid:
        shutil.rmtree(artifacts, ignore_errors=True)
    return report


def _compare_output_trees(a: Path, b: Path, *, exclude: set[str] | None = None) -> tuple[bool, list[str]]:
    exclude = exclude or set()
    files_a = {path.relative_to(a).as_posix(): path for path in a.rglob("*") if path.is_file() and path.relative_to(a).as_posix() not in exclude}
    files_b = {path.relative_to(b).as_posix(): path for path in b.rglob("*") if path.is_file() and path.relative_to(b).as_posix() not in exclude}
    differences: list[str] = []
    if set(files_a) != set(files_b):
        differences.append(f"file sets differ: a_only={sorted(set(files_a)-set(files_b))}, b_only={sorted(set(files_b)-set(files_a))}")
    for relative in sorted(set(files_a) & set(files_b)):
        if not _same_file_bytes(files_a[relative], files_b[relative]):
            differences.append(relative)
    return not differences, differences


def _pdf_visual_equivalence(png_path: Path, pdf_path: Path, dpi: int) -> bool:
    png = Image.open(png_path).convert("RGB")
    with fitz.open(pdf_path) as document:
        if document.page_count != 1:
            return False
        pix = document[0].get_pixmap(matrix=fitz.Matrix(dpi / 72.0, dpi / 72.0), alpha=False)
        rendered = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    if rendered.size != png.size:
        return False
    if np is None:
        return list(rendered.resize((64, 64)).getdata()) == list(png.resize((64, 64)).getdata())
    left = np.asarray(png, dtype=np.int16)
    right = np.asarray(rendered, dtype=np.int16)
    return float(np.mean(np.abs(left - right))) <= 2.0


def _write_artifact_manifest(root: Path, output: Path) -> dict[str, Any]:
    artifacts = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and path != output:
            artifacts.append({
                "path": _safe_relative(path, root.parent),
                "sha256": _sha256_file(path),
                "size_bytes": path.stat().st_size,
            })
    payload = {
        "schema_version": "synthetic-document-audit-artifacts/1.0",
        "generator_id": GENERATOR_ID,
        "template_version": TEMPLATE_VERSION,
        "artifacts": artifacts,
    }
    _write_json(output, payload)
    return payload


def _load_machine_summary(work: Path, source_pdf: Path, seed: int) -> Mapping[str, Any] | None:
    """Return a verified machine-audit cache or None.

    A first audit run intentionally stops at status 60 until an external
    visual review is supplied.  Re-running every render after that review is
    wasteful and can invalidate the reviewed artifact set.  This cache is
    accepted only when the generator, source PDF, seed, artifact manifest,
    and every manifested artifact are byte-for-byte unchanged.
    """
    summary_path = work / "machine_summary.json"
    manifest_path = work / "artifact_manifest.json"
    if not summary_path.is_file() or not manifest_path.is_file() or not source_pdf.is_file():
        return None
    try:
        summary = _json_load(summary_path)
        required = {
            "schema_version", "generator_id", "template_version", "source_sha256",
            "generator_sha256", "seed", "artifact_manifest_sha256", "machine_checks",
            "machine_metrics", "machine_errors", "warnings", "machine_valid",
        }
        if not isinstance(summary, Mapping) or set(summary) != required:
            return None
        if summary["schema_version"] != "synthetic-document-machine-audit/1.0":
            return None
        if summary["generator_id"] != GENERATOR_ID or summary["template_version"] != TEMPLATE_VERSION:
            return None
        if int(summary["seed"]) != int(seed):
            return None
        if summary["source_sha256"] != _sha256_file(source_pdf):
            return None
        if summary["generator_sha256"] != _sha256_file(Path(__file__)):
            return None
        if summary["artifact_manifest_sha256"] != _sha256_file(manifest_path):
            return None
        manifest = _json_load(manifest_path)
        if not isinstance(manifest, Mapping) or not isinstance(manifest.get("artifacts"), list):
            return None
        output_root = work.parent
        for item in manifest["artifacts"]:
            if not isinstance(item, Mapping) or not {"path", "sha256", "size_bytes"}.issubset(item):
                return None
            candidate = output_root / str(item["path"])
            try:
                candidate.resolve().relative_to(output_root.resolve())
            except Exception:
                return None
            if not candidate.is_file() or candidate.stat().st_size != int(item["size_bytes"]):
                return None
            if _sha256_file(candidate) != item["sha256"]:
                return None
        if summary["machine_valid"] is not True:
            return None
        return summary
    except Exception:
        return None


def _write_machine_summary(
    work: Path,
    source_pdf: Path,
    seed: int,
    artifact_manifest_path: Path,
    checks: Mapping[str, bool],
    metrics: Mapping[str, Any],
    errors: Sequence[Mapping[str, Any]],
    warnings: Sequence[Any],
) -> dict[str, Any]:
    machine_checks = {name: bool(checks.get(name)) for name in REQUIRED_GENERATOR_CHECKS if name != "visual_quality"}
    payload = {
        "schema_version": "synthetic-document-machine-audit/1.0",
        "generator_id": GENERATOR_ID,
        "template_version": TEMPLATE_VERSION,
        "source_sha256": _sha256_file(source_pdf),
        "generator_sha256": _sha256_file(Path(__file__)),
        "seed": int(seed),
        "artifact_manifest_sha256": _sha256_file(artifact_manifest_path),
        "machine_checks": machine_checks,
        "machine_metrics": dict(metrics),
        "machine_errors": [dict(item) for item in errors if item.get("stage") != "visual_quality"],
        "warnings": list(warnings),
        "machine_valid": all(machine_checks.values()),
    }
    _write_json(work / "machine_summary.json", payload)
    return payload


def _load_visual_review(value: str | Path | Mapping[str, Any] | None) -> Mapping[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, Mapping):
        return value
    return _json_load(Path(value))


def _required_visual_artifacts(output_root: Path) -> set[str]:
    required = {
        "_audit_artifacts/master_overlay.png",
        "_audit_artifacts/reconstructed_background.png",
        "_audit_artifacts/reconstruction_overlay.png",
        "_audit_artifacts/normal/sample/document.png",
        "_audit_artifacts/normal/debug/field_glyph_overlay.png",
        "_audit_artifacts/normal/debug/layout_overlay.png",
        "_audit_artifacts/weird/sample/document.png",
        "_audit_artifacts/weird/debug/field_glyph_overlay.png",
        "_audit_artifacts/weird/debug/layout_overlay.png",
        "_audit_artifacts/edge/edge_case_report.json",
    }
    audit_root = output_root / "_audit_artifacts"
    if audit_root.is_dir():
        for path in audit_root.rglob("*"):
            if not path.is_file():
                continue
            relative = path.relative_to(output_root).as_posix()
            if path.name in {"document.png", "field_glyph_overlay.png", "layout_overlay.png"}:
                required.add(relative)
            if "expected_" in relative and path.name == "report.json":
                required.add(relative)
            if relative.endswith("maximum_permitted_character_length/coverage.json"):
                required.add(relative)
    return {relative for relative in required if (output_root / relative).is_file()}


def _validate_visual_review(
    review: Mapping[str, Any] | None,
    *,
    output_root: Path,
    edge_case_names: Sequence[str],
) -> tuple[bool, list[dict[str, Any]]]:
    if review is None:
        return False, [_error("VISUAL_REVIEW_REQUIRED", "visual_quality", "External full-resolution visual review is required before status 0", artifact="_audit_artifacts/artifact_manifest.json")]
    errors: list[dict[str, Any]] = []
    expected_keys = {"schema_version", "generator_id", "template_version", "status", "checks", "reviewed_artifacts", "issues"}
    if set(review) != expected_keys:
        errors.append(_error("VISUAL_REVIEW_SCHEMA", "visual_quality", "Visual-review envelope has the wrong top-level schema"))
        return False, errors
    if review["schema_version"] != VISUAL_REVIEW_SCHEMA_VERSION or review["generator_id"] != GENERATOR_ID or review["template_version"] != TEMPLATE_VERSION:
        errors.append(_error("VISUAL_REVIEW_IDENTITY", "visual_quality", "Visual-review identity or version mismatch"))
    if review["status"] != "passed":
        errors.append(_error("VISUAL_REVIEW_FAILED", "visual_quality", "External visual review did not pass"))
    checks = review.get("checks", {})
    if not isinstance(checks, Mapping):
        errors.append(_error("VISUAL_REVIEW_CHECKS", "visual_quality", "Visual-review checks must be an object"))
    else:
        for check in VISUAL_REVIEW_REQUIRED_CHECKS:
            if checks.get(check) is not True:
                errors.append(_error("VISUAL_REVIEW_CHECK_MISSING", "visual_quality", f"Required visual check did not pass: {check}"))
        edge_checks = checks.get("edge_cases")
        if not isinstance(edge_checks, Mapping):
            errors.append(_error("VISUAL_REVIEW_EDGE_CASES", "visual_quality", "Visual-review edge_cases must be an object"))
        else:
            for name in edge_case_names:
                if edge_checks.get(name) is not True:
                    errors.append(_error("VISUAL_REVIEW_EDGE_CASE_MISSING", "visual_quality", f"Edge case was not visually approved: {name}"))
    issues = review.get("issues")
    if not isinstance(issues, list) or issues:
        errors.append(_error("VISUAL_REVIEW_OPEN_ISSUES", "visual_quality", "Visual-review envelope contains unresolved issues"))
    reviewed = review.get("reviewed_artifacts")
    reviewed_paths: set[str] = set()
    if not isinstance(reviewed, list) or not reviewed:
        errors.append(_error("VISUAL_REVIEW_ARTIFACTS", "visual_quality", "No reviewed artifact hashes were supplied"))
    else:
        for item in reviewed:
            if not isinstance(item, Mapping) or set(item) != {"path", "sha256"}:
                errors.append(_error("VISUAL_REVIEW_ARTIFACT_SCHEMA", "visual_quality", "Invalid reviewed-artifact entry"))
                continue
            relative = str(item["path"])
            reviewed_paths.add(relative)
            candidate = output_root / relative
            try:
                candidate.resolve().relative_to(output_root.resolve())
            except Exception:
                errors.append(_error("VISUAL_REVIEW_ARTIFACT_PATH", "visual_quality", f"Reviewed artifact escapes output root: {relative}"))
                continue
            if not candidate.is_file():
                errors.append(_error("VISUAL_REVIEW_ARTIFACT_MISSING", "visual_quality", f"Reviewed artifact missing: {relative}", artifact=relative))
            elif _sha256_file(candidate) != item["sha256"]:
                errors.append(_error("VISUAL_REVIEW_STALE", "visual_quality", f"Reviewed artifact hash is stale: {relative}", artifact=relative))
        missing_reviewed = sorted(_required_visual_artifacts(output_root) - reviewed_paths)
        for relative in missing_reviewed:
            errors.append(_error("VISUAL_REVIEW_ARTIFACT_UNREVIEWED", "visual_quality", f"Required artifact was not included in the visual review: {relative}", artifact=relative))
    return not errors, errors


def audit_generator(
    source_pdf: str | Path,
    output_dir: str | Path,
    *,
    seed: int = 0,
    keep_artifacts: bool = False,
    visual_review: str | Path | Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    source = Path(source_pdf)
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    work = output / "_audit_artifacts"

    # Two-phase audit: the first call performs all machine work and creates
    # reviewable artifacts.  A later call with an external visual-review
    # envelope reuses that exact, hash-verified artifact set instead of
    # needlessly rerendering it.
    cached = _load_machine_summary(work, source, seed) if visual_review is not None else None
    if cached is not None:
        checks = dict(cached["machine_checks"])
        review_payload = _load_visual_review(visual_review)
        visual_valid, visual_errors = _validate_visual_review(review_payload, output_root=output, edge_case_names=EDGE_CASE_NAMES)
        checks["visual_quality"] = visual_valid
        errors = [dict(item) for item in cached["machine_errors"]] + visual_errors
        warnings = list(cached["warnings"])
        status_code = 0 if visual_valid else 60
        report = _make_report(
            status_code,
            None if status_code == 0 else "visual_quality",
            "All machine and external visual checks passed." if status_code == 0 else "External visual review is missing, stale, or failed.",
            checks,
            cached["machine_metrics"],
            errors=errors,
            warnings=warnings,
            outputs={
                "manifest": "manifest.json",
                "generator_report": "generator_report.json",
                "artifact_manifest": "_audit_artifacts/artifact_manifest.json",
            },
            scope="generator_validation",
        )
        _write_json(output / "manifest.json", get_generator_manifest())
        _write_json(output / "generator_report.json", report)
        if status_code == 0 and not keep_artifacts:
            shutil.rmtree(work, ignore_errors=True)
        return report

    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True, exist_ok=True)
    errors: list[dict[str, Any]] = []
    warnings: list[Any] = []
    checks = {name: False for name in REQUIRED_GENERATOR_CHECKS}

    # Syntax/import is necessarily true for the running module, but compile the
    # current source again so a modified on-disk file cannot be silently stale.
    try:
        source_code = Path(__file__).read_text(encoding="utf-8")
        compile(source_code, str(Path(__file__)), "exec")
        checks["syntax_import"] = True
    except Exception as exc:
        errors.append(_error("SYNTAX_IMPORT", "syntax_import", str(exc), artifact="generator.py"))

    structural = self_test()
    checks["self_test"] = structural["valid"]
    warnings.extend(structural.get("warnings", []))
    errors.extend(_error("SELF_TEST", "self_test", message, artifact="generator.py") for message in structural.get("errors", []))

    normal_report: dict[str, Any] = {}
    weird_report: dict[str, Any] = {}
    normal_contract: dict[str, Any] = {}
    weird_contract: dict[str, Any] = {}
    edge_report: dict[str, Any] = {"status_code": 80, "metrics": {"edge_cases_total": 0, "edge_cases_passed": 0}, "cases": []}
    deterministic = False
    pdf_smoke = False
    local_canonical_equivalent = False
    synthesis_deterministic = False

    try:
        _draw_master_overlay(source, work / "master_overlay.png")
        background = _prepare_background(source, BASE_DPI)
        background.save(work / "reconstructed_background.png")
        background_overlay = background.copy()
        draw = ImageDraw.Draw(background_overlay)
        sx, sy = background.width / BASE_SIZE[0], background.height / BASE_SIZE[1]
        for erase in ERASE_SPECS:
            draw.rectangle(_scale_box(erase.bbox, sx, sy), outline=(255, 0, 0), width=3)
        background_overlay.save(work / "reconstruction_overlay.png")
    except Exception as exc:
        errors.append(_error("BACKGROUND_ARTIFACT_FAILURE", "rendering", str(exc), artifact="_audit_artifacts/reconstructed_background.png"))

    if structural["valid"]:
        normal_dir = work / "normal"
        weird_dir = work / "weird"
        normal_report = _render_document_impl(source, _local_normal_record(), normal_dir / "sample", output_pdf=True, input_mode="local", key_map=None, allow_synthesis=False, require_required=False, dpi=BASE_DPI, seed=seed, scenario="normal", placement_profile="natural", debug_dir=normal_dir / "debug")
        weird_report = _render_document_impl(source, make_weird_data(), weird_dir / "sample", output_pdf=False, input_mode="local", key_map=None, allow_synthesis=False, require_required=True, dpi=BASE_DPI, seed=seed + 1, scenario="weird", placement_profile="natural", debug_dir=weird_dir / "debug")
        normal_contract = validate_output_contract(normal_dir / "sample")
        weird_contract = validate_output_contract(weird_dir / "sample")
        checks["normal_render"] = normal_report.get("status_code") == 0 and normal_contract.get("valid") is True
        checks["weird_render"] = weird_report.get("status_code") == 0 and weird_contract.get("valid") is True
        errors.extend(normal_report.get("errors", []))
        errors.extend(normal_contract.get("errors", []))
        errors.extend(weird_report.get("errors", []))
        errors.extend(weird_contract.get("errors", []))

        edge_report = generate_edge_cases(source, work / "edge", seed=seed + 100, keep_artifacts=True)
        checks["edge_cases"] = edge_report.get("status_code") == 0
        errors.extend(edge_report.get("errors", []))

        det_a = work / "determinism/a"
        det_b = work / "determinism/b"
        report_a = _render_document_impl(source, _local_normal_record(), det_a, output_pdf=False, input_mode="local", key_map=None, allow_synthesis=False, require_required=False, dpi=BASE_DPI, seed=seed + 200, scenario="determinism", placement_profile="natural", debug_dir=None)
        report_b = _render_document_impl(source, _local_normal_record(), det_b, output_pdf=False, input_mode="local", key_map=None, allow_synthesis=False, require_required=False, dpi=BASE_DPI, seed=seed + 200, scenario="determinism", placement_profile="natural", debug_dir=None)
        deterministic, differences = _compare_output_trees(det_a, det_b)
        if report_a["status_code"] != 0 or report_b["status_code"] != 0:
            deterministic = False
        if not deterministic:
            errors.append(_error("NONDETERMINISTIC_OUTPUT", "determinism", f"Repeated outputs differ: {differences}", artifact="_audit_artifacts/determinism"))

        canonical_dir = work / "canonical_equivalence"
        canonical_report = _render_document_impl(source, _canonical_from_local(make_weird_data()), canonical_dir, output_pdf=False, input_mode="canonical", key_map=None, allow_synthesis=False, require_required=True, dpi=BASE_DPI, seed=seed + 1, scenario="weird", placement_profile="natural", debug_dir=None)
        local_canonical_equivalent = canonical_report["status_code"] == 0 and _same_file_bytes(weird_dir / "sample/document.png", canonical_dir / "document.png") and _same_file_bytes(weird_dir / "sample/labels/key_information.json", canonical_dir / "labels/key_information.json")
        if not local_canonical_equivalent:
            errors.append(_error("LOCAL_CANONICAL_MISMATCH", "determinism", "Equivalent local and canonical records produced different values or pixels", artifact="_audit_artifacts/canonical_equivalence"))

        proposal_a = propose_missing_values({}, seed=seed + 300, scenario="audit")
        proposal_b = propose_missing_values({}, seed=seed + 300, scenario="audit")
        synthesis_deterministic = proposal_a == proposal_b
        if not synthesis_deterministic:
            errors.append(_error("PROPOSAL_NONDETERMINISTIC", "determinism", "Missing-value proposals differ for identical seed and scenario"))

        pdf_smoke = normal_report["status_code"] == 0 and (normal_dir / "sample/document.pdf").is_file() and _pdf_visual_equivalence(normal_dir / "sample/document.png", normal_dir / "sample/document.pdf", BASE_DPI)
        if not pdf_smoke:
            errors.append(_error("PDF_OUTPUT_MISMATCH", "rendering", "Optional PDF output does not match document.png", artifact="_audit_artifacts/normal/sample/document.pdf"))

        checks["determinism"] = deterministic and local_canonical_equivalent and synthesis_deterministic
        checks["output_contract"] = normal_contract.get("valid") is True and weird_contract.get("valid") is True and pdf_smoke
        checks["layout_labels"] = bool(normal_report.get("checks", {}).get("layout_validation")) and bool(weird_report.get("checks", {}).get("layout_validation"))
        checks["table_otsl"] = bool(normal_report.get("checks", {}).get("table_otsl_validation")) and bool(weird_report.get("checks", {}).get("table_otsl_validation"))
        checks["table_text_bbox"] = bool(normal_report.get("checks", {}).get("table_text_bbox_validation")) and bool(weird_report.get("checks", {}).get("table_text_bbox_validation"))
        checks["key_information"] = bool(normal_report.get("checks", {}).get("key_information_validation")) and bool(weird_report.get("checks", {}).get("key_information_validation"))

    artifact_manifest = _write_artifact_manifest(work, work / "artifact_manifest.json")
    review_payload = _load_visual_review(visual_review)
    visual_valid, visual_errors = _validate_visual_review(review_payload, output_root=output, edge_case_names=EDGE_CASE_NAMES)
    checks["visual_quality"] = visual_valid
    errors.extend(visual_errors)

    counts = {presence: sum(spec.presence == presence for spec in FIELD_CATALOG) for presence in VALID_PRESENCE}
    aggregate_metrics_sources = [normal_report.get("metrics", {}), weird_report.get("metrics", {})]
    boundary_violations = sum(int(source_metrics.get("boundary_violations", 0) or 0) for source_metrics in aggregate_metrics_sources)
    container_violations = sum(int(source_metrics.get("container_violations", 0) or 0) for source_metrics in aggregate_metrics_sources)
    text_collisions = sum(int(source_metrics.get("text_collisions", 0) or 0) for source_metrics in aggregate_metrics_sources)
    border_intersections = sum(int(source_metrics.get("border_intersections", 0) or 0) for source_metrics in aggregate_metrics_sources)
    metrics = {
        "field_count": len(FIELD_CATALOG),
        "required_fields": counts["required"],
        "recommended_fields": counts["recommended"],
        "optional_fields": counts["optional"],
        "derived_fields": sum(spec.missing_policy == "derive" for spec in FIELD_CATALOG),
        "synthesizable_fields": sum(spec.missing_policy == "synthesize" for spec in FIELD_CATALOG),
        "table_count": len(TABLE_CATALOG),
        "edge_cases_total": int(edge_report.get("metrics", {}).get("edge_cases_total", 0) or 0),
        "edge_cases_passed": int(edge_report.get("metrics", {}).get("edge_cases_passed", 0) or 0),
        "boundary_violations": boundary_violations,
        "container_violations": container_violations,
        "text_collisions": text_collisions,
        "border_intersections": border_intersections,
    }

    machine_checks = [name for name in REQUIRED_GENERATOR_CHECKS if name != "visual_quality"]
    machine_valid = all(checks[name] for name in machine_checks)
    _write_machine_summary(
        work,
        source,
        seed,
        work / "artifact_manifest.json",
        checks,
        metrics,
        errors,
        warnings,
    )
    if not checks["syntax_import"]:
        status_code = 20
    elif not checks["self_test"]:
        status_code = 30
    elif not machine_valid:
        if any(error["stage"] in {"annotation_validation", "layout_validation", "table_otsl_validation", "table_text_bbox_validation", "key_information_validation", "output_validation"} for error in errors):
            status_code = 50
        elif any(error["stage"] in {"rendering", "input_validation"} for error in errors):
            status_code = 40
        else:
            status_code = 60
    elif not visual_valid:
        status_code = 60
    else:
        status_code = 0

    report = _make_report(
        status_code,
        None if status_code == 0 else next((name for name in REQUIRED_GENERATOR_CHECKS if not checks[name]), "generator_validation"),
        "All machine and external visual checks passed." if status_code == 0 else "Generator validation is incomplete or failed.",
        checks,
        metrics,
        errors=errors,
        warnings=warnings,
        outputs={
            "manifest": "manifest.json",
            "generator_report": "generator_report.json",
            "artifact_manifest": "_audit_artifacts/artifact_manifest.json",
        },
        scope="generator_validation",
    )
    _write_json(output / "manifest.json", get_generator_manifest())
    _write_json(output / "generator_report.json", report)

    if status_code == 0 and not keep_artifacts:
        shutil.rmtree(work, ignore_errors=True)
    elif status_code != 0:
        # Retain the audit directory because every visual or machine failure
        # references evidence inside it. Successful packaging removes it.
        pass
    return report


PUBLIC_API = (
    "get_canonical_schema",
    "get_generator_manifest",
    "get_available_fields",
    "assess_compatibility",
    "propose_missing_values",
    "resolve_record",
    "validate_record",
    "render_document",
    "validate_output_contract",
    "generate_edge_cases",
    "self_test",
    "audit_generator",
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Portable scan-only synthetic document generator")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("describe", "schema", "list-fields", "self-test"):
        command = sub.add_parser(name)
        command.add_argument("--output", type=Path)
    command = sub.add_parser("assess")
    command.add_argument("--data", type=Path, required=True)
    command.add_argument("--key-map", type=Path)
    command = sub.add_parser("propose-missing")
    command.add_argument("--data", type=Path, required=True)
    command.add_argument("--key-map", type=Path)
    command.add_argument("--seed", type=int, default=0)
    command.add_argument("--scenario", default="synthetic")
    command = sub.add_parser("make-weird-data")
    command.add_argument("--output", type=Path)
    command.add_argument("--canonical", action="store_true")
    command = sub.add_parser("render")
    command.add_argument("--pdf", type=Path, required=True)
    command.add_argument("--data", type=Path, required=True)
    command.add_argument("--output-dir", type=Path, required=True)
    command.add_argument("--output-pdf", action="store_true")
    command.add_argument("--input-mode", choices=["canonical", "local"], default="canonical")
    command.add_argument("--key-map", type=Path)
    command.add_argument("--allow-synthesis", action="store_true")
    command.add_argument("--allow-missing-required", action="store_true")
    command.add_argument("--dpi", type=int, default=BASE_DPI)
    command.add_argument("--seed", type=int, default=0)
    command.add_argument("--scenario", default="synthetic")
    command.add_argument("--placement", choices=sorted(ALLOWED_PLACEMENT_PROFILES), default="natural")
    command = sub.add_parser("edge-cases")
    command.add_argument("--pdf", type=Path, required=True)
    command.add_argument("--output-dir", type=Path, required=True)
    command.add_argument("--seed", type=int, default=0)
    command.add_argument("--keep-artifacts", action="store_true")
    command = sub.add_parser("audit")
    command.add_argument("--pdf", type=Path, required=True)
    command.add_argument("--output-dir", type=Path, required=True)
    command.add_argument("--seed", type=int, default=0)
    command.add_argument("--keep-artifacts", action="store_true")
    command.add_argument("--visual-review", type=Path)
    command = sub.add_parser("validate-output")
    command.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    key_map = _json_load(args.key_map) if getattr(args, "key_map", None) else None
    if args.command == "describe":
        payload = get_generator_manifest()
    elif args.command == "schema":
        payload = get_canonical_schema()
    elif args.command == "list-fields":
        payload = get_available_fields()
    elif args.command == "self-test":
        payload = self_test()
    elif args.command == "assess":
        payload = assess_compatibility(_json_load(args.data), key_map=key_map)
    elif args.command == "propose-missing":
        payload = propose_missing_values(_json_load(args.data), key_map=key_map, seed=args.seed, scenario=args.scenario)
    elif args.command == "make-weird-data":
        payload = _canonical_weird_record() if args.canonical else make_weird_data()
    elif args.command == "render":
        payload = render_document(
            args.pdf,
            _json_load(args.data),
            args.output_dir,
            output_pdf=args.output_pdf,
            input_mode=args.input_mode,
            key_map=key_map,
            allow_synthesis=args.allow_synthesis,
            require_required=not args.allow_missing_required,
            dpi=args.dpi,
            seed=args.seed,
            scenario=args.scenario,
            placement_profile=args.placement,
        )
    elif args.command == "edge-cases":
        payload = generate_edge_cases(args.pdf, args.output_dir, seed=args.seed, keep_artifacts=args.keep_artifacts)
    elif args.command == "audit":
        payload = audit_generator(args.pdf, args.output_dir, seed=args.seed, keep_artifacts=args.keep_artifacts, visual_review=args.visual_review)
    elif args.command == "validate-output":
        payload = validate_output_contract(args.output_dir)
    else:
        raise AssertionError(args.command)

    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    output_path = getattr(args, "output", None)
    if output_path is not None and args.command in {"describe", "schema", "list-fields", "self-test", "make-weird-data"}:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)

    if isinstance(payload, Mapping) and "status_code" in payload:
        exit_code = int(payload["status_code"])
    elif args.command == "self-test":
        exit_code = 0 if bool(payload.get("valid")) else 30
    else:
        exit_code = 0
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()

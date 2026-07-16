#!/usr/bin/env python3
"""Reproduce the V2 World Rowing 2017 median summary with Python stdlib only."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path, PurePosixPath
from typing import Optional

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
EXPECTED_SHA256 = "e0d494d42fd5e0868a2bc64a388713083fec26c84a11173bc8c329a07659024d"
CELL_REF = re.compile(r"([A-Z]+)")


def column_number(reference: str) -> int:
    match = CELL_REF.match(reference)
    if not match:
        raise ValueError(f"Ungültige Zellreferenz: {reference}")
    number = 0
    for char in match.group(1):
        number = number * 26 + ord(char) - ord("A") + 1
    return number


def finite_in_range(value: object, minimum: float, maximum: float) -> Optional[float]:
    if not isinstance(value, (int, float)):
        return None
    numeric = float(value)
    return numeric if minimum <= numeric <= maximum else None


def first_plausible_rig_distance(row: dict[int, float], minimum: float, maximum: float) -> Optional[float]:
    """Return at most one distance per survey row, preferring column N over O."""
    for column in (14, 15):
        candidate = finite_in_range(row.get(column), minimum, maximum)
        if candidate is not None:
            return candidate
    return None


def median(values: list[float]) -> Optional[float]:
    return statistics.median(values) if values else None


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_target(target: str) -> str:
    target = target.lstrip("/")
    if target.startswith("xl/"):
        return target
    return str(PurePosixPath("xl") / target)


def workbook_sheets(archive: zipfile.ZipFile) -> list[tuple[str, str]]:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {
        item.attrib["Id"]: normalize_target(item.attrib["Target"])
        for item in relations.findall(f"{{{PACKAGE_REL_NS}}}Relationship")
    }
    sheets = []
    for item in workbook.findall(f".//{{{MAIN_NS}}}sheet"):
        relation_id = item.attrib[f"{{{REL_NS}}}id"]
        sheets.append((item.attrib["name"], targets[relation_id]))
    return sheets


def numeric_rows(archive: zipfile.ZipFile, member: str) -> list[dict[int, float]]:
    root = ET.fromstring(archive.read(member))
    rows: list[dict[int, float]] = []
    for row in root.findall(f".//{{{MAIN_NS}}}row"):
        row_number = int(row.attrib.get("r", "0"))
        if row_number <= 2:
            continue
        values: dict[int, float] = {}
        for cell in row.findall(f"{{{MAIN_NS}}}c"):
            if cell.attrib.get("t") in {"s", "str", "inlineStr", "b", "e"}:
                continue
            value_element = cell.find(f"{{{MAIN_NS}}}v")
            if value_element is None or value_element.text is None:
                continue
            try:
                values[column_number(cell.attrib["r"])] = float(value_element.text)
            except (KeyError, ValueError):
                continue
        if values:
            rows.append(values)
    return rows


def analyze(path: Path) -> dict[str, dict[str, object]]:
    result: dict[str, dict[str, object]] = {}
    with zipfile.ZipFile(path) as archive:
        for name, member in workbook_sheets(archive):
            rows = numeric_rows(archive, member)
            scull = "x" in name.lower()
            distance_min, distance_max = (145, 175) if scull else (70, 100)
            rig_distance = [
                candidate
                for row in rows
                if (candidate := first_plausible_rig_distance(row, distance_min, distance_max)) is not None
            ]
            inboard = [value for row in rows if (value := finite_in_range(row.get(20), 75, 130)) is not None]
            oar_length = [value for row in rows if (value := finite_in_range(row.get(19), 260, 410)) is not None]
            result[name] = {
                "numericRows": len(rows),
                "samples": {
                    "rigDistance": len(rig_distance),
                    "inboard": len(inboard),
                    "oarLength": len(oar_length),
                },
                "rigDistance": median(rig_distance),
                "inboard": median(inboard),
                "oarLength": median(oar_length),
            }
    return result


def verify(actual: dict[str, dict[str, object]], expected_path: Path) -> None:
    expected = json.loads(expected_path.read_text(encoding="utf-8"))["classes"]
    if set(actual) != set(expected):
        raise AssertionError(f"Klassen unterscheiden sich: {set(actual) ^ set(expected)}")
    for boat_class, metrics in expected.items():
        for key, expected_value in metrics.items():
            actual_value = actual[boat_class][key]
            if isinstance(expected_value, (int, float)) and isinstance(actual_value, (int, float)):
                if abs(float(actual_value) - float(expected_value)) > 1e-9:
                    raise AssertionError(f"{boat_class}.{key}: {actual_value} != {expected_value}")
            elif actual_value != expected_value:
                raise AssertionError(f"{boat_class}.{key}: {actual_value} != {expected_value}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook", type=Path, help="Pfad zur offiziellen World-Rowing-XLSX")
    parser.add_argument(
        "--verify",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "world-rowing-2017-summary.json",
        help="Erwartete abgeleitete Zusammenfassung",
    )
    arguments = parser.parse_args()
    digest = sha256(arguments.workbook)
    if digest != EXPECTED_SHA256:
        raise SystemExit(f"Unerwarteter SHA-256: {digest}")
    actual = analyze(arguments.workbook)
    verify(actual, arguments.verify)
    json.dump(actual, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
    sys.stdout.write("\nVERIFIED\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

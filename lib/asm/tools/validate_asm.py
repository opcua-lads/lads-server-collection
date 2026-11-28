#!/usr/bin/env python3
"""Validate an ASM JSON file against an embedded ASM schema (*.embed.schema.json) of lib/asm/schemas.

    python3 lib/asm/tools/validate_asm.py <asm.json> [<schema>]   (default schema: liquid-chromatography.tabular)

The embedded schemas carry every referenced schema in $defs (keyed by its $id), so no network access is needed.
Prints the errors (path, message), exit 0 = valid, 1 = invalid. Needs the Python package jsonschema (>= 4.18).
"""
import json, sys
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

HERE = Path(__file__).resolve().parent.parent / "schemas"

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    doc = json.load(open(sys.argv[1], encoding="utf-8"))
    name = sys.argv[2] if len(sys.argv) > 2 else "liquid-chromatography.tabular"
    path = Path(name) if Path(name).exists() else HERE / f"{name}.embed.schema.json"
    schema = json.load(open(path, encoding="utf-8"))
    resources = [(uri, Resource.from_contents(sub, default_specification=DRAFT202012)) for uri, sub in schema.get("$defs", {}).items()]
    registry = Registry().with_resources(resources)
    validator = Draft202012Validator(schema, registry=registry, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(doc), key=lambda e: list(e.absolute_path))
    for e in errors[:40]:
        print(f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message[:300]}")
        for sub in sorted(e.context or [], key=lambda s: len(list(s.absolute_path)))[-3:]:
            print(f"    - {'/'.join(map(str, sub.absolute_path))}: {sub.message[:200]}")
    print(f"{path.name}: {'valid' if not errors else f'{len(errors)} error(s)'}")
    sys.exit(1 if errors else 0)

if __name__ == "__main__":
    main()

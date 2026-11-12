#!/usr/bin/env python3
"""Lists the missing instance declarations of a NodeSet (see nodeset_model.py).
Usage: check_modelling.py <nodeset.xml> <dependency nodesets ...>      (exit code 1 if there are gaps)"""
import sys
from nodeset_model import Model
m = Model()
for p in sys.argv[2:]: m.load(p)
m.load(sys.argv[1], own=True)
g = m.gaps()
for owner, decl, path in g: print(f'{path} : missing {decl["name"][1]} ({decl["cls"]}, mandatory, declared as child of {m.nodes[owner]["name"][1]})')
print('gaps:', len(g), file=sys.stderr)
sys.exit(1 if g else 0)

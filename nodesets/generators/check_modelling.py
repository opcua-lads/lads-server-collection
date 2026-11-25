#!/usr/bin/env python3
"""Checks a NodeSet (see nodeset_model.py).
Usage: check_modelling.py <nodeset.xml> <dependency nodesets ...>      (exit code 1 if there are gaps or errors)

Gaps     mandatory instance declarations missing in the types of the nodeset
Errors   - the same BrowseName twice below one node (a declaration that also exists, or is added by the server, a second time)
         - NodeVersion variables with the value NaN (the string "0" is meant)
         - a hierarchical reference from an own node to a node of another nodeset, e.g. a Timer that is a component of
           the LADS declaration 'Operational' instead of declaring its own (listed as warning for ordinary children of
           own nodes, see below)
Warnings hierarchical references from own nodes to nodes of the dependencies (shared declarations)
         - a LADS device (own subtype of LADSDeviceType, or an own instance of one) without the nameplate / location nodes
           that every device should expose (clients such as the MHS fleet use them for the picture, the site and the map):
           DeviceTypeImage (DI, folder for product pictures), HierarchicalLocation and OperationalLocation (AMB, optional in
           LADSDeviceType), Identification/Location (Machinery, end-user scheme; also holds the geographical location, e.g.
           "N 50.777642 E 6.071827"). In a device type declare them Mandatory, so every instance gets them."""
import sys
from nodeset_model import Model, BASE
m = Model()
for p in sys.argv[2:]: m.load(p)
m.load(sys.argv[1], own=True)
name = lambda i: '/'.join(filter(None, [m.nodes[i]['name'][1]])) + f' ({i[1]})'
def path(i):
    out, seen = [], set()
    while i in m.nodes and i not in seen:
        seen.add(i); out.append(m.nodes[i]['name'][1]); i = m.nodes[i]['parent'] if m.nodes[i].get('parent') else m.nodes[i]['pid']
    return '/'.join(reversed(out))
g = m.gaps()
errors, warnings = [], []
for owner, decl, p in g: print(f'gap      {p} : missing {decl["name"][1]} ({decl["cls"]}, mandatory, declared as child of {m.nodes[owner]["name"][1]})')
# 1. duplicates
for parent, ids in m.kids().items():
    if not m.nodes[parent]['own']: continue
    seen = {}
    for c in ids: seen.setdefault(m.nodes[c]['name'], []).append(c)
    for bn, cs in seen.items():
        if len(cs) > 1: errors.append(f'duplicate {path(parent)}/{bn[1]} : {len(cs)} nodes ' + ', '.join(f'{c[1]}' for c in cs))
# 2. NodeVersion
for n in m.nodes.values():
    if n['own'] and n['name'][1] == 'NodeVersion' and n['value'] in ('NaN', ''): errors.append(f'NodeVersion {path(n["id"])} ({n["id"][1]}) has the value "{n["value"] or "(none)"}", expected "0"')
# 3. references into the dependencies
for n in m.nodes.values():
    if not n['own']: continue
    for r, c in n['children']:
        t = m.nodes.get(c)
        if t is None or t['own']: continue
        if n['cls'] == 'UAMethod' and r in ('HasProperty', 'i=46'): continue      # shared InputArguments / OutputArguments
        (errors if n['cls'] in ('UAObject', 'UAVariable') and t['cls'] in ('UAObject', 'UAVariable') and t.get('rule') and t['id'][0] != BASE else warnings).append(
            f'reference {path(n["id"])} -> {r} {t["name"][1]} of {t["id"][0].rstrip("/").split("/")[-1]} ({t["id"][1]})')
# 4. remote operation mode: MachineryOperationMode of a device without the Goto methods cannot be switched (optional in LADS, wanted for maintenance)
kids = m.kids()
for n in m.nodes.values():
    if not n['own'] or n['cls'] != 'UAObject' or n['name'][1] != 'MachineryOperationMode': continue
    have = {m.nodes[c]['name'][1] for c in kids.get(n['id'], []) if m.nodes[c]['cls'] == 'UAMethod'}
    missing = [x for x in ('GotoProcessing', 'GotoMaintenance', 'GotoSetup') if x not in have]
    if missing: warnings.append(f'{path(n["id"])} ({n["id"][1]}) has no ' + ', '.join(missing))
# 5. nameplate / location nodes of LADS devices (see the docstring)
LADS_DEVICE = ('http://opcfoundation.org/UA/LADS/', 'i=1002')
DEVICE_NODES = ('DeviceTypeImage', 'HierarchicalLocation', 'OperationalLocation')
dev_types = {n['id'] for n in m.nodes.values() if n['own'] and n['cls'] == 'UAObjectType' and LADS_DEVICE in m.chain(n['id'])[1:]}
for n in m.nodes.values():
    if not n['own'] or not (n['id'] in dev_types or (n['cls'] == 'UAObject' and n['td'] in dev_types)): continue
    have = {m.nodes[c]['name'][1]: c for c in kids.get(n['id'], [])}
    missing = [x for x in DEVICE_NODES if x not in have]
    ident = have.get('Identification')
    if ident is None or 'Location' not in {m.nodes[c]['name'][1] for c in kids.get(ident, [])}: missing.append('Identification/Location')
    if missing: warnings.append(f'{path(n["id"])} ({n["id"][1]}) has no ' + ', '.join(missing))
for e in errors: print('error    ' + e)
for w in warnings: print('warning  ' + w)
print(f'gaps: {len(g)}, errors: {len(errors)}, warnings: {len(warnings)}', file=sys.stderr)
sys.exit(1 if g or errors else 0)

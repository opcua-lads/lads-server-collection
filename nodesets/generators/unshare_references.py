#!/usr/bin/env python3
"""Removes the shared references of a hand modelled / SiOME exported NodeSet (see check_modelling.py, error 'reference').
Usage: unshare_references.py <nodeset.xml> <dependency nodesets ...> [--check]
An instance declaration of the NodeSet that references an instance declaration of a dependency (for example the 'Operational' or the
'RawValue' of the LADS type of a function) shares a node of another model. The reference is removed. Mandatory declarations are
created again as own nodes by complete_nodeset.py (run it afterwards), optional ones are gone (they are not needed: the server adds
them where it uses them). Nothing else is changed. --check lists the references without writing."""
import sys, re
from nodeset_model import Model, BASE

args = [a for a in sys.argv[1:] if not a.startswith('--')]
check_only = '--check' in sys.argv
path, deps = args[0], args[1:]
text = open(path, encoding='utf-8').read()
uris = re.findall(r'<Uri>([^<]*)</Uri>', text.split('</NamespaceUris>')[0])
def nid_str(t):
    uri, part = t
    return part if uri == BASE else f'ns={uris.index(uri) + 1};{part}'

model = Model()
for d in deps: model.load(d)
model.load(path, own=True)
remove = {}          # owner NodeId text -> set of target NodeId texts
for n in model.nodes.values():
    if not n['own'] or n['cls'] not in ('UAObject', 'UAVariable'): continue
    for r, c in n['children']:
        t = model.nodes.get(c)
        if t is None or t['own'] or t['id'][0] == BASE or not t.get('rule'): continue
        if t['cls'] not in ('UAObject', 'UAVariable'): continue
        remove.setdefault(nid_str(n['id']), set()).add(nid_str(c))
        print(f'{"mandatory" if t["rule"] == "i=78" else "optional "}  {n["name"][1]} ({n["id"][1]}) -> {t["name"][1]} ({t["id"][0].rstrip("/").split("/")[-1]} {t["id"][1]})')
print('references:', sum(len(v) for v in remove.values()), file=sys.stderr)
if check_only or not remove: sys.exit(0)

for owner, targets in remove.items():
    m = re.search(r'^    <UA\w+ [^>]*NodeId="%s"[^>]*>.*?^    </UA\w+>\n' % re.escape(owner), text, re.M | re.S)
    if not m: raise SystemExit(f'node {owner} not found in {path}')
    block = m.group(0)
    for t in targets:
        block = re.sub(r'^ *<Reference ReferenceType="[^"]*">%s</Reference>\n' % re.escape(t), '', block, flags=re.M)
    text = text[:m.start()] + block + text[m.end():]
open(path, 'w', encoding='utf-8').write(text)
print('written', path)

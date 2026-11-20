#!/usr/bin/env python3
"""Completes the mandatory instance declarations of a hand modelled NodeSet in place (see nodeset_model.py for the convention).
Usage: complete_nodeset.py <nodeset.xml> <dependency nodesets ...> [--check]
Every gap that check_modelling.py reports is filled with a copy of the missing declaration (Mandatory, own namespace, new NodeIds
above the highest one of the file, all other NodeIds stay as they are). New declarations get no value: values are set by the server.
Idempotent: a complete NodeSet is not changed. --check lists what would be added without writing."""
import sys, re
from xml.sax.saxutils import escape
from nodeset_model import Model, BASE

REFNAME = {'i=47': 'HasComponent', 'i=46': 'HasProperty', 'i=17604': 'HasAddIn', 'i=35': 'Organizes', 'i=49': 'HasOrderedComponent'}
args = [a for a in sys.argv[1:] if not a.startswith('--')]
check_only = '--check' in sys.argv
path, deps = args[0], args[1:]
text = open(path, encoding='utf-8').read()
uris = re.findall(r'<Uri>([^<]*)</Uri>', text.split('</NamespaceUris>')[0])
own_uri = re.search(r'<Model ModelUri="([^"]*)"', text).group(1)
max_id = max(int(i) for i in re.findall(r'ns=%d;i=(\d+)' % (uris.index(own_uri) + 1), text))

def nid_str(t):
    uri, part = t
    if uri == BASE: return part
    if uri not in uris: raise SystemExit(f'namespace {uri} is not declared in {path}')
    return f'ns={uris.index(uri) + 1};{part}'
def bn_str(t):
    return t[1] if t[0] == BASE else f'{uris.index(t[0]) + 1}:{t[1]}'
def display_name(bn): return re.sub(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])', ' ', bn)

model = Model()
for d in deps: model.load(d)
model.load(path, own=True)
new, counter = [], max_id
for _ in range(25):
    gaps = [g for g in model.gaps() if model.nodes[g[0]]['own']]
    if not gaps: break
    for owner, decl, p in gaps:
        if not model.nodes[owner]['own']: continue      # the standard argument properties referenced by a method are not ours
        counter += 1
        nid = (own_uri, f'i={counter}')
        reft = REFNAME.get(decl.get('reftype'), decl.get('reftype') or 'HasComponent')
        entry = dict(cls=decl['cls'], id=nid, name=decl['name'], rule='i=78', td=decl['td'] if decl['cls'] != 'UAMethod' else None, sup=None,
                     children=[], own=True, vr=decl.get('vr'), ad=decl.get('ad'), access=decl.get('access'), desc=decl.get('desc'),
                     dt=model.data_type(decl) if decl['cls'] == 'UAVariable' else None, reftype=reft, parent=owner, path=p)
        if decl['cls'] == 'UAMethod':          # the argument properties of the standard method are referenced
            entry['children'] = [('HasProperty', c) for r, c in model.nodes[decl['id']]['children'] if r in ('i=46', 'HasProperty')]
        model.nodes[owner]['children'].append((reft, nid)); model.nodes[nid] = entry; new.append(entry)
else:
    raise SystemExit('no fixpoint')
if not new:
    print('complete, nothing to add'); sys.exit(0)
for e in new: print(f'{e["path"]}/{e["name"][1]}  ({e["cls"]})')
print('to add:', len(new), file=sys.stderr)
if check_only: sys.exit(0)

new_ids = {e['id'] for e in new}
def element(e):
    a = f'NodeId="{nid_str(e["id"])}" BrowseName="{bn_str(e["name"])}" ParentNodeId="{nid_str(e["parent"])}"'
    if e['cls'] == 'UAVariable':
        a = f'DataType="{nid_str(e["dt"])}" ' + a
        if e['vr'] is not None: a = f'ValueRank="{e["vr"]}" ' + a
        if e['ad'] is not None: a += f' ArrayDimensions="{e["ad"]}"'
        if e['access'] == '3': a += ' AccessLevel="3" UserAccessLevel="3"'
    s = f'    <{e["cls"]} {a}>\n        <DisplayName>{escape(display_name(e["name"][1]))}</DisplayName>\n'
    if e['desc']: s += f'        <Description>{escape(e["desc"])}</Description>\n'
    s += '        <References>\n'
    if e['td']: s += f'            <Reference ReferenceType="HasTypeDefinition">{nid_str(e["td"])}</Reference>\n'
    s += '            <Reference ReferenceType="HasModellingRule">i=78</Reference>\n'
    s += f'            <Reference ReferenceType="{e["reftype"]}" IsForward="false">{nid_str(e["parent"])}</Reference>\n'
    for r, c in e['children']: s += f'            <Reference ReferenceType="{r}">{nid_str(c)}</Reference>\n'
    return s + '        </References>\n' + f'    </{e["cls"]}>\n'

# references from existing nodes to their new children
inject = {}
for e in new:
    if e['parent'] not in new_ids: inject.setdefault(nid_str(e['parent']), []).append(f'            <Reference ReferenceType="{e["reftype"]}">{nid_str(e["id"])}</Reference>\n')
for owner, lines in inject.items():
    m = re.search(r'^    <UA\w+ [^>]*NodeId="%s"[^>]*>.*?^    </UA\w+>\n' % re.escape(owner), text, re.M | re.S)
    if not m: raise SystemExit(f'node {owner} not found in {path}')
    block = m.group(0)
    i = block.rindex('        </References>\n')
    text = text[:m.start()] + block[:i] + ''.join(lines) + block[i:] + text[m.end():]
text = text.replace('</UANodeSet>', ''.join(element(e) for e in new) + '</UANodeSet>')
open(path, 'w', encoding='utf-8').write(text)
print('written', path, len(new), 'declarations added')

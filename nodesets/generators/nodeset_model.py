"""Minimal OPC UA NodeSet model for checking / completing the instance declarations of types.

Convention (OPC 10000-3 and the common model compilers): wherever a type contains an instance declaration X
  - of a type definition D, every mandatory child of D (incl. the ones inherited by D) is declared again below X;
  - that overrides / belongs to an instance declaration X' of a supertype of the containing type, every mandatory
    descendant of X' is declared again below X;
and a subtype re-declares every mandatory instance declaration of its supertypes. The rule is applied recursively.
"""
import re
import xml.etree.ElementTree as ET
NS = '{http://opcfoundation.org/UA/2011/03/UANodeSet.xsd}'
BASE = 'http://opcfoundation.org/UA/'
HIER = {'i=47', 'i=46', 'i=17604', 'i=35', 'i=49', 'HasComponent', 'HasProperty', 'HasAddIn', 'Organizes', 'HasOrderedComponent'}
MANDATORY = 'i=78'

class Model:
    def __init__(self): self.nodes = {}
    def load(self, path, own=False):
        root = ET.parse(path).getroot()
        nu = root.find(NS + 'NamespaceUris')
        uris = [u.text for u in nu] if nu is not None else []
        alias = {a.get('Alias'): a.text for a in root.iter(NS + 'Alias')}
        def nid(t):
            if t is None: return None
            t = alias.get(t, t); m = re.match(r'ns=(\d+);(.*)', t)
            return (uris[int(m.group(1)) - 1] if m and int(m.group(1)) > 0 else BASE, m.group(2) if m else t)
        def bn(t):
            m = re.match(r'(\d+):(.*)', t)
            return (uris[int(m.group(1)) - 1] if m and int(m.group(1)) > 0 else BASE, m.group(2) if m else t)
        for e in root:
            tag = e.tag.replace(NS, '')
            if tag not in ('UAObject', 'UAVariable', 'UAObjectType', 'UAVariableType', 'UAMethod'): continue
            n = dict(cls=tag, id=nid(e.get('NodeId')), name=bn(e.get('BrowseName')), rule=None, td=None, sup=None, children=[], own=own,
                     dt=nid(e.get('DataType')) if e.get('DataType') else None, vr=e.get('ValueRank'), ad=e.get('ArrayDimensions'),
                     access=e.get('AccessLevel'), desc=None)
            d = e.find(NS + 'Description')
            if d is not None: n['desc'] = d.text
            for r in e.iter(NS + 'Reference'):
                t = alias.get(r.get('ReferenceType'), r.get('ReferenceType')); tgt = nid(r.text); fwd = r.get('IsForward', 'true') != 'false'
                if t == 'i=37': n['rule'] = tgt[1]
                elif t == 'i=40': n['td'] = tgt
                elif t == 'i=45' and not fwd: n['sup'] = tgt
                elif t in HIER and fwd: n['children'].append((t, tgt))
            self.nodes[n['id']] = n
        for n in self.nodes.values():
            for r, c in n['children']:
                if c in self.nodes: self.nodes[c].setdefault('reftype', r); self.nodes[c].setdefault('parent', n['id'])
    def chain(self, t):
        res = []
        while t and t in self.nodes and t not in res: res.append(t); t = self.nodes[t]['sup']
        return res
    def mand(self, owner):
        return [self.nodes[c] for r, c in self.nodes[owner]['children'] if c in self.nodes and self.nodes[c]['rule'] == MANDATORY]
    def gather(self, decls, types):
        exp = {}
        for d in decls:
            for ch in self.mand(d['id']): exp.setdefault(ch['name'], []).append(ch)
        for t in types:
            for tt in self.chain(t):
                for ch in self.mand(tt): exp.setdefault(ch['name'], []).append(ch)
        return exp
    def gaps(self, only_own=True):
        """[(owner id, declaration to copy, path)] for the instance declarations missing in the own types"""
        out = []
        def walk(owner, decls, types, path, depth=0):
            if depth > 12: return
            have = {self.nodes[c]['name']: self.nodes[c] for r, c in owner['children'] if c in self.nodes}
            exp = self.gather(decls, types)
            for name, ds in exp.items():
                if name not in have: out.append((owner['id'], next((d for d in ds if d.get('dt')), ds[0]), path)); continue
                ch = have[name]
                walk(ch, ds, [ch['td'] or ds[-1]['td']], path + '/' + name[1], depth + 1)
            for name, ch in have.items():
                if name not in exp and ch['cls'] in ('UAObject', 'UAVariable') and ch['td']:
                    walk(ch, [], [ch['td']], path + '/' + name[1], depth + 1)
        for t in list(self.nodes.values()):
            if t['own'] and t['cls'] in ('UAObjectType', 'UAVariableType'):
                walk(t, [], [t['sup']] if t['sup'] else [], t['name'][1])
        return out

    def data_type(self, decl):
        """DataType of a declaration; if it is not stated, the one of the declaration it overrides in a supertype, else BaseDataType"""
        if decl.get('dt'): return decl['dt']
        parent = decl.get('parent')
        if parent in self.nodes:
            for t in self.chain(parent)[1:]:
                for ch in self.nodes[t]['children']:
                    c = self.nodes.get(ch[1])
                    if c and c['name'] == decl['name'] and c.get('dt'): return c['dt']
            vt = self.nodes[decl['td']] if decl.get('td') in self.nodes else None
            for t in self.chain(decl.get('td')):
                if self.nodes[t].get('dt'): return self.nodes[t]['dt']
        return (BASE, 'i=17') if decl['name'][1] == 'Id' else (BASE, 'i=24')   # Id of the state machine variables is a NodeId

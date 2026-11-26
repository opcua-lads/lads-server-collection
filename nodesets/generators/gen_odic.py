#!/usr/bin/env python3
"""Generates nodesets/ODIC.xml: LADS model of an experimental facility whose functional units are arranged hierarchically.

Same approach as gen_labwasher.py: a static type model, the server instantiates the device. Mandatory instance declarations are
completed recursively (nodeset_model.py).

    python3 generators/gen_odic.py ODIC.xml          (run in nodesets/)

Types
  ODICUnitType (FunctionalUnitType)   base type of all units of this model
      - FunctionalUnitState with Start and Stop and the RunningStateMachine (Start: Stopped -> Running/Idle, Stop: -> Stopped;
        a unit switches to Running/Execute while one of its subordinate functions is switched on - behaviour of the server)
      - FunctionalUnitSet (FunctionalUnitSetType, optional): the units subordinate to this unit. They are only referenced
        (Organizes); each unit keeps its single parent in the FunctionalUnitSet of the device.
  ExperimentFacilityUnitType, ExperimentModuleUnitType   ODICUnitType with a (mandatory) FunctionalUnitSet
  ChillerUnitType                     ODICUnitType with CoolingFan (TwoStateDiscreteControlFunction) and TemperatureController
                                      (AnalogControlFunction), both with Start and Stop
  VideoProcessingUnitType             ODICUnitType
  ExperimentalFacilityDeviceType (LADSDeviceType)   FunctionalUnitSet with the four units; Organizes references:
      ExperimentFacilityUnit/FunctionalUnitSet  ->  ChillerUnit, ExperimentModuleUnit
      ExperimentModuleUnit/FunctionalUnitSet    ->  VideoProcessingUnit
"""
import sys, re, os, datetime
from xml.sax.saxutils import escape

URI = 'http://spectaris.de/ODIC/'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'ODIC.xml'
TODAY = datetime.date.today().isoformat()

# namespace indices of this file: 1 DI, 2 AMB, 3 Machinery, 4 LADS, 5 own
MR_MAND, MR_OPT = 'i=78', 'i=80'
T = dict(
    BaseObject='i=58', Folder='i=61', BaseVar='i=63', Prop='i=68', AnalogUnitRange='i=17570', TwoStateDiscrete='i=2373',
    LADSDevice='ns=4;i=1002', FunctionalUnit='ns=4;i=1003', FunctionalUnitSet='ns=4;i=1023', FunctionSet='ns=4;i=1026',
    FunctionalUnitState='ns=4;i=1043', ProgramManager='ns=4;i=1006', ActiveProgram='ns=4;i=1040',
    ProgramTemplateSet='ns=4;i=1019', ResultSet='ns=4;i=1020', ProgramTemplate='ns=4;i=1018', DeviceState='ns=4;i=1039',
    ControlFunctionState='ns=4;i=1044', AnalogControl='ns=4;i=1009', AnalogScalar='ns=4;i=1016', Cover='ns=4;i=1011',
    TwoStateSensor='ns=4;i=1031', TwoStateControl='ns=4;i=1042', RunningSM='ns=4;i=1036', Lock='ns=1;i=6388', MachineryItemState='ns=3;i=1002', OperationMode='ns=4;i=1050',
    MachineIdent='ns=3;i=1012')
DT = dict(Boolean='i=1', UInt32='i=7', Int32='i=6', Double='i=11', String='i=12', DateTime='i=13', LocalizedText='i=21',
          Duration='i=290', EUInformation='i=887', Range='i=884', DeviceHealth='ns=1;i=6244', NameNodeId='ns=2;i=3003')
X = lambda s: escape(str(s))

def display_name(browse_name):
    return re.sub(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[a-z])(?=[0-9])', ' ', browse_name)

def v_str(s): return f'<uax:String>{X(s)}</uax:String>'
def v_lt(s): return f'<uax:LocalizedText><uax:Text>{X(s)}</uax:Text></uax:LocalizedText>'
def v_num(tag, x): return f'<uax:{tag}>{x}</uax:{tag}>'
def v_bool(b): return f'<uax:Boolean>{"true" if b else "false"}</uax:Boolean>'
def v_eu(unit):
    uid, sym, desc = unit
    return ('<uax:ExtensionObject><uax:TypeId><uax:Identifier>i=888</uax:Identifier></uax:TypeId><uax:Body><uax:EUInformation>'
            f'<uax:NamespaceUri>http://www.opcfoundation.org/UA/units/un/cefact</uax:NamespaceUri><uax:UnitId>{uid}</uax:UnitId>'
            f'<uax:DisplayName><uax:Text>{X(sym)}</uax:Text></uax:DisplayName><uax:Description><uax:Text>{X(desc)}</uax:Text></uax:Description>'
            '</uax:EUInformation></uax:Body></uax:ExtensionObject>')
def v_range(lo, hi):
    return ('<uax:ExtensionObject><uax:TypeId><uax:Identifier>i=885</uax:Identifier></uax:TypeId><uax:Body><uax:Range>'
            f'<uax:Low>{lo}</uax:Low><uax:High>{hi}</uax:High></uax:Range></uax:Body></uax:ExtensionObject>')

U_CEL = (4408652, '°C', 'degree Celsius')
U_US_CM = (4666418, 'µS/cm', 'microsiemens per centimetre')
U_PCT = (20529, '%', 'percent')

class Node:
    cnt = {'obj': 5000, 'var': 6000}
    allnodes = []
    def __init__(self, kind, bn, parent=None, rt='HasComponent', td=None, mr=MR_MAND, desc=None, nsb=5, dt=None,
                 value=None, vr=None, ad=None, rw=False, nid=None, dn=None):
        self.kind, self.bn, self.nsb, self.td, self.mr, self.desc, self.dt = kind, bn, nsb, td, mr, desc, dt
        self.value, self.vr, self.ad, self.rw, self.parent, self.rt, self.dn = value, vr, ad, rw, parent, rt, dn
        self.kids = []
        self.orgs = []      # targets of Organizes references (nodes that have another parent)
        if nid: self.nid = nid
        else:
            k = 'obj' if kind == 'UAObject' else 'var'
            Node.cnt[k] += 1; self.nid = f'ns=5;i={Node.cnt[k]}'
        if parent is not None: parent.kids.append(self)
        Node.allnodes.append(self)
    def obj(self, bn, td, **k): return Node('UAObject', bn, self, td=td, **k)
    def var(self, bn, dt, value=None, td=T['BaseVar'], rt='HasComponent', **k): return Node('UAVariable', bn, self, rt=rt, td=td, dt=dt, value=value, **k)
    def prop(self, bn, dt, value=None, nsb=0, **k): return Node('UAVariable', bn, self, rt='HasProperty', td=T['Prop'], dt=dt, value=value, nsb=nsb, **k)
    def xml(self):
        a = f'NodeId="{self.nid}" BrowseName="{self.nsb}:{X(self.bn)}"' if self.nsb else f'NodeId="{self.nid}" BrowseName="{X(self.bn)}"'
        if self.parent is not None: a += f' ParentNodeId="{self.parent.nid}"'
        if self.kind == 'UAVariable':
            a = f'DataType="{self.dt}" ' + a
            if self.vr is not None: a = f'ValueRank="{self.vr}" ' + a
            if self.ad is not None: a += f' ArrayDimensions="{self.ad}"'
            if self.rw: a += ' AccessLevel="3" UserAccessLevel="3"'
        if self.kind == 'UAObjectType': a += ' IsAbstract="false"'
        shown = self.dn or (self.bn if self.kind == 'UAObjectType' else display_name(self.bn))
        s = f'    <{self.kind} {a}>\n        <DisplayName>{X(shown)}</DisplayName>\n'
        if self.desc: s += f'        <Description>{X(self.desc)}</Description>\n'
        s += '        <References>\n'
        if self.kind == 'UAObjectType': s += f'            <Reference ReferenceType="HasSubtype" IsForward="false">{self.td}</Reference>\n'
        elif self.td: s += f'            <Reference ReferenceType="HasTypeDefinition">{self.td}</Reference>\n'
        if self.parent is not None and self.mr: s += f'            <Reference ReferenceType="HasModellingRule">{self.mr}</Reference>\n'
        if self.parent is not None: s += f'            <Reference ReferenceType="{self.rt}" IsForward="false">{self.parent.nid}</Reference>\n'
        for k in self.kids: s += f'            <Reference ReferenceType="{k.rt}">{k.nid}</Reference>\n'
        for r in getattr(self, 'extra', []): s += f'            <Reference ReferenceType="HasProperty">{r}</Reference>\n'
        for t in self.orgs: s += f'            <Reference ReferenceType="Organizes">{t.nid}</Reference>\n'
        for o in Node.allnodes:
            if self in o.orgs: s += f'            <Reference ReferenceType="Organizes" IsForward="false">{o.nid}</Reference>\n'
        s += '        </References>\n'
        if self.kind == 'UAVariable' and self.value is not None: s += f'        <Value>\n            {self.value}\n        </Value>\n'
        return s + f'    </{self.kind}>\n'

def objtype(nid, bn, sup, desc): return Node('UAObjectType', bn, None, td=sup, mr=None, desc=desc, nid=nid)

def analog(parent, bn, unit, rng, rw=False, td=T['AnalogUnitRange'], desc=None):
    v = parent.var(bn, DT['Double'], td=td, nsb=4, rw=rw, desc=desc)
    v.prop('EngineeringUnits', DT['EUInformation'], v_eu(unit)); v.prop('EURange', DT['Range'], v_range(*rng))
    return v

def enabled(f): f.prop('IsEnabled', DT['Boolean'], v_bool(True), nsb=4)


# ============================ helpers of this model
M_ID = [7000]
def method(parent, name, desc, args=None):
    """Method of a state machine (BrowseName in the LADS namespace); args: the shared argument properties of the LADS method"""
    M_ID[0] += 1
    m = Node('UAMethod', name, parent, td=None, nsb=4, nid=f'ns=5;i={M_ID[0]}', desc=desc)
    if args: m.extra = args
    return m

def control_state(f):
    """ControlFunctionState of a control function: Start and Stop"""
    s = f.obj('ControlFunctionState', T['ControlFunctionState'], nsb=4)
    method(s, 'Start', 'Starts the control function: Stopped -> Running')
    method(s, 'Stop', 'Stops the control function: Running -> Stopped')
    return s

def control_twostate(fs, name, false_state, true_state, desc):
    f = fs.obj(name, T['TwoStateControl'], desc=desc)
    enabled(f)
    for vn in ('CurrentValue', 'TargetValue'):
        v = f.var(vn, DT['Boolean'], v_bool(False), td=T['TwoStateDiscrete'], nsb=4, rw=(vn == 'TargetValue'))
        v.prop('TrueState', DT['LocalizedText'], v_lt(true_state)); v.prop('FalseState', DT['LocalizedText'], v_lt(false_state))
    control_state(f)
    return f

def control_analog(fs, name, unit, rng, desc):
    f = fs.obj(name, T['AnalogControl'], desc=desc)
    enabled(f)
    analog(f, 'CurrentValue', unit, rng)
    analog(f, 'TargetValue', unit, rng, rw=True, desc='Set point')
    control_state(f)
    return f

U_CEL = (4408652, '°C', 'degree Celsius')

# ============================ types
dev_t = objtype('ns=5;i=1000', 'ExperimentalFacilityDeviceType', T['LADSDevice'], 'Experimental facility: four functional units, two of them arranged hierarchically below other units')
odic_t = objtype('ns=5;i=1001', 'ODICUnitType', T['FunctionalUnit'], 'Base type of the units of the experimental facility: Start / Stop with a RunningStateMachine and an optional FunctionalUnitSet for subordinate units')
facility_t = objtype('ns=5;i=1002', 'ExperimentFacilityUnitType', odic_t.nid, 'Experiment facility unit: arranges the chiller unit and the experiment module unit')
chiller_t = objtype('ns=5;i=1003', 'ChillerUnitType', odic_t.nid, 'Chiller unit with cooling fan and temperature controller')
module_t = objtype('ns=5;i=1004', 'ExperimentModuleUnitType', odic_t.nid, 'Experiment module unit: arranges the video processing unit')
video_t = objtype('ns=5;i=1005', 'VideoProcessingUnitType', odic_t.nid, 'Video processing unit')

# ODICUnitType
state = odic_t.obj('FunctionalUnitState', T['FunctionalUnitState'], nsb=4)
method(state, 'Start', 'Starts the unit: Stopped -> Running, the RunningStateMachine is Idle', ['ns=4;i=6127'])
method(state, 'Stop', 'Stops the unit: Running -> Stopped')
state.obj('RunningStateMachine', T['RunningSM'], nsb=4, desc='Sub state machine of the Running state (RunningStateMachineType): Idle while no subordinate function is on, Execute otherwise')
odic_t.obj('Lock', T['Lock'], nsb=1)
odic_t.obj('FunctionalUnitSet', T['FunctionalUnitSet'], mr=MR_OPT, desc='Functional units subordinate to this unit; referenced by Organizes only')

# units with subordinate units: FunctionalUnitSet is mandatory
for t in (facility_t, module_t):
    t.obj('FunctionalUnitSet', T['FunctionalUnitSet'], desc='Functional units subordinate to this unit; referenced by Organizes only')

# ChillerUnitType
cfs = chiller_t.obj('FunctionSet', T['FunctionSet'], nsb=4)
control_twostate(cfs, 'CoolingFan', 'Off', 'On', 'Cooling fan of the chiller')
control_analog(cfs, 'TemperatureController', U_CEL, (0, 40), 'Temperature controller of the chiller')

# device: nameplate (DI) and Identification (Machinery); the values are filled in by the server / the user
NAMEPLATE = [('Manufacturer', 'LocalizedText', v_lt('')), ('Model', 'LocalizedText', v_lt('')),
             ('ProductCode', 'String', v_str('')), ('SerialNumber', 'String', v_str('')),
             ('SoftwareRevision', 'String', v_str('')), ('HardwareRevision', 'String', v_str('')), ('DeviceRevision', 'String', v_str('')),
             ('ProductInstanceUri', 'String', v_str('')), ('AssetId', 'String', v_str('')), ('ComponentName', 'LocalizedText', v_lt('')),
             ('ManufacturerUri', 'String', v_str('')), ('RevisionCounter', 'Int32', v_num('Int32', 0)),
             ('DeviceManual', 'String', v_str(''))]
for n, dt, v in NAMEPLATE: dev_t.prop(n, DT[dt], v, nsb=1)
dev_t.prop('HierarchicalLocation', DT['String'], v_str(''), nsb=2, rw=True, desc='Hierarchical location of the device, e.g. FactoryA/BuildingC/Floor1')
dev_t.prop('OperationalLocation', DT['String'], v_str(''), nsb=2, rw=True, desc='Operational location of the device, e.g. Warehouse1/Sheet3')
dev_t.obj('DeviceTypeImage', T['Folder'], nsb=1, desc='Organizes pictures of the device')
ident = dev_t.obj('Identification', T['MachineIdent'], nsb=1, rt='HasAddIn', desc='Identification according to OPC 40001-1')
for n, dt, v in NAMEPLATE: ident.prop(n, DT[dt], v, nsb=1)
ident.prop('Location', DT['String'], v_str(''), nsb=3, rw=True, desc='Location of the machine in a scheme specific to the end user (GPS position as text)')
dev_t.obj('DeviceState', T['DeviceState'], nsb=4)
dev_t.var('DeviceHealth', DT['DeviceHealth'], v_num('Int32', 0), nsb=1, desc='NAMUR NE 107 device health')
dev_t.obj('MachineryItemState', T['MachineryItemState'], nsb=3, desc='MachineryItemState indicates the current state of the device in conformance with the Machinery Basics specification.')
op_mode = dev_t.obj('MachineryOperationMode', T['OperationMode'], nsb=3, desc='State machine representing the operation mode of a laboratory device. Optional methods allow for initiating changes of the operation mode from remote.')
for i, m in enumerate(['GotoMaintenance', 'GotoProcessing', 'GotoSetup']):
    Node('UAMethod', m, op_mode, td=None, nsb=4, nid=f'ns=5;i={7100 + i}')

# FunctionalUnitSet of the device: the four units (each has exactly one parent: this set)
fus = dev_t.obj('FunctionalUnitSet', T['FunctionalUnitSet'], nsb=4)
facility = fus.obj('ExperimentFacilityUnit', facility_t.nid, desc='Experiment facility unit, arranges ChillerUnit and ExperimentModuleUnit')
chiller = fus.obj('ChillerUnit', chiller_t.nid, desc='Chiller unit')
module = fus.obj('ExperimentModuleUnit', module_t.nid, desc='Experiment module unit, arranges VideoProcessingUnit')
video = fus.obj('VideoProcessingUnit', video_t.nid, desc='Video processing unit')
# hierarchy by Organizes between the instance declarations
facility_set = facility.obj('FunctionalUnitSet', T['FunctionalUnitSet'], desc='Units subordinate to ExperimentFacilityUnit')
facility_set.orgs += [chiller, module]
module_set = module.obj('FunctionalUnitSet', T['FunctionalUnitSet'], desc='Units subordinate to ExperimentModuleUnit')
module_set.orgs += [video]

# ============================ completion of the mandatory instance declarations (as gen_futura.py)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nodeset_model import Model, BASE
URIS = [BASE, 'http://opcfoundation.org/UA/DI/', 'http://opcfoundation.org/UA/AMB/', 'http://opcfoundation.org/UA/Machinery/', 'http://opcfoundation.org/UA/LADS/', URI]
REFNAME = {'i=47': 'HasComponent', 'i=46': 'HasProperty', 'i=17604': 'HasAddIn', 'i=35': 'Organizes', 'i=49': 'HasOrderedComponent'}
def _tup(s):
    m = re.match(r'ns=(\d+);(.*)', s); return (URIS[int(m.group(1))], m.group(2)) if m else (BASE, s)
def _str(t):
    i = URIS.index(t[0]); return (f'ns={i};' if i else '') + t[1]
NAME2ID = {v: k for k, v in REFNAME.items()}
def _own_model(base):
    m = Model(); m.nodes = dict(base.nodes)
    for n in Node.allnodes:
        is_type = n.kind == 'UAObjectType'
        m.nodes[_tup(n.nid)] = dict(cls=n.kind, id=_tup(n.nid), name=(URIS[n.nsb], n.bn), rule=n.mr, own=True,
                                    td=None if is_type or not n.td else _tup(n.td), sup=_tup(n.td) if is_type else None,
                                    dt=_tup(n.dt) if n.dt else None, vr=n.vr, ad=n.ad, desc=n.desc, value=n.value, access='3' if n.rw else None,
                                    children=[(NAME2ID.get(k.rt, k.rt), _tup(k.nid)) for k in n.kids] + [('i=46', _tup(r)) for r in getattr(n, 'extra', [])]
                                             + [('i=35', _tup(t.nid)) for t in n.orgs])
    for n in Node.allnodes:
        for k in n.kids: m.nodes[_tup(k.nid)].update(reftype=NAME2ID.get(k.rt, 'i=47'), parent=_tup(n.nid))
    return m

# initial states: functional units and control functions are Stopped; they offer Start and Stop only (no Abort / Clear)
FSM_STATES = dict(Stopped=5085, Running=5099, Stopping=5100)
FSM_TRANSITIONS = dict(StoppedToRunning=5102, RunningToStopping=5105, StoppingToStopped=5101)
def v_nodeid(i): return f'<uax:NodeId><uax:Identifier>ns=4;i={i}</uax:Identifier></uax:NodeId>'
def v_nodeid_list(ids): return '<uax:ListOfNodeId>' + ''.join(v_nodeid(i) for i in ids) + '</uax:ListOfNodeId>'
def state_machine_values(n):
    machine = n.parent.parent if n.bn == 'Id' and n.parent is not None and n.parent.bn == 'CurrentState' else n.parent
    if machine is None or machine.td not in (T['FunctionalUnitState'], T['ControlFunctionState']): return
    states, transitions, initial = list(FSM_STATES), list(FSM_TRANSITIONS), 'Stopped'     # Start / Stop only, no Abort / Clear
    if n.bn == 'AvailableStates' and n.parent is machine: n.value, n.ad = v_nodeid_list(FSM_STATES[s] for s in states), len(states)
    elif n.bn == 'AvailableTransitions' and n.parent is machine: n.value, n.ad = v_nodeid_list(FSM_TRANSITIONS[s] for s in transitions), (len(transitions) or 0)
    elif n.bn == 'CurrentState' and n.parent is machine: n.value = v_lt(initial)
    elif n.bn == 'Id': n.value = v_nodeid(FSM_STATES[initial])
def expand_mandatory(start=10000):
    base = Model()
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
    for f in ['Opc.Ua.NodeSet2.xml', 'Opc.Ua.Di.NodeSet2.xml', 'Opc.Ua.AMB.NodeSet2.xml', 'Opc.Ua.Machinery.NodeSet2.xml', 'Opc.Ua.LADS.NodeSet2.xml']:
        base.load(os.path.join(d, f))
    counter, added = start, 0
    for _ in range(25):
        model = _own_model(base)
        gaps = model.gaps()
        if not gaps: break
        byid = {_tup(n.nid): n for n in Node.allnodes}
        done = set()
        for owner, decl, path in gaps:
            if (owner, decl['name']) in done: continue      # a unit reached by several paths (Organizes) is completed once
            done.add((owner, decl['name']))
            counter += 1; added += 1
            n = Node(decl['cls'], decl['name'][1], byid[owner], rt=REFNAME.get(decl.get('reftype'), 'HasComponent'), mr=MR_MAND,
                     td=_str(decl['td']) if decl['td'] else None, nsb=URIS.index(decl['name'][0]),
                     dt=_str(model.data_type(decl)) if decl['cls'] == 'UAVariable' else None, desc=decl.get('desc'),
                     nid=f'ns=5;i={counter}', rw=decl.get('access') == '3', vr=decl.get('vr'), ad=decl.get('ad'),
                     value=v_str('0') if decl['name'][1] == 'NodeVersion' else decl.get('value'))
            state_machine_values(n)
            if decl['cls'] == 'UAMethod':
                n.extra = [_str(c) for r, c in model.nodes[decl['id']]['children'] if r in ('i=46', 'HasProperty')]
    else:
        raise SystemExit('expand_mandatory: no fixpoint')
    print('expanded', added, 'mandatory instance declarations')
    return counter
expand_mandatory()

# ============================ output
ALIAS = {'Boolean': 'i=1', 'Int32': 'i=6', 'UInt32': 'i=7', 'Double': 'i=11', 'String': 'i=12', 'DateTime': 'i=13',
         'LocalizedText': 'i=21', 'Duration': 'i=290', 'EUInformation': 'i=887', 'Range': 'i=884',
         'HasComponent': 'i=47', 'HasProperty': 'i=46', 'HasSubtype': 'i=45', 'HasTypeDefinition': 'i=40', 'HasModellingRule': 'i=37', 'HasAddIn': 'i=17604', 'Organizes': 'i=35'}
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n')
    f.write('<UANodeSet LastModified="%sT00:00:00Z" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://opcfoundation.org/UA/2011/03/UANodeSet.xsd" xmlns:uax="http://opcfoundation.org/UA/2008/02/Types.xsd" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' % TODAY)
    f.write('    <NamespaceUris>\n' + ''.join(f'        <Uri>{u}</Uri>\n' for u in URIS[1:]) + '    </NamespaceUris>\n')
    f.write(f'    <Models>\n        <Model ModelUri="{URI}" PublicationDate="{TODAY}T00:00:00Z" Version="0.1.0">\n')
    for u, d, v in [('http://opcfoundation.org/UA/', '2023-12-15T00:00:00Z', '1.05.03'), ('http://opcfoundation.org/UA/DI/', '2022-11-03T00:00:00Z', '1.04.0'),
                    ('http://opcfoundation.org/UA/AMB/', '2022-11-01T00:00:00Z', '1.01.0'), ('http://opcfoundation.org/UA/Machinery/', '2023-08-01T00:00:00Z', '1.03.0'),
                    ('http://opcfoundation.org/UA/LADS/', '2023-11-30T00:00:00Z', '1.0.0')]:
        f.write(f'            <RequiredModel ModelUri="{u}" PublicationDate="{d}" Version="{v}"/>\n')
    f.write('        </Model>\n    </Models>\n    <Aliases>\n' + ''.join(f'        <Alias Alias="{a}">{i}</Alias>\n' for a, i in ALIAS.items()) + '    </Aliases>\n')
    for n in Node.allnodes: f.write(n.xml())
    f.write('</UANodeSet>\n')
print('written', OUT, len(Node.allnodes), 'nodes')

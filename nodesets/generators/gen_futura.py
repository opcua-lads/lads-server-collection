#!/usr/bin/env python3
"""Generates nodesets/FuturaConnect.xml (Aber Instruments Futura Connect Xtra, LADS model, layout B).
Source of truth: 'LADS Information Model for the Futura Connect Xtra (Draft)'. Static address space:
everything, including ProgramTemplates, ParameterSet variables and alarms, is declared in the types."""
import sys, re, datetime
from xml.sax.saxutils import escape

URI = 'http://aberinstruments.com/FuturaConnect/'
PROBE_DURATION = 'OperationDuration'      # alternative: 'PowerOnDuration' (see DI 4.5.5)
OUT = sys.argv[1] if len(sys.argv) > 1 else 'FuturaConnect.xml'
TODAY = datetime.date.today().isoformat()

# namespace indices of this file: 1 DI, 2 AMB, 3 Machinery, 4 LADS, 5 own
MR_MAND, MR_OPT = 'i=78', 'i=80'
T = dict(
    BaseObject='i=58', Folder='i=61', BaseVar='i=63', Prop='i=68', AnalogUnitRange='i=17570',
    MultiStateDiscrete='i=2376', TwoStateDiscrete='i=2373', MultiStateValueDiscrete='i=11238',
    LADSDevice='ns=4;i=1002', FunctionalUnit='ns=4;i=1003', LADSComponent='ns=4;i=1024',
    FunctionalUnitSet='ns=4;i=1023', FunctionSet='ns=4;i=1026', FunctionalUnitState='ns=4;i=1043',
    ProgramManager='ns=4;i=1006', ActiveProgram='ns=4;i=1040', ProgramTemplateSet='ns=4;i=1019',
    ResultSet='ns=4;i=1020', ProgramTemplate='ns=4;i=1018', SupportedPropertiesSet='ns=4;i=1033',
    SupportedProperty='ns=4;i=1035', DeviceState='ns=4;i=1039', ControlFunctionState='ns=4;i=1044',
    AnalogScalar='ns=4;i=1016', AnalogArray='ns=4;i=1015', TwoStateControl='ns=4;i=1042',
    MultiStateControl='ns=4;i=1045', Components='ns=4;i=1025',
    Lock='ns=1;i=6388', LifetimeVariable='ns=1;i=468',
    MachineIdent='ns=3;i=1012', ComponentIdent='ns=3;i=1005', LifetimeCounters='ns=3;i=1015', OperationCounters='ns=3;i=1009',
    Failure='ns=1;i=15292', OffSpec='ns=1;i=15590', MaintReq='ns=1;i=15739')
DT = dict(Boolean='i=1', UInt16='i=5', Int32='i=6', UInt32='i=7', Double='i=11', String='i=12', DateTime='i=13',
          LocalizedText='i=21', Duration='i=290', EUInformation='i=887', Range='i=884', EnumValueType='i=7594',
          DeviceHealth='ns=1;i=6244')
X = lambda s: escape(str(s))

def strip_inst(text):
    """Removes the references to the EtherNet/IP instances (Inst. n) from descriptions; they stay in the specification."""
    if not text: return text
    text = re.sub(r'\s*\([^()]*Inst\. \d+[^()]*\)', '', text)
    text = re.sub(r';? limit from Inst\. \d+', '', text)
    return re.sub(r'\s+([.;,])', r'\1', text).strip()

def display_name(browse_name):
    """Display name from the camel case browse name: a space before every upper case letter except the first;
    runs of capitals stay together (EURange -> EU Range, ColeColeAlpha -> Cole Cole Alpha)."""
    return re.sub(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])', ' ', browse_name)

def v_str(s): return f'<uax:String>{X(s)}</uax:String>'
def v_lt(s): return f'<uax:LocalizedText><uax:Text>{X(s)}</uax:Text></uax:LocalizedText>'
def v_num(tag, x): return f'<uax:{tag}>{x}</uax:{tag}>'
def v_bool(b): return f'<uax:Boolean>{"true" if b else "false"}</uax:Boolean>'
def v_dbl_list(l): return '<uax:ListOfDouble>' + ''.join(f'<uax:Double>{x}</uax:Double>' for x in l) + '</uax:ListOfDouble>'
def v_lt_list(l): return '<uax:ListOfLocalizedText>' + ''.join(v_lt(s) for s in l) + '</uax:ListOfLocalizedText>'
def v_eu(unit):
    if unit is None: uid, sym, desc, nsu = -1, '', '', ''
    else: uid, sym, desc = unit; nsu = 'http://www.opcfoundation.org/UA/units/un/cefact'
    return ('<uax:ExtensionObject><uax:TypeId><uax:Identifier>i=888</uax:Identifier></uax:TypeId><uax:Body><uax:EUInformation>'
            f'<uax:NamespaceUri>{nsu}</uax:NamespaceUri><uax:UnitId>{uid}</uax:UnitId>'
            f'<uax:DisplayName><uax:Text>{X(sym)}</uax:Text></uax:DisplayName><uax:Description><uax:Text>{X(desc)}</uax:Text></uax:Description>'
            '</uax:EUInformation></uax:Body></uax:ExtensionObject>')
def v_range(lo, hi):
    return ('<uax:ExtensionObject><uax:TypeId><uax:Identifier>i=886</uax:Identifier></uax:TypeId><uax:Body><uax:Range>'
            f'<uax:Low>{lo}</uax:Low><uax:High>{hi}</uax:High></uax:Range></uax:Body></uax:ExtensionObject>')
def v_enumvalues(items):
    s = '<uax:ListOfExtensionObject>'
    for val, name in items:
        s += ('<uax:ExtensionObject><uax:TypeId><uax:Identifier>i=8251</uax:Identifier></uax:TypeId><uax:Body><uax:EnumValueType>'
              f'<uax:Value>{val}</uax:Value><uax:DisplayName><uax:Text>{X(name)}</uax:Text></uax:DisplayName><uax:Description><uax:Text></uax:Text></uax:Description>'
              '</uax:EnumValueType></uax:Body></uax:ExtensionObject>')
    return s + '</uax:ListOfExtensionObject>'

U_KHZ = (4933722, 'kHz', 'kilohertz');  U_CEL = (4408652, '°C', 'degree Celsius')
U_UM  = (13384, 'µm', 'micrometre (micron)'); U_MS_CM = (4732465, 'mS/cm', 'millisiemens per centimetre')
U_ONE = (4404786, '1', 'one');          U_GL = (18252, 'g/l', 'gram per litre')

class Node:
    cnt = {'obj': 5000, 'var': 6000}
    allnodes = []
    def __init__(self, kind, bn, parent=None, rt='HasComponent', td=None, mr=MR_MAND, desc=None, nsb=5, dt=None,
                 value=None, vr=None, ad=None, rw=False, nid=None):
        self.kind, self.bn, self.nsb, self.td, self.mr, self.desc, self.dt = kind, bn, nsb, td, mr, strip_inst(desc), dt
        self.value, self.vr, self.ad, self.rw, self.parent, self.rt = value, vr, ad, rw, parent, rt
        self.kids = []
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
        a = f'NodeId="{self.nid}" BrowseName="{self.nsb}:{self.bn}"' if self.nsb else f'NodeId="{self.nid}" BrowseName="{self.bn}"'
        if self.parent is not None: a += f' ParentNodeId="{self.parent.nid}"'
        if self.kind == 'UAVariable':
            a = f'DataType="{self.dt}" ' + a
            if self.vr is not None: a = f'ValueRank="{self.vr}" ' + a
            if self.ad is not None: a += f' ArrayDimensions="{self.ad}"'
            if self.rw: a += ' AccessLevel="3" UserAccessLevel="3"'
        if self.kind == 'UAObjectType': a += ' IsAbstract="false"'
        shown = self.bn if self.kind == 'UAObjectType' else display_name(self.bn)
        s = f'    <{self.kind} {a}>\n        <DisplayName>{X(shown)}</DisplayName>\n'
        if self.desc: s += f'        <Description>{X(self.desc)}</Description>\n'
        s += '        <References>\n'
        if self.kind == 'UAObjectType': s += f'            <Reference ReferenceType="HasSubtype" IsForward="false">{self.td}</Reference>\n'
        elif self.td: s += f'            <Reference ReferenceType="HasTypeDefinition">{self.td}</Reference>\n'
        if self.parent is not None and self.mr: s += f'            <Reference ReferenceType="HasModellingRule">{self.mr}</Reference>\n'
        if self.parent is not None: s += f'            <Reference ReferenceType="{self.rt}" IsForward="false">{self.parent.nid}</Reference>\n'
        for k in self.kids: s += f'            <Reference ReferenceType="{k.rt}">{k.nid}</Reference>\n'
        for r in getattr(self, 'extra', []): s += f'            <Reference ReferenceType="HasProperty">{r}</Reference>\n'      # argument properties of the standard method
        s += '        </References>\n'
        if self.kind == 'UAVariable' and self.value is not None: s += f'        <Value>\n            {self.value}\n        </Value>\n'
        return s + f'    </{self.kind}>\n'

def objtype(nid, bn, sup, desc): return Node('UAObjectType', bn, None, td=sup, mr=None, desc=desc, nid=nid)

def add_ident(parent, td, items):
    n = parent.obj('Identification', td, nsb=1, rt='HasAddIn', desc='Identification according to OPC 40001-1')
    for name, spec in items.items():
        dt, val = spec[0], spec[1]
        n.prop(name, dt, val, nsb=spec[2] if len(spec) > 2 else 1, rw=(name == 'Location'))
    return n

def sensor_scalar(fs, name, unit, rng, enabled, desc, cal=None):
    f = fs.obj(name, T['AnalogScalar'], desc=desc)
    f.prop('IsEnabled', DT['Boolean'], v_bool(enabled), nsb=4)
    sv = f.var('SensorValue', DT['Double'], td=T['AnalogUnitRange'], nsb=4)
    sv.prop('EngineeringUnits', DT['EUInformation'], v_eu(unit)); sv.prop('EURange', DT['Range'], v_range(*rng))
    if cal: f.var('CalibrationValues', DT['Double'], v_dbl_list(cal), vr=1, ad=len(cal), nsb=4, rw=True)
    return f

def sensor_array(fs, name, unit, rng, n, enabled, desc, cal=None):
    f = fs.obj(name, T['AnalogArray'], desc=desc)
    f.prop('IsEnabled', DT['Boolean'], v_bool(enabled), nsb=4)
    sv = f.var('SensorValue', DT['Double'], td=T['AnalogUnitRange'], nsb=4, vr=1, ad=n)
    sv.prop('EngineeringUnits', DT['EUInformation'], v_eu(unit)); sv.prop('EURange', DT['Range'], v_range(*rng))
    if cal: f.var('CalibrationValues', DT['Double'], v_dbl_list(cal), vr=1, ad=len(cal), nsb=4)
    return f

MODES = ['CellCulture', 'Bacterial', 'Microbial', 'SignalSimulator', 'Custom', 'Brewery', 'Scan']
def control_multistate(fs, name, strings, current, desc):
    f = fs.obj(name, T['MultiStateControl'], desc=desc)
    f.prop('IsEnabled', DT['Boolean'], v_bool(True), nsb=4)
    for vn in ('CurrentValue', 'TargetValue'):
        v = f.var(vn, DT['UInt32'], v_num('UInt32', current), td=T['MultiStateDiscrete'], nsb=4, rw=(vn == 'TargetValue'))
        v.prop('EnumStrings', DT['LocalizedText'], v_lt_list(strings), vr=1, ad=len(strings))
    f.obj('ControlFunctionState', T['ControlFunctionState'], nsb=4)
    return f

def control_twostate(fs, name, desc):
    f = fs.obj(name, T['TwoStateControl'], desc=desc)
    f.prop('IsEnabled', DT['Boolean'], v_bool(True), nsb=4)
    for vn in ('CurrentValue', 'TargetValue'):
        v = f.var(vn, DT['Boolean'], v_bool(False), td=T['TwoStateDiscrete'], nsb=4, rw=(vn == 'TargetValue'))
        v.prop('TrueState', DT['LocalizedText'], v_lt('Active')); v.prop('FalseState', DT['LocalizedText'], v_lt('Idle'))
    f.obj('ControlFunctionState', T['ControlFunctionState'], nsb=4)
    return f

def p_analog(ps, name, dt, val, unit, rng, desc):
    v = ps.var(name, DT[dt], v_num(dt, val), td=T['AnalogUnitRange'], rw=True, desc=desc)
    v.prop('EngineeringUnits', DT['EUInformation'], v_eu(unit)); v.prop('EURange', DT['Range'], v_range(*rng)); return v
def p_enum(ps, name, items, val, desc):
    v = ps.var(name, DT['UInt16'], v_num('UInt16', val), td=T['MultiStateValueDiscrete'], rw=True, desc=desc)
    v.prop('EnumValues', DT['EnumValueType'], v_enumvalues(items), vr=1, ad=len(items))
    v.prop('ValueAsText', DT['LocalizedText'], v_lt(dict(items)[val])); return v

POL = [(0, 'None'), (1, 'Pol220'), (2, 'PolFutura')]
CALIB = [(0, 'FactoryTip'), (1, 'Custom1'), (2, 'Custom2')]
CELL = [(0, 'Animal'), (1, 'Yeast'), (2, 'Bacteria')]
BIOM = [(0, 'MillionCellsPerMl'), (1, 'GramPerLitre'), (2, 'VolumeFraction')]

def futura_params(ps):
    p_analog(ps, 'MeasuringFrequency', 'UInt16', 580, U_KHZ, (50, 20000), 'Measuring frequency (Inst. 10)')
    p_analog(ps, 'DualFrequency', 'UInt16', 0, U_KHZ, (1000, 20000), 'Second frequency for polarisation correction, 0 = off (Inst. 11)')
    p_enum(ps, 'PolarisationCorrection', POL, 1, 'Type of polarisation correction (Inst. 12)')
    p_analog(ps, 'FilterLength', 'UInt16', 30, None, (0, 200), 'Filter of the readings in readings; 0 and 1 = off, >= 2 = length of the running average (Inst. 13)')
    p_enum(ps, 'CustomCalibration', CALIB, 0, 'Selects the probe calibration (Inst. 14)')
    ps.var('RockerFilter', DT['UInt16'], v_num('UInt16', 0), rw=True, desc='Filter setting, meaning to be clarified with Aber (Inst. 52)')
    p_analog(ps, 'PostCleanPulseBlankingPeriod', 'UInt16', 0, None, (0, 0), 'Blanking time of the measurement after a clean pulse; unit to be clarified (Inst. 71)')
def spectra_params(ps):
    p_enum(ps, 'CellType', CELL, 0, 'Cell type for the fit; sets the range of the internal conductivity (Inst. 223)')
    p_enum(ps, 'DerivedBiomassType', BIOM, 0, 'Unit of the derived biomass (Inst. 224)')
    p_analog(ps, 'MembraneCapacitance', 'Double', 1.0, None, (0, 0), 'Membrane capacitance in uF/cm (Inst. 225)')
    p_analog(ps, 'MinimumFrequency', 'UInt16', 106, U_KHZ, (0, 0), 'Lower frequency limit of the evaluation (Inst. 227)')

TEMPLATES = [
    ('Zero', 'Zeroes the capacitance (Inst. 18 = 1). Single-frequency mode: current capacitance becomes the ZeroValue; scan mode: zero for all scan frequencies.'),
    ('ClearZero', 'Removes zero offsets. Optional property "Scope": All (default), Reading or Scan (Inst. 18 = 2 for the scan zero, 0.0 into Inst. 15 for the reading zero).'),
    ('CleanPulse', 'Triggers a clean pulse (Inst. 17 = 1); PostCleanPulseBlankingPeriod applies afterwards.'),
    ('IncrementAutoclaveCount', 'Increases AutoclaveCycles of the probe by 1 (Inst. 35).'),
    ('SlopeCalibration', 'Sets the slope of the biomass calibration; KeyValue property "BioMassMultiplier" (Double) (Inst. 19).')]
def add_template(pts, name, desc):
    desc = strip_inst(desc)
    t = pts.obj(name, T['ProgramTemplate'], desc=desc)
    dtm = f'<uax:DateTime>{TODAY}T00:00:00Z</uax:DateTime>'
    t.prop('Author', DT['String'], v_str('Aber Instruments'), nsb=4)
    t.prop('Created', DT['DateTime'], dtm, nsb=4)
    t.prop('Description', DT['LocalizedText'], v_lt(desc), nsb=4)
    t.prop('DeviceTemplateId', DT['String'], v_str(name), nsb=4)
    t.prop('Modified', DT['DateTime'], dtm, nsb=4)
    t.prop('Version', DT['String'], v_str('1.0.0'), nsb=4)

# ============================ types
FU_ID, SU_ID = 'ns=5;i=1001', 'ns=5;i=1002'
dev_t = objtype('ns=5;i=1000', 'FuturaConnectDeviceType', T['LADSDevice'], 'Aber Futura Connect Xtra: one device with Probe, FUTURA and SPECTRA components and two FunctionalUnits')
fu_t  = objtype(FU_ID, 'FuturaUnitType', T['FunctionalUnit'], 'FUTURA functional unit: capacitance, conductivity, biomass, temperatures, commands and ProgramManager')
su_t  = objtype(SU_ID, 'SpectraUnitType', T['FunctionalUnit'], 'SPECTRA functional unit: frequency scan and derived values. Stopped, with all functions disabled, if no SPECTRA is installed')
probe_t = objtype('ns=5;i=1003', 'AberProbeType', T['LADSComponent'], 'FUTURA probe')
fe_t  = objtype('ns=5;i=1004', 'FuturaElectronicsType', T['LADSComponent'], 'FUTURA electronics (head amplifier)')
sm_t  = objtype('ns=5;i=1005', 'SpectraModuleType', T['LADSComponent'], 'SPECTRA module; the component exists statically, empty if no SPECTRA is installed')

# FuturaUnitType
state = fu_t.obj('FunctionalUnitState', T['FunctionalUnitState'], nsb=4)
# StartProgram is optional in FunctionalUnitStateMachineType; the FUTURA declares it (same Input/OutputArguments as the standard method) to start the command ProgramTemplates
start_program = Node('UAMethod', 'StartProgram', state, td=None, nsb=4, nid='ns=5;i=7001', desc='Starts one of the ProgramTemplates (Zero, ClearZero, CleanPulse, IncrementAutoclaveCount) with the same behaviour as the corresponding command function')
start_program.extra = ['ns=4;i=6098', 'ns=4;i=6121']
fu_t.obj('Lock', T['Lock'], nsb=1)
fs = fu_t.obj('FunctionSet', T['FunctionSet'], nsb=4)
control_multistate(fs, 'MeasurementMode', MODES, 0, 'Measurement mode (Inst. 1); values as in the register: 0 CellCulture, 1 Bacterial, 2 Microbial, 3 SignalSimulator, 4 Custom, 5 Brewery, 6 Scan')
control_twostate(fs, 'ZeroNow', 'Zero command (Inst. 18 = 1)')
control_twostate(fs, 'ClearZero', 'Clear zero command (Inst. 18 = 2 and 0.0 into Inst. 15)')
control_twostate(fs, 'CleanPulseNow', 'Clean pulse command (Inst. 17 = 1)')
control_twostate(fs, 'IncrementAutoclaveCount', 'Increment autoclave count (Inst. 35)')
sensor_scalar(fs, 'Capacitance', None, (0, 0), True, 'Capacitance at the measuring frequency, polarisation corrected, pF/cm (Inst. 6)')
sensor_scalar(fs, 'Conductivity', U_MS_CM, (0, 0), True, 'Conductivity at the measuring frequency (Inst. 8)')
sensor_scalar(fs, 'BioMassMeasurement', None, (0, 0), True, 'Zeroed and scaled biomass reading: (Capacitance - ZeroValue) x BioMassMultiplier, user defined unit (Inst. 21). In Cell Culture mode the multiplier 1.0 gives 10^6 viable cells/ml (rule of thumb of the manual: 1 pF/cm = 10^6 cells/ml). CalibrationValues: [0] ZeroValue pF/cm (Inst. 15), [1] BioMassMultiplier (Inst. 19)', cal=[0.0, 1.0])
sensor_scalar(fs, 'ProbeTemperature', U_CEL, (0, 0), True, 'Process temperature at the probe (Inst. 23)')
sensor_scalar(fs, 'ElectronicsTemperature', U_CEL, (0, 0), True, 'Temperature of the FUTURA electronics (Inst. 69)')
futura_params(fu_t.obj('ParameterSet', T['BaseObject'], nsb=1))
pm = fu_t.obj('ProgramManager', T['ProgramManager'], nsb=4)
pm.obj('ActiveProgram', T['ActiveProgram'], nsb=4)
pts = pm.obj('ProgramTemplateSet', T['ProgramTemplateSet'], nsb=4)
pts.prop('NodeVersion', DT['String'], v_str('0'))
for n, d in TEMPLATES: add_template(pts, n, d)
rs = pm.obj('ResultSet', T['ResultSet'], nsb=4); rs.prop('NodeVersion', DT['String'], v_str('0'))
sp = fu_t.obj('SupportedPropertiesSet', T['SupportedPropertiesSet'], nsb=4, desc='Properties accepted in the Properties argument of StartProgram')
sp.obj('Scope', T['SupportedProperty'], desc='ClearZero: All (default), Reading or Scan')
sp.obj('BioMassMultiplier', T['SupportedProperty'], desc='SlopeCalibration: slope of the biomass calibration (Double)')

# SpectraUnitType
su_t.obj('FunctionalUnitState', T['FunctionalUnitState'], nsb=4)
su_t.obj('Lock', T['Lock'], nsb=1)
fs = su_t.obj('FunctionSet', T['FunctionSet'], nsb=4)
N = 25
sensor_array(fs, 'ScanFrequencies', U_KHZ, (50, 20000), N, False, 'Frequencies of the last scan, 25 values in kHz (Inst. 76)')
sensor_array(fs, 'ScanCapacitance', None, (0, 0), N, False, 'Capacitance spectrum in pF/cm, index matches ScanFrequencies (Inst. 101, interleaved). CalibrationValues: zero per frequency (Inst. 228)', cal=[0.0] * N)
sensor_array(fs, 'ScanConductivity', U_MS_CM, (0, 0), N, False, 'Conductivity spectrum, index matches ScanFrequencies (Inst. 101, interleaved)')
D = [('CapacitanceRate', None, (0, 0), 'Rate of change of the capacitance, pF/cm per h (Inst. 201)'),
     ('DerivedBiomass', None, (0, 0), 'Biomass derived from the spectrum; unit depends on DerivedBiomassType (Inst. 203). EngineeringUnits are set at run time (g/L: GL, volume fraction: 1, cells/ml: none)'),
     ('CellDiameter', U_UM, (0, 0), 'Estimated cell diameter (Inst. 205)'),
     ('ColeColeAlpha', U_ONE, (0, 1), 'Distribution parameter alpha of the Cole-Cole relaxation (Inst. 207)'),
     ('DeltaCapacitance', None, (0, 0), 'Delta C = C(low frequency) - C(infinity), pF/cm (Inst. 209)'),
     ('CriticalFrequency', U_KHZ, (50, 20000), 'Characteristic frequency of the relaxation (Inst. 211)'),
     ('InternalConductivity', U_MS_CM, (0, 0), 'Conductivity of the cell interior (Inst. 213)'),
     ('SuspensionConductivity', U_MS_CM, (0, 0), 'Conductivity of the suspension (Inst. 215)'),
     ('MediumConductivity', U_MS_CM, (0, 0), 'Conductivity of the medium (Inst. 217)'),
     ('CapacitanceInfinity', None, (0, 0), 'Capacitance at high frequency, pF/cm (Inst. 219)'),
     ('QualityOfFit', U_ONE, (0, 1), 'Coefficient of determination R2 of the Cole-Cole fit (Inst. 221)')]
for n, u, r, d in D: sensor_scalar(fs, n, u, r, False, d)
spectra_params(su_t.obj('ParameterSet', T['BaseObject'], nsb=1))

# components
def comp_common(c, vendor_items, with_sw):
    ident = {'Manufacturer': (DT['LocalizedText'], v_lt('Aber Instruments')), 'Model': (DT['LocalizedText'], v_lt('')), 'SerialNumber': (DT['String'], v_str(''))}
    if with_sw: ident['SoftwareRevision'] = (DT['String'], v_str(''))
    add_ident(c, T['ComponentIdent'], ident)
    c.prop('Model', DT['LocalizedText'], v_lt(''), nsb=1, desc='Model of the component (mandatory)')
    for name, dt, val in vendor_items:
        c.var(name, DT[dt], val, desc='Aber-specific (not defined by LADS, DI or Machinery)')
comp_common(probe_t, [], False)
oc = probe_t.obj('OperationCounters', T['OperationCounters'], nsb=1, rt='HasAddIn', desc='Operating time of the probe (register Probe Total Hours; the server multiplies the hours by 3 600 000)')
oc.prop(PROBE_DURATION, DT['Duration'], '<uax:Double>0</uax:Double>', nsb=1)
lc = probe_t.obj('LifetimeCounters', T['LifetimeCounters'], nsb=3, rt='HasAddIn')
for name, d in (('AutoclaveCycles', 'Counted CIP and autoclave cycles (Inst. 27); limit from Inst. 29 (placeholder 100, to be confirmed)'), ('LeakageDetections', 'Leakages detected on the probe (Inst. 31); limit from Inst. 33 (placeholder 100, to be confirmed)')):
    v = lc.var(name, DT['UInt32'], v_num('UInt32', 0), td=T['LifetimeVariable'], nsb=5, desc=d)
    v.prop('EngineeringUnits', DT['EUInformation'], v_eu(U_ONE))
    v.prop('LimitValue', DT['UInt32'], v_num('UInt32', 100), nsb=1); v.prop('StartValue', DT['UInt32'], v_num('UInt32', 0), nsb=1)
comp_common(fe_t, [('SignalSimulatorConnected', 'Boolean', v_bool(False)), ('BootloaderVersion', 'String', v_str(''))], True)
comp_common(sm_t, [('BootloaderVersion', 'String', v_str('')), ('FirmwareCheckSum', 'UInt32', v_num('UInt32', 0))], True)

# device
for n, dt, v in [('Manufacturer', 'LocalizedText', v_lt('Aber Instruments')), ('Model', 'LocalizedText', v_lt('FUTURA Connect Xtra')),
                 ('SerialNumber', 'String', v_str('')), ('SoftwareRevision', 'String', v_str('')), ('HardwareRevision', 'String', v_str('')),
                 ('DeviceRevision', 'String', v_str('')), ('ProductInstanceUri', 'String', v_str('')), ('AssetId', 'String', v_str('')),
                 ('ComponentName', 'LocalizedText', v_lt('')), ('RevisionCounter', 'Int32', v_num('Int32', 0)),
                 ('DeviceManual', 'String', v_str('Aber Instruments manuals 2819-09-00 / 2390-09-08'))]:
    dev_t.prop(n, DT[dt], v, nsb=1)
dev_t.prop('Location', DT['String'], v_str(''), nsb=3, rw=True, desc='Location of the machine in a scheme specific to the end user (GPS position as text)')
dev_t.prop('HierarchicalLocation', DT['String'], v_str(''), nsb=2, rw=True, desc='Hierarchical location of the device, e.g. FactoryA/BuildingC/Floor1')
dev_t.prop('OperationalLocation', DT['String'], v_str(''), nsb=2, rw=True, desc='Operational location of the device, e.g. Warehouse1/Sheet3')
dev_t.obj('DeviceTypeImage', T['Folder'], nsb=1, desc='Organizes pictures of the device')
add_ident(dev_t, T['MachineIdent'], {'Manufacturer': (DT['LocalizedText'], v_lt('Aber Instruments')), 'Model': (DT['LocalizedText'], v_lt('FUTURA Connect Xtra')),
    'SerialNumber': (DT['String'], v_str('')), 'ProductInstanceUri': (DT['String'], v_str('')), 'SoftwareRevision': (DT['String'], v_str('')),
    'HardwareRevision': (DT['String'], v_str('')), 'DeviceRevision': (DT['String'], v_str('')), 'AssetId': (DT['String'], v_str('')),
    'ComponentName': (DT['LocalizedText'], v_lt('')), 'DeviceManual': (DT['String'], v_str('Aber Instruments manuals 2819-09-00 / 2390-09-08')),
    'RevisionCounter': (DT['Int32'], v_num('Int32', 0)), 'Location': (DT['String'], v_str(''), 3)})
dev_t.obj('DeviceState', T['DeviceState'], nsb=4)
dev_t.var('DeviceHealth', DT['DeviceHealth'], v_num('Int32', 0), nsb=1, desc='NAMUR NE 107: worst DeviceHealth of all active alarms of Probe, Futura and Spectra')
dev_t.var('StatusFlags', DT['UInt16'], v_num('UInt16', 0), nsb=1, desc='FUTURA Status Flags register (Inst. 2): bits 0-4 warnings, 6-7 errors, 9-10 indicators, 12 curve fit error (SPECTRA); the alarms of DeviceHealthAlarms are derived from the bits')
alarms = dev_t.obj('DeviceHealthAlarms', T['Folder'], nsb=1, desc='One alarm per status bit of the StatusFlags register; the alarm source is the affected component (Probe, Futura or Spectra)')
for n, ty, d in [('ProbeTemperatureOutOfRange', 'OffSpec', 'Status bit 2: temperature out of range (severity 300)'),
                 ('ProbeLeakage', 'MaintReq', 'Status bit 3: probe leakage (severity 300)'),
                 ('CleanLeakage', 'MaintReq', 'Status bit 4: clean leakage (severity 300)'),
                 ('ProbeMemoryFileMissing', 'Failure', 'Status bit 7: probe memory, file missing (severity 600)'),
                 ('NoProbe', 'Failure', 'Status bit 9: no probe (severity 600); measurements get Bad_SensorFailure'),
                 ('FuturaCapacitanceOutOfRange', 'OffSpec', 'Status bit 0: capacitance out of range (severity 300)'),
                 ('FuturaConductivityOutOfRange', 'OffSpec', 'Status bit 1: conductivity out of range (severity 300)'),
                 ('FuturaMemoryFileMissing', 'Failure', 'Status bit 6: FUTURA memory, file missing (severity 600)'),
                 ('SpectraCurveFitError', 'OffSpec', 'Status bit 12: Cole-Cole curve fit error (severity 300)')]:
    alarms.obj(n, T[ty], desc=d)
comps = dev_t.obj('Components', T['Components'], nsb=3, rt='HasAddIn')
comps.obj('Probe', probe_t.nid, desc='Probe'); comps.obj('Futura', fe_t.nid, desc='FUTURA electronics'); comps.obj('Spectra', sm_t.nid, desc='SPECTRA module (static; empty if not installed)')
fus = dev_t.obj('FunctionalUnitSet', T['FunctionalUnitSet'], nsb=4)
fus.obj('Futura', FU_ID, desc='FUTURA functional unit'); fus.obj('Spectra', SU_ID, desc='SPECTRA functional unit')


# ============================ completion of the mandatory instance declarations
# OPC UA modelling convention: an instance declaration inside a type must declare again the mandatory children of its type definition
# (and of the instance declaration it overrides in a supertype); a subtype re-declares the mandatory declarations of its supertypes.
# Done recursively until nothing is missing (generators/nodeset_model.py). New NodeIds start at EXPAND_BASE so that all other NodeIds stay stable.
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from nodeset_model import Model, BASE
import os
URIS = [BASE, 'http://opcfoundation.org/UA/DI/', 'http://opcfoundation.org/UA/AMB/', 'http://opcfoundation.org/UA/Machinery/', 'http://opcfoundation.org/UA/LADS/', URI]
REFNAME = {'i=47': 'HasComponent', 'i=46': 'HasProperty', 'i=17604': 'HasAddIn', 'i=35': 'Organizes', 'i=49': 'HasOrderedComponent'}
EXPAND_BASE = 10000
def _tup(s):
    m = re.match(r'ns=(\d+);(.*)', s); return (URIS[int(m.group(1))], m.group(2)) if m else (BASE, s)
def _str(t):
    i = URIS.index(t[0]); return (f'ns={i};' if i else '') + t[1]
def _own_model(base):
    m = Model(); m.nodes = dict(base.nodes)
    for n in Node.allnodes:
        is_type = n.kind == 'UAObjectType'
        m.nodes[_tup(n.nid)] = dict(cls=n.kind, id=_tup(n.nid), name=(URIS[n.nsb], n.bn), rule=n.mr, own=True,
                                    td=None if is_type or not n.td else _tup(n.td), sup=_tup(n.td) if is_type else None,
                                    dt=_tup(n.dt) if n.dt else None, vr=n.vr, ad=n.ad, desc=n.desc, value=n.value, access='3' if n.rw else None,
                                    children=[(k.rt, _tup(k.nid)) for k in n.kids] + [('i=46', _tup(r)) for r in getattr(n, 'extra', [])])
    inv = {v: k for k, v in REFNAME.items()}
    for n in Node.allnodes:
        for k in n.kids: m.nodes[_tup(k.nid)].update(reftype=inv.get(k.rt, 'i=47'), parent=_tup(n.nid))
    return m
def expand_mandatory():
    base = Model()
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
    for f in ['Opc.Ua.NodeSet2.xml', 'Opc.Ua.Di.NodeSet2.xml', 'Opc.Ua.AMB.NodeSet2.xml', 'Opc.Ua.Machinery.NodeSet2.xml', 'Opc.Ua.LADS.NodeSet2.xml']:
        base.load(os.path.join(d, f))
    counter, added = EXPAND_BASE, 0
    for _ in range(25):
        model = _own_model(base)
        gaps = model.gaps()
        if not gaps: break
        byid = {_tup(n.nid): n for n in Node.allnodes}
        for owner, decl, path in gaps:
            counter += 1; added += 1
            n = Node(decl['cls'], decl['name'][1], byid[owner], rt=REFNAME.get(decl.get('reftype'), 'HasComponent'), mr=MR_MAND,
                     td=_str(decl['td']) if decl['td'] else None, nsb=URIS.index(decl['name'][0]),
                     dt=_str(model.data_type(decl)) if decl['cls'] == 'UAVariable' else None, desc=decl.get('desc'),
                     nid=f'ns=5;i={counter}', rw=decl.get('access') == '3', vr=decl.get('vr'), ad=decl.get('ad'), value=v_str('0') if decl['name'][1] == 'NodeVersion' else decl.get('value'))
            if decl['cls'] == 'UAMethod':          # input / output arguments: the properties of the standard method are referenced
                n.extra = [_str(c) for r, c in model.nodes[decl['id']]['children'] if r in ('i=46', 'HasProperty')]
    else:
        raise SystemExit('expand_mandatory: no fixpoint')
    print('expanded', added, 'mandatory instance declarations')
expand_mandatory()

# ============================ output
ALIAS = {'Boolean': 'i=1', 'UInt16': 'i=5', 'Int32': 'i=6', 'UInt32': 'i=7', 'Double': 'i=11', 'String': 'i=12', 'DateTime': 'i=13',
         'LocalizedText': 'i=21', 'Duration': 'i=290', 'EUInformation': 'i=887', 'Range': 'i=884', 'EnumValueType': 'i=7594',
         'HasComponent': 'i=47', 'HasProperty': 'i=46', 'HasSubtype': 'i=45', 'HasTypeDefinition': 'i=40', 'HasModellingRule': 'i=37', 'HasAddIn': 'i=17604', 'Organizes': 'i=35', 'HasOrderedComponent': 'i=49'}
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n')
    f.write('<UANodeSet LastModified="%sT00:00:00Z" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://opcfoundation.org/UA/2011/03/UANodeSet.xsd" xmlns:uax="http://opcfoundation.org/UA/2008/02/Types.xsd" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' % TODAY)
    f.write('    <NamespaceUris>\n' + ''.join(f'        <Uri>{u}</Uri>\n' for u in ['http://opcfoundation.org/UA/DI/', 'http://opcfoundation.org/UA/AMB/', 'http://opcfoundation.org/UA/Machinery/', 'http://opcfoundation.org/UA/LADS/', URI]) + '    </NamespaceUris>\n')
    f.write(f'    <Models>\n        <Model ModelUri="{URI}" PublicationDate="{TODAY}T00:00:00Z" Version="0.1.0">\n')
    for u, d, v in [('http://opcfoundation.org/UA/', '2023-12-15T00:00:00Z', '1.05.03'), ('http://opcfoundation.org/UA/DI/', '2022-11-03T00:00:00Z', '1.04.0'),
                    ('http://opcfoundation.org/UA/AMB/', '2022-11-01T00:00:00Z', '1.01.0'), ('http://opcfoundation.org/UA/Machinery/', '2023-08-01T00:00:00Z', '1.03.0'),
                    ('http://opcfoundation.org/UA/LADS/', '2023-11-30T00:00:00Z', '1.0.0')]:
        f.write(f'            <RequiredModel ModelUri="{u}" PublicationDate="{d}" Version="{v}"/>\n')
    f.write('        </Model>\n    </Models>\n    <Aliases>\n' + ''.join(f'        <Alias Alias="{a}">{i}</Alias>\n' for a, i in ALIAS.items()) + '    </Aliases>\n')
    for n in Node.allnodes: f.write(n.xml())
    f.write('</UANodeSet>\n')
print('written', OUT, len(Node.allnodes), 'nodes')

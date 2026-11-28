# LADS HPLC – test / simulation server (skeleton)

A starting point for a LADS server built on a vendor nodeset, here `nodesets/HPLC.xml`. It shows the usual
initialisation steps of the example servers in one small, generic place; the instrument behaviour is simulated.

```bash
npm run lads-hplc                 # port 4851, uses the instance DeviceSet/AgilentCompactLC of the nodeset
npm run lads-hplc -- -p 4860      # another port
npm run lads-hplc -- --new        # a new instance of HPLCDeviceType instead
npm run lads-hplc -- --no-afo     # without the AFO dictionary (faster start, no ontology references)
```

| File | What it does |
|---|---|
| `src/server.ts` | `createServer` with the nodesets (Base, DI, Machinery, AMB, LADS, HPLC), finds or creates the device below DeviceSet, starts the server (LDS registration, roles, users from `config/lads-users.json`) |
| `src/device.ts` | 1. `DeviceTypeImage.create` (images of `src/resources/images`) · 2. `initComponent` for the device and every component, recursively: DI nameplate copied to the Machinery Identification, ManufacturerUri / ProductInstanceUri · 3. locations: `Identification/Location` (GPS of the site), `HierarchicalLocation` (site, `config/lads-site.json`), `OperationalLocation` (place in the lab) · 4. `LADSDeviceHelper` (Machinery building blocks, event tree, DeviceState, DeviceHealth) · 5. locks · 6. functional units |
| `src/locks.ts` | `DeviceLocks`: device lock (if the nodeset has one) and one `LockImpl` per functional unit with the device lock as parent; `predicate(unit)` for methods, `restrictWriteAccess` for TargetValues |
| `src/unit.ts` | `SimulatedUnitImpl` per functional unit: binds Start / StartProgram / Stop / Abort / Clear (lock → `BadLocked`, state → `BadInvalidState`), adds the program templates, creates a result per run, counts ActiveProgram runtime and steps, Stop after the current step, Abort deletes the result, Clear → Stopped; IsEnabled of every function true |

| `src/simulation.ts` | simulation loop (500 ms) of the HPLC unit: column oven and pump, `Simulator` object below the functional unit |

States: Stopped → Running → (Stopping) → Stopped; Running → Aborting → Aborted → Clearing → Stopped.

## Functional unit state machine

| Method | Skeleton behaviour (`unit.ts`) |
|---|---|
| `Start(Properties)` | manual operation without a program: Running until Stop / Abort, no result; ActiveProgram counts CurrentRuntime; the Properties are kept for the driver (`manualProperties`) |
| `StartProgram(template, properties, job, task, samples)` | program run: result in the ResultSet, steps of the template, Stopped at the end |
| `Stop` | manual: Stopping → Stopped at once; program: after the current step |
| `Abort` | Aborting → Aborted, the result of a program run is deleted |
| `Clear` | Aborted → Clearing → Stopped |

Every method checks the lock of the unit (`BadLocked`) and the state (`BadInvalidState`). The controllers of the
simulation start with Start / StartProgram and stop with the end of the run, Stop and Abort.

## Device helper

`LADSDeviceHelper` (device.ts, step 4) runs the device state machine (Initialization → Operate), follows the functional
units with `MachineryItemState` (Executing while a unit runs, NotExecuting otherwise), binds `GotoProcessing` /
`GotoMaintenance` / `GotoSetup` of `MachineryOperationMode` (role based: Engineer), creates `DeviceHealth` (NORMAL),
adds the device to the Machinery `Machines` folder and builds the event notifier tree. The nodeset declares
`MachineryItemState` and `MachineryOperationMode` below the device, otherwise the helper has nothing to drive.

## Simulation (column oven, pump)

| Function | Behaviour |
|---|---|
| `ColumnOven` (AnalogControlFunction) | PT1 of the oven compartment: towards TargetValue while Running, towards the ambient temperature while Stopped |
| `Pump` (control function, CurrentValue = flow) | flow follows TargetValue with a short PT1 while Running, falls to 0 when Stopped |
| `Pump/Pressure` (AnalogScalarSensorFunction) | SensorValue = flow × flow resistance |
| `Pump/Solvent A`, `Pump/Solvent B` (AnalogControlFunctions) | no commands, TargetValue read-only: TargetValue = pump TargetValue × share, CurrentValue = pump CurrentValue × share (share of B = `PercentageSolventB`, default 10 %; A = the rest), CurrentValue historized; ControlFunctionState follows the pump |
| `Valve` (MultiStateDiscreteControlFunction, Port 12 / 13 / 14) | no Start / Stop; writing TargetValue sets ControlFunctionState to Running, CurrentValue moves one port every 0.5 s towards it, Stopped on arrival |
| `SamplePosition` (MultiStateDiscreteControlFunction, Position 1 … 24) | autosampler tray position, same behaviour as the valve (the injector itself is `SampleInjector`) |
| `SampleInjector` (AnalogControlFunctionWithRelativeTargetValue, volume in µl) | Start runs one injection cycle: Running → aspirate (CurrentValue up to TargetValue with `IncreaseRate`, display name "Aspirate Rate", µl/s) → move the injector from the sample into the HPLC stream (`Injector Move Time`, 2 s) → dispense (CurrentValue down to 0 with `DecreaseRate`, display name "Inject Rate") → Stopped; Stop ends the cycle at once (the volume drawn so far stays); the mandatory `Operational` group of this type organizes state, methods and values |

CurrentValue of the column oven and of the pump and the pressure SensorValue are historized (HistoryRead).

Settable in `HPLCUnit/Simulator`: `Ambient Temperature` [°C] (22), `Oven Time Constant` [s] (60), `Flow Resistance`
[bar per mL/min] (100), `Pump Time Constant` [s] (2), `Injector Move Time` [s] (2), `Dead Volume` [µl] (166.7), `Elution Window` [s] (50), `Detector Noise` [mAU] (0.3). Start values: oven at ambient temperature, set point 40 °C; pump
without flow, set point 1 mL/min, 10 % solvent B; sample injector 50 µl.

Both controllers can be started and stopped on their own (`ControlFunctionState/Start`, `Stop`; the lock of the unit
applies, also to writes of their TargetValue). StartProgram (and Start) of the unit starts the controllers that are not
running; the end of the run, Stop and Abort stop both.

Link to the unit state (as in the viscometer): starting the column oven or the pump by hand sets the functional unit
from Stopped to Running (manual operation; refused with BadInvalidState while the unit is Aborted, Stopping …); when
the last of them is stopped by hand and no run is active, the unit goes back to Stopped. Stop / Abort of the unit in
this state stop the controllers (Stopped / Aborted). During a program run the run owns the unit state: controllers can
be stopped and started by hand without changing it.

To turn the skeleton into a real instrument server: replace `runSteps()` in `unit.ts` by the device driver and fill the
VariableSet / FileSet of the result; add sensor / control functions with the implementations of `@utils`
(`AnalogScalarSensorFunctionImpl`, `AnalogControlFunctionImpl` …); add AFO references (`@afo`) once
`AFO_Dictionary.NodeSet2.xml` is loaded; replace `src/resources/images/default.png` (a drawn placeholder) by product pictures.

Check the nodeset after changes:

```bash
cd nodesets && python3 generators/check_modelling.py HPLC.xml Opc.Ua.NodeSet2.xml Opc.Ua.Di.NodeSet2.xml Opc.Ua.AMB.NodeSet2.xml Opc.Ua.Machinery.NodeSet2.xml Opc.Ua.LADS.NodeSet2.xml
```

## Chromatography (simulated)

`src/chromatography.ts`: after every completed injection the sample reaches the detector after the dead time
t0 = `Dead Volume` / flow (166.7 µl → 10 s at 1 ml/min); its 3 … 8 components elute within the `Elution Window`
(50 s at 1 ml/min, both scale with 1 / flow). Each component is a Lorentz peak with an absorption band:

    signal(t, λ) = h · 1 / (1 + ((t − tR) / w)²) · exp(−(λ − λc)² / (2 σ²))

w is the half width at half maximum (FWHM = 2 w), the area is π · h · w · band(λ). Height, width, retention time and
band (λc 220 … 500 nm, σ 15 … 70 nm) are random per peak. The DAD channels show the sum of all peaks at their
wavelength (DAD1A 250, DAD1B 320, DAD1C 420, DAD1D 480 nm, unit mAU, every 250 ms, historized, `Detector Noise`), DAD1I
the spectrum 190 … 600 nm in 2 nm steps (its `Range` property stays empty: node-opcua cannot write a Range with
ValueRank −2).

The channel wavelengths come from the DAD component: `Components / DAD / Components / DAD1A … DAD1D` are sub-components
of the type `DADChannelType` (HPLC namespace, derived from the LADS `ComponentType`) with the variable `Wavelength`
(AnalogUnitRange, nm, 190 … 950); a channel without a value gets the default above.

## Program run (StartProgram)

The samples of the call are measured one after the other (no samples: one, "Sample 1"): event "Processing sample <id>",
the tray moves to position n (n = index in the list), the injector injects (TargetValue µl), then the chromatogram is
recorded. ActiveProgram: one step per sample (`Sample <id>: moving to Position n / injecting … µl / separation`; the number of peaks is reported only after the separation), runtime
estimate 90 s per sample. Stop ends the run after the current sample, Abort at once (result deleted).

Templates and their optional properties (KeyValue, values 0 … 100 %; an invalid value refuses the start with
BadInvalidArgument):

| Template | Property | Effect |
|---|---|---|
| `Isocratic Run` | `PercentageSolventB` | share of solvent B for the whole run (without it the current value of the pump stays) |
| `Gradient Run` | `GradientStart`, `GradientEnd` (10, 90) | per sample: %B rises linearly from start to end during the separation, back to start for the next sample |

The composition changes the pump's `PercentageSolventB` and thus Solvent A / B; it does not change the simulated peaks.

Result: `VariableSet / <sample id> / Peak n /` `Retention Time` [s], `Height` [mAU], `Width` (FWHM) [s], `Area` [mAU·s]
at the DAD channel with the strongest signal, `Channel` (e.g. "DAD1B (320 nm)") and `Absorption Maximum` [nm].

**ASM** (Allotrope Simple Model, liquid chromatography REC/2026/09, `LiquidChromatographyRecorder` of `lib/asm`): at the end
of every program run the same JSON goes to `VariableSet / ASM` (string) and `FileSet / ASM` (`src/data/results/<run id>.json`):

- device system document: the LC system and its modules (autosampler, pump, column compartment, DAD) with nameplates,
  pump and detector model number;
- one liquid chromatography document per injection (sample), analyst = user of the run, method = template;
- one measurement document per DAD channel (DAD1A … D): sample document (sample id, batch = job-task, tray position),
  injection document (identifier, time, volume), column document (Column 1: name, manufacturer, serial number,
  chemistry), detector settings (wavelength, sampling rate 10 Hz), the chromatogram data cube (retention time [s] →
  absorbance [mAU], noise-free, from the injection to the end of the elution), the peak list at the channel wavelength
  (retention time, area, height, FWHM, start / end = tR ∓ 4 w, relative area / height; peaks below 1 mAU are left out)
  and the conditions at the injection as custom information (flow rate, column temperature, solvent B, dead time).

Check a file with `python3 lib/asm/tools/validate_asm.py <file.json>` (schema in `lib/asm/schemas`, no network needed).

## Allotrope Foundation Ontology (`src/afo.ts`)

With `AFO_Dictionary.NodeSet2.xml` loaded (default) the nodes get `HasDictionaryEntry` references, as in the other
example servers: the LADS defaults (`AFODictionary.addDefaultDeviceReferences`: nameplates, states, functions,
templates) plus chromatography terms, e.g.

| Node | AFO terms |
|---|---|
| device / functional unit | high-performance liquid chromatograph, LC-UV system, chromatograph / high-performance liquid chromatography |
| components | autosampler, pump, column compartment, HPLC column, diode array detector, UV / deuterium / visible lamp, DAD channels (detector, Wavelength: detector wavelength setting) |
| Column Oven | temperature controller, temperature, column compartment (TargetValue: column compartment temperature setting) |
| Pump | pump, flow rate, mobile phase delivery; Flow / PercentageSolventB: pump flow rate / mobile phase ratio setting (chromatography); Pressure: pressure sensor; Solvent A / B: solvent channel, mobile phase |
| Sample Injector / Sample Position / Valve | injection device, injection of chromatography, injection volume setting / autosampler, tray, position / valve |
| DAD channels | chromatographic detector, absorbance (wavelength: detector wavelength setting); DAD1I: absorption spectrum |
| templates / results | LC-UV system method, gradient profile setting / chromatography result |
| result peaks | chromatogram, peak list, chromatography peak, retention time, peak height, peak width at half height, peak area, wavelength, detector identifier |


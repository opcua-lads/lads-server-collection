# LADS HPLC – test / simulation server (skeleton)

A starting point for a LADS server built on a vendor nodeset, here `nodesets/HPLC.xml`. It shows the usual
initialisation steps of the example servers in one small, generic place; the instrument behaviour is simulated.

```bash
npm run lads-hplc                 # port 4851, uses the instance DeviceSet/AgilentCompactLC of the nodeset
npm run lads-hplc -- -p 4860      # another port
npm run lads-hplc -- --new        # a new instance of HPLCDeviceType instead
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
| `Valve` (MultiStateDiscreteControlFunction, Port 12 / 13 / 14) | no Start / Stop; writing TargetValue sets ControlFunctionState to Running, CurrentValue moves one port every 0.5 s towards it, Stopped on arrival |

CurrentValue of the column oven and of the pump and the pressure SensorValue are historized (HistoryRead).

Settable in `HPLCUnit/Simulator`: `Ambient Temperature` [°C] (22), `Oven Time Constant` [s] (60), `Flow Resistance`
[bar per mL/min] (100), `Pump Time Constant` [s] (2). Start values: oven at ambient temperature, set point 40 °C; pump
without flow, set point 1 mL/min.

Both controllers can be started and stopped on their own (`ControlFunctionState/Start`, `Stop`; the lock of the unit
applies, also to writes of their TargetValue). StartProgram (and Start) of the unit starts the controllers that are not
running; the end of the run, Stop and Abort stop both.

To turn the skeleton into a real instrument server: replace `runSteps()` in `unit.ts` by the device driver and fill the
VariableSet / FileSet of the result; add sensor / control functions with the implementations of `@utils`
(`AnalogScalarSensorFunctionImpl`, `AnalogControlFunctionImpl` …); add AFO references (`@afo`) once
`AFO_Dictionary.NodeSet2.xml` is loaded; replace `src/resources/images/default.png` (a drawn placeholder) by product pictures.

Check the nodeset after changes:

```bash
cd nodesets && python3 generators/check_modelling.py HPLC.xml Opc.Ua.NodeSet2.xml Opc.Ua.Di.NodeSet2.xml Opc.Ua.AMB.NodeSet2.xml Opc.Ua.Machinery.NodeSet2.xml Opc.Ua.LADS.NodeSet2.xml
```

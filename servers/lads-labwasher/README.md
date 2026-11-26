# LADS LabWasher simulation server (Miele LabWasher PG 8583)

Test and simulation server for the nodeset `nodesets/LabWasher.xml` (generator `nodesets/generators/gen_labwasher.py`).

```bash
npm run lads-labwasher            # port 4852
npm run lads-labwasher -- -p 4860
```

VS Code: *LADS-LabWasher (Simulator, port 4852)*, also part of the compound *LADS Fleet (LDS + 9 servers)*.

## Files

| File | Content |
|---|---|
| `src/server.ts` | loads Base, DI, Machinery, AMB, LADS and LabWasher.xml, creates `DeviceSet/LabWasher` (LabWasherDeviceType) |
| `src/device.ts` | DeviceTypeImage (`resources/images`), DI + Machinery nameplate of the type plate (Miele, PG 8583, 09960610, SN 000018404821, SW 35913, rev. E), locations, LADSDeviceHelper, locks |
| `src/locks.ts` | device / unit locks (LockImpl), access predicate for methods and writes |
| `src/unit.ts` | FunctionalUnitState (StartProgram, Stop, Abort, Clear), RunningStateMachine, washing simulation, ActiveProgram, result |
| `src/washing.ts` | phases of the 14 washing programs by Miele program number |

## Behaviour

- **StartProgram**: the template by name (`Universal`) or by Miele program number (`49`, the DeviceTemplateId).
  The door must not be open. The call creates a result (samples, properties, job and task ids, copy of the template).
- **Phases**: each phase fills (cold, warm or DI water = purified water, Miele "AD water"), circulates with the spray arms, doses a chemical,
  heats to the set point and holds it, then drains. The times are shortened to seconds.
  - Dispenser pumps: 1 = alkaline cleaner, 2 = neutraliser, 3 = additive.
- **What the program drives**: no function has commands.
  - TemperatureController: target 30 … 95 °C, PT1 heating, Running while heating.
  - DispenserPump1–3: Running while dosing.
  - Conductivity: tap water about 450 µS/cm, with chemicals up to about 900, DI water about 3.
  - SprayArm1–5: Rotating while circulating.
  - Valves ColdWater, WarmWater, DIWater: Opened while filling.
  - Door: Closed → Locking → Locked → Unlocking → Closed.
  - TemperatureController CurrentValue and Conductivity record history.
- **RunningStateMachine**: (Complete → Resetting →) Idle → Starting → Execute → Completing → Complete.
- **ActiveProgram**: CurrentProgramTemplate (NameNodeId), CurrentRuntime, CurrentStepName / Number / Runtime, the
  estimates, and DeviceProgramRunId.
- **Stop** ends after the current phase. **Abort** ends at once: the result is deleted, every function goes off, the unit
  goes Aborted, and **Clear** returns it to Stopped.
- **Result VariableSet**:
  - Max Temperature (°C);
  - A0 Value (s, Σ 10^((T−80)/10)·dt per EN ISO 15883, over the shortened demo time);
  - Final Conductivity (µS/cm).

## Open

- The program phases are typical, not Miele's factory parameters.
- No water volume measurement at the valves yet.
- No AFO references yet.
- No simulator object (for example, to open the door by hand).
- TODO for a real device: a driver via Miele's interface instead of the simulation.

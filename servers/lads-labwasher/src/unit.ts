// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Simulated washing unit of the Miele LabWasher PG 8583 (skeleton):

  - FunctionalUnitState: StartProgram, Stop, Abort, Clear; every call checks the lock (BadLocked) and the state
    (BadInvalidState): Stopped -> Running -> (Stopping) -> Stopped, Running -> Aborting -> Aborted -> Clearing -> Stopped
  - RunningStateMachine (sub state machine of Running): Idle -> Starting -> Execute -> Completing -> Complete; the next
    start goes through Resetting -> Idle
  - StartProgram: the program template by name ("Universal") or by Miele program number (DeviceTemplateId, "49");
    creates a result, runs the phases of the program (washing.ts) and fills ActiveProgram (CurrentProgramTemplate,
    runtimes, step name / number, estimates); Stop ends after the current phase, Abort at once (result deleted)
  - functions: the program drives them, none of them has commands: door locked while running, valves open while
    filling, spray arms rotating while circulating, dispenser pumps dosing, temperature controller heating to the set
    point of the phase (PT1), conductivity following the water and the chemicals
  - result: VariableSet with Max Temperature, A0 Value (disinfection, EN ISO 15883: sum of 10^((T-80)/10) dt) and
    Final Conductivity; Samples / Properties / job and task ids as given
  - TODO for a real instrument: replace the simulation by the device driver (Miele XKM / Miele Professional Connect)
*/

import { CallMethodResultOptions, DataType, ISessionContext, LocalizedText, makeEUInformation, Namespace, StatusCodes, UAObject, UAStateMachineEx, UAVariable, Variant, VariantLike } from "node-opcua"
import { LADSActiveProgram, LADSFunctionalState, LADSFunctionalUnit, LADSProgramTemplate, LADSProperty, LADSResult, LADSSampleInfo } from "@interfaces"
import {
    copyProgramTemplate, createDeviceProgramRunId, createResult, enterAborted, enterClearing, EventSeverity, getDescriptionVariable, getLADSFunctions,
    installVariableHistory, promoteToFiniteStateMachine, raiseEvent, restrictAvailableStatesAndTransitions, setBooleanValue, setDateTimeValue,
    setNumericValue, setPropertiesValue, setSamplesValue, setSessionInformation, setStringValue,
} from "@utils"
import { AccessPredicate } from "./locks"
import { Phase, programPhases, Water } from "./washing"

const TICK_MS = 500
const INLET_TEMPERATURE: { [w in Water]: number } = { ColdWater: 15, WarmWater: 40, AD: 20 }
const INLET_CONDUCTIVITY: { [w in Water]: number } = { ColdWater: 450, WarmWater: 450, AD: 3 }
const AMBIENT = 22
const CELSIUS = makeEUInformation("CEL", "°C", "degree Celsius")
const SECOND = makeEUInformation("SEC", "s", "second")
const MICROSIEMENS_PER_CM = makeEUInformation("H61", "µS/cm", "microsiemens per centimetre")

interface Template { name: string, number: string, node: LADSProgramTemplate }

interface Run {
    template: Template
    phases: Phase[]
    runId: string
    started: Date
    result?: LADSResult
    stopRequested: boolean
    maxTemperature: number
    a0: number
}

/** a LADS control function without commands, driven by the program */
class DrivenController {
    readonly target: UAVariable
    readonly current: UAVariable
    readonly state?: UAStateMachineEx
    constructor(readonly node: UAObject) {
        this.target = node.getChildByName("TargetValue") as UAVariable
        this.current = node.getChildByName("CurrentValue") as UAVariable
        const sm = node.getChildByName("ControlFunctionState")
        if (sm) {
            this.state = promoteToFiniteStateMachine(sm as any)
            restrictAvailableStatesAndTransitions(this.state, ["Running", "Stopped"], [])
            this.state.setState("Stopped")
        }
        installVariableHistory(this.current)
    }
    get value(): number { return Number(this.current?.readValue().value.value ?? 0) }
    set value(v: number) { setNumericValue(this.current, v) }
    setTarget(v: number) { setNumericValue(this.target, v) }
    run(on: boolean) { this.state?.setState(on ? "Running" : "Stopped") }
}

export class WasherUnitImpl {
    readonly name: string
    readonly stateMachine: UAStateMachineEx
    readonly runningState?: UAStateMachineEx
    readonly activeProgram: LADSActiveProgram
    readonly templates: Template[] = []
    private run?: Run

    // functions
    private temperature: DrivenController
    private pumps: DrivenController[] = []
    private conductivity?: UAVariable
    private door?: UAStateMachineEx
    private sprayArms: UAVariable[] = []
    private valves: { [w in Water]?: UAVariable } = {}
    private waterTemperature = AMBIENT
    private conductivityTarget = 0
    private temperatureTarget?: number
    private timer: NodeJS.Timeout

    constructor(readonly unit: LADSFunctionalUnit, private readonly isAccessible: AccessPredicate) {
        this.name = unit.browseName.name!
        const state = unit.functionalUnitState as any
        state.startProgram?.bindMethod(this.startProgram.bind(this))
        state.stop?.bindMethod(this.stop.bind(this))
        state.abort?.bindMethod(this.abort.bind(this))
        state.clear?.bindMethod(this.clear.bind(this))
        this.stateMachine = promoteToFiniteStateMachine(unit.functionalUnitState)
        this.stateMachine.setState(LADSFunctionalState.Stopped)
        const rsm = (unit.functionalUnitState as unknown as UAObject).getChildByName("RunningStateMachine")
        if (rsm) {
            this.runningState = promoteToFiniteStateMachine(rsm as any)
            this.runningState.setState("Idle")
        }
        this.activeProgram = unit.programManager?.activeProgram

        // every function of the unit is available
        for (const fn of getLADSFunctions(unit, true)) setBooleanValue((fn as any).isEnabled as UAVariable, true)

        // functions of the FunctionSet
        const fs = (unit as unknown as UAObject).getChildByName("FunctionSet") as UAObject
        const fn = (name: string) => fs?.getChildByName(name) as UAObject | null
        this.temperature = new DrivenController(fn("TemperatureController")!)
        this.temperature.setTarget(30)
        this.temperature.value = AMBIENT
        for (let i = 1; i <= 3; i++) {
            const p = fn(`DispenserPump${i}`)
            if (!p) continue
            const pump = new DrivenController(p)
            pump.setTarget(10); pump.value = 0
            this.pumps.push(pump)
        }
        this.conductivity = fn("Conductivity")?.getChildByName("SensorValue") as UAVariable | undefined
        if (this.conductivity) { installVariableHistory(this.conductivity); setNumericValue(this.conductivity, 0) }
        const cover = fn("Door")?.getChildByName("CoverState")
        if (cover) {
            this.door = promoteToFiniteStateMachine(cover as any)
            this.door.setState("Closed")
        }
        for (let i = 1; i <= 5; i++) {
            const v = fn(`SprayArm${i}`)?.getChildByName("SensorValue") as UAVariable | null
            if (v) { setBooleanValue(v, false); this.sprayArms.push(v) }
        }
        for (const w of ["ColdWater", "WarmWater", "AD"] as Water[]) {
            const v = fn(w)?.getChildByName("SensorValue") as UAVariable | null
            if (v) { setBooleanValue(v, false); this.valves[w] = v }
        }

        // program templates of the nodeset (name = BrowseName, number = DeviceTemplateId)
        const templateSet = unit.programManager?.programTemplateSet as unknown as UAObject
        for (const t of (templateSet?.getComponents() ?? []) as UAObject[]) {
            const number = String((t.getChildByName("DeviceTemplateId") as UAVariable | null)?.readValue().value.value ?? "")
            this.templates.push({ name: t.browseName.name!, number, node: t as unknown as LADSProgramTemplate })
        }

        this.timer = setInterval(() => this.tick(), TICK_MS)
        console.log(`Unit ${this.name}: ${this.templates.length} washing programs, methods ${["startProgram", "stop", "abort", "clear"].filter(m => state[m]).join(", ")}`)
    }

    private get state(): string { return this.stateMachine.getCurrentState() ?? "" }
    private is(state: LADSFunctionalState) { return this.state.includes(state) }
    private event(message: string, severity = EventSeverity.Info) { raiseEvent(this.unit as unknown as UAObject, message, severity) }

    //---------------------------------------------------------------
    // methods of the FunctionalUnitState
    //---------------------------------------------------------------
    private async startProgram(args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
        if (!this.is(LADSFunctionalState.Stopped)) return { statusCode: StatusCodes.BadInvalidState }
        if (this.door && this.door.getCurrentState()?.includes("Opened")) {
            this.event("Program not started: the door is open", EventSeverity.Warning)
            return { statusCode: StatusCodes.BadInvalidState }
        }
        const id = String(args?.[0]?.value ?? "").trim().toLowerCase()
        const template = this.templates.find(t => t.name.toLowerCase() === id || t.number === id || `${t.number} ${t.name}`.toLowerCase() === id)
        if (!template) return { statusCode: StatusCodes.BadInvalidArgument }
        const phases = programPhases(template.number)

        const properties = ((args[1]?.value as Variant[] | null) ?? []).map(x => x as unknown as LADSProperty)
        const samples = ((args[4]?.value as Variant[] | null) ?? []).map(x => x as unknown as LADSSampleInfo)
        const run: Run = { template, phases, runId: createDeviceProgramRunId(template.name.replace(/[^A-Za-z0-9]/g, "")), started: new Date(), stopRequested: false, maxTemperature: this.waterTemperature, a0: 0 }
        this.run = run

        // result
        const result = createResult(this.unit.programManager.resultSet as unknown as UAObject, run.runId)
        run.result = result
        if (result) {
            setSessionInformation(result, context)
            setStringValue(getDescriptionVariable(result), `Washing program ${template.name} (Miele program ${template.number}), started ${run.started.toISOString()}.`)
            setPropertiesValue(result.properties, properties)
            setSamplesValue(result.samples, samples)
            setStringValue(result.supervisoryJobId, String(args[2]?.value ?? ""))
            setStringValue(result.supervisoryTaskId, String(args[3]?.value ?? ""))
            setStringValue(result.deviceProgramRunId, run.runId)
            setDateTimeValue(result.started, run.started)
            copyProgramTemplate(template.node, result.programTemplate)
        }

        this.event(`Starting ${template.name} (program ${template.number}), run ${run.runId}.`)
        this.stateMachine.setState(LADSFunctionalState.Running)
        this.execute(run)
        return { statusCode: StatusCodes.Good, outputArguments: [new Variant({ dataType: DataType.String, value: run.runId })] }
    }

    private async stop(_args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
        if (!this.is(LADSFunctionalState.Running) || !this.run) return { statusCode: StatusCodes.BadInvalidState }
        this.run.stopRequested = true   // ends after the current phase (drained)
        this.stateMachine.setState(LADSFunctionalState.Stopping)
        this.event(`Stopping run ${this.run.runId} after the current phase.`)
        return { statusCode: StatusCodes.Good }
    }

    private async abort(_args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
        if (!(this.is(LADSFunctionalState.Running) || this.is(LADSFunctionalState.Stopping)) || !this.run) return { statusCode: StatusCodes.BadInvalidState }
        const run = this.run
        this.run = undefined
        if (run.result) run.result.namespace.deleteNode(run.result as unknown as UAObject)
        this.allOff()
        this.door?.setState("Closed")
        this.runningState?.setState("Idle")
        this.stateMachine.setState(LADSFunctionalState.Aborting)
        enterAborted(this.stateMachine, this.unit as unknown as UAObject, `Aborted run ${run.runId}.`)   // Aborting -> Aborted
        return { statusCode: StatusCodes.Good }
    }

    private async clear(_args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
        if (!this.is(LADSFunctionalState.Aborted)) return { statusCode: StatusCodes.BadInvalidState }
        enterClearing(this.stateMachine, this.unit as unknown as UAObject)   // Aborted -> Clearing -> Stopped
        return { statusCode: StatusCodes.Good }
    }

    //---------------------------------------------------------------
    // simulation (TODO: device driver)
    //---------------------------------------------------------------
    /** physics every tick: water temperature (PT1 to the set point while heating, slow cooling otherwise), conductivity, A0 */
    private tick() {
        const dt = TICK_MS / 1000
        if (this.temperatureTarget !== undefined) {
            this.waterTemperature += (this.temperatureTarget + 1.5 - this.waterTemperature) * dt / 4   // heater overshoots the set point a little
            this.waterTemperature = Math.min(this.waterTemperature, this.temperatureTarget + 0.3)
        } else {
            this.waterTemperature += (AMBIENT - this.waterTemperature) * dt / 120
        }
        this.temperature.value = +(this.waterTemperature + (Math.random() - 0.5) * 0.1).toFixed(2)
        if (this.conductivity) {
            const c = Number(this.conductivity.readValue().value.value ?? 0)
            setNumericValue(this.conductivity, +(c + (this.conductivityTarget - c) * dt / 1.5).toFixed(2))
        }
        const run = this.run
        if (run) {
            run.maxTemperature = Math.max(run.maxTemperature, this.waterTemperature)
            run.a0 += Math.pow(10, (this.waterTemperature - 80) / 10) * dt
        }
    }

    private allOff() {
        this.temperatureTarget = undefined
        this.temperature.run(false)
        for (const p of this.pumps) { p.run(false); p.value = 0 }
        for (const v of this.sprayArms) setBooleanValue(v, false)
        for (const v of Object.values(this.valves)) setBooleanValue(v!, false)
    }

    private sleep(ms: number, run: Run): Promise<boolean> {
        return new Promise(resolve => setTimeout(() => resolve(this.run === run), ms))
    }

    /** waits until cond() or the time is over; false if the run was aborted */
    private async waitFor(cond: () => boolean, maxMs: number, run: Run): Promise<boolean> {
        const t0 = Date.now()
        while (Date.now() - t0 < maxMs && !cond()) if (!await this.sleep(TICK_MS, run)) return false
        return this.run === run
    }

    private async execute(run: Run) {
        const ap = this.activeProgram
        const total = run.phases.reduce((s, p) => s + p.estimatedMs, 0)
        setStringValue(ap?.deviceProgramRunId, run.runId)
        setNumericValue(ap?.estimatedRuntime, total)
        setNumericValue(ap?.estimatedStepNumbers, run.phases.length)
        setNumericValue(ap?.currentRuntime, 0)
        this.setCurrentTemplate(run.template)

        // RunningStateMachine: (Complete -> Resetting ->) Idle -> Starting -> Execute
        if (this.runningState?.getCurrentState()?.includes("Complete")) {
            this.runningState.setState("Resetting")
            if (!await this.sleep(500, run)) return
        }
        this.runningState?.setState("Idle")
        this.runningState?.setState("Starting")
        this.door?.setState("Locking")
        if (!await this.sleep(1000, run)) return
        this.door?.setState("Locked")
        this.runningState?.setState("Execute")

        const t0 = Date.now()
        let stepStart = t0
        const clock = setInterval(() => {
            if (this.run !== run) return clearInterval(clock)
            setNumericValue(ap?.currentRuntime, Date.now() - t0)
            setNumericValue(ap?.currentStepRuntime, Date.now() - stepStart)
        }, TICK_MS)

        for (let i = 0; i < run.phases.length; i++) {
            if (run.stopRequested) break
            const phase = run.phases[i]
            stepStart = Date.now()
            setNumericValue(ap?.currentStepNumber, i + 1)
            setNumericValue(ap?.estimatedStepRuntime, phase.estimatedMs)
            ap?.currentStepName?.setValueFromSource({ dataType: DataType.LocalizedText, value: new LocalizedText({ text: phase.name }) })
            this.event(`${run.template.name}: phase ${i + 1}/${run.phases.length} ${phase.name}${phase.temperature ? ` (${phase.temperature} °C)` : ""}.`)
            if (!await this.runPhase(phase, run)) return clearInterval(clock)   // aborted
        }
        clearInterval(clock)
        if (this.run !== run) return

        // Completing -> Complete, door unlocked, result, Stopped
        this.runningState?.setState("Completing")
        this.door?.setState("Unlocking")
        if (!await this.sleep(1000, run)) return
        this.door?.setState("Closed")
        this.runningState?.setState("Complete")
        this.finish(run)
    }

    /** fill, circulate (dosing, heating, holding), drain */
    private async runPhase(phase: Phase, run: Run): Promise<boolean> {
        // fill
        if (phase.water) {
            const valve = this.valves[phase.water]
            if (valve) setBooleanValue(valve, true)
            this.waterTemperature = INLET_TEMPERATURE[phase.water] * 0.8 + this.waterTemperature * 0.2   // fresh water mixes with the remaining water
            this.conductivityTarget = INLET_CONDUCTIVITY[phase.water]
            if (!await this.sleep(phase.fillMs, run)) return false
            if (valve) setBooleanValue(valve, false)
        }
        if (phase.drainOnly) {
            if (!await this.sleep(phase.circulateMs, run)) return false
            this.conductivityTarget = 0
            return true
        }

        // circulate: spray arms, dosing, heating
        for (const v of this.sprayArms) setBooleanValue(v, true)
        if (phase.dosing) {
            const pump = this.pumps[phase.dosing.pump - 1]
            if (pump) {
                pump.setTarget(phase.dosing.rate)
                pump.run(true); pump.value = phase.dosing.rate
                this.conductivityTarget += phase.dosing.conductivity
                await this.sleep(3000, run)
                pump.run(false); pump.value = 0
                if (this.run !== run) return false
            }
        }
        if (phase.temperature) {
            this.temperature.setTarget(phase.temperature)
            this.temperature.run(true)
            this.temperatureTarget = phase.temperature
            if (!await this.waitFor(() => this.waterTemperature >= phase.temperature! - 0.5, 60000, run)) return false
            this.event(`${phase.name}: ${phase.temperature} °C reached, holding ${(phase.holdMs / 1000).toFixed(0)} s.`)
            if (!await this.sleep(phase.holdMs, run)) return false
            this.temperatureTarget = undefined
            this.temperature.run(false)
        } else if (!await this.sleep(phase.circulateMs, run)) return false

        // drain
        for (const v of this.sprayArms) setBooleanValue(v, false)
        if (!await this.sleep(phase.drainMs, run)) return false
        return true
    }

    private setCurrentTemplate(template: Template) {
        const v = this.activeProgram?.currentProgramTemplate as unknown as UAVariable | undefined
        if (!v) return
        try {
            const value = v.addressSpace.constructExtensionObject(v.dataType, { name: template.name, nodeId: (template.node as unknown as UAObject).nodeId })
            v.setValueFromSource({ dataType: DataType.ExtensionObject, value })
        } catch (err) {
            console.warn("CurrentProgramTemplate not set:", (err as Error).message)
        }
    }

    private finish(run: Run) {
        if (run.result) {
            setDateTimeValue(run.result.stopped, new Date())
            this.addResultValues(run)
        }
        this.allOff()
        this.run = undefined
        this.stateMachine.setState(LADSFunctionalState.Stopped)
        this.event(`${run.template.name} ${run.stopRequested ? "stopped" : "completed"}: max ${run.maxTemperature.toFixed(1)} °C, A0 ${run.a0.toFixed(1)} s.`)
    }

    /** VariableSet: Max Temperature, A0 Value, Final Conductivity */
    private addResultValues(run: Run) {
        const variableSet = run.result?.variableSet as unknown as UAObject | undefined
        if (!variableSet) return
        const ns = variableSet.namespace as Namespace
        const add = (name: string, value: number, eu: any, high: number) => ns.addAnalogDataItem({
            componentOf: variableSet, browseName: name.replace(/ /g, ""), displayName: name, dataType: "Double",
            engineeringUnits: eu, engineeringUnitsRange: { low: 0, high },
            value: { dataType: DataType.Double, value },
        })
        add("Max Temperature", +run.maxTemperature.toFixed(2), CELSIUS, 100)
        add("A0 Value", +run.a0.toFixed(2), SECOND, Math.max(100, run.a0 * 2))
        add("Final Conductivity", +Number(this.conductivity?.readValue().value.value ?? 0).toFixed(2), MICROSIEMENS_PER_CM, 1000)
    }
}

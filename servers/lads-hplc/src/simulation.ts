// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Simulation loop of the HPLC unit: column oven and pump.

  - Simulator object (programmatic, below the functional unit, as in the other example servers) with the settable
    simulation parameters: Ambient Temperature, Oven Time Constant, Flow Resistance, Pump Time Constant
  - ColumnOven (AnalogControlFunction): PT1 behaviour of the oven compartment,
        dT/dt = (T_target - T) / tau   while the controller runs,
        dT/dt = (T_ambient - T) / tau  while it is stopped (the compartment cools down to the ambient temperature)
  - Pump (control function, CurrentValue = flow): the flow follows the TargetValue with a short PT1 while running and
    falls to 0 when stopped; the sensor value of its sub-function Pressure = flow × flow resistance
  - Pump (AnalogControlFunctionWithComposedTargetValue): the partial target values of its TargetValueSet are written by
    clients (TargetValue itself is read-only); Flow is the flow set point and is copied to TargetValue, PercentageSolventB
    is kept for the gradient (not simulated yet)
  - Pump sub-functions Solvent A / Solvent B (AnalogControlFunctions below Pump/FunctionSet): no commands, TargetValue
    read-only; TargetValue = pump TargetValue × share, CurrentValue = pump CurrentValue × share (share of B =
    PercentageSolventB, default 10 %, A = the rest), CurrentValue historized; ControlFunctionState = that of the pump
  - CurrentValue of the column oven and of the pump are historized (HistoryRead), as the pressure SensorValue
  - Valve (ports) and SamplePosition (24 tray positions), both MultiStateDiscreteControlFunctions: no Start / Stop; a write
    of TargetValue sets ControlFunctionState to Running, CurrentValue moves one position every 0.5 s towards TargetValue,
    then Stopped
  - SampleInjector (AnalogControlFunctionWithRelativeTargetValue, volume in µl): Start runs one injection cycle:
    Running -> aspirate (CurrentValue up to TargetValue with IncreaseRate) -> move the injector from the sample into the
    HPLC stream (Injector Move Time, 2 s) -> dispense (CurrentValue down to 0 with DecreaseRate) -> Stopped. Stop ends the
    cycle at once
  - both controllers can be started and stopped individually; linked to the unit as in the viscometer: a start by hand
    sets the unit from Stopped to Running (refused while the unit is Aborted, Stopping ...), stopping the last of them by
    hand without a run sets it back to Stopped (SimulatedUnitImpl.controllerStartedByHand / controllerStoppedByHand) (ControlFunctionState Start / Stop, lock of the unit
    checked); they are started together with a program run of the unit and stopped when the run ends, is stopped or aborted
*/

import { AccessLevelFlag, CallMethodResultOptions, DataType, ISessionContext, StatusCodes, UAObject, UAVariable, VariantLike } from "node-opcua"
import { LADSAnalogControlFunction, LADSFunctionalUnit } from "@interfaces"
import { AnalogControlFunctionImpl, AnalogScalarSensorFunctionImpl, EventSeverity, getNumericValue, installVariableHistory, promoteToFiniteStateMachine, raiseEvent, restrictAvailableStatesAndTransitions, setNumericValue } from "@utils"
import { AccessPredicate, restrictWriteAccess } from "./locks"

/** the unit side of the link (SimulatedUnitImpl) */
export interface UnitLink { controllerStartedByHand(controller: string): boolean; controllerStoppedByHand(): void }

const TICK_MS = 500
const VALVE_STEP_MS = 500

export class HPLCSimulation {
    readonly oven?: AnalogControlFunctionImpl
    readonly pump?: AnalogControlFunctionImpl
    readonly pressure?: AnalogScalarSensorFunctionImpl
    readonly injector?: AnalogControlFunctionImpl
    private percentB?: UAVariable
    private solvents: { share: (b: number) => number, target: UAVariable, current: UAVariable, state: any }[] = []
    private increaseRate?: UAVariable
    private decreaseRate?: UAVariable
    /** phase of the injection cycle of the sample injector (undefined while its controller is stopped) */
    private injection?: { phase: "aspirate" | "move" | "dispense", since: number }
    readonly parameters: { [name: string]: UAVariable } = {}
    private timer: NodeJS.Timeout
    /** set by the device: the functional unit whose state follows the linked controllers (column oven, pump) */
    unitLink?: UnitLink

    constructor(readonly unit: LADSFunctionalUnit, private readonly isAccessible: AccessPredicate) {
        const fs = (unit as unknown as UAObject).getChildByName("FunctionSet") as UAObject
        const ovenNode = fs?.getChildByName("ColumnOven") as unknown as LADSAnalogControlFunction
        const pumpNode = fs?.getChildByName("Pump") as unknown as LADSAnalogControlFunction
        const pressureNode = (pumpNode as unknown as UAObject)?.getChildByName("FunctionSet")?.getChildByName("Pressure")
        if (ovenNode) this.oven = this.controller(ovenNode, true)
        if (pumpNode) this.pump = this.controller(pumpNode, true)
        if (pressureNode) this.pressure = new AnalogScalarSensorFunctionImpl(pressureNode as any)   // historizes its SensorValue
        for (const c of [this.oven, this.pump]) if (c) installVariableHistory(c.currentValue as unknown as UAVariable)
        for (const name of ["Valve", "SamplePosition"]) {
            const node = fs?.getChildByName(name) as UAObject | null
            if (node) this.installStepper(node)
        }
        const injectorNode = fs?.getChildByName("SampleInjector") as unknown as LADSAnalogControlFunction
        if (injectorNode) this.injector = this.installDosing(injectorNode)

        // simulator object with the settable parameters
        const ns = (unit as unknown as UAObject).namespace
        const simulator = ns.addObject({ componentOf: unit as unknown as UAObject, browseName: "Simulator", description: "Simulation of the column oven (PT1) and of the pump pressure (flow × flow resistance)." })
        const add = (name: string, value: number, description: string) => {
            this.parameters[name] = ns.addVariable({
                componentOf: simulator, browseName: name, description, dataType: DataType.Double,
                value: { dataType: DataType.Double, value },
                accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite, userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
            })
        }
        add("Ambient Temperature", 22, "Ambient temperature of the lab [°C]: the oven compartment cools down to it while the column oven is stopped")
        add("Oven Time Constant", 60, "Time constant of the oven compartment [s] (PT1)")
        add("Flow Resistance", 100, "Flow resistance of the column [bar per mL/min]: pressure = flow × flow resistance")
        add("Pump Time Constant", 2, "Time constant of the pump flow [s] (PT1)")
        add("Injector Move Time", 2, "Time the sample injector needs to move from the sample into the HPLC stream [s]")

        // start values: oven at ambient temperature, pump without flow; sensible set points if the nodeset has none
        const ambient = this.param("Ambient Temperature")
        if (this.oven) {
            setNumericValue(this.oven.currentValue, ambient)
            if (!getNumericValue(this.oven.targetValue)) setNumericValue(this.oven.targetValue, 40)
        }
        if (this.pump) {
            setNumericValue(this.pump.currentValue, 0)
            if (!getNumericValue(this.pump.targetValue)) setNumericValue(this.pump.targetValue, 1.0)
            this.installComposedTargetValue(pumpNode as unknown as UAObject)
            this.installSolvents(pumpNode as unknown as UAObject)
        }
        if (this.pressure) setNumericValue(this.pressure.sensorValue, 0)
        console.log(`Simulation: oven ${this.oven ? "yes" : "no"}, pump ${this.pump ? "yes" : "no"}, pressure ${this.pressure ? "yes" : "no"}`)

        let last = Date.now()
        this.timer = setInterval(() => { const now = Date.now(); this.evaluate((now - last) / 1000); last = now }, TICK_MS)
    }

    /** control function with lock check on Start / Stop and on writes of its TargetValue */
    private controller(node: LADSAnalogControlFunction, linked = false): AnalogControlFunctionImpl {
        const impl = new AnalogControlFunctionImpl(node)
        impl.stateMachine.setState("Stopped")
        const state = node.controlFunctionState as any
        const name = (node as unknown as UAObject).getDisplayName()
        state.start?.bindMethod(async (_args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> => {
            if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
            if (this.running(impl)) return { statusCode: StatusCodes.BadInvalidState }
            if (linked && this.unitLink && !this.unitLink.controllerStartedByHand(name)) return { statusCode: StatusCodes.BadInvalidState }
            this.start(impl, `${name} started`)
            return { statusCode: StatusCodes.Good }
        })
        state.stop?.bindMethod(async (_args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> => {
            if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
            if (!this.running(impl)) return { statusCode: StatusCodes.BadInvalidState }
            this.stop(impl, `${name} stopped`)
            if (linked) this.unitLink?.controllerStoppedByHand()
            return { statusCode: StatusCodes.Good }
        })
        restrictWriteAccess(node.targetValue as unknown as UAVariable, this.isAccessible)
        return impl
    }

    /**
     * MultiStateDiscreteControlFunction that moves stepwise (valve ports, autosampler positions): no Start / Stop; a new
     * TargetValue sets ControlFunctionState to Running, CurrentValue moves one position every 0.5 s towards it, then
     * Stopped. A new TargetValue while moving changes the goal.
     */
    private installStepper(valve: UAObject) {
        const target = valve.getChildByName("TargetValue") as UAVariable
        const current = valve.getChildByName("CurrentValue") as UAVariable
        const state = valve.getChildByName("ControlFunctionState") as UAObject
        if (!target || !current || !state) return
        const sm = promoteToFiniteStateMachine(state as any)
        sm.setState("Stopped")
        restrictAvailableStatesAndTransitions(sm, ["Running", "Stopped"], [])
        restrictWriteAccess(target, this.isAccessible)   // the lock of the unit applies
        const value = (v: UAVariable) => Number(v.readValue().value.value ?? 0)
        const dataType = current.readValue().value.dataType || DataType.UInt32
        if (current.readValue().value.value == null) current.setValueFromSource({ dataType, value: 0 })
        if (target.readValue().value.value == null) target.setValueFromSource({ dataType, value: 0 })
        const ports = ((current.getChildByName("EnumStrings") as UAVariable)?.readValue().value.value as { text: string }[] | null) ?? []
        const label = (i: number) => ports[i]?.text ?? String(i)
        let timer: NodeJS.Timeout | undefined
        const step = () => {
            const goal = value(target), now = value(current)
            const next = now === goal ? now : now + Math.sign(goal - now)
            if (next !== now) current.setValueFromSource({ dataType, value: next })
            if (next === goal) {   // arrived: Stopped at once
                timer = undefined
                sm.setState("Stopped")
                raiseEvent(valve, `${valve.getDisplayName()} at ${label(goal)}`, EventSeverity.Info)
                return
            }
            timer = setTimeout(step, VALVE_STEP_MS)
        }
        target.on("value_changed", () => {
            if (timer || value(target) === value(current)) return
            sm.setState("Running")
            raiseEvent(valve, `${valve.getDisplayName()} moving from ${label(value(current))} to ${label(value(target))}`, EventSeverity.Info)
            timer = setTimeout(step, VALVE_STEP_MS)
        })
    }

    /** SampleInjector dosing: controller (Start / Stop, lock) and rates */
    private installDosing(node: LADSAnalogControlFunction): AnalogControlFunctionImpl {
        const impl = this.controller(node)
        const obj = node as unknown as UAObject
        this.increaseRate = obj.getChildByName("IncreaseRate") as UAVariable | null ?? undefined
        this.decreaseRate = obj.getChildByName("DecreaseRate") as UAVariable | null ?? undefined
        for (const [v, d] of [[this.increaseRate, 5], [this.decreaseRate, 10]] as [UAVariable | undefined, number][]) {
            if (!v) continue
            restrictWriteAccess(v, this.isAccessible)
            if (!getNumericValue(v)) setNumericValue(v, d)
        }
        setNumericValue(impl.currentValue, 0)
        if (!getNumericValue(impl.targetValue)) setNumericValue(impl.targetValue, 50)   // default injection volume 50 µl
        return impl
    }

    /** Solvent A / B below the pump: read-only shares of the pump flow, state = pump state, history of CurrentValue */
    private installSolvents(pump: UAObject) {
        const fs = pump.getChildByName("FunctionSet") as UAObject | null
        for (const [name, share] of [["SolventA", (b: number) => 1 - b / 100], ["SolventB", (b: number) => b / 100]] as [string, (b: number) => number][]) {
            const node = fs?.getChildByName(name) as UAObject | null
            if (!node) continue
            const target = node.getChildByName("TargetValue") as UAVariable
            const current = node.getChildByName("CurrentValue") as UAVariable
            const state = promoteToFiniteStateMachine(node.getChildByName("ControlFunctionState") as any)
            restrictAvailableStatesAndTransitions(state, ["Running", "Stopped"], [])
            state.setState("Stopped")
            setNumericValue(current, 0)
            installVariableHistory(current)
            this.solvents.push({ share, target, current, state })
        }
    }

    /** composed target value of the pump: Flow (TargetValueSet) -> TargetValue; partial values follow the lock of the unit */
    private installComposedTargetValue(pump: UAObject) {
        const set = pump.getChildByName("TargetValueSet") as UAObject | null
        if (!set || !this.pump) return
        const flow = set.getChildByName("Flow") as UAVariable | null
        const percentB = set.getChildByName("PercentageSolventB") as UAVariable | null
        for (const v of [flow, percentB]) restrictWriteAccess(v, this.isAccessible)
        if (percentB && !getNumericValue(percentB)) setNumericValue(percentB, 10)   // default: 10 % solvent B
        this.percentB = percentB ?? undefined
        if (flow) {
            setNumericValue(flow, getNumericValue(this.pump.targetValue))
            flow.on("value_changed", () => setNumericValue(this.pump!.targetValue, getNumericValue(flow)))
        }
    }

    private running(c: AnalogControlFunctionImpl): boolean { return (c.stateMachine.getCurrentState() ?? "").includes("Running") }
    private start(c: AnalogControlFunctionImpl, message: string) { c.enterStart(); raiseEvent(c.controlFunction as unknown as UAObject, message, EventSeverity.Info) }
    private stop(c: AnalogControlFunctionImpl, message: string) { c.enterStop(); raiseEvent(c.controlFunction as unknown as UAObject, message, EventSeverity.Info) }
    private param(name: string): number { return getNumericValue(this.parameters[name]) }

    /** with a program run of the unit: both controllers start (those not running yet) */
    startControllers() { for (const c of [this.oven, this.pump]) if (c && !this.running(c)) this.start(c, `${c.controlFunction.getDisplayName()} started with the run`) }
    anyControllerRunning(): boolean { return [this.oven, this.pump].some(c => c && this.running(c)) }

    /** end, stop or abort of the run: both controllers stop */
    stopControllers() { for (const c of [this.oven, this.pump]) if (c && this.running(c)) this.stop(c, `${c.controlFunction.getDisplayName()} stopped with the run`) }

    private evaluate(dt: number) {
        const pt1 = (value: number, target: number, tau: number) => value + (target - value) * Math.min(1, dt / Math.max(tau, 1e-3))
        if (this.oven) {
            const target = this.running(this.oven) ? getNumericValue(this.oven.targetValue) : this.param("Ambient Temperature")
            setNumericValue(this.oven.currentValue, pt1(getNumericValue(this.oven.currentValue), target, this.param("Oven Time Constant")))
        }
        if (this.pump) {
            const target = this.running(this.pump) ? getNumericValue(this.pump.targetValue) : 0
            const flow = pt1(getNumericValue(this.pump.currentValue), target, this.param("Pump Time Constant"))
            setNumericValue(this.pump.currentValue, flow < 1e-4 ? 0 : flow)
            if (this.pressure) setNumericValue(this.pressure.sensorValue, flow * this.param("Flow Resistance"))
            const b = getNumericValue(this.percentB), pumpState = this.running(this.pump) ? "Running" : "Stopped"
            for (const s of this.solvents) {
                setNumericValue(s.target, getNumericValue(this.pump.targetValue) * s.share(b))
                setNumericValue(s.current, (flow < 1e-4 ? 0 : flow) * s.share(b))
                if (!(s.state.getCurrentState() ?? "").includes(pumpState)) s.state.setState(pumpState)   // follows the pump
            }
        }
        if (this.injector) this.evaluateInjection(dt)
    }

    /** one injection cycle per Start: aspirate -> move injector -> dispense -> Stopped */
    private evaluateInjection(dt: number) {
        const as = this.injector!
        if (!this.running(as)) { this.injection = undefined; return }   // stopped (also by Stop during a cycle)
        const obj = as.controlFunction as unknown as UAObject
        const enter = (phase: "aspirate" | "move" | "dispense", message: string) => {
            this.injection = { phase, since: Date.now() }
            raiseEvent(obj, message, EventSeverity.Info)
        }
        if (!this.injection) enter("aspirate", `${obj.getDisplayName()}: aspirating ${getNumericValue(as.targetValue)} µl`)
        const current = getNumericValue(as.currentValue)
        const ramp = (goal: number, rate: number) => {   // one step towards goal; true when it is reached
            const step = Math.max(0, rate) * dt
            const next = Math.abs(goal - current) <= step ? goal : current + Math.sign(goal - current) * step
            if (next !== current) setNumericValue(as.currentValue, next)
            return next === goal
        }
        switch (this.injection!.phase) {
            case "aspirate":
                if (ramp(getNumericValue(as.targetValue), getNumericValue(this.increaseRate))) enter("move", `${obj.getDisplayName()}: moving the injector into the HPLC stream`)
                break
            case "move":
                if (Date.now() - this.injection!.since >= this.param("Injector Move Time") * 1000) enter("dispense", `${obj.getDisplayName()}: dispensing ${current} µl`)
                break
            case "dispense":
                if (ramp(0, getNumericValue(this.decreaseRate))) {
                    this.injection = undefined
                    this.stop(as, `${obj.getDisplayName()}: injection done`)
                }
                break
        }
    }

    dispose() { clearInterval(this.timer) }
}

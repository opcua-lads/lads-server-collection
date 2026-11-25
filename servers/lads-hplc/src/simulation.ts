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
  - CurrentValue of the column oven and of the pump are historized (HistoryRead), as the pressure SensorValue
  - Valve (MultiStateDiscreteControlFunction, ports): no Start / Stop; a write of TargetValue sets ControlFunctionState
    to Running, CurrentValue moves one position every 0.5 s towards TargetValue, then Stopped
  - both controllers can be started and stopped individually (ControlFunctionState Start / Stop, lock of the unit
    checked); they are started together with a program run of the unit and stopped when the run ends, is stopped or aborted
*/

import { AccessLevelFlag, CallMethodResultOptions, DataType, ISessionContext, StatusCodes, UAObject, UAVariable, VariantLike } from "node-opcua"
import { LADSAnalogControlFunction, LADSFunctionalUnit } from "@interfaces"
import { AnalogControlFunctionImpl, AnalogScalarSensorFunctionImpl, EventSeverity, getNumericValue, installVariableHistory, promoteToFiniteStateMachine, raiseEvent, restrictAvailableStatesAndTransitions, setNumericValue } from "@utils"
import { AccessPredicate, restrictWriteAccess } from "./locks"

const TICK_MS = 500
const VALVE_STEP_MS = 500

export class HPLCSimulation {
    readonly oven?: AnalogControlFunctionImpl
    readonly pump?: AnalogControlFunctionImpl
    readonly pressure?: AnalogScalarSensorFunctionImpl
    readonly parameters: { [name: string]: UAVariable } = {}
    private timer: NodeJS.Timeout

    constructor(readonly unit: LADSFunctionalUnit, private readonly isAccessible: AccessPredicate) {
        const fs = (unit as unknown as UAObject).getChildByName("FunctionSet") as UAObject
        const ovenNode = fs?.getChildByName("ColumnOven") as unknown as LADSAnalogControlFunction
        const pumpNode = fs?.getChildByName("Pump") as unknown as LADSAnalogControlFunction
        const pressureNode = (pumpNode as unknown as UAObject)?.getChildByName("FunctionSet")?.getChildByName("Pressure")
        if (ovenNode) this.oven = this.controller(ovenNode)
        if (pumpNode) this.pump = this.controller(pumpNode)
        if (pressureNode) this.pressure = new AnalogScalarSensorFunctionImpl(pressureNode as any)   // historizes its SensorValue
        for (const c of [this.oven, this.pump]) if (c) installVariableHistory(c.currentValue as unknown as UAVariable)
        const valveNode = fs?.getChildByName("Valve") as UAObject | null
        if (valveNode) this.installValve(valveNode)

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
        }
        if (this.pressure) setNumericValue(this.pressure.sensorValue, 0)
        console.log(`Simulation: oven ${this.oven ? "yes" : "no"}, pump ${this.pump ? "yes" : "no"}, pressure ${this.pressure ? "yes" : "no"}`)

        let last = Date.now()
        this.timer = setInterval(() => { const now = Date.now(); this.evaluate((now - last) / 1000); last = now }, TICK_MS)
    }

    /** control function with lock check on Start / Stop and on writes of its TargetValue */
    private controller(node: LADSAnalogControlFunction): AnalogControlFunctionImpl {
        const impl = new AnalogControlFunctionImpl(node)
        impl.stateMachine.setState("Stopped")
        const state = node.controlFunctionState as any
        const name = (node as unknown as UAObject).getDisplayName()
        state.start?.bindMethod(async (_args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> => {
            if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
            if (this.running(impl)) return { statusCode: StatusCodes.BadInvalidState }
            this.start(impl, `${name} started`)
            return { statusCode: StatusCodes.Good }
        })
        state.stop?.bindMethod(async (_args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> => {
            if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
            if (!this.running(impl)) return { statusCode: StatusCodes.BadInvalidState }
            this.stop(impl, `${name} stopped`)
            return { statusCode: StatusCodes.Good }
        })
        restrictWriteAccess(node.targetValue as unknown as UAVariable, this.isAccessible)
        return impl
    }

    /**
     * Valve (MultiStateDiscreteControlFunction): no Start / Stop; a new TargetValue sets ControlFunctionState to Running,
     * CurrentValue moves one position every 0.5 s towards it, then Stopped. A new TargetValue while moving changes the goal.
     */
    private installValve(valve: UAObject) {
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
                raiseEvent(valve, `Valve at ${label(goal)}`, EventSeverity.Info)
                return
            }
            timer = setTimeout(step, VALVE_STEP_MS)
        }
        target.on("value_changed", () => {
            if (timer || value(target) === value(current)) return
            sm.setState("Running")
            raiseEvent(valve, `Valve moving from ${label(value(current))} to ${label(value(target))}`, EventSeverity.Info)
            timer = setTimeout(step, VALVE_STEP_MS)
        })
        this.valve = valve
    }
    valve?: UAObject

    /** composed target value of the pump: Flow (TargetValueSet) -> TargetValue; partial values follow the lock of the unit */
    private installComposedTargetValue(pump: UAObject) {
        const set = pump.getChildByName("TargetValueSet") as UAObject | null
        if (!set || !this.pump) return
        const flow = set.getChildByName("Flow") as UAVariable | null
        const percentB = set.getChildByName("PercentageSolventB") as UAVariable | null
        for (const v of [flow, percentB]) restrictWriteAccess(v, this.isAccessible)
        if (percentB && percentB.readValue().value.value == null) setNumericValue(percentB, 0)
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
        }
    }

    dispose() { clearInterval(this.timer) }
}

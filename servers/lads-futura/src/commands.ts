// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Command behaviour of the FUTURA functional unit.

The commands Zero, ClearZero, CleanPulse and IncrementAutoclaveCount are modelled as TwoStateDiscreteControlFunctions
(ZeroNow, ClearZero, CleanPulseNow, IncrementAutoclaveCount) for clients that cannot call methods, and as ProgramTemplates
(started with StartProgram of the FunctionalUnitState). Both routes share the same behaviour:

  - ControlFunctionState is always Running
  - TargetValue = true while CurrentValue is true (command executing)  ->  BadInvalidState
  - otherwise: event "<function> initiated" (Info), CurrentValue = true (executing),
    TargetValue = false after about 100 ms, CurrentValue = false after about 1000 ms
*/

import { CallMethodResultOptions, DataValue, ISessionContext, StatusCode, StatusCodes, UAVariable, VariantLike } from "node-opcua"
import { EventSeverity, getBooleanValue, getLADSFunctionalUnits, promoteToFiniteStateMachine, raiseEvent, setBooleanValue } from "@utils"
import { LADSDevice, LADSFunctionalState, LADSFunctionalUnit, LADSTwoStateDiscreteControlFunction } from "@interfaces"

const TARGET_RESET_MS = 100
const EXECUTION_MS = 1000

/** ProgramTemplate (DeviceTemplateId) -> command function */
const PROGRAM_COMMANDS: Record<string, string> = {
    Zero: "ZeroNow",
    ClearZero: "ClearZero",
    CleanPulse: "CleanPulseNow",
    IncrementAutoclaveCount: "IncrementAutoclaveCount",
}

type SetCallback = (err: Error | null, statusCode: StatusCode, dataValue?: DataValue) => void

export class CommandFunction {
    private readonly target: UAVariable
    private readonly current: UAVariable

    constructor(readonly commandFunction: LADSTwoStateDiscreteControlFunction, private readonly onExecute?: () => void) {
        this.target = commandFunction.targetValue as unknown as UAVariable
        this.current = commandFunction.currentValue as unknown as UAVariable

        // the command function is always running; it can neither be stopped nor started
        const state = commandFunction.controlFunctionState
        promoteToFiniteStateMachine(state).setState(LADSFunctionalState.Running)
        state.start?.bindMethod(async (_inputArguments: VariantLike[], _context: ISessionContext) => ({ statusCode: StatusCodes.BadInvalidState }))
        state.stop?.bindMethod(async (_inputArguments: VariantLike[], _context: ISessionContext) => ({ statusCode: StatusCodes.BadInvalidState }))

        // validate writes of TargetValue (node-opcua offers no hook that rejects a write and still keeps the value storage)
        ;(this.target as any)._timestamped_set_func = (dataValue: DataValue, callback: SetCallback) => {
            if (dataValue.value.value !== true) return callback(null, StatusCodes.Good, dataValue)
            const status = this.trigger()
            if (status.isNotGood()) return callback(null, status)
            callback(null, StatusCodes.Good, dataValue)
        }
    }

    get name(): string { return this.commandFunction.browseName.name! }
    get isExecuting(): boolean { return getBooleanValue(this.current) }

    /** common behaviour of both routes (TargetValue write and StartProgram) */
    private trigger(): StatusCode {
        if (this.isExecuting) return StatusCodes.BadInvalidState
        raiseEvent(this.commandFunction, `${this.commandFunction.getDisplayName()} initiated`, EventSeverity.Info)
        setBooleanValue(this.current, true)
        setTimeout(() => setBooleanValue(this.target, false), TARGET_RESET_MS)
        setTimeout(() => setBooleanValue(this.current, false), EXECUTION_MS)
        this.onExecute?.()
        return StatusCodes.Good
    }

    /** StartProgram route: the same as writing TargetValue = true */
    startProgram(): StatusCode {
        const status = this.trigger()
        if (status.isGood()) setBooleanValue(this.target, true)
        return status
    }
}

/** Installs the command behaviour on the command functions of a functional unit and binds its StartProgram method. */
export function installCommands(unit: LADSFunctionalUnit): Map<string, CommandFunction> {
    const functionSet = unit.functionSet as any
    const byFunction = new Map<string, CommandFunction>()
    for (const functionName of new Set(Object.values(PROGRAM_COMMANDS))) {
        const node = functionSet.getChildByName(functionName)
        if (node) byFunction.set(functionName, new CommandFunction(node as LADSTwoStateDiscreteControlFunction))
    }

    unit.functionalUnitState.startProgram?.bindMethod(async (inputArguments: VariantLike[], _context: ISessionContext): Promise<CallMethodResultOptions> => {
        const templateId = String(inputArguments?.[0]?.value ?? "")
        if (templateId === "SlopeCalibration") return { statusCode: StatusCodes.BadNotSupported }      // no command function, not simulated
        if (!(templateId in PROGRAM_COMMANDS)) return { statusCode: StatusCodes.BadInvalidArgument }
        const command = byFunction.get(PROGRAM_COMMANDS[templateId])
        if (!command) return { statusCode: StatusCodes.BadNotSupported }
        return { statusCode: command.startProgram() }
    })
    return byFunction
}

/** Installs the commands on the FUTURA functional unit of the device. */
export function installFuturaCommands(device: LADSDevice) {
    const unit = getLADSFunctionalUnits(device).find(u => u.browseName.name === "Futura")
    if (unit) installCommands(unit)
}

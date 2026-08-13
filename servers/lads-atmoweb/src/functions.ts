// SPDX-FileCopyrightText: 2025-2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS AtmoWEB gateway
Copyright (C) 2025-2026  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import { AccessLevelFlag, CallMethodResultOptions, DataType, DataValue, EUInformation, ISessionContext, Namespace, promoteToStateMachine, Range, StatusCodes, UAMultiStateDiscrete, UAObject, UAStateMachineEx, UATwoStateDiscrete, UAVariable, VariantLike } from "node-opcua"
import { LADSAnalogControlFunction, LADSAnalogScalarSensorFunction, LADSCoverFunction, LADSCoverState, LADSFunctionalState, LADSTwoStateDiscreteControlFunction } from "@interfaces"
import { setNumericValue, getLADSObjectType, setBooleanValue, getBooleanValue, raiseEvent, initializeAnalogUnitRange, initializeTwoStateDiscrete, AnalogUnitRangeChangedEventReporter, TwoStateDiscreteChangedEventReporter, getStringArrayValue } from "@utils"
import { AtmoWebClient } from "./client"
import { AFODictionary } from "@afo"
import { AutomatedReactorMeasurementOptions, Units } from "@asm"

export enum OperationMode { Offline = 0, Manual, Program, Idle, Timer }

//---------------------------------------------------------------
// variable binding
//---------------------------------------------------------------
export abstract class VariableBinding {
    client: AtmoWebClient
    variable: UAVariable
    id: string
    pendingWriteRequest: boolean = false
    pendingUpdate: boolean = false

    constructor(client: AtmoWebClient, variable: UAVariable, id: string) {
        this.client = client
        this.variable = variable
        this.id = id
        this.variable.on("value_changed", this.onChanged.bind(this))
    }

    async update(value: unknown): Promise<void> {
        if (this.pendingWriteRequest) {
            this.pendingWriteRequest = false
        } else {
            this.pendingUpdate = true
            this.setValue(value)
            this.pendingUpdate = false
        }
    }

    abstract getValueStr(value: unknown): string
    abstract setValue(value: unknown): void

    onChanged(dataValue: DataValue) {
        if (this.pendingUpdate) return
        const value = dataValue.value.value
        this.client.queueWrite(this.id, this.getValueStr(value))
        this.pendingWriteRequest = true
    }
}

class NumericVariableBinding extends VariableBinding {
    setValue(value: unknown): void { setNumericValue(this.variable, Number(value)) }
    getValueStr(value: unknown): string { return Number(value).toString() }
}

class BooleanVariableBinding extends VariableBinding {
    setValue(value: unknown): void { setBooleanValue(this.variable, Boolean(value)) }
    getValueStr(value: unknown): string { return Boolean(value) ? "1" : "0" }
}

function getOperationMode(value: string) {
    switch (value) {
        case "manual": return OperationMode.Manual
        case "idle": return OperationMode.Idle
        case "program": return OperationMode.Program
        case "timer": return OperationMode.Timer
        default: return OperationMode.Offline
    }
}

export class OperationModeVariableBinding extends VariableBinding {

    setValue(value: unknown): void {
        const operationMode = getOperationMode(String(value).trim().toLowerCase())
        setNumericValue(this.variable, operationMode)
    }

    getValueStr(value: unknown): string {
        const multiStateVariable = this.variable as UAMultiStateDiscrete<number, DataType.UInt32>
        const enumStrings = getStringArrayValue(multiStateVariable.enumStrings)
        try {
            return enumStrings[Number(value)]
        } catch (error) {
            return "Unknown"
        }
    }
}


//---------------------------------------------------------------
// function configuration
//---------------------------------------------------------------
interface BaseFunctionConfig {
    id: string
    name: string
    functionDictionaryId?: string
    dictionaryIds?: string[]
}

export interface AnalogFunctionConfig extends BaseFunctionConfig {
    euInformation: EUInformation
    unit?: Units
    detectionType?: string,
    analyteName?: string
}

export interface AnalogControlFunctionConfig extends AnalogFunctionConfig {
    targetValue: number
    targetValueRange: Range
    currentValue: number
    currentValueId?: string
    currentValueRange: Range
    alarmHi: number
    alarmLo: number
}

export interface AnalogSensorFunctionConfig extends AnalogFunctionConfig {
    sensorValue: number
    sensorValueRange: Range
}

export interface TwoStateDiscreteControlFunctionConfig extends BaseFunctionConfig {
    value: boolean
    trueState: string
    falseState: string
}

export interface CoverFunctionConfig extends BaseFunctionConfig {
    opened: boolean
    locked?: boolean
    lockedId?: string
}

//---------------------------------------------------------------
// function implementation
//---------------------------------------------------------------
export type AccessPredicate = (context: ISessionContext) => boolean;
export function restrictWriteAccess(
    variable: UAVariable,
    isAccessible: AccessPredicate
): void {
    if (!isAccessible) return
    const original = variable.isUserWritable;

    variable.isUserWritable = function (context): boolean {
        return (
            original.call(variable, context) &&
            isAccessible(context)
        );
    };
}

function createMeasurementOptions(variable: UAVariable, config: AnalogFunctionConfig): AutomatedReactorMeasurementOptions {
    return {
        variable: variable,
        analyteName: config.analyteName ? config.analyteName : config.dictionaryIds[0] ?? "",
        detectionType: config.detectionType,
        unit: config.unit,
        referenceIds: config.dictionaryIds ?? []
    }
}

export abstract class FunctionImpl {
    abstract variableBindings(client: AtmoWebClient): VariableBinding[]
    recorderVariables(): UAVariable[] { return [] }
    measurementOptions(): AutomatedReactorMeasurementOptions[] { return [] }
}

export class AnalogControlFunctionImpl extends FunctionImpl {
    config: AnalogControlFunctionConfig
    controlFunction: LADSAnalogControlFunction
    controlFunctionState: UAStateMachineEx

    constructor(parent: UAObject, config: AnalogControlFunctionConfig, isAccessible: AccessPredicate) {
        super()
        this.config = config
        const objectType = getLADSObjectType(parent.addressSpace, "AnalogControlFunctionType")
        this.controlFunction = objectType.instantiate({
            componentOf: parent,
            browseName: config.name,
            description: `${config.name} representing AtmoWEB "${config.id}" function.`
        }) as LADSAnalogControlFunction
        setBooleanValue(this.controlFunction.isEnabled, true)
        initializeAnalogUnitRange(this.controlFunction.targetValue, config.targetValue, config.euInformation, config.targetValueRange)
        initializeAnalogUnitRange(this.controlFunction.currentValue, config.currentValue, config.euInformation, config.currentValueRange, true)
        this.controlFunctionState = promoteToStateMachine(this.controlFunction.controlFunctionState)
        this.controlFunctionState.setState(LADSFunctionalState.Running)
        AnalogUnitRangeChangedEventReporter.install(this.controlFunction, this.controlFunction.targetValue)
        restrictWriteAccess(this.controlFunction.targetValue, isAccessible)
        AFODictionary.addControlFunctionReferences(this.controlFunction, config.functionDictionaryId, ...config.dictionaryIds)
    }

    variableBindings(client: AtmoWebClient): VariableBinding[] {
        return [
            new NumericVariableBinding(client, this.controlFunction.currentValue, `${this.config.currentValueId ?? this.config.id}Read`),
            new NumericVariableBinding(client, this.controlFunction.targetValue, `${this.config.id}Set`)
        ]
    }

    recorderVariables(): UAVariable[] { return [this.controlFunction.currentValue] }

    measurementOptions(): AutomatedReactorMeasurementOptions[] { return [createMeasurementOptions(this.controlFunction.currentValue, this.config)] }

}

export class AnalogSensorFunctionImpl extends FunctionImpl {
    config: AnalogSensorFunctionConfig
    sensorFunction: LADSAnalogScalarSensorFunction

    constructor(parent: UAObject, config: AnalogSensorFunctionConfig) {
        super()
        this.config = config
        const objectType = getLADSObjectType(parent.addressSpace, "AnalogScalarSensorFunctionType")
        this.sensorFunction = objectType.instantiate({
            componentOf: parent,
            browseName: config.name,
            description: `${config.name} representing AtmoWEB "${config.id}" sensor.`
        }) as LADSAnalogScalarSensorFunction
        setBooleanValue(this.sensorFunction.isEnabled, true)
        initializeAnalogUnitRange(this.sensorFunction.sensorValue, config.sensorValue, config.euInformation, config.sensorValueRange, true)
        AFODictionary.addSensorFunctionReferences(this.sensorFunction, config.functionDictionaryId, ...config.dictionaryIds)
    }

    variableBindings(client: AtmoWebClient): VariableBinding[] {
        return [
            new NumericVariableBinding(client, this.sensorFunction.sensorValue, `${this.config.id}Read`),
        ]
    }

    recorderVariables(): UAVariable[] { return [this.sensorFunction.sensorValue] }

    measurementOptions(): AutomatedReactorMeasurementOptions[] { return [createMeasurementOptions(this.sensorFunction.sensorValue, this.config)] }

}


export class TwoStateDiscreteControlFunctionImpl extends FunctionImpl {
    config: TwoStateDiscreteControlFunctionConfig
    controlFunction: LADSTwoStateDiscreteControlFunction
    controlFunctionState: UAStateMachineEx

    constructor(parent: UAObject, config: TwoStateDiscreteControlFunctionConfig, isAccessible: AccessPredicate) {
        super()
        this.config = config
        const objectType = getLADSObjectType(parent.addressSpace, "TwoStateDiscreteControlFunctionType")
        this.controlFunction = objectType.instantiate({
            componentOf: parent,
            browseName: config.name,
            description: `${config.name} representing AtmoWEB "${config.id}" function.`,
            optionals: ["TrueState", "FalseState"]
        }) as LADSTwoStateDiscreteControlFunction
        setBooleanValue(this.controlFunction.isEnabled, true)
        initializeTwoStateDiscrete(this.controlFunction.targetValue, config.value, config.falseState, config.trueState)
        initializeTwoStateDiscrete(this.controlFunction.currentValue, config.value, config.falseState, config.trueState)
        this.controlFunctionState = promoteToStateMachine(this.controlFunction.controlFunctionState)
        this.controlFunctionState.setState(LADSFunctionalState.Running)
        restrictWriteAccess(this.controlFunction.targetValue, isAccessible)
        TwoStateDiscreteChangedEventReporter.install(this.controlFunction, this.controlFunction.currentValue)
        AFODictionary.addControlFunctionReferences(this.controlFunction, config.functionDictionaryId, ...config.dictionaryIds)
    }

    variableBindings(client: AtmoWebClient): VariableBinding[] {
        return [
            new BooleanVariableBinding(client, this.controlFunction.currentValue, `${this.config.id}`),
            new BooleanVariableBinding(client, this.controlFunction.targetValue, `${this.config.id}`)
        ]
    }

    recorderVariables(): UAVariable[] { return [this.controlFunction.currentValue] }
}

export class CoverFunctionImpl extends FunctionImpl {
    config: CoverFunctionConfig
    coverFunction: LADSCoverFunction
    coverState: UAStateMachineEx
    openedVariable: UATwoStateDiscrete<boolean>
    lockedVariable: UATwoStateDiscrete<boolean>
    isAccessible: AccessPredicate

    constructor(parent: UAObject, config: CoverFunctionConfig, isAccessible: AccessPredicate) {
        super()
        this.config = config
        this.isAccessible = isAccessible
        const optionals = ["CoverState.Close", "CoverState.Open"]
        if (config.lockedId) {
            optionals.push("CoverState.Lock", "CoverState.Unlock")
        }

        // create cover function object
        const objectType = getLADSObjectType(parent.addressSpace, "CoverFunctionType")
        this.coverFunction = objectType.instantiate({
            componentOf: parent,
            browseName: config.name,
            description: `${config.name} representing AtmoWEB door function.`,
            optionals: optionals
        }) as LADSCoverFunction
        setBooleanValue(this.coverFunction.isEnabled, true)

        // create variables representing the AtmoWEB cover state
        const namespace = this.coverFunction.namespace as Namespace
        this.openedVariable = namespace.addTwoStateDiscrete({
            componentOf: this.coverFunction.coverState,
            dataType: DataType.Boolean,
            browseName: "isOpened",
            description: `Represents AtmoWEB "${config.id}" status.`,
            accessLevel: AccessLevelFlag.CurrentRead,
            falseState: "closed",
            trueState: "opened",
            value: { dataType: DataType.Boolean, value: config.opened }
        }) as UATwoStateDiscrete<boolean>
        if (config.lockedId) {
            this.lockedVariable = namespace.addTwoStateDiscrete({
                componentOf: this.coverFunction.coverState,
                dataType: DataType.Boolean,
                browseName: "isLocked",
                description: `Represents AtmoWEB "${config.lockedId}" status.`,
                accessLevel: AccessLevelFlag.CurrentRead,
                falseState: "unlocked",
                trueState: "locked",
                value: { dataType: DataType.Boolean, value: config.locked }
            }) as UATwoStateDiscrete<boolean>
        }

        // variable bindings
        this.coverState = promoteToStateMachine(this.coverFunction.coverState)
        this.openedVariable.on("value_changed", this.onCoverStateVariablesChanged.bind(this))
        this.lockedVariable?.on("value_changed", this.onCoverStateVariablesChanged.bind(this))
        this.onCoverStateVariablesChanged()

        // method bindings
        const stateMachine = this.coverFunction.coverState
        stateMachine.open?.bindMethod(this.openMethod.bind(this))
        stateMachine.close?.bindMethod(this.closeOrUnlockMethod.bind(this))
        stateMachine.lock?.bindMethod(this.lockMethod.bind(this))
        stateMachine.unlock?.bindMethod(this.closeOrUnlockMethod.bind(this))
    }

    private handleMethod(context: ISessionContext, opened: boolean, locked: boolean): CallMethodResultOptions {
        if (!this.isAccessible(context)) return  { statusCode: StatusCodes.BadUserAccessDenied }
        this.setCoverStateVariables(opened, locked)
        return { statusCode: StatusCodes.Good }
    }

    private async openMethod(inputArguments: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        return this.handleMethod(context, true, false)
    }
    private async closeOrUnlockMethod(inputArguments: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        return this.handleMethod(context, false, false)
    }
    private async lockMethod(inputArguments: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        return this.handleMethod(context, false, true)
    }

    private setCoverStateVariables(openedValue: boolean, lockedValue: boolean) {
        setBooleanValue(this.openedVariable, openedValue)
        setBooleanValue(this.lockedVariable, lockedValue)
    }

    private setCoverState(newState: LADSCoverState) {
        const state = this.coverState.getCurrentState() ?? "Unknown"
        if (state.includes(newState)) return
        this.coverState.setState(newState)
        raiseEvent(this.coverFunction, `${this.coverFunction.getDisplayName()} state changed to ${newState}.`)
    }

    onCoverStateVariablesChanged() {
        const opened = getBooleanValue(this.openedVariable)
        const locked = this.lockedVariable ? getBooleanValue(this.lockedVariable) : false
        if (opened) {
            this.setCoverState(LADSCoverState.Opened)
        } else if (locked) {
            this.setCoverState(LADSCoverState.Locked)
        } else {
            this.setCoverState(LADSCoverState.Closed)
        }
    }

    variableBindings(client: AtmoWebClient): VariableBinding[] {
        const bindings: VariableBinding[] = [new BooleanVariableBinding(client, this.openedVariable, `${this.config.id}`)]
        this.lockedVariable ? bindings.push(new BooleanVariableBinding(client, this.lockedVariable, `${this.config.lockedId}`)) : 0
        return bindings
    }
}




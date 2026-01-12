// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { LADSAnalogControlFunction, LADSAnalogControlFunctionWithTotalizer, LADSAnalogScalarSensorFunction, LADSBaseControlFunction, LADSFunctionalState, LADSMultiStateDiscreteControlFunction, LADSTimerControlFunction } from "@interfaces";
import EventEmitter from "events";
import { UAAnalogUnitRange, DataType, UAExclusiveLimitAlarm, Namespace, makeNodeId, ReferenceTypeIds, ObjectTypeIds, InstantiateExclusiveLimitAlarmOptions, ConditionInfo, LocalizedText, StatusCodes, CallMethodResultOptions, SessionContext, UAState, UAStateMachineEx, VariantLike, UAMultiStateDiscrete, AccessRestrictionsFlag, AccessLevelFlag, UAVariable, QualifiedName } from "node-opcua";
import { getLADSNamespace, promoteToFiniteStateMachine } from "./lads-utils";
import { getNumericValue, setNumericValue } from "./lads-variable-utils";

//---------------------------------------------------------------
// generic definitions
//---------------------------------------------------------------
export interface AlarmMonitorOptions {
    highHighLimit: number;
    highLimit: number;
    lowLimit: number;
    lowLowLimit: number;
}

export enum EventSeverity {
    Info = 0,
    Warning = 300,
    Alarm = 600,
    Critical = 900,
    LowLow = Alarm,
    Low = Warning,
    High = Warning,
    HighHigh = Alarm
}

//---------------------------------------------------------------
// analog sensor function implementation
//---------------------------------------------------------------
function setAccessLevel(variable: UAVariable, accessLevel: number) {
    if (!variable) return
    variable.accessLevel = accessLevel
    variable.userAccessLevel = accessLevel
}

export class AnalogScalarSensorFunctionImpl {
    sensorFunction: LADSAnalogScalarSensorFunction
    rawValue?: UAAnalogUnitRange<number, DataType.Double>
    sensorValue: UAAnalogUnitRange<number, DataType.Double>
    alarmMonitor: UAExclusiveLimitAlarm

    constructor(sensorFunction: LADSAnalogScalarSensorFunction, alarmMonitorOptions: AlarmMonitorOptions = undefined) {
        this.sensorFunction = sensorFunction
        this.rawValue = sensorFunction.rawValue
        this.sensorValue = sensorFunction.sensorValue
        if (alarmMonitorOptions) {
            const addressSpace = sensorFunction.addressSpace
            const namespace = getLADSNamespace(addressSpace) as Namespace
            const functionSet = sensorFunction.parent
            const hasEventSource = addressSpace.findReferenceType(makeNodeId(ReferenceTypeIds.HasEventSource))
            functionSet.addReference({ referenceType: hasEventSource, nodeId: sensorFunction })
            const alarmType = addressSpace.findEventType(makeNodeId(ObjectTypeIds.ExclusiveLimitAlarmType))
            const name = "AlarmMonitor"
            const options: InstantiateExclusiveLimitAlarmOptions = {
                browseName: new QualifiedName({name: "AlarmMonitor", namespaceIndex: namespace.index}),
                displayName: "Alarm Monitor",
                componentOf: sensorFunction,
                conditionOf: sensorFunction,
                eventSourceOf: sensorFunction,
                conditionSource: sensorFunction,
                conditionName: `${sensorFunction.getDisplayName()}-${name}`,
                highHighLimit: alarmMonitorOptions.highHighLimit,
                highLimit: alarmMonitorOptions.highLimit,
                lowLimit: alarmMonitorOptions.lowLimit,
                lowLowLimit: alarmMonitorOptions.lowLowLimit,
                inputNode: this.sensorValue,
                optionals: ["AckedState", "Acknowledge"]
            }
            const accessReadWrite = AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
            this.alarmMonitor = namespace.instantiateExclusiveLimitAlarm(alarmType, options)
            setAccessLevel(this.alarmMonitor.highHighLimit, accessReadWrite)
            setAccessLevel(this.alarmMonitor.highLimit, accessReadWrite)
            setAccessLevel(this.alarmMonitor.lowLimit, accessReadWrite)
            setAccessLevel(this.alarmMonitor.lowLowLimit, accessReadWrite)
            const alarmMonitor = this.alarmMonitor as any
            alarmMonitor._calculateConditionInfo = this._calculateConditionInfo.bind(this)
        }
    }

    private severity(stateData: string) : number {
        if (!stateData) return 0
        switch(stateData) {
            case "Low":
            case "High":
                return EventSeverity.Warning
            case "LowLow":
            case "HighHigh":
                return EventSeverity.Alarm
        }
    }

    private _calculateConditionInfo(stateData: string | null, isActive: boolean, value: string, oldCondition: ConditionInfo): ConditionInfo {
        const name = this.sensorFunction.getDisplayName()
        const message = stateData ? `${name} sensor value ${stateData.toLowerCase()}` : `${name} sensor value normal`
        const result: ConditionInfo = {
            message: new LocalizedText(message),
            quality: StatusCodes.Good,
            retain: true,
            severity: this.severity(stateData),
            isDifferentFrom: undefined
        }
        // console.log(name, oldCondition, result)
        return result
    }
}

//---------------------------------------------------------------
// generic control function implementation
//---------------------------------------------------------------
interface ControlFunctionEvents {
    "start": []
    "stop": []
}

export class ControlFunctionImpl extends EventEmitter<ControlFunctionEvents> {
    contolFunction: LADSBaseControlFunction
    stateMachine: UAStateMachineEx
    stateRunning: UAState
    stateStopped: UAState

    constructor(controlFunction: LADSBaseControlFunction) {
        super()
        this.contolFunction = controlFunction
        this.stateMachine = promoteToFiniteStateMachine(controlFunction.controlFunctionState)
        this.stateRunning = this.stateMachine.getStateByName(LADSFunctionalState.Running)
        this.stateStopped = this.stateMachine.getStateByName(LADSFunctionalState.Stopped)
        controlFunction.controlFunctionState.start?.bindMethod(this.handleStart.bind(this))
        controlFunction.controlFunctionState.stop?.bindMethod(this.handleStop.bind(this))
    }

    private async handleStart(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        this.enterStart()
        return { statusCode: StatusCodes.Good }
    }
    async enterStart() {
        this.stateMachine.setState(LADSFunctionalState.Running)
        this.emit("start")
        this.onStart()
    }
    protected async onStart() { }

    private async handleStop(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        this.enterStop()
        return { statusCode: StatusCodes.Good }
    }
    async enterStop() {
        this.onStop()
        this.emit("stop")
        this.stateMachine.setState(LADSFunctionalState.Stopped)
    }
    protected async onStop() { }
}

//---------------------------------------------------------------
// multi-state discrete control function implementation
//---------------------------------------------------------------
export class MulitStateDiscreteControlFunctionImpl extends ControlFunctionImpl {
    targetValue: UAMultiStateDiscrete<number, DataType.UInt32>
    currentValue: UAMultiStateDiscrete<number, DataType.UInt32>

    constructor(controlFunction: LADSMultiStateDiscreteControlFunction) {
        super(controlFunction)
        this.targetValue = controlFunction.targetValue
        this.currentValue = controlFunction.currentValue
    }
}

//---------------------------------------------------------------
// analog control function implementation
//---------------------------------------------------------------
export class AnalogControlFunctionImpl extends ControlFunctionImpl {
    targetValue: UAAnalogUnitRange<number, DataType.Double>
    currentValue: UAAnalogUnitRange<number, DataType.Double>

    constructor(controlFunction: LADSAnalogControlFunction) {
        super(controlFunction)
        this.targetValue = controlFunction.targetValue
        this.currentValue = controlFunction.currentValue
    }
}
export class AnalogControlFunctionWithTotalizerImpl extends AnalogControlFunctionImpl {
    totalizedValue: UAAnalogUnitRange<number, DataType.Double>

    constructor(controlFunction: LADSAnalogControlFunctionWithTotalizer) {
        super(controlFunction)
        this.totalizedValue = controlFunction.totalizedValue
        controlFunction.resetTotalizer?.bindMethod(this.handleResetTotalizer.bind(this))
    }

    private async handleResetTotalizer(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        const value = inputArguments.length > 0 ? Number(inputArguments[0]) : 0
        setNumericValue(this.totalizedValue, value)
        return { statusCode: StatusCodes.Good }
    }
}

//---------------------------------------------------------------
// timer control function implementation
//---------------------------------------------------------------
export class TimerControlFunctionImpl extends AnalogControlFunctionImpl {
    started: number
    autoStop: boolean = false
    differenceValue: UAAnalogUnitRange<number, DataType.Double>

    constructor(controlFunction: LADSTimerControlFunction, autoStop = false) {
        super(controlFunction)
        this.started = Date.now()
        this.autoStop = autoStop
        this.differenceValue = controlFunction.differenceValue
        this.targetValue?.on("value_changed", (dataValue) => { this.updateDifferenceValue() })
        this.currentValue?.on("value_changed", (dataValue) => { this.updateDifferenceValue() })
    }

    private updateDifferenceValue() {
        if (!this.targetValue) return
        if (!this.currentValue) return
        if (!this.differenceValue) return
        setNumericValue(this.differenceValue, getNumericValue(this.targetValue) - getNumericValue(this.currentValue))
    }

    private updateCurrentValue() { setNumericValue(this.currentValue, Date.now() - this.started) }

    protected onStart(): Promise<void> {
        setNumericValue(this.currentValue, 0.0)
        this.started = Date.now()
        return
    }

    evaluate(): boolean {
        if (this.stateMachine.currentStateNode !== this.stateRunning) return false
        this.updateCurrentValue()
        if (this.autoStop && this.targetValue && this.currentValue) {
            const dt = getNumericValue(this.targetValue) - getNumericValue(this.currentValue)
            if (dt <= 0) {
                this.enterStop()
            }
        }
        return true
    }

    protected onStop(): Promise<void> {
        this.updateCurrentValue()
        return
    }
}

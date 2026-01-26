// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { LADSFunction, LADSAnalogControlFunction, LADSAnalogControlFunctionWithTotalizer, LADSAnalogScalarSensorFunction, LADSBaseControlFunction, LADSFunctionalState, LADSMultiStateDiscreteControlFunction, LADSTimerControlFunction, LADSAnalogScalarSensorWithCompensationFunction } from "@interfaces";
import EventEmitter from "events";
import {
    UAAnalogUnitRange, DataType, Namespace, makeNodeId, ReferenceTypeIds, ObjectTypeIds,
    InstantiateExclusiveLimitAlarmOptions, ConditionInfo, LocalizedText, StatusCodes, CallMethodResultOptions, SessionContext, UAState, UAStateMachineEx, VariantLike, UAMultiStateDiscrete, AccessLevelFlag, UAVariable, QualifiedName, 
    UAVariableT, UAExclusiveDeviationAlarmEx, UAExclusiveLimitAlarmEx, DataValue,
    UAProperty,
    EUInformation} from "node-opcua";
import { getLADSNamespace, installVariableHistory, promoteToFiniteStateMachine } from "./lads-utils";
import { getEUInformation, getNumericValue, setNumericValue } from "./lads-variable-utils";
import { raiseEvent } from "./lads-event-utils";

//---------------------------------------------------------------
// generic definitions
//---------------------------------------------------------------
export interface AlarmMonitorOptions {
    logLimitChanges?: boolean
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

export interface SensorFunctionOptions extends AlarmMonitorOptions {
    historizing?: boolean
}

//---------------------------------------------------------------
// alarm monitor implementation
//---------------------------------------------------------------
function setAccessLevel(variable: UAVariable, accessLevel: number) {
    if (!variable) return
    variable.accessLevel = accessLevel
    variable.userAccessLevel = accessLevel
}

type SetPointNodeType = UAVariableT<number, DataType.Float> | UAVariableT<number, DataType.Double> 

export abstract class LimitAlarmImpl {
    parentFunction: FunctionImpl
    options: InstantiateExclusiveLimitAlarmOptions
    alarmMonitor: UAExclusiveLimitAlarmEx | UAExclusiveDeviationAlarmEx

    constructor(parentFunction: FunctionImpl, alarmMonitorOptions: AlarmMonitorOptions, inputNode: UAVariable, setpointNode: SetPointNodeType = undefined) {
        this.parentFunction = parentFunction
        const functionNode = this.parentFunction.functionNode
        const addressSpace = functionNode.addressSpace
        const namespace = getLADSNamespace(addressSpace) as Namespace
        const functionSet = functionNode.parent
        const hasEventSource = addressSpace.findReferenceType(makeNodeId(ReferenceTypeIds.HasEventSource))
        functionSet.addReference({ referenceType: hasEventSource, nodeId: functionNode })
        const name = "AlarmMonitor"
        this.options = {
            browseName: new QualifiedName({ name: "AlarmMonitor", namespaceIndex: namespace.index }),
            displayName: "Alarm Monitor",
            componentOf: functionNode,
            conditionOf: functionNode,
            eventSourceOf: functionNode,
            conditionSource: functionNode,
            conditionName: `${functionNode.getDisplayName()}-${name}`,
            highHighLimit: alarmMonitorOptions.highHighLimit,
            highLimit: alarmMonitorOptions.highLimit,
            lowLimit: alarmMonitorOptions.lowLimit,
            lowLowLimit: alarmMonitorOptions.lowLowLimit,
            inputNode: inputNode,
            setpointNode: setpointNode,
            optionals: ["AckedState", "Acknowledge"]
        }
    }

    private installLimitChanged(variable: UAVariable) {
        if (!variable) return
        variable.on("value_changed", (dataValue: DataValue) => this.onLimitChanged(variable, dataValue))
    }

    private onLimitChanged(variable: UAVariable, dataValue: DataValue) {
        const eu = this.parentFunction.engineeringUnits
        const euStr = eu ? ` ${eu.displayName.text}` : ""
        raiseEvent(this.parentFunction.functionNode, `AlarmMonitor.${variable.getDisplayName()} changed to ${dataValue.value.value}${euStr}`)
    }

    setEnabledState(requestedEnabledState: boolean) { this.alarmMonitor.setEnabledState(requestedEnabledState)} 

    protected postInitialize(alarmMonitorOptions: AlarmMonitorOptions) {
        if (alarmMonitorOptions.logLimitChanges ?? true) {
            this.installLimitChanged(this.alarmMonitor.highHighLimit)
            this.installLimitChanged(this.alarmMonitor.highLimit)
            this.installLimitChanged(this.alarmMonitor.lowLimit)
            this.installLimitChanged(this.alarmMonitor.lowLowLimit)
        }
        const accessReadWrite = AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
        setAccessLevel(this.alarmMonitor.highHighLimit, accessReadWrite)
        setAccessLevel(this.alarmMonitor.highLimit, accessReadWrite)
        setAccessLevel(this.alarmMonitor.lowLimit, accessReadWrite)
        setAccessLevel(this.alarmMonitor.lowLowLimit, accessReadWrite)
        const alarmMonitor = this.alarmMonitor as any
        alarmMonitor._calculateConditionInfo = this._calculateConditionInfo.bind(this)
    }

    protected severity(stateData: string): number {
        if (!stateData) return 0
        switch (stateData) {
            case "Low":
            case "High":
                return EventSeverity.Warning
            case "LowLow":
            case "HighHigh":
                return EventSeverity.Alarm
        }
    }

    protected _calculateConditionInfo(stateData: string | null, isActive: boolean, value: string, oldCondition: ConditionInfo): ConditionInfo {
        const name = this.parentFunction.functionNode.getDisplayName()
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

export class ExclusiveLimitAlarmImpl extends LimitAlarmImpl {
    constructor(parent: AnalogScalarSensorFunctionImpl, alarmMonitorOptions: AlarmMonitorOptions) {
        if (!alarmMonitorOptions) return
        const sensorFunction = parent.sensorFunction
        super(parent, alarmMonitorOptions, sensorFunction.sensorValue)
        const addressSpace = sensorFunction.addressSpace
        const namespace = getLADSNamespace(addressSpace) as Namespace
        const alarmType = addressSpace.findEventType(makeNodeId(ObjectTypeIds.ExclusiveLimitAlarmType))
        this.alarmMonitor = namespace.instantiateExclusiveLimitAlarm(alarmType, this.options) as UAExclusiveDeviationAlarmEx
        this.postInitialize(alarmMonitorOptions)
    }

}

export class ExclusiveDeviationAlarmImpl extends LimitAlarmImpl {
    signalNewCondition: (stateName: string | null, isActive?: boolean, value?: string) => void
    onSetpointDataValueChange: (dataValue: DataValue) => void
    
    
    constructor(parent: AnalogControlFunctionImpl, alarmMonitorOptions: AlarmMonitorOptions) {
        if (!alarmMonitorOptions) return
        const controlFunction = parent.contolFunction as LADSAnalogControlFunction
        super(parent, alarmMonitorOptions, controlFunction.currentValue, controlFunction.targetValue)
        const addressSpace = controlFunction.addressSpace
        const namespace = getLADSNamespace(addressSpace) as Namespace
        this.alarmMonitor = namespace.instantiateExclusiveDeviationAlarm(this.options)

        // handling of enabled state in node-opcua default implmentation is somewhat stange - better don't enable/disable at all
        if (false) {
            // try to install guard
            const alarmMonitor = this.alarmMonitor as any
            this.onSetpointDataValueChange = alarmMonitor._onSetpointDataValueChange
            this.signalNewCondition = alarmMonitor._signalNewCondition
            alarmMonitor._signalNewCondition = this._signalNewCondition.bind(this)
            alarmMonitor._onSetpointDataValueChange = this._onSetpointDataValueChange.bind(this)
        }
        if (false) {        
            this.alarmMonitor.setEnabledState(false)
            parent.on("start", () => this.alarmMonitor.setEnabledState(true))
            parent.on("stop", () => this.alarmMonitor.setEnabledState(false))
        }

        this.postInitialize(alarmMonitorOptions)
    }

    private _signalNewCondition(stateName: string | null, isActive?: boolean, value?: string): void {
        if (this.alarmMonitor.getEnabledState()) {
            this.signalNewCondition(stateName, isActive, value)
        }
    }

    private _onSetpointDataValueChange(dataValue: DataValue): void {
        if (this.alarmMonitor.getEnabledState()) {
            this.onSetpointDataValueChange(dataValue)
        }
    }

}

//---------------------------------------------------------------
// analog sensor function implementation
//---------------------------------------------------------------
export interface FunctionImpl { 
    readonly functionNode: LADSFunction 
    readonly engineeringUnits?: EUInformation
}

export class AnalogScalarSensorFunctionImpl implements FunctionImpl {
    sensorFunction: LADSAnalogScalarSensorFunction
    rawValue?: UAAnalogUnitRange<number, DataType.Double>
    sensorValue: UAAnalogUnitRange<number, DataType.Double>
    calibrationValues?: UAProperty<number[], DataType.Double>
    alarmMonitor: ExclusiveLimitAlarmImpl

    get functionNode(): LADSFunction { return this.sensorFunction }
    get engineeringUnits(): EUInformation { return getEUInformation(this.sensorValue) }

    constructor(sensorFunction: LADSAnalogScalarSensorFunction, options: SensorFunctionOptions = undefined) {
        this.sensorFunction = sensorFunction
        this.rawValue = sensorFunction.rawValue
        this.sensorValue = sensorFunction.sensorValue
        this.calibrationValues = sensorFunction.calibrationValues
        if (options?.historizing ?? true) installVariableHistory(this.sensorValue)
        if (options)
            this.alarmMonitor = new ExclusiveLimitAlarmImpl(this, options)
    }

}

export class AnalogScalarSensorWithCompenstionFunctionImpl extends AnalogScalarSensorFunctionImpl { 
    compensationValue?: UAAnalogUnitRange<number, DataType.Double>

    constructor(sensorFunction: LADSAnalogScalarSensorWithCompensationFunction, options: SensorFunctionOptions = undefined) {
        super(sensorFunction, options)
        this.compensationValue = (this.sensorFunction as LADSAnalogScalarSensorWithCompensationFunction).compensationValue
    }
}

//---------------------------------------------------------------
// generic control function implementation
//---------------------------------------------------------------
interface ControlFunctionEvents {
    "start": []
    "stop": []
}

export abstract class ControlFunctionImpl extends EventEmitter<ControlFunctionEvents> implements FunctionImpl  {
    static stopped: UAState = undefined
    static stopping: UAState = undefined
    static running: UAState = undefined

    static initialize(stateMachine: UAStateMachineEx) {
        if (this.stopped != undefined) return
        this.stopped = stateMachine.getStateByName(LADSFunctionalState.Stopped)
        this.stopping = stateMachine.getStateByName(LADSFunctionalState.Stopping)
        this.running = stateMachine.getStateByName(LADSFunctionalState.Running)
    }

    contolFunction: LADSBaseControlFunction
    stateMachine: UAStateMachineEx

    get functionNode(): LADSFunction {return this.contolFunction}
    
    constructor(controlFunction: LADSBaseControlFunction) {
        super()
        this.contolFunction = controlFunction
        this.stateMachine = promoteToFiniteStateMachine(controlFunction.controlFunctionState)
        controlFunction.controlFunctionState.start?.bindMethod(this.handleStart.bind(this))
        controlFunction.controlFunctionState.stop?.bindMethod(this.handleStop.bind(this))
        ControlFunctionImpl.initialize(this.stateMachine)
    }

    protected get isStopped(): boolean { return this.stateMachine.currentStateNode == ControlFunctionImpl.stopped }
    protected get isStopping(): boolean { return this.stateMachine.currentStateNode == ControlFunctionImpl.stopping }
    protected get isRunning(): boolean { return this.stateMachine.currentStateNode == ControlFunctionImpl.running }

    private async handleStart(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (this.isRunning)
            return { statusCode: StatusCodes.BadInvalidState }
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
        if (!this.isRunning)
            return { statusCode: StatusCodes.BadInvalidState }
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
    alarmMonitor: ExclusiveDeviationAlarmImpl

    get engineeringUnits(): EUInformation { return getEUInformation(this.currentValue) }

    constructor(controlFunction: LADSAnalogControlFunction, alarmMonitorOptions: AlarmMonitorOptions = undefined) {
        super(controlFunction)
        this.targetValue = controlFunction.targetValue
        this.currentValue = controlFunction.currentValue
        controlFunction.controlFunctionState.startWithTargetValue?.bindMethod(this.handleStartWithTargetValue.bind(this))
        if (alarmMonitorOptions)
            this.alarmMonitor = new ExclusiveDeviationAlarmImpl(this, alarmMonitorOptions)
    }

    private async handleStartWithTargetValue(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (this.isRunning)
            return { statusCode: StatusCodes.BadInvalidState }
        if (inputArguments.length > 0)
            setNumericValue(this.targetValue, inputArguments[0].value)
        this.enterStart()
        return { statusCode: StatusCodes.Good }
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
        if (!this.isRunning) return false
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

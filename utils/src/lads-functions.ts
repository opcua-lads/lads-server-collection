// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { LADSFunction, LADSAnalogControlFunction, LADSAnalogControlFunctionWithTotalizer, LADSAnalogScalarSensorFunction, LADSBaseControlFunction, LADSFunctionalState, LADSMultiStateDiscreteControlFunction, LADSTimerControlFunction, LADSAnalogScalarSensorWithCompensationFunction, LADSAnalogArraySensorFunction, LADSAnalogScalarSensorWithCompensationFunction_Base, LADSFunctionalStateMachine } from "@interfaces";
import { LADSAnalogScalarSensorFunction_Base } from "@interfaces"
import EventEmitter from "events";
import {
    UAAnalogUnitRange, DataType, Namespace, makeNodeId, ReferenceTypeIds, ObjectTypeIds,
    InstantiateExclusiveLimitAlarmOptions, ConditionInfo, LocalizedText, StatusCodes, CallMethodResultOptions, SessionContext, UAState, UAStateMachineEx, VariantLike, UAMultiStateDiscrete, AccessLevelFlag, UAVariable, QualifiedName,
    UAVariableT, UAExclusiveDeviationAlarmEx, UAExclusiveLimitAlarmEx, DataValue,
    UAProperty,
    EUInformation,
    coerceNodeId,
    VariableTypeIds,
    UATwoStateVariable,
    NodeId,
    UAMethod,
    StatusCode,
    UAConditionVariable,
    UAExclusiveLimitAlarm_Base,
    UAExclusiveLimitStateMachine
} from "node-opcua";
import { getLADSNamespace, installVariableHistory, promoteToFiniteStateMachine } from "./lads-utils";
import { getEUInformation, getNumericValue, setNumericValue, setStringArrayValue } from "./lads-variable-utils";
import { raiseEvent } from "./lads-event-utils";
import { get } from "http";

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


export abstract class LimitAlarmImpl implements UAExclusiveLimitAlarm_Base {

    // own members
    parentFunction: LADSFunction
    options: InstantiateExclusiveLimitAlarmOptions
    alarmMonitor: UAExclusiveLimitAlarmEx | UAExclusiveDeviationAlarmEx
    eu: EUInformation

    constructor(parentFunction: LADSFunction, alarmMonitorOptions: AlarmMonitorOptions, inputNode: UAVariable, setpointNode: SetPointNodeType = undefined) {
        this.parentFunction = parentFunction
        const addressSpace = parentFunction.addressSpace
        const namespace = getLADSNamespace(addressSpace) as Namespace
        const functionSet = parentFunction.parent
        const hasEventSource = addressSpace.findReferenceType(makeNodeId(ReferenceTypeIds.HasEventSource))
        functionSet.addReference({ referenceType: hasEventSource, nodeId: parentFunction })
        const name = "AlarmMonitor"
        this.options = {
            browseName: new QualifiedName({ name: "AlarmMonitor", namespaceIndex: namespace.index }),
            displayName: "Alarm Monitor",
            componentOf: parentFunction,
            conditionOf: parentFunction,
            eventSourceOf: parentFunction,
            conditionSource: parentFunction,
            conditionName: `${parentFunction.getDisplayName()}-${name}`,
            highHighLimit: alarmMonitorOptions.highHighLimit,
            highLimit: alarmMonitorOptions.highLimit,
            lowLimit: alarmMonitorOptions.lowLimit,
            lowLowLimit: alarmMonitorOptions.lowLowLimit,
            inputNode: inputNode,
            setpointNode: setpointNode,
            optionals: ["AckedState", "Acknowledge"]
        }
        // determine engineering unit of input node
        const analogItemType = addressSpace.findVariableType(coerceNodeId(VariableTypeIds.BaseAnalogType))
        const variableTypeObj = inputNode.typeDefinitionObj
        variableTypeObj.isSubtypeOf(analogItemType)
        this.eu = variableTypeObj.isSubtypeOf(analogItemType) ? getEUInformation(inputNode) : undefined
    }

    private installLimitChanged(variable: UAVariable) {
        if (!variable) return
        variable.on("value_changed", (dataValue: DataValue) => this.onLimitChanged(variable, dataValue))
    }

    private onLimitChanged(variable: UAVariable, dataValue: DataValue) {
        const euStr = this.eu ? ` ${this.eu.displayName.text}` : ""
        raiseEvent(this.parentFunction, `AlarmMonitor.${variable.getDisplayName()} changed to ${dataValue.value.value}${euStr}`)
    }

    setEnabledState(requestedEnabledState: boolean) { this.alarmMonitor.setEnabledState(requestedEnabledState) }

    protected postInitialize(alarmMonitorOptions: AlarmMonitorOptions) {
        const am = this.alarmMonitor
        if (alarmMonitorOptions.logLimitChanges ?? true) {
            this.installLimitChanged(am.highHighLimit)
            this.installLimitChanged(am.highLimit)
            this.installLimitChanged(am.lowLimit)
            this.installLimitChanged(am.lowLowLimit)
        }
        const accessReadWrite = AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
        setAccessLevel(am.highHighLimit, accessReadWrite)
        setAccessLevel(am.highLimit, accessReadWrite)
        setAccessLevel(am.lowLimit, accessReadWrite)
        setAccessLevel(am.lowLowLimit, accessReadWrite)
        // set custom message function
        const alarmMonitor = this.alarmMonitor as any
        alarmMonitor._calculateConditionInfo = this._calculateConditionInfo.bind(this)
    }

    // delegated members
    get enabledState(): UATwoStateVariable<LocalizedText> { return this.alarmMonitor.enabledState }
    get ackedState(): UATwoStateVariable<LocalizedText> { return this.alarmMonitor.ackedState }
    get activeState(): UATwoStateVariable<LocalizedText> { return this.alarmMonitor.activeState }
    get confirmedState(): UATwoStateVariable<LocalizedText> { return this.alarmMonitor.confirmedState }
    get conditionClassId(): UAProperty<NodeId, DataType.NodeId> { return this.alarmMonitor.conditionClassId }
    get conditionClassName(): UAProperty<LocalizedText, DataType.LocalizedText> { return this.alarmMonitor.conditionClassName }
    get conditionSubClassId(): UAProperty<NodeId[], DataType.NodeId> { return this.alarmMonitor.conditionSubClassId }
    get conditionSubClassName(): UAProperty<LocalizedText[], DataType.LocalizedText> { return this.alarmMonitor.conditionSubClassName }
    get conditionName(): UAProperty<string, DataType.String> { return this.alarmMonitor.conditionName }
    get branchId(): UAProperty<NodeId, DataType.NodeId> { return this.alarmMonitor.branchId }
    get comment(): UAConditionVariable<LocalizedText, DataType.LocalizedText> { return this.alarmMonitor.comment }
    get clientUserId(): UAProperty<string, DataType.String> { return this.alarmMonitor.clientUserId }
    get eventId(): UAProperty<Buffer<ArrayBufferLike>, DataType.ByteString> { return this.alarmMonitor.eventId }
    get eventType(): UAProperty<NodeId, DataType.NodeId> { return this.alarmMonitor.eventType }
    get message(): UAProperty<LocalizedText, DataType.LocalizedText> { return this.alarmMonitor.message }
    get suppressedOrShelved(): UAProperty<boolean, DataType.Boolean> { return this.alarmMonitor.suppressedOrShelved }
    get supportsFilteredRetain(): UAProperty<boolean, DataType.Boolean> { return this.alarmMonitor.supportsFilteredRetain }
    get retain(): UAProperty<boolean, DataType.Boolean> { return this.alarmMonitor.retain }
    get quality(): UAConditionVariable<StatusCode, DataType.StatusCode> { return this.alarmMonitor.quality }
    get lastSeverity(): UAConditionVariable<number, DataType.UInt16> { return this.alarmMonitor.lastSeverity }
    get severity(): UAProperty<number, DataType.UInt16> { return this.alarmMonitor.severity }
    get limitState(): UAExclusiveLimitStateMachine { return this.alarmMonitor.limitState }
    get time(): UAProperty<Date, DataType.DateTime> { return this.alarmMonitor.time }
    get receiveTime(): UAProperty<Date, DataType.DateTime> { return this.alarmMonitor.receiveTime }
    get inputNode(): UAProperty<NodeId, DataType.NodeId> { return this.alarmMonitor.inputNode }
    get sourceName(): UAProperty<string, DataType.String> { return this.alarmMonitor.sourceName }
    get sourceNode(): UAProperty<NodeId, DataType.NodeId> { return this.alarmMonitor.sourceNode }
    get addComment(): UAMethod { return this.alarmMonitor.addComment }
    get acknowledge(): UAMethod { return this.alarmMonitor.acknowledge }
    get conditionRefresh(): UAMethod { return this.alarmMonitor.conditionRefresh }
    get conditionRefresh2(): UAMethod { return this.alarmMonitor.conditionRefresh2 }
    get confirm(): UAMethod { return this.alarmMonitor.confirm }
    get disable(): UAMethod { return this.alarmMonitor.disable }
    get enable(): UAMethod { return this.alarmMonitor.enable }
    get lowLowLimit(): UAProperty<number, DataType.Double> { return this.alarmMonitor.lowLowLimit}
    get lowLimit(): UAProperty<number, DataType.Double> { return this.alarmMonitor.lowLimit}
    get highLimit(): UAProperty<number, DataType.Double> { return this.alarmMonitor.highLimit}
    get highHighLimit(): UAProperty<number, DataType.Double> { return this.alarmMonitor.highHighLimit}

    protected getSeverity(stateData: string): number {
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
        const name = this.parentFunction.getDisplayName()
        const message = stateData ? `${name} sensor value ${stateData.toLowerCase()}` : `${name} sensor value normal`
        const result: ConditionInfo = {
            message: new LocalizedText(message),
            quality: StatusCodes.Good,
            retain: true,
            severity: this.getSeverity(stateData),
            isDifferentFrom: undefined
        }
        // console.log(name, oldCondition, result)
        return result
    }
}

export class ExclusiveLimitAlarmImpl extends LimitAlarmImpl {
    constructor(sensorFunction: LADSAnalogScalarSensorFunction | LADSAnalogArraySensorFunction, alarmMonitorOptions: AlarmMonitorOptions) {
        if (!alarmMonitorOptions) return
        super(sensorFunction, alarmMonitorOptions, sensorFunction.sensorValue)
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
        const controlFunction = parent.controlFunction as LADSAnalogControlFunction
        super(controlFunction, alarmMonitorOptions, controlFunction.currentValue, controlFunction.targetValue)
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
export class AnalogScalarSensorFunctionImpl implements LADSAnalogScalarSensorFunction_Base {
    sensorFunction: LADSAnalogScalarSensorFunction
    alarmMonitor: ExclusiveLimitAlarmImpl

    constructor(sensorFunction: LADSAnalogScalarSensorFunction, options: SensorFunctionOptions = undefined) {
        this.sensorFunction = sensorFunction
        if (options?.historizing ?? true) installVariableHistory(this.sensorValue)
        if (options)
            this.alarmMonitor = new ExclusiveLimitAlarmImpl(sensorFunction, options)
    }

    get isEnabled(): UAProperty<boolean, DataType.Boolean> { return this.sensorFunction.isEnabled }
    get rawValue(): UAAnalogUnitRange<number, DataType.Double> | undefined { return this.sensorFunction.rawValue }
    get sensorValue(): UAAnalogUnitRange<number, DataType.Double> { return this.sensorFunction.sensorValue }
    get calibrationValues(): UAProperty<number[], DataType.Double> | undefined { return this.sensorFunction.calibrationValues }

}

export class AnalogScalarSensorWithCompenstionFunctionImpl extends AnalogScalarSensorFunctionImpl implements LADSAnalogScalarSensorWithCompensationFunction_Base {
    constructor(sensorFunction: LADSAnalogScalarSensorWithCompensationFunction, options: SensorFunctionOptions = undefined) { super(sensorFunction, options) }
    get compensationValue(): UAAnalogUnitRange<number, DataType.Double> | undefined { return (this.sensorFunction as LADSAnalogScalarSensorWithCompensationFunction).compensationValue }
}

//---------------------------------------------------------------
// generic control function implementation
//---------------------------------------------------------------
interface ControlFunctionEvents {
    "start": []
    "stop": []
}

export abstract class ControlFunctionImpl extends EventEmitter<ControlFunctionEvents> {
    static stopped: UAState = undefined
    static stopping: UAState = undefined
    static running: UAState = undefined

    static initialize(stateMachine: UAStateMachineEx) {
        if (this.stopped != undefined) return
        this.stopped = stateMachine.getStateByName(LADSFunctionalState.Stopped)
        this.stopping = stateMachine.getStateByName(LADSFunctionalState.Stopping)
        this.running = stateMachine.getStateByName(LADSFunctionalState.Running)
    }

    controlFunction: LADSBaseControlFunction
    stateMachine: UAStateMachineEx

    constructor(controlFunction: LADSBaseControlFunction) {
        super()
        this.controlFunction = controlFunction
        this.stateMachine = promoteToFiniteStateMachine(controlFunction.controlFunctionState)
        controlFunction.controlFunctionState.start?.bindMethod(this.handleStart.bind(this))
        controlFunction.controlFunctionState.stop?.bindMethod(this.handleStop.bind(this))
        ControlFunctionImpl.
            initialize(this.stateMachine)
    }

    get controlFunctionState(): LADSFunctionalStateMachine { return this.controlFunction.controlFunctionState }
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
    constructor(controlFunction: LADSMultiStateDiscreteControlFunction) { super(controlFunction) }
    get targetValue(): UAMultiStateDiscrete<number, DataType.UInt32> { return (this.controlFunction as LADSMultiStateDiscreteControlFunction).targetValue }
    get currentValue(): UAMultiStateDiscrete<number, DataType.UInt32> { return (this.controlFunction as LADSMultiStateDiscreteControlFunction).currentValue }

    initEnumStrings(enumStrings: string[]) {
        setStringArrayValue(this.targetValue.enumStrings, enumStrings)
        setStringArrayValue(this.currentValue.enumStrings, enumStrings)
    }

    get targetValueEnumStrings(): LocalizedText[] { return this.targetValue.enumStrings.readValue().value.value} 
    get targetValueString(): string {return this.targetValueEnumStrings[getNumericValue(this.targetValue)].text }
    get currentValueEnumStrings(): LocalizedText[] { return this.currentValue.enumStrings.readValue().value.value} 
    get currentValueString(): string {return this.currentValueEnumStrings[getNumericValue(this.currentValue)].text }
}

//---------------------------------------------------------------
// analog control function implementation
//---------------------------------------------------------------
export class AnalogControlFunctionImpl extends ControlFunctionImpl {
    alarmMonitor: ExclusiveDeviationAlarmImpl

    constructor(controlFunction: LADSAnalogControlFunction, alarmMonitorOptions: AlarmMonitorOptions = undefined) {
        super(controlFunction)
        controlFunction.controlFunctionState.startWithTargetValue?.bindMethod(this.handleStartWithTargetValue.bind(this))
        if (alarmMonitorOptions)
            this.alarmMonitor = new ExclusiveDeviationAlarmImpl(this, alarmMonitorOptions)
    }

    get targetValue(): UAAnalogUnitRange<number, DataType.Double> { return (this.controlFunction as LADSAnalogControlFunction).targetValue }
    get currentValue(): UAAnalogUnitRange<number, DataType.Double> { return (this.controlFunction as LADSAnalogControlFunction).currentValue }
    get engineeringUnits(): EUInformation { return getEUInformation(this.currentValue) }

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

    constructor(controlFunction: LADSTimerControlFunction, autoStop = false) {
        super(controlFunction)
        this.started = Date.now()
        this.autoStop = autoStop
        this.targetValue?.on("value_changed", (dataValue) => { this.updateDifferenceValue() })
        this.currentValue?.on("value_changed", (dataValue) => { this.updateDifferenceValue() })
    }

    get differenceValue(): UAAnalogUnitRange<number, DataType.Double> { return (this.controlFunction as LADSTimerControlFunction).differenceValue }

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

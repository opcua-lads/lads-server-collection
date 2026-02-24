// SPDX-FileCopyrightText: 2023 - 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-FileCopyrightText:  2023 SPECTARIS - Deutscher Industrieverband für optische, medizinische und mechatronische Technologien e.V. and affiliates.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2023 - 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 * Copyright (c) 2023 SPECTARIS - Deutscher Industrieverband für optische, medizinische und mechatronische Technologien e.V. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
    DataType,
    DateTime,
    LocalizedText,
    UAAnalogUnit,
    UAAnalogUnitRange,
    UAExclusiveDeviationAlarm,
    UAExclusiveLimitAlarm,
    UAExclusiveLimitAlarm_Base,
    UAFile,
    UAFiniteStateMachine,
    UAMethod,
    UAMultiStateDiscrete,
    UAObject,
    UAProperty,
    UAString,
    UATwoStateDiscrete,
    UAVariable
} from "node-opcua"
import { UAComponent, UADevice, UAFunctionalGroup, UALockingServices } from "node-opcua-nodeset-di"

//---------------------------------------------------------------
// Interfaces for LADS devices
//---------------------------------------------------------------
export interface LADSComponent extends UAComponent {
    identification?: MachineIdentificationType
    deviceHealth?: UAVariable
    components?: UAObject
    lifetimeCounters?: UAObject
    operationCounters?: OperationCounters
    maintenance?: UAObject
}

export interface MachineIdentificationType extends UAComponent {
    location?: UAProperty<UAString, DataType.String>
    initialOperationDate?: UAProperty<Date, DataType.DateTime>
}

export interface LifetimeVariableType extends UAAnalogUnit<number, DataType.Double> {
    limitValue: UAProperty<number, DataType.Double>
    startValue: UAProperty<number, DataType.Double>
    warningValues?: UAProperty<number[], DataType.Double>
}

export interface LADSDevice extends UADevice {
    deviceState: LADSDeviceStateMachine
    machineryItemState?: UAFiniteStateMachine
    machineryOperationMode?: MachineryOperationModeStateMachine
    operationalLocation?: UAProperty<UAString, DataType.String>
    hierarchicalLocation?: UAProperty<UAString, DataType.String>
    identification?: MachineIdentificationType
    components?: UAObject
    functionalUnitSet: LADSFunctionalUnitSet | UAObject
    operationCounters?: OperationCounters
    lock?: UALockingServices
}

export interface OperationCounters extends UAFunctionalGroup {
    operationCycleCounter?: UAProperty<number, DataType.UInt32>
    operationDuration?: UAProperty<number, DataType.Double>
    powerOnDuration?: UAProperty<number, DataType.Double>
}

export interface LADSFunctionalUnitSet {
    [key: string]: LADSFunctionalUnit
}

//---------------------------------------------------------------
// Interfaces for LADS functional unit
//---------------------------------------------------------------
export interface LADSSupportedProperty extends UAObject { }
export interface LADSSupportedPropertiesSet {
    [key: string]: LADSSupportedProperty
}

export interface LADSProgramManager extends UAObject {
    programTemplateSet: LADSProgramTemplateSet | UAObject
    activeProgram: LADSActiveProgram
    resultSet: LADSResultSet | UAObject
}

export interface LADSFunctionalUnit extends UAObject {
    functionSet: LADSFunctionSet | UAObject
    programManager: LADSProgramManager
    functionalUnitState: LADSFunctionalUnitStateMachine
    lock?: UALockingServices
    supportedPropertiesSet?: LADSSupportedPropertiesSet
}

export interface LADSFunctionSet {
    [key: string]: LADSFunction
}

//---------------------------------------------------------------
// Interfaces for LADS state machines
//---------------------------------------------------------------
// LADSDeviceStateMachine
export enum LADSDeviceState {
    Initialization = 'Initialization',
    Operate = 'Operate',
    Sleep = 'Sleep',
    Shutdown = 'Shutdown',
}
export interface LADSDeviceStateMachine extends UAFiniteStateMachine {
    gotoOperate?: UAMethod
    gotoShutdown?: UAMethod
    gotoSleep?: UAMethod
}

// MachineryItemState
export enum MachineryItemState {
    NotAvailable = 'NotAvailable',
    Executing = 'Executing',
    NotExecuting = 'NotExecuting',
    OutOfService = 'OutOfService',
}

// MachineryOperationMode
export enum MachineryOperationMode {
    None = 'None',
    Processing = 'Processing',
    Maintenance = 'Maintenance',
    Setup = 'Setup',
}
export interface MachineryOperationModeStateMachine extends UAFiniteStateMachine {
    gotoMaintenance?: UAMethod
    gotoProcessing?: UAMethod
    gotoSetup?: UAMethod
}

// LADSCoverStateMachine
export enum LADSCoverState {
    Opened = 'Opened',
    Closed = 'Closed',
    Locked = 'Locked',
}
export interface LADSCoverStateMachine extends UAFiniteStateMachine {
    open: UAMethod
    close: UAMethod
    lock?: UAMethod
    unlock?: UAMethod
}

// FunctionalStateMachine
export enum LADSFunctionalState {
    Clearing = 'Clearing',
    Running = 'Running',
    Stopping = 'Stopping',
    Stopped = 'Stopped',
    Aborting = 'Aborting',
    Aborted = 'Aborted',
}

export interface LADSFunctionalStateMachine_Base{
    runningStateMachine?: LADSRunnnigStateMachine
    start: UAMethod
    stop: UAMethod
    abort: UAMethod
    clear?: UAMethod
} 
export interface LADSFunctionalStateMachine extends UAFiniteStateMachine, LADSFunctionalStateMachine_Base { }

export interface LADSFunctionalUnitStateMachine_Base extends LADSFunctionalStateMachine_Base {
    startProgram?: UAMethod
}
export interface LADSFunctionalUnitStateMachine extends LADSFunctionalStateMachine, LADSFunctionalUnitStateMachine_Base { }

export interface LADSControlFunctionStateMachine extends LADSFunctionalStateMachine {
    startWithTargetValue?: UAMethod
}

// RunningStateMachine
export enum LADSRunnnigState {
    Idle = 'Idle',
    Starting = 'Starting',
    Execute = 'Execute',
    Suspending = 'Suspending',
    Suspended = 'Suspended',
    Unsuspending = 'Unsuspending',
    Holding = 'Holding',
    Held = 'Held',
    Unholding = 'Unholding',
    Completing = 'Completing',
    Complete = 'Complete',
    Resetting = 'Resetting',
}

export interface LADSRunnnigStateMachine extends UAFiniteStateMachine {
    suspend: UAMethod
    unsuspend: UAMethod
    hold: UAMethod
    unhold: UAMethod
    toComplete: UAMethod
    reset: UAMethod
    start: UAMethod
}

//---------------------------------------------------------------
// Interfaces for LADS functions
//---------------------------------------------------------------
export interface LADSFunction_Base {
    isEnabled: UAProperty<boolean, DataType.Boolean>
    functionSet?: LADSFunctionSet
}
export interface LADSFunction extends LADSFunction_Base, UAObject { }

export interface LADSCoverFunction_Base extends LADSFunction_Base {
    coverState: LADSCoverStateMachine
}
export interface LADSCoverFunction extends LADSFunction, LADSCoverFunction_Base { }

//---------------------------------------------------------------
// Interfaces for LADS sensor-functions
//---------------------------------------------------------------
export interface LADSBaseSensorFunction_Base extends LADSFunction_Base { }
export interface LADSBaseSensorFunction extends LADSFunction, LADSBaseSensorFunction_Base { }

//---------------------------------------------------------------
export interface LADSAnalogSensorFunction_Base extends LADSBaseSensorFunction_Base {
    alarmMonitor?: UAExclusiveLimitAlarm_Base
    damping?: UAProperty<number, DataType.Double>
}

export interface LADSAnalogSensorFunction extends LADSBaseSensorFunction, Omit<LADSAnalogSensorFunction_Base, "alarmMonitor"> { 
    alarmMonitor?: UAExclusiveLimitAlarm
}

//---------------------------------------------------------------
export interface LADSAnalogScalarSensorFunction_Base extends LADSAnalogSensorFunction_Base {
    calibrationValues?: UAProperty<number[], DataType.Double>
    rawValue?: UAAnalogUnitRange<number, DataType.Double>
    sensorValue: UAAnalogUnitRange<number, DataType.Double>
}
export interface LADSAnalogScalarSensorFunction extends LADSAnalogSensorFunction, Omit<LADSAnalogScalarSensorFunction_Base, "alarmMonitor"> { }

//---------------------------------------------------------------
export interface LADSAnalogScalarSensorWithCompensationFunction_Base extends LADSAnalogScalarSensorFunction_Base {
    compensationValue?: UAAnalogUnitRange<number, DataType.Double>
}
export interface LADSAnalogScalarSensorWithCompensationFunction extends LADSAnalogScalarSensorFunction, Omit<LADSAnalogScalarSensorWithCompensationFunction_Base, "alarmMonitor"> { }

//---------------------------------------------------------------
interface LADSAnalogArraySensorFunction_Base extends LADSAnalogSensorFunction_Base {
    rawValue?: UAAnalogUnitRange<Float64Array, DataType.Double>
    sensorValue: UAAnalogUnitRange<Float64Array, DataType.Double>
}
export interface LADSAnalogArraySensorFunction extends LADSAnalogSensorFunction, Omit<LADSAnalogArraySensorFunction_Base, "alarmMonitor"> { }

//---------------------------------------------------------------
export interface LADSDiscreteSensorFunction_Base extends LADSBaseSensorFunction_Base { }
export interface LADSDiscreteSensorFunction extends LADSBaseSensorFunction, LADSDiscreteSensorFunction_Base { }

//---------------------------------------------------------------
export interface LADSTwoStateDiscreteSensorFunction_Base extends LADSDiscreteSensorFunction_Base {
    sensorValue: UATwoStateDiscrete<boolean>
}
export interface LADSTwoStateDiscreteSensorFunction extends LADSDiscreteSensorFunction, LADSTwoStateDiscreteSensorFunction_Base { }

//---------------------------------------------------------------
export interface LADSMultiStateDiscreteSensorFunction_Base extends LADSDiscreteSensorFunction_Base {
    sensorValue: UAMultiStateDiscrete<number, DataType.UInt32>
}
export interface LADSMultiStateDiscreteSensorFunction extends LADSDiscreteSensorFunction, LADSMultiStateDiscreteSensorFunction_Base { }

//---------------------------------------------------------------
export interface LADSMultiSensorFunctionType_Base extends LADSBaseSensorFunction_Base { }
export interface LADSMultiSensorFunctionType extends LADSBaseSensorFunction, LADSMultiSensorFunctionType_Base  { }

//---------------------------------------------------------------
// Interfaces for LADS control-functions
//---------------------------------------------------------------
export interface LADSBaseControlFunction extends LADSFunction {
    alarmMonitor?: UAExclusiveDeviationAlarm
    controlFunctionState: LADSControlFunctionStateMachine
}

export interface LADSAnalogControlFunction extends LADSBaseControlFunction {
    currentValue: UAAnalogUnitRange<number, DataType.Double>
    targetValue: UAAnalogUnitRange<number, DataType.Double>
}

export interface LADSAnalogControlFunctionWithTotalizer extends LADSAnalogControlFunction {
    totalizedValue: UAAnalogUnitRange<number, DataType.Double>
    resetTotalizer?: UAMethod
}

export interface LADSTimerControlFunction extends LADSAnalogControlFunction {
    differenceValue: UAAnalogUnitRange<number, DataType.Double>
}

export interface LADSControllerParameter {
    alarmMonitor?: UAExclusiveDeviationAlarm
    currentValue: UAAnalogUnitRange<number, DataType.Double>
    targetValue: UAAnalogUnitRange<number, DataType.Double>
}
export interface LADSControllerParameterSet {
    [key: string]: LADSControllerParameter
}
export interface LADSMultiModeControlFunction extends LADSAnalogControlFunction {
    currentMode: UAMultiStateDiscrete<number, DataType.UInt32>
    controllerModeSet: LADSControllerParameterSet
}

export interface LADSMultiStateDiscreteControlFunction extends LADSBaseControlFunction {
    currentValue: UAMultiStateDiscrete<number, DataType.UInt32>
    targetValue: UAMultiStateDiscrete<number, DataType.UInt32>
}

export interface LADSTwoStateDiscreteControlFunction extends LADSBaseControlFunction {
    currentValue: UATwoStateDiscrete<boolean>
    targetValue: UATwoStateDiscrete<boolean>
}

//---------------------------------------------------------------
// Interfaces for LADS program-manager
//---------------------------------------------------------------
export interface LADSActiveProgram {
    currentProgramTemplate?: UAProperty<any, DataType.ExtensionObject>
    currentRuntime?: UAProperty<number, DataType.Double>
    currentPauseTime?: UAProperty<number, DataType.Double>
    currentStepName?: UAProperty<LocalizedText, DataType.LocalizedText>
    currentStepRuntime?: UAProperty<number, DataType.Double>
    currentStepNumber?: UAProperty<number, DataType.UInt32>
    estimatedRuntime?: UAProperty<number, DataType.Double>
    estimatedStepRuntime?: UAProperty<number, DataType.Double>
    estimatedStepNumbers?: UAProperty<number, DataType.UInt32>
    deviceProgramRunId?: UAProperty<string, DataType.String>
}

export interface LADSProgramTemplateSet {
    [key: string]: LADSProgramTemplate
}

export interface LADSProgramTemplate extends UAObject {
    author: UAProperty<string, DataType.String>
    deviceTemplateId: UAProperty<string, DataType.String>
    supervisoryTemplateId?: UAProperty<string, DataType.String>
    created: UAProperty<DateTime, DataType.DateTime>
    modified: UAProperty<DateTime, DataType.DateTime>
    version?: UAProperty<string, DataType.String>
}

export interface LADSResultSet {
    [key: string]: LADSResult
}

export interface LADSProperty {
    key: string
    value: string
}

export interface LADSSampleInfo {
    containerId: string
    sampleId: string
    position: string
    customData: string
}

export interface LADSResult extends UAObject {
    name: UAProperty<string, DataType.String>
    supervisoryJobId?: UAProperty<string, DataType.String>
    supervisoryTaskId?: UAProperty<string, DataType.String>
    properties: UAProperty<any, DataType.ExtensionObject>
    samples: UAProperty<any, DataType.ExtensionObject>
    deviceProgramRunId?: UAProperty<string, DataType.String>
    started: UAProperty<DateTime, DataType.DateTime>
    stopped: UAProperty<DateTime, DataType.DateTime>
    totalRuntime?: UAProperty<number, DataType.Double>
    totalPauseTime?: UAProperty<number, DataType.Double>
    applicationUri: UAProperty<string, DataType.String>
    user: UAProperty<string, DataType.String>
    variableSet: UAObject
    fileSet: UAObject
    programTemplate: LADSProgramTemplate
}

export interface LADSResultFile extends UAObject {
    name: UAProperty<string, DataType.String>
    mimeType: UAProperty<string, DataType.String>
    file?: UAFile
    uRL?: UAProperty<string, DataType.String>
}
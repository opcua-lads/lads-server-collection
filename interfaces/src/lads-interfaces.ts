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
    UAAnalogUnitRange,
    UAExclusiveDeviationAlarm,
    UAExclusiveLimitAlarm,
    UAFile,
    UAFiniteStateMachine,
    UAMethod,
    UAMultiStateDiscrete,
    UAObject,
    UAProperty,
    UAString,
    UATwoStateDiscrete} from "node-opcua"
import { UAComponent, UADevice, UAFunctionalGroup, UALockingServices } from "node-opcua-nodeset-di"

//---------------------------------------------------------------
// Interfaces for LADS devices
//---------------------------------------------------------------
export interface LADSComponent extends UAComponent {
    identification?: MachineIdentificationType
    components?: UAObject
}

export interface MachineIdentificationType extends UAComponent { 
    location?: UAProperty<UAString, DataType.String> 
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
    operationCycleCounter: UAProperty<number, DataType.UInt32>
    operationDuration: UAProperty<number, DataType.Double>
    powerOnDuration: UAProperty<number, DataType.Double>
}

export interface LADSFunctionalUnitSet  {
    [key: string]: LADSFunctionalUnit
}

//---------------------------------------------------------------
// Interfaces for LADS functional unit
//---------------------------------------------------------------
export interface LADSSupportedProperty extends UAObject {}
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
    Processing ='Processing',
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
export interface LADSFunctionalStateMachine extends UAFiniteStateMachine {
    runningStateMachine: LADSRunnnigStateMachine
    start: UAMethod
    stop: UAMethod
    abort: UAMethod
    clear?: UAMethod
}
export interface LADSFunctionalUnitStateMachine extends LADSFunctionalStateMachine {
    startProgram?: UAMethod
}
export interface LADSControlFunctionStateMachine extends LADSFunctionalStateMachine {
    startWithTargetValue?: UAMethod
}

// RunningStateMachine
export enum LADSRunnnigState {
    Starting = 'Starting',
    Executing = 'Executing',
    Suspending = 'Suspending',
    Suspended = 'Suspended',
    Unsuspending = 'Unsuspending',
    Holding = 'Holding',
    Held = 'Held',
    Unholding = 'Unholding',
    Completing = 'Completing',
    Completed = 'Completed',
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
export interface LADSFunction extends UAObject {
    isEnabled: UAProperty<boolean, DataType.Boolean>
    functionSet?: LADSFunctionSet
}

export interface LADSCoverFunction extends LADSFunction {
    coverState: LADSCoverStateMachine
}

//---------------------------------------------------------------
// Interfaces for LADS sensor-functions
//---------------------------------------------------------------
export interface LADSBaseSensorFunction extends LADSFunction {}

export interface LADSAnalogSensorFunction extends LADSBaseSensorFunction {
    alarmMonitor?: UAExclusiveLimitAlarm
    damping?: UAProperty<number, DataType.Double>
}

export interface LADSAnalogScalarSensorFunction extends LADSAnalogSensorFunction {
    calibrationValues?: UAProperty<number[], DataType.Double>
    rawValue?: UAAnalogUnitRange<number, DataType.Double>
    sensorValue: UAAnalogUnitRange<number, DataType.Double>
}

export interface LADSAnalogScalarSensorWithCompensationFunction extends LADSAnalogScalarSensorFunction {
    compensationValue?: UAAnalogUnitRange<number, DataType.Double>
}

export interface LADSAnalogArraySensorFunction extends LADSAnalogSensorFunction {
    rawValue?: UAAnalogUnitRange<Float64Array, DataType.Double>
    sensorValue: UAAnalogUnitRange<Float64Array, DataType.Double>
}

export interface LADSDiscreteSensorFunction extends LADSBaseSensorFunction {}

export interface LADSTwoStateDiscreteSensorFunction extends LADSDiscreteSensorFunction {
    sensorValue: UATwoStateDiscrete<boolean>
}

export interface LADSMultiStateDiscreteSensorFunction extends LADSDiscreteSensorFunction {
    sensorValue: UAMultiStateDiscrete<number, DataType.UInt32>
}

export interface LADSMultiSensorFunctionType extends LADSBaseSensorFunction {}

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
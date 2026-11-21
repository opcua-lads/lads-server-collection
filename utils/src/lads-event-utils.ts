// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { BaseNode, DataType, DataValue, UAAnalogUnitRange, UAObject, UATwoStateDiscrete, UAVariable } from "node-opcua"
import { getEUInformation, getStringValue } from "./lads-variable-utils"
import { EnumDeviceHealth } from "node-opcua-nodeset-di"

//---------------------------------------------------------------
// generic event raising
//---------------------------------------------------------------
/**
 * Raises a BaseEventType event on the notifier node. The event source (SourceNode, SourceName) is the notifier itself, or
 * the given source when the event belongs to a part below it (for example the DeviceHealth variable, the state machine
 * of MachineryOperationMode): clients can then route the event by its SourceNode, not by its text.
 */
export function raiseEvent(node: UAObject, message: string, severity: number = 0, source?: BaseNode) {
    if (!node) return
    const eventType = node.addressSpace.findObjectType("BaseEventType")
    node.raiseEvent(eventType, eventData(message, severity, source))
}

/** Event data: message, severity and, if given, the source node */
export function eventData(message: string, severity: number = 0, source?: BaseNode): Record<string, any> {
    const data: Record<string, any> = {
        message: { dataType: DataType.LocalizedText, value: message },
        severity: { dataType: DataType.UInt16, value: severity }
    }
    if (source) data.sourceNode = { dataType: DataType.NodeId, value: source.nodeId }
    return data
}

/**
 * DeviceHealth (OPC 10000-100, DeviceHealthEnumeration after NAMUR NE 107) as event severity, in the NE 107 order of priority
 * Failure > Check function > Off spec > Maintenance required > Normal.
 */
export function deviceHealthSeverity(health: number): number {
    switch (health) {
        case EnumDeviceHealth.FAILURE: return 900   // Critical: malfunction of the device
        case EnumDeviceHealth.CHECK_FUNCTION: return 600   // Alarm: output temporarily not valid (work on the device)
        case EnumDeviceHealth.OFF_SPEC: return 400   // Warning: operating outside its specified range
        case EnumDeviceHealth.MAINTENANCE_REQUIRED: return 300   // Warning: still valid, maintenance needed soon
        default: return 0     // Info: NORMAL
    }
}

/** Raises an event with the matching severity whenever the DeviceHealth of the device changes. */
export function installDeviceHealthEvents(device: UAObject & { deviceHealth?: UAVariable }) {
    device.deviceHealth?.on("value_changed", (dataValue: DataValue) => {
        const health = dataValue.value.value as number
        raiseEvent(device, `Device health changed to ${EnumDeviceHealth[health] ?? health}`, deviceHealthSeverity(health))
    })
}

//---------------------------------------------------------------
// raise events based on variable value changes
//---------------------------------------------------------------
export class ValueChangedEventReporter {
    static install(eventSource: UAObject, variable: UAVariable) { new ValueChangedEventReporter(eventSource, variable) }

    previousValue: any = null
    eventSource: UAObject
    variable: UAVariable

    constructor(eventSource: UAObject, variable: UAVariable) {
        this.eventSource = eventSource
        this.variable = variable
        this.variable.on("value_changed", this.onChanged.bind(this))
    }

    protected message(value: any): string {
        return `${this.eventSource.getDisplayName()} ${this.variable.getDisplayName()} changed to ${value}.`
    }

    onChanged(dataValue: DataValue) {
        const value = dataValue.value.value
        if (this.previousValue !== null) {
            if (value !== this.previousValue) {
                raiseEvent(this.eventSource, this.message(value))
            }
        }
        this.previousValue = value
    }
}

function toFixed(value: number, decimals: number) {
    var power = Math.pow(10, decimals || 0);
    return String(Math.round(value * power) / power);
}

type AnalogUnitRange = UAAnalogUnitRange<number, DataType.Double>
export class AnalogUnitRangeChangedEventReporter extends ValueChangedEventReporter { 
    static install(eventSource: UAObject, variable: AnalogUnitRange) { new AnalogUnitRangeChangedEventReporter(eventSource, variable) }
    
    decimals: number

    constructor(eventSource: UAObject, variable: AnalogUnitRange, decimals = 1) {
        super(eventSource, variable)
        this.decimals = decimals
    }

    protected message(value: any): string {
        const variable = this.variable as AnalogUnitRange
        const valueStr = toFixed(Number(value), this.decimals)
        const eu = getEUInformation(variable)?.displayName.text
        const euStr = eu ? ` [${eu}]` : ""
        return `${this.eventSource.getDisplayName()} ${this.variable.getDisplayName()} changed to ${valueStr}${euStr}.`
    }

}

type TwoStateDiscrete = UATwoStateDiscrete<boolean>
export class TwoStateDiscreteChangedEventReporter extends ValueChangedEventReporter { 
    static install(eventSource: UAObject, variable: TwoStateDiscrete) { new TwoStateDiscreteChangedEventReporter(eventSource, variable) }

    constructor(eventSource: UAObject, variable: TwoStateDiscrete) {
        super(eventSource, variable)
    }

    protected message(value: any): string {
        const variable = this.variable as TwoStateDiscrete
        const state = Boolean(value)
        const trueStateStr = getStringValue(variable.trueState, "true")
        const falseStateStr = getStringValue(variable.falseState, "false")
        return `${this.eventSource.getDisplayName()} ${this.variable.getDisplayName()} changed to ${state ? trueStateStr : falseStateStr}.`
    }

}


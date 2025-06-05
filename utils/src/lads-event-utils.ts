// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { DataType, DataValue, UAAnalogUnitRange, UAObject, UATwoStateDiscrete, UAVariable } from "node-opcua"
import { getEUInformation, getStringValue } from "./lads-variable-utils"

//---------------------------------------------------------------
// generic event raising
//---------------------------------------------------------------
export function raiseEvent(node: UAObject, message: string, severity: number = 0) {
    if (!node) return
    const eventType = node.addressSpace.findObjectType("BaseEventType")
    node.raiseEvent(eventType, { message: { dataType: DataType.String, value: message }, severity: { dataType: DataType.UInt16, value: severity } })
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


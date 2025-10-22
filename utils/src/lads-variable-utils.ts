// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from "assert"
import { UAVariable, StatusCodes, DataType, StatusCode, LocalizedText, QualifiedName, Range, UAObject, coerceNodeId, UABaseDataVariable, UAMultiStateDiscrete, VariableTypeIds, VariantArrayType, ConstantStatusCode, NodeId,  EUInformation, UABaseAnalog, UAAnalogUnitRange, UATwoStateDiscrete, DateTime, ByteString } from "node-opcua"
import { LADSProperty, LADSSampleInfo } from "@interfaces"
import { constructNameNodeIdExtensionObject, constructPropertiesExtensionObject, constructSamplesExtensionObject } from "./lads-utils"

// ----------------------------------------------------------------------------
// Variable getters
// ----------------------------------------------------------------------------

export function getBooleanValue(variable: UAVariable, defaultValue = false): boolean {
    if (!variable) return defaultValue
    return variable.readValue().value.value
}

export function getNumericValue(variable: UAVariable, defaultValue = 0): number {
    if (!variable) return defaultValue
    return variable.readValue().value.value
}

export function getNumericArrayValue(variable: UAVariable, defaultValue = []): number[] {
    if (!variable) return defaultValue
    return variable.readValue().value.value
}

export function getStringValue(variable: UAVariable, defaultValue = ""): string {
    if (!variable) return defaultValue
    const value = variable.readValue().value.value
    const dataType = variable.dataTypeObj.basicDataType
    switch (dataType) {
        case DataType.String:
            return value;
        case DataType.LocalizedText:
            return (<LocalizedText>value).text
        case DataType.QualifiedName:
            return (<QualifiedName>value).name
        default:
            return defaultValue
    }
}

export function getDateTimeValue(variable: UAVariable): DateTime {
    if (!variable) return undefined
    return variable.readValue().value.value
}

export function getEUInformation(variable: UABaseAnalog<number, any>): EUInformation { return variable.engineeringUnits?.readValue().value.value }

export function getItem<T>(item: T | null, propertyName: string): T {
    if (!item) {
        throw new Error(`Failed to get ${propertyName}`);
    }
    return item as T
}

// ----------------------------------------------------------------------------
// Variable setters
// ----------------------------------------------------------------------------
export const NumericDataTypes = new Set<number>([DataType.Int16, DataType.Int32, DataType.Int64, DataType.UInt16, DataType.UInt32, DataType.UInt64, DataType.Byte, DataType.Float, DataType.Double])

export function setBooleanValue(variable: UAVariable, value: boolean, statusCode = StatusCodes.Good) {
    if (!variable) return
    variable.setValueFromSource({ dataType: DataType.Boolean, value: value }, statusCode)
}

export function setNumericValue(variable: UAVariable, value: number, statusCode = StatusCodes.Good) {
    if (!variable) return
    const dataTypeObject = variable.dataTypeObj
    const dataType = dataTypeObject.basicDataType
    try {
        assert(NumericDataTypes.has(dataType))
    } catch (err) {
        console.debug(err)
    }
    variable.setValueFromSource({ dataType: dataType, value: value }, statusCode)
}

export function setNumericArrayValue(variable: UAVariable, value: number[], statusCode = StatusCodes.Good) {
    if (!variable) return
    const dataTypeObject = variable.dataTypeObj
    const dataType = dataTypeObject.basicDataType
    const isArray = variable.valueRank === VariantArrayType.Array
    try {
        assert(NumericDataTypes.has(dataType) && isArray)
    } catch (err) {
        console.debug(err)
    }
    variable.setValueFromSource({ dataType: dataType, value: value }, statusCode)
}

export function setStringValue(variable: UAVariable, value: string | LocalizedText, statusCode = StatusCodes.Good) {
    if (!variable) return
    const dataType = variable.dataTypeObj.basicDataType
    assert((dataType === DataType.String) || (dataType === DataType.LocalizedText))
    variable.setValueFromSource({ dataType: dataType, value: value }, statusCode)
}

export function setStringArrayValue(variable: UAVariable, value: string[] | LocalizedText[], statusCode = StatusCodes.Good) {
    if (!variable) return
    const dataTypeObject = variable.dataTypeObj
    const dataType = dataTypeObject.basicDataType
    const isString = (dataType === DataType.String) || (dataType === DataType.LocalizedText)
    const isArray = variable.valueRank === VariantArrayType.Array
    try {
        assert(isString && isArray)
    } catch (err) {
        console.debug(err)
    }
    variable.setValueFromSource({ dataType: dataType, value: value }, statusCode)
}

export function setStatusCodeValue(variable: UAVariable, value: StatusCode, statusCode = StatusCodes.Good) {
    if (!variable) return
    variable.setValueFromSource({ dataType: DataType.StatusCode, value: value }, statusCode)
}

export function modifyStatusCode(variable: UAVariable, statusCode: StatusCode) {
    if (!variable) return
    variable.setValueFromSource( variable.readValue().value, statusCode)
}

export function setDateTimeValue(variable: UAVariable, value: Date, statusCode = StatusCodes.Good) {
    if (!variable) return
    variable.setValueFromSource({ dataType: DataType.DateTime, value: value }, statusCode)
}

export function setByteStringValue(variable: UAVariable, value: ByteString, statusCode = StatusCodes.Good) {
    if (!variable) return
    variable.setValueFromSource({ dataType: DataType.ByteString, value: value }, statusCode)
}

export function setPropertiesValue(variable: UAVariable, properties: LADSProperty[]) {
    if (!variable) return
    variable.setValueFromSource({ dataType: DataType.ExtensionObject, value: constructPropertiesExtensionObject(variable.addressSpace, properties), arrayType: VariantArrayType.Array })
}

export function setSamplesValue(variable: UAVariable, samples: LADSSampleInfo[]) {
    if (!variable) return
    variable.setValueFromSource({ dataType: DataType.ExtensionObject, value: constructSamplesExtensionObject(variable.addressSpace, samples), arrayType: VariantArrayType.Array })
}

export function setNameNodeIdValue(variable: UAVariable, name: string, nodeId: NodeId) {
    if (!variable) return
    variable.setValueFromSource({ dataType: DataType.ExtensionObject, value: constructNameNodeIdExtensionObject(variable.addressSpace, name, nodeId) })
}

// ----------------------------------------------------------------------------
// Variable initializers
// ----------------------------------------------------------------------------
export function initializeAnalogUnitRange(variable: UAAnalogUnitRange<number, DataType.Double>, value: number, euInformation: EUInformation, range: Range, historizing: boolean = false) {
    setNumericValue(variable, value)
    if (euInformation) {
        variable.engineeringUnits.setValueFromSource({ value: euInformation, dataType: DataType.ExtensionObject })
    }
    if (range) {
        variable.euRange.setValueFromSource({ value: range, dataType: DataType.ExtensionObject })
    }
    if (historizing) {
        variable.historizing = true
        variable.addressSpace.installHistoricalDataNode(variable)
    }
}

export function initializeTwoStateDiscrete(variable: UATwoStateDiscrete<boolean>, value: boolean, falseState: string, trueState: string) {
    setBooleanValue(variable, value)
    setStringValue(variable?.trueState, trueState)
    setStringValue(variable?.falseState, falseState)
}

// ----------------------------------------------------------------------------
// Create variables at runtime
// ----------------------------------------------------------------------------
export function addStringVariable(parent: UAObject, name: string, value = ""): UABaseDataVariable<string, DataType.String> {
    if (!parent) return undefined
    const namespace = parent.namespace
    return <UABaseDataVariable<string, DataType.String>>namespace.addVariable({
        browseName: name,
        componentOf: parent,
        dataType: DataType.String,
        value: { dataType: DataType.String, value: value }
    })
}

export function addUInt32Variable(parent: UAObject, name: string, value = 0): UABaseDataVariable<number, DataType.UInt32> {
    if (!parent) return undefined
    const namespace = parent.namespace
    return <UABaseDataVariable<number, DataType.UInt32>>namespace.addVariable({
        browseName: name,
        componentOf: parent,
        dataType: DataType.UInt32,
        value: { dataType: DataType.UInt32, value: value }
    })
}

export function addBooleanVariable(parent: UAObject, name: string, value = false): UABaseDataVariable<boolean, DataType.Boolean> {
    if (!parent) return undefined
    const namespace = parent.namespace
    return <UABaseDataVariable<boolean, DataType.Boolean>>namespace.addVariable({
        browseName: name,
        componentOf: parent,
        dataType: DataType.Boolean,
        value: { dataType: DataType.Boolean, value: value }
    })
}

export function addMultiStateDiscreteVariable(parent: UAObject, name: string, value: number, enumStrings: string[]): UAMultiStateDiscrete<number, DataType.UInt32> {
    if (!parent) return undefined
    const namespace = parent.namespace
    const variable = <UAMultiStateDiscrete<number, DataType.UInt32>>namespace.addVariable({
        browseName: name,
        typeDefinition: coerceNodeId(VariableTypeIds.MultiStateDiscreteType),
        componentOf: parent,
        dataType: DataType.UInt32,
        value: { dataType: DataType.UInt32, value: value },
    })
    const l = enumStrings.map((value: string) => (new LocalizedText(value)))
    variable.enumStrings?.setValueFromSource({ arrayType: VariantArrayType.Array, dataType: DataType.LocalizedText, value: l })
    return variable
}

export function addDoubleVariable(parent: UAObject, name: string, value = 0): UABaseDataVariable<number, DataType.Double> {
    if (!parent) return undefined
    const namespace = parent.namespace
    return <UABaseDataVariable<number, DataType.Double>>namespace.addVariable({
        browseName: name,
        componentOf: parent,
        dataType: DataType.Double,
        value: { dataType: DataType.Double, value: value }
    })
}

export function addStatusCodeVariable(parent: UAObject, name: string, value = StatusCodes.Good): UABaseDataVariable<ConstantStatusCode, DataType.StatusCode> {
    if (!parent) return undefined
    const namespace = parent.namespace
    return <UABaseDataVariable<ConstantStatusCode, DataType.StatusCode>>namespace.addVariable({
        browseName: name,
        componentOf: parent,
        dataType: DataType.StatusCode,
        value: { dataType: DataType.StatusCode, value: value }
    })
}


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
import { UAVariable, StatusCodes, DataType, StatusCode, LocalizedText, QualifiedName, UAObject, coerceNodeId, UABaseDataVariable, UAMultiStateDiscrete, VariableTypeIds, VariantArrayType, ConstantStatusCode } from "node-opcua"
import { LADSProperty, LADSSampleInfo } from "@interfaces"
import { constructPropertiesExtensionObject, constructSamplesExtensionObject } from "./lads-utils"

export function getBooleanValue(variable: UAVariable): boolean {
    if (!variable) return false
    return variable.readValue().value.value
}

export function setBooleanValue(variable: UAVariable, value: boolean, statusCode = StatusCodes.Good) {
    if (!variable) return
    variable.setValueFromSource({dataType: DataType.Boolean, value: value}, statusCode)
}

export function getNumericValue(variable: UAVariable): number {
    if (!variable) return 0
    return variable.readValue().value.value
}

export function getNumericArrayValue(variable: UAVariable): number[] {
    if (!variable) return []
    return variable.readValue().value.value
}

const NumericDataTypes = new Set<number>([DataType.Int16, DataType.Int32, DataType.Int64, DataType.UInt16, DataType.UInt32, DataType.UInt64, DataType.Byte, DataType.Float, DataType.Double])
export function setNumericValue(variable: UAVariable, value: number, statusCode = StatusCodes.Good) {
    if (!variable) return
    const dataTypeObject = variable.dataTypeObj
    const dataType = dataTypeObject.basicDataType
    try {
        assert(NumericDataTypes.has(dataType))
    } catch(err) {
        console.debug(err)
    }
    variable.setValueFromSource({dataType: dataType, value: value}, statusCode)
}

export function setNumericArrayValue(variable: UAVariable, value: number[], statusCode = StatusCodes.Good) {
    if (!variable) return
    const dataTypeObject = variable.dataTypeObj
    const dataType = dataTypeObject.basicDataType
    const isArray = variable.valueRank === VariantArrayType.Array
    try {
        assert(NumericDataTypes.has(dataType) && isArray)
    } catch(err) {
        console.debug(err)
    }
    variable.setValueFromSource({dataType: dataType, value: value}, statusCode)
}

export function setStringValue(variable: UAVariable, value: string, statusCode = StatusCodes.Good) {
    if (!variable) return
    const dataType = variable.dataTypeObj.basicDataType
    assert((dataType === DataType.String) || (dataType === DataType.LocalizedText))
    variable.setValueFromSource({dataType: dataType, value: value}, statusCode)
}

export function setStatusCodeValue(variable: UAVariable, value: StatusCode, statusCode = StatusCodes.Good) {
    if (!variable) return
    variable.setValueFromSource({dataType: DataType.StatusCode, value: value}, statusCode)
}

export function setDateTimeValue(variable: UAVariable, value: Date, statusCode = StatusCodes.Good) {
    if (!variable) return
    variable.setValueFromSource({dataType: DataType.DateTime, value: value}, statusCode)
}

export function getStringValue(variable: UAVariable, defaultValue = ""): string {
    if (!variable) return defaultValue
    const value =  variable.readValue().value.value
    const dataType = variable.dataTypeObj.basicDataType
    switch (dataType) {
        case DataType.String:
            return value; 
        case DataType.LocalizedText:
            return (<LocalizedText>value).text
        case DataType.QualifiedName:
            return (<QualifiedName>value).name
    }
}

export function setPropertiesValue(variable: UAVariable, properties: LADSProperty[]) {
    if (!variable) return
    variable?.setValueFromSource({ dataType: DataType.ExtensionObject, value: constructPropertiesExtensionObject(variable.addressSpace, properties), arrayType: VariantArrayType.Array })
}

export function setSamplesValue(variable: UAVariable, samples: LADSSampleInfo[]) {
    if (!variable) return
    variable?.setValueFromSource({ dataType: DataType.ExtensionObject, value: constructSamplesExtensionObject(variable.addressSpace, samples), arrayType: VariantArrayType.Array })
}

export function getItem<T>(item: T | null, propertyName: string): T {
    if (!item) {
        throw new Error(`Failed to get ${propertyName}`);
    }
    return item as T
}

export function addStringVariable(parent: UAObject, name: string, value = ""): UABaseDataVariable<string, DataType.String> {
    if (!parent) return undefined
    const namespace = parent.namespace
    return <UABaseDataVariable<string, DataType.String>>namespace.addVariable({
        browseName: name,
        componentOf: parent,
        dataType: DataType.String,
        value: { dataType: DataType.String, value: value}
    })
}

export function addUInt32Variable(parent: UAObject, name: string, value = 0): UABaseDataVariable<number, DataType.UInt32> {
    if (!parent) return undefined
    const namespace = parent.namespace
    return <UABaseDataVariable<number, DataType.UInt32>>namespace.addVariable({
        browseName: name,
        componentOf: parent,
        dataType: DataType.UInt32,
        value: { dataType: DataType.UInt32, value: value}
    })
}

export function addBooleanVariable(parent: UAObject, name: string, value = false): UABaseDataVariable<boolean, DataType.Boolean> {
    if (!parent) return undefined
    const namespace = parent.namespace
    return <UABaseDataVariable<boolean, DataType.Boolean>>namespace.addVariable({
        browseName: name,
        componentOf: parent,
        dataType: DataType.Boolean,
        value: { dataType: DataType.Boolean, value: value}
    })
}

export function addMultiStateDiscreteVariable(parent: UAObject, name: string, value: number, enumStrings: string[]): UAMultiStateDiscrete<number, DataType.UInt32> {
    if (!parent) return undefined
    const namespace = parent.namespace
    const variable =  <UAMultiStateDiscrete<number, DataType.UInt32>>namespace.addVariable({
        browseName: name,
        typeDefinition: coerceNodeId(VariableTypeIds.MultiStateDiscreteType),
        componentOf: parent,
        dataType: DataType.UInt32,
        value: { dataType: DataType.UInt32, value: value},
    })
    const l = enumStrings.map((value: string) => (new LocalizedText(value)))
    variable.enumStrings?.setValueFromSource({arrayType: VariantArrayType.Array, dataType: DataType.LocalizedText, value: l})
    return variable
}

export function addDoubleVariable(parent: UAObject, name: string, value = 0): UABaseDataVariable<number, DataType.Double> {
    if (!parent) return undefined
    const namespace = parent.namespace
    return <UABaseDataVariable<number, DataType.Double>>namespace.addVariable({
        browseName: name,
        componentOf: parent,
        dataType: DataType.Double,
        value: { dataType: DataType.Double, value: value}
    })
}

export function addStatusCodeVariable(parent: UAObject, name: string, value = StatusCodes.Good): UABaseDataVariable<ConstantStatusCode, DataType.StatusCode> {
    if (!parent) return undefined
    const namespace = parent.namespace
    return <UABaseDataVariable<ConstantStatusCode, DataType.StatusCode>>namespace.addVariable({
        browseName: name,
        componentOf: parent,
        dataType: DataType.StatusCode,
        value: { dataType: DataType.StatusCode, value: value}
    })
}


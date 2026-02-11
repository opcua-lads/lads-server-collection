// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Balance
Copyright (C) 2025  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.

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

//---------------------------------------------------------------
// interfaces
//---------------------------------------------------------------

import { LADSAnalogScalarSensorFunction, LADSFunctionalUnit, LADSDevice, LADSComplianceDocumentSet, LADSMultiStateDiscreteControlFunction, LADSProgramManager, LADSResult } from "@interfaces"
import { NameNodeId } from "@utils"
import { DataType, EUInformation, NodeId, UAAnalogUnit, UAObject, UAProperty } from "node-opcua"

//---------------------------------------------------------------
export interface MWFunctionSet extends UAObject {
    selectedProduct: LADSMultiStateDiscreteControlFunction
    temperature: LADSAnalogScalarSensorFunction
    density: LADSAnalogScalarSensorFunction
    moisture: LADSAnalogScalarSensorFunction
}

export interface MWProgramManager extends LADSProgramManager {
    lastEmptyCheck: UAProperty<Date, DataType.DateTime>
    lastResult : UAProperty<NameNodeId, DataType.ExtensionObject>
    lastResultData: MWResult
}

export interface MWFunctionalUnit extends Omit<LADSFunctionalUnit, "functionSet, programManager">  {
    functionSet: MWFunctionSet
    programManager: MWProgramManager
}

export interface MWFunctionalUnitSet extends UAObject {
    MWUnit: MWFunctionalUnit
}

export interface MWDevice extends Omit<LADSDevice, "functionalUnitSet, components"> {
    functionalUnitSet: MWFunctionalUnitSet
    complianceDocumentSet?: LADSComplianceDocumentSet
    productSet: ProductSet
}

export interface MeasurementResult extends UAObject {
    average: UAProperty<number, DataType.Double>
    standardDeviation: UAProperty<number, DataType.Double>
    samples: UAProperty<number, DataType.Double>
    engineeringUnits: EUInformation
}

export interface MWVariableSet extends UAObject {
    product: Product
    moisture: MeasurementResult
    density: MeasurementResult
    temperature: MeasurementResult
}

export interface MWResult extends Omit<LADSResult, "variableSet"> {
    variableSet: MWVariableSet
}

export interface ProductSet extends UAObject{}

export interface Product extends UAObject{
    name: UAProperty<string, DataType.String>
    moistureOffset: UAProperty<number, DataType.Double>
    moistureLowLimit: UAProperty<number, DataType.Double>
    moistureHighLimit: UAProperty<number, DataType.Double>
    densityOffset: UAProperty<number, DataType.Double>
    densityLowLimit: UAProperty<number, DataType.Double>
    densityHighLimit: UAProperty<number, DataType.Double>
    temperatureLowLimit: UAProperty<number, DataType.Double>
    temperatureHighLimit: UAProperty<number, DataType.Double>
    sampleCount: UAProperty<number, DataType.UInt32>
}


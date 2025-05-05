// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

//---------------------------------------------------------------
// interfaces
//---------------------------------------------------------------

import { LADSAnalogScalarSensorFunction, LADSAnalogScalarSensorWithCompensationFunction, LADSFunctionalUnit, LADSDevice, LADSComponent } from "@interfaces"
import { UAObject } from "node-opcua"

//---------------------------------------------------------------
export interface pHMeterFunctionSet extends UAObject {
    temperatureSensor: LADSAnalogScalarSensorFunction
    pHSensor: LADSAnalogScalarSensorWithCompensationFunction
}

export interface pHMeterFunctionalUnit extends Omit<LADSFunctionalUnit, "functionSet"> {
    functionSet: pHMeterFunctionSet
}

export interface pHMeterFunctionalUnitSet extends UAObject {
    pHMeterUnit: pHMeterFunctionalUnit
}
export interface pHMeterDevice extends Omit<LADSDevice, "functionalUnitSet, components"> {
    functionalUnitSet: pHMeterFunctionalUnitSet
    components: phMeterComponents
}

export interface phMeterComponents extends UAObject {
    pHSensor: LADSComponent
}


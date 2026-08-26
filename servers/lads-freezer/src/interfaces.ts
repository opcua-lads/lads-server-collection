// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { LADSAnalogControlFunction, LADSAnalogScalarSensorFunction, LADSCoverFunction, LADSDevice, LADSFunctionalUnit } from "@interfaces"
import { UAObject } from "node-opcua"

//---------------------------------------------------------------
// interfaces
//---------------------------------------------------------------
export interface FreezerFunctionSet extends UAObject {
    temperatureSensor: LADSAnalogScalarSensorFunction
    temperatureController: LADSAnalogControlFunction
    door: FreezerDoorFunction
}

export interface FreezerDoorFunction extends LADSCoverFunction {
    functionSet?: {
        timer: LADSAnalogScalarSensorFunction
    }
}

export interface FreezerFunctionalUnit extends Omit<LADSFunctionalUnit, "functionSet"> {
    functionSet: FreezerFunctionSet
}

export interface FreezerFunctionalUnitSet extends UAObject {
    freezerUnit: FreezerFunctionalUnit
}
export interface FreezerDevice extends Omit<LADSDevice, "functionalUnitSet"> {
    functionalUnitSet: FreezerFunctionalUnitSet
}


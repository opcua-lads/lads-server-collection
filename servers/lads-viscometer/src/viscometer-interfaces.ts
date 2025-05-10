// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

import { LADSAnalogControlFunction, LADSAnalogScalarSensorFunction, LADSMultiStateDiscreteControlFunction, LADSFunctionalUnit, LADSDevice } from "@interfaces"
import { UAObject } from "node-opcua"

/*
LADS Viscometer
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
export interface ViscometerFunctionSet extends UAObject {
    speedController: LADSAnalogControlFunction
    temperature: LADSAnalogScalarSensorFunction
    temperatureController: LADSAnalogControlFunction
    relativeTorque: LADSAnalogScalarSensorFunction
    torque: LADSAnalogScalarSensorFunction
    viscosity: LADSAnalogScalarSensorFunction
    shearStress: LADSAnalogScalarSensorFunction
    shearRate: LADSAnalogScalarSensorFunction
    spindle: LADSMultiStateDiscreteControlFunction
}

export interface ViscometerFunctionalUnit extends Omit<LADSFunctionalUnit, "functionSet"> {
    functionSet: ViscometerFunctionSet
}

export interface ViscometerFunctionalUnitSet extends UAObject {
    viscometerUnit: ViscometerFunctionalUnit
}
export interface ViscometerDevice extends Omit<LADSDevice, "functionalUnitSet"> {
    functionalUnitSet: ViscometerFunctionalUnitSet
}

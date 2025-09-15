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

import { LADSAnalogScalarSensorFunction, LADSFunctionalUnit, LADSDevice, LADSTwoStateDiscreteSensorFunction, LADSMultiStateDiscreteSensorFunction } from "@interfaces"
import { UAObject } from "node-opcua"

//---------------------------------------------------------------
export interface BalanceFunctionSet extends UAObject {
    weightSensor: LADSAnalogScalarSensorFunction
    weightStable: LADSTwoStateDiscreteSensorFunction
    tareMode: LADSMultiStateDiscreteSensorFunction
}

export interface BalanceFunctionalUnit extends Omit<LADSFunctionalUnit, "functionSet"> {
    functionSet: BalanceFunctionSet
}

export interface BalanceFunctionalUnitSet extends UAObject {
    balanceUnit: BalanceFunctionalUnit
}
export interface BalanceDevice extends Omit<LADSDevice, "functionalUnitSet, components"> {
    functionalUnitSet: BalanceFunctionalUnitSet
    components: BalanceComponents
}

export interface BalanceComponents extends UAObject {}


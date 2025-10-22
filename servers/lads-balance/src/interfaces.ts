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

import { LADSAnalogScalarSensorFunction, LADSFunctionalUnit, LADSDevice, LADSTwoStateDiscreteSensorFunction, LADSMultiStateDiscreteSensorFunction, LADSFunctionalUnitStateMachine, LADSComplianceDocument, LADSComplianceDocumentSet } from "@interfaces"
import { DataType, UABaseDataVariable, UAMethod, UAObject } from "node-opcua"

export const BalanceTareOptionals = ["FunctionSet.CurrentWeight.FunctionSet", "FunctionalUnitState.SetPresetTare", "FunctionalUnitState.ClearTare"]
//---------------------------------------------------------------

export interface BalanceCurrentWeightType extends Omit<LADSAnalogScalarSensorFunction, "functionSet"> {
    functionSet?: {
        gross: LADSAnalogScalarSensorFunction
        net: LADSAnalogScalarSensorFunction
        tare: LADSAnalogScalarSensorFunction
    }
}

export interface BalanceFunctionSet extends UAObject {
    currentWeight: BalanceCurrentWeightType
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
    complianceDocumentSet?: LADSComplianceDocumentSet
}

export interface BalanceFunctionalUnitStatemachine extends LADSFunctionalUnitStateMachine {
    setTare: UAMethod
    setZero: UAMethod
    registerWeight: UAMethod
    setPresetTare?: UAMethod
    clearTare?: UAMethod
}
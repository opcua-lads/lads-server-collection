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

import { getNumericValue, setNumericValue } from '@utils'
import { BalanceFunctionalUnit } from './interfaces';
import { BalanceDeviceImpl } from './device';
import { BalanceUnitImpl } from './unit';
import { AccessLevelFlag, DataType, DataValue, UAVariable } from 'node-opcua';

//---------------------------------------------------------------
export class BalanceSimulatorUnitImpl extends BalanceUnitImpl {
    simSampleWeight: UAVariable
    simTareWeight: UAVariable
    simGrossWeight: UAVariable

    constructor(parent: BalanceDeviceImpl, functionalUnit: BalanceFunctionalUnit) {
        super(parent, functionalUnit)
        const namespace = functionalUnit.namespace
        const simulator = namespace.addObject({
            componentOf: functionalUnit,
            browseName: "Simulator"
        })
        this.simSampleWeight = namespace.addVariable({
            componentOf: simulator,
            browseName: "Sample Weight",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.0 }
        })
        this.simTareWeight = namespace.addVariable({
            componentOf: simulator,
            browseName: "Tare Weight",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.0 }
        })
        this.simGrossWeight = namespace.addVariable({
            componentOf: simulator,
            browseName: "Gross Weight",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.0 },
            accessLevel: AccessLevelFlag.CurrentRead
        })

        this.simSampleWeight.on("value_changed", (dataValue: DataValue) => { setNumericValue(this.simGrossWeight, getNumericValue(this.simTareWeight) + Number(dataValue.value.value)) })
        this.simTareWeight.on("value_changed", (dataValue: DataValue) => { setNumericValue(this.simGrossWeight, getNumericValue(this.simSampleWeight) + Number(dataValue.value.value)) })

        // start run loop
        const dT = 200
        setInterval(() => { this.evaluate(dT) }, dT)
    }

    get simulationMode(): boolean { return true }

    private evaluate(dT: number) {
        const sim_gross = getNumericValue(this.simGrossWeight)
        const sim_tare = getNumericValue(this.simTareWeight)

        const cf = 0.1
        const new_gross = (1.0 - cf) * getNumericValue(this.balanceSensor.rawValue) + cf * sim_gross
        setNumericValue(this.balanceSensor.rawValue, new_gross)
        setNumericValue(this.balanceSensor.sensorValue, new_gross + sim_tare)
    }

}

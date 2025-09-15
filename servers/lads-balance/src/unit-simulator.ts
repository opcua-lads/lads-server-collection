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
import { AccessLevelFlag, DataType, UAVariable } from 'node-opcua';
import { SimulatedBalance } from './balance-simulator';

//---------------------------------------------------------------
export class BalanceSimulatorUnitImpl extends BalanceUnitImpl {
    sampleWeight: UAVariable
    tareWeight: UAVariable
    zeroWeight: UAVariable
    grossWeight: UAVariable
    rawWeight: UAVariable
    filteredRawWeight = 0

    constructor(parent: BalanceDeviceImpl, functionalUnit: BalanceFunctionalUnit) {
        super(parent, functionalUnit)

        // create balance
        this.balance = new SimulatedBalance(this.getRawWeight.bind(this))
        
        // create variables for simulator
        const namespace = functionalUnit.namespace
        const simulator = namespace.addObject({
            componentOf: functionalUnit,
            browseName: "Simulator"
        })
        this.sampleWeight = namespace.addVariable({
            componentOf: simulator,
            browseName: "Sample Weight",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.0 }
        })
        this.tareWeight = namespace.addVariable({
            componentOf: simulator,
            browseName: "Tare Weight",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.0 }
        })
        this.zeroWeight = namespace.addVariable({
            componentOf: simulator,
            browseName: "Zero Weight",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.0 }
        })
        this.grossWeight = namespace.addVariable({
            componentOf: simulator,
            browseName: "Gross Weight",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.0 },
            accessLevel: AccessLevelFlag.CurrentRead
        })
        this.rawWeight = namespace.addVariable({
            componentOf: simulator,
            browseName: "Raw Weight",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.0 },
            accessLevel: AccessLevelFlag.CurrentRead
        })

        // start simulation loop
        const dT = 200
        setInterval(async () => { this.evaluate(dT) }, 200)

        // start balance polling loop
        setInterval(async () => { 
            await this.balance.getCurrentReading()
        }, 500)

        this.postInitialize()
    }

    getRawWeight(): number { return this.filteredRawWeight }

    private async evaluate(dT: number) {        
        // compute simulated values
        const gross = getNumericValue(this.sampleWeight) + getNumericValue(this.tareWeight)
        const raw = gross + getNumericValue(this.zeroWeight)
        setNumericValue(this.grossWeight, gross)
        setNumericValue(this.rawWeight, raw)

        // evaluate low pass filter
        const cf = 0.2
        this.filteredRawWeight = (1.0 - cf) * this.filteredRawWeight + cf * raw
    }

}

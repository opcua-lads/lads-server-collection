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
import { BalanceFunctionalUnitSet } from './interfaces';
import { BalanceDeviceImpl } from './device';
import { BalanceUnitImpl } from './unit';
import { AccessLevelFlag, DataType, UAVariable } from 'node-opcua';
import { SimulatedBalance } from './balance-simulator';
import { BalanceEvents } from './balance';

//---------------------------------------------------------------
export class SimulatedBalanceUnitImpl extends BalanceUnitImpl {
    private simSampleWeight: UAVariable
    private simTareWeight: UAVariable
    private simZeroWeight: UAVariable
    private simGrossWeight: UAVariable
    private simRawWeight: UAVariable
    // Initialize to 50g (matching initial simSampleWeight) to avoid starting at 0
    private filteredRawWeight = 50.0

    constructor(parent: BalanceDeviceImpl, functionalUnitSet: BalanceFunctionalUnitSet) {
        super(parent)

        // create balance
        this.balance = new SimulatedBalance(this.getRawWeight.bind(this))
        
        // create variables for simulator
        const functionalUnit = this.functionalUnit
        const namespace = functionalUnit.namespace
        const simulator = namespace.addObject({
            componentOf: functionalUnit,
            browseName: "Simulator"
        })
        this.simSampleWeight = namespace.addVariable({
            componentOf: simulator,
            browseName: "Sample Weight",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 50.0 }
        })
        this.simTareWeight = namespace.addVariable({
            componentOf: simulator,
            browseName: "Tare Weight",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.0 }
        })
        this.simZeroWeight = namespace.addVariable({
            componentOf: simulator,
            browseName: "Zero Weight",
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
        this.simRawWeight = namespace.addVariable({
            componentOf: simulator,
            browseName: "Raw Weight",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.0 },
            accessLevel: AccessLevelFlag.CurrentRead
        })

        // start simulation loop
        setInterval(async () => { this.evaluate() }, 200)

        // Weight change simulation: change weight every 5 seconds
        // Simulates realistic balance behavior:
        // - Weight changes (sample added/removed)
        // - Brief instability, then settles to stable
        // - TareMode stays at "None" (no tare set)
        let weightDirection = 1

        setInterval(async () => {
            const simulatedBalance = this.balance as SimulatedBalance

            // Change weight by ±0.5g (simulates sample weight variation)
            const currentWeight = getNumericValue(this.simSampleWeight)
            const newWeight = currentWeight + (weightDirection * 0.5)
            setNumericValue(this.simSampleWeight, newWeight)
            weightDirection *= -1

            // Set unstable immediately when weight changes
            simulatedBalance.simulatedStable = false
            console.log(`[Balance Simulator] Weight changed: ${newWeight.toFixed(2)}g, Stable: false`)

            // Emit reading immediately with unstable state
            const unstableReading = await simulatedBalance.getCurrentReading()
            simulatedBalance.emit(BalanceEvents.Reading, unstableReading)

            // Capture the weight value for the stable reading (don't re-read)
            const capturedWeight = unstableReading.weight
            const capturedTareMode = unstableReading.tareMode

            // After 1 second, measurement has settled -> stable
            setTimeout(() => {
                simulatedBalance.simulatedStable = true
                console.log(`[Balance Simulator] Measurement settled, Stable: true`)

                // Emit reading with same weight but stable=true
                simulatedBalance.emit(BalanceEvents.Reading, {
                    weight: capturedWeight,
                    unit: "g",
                    stable: true,
                    tareMode: capturedTareMode
                })
            }, 1000)
        }, 5000)

        // finalize iitialization
        this.postInitialize()
    }

    getRawWeight(): number { return this.filteredRawWeight }

    private async evaluate() {
        // compute simulated values with noise (like viscometer simulator)
        // noise simulates real balance behavior with small fluctuations
        const noise = 0.002 * (Math.random() - 0.5)
        const gross = getNumericValue(this.simSampleWeight) + getNumericValue(this.simTareWeight) + noise
        const raw = gross + getNumericValue(this.simZeroWeight)
        setNumericValue(this.simGrossWeight, gross)
        setNumericValue(this.simRawWeight, raw)

        // evaluate low pass filter with fast convergence (cf=0.8)
        // Higher cf = faster response: converges within 2-3 iterations (~400-600ms)
        // This gives brief "unstable" period after 5-second step changes, then settles to "stable"
        const cf = 0.8
        this.filteredRawWeight = (1.0 - cf) * this.filteredRawWeight + cf * raw
    }

}

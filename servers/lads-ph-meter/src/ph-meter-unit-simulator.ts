// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS pH-Meter
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

import { getNumericArrayValue, getNumericValue, setNumericValue } from '@utils'
import { pHMeterFunctionalUnit } from './ph-meter-interfaces';
import { pHMeterDeviceImpl } from './ph-meter-device';
import { Constants, pHMeterUnitImpl, ProgramTemplateIds } from './ph-meter-unit';
import { AccessLevelFlag, DataType, UAVariable } from 'node-opcua';

//---------------------------------------------------------------
export class pHMeterSimulatorUnitImpl extends pHMeterUnitImpl {
    simpHPV: UAVariable
    simpHOfs: UAVariable
    simpHSlope: UAVariable
    simpHRaw: UAVariable
    simTPV: UAVariable
    simTOfs: UAVariable
    simTSlope: UAVariable
    simTRaw: UAVariable

    constructor(parent: pHMeterDeviceImpl, functionalUnit: pHMeterFunctionalUnit) {
        super(parent, functionalUnit)
        const namespace = functionalUnit.namespace
        const simulator = namespace.addObject({
            componentOf: functionalUnit,
            browseName: "Simulator"
        })
        this.simpHPV = namespace.addVariable({
            componentOf: simulator,
            browseName: "pH.PV",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 6.0 }
        })
        this.simpHSlope = namespace.addVariable({
            componentOf: simulator,
            browseName: "pH.Slope",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 100.0 }
        })
        this.simpHOfs = namespace.addVariable({
            componentOf: simulator,
            browseName: "pH.Offset",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.0 }
        })
        this.simpHRaw = namespace.addVariable({
            componentOf: simulator,
            browseName: "pH.Raw",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.0 },
            accessLevel: AccessLevelFlag.CurrentRead
        })
        this.simTPV = namespace.addVariable({
            componentOf: simulator,
            browseName: "T.PV",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 25.0 },
        })
        this.simTRaw = namespace.addVariable({
            componentOf: simulator,
            browseName: "T.Raw",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 1000.0 },
            accessLevel: AccessLevelFlag.CurrentRead
        })
        // start run loop
        const dT = 200
        setInterval(() => { this.evaluate(dT) }, dT)
    }

    get simulationMode(): boolean { return true }

    private evaluate(dT: number) {
        if (!this.simulationMode) return

        const R0 = 1000
        const lastpH = getNumericValue(this.pHSensor.sensorValue)
        const lastT = getNumericValue(this.temperatureSensor.sensorValue)

        // compute simulated sensor values
        const simpH = getNumericValue(this.simpHPV)
        const simSlope = getNumericValue(this.simpHSlope)
        const simOfs = getNumericValue(this.simpHOfs)
        const simT = getNumericValue(this.simTPV)
        const simRaw = 1000.0 * Math.log(10) * Constants.R * (simT + Constants.T0) / Constants.F * (7.0 + simOfs - simpH) * 0.01 * simSlope // mV
        const simR = R0 * (1 + 0.00385 * simT) // Ohm
        setNumericValue(this.simpHRaw, simRaw)
        setNumericValue(this.simTRaw, simR)

        // set sensor raw values with some additional noise
        const snsRaw = simRaw + 0.5 * (Math.random() - 0.5)
        const snsR = simR + 0.1 * (Math.random() - 0.5)
        setNumericValue(this.pHSensor.rawValue, snsRaw)
        setNumericValue(this.temperatureSensor.rawValue, snsR)

        // compute sensor values
        const cf = dT / 5000 // filter constant 5s
        const T = ((snsR / R0) - 1) / 0.00385
        const snsT = (1.0 - cf) * lastT + cf * T
        setNumericValue(this.temperatureSensor.sensorValue, snsT)
        setNumericValue(this.pHSensor.compensationValue, snsT)

        const cal: number[] = getNumericArrayValue(this.pHSensor.calibrationValues)
        const snsOfs = cal[0]
        const snsSlope = cal[1]
        const pH = 7.0 + snsOfs - 0.001 * snsRaw / (0.01 * snsSlope) * Constants.F / (Math.log(10) * Constants.R * (snsT + Constants.T0))
        const snspH = (1.0 - cf) * lastpH + cf * pH
        setNumericValue(this.pHSensor.sensorValue, snspH)
    }

    protected enterMeasuring() {
        // set simulated pH
        const pHValues: { id: string, value: number }[] = [
            { id: ProgramTemplateIds.Measure, value: 7.0 + 6.0 * (Math.random() - 0.5) },
            { id: ProgramTemplateIds.CalibrateOffset, value: 7 },
            { id: ProgramTemplateIds.CalibrateSlope, value: 4 },
        ]
        const options = this.currentRunOptions
        const pHPropertyKey = options.programTemplateId === ProgramTemplateIds.Measure ? "ph" : "buffer"
        const pHProperty = options.properties?.find(property => property.key.toLowerCase().includes(pHPropertyKey))
        options.referenceValue = pHProperty ? Number(pHProperty.value) : pHValues.find(value => value.id === options.programTemplateId).value
        setNumericValue(this.simpHPV, options.referenceValue)

        // enter measuring
        super.enterMeasuring()
    }

}

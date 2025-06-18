// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

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

import { AccessLevelFlag, DataType, StatusCodes, UAVariable } from "node-opcua";
import { getNumericValue, setNumericValue } from "@utils";
import { ViscometerUnitImpl } from "./viscometer-unit";
import { ViscometerDeviceImpl } from "./viscometer-device";
import { ViscometerFunctionalUnit } from "./viscometer-interfaces";

export class ViscometerUnitSimulatorImpl extends ViscometerUnitImpl { 
    // simulation
    viscosity_0: UAVariable
    alpha: UAVariable    
    n: UAVariable

    constructor(parent: ViscometerDeviceImpl, functionalUnit: ViscometerFunctionalUnit) {
        super(parent, functionalUnit)
        // simulation
        const namespace = this.functionalUnit.namespace
        const simulator = namespace.addObject({
            componentOf: this.functionalUnit,
            browseName: "Simulator",
            description: "Viscositiy simulation with temperataue and shearforce dependencies."
        })
        this.viscosity_0 = namespace.addVariable({
            componentOf: simulator,
            browseName: "Simulated Viscosity",
            description: "Viscosity at temperature 25°C and shear rate 1/s",
            dataType: DataType.Double,
            value: {dataType: DataType.Double, value: 622.8 },
            accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
        })
        this.alpha = namespace.addVariable({
            componentOf: simulator,
            browseName: "Simulated Alpha",
            description: "Temperature coefficient for viscosity [%/K]",
            dataType: DataType.Double,
            value: {dataType: DataType.Double, value: 0.01 },
            accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
        })
        this.n = namespace.addVariable({
            componentOf: simulator,
            browseName: "Simulated N",
            description: "Flow behavior index according to power law model. N = 1 : no shear rate dependency; N > 1: shear thickening, dilatant; 0 < N < 1 : shear thinning, pseudo-plastic",
            dataType: DataType.Double,
            value: {dataType: DataType.Double, value: 0.95 },
            accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
        })

        const dT = 200
        setInterval(() => this.evaluate(dT), dT)
    }

    protected evaluate(dT: number) {

        // input values
        const tpv = getNumericValue(this.temperatureController.currentValue)
        const npv = getNumericValue(this.speedController.currentValue)
        const shearRate = getNumericValue(this.shearRate.sensorValue)
        setNumericValue(this.temperature.sensorValue, tpv)

        // simulated viscosity
        const viscosity_0 = getNumericValue(this.viscosity_0)  // viscosity at 25°C and 1/s
        const alpha = getNumericValue(this.alpha)
        const n = getNumericValue(this.n)
        const viscosity_t = viscosity_0 / (1.0 + alpha * (tpv - 25.0)) // temperature dependency
        const viscosity_pv = shearRate > 0?viscosity_t * Math.pow(shearRate, n - 1):viscosity_t // shear dependency

        // resulting torque
        const noise =  0.002 * (Math.random() - 0.5)
        const relativeTorque = viscosity_pv * npv / 100.0 / (this.model.tk * this.spindle.smc) + noise
        setNumericValue(this.relativeTorque.sensorValue, relativeTorque)
        const torque = 1000.0 * this.model.tk * (relativeTorque / 100.0) // absolute toreque in mNm
        setNumericValue(this.torque.sensorValue, torque)

        // measured viscosity
        const valid = npv > 0.01
        const statusCode = valid?StatusCodes.Good:StatusCodes.UncertainLastUsableValue
        const viscosity = valid?100.0 / npv * this.model.tk * this.spindle.smc * relativeTorque + noise:getNumericValue(this.viscosity.sensorValue)
        setNumericValue(this.viscosity.sensorValue, viscosity, statusCode)

        // shear stress
        const shearStress = this.model.tk * this.spindle.src * this.spindle.smc * relativeTorque
        setNumericValue(this.shearStress.sensorValue, shearStress)
    }


}

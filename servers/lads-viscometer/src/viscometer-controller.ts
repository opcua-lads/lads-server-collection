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

import { AFODictionary, AFODictionaryIds } from "@afo"
import { LADSAnalogControlFunction, LADSAnalogScalarSensorFunction, LADSComponent, LADSFunctionalState } from "@interfaces"
import { AnalogControlFunctionImpl, setNumericValue, raiseEvent, getNumericValue, LADSComponentOptions, initComponent } from "@utils"
import { ViscometerUnitImpl } from "./unit"
import { ControllerOptions } from "./server"
import { ViscometerFunctionSet } from "./interfaces"
import { AccessLevelFlag, DataType, StatusCodes, UAVariable } from "node-opcua"
import { ControllerImpl } from "./controller"

//---------------------------------------------------------------
// viscometer controller implementation
//---------------------------------------------------------------
export class ViscometerControllerImpl extends ControllerImpl {
    speedControlFunction: SpeedControlFunction
    temperature: LADSAnalogScalarSensorFunction
    relativeTorque: LADSAnalogScalarSensorFunction
    torque: LADSAnalogScalarSensorFunction
    viscosity: LADSAnalogScalarSensorFunction
    shearStress: LADSAnalogScalarSensorFunction
    shearRate: LADSAnalogScalarSensorFunction

    constructor(parent: ViscometerUnitImpl, options: ControllerOptions, component?: LADSComponent) {
        super(parent, options)

        if (component) {
            const componentOptions: LADSComponentOptions = {
                manufacturer: "AMETEK Brookfield",
                model: parent.model.name,
            }
            initComponent(component, componentOptions)
        }

        // initialize viscosity with history
        const functionSet: ViscometerFunctionSet = parent.functionalUnit.functionSet
        this.viscosity = functionSet.viscosity
        const viscosityValue = this.viscosity.sensorValue
        viscosityValue.historizing = true
        functionSet.addressSpace.installHistoricalDataNode(viscosityValue)
        // initialize other functions
        this.relativeTorque = functionSet.relativeTorque
        this.torque = functionSet.torque
        this.shearStress = functionSet.shearStress
        this.shearRate = functionSet.shearRate
        this.temperature = functionSet.temperature
        this.temperature.sensorValue.setValueFromSource({ dataType: DataType.Double, value: 25.0 })
        AFODictionary.addSensorFunctionReferences(this.viscosity, AFODictionaryIds.viscosity)
        AFODictionary.addSensorFunctionReferences(this.relativeTorque, AFODictionaryIds.relative_intensity)
        AFODictionary.addSensorFunctionReferences(this.torque, AFODictionaryIds.torque)
        AFODictionary.addSensorFunctionReferences(this.shearStress, AFODictionaryIds.shear_stress_of_quality)
        AFODictionary.addSensorFunctionReferences(this.shearRate, AFODictionaryIds.rate)
        AFODictionary.addSensorFunctionReferences(this.temperature, AFODictionaryIds.temperature_measurement, AFODictionaryIds.temperature)

        // init simulator / gateway
        const port = options?.serialPort ?? ""
        const simulator = true
        simulator ? new ViscometerControllerSimulator(this) : new ViscometerControllerGateway(this)
    }

    start() { this.speedControlFunction.start() }
    stop() { this.speedControlFunction.stop() }
}

//---------------------------------------------------------------
// viscometer controller simulator
//---------------------------------------------------------------
class ViscometerControllerSimulator {
    viscosity_0: UAVariable
    alpha: UAVariable
    n: UAVariable

    constructor(controller: ViscometerControllerImpl) {
        const functionalUnit = controller.parent.functionalUnit
        controller.speedControlFunction = new SpeedControlFunctionSimulator(functionalUnit.functionSet.speedController)
        const namespace = functionalUnit.namespace
        const simulator = namespace.addObject({
            componentOf: functionalUnit,
            browseName: "Simulator",
            description: "Viscositiy simulation with temperataue and shearforce dependencies."
        })
        this.viscosity_0 = namespace.addVariable({
            componentOf: simulator,
            browseName: "Simulated Viscosity",
            description: "Viscosity at temperature 25°C and shear rate 1/s",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 622.8 },
            accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
        })
        this.alpha = namespace.addVariable({
            componentOf: simulator,
            browseName: "Simulated Alpha",
            description: "Temperature coefficient for viscosity [%/K]",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.01 },
            accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
        })
        this.n = namespace.addVariable({
            componentOf: simulator,
            browseName: "Simulated N",
            description: "Flow behavior index according to power law model. N = 1 : no shear rate dependency; N > 1: shear thickening, dilatant; 0 < N < 1 : shear thinning, pseudo-plastic",
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.95 },
            accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
        })

        const dT = 500
        setInterval(() => this.evaluate(dT, controller), dT)
    }

    private evaluate(dT: number, controller: ViscometerControllerImpl) {
        // evaluate speed controller
        (controller.speedControlFunction as SpeedControlFunctionSimulator).evaluate(dT)

        // input values
        const tpv = getNumericValue(controller.parent.temperatureController.temperatureControlFunction.currentValue)
        const npv = getNumericValue(controller.speedControlFunction.currentValue)
        const shearRate = getNumericValue(controller.shearRate.sensorValue)
        setNumericValue(controller.temperature.sensorValue, tpv)

        // simulated viscosity
        const viscosity_0 = getNumericValue(this.viscosity_0)  // viscosity at 25°C and 1/s
        const alpha = getNumericValue(this.alpha)
        const n = getNumericValue(this.n)
        const viscosity_t = viscosity_0 / (1.0 + alpha * (tpv - 25.0)) // temperature dependency
        const viscosity_pv = shearRate > 0 ? viscosity_t * Math.pow(shearRate, n - 1) : viscosity_t // shear dependency

        // resulting torque
        const model = controller.parent.model
        const spindle = controller.parent.spindle

        const noise = 0.002 * (Math.random() - 0.5)
        const relativeTorque = viscosity_pv * npv / 100.0 / (model.tk * spindle.smc) + noise
        setNumericValue(controller.relativeTorque.sensorValue, relativeTorque)
        const torque = 1000.0 * model.tk * (relativeTorque / 100.0) // absolute toreque in mNm
        setNumericValue(controller.torque.sensorValue, torque)

        // measured viscosity
        const valid = npv > 0.01
        const statusCode = valid ? StatusCodes.Good : StatusCodes.UncertainLastUsableValue
        const viscosity = valid ? 100.0 / npv * model.tk * spindle.smc * relativeTorque + noise : getNumericValue(controller.viscosity.sensorValue)
        setNumericValue(controller.viscosity.sensorValue, viscosity, statusCode)

        // shear stress
        const shearStress = model.tk * spindle.src * spindle.smc * relativeTorque
        setNumericValue(controller.shearStress.sensorValue, shearStress)
    }
}

//---------------------------------------------------------------
// viscometer controller gateway
//---------------------------------------------------------------
class ViscometerControllerGateway {
    constructor(controller: ViscometerControllerImpl) {
        const port = controller.options?.serialPort ?? ""
    }
}

//---------------------------------------------------------------
// abstract speed control function implementation
//---------------------------------------------------------------
export abstract class SpeedControlFunction extends AnalogControlFunctionImpl {

    constructor(controller: LADSAnalogControlFunction) {
        super(controller, 30.0, 0.0)
        this.controller.targetValue.on("value_changed", (dataValue => { raiseEvent(this.controller, `Speed set-point changed to ${dataValue.value.value}rpm`) }))
        AFODictionary.addControlFunctionReferences(this.controller, AFODictionaryIds.rotational_speed, AFODictionaryIds.rotational_speed)
    }
}

//---------------------------------------------------------------
// simulated speed function implementation
//---------------------------------------------------------------
export class SpeedControlFunctionSimulator extends SpeedControlFunction {

    evaluate(dT: number) {
        function calcSpeed(sp: number, pv: number): number {
            const delta = 0.001 * dT * 10 // 10rpm/s
            if (Math.abs(sp - pv) < delta) {
                return sp
            } else if (pv < sp) {
                return pv + delta
            } else {
                return pv - delta
            }
        }

        const running = this.controllerState.getCurrentState().includes(LADSFunctionalState.Running)
        const sp = getNumericValue(this.controller.targetValue)
        const pv = getNumericValue(this.controller.currentValue)
        const newpv = running ? calcSpeed(sp, pv) : 0
        setNumericValue(this.controller.currentValue, newpv)
    }
}



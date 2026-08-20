// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { CallMethodResultOptions, DataType, ISessionContext, StatusCodes, UAStateMachineEx, VariantLike } from "node-opcua"
import { LADSAnalogControlFunction, LADSAnalogScalarSensorFunction, LADSCoverFunction, LADSCoverState, LADSFunctionalState } from "@interfaces"
import { installVariableHistory, LockImpl, promoteToFiniteStateMachine, raiseEvent } from "@utils"
import { FreezerFunctionalUnit } from "./interfaces"

export class FreezerUnitImpl {
    functionalUnit: FreezerFunctionalUnit
    temperatureSensor: LADSAnalogScalarSensorFunction
    temperatureController: LADSAnalogControlFunction
    temperatureControllerStateMachine: UAStateMachineEx
    door: LADSCoverFunction
    doorStateMachine: UAStateMachineEx
    functionalUnitStateMachine: UAStateMachineEx
    lock: LockImpl
    compressorRunning: boolean = false

    constructor(functionalUnit: FreezerFunctionalUnit) {
        this.functionalUnit = functionalUnit
        this.functionalUnitStateMachine = promoteToFiniteStateMachine(functionalUnit.functionalUnitState)
        this.functionalUnitStateMachine.setState(LADSFunctionalState.Running)

        const functionSet = functionalUnit.functionSet

        // temperature sensor and controller
        this.temperatureSensor = functionSet.temperatureSensor
        this.temperatureController = functionSet.temperatureController
        this.temperatureControllerStateMachine = promoteToFiniteStateMachine(this.temperatureController.controlFunctionState)
        this.temperatureControllerStateMachine.setState(LADSFunctionalState.Running)
        this.temperatureController.targetValue.on("value_changed", dataValue => {
            const value = Number(dataValue.value.value)
            raiseEvent(this.temperatureController, `Target value changed to ${value}°C`)
        })

        // door state machine and methods
        this.door = functionSet.door
        const stateMachine = this.door.coverState
        this.doorStateMachine = promoteToFiniteStateMachine(stateMachine)
        this.doorStateMachine.setState(LADSCoverState.Closed)
        stateMachine.open.bindMethod(this.open.bind(this))
        stateMachine.close.bindMethod(this.close.bind(this))

        // history
        installVariableHistory(this.temperatureController.currentValue)
        installVariableHistory(this.temperatureSensor.sensorValue)
        
        // lock
        this.lock = new LockImpl(this.functionalUnit.lock)
        
        // run unit
        const dT = 500
        setInterval(() => { this.evaluate(dT) }, dT) 
    }

    private async open(inputArguments: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        this.doorStateMachine.setState(LADSCoverState.Opened)
        raiseEvent(this.door, "Door opened")
        return { statusCode: StatusCodes.Good }
    }

    private async close(inputArguments: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        this.doorStateMachine.setState(LADSCoverState.Closed)
        raiseEvent(this.door, "Door closed")
        return { statusCode: StatusCodes.Good }
    }

    evaluate(dT: number) {
        const tAmbient = 25.0 // °C
        const gDoorClosed = 2 // W/K
        const gDoorOpen = 50 // W/K
        const heatCapacity = 5000 // J/K
        const tpv = this.temperatureSensor.sensorValue.readValue().value.value
        const tsp = this.temperatureController.targetValue.readValue().value.value
        const doorIsOpen = this.doorStateMachine.getCurrentState()?.includes(LADSCoverState.Opened)

        // heat tranfer model
        const dtAmbient = tAmbient - tpv
        const gAmbient = doorIsOpen ? gDoorOpen : gDoorClosed
        const qCompressor = this.compressorRunning ? -1000 : 0 // Watt
        const qAmbient = dtAmbient * gAmbient
        const t = tpv + (qCompressor + qAmbient) / heatCapacity * 0.001 * dT
        this.temperatureSensor.sensorValue.setValueFromSource({ dataType: DataType.Double, value: t })
        this.temperatureController.currentValue.setValueFromSource({ dataType: DataType.Double, value: t })

        // 2-point compressor controller
        if (this.compressorRunning) {
            if (tpv <= tsp) {
                this.compressorRunning = false
            }
        } else {
            if ((tpv - tsp) > 5) {
                this.compressorRunning = true
            }
        }
    }
}


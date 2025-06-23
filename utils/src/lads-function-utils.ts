// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { assert, CallMethodResultOptions, DataType, DataValue, SessionContext, StatusCode, StatusCodes, UAAnalogUnitRange, UAStateMachineEx, VariantLike } from "node-opcua";
import { LADSAnalogControlFunction, LADSBaseControlFunction, LADSFunctionalState } from "@interfaces";
import { raiseEvent } from "./lads-event-utils";
import { promoteToFiniteStateMachine } from "./lads-utils";
import { setNumericValue } from "./lads-variable-utils";

function startController(controller: LADSBaseControlFunction, stateMachine: UAStateMachineEx, withEvent: boolean): StatusCode {
    const currentState = stateMachine.getCurrentState();
    if (currentState.includes(LADSFunctionalState.Running)) {
        return StatusCodes.BadInvalidState
    }
    stateMachine.setState(LADSFunctionalState.Running)
    if (withEvent) {
        raiseEvent(controller, `${controller.getDisplayName()} started`)
    }
    return StatusCodes.Good
}

function stopController(controller: LADSBaseControlFunction, stateMachine: UAStateMachineEx, withEvent: boolean): StatusCode {
    const currentState = stateMachine.getCurrentState();
    if (currentState.includes(LADSFunctionalState.Stopped) || currentState.includes(LADSFunctionalState.Stopping)) {
        return StatusCodes.BadInvalidState
    }
    stateMachine.setState(LADSFunctionalState.Stopped)
    if (withEvent) {
        raiseEvent(controller, `${controller.getDisplayName()} stopped`)
    }
    return StatusCodes.Good
}

//---------------------------------------------------------------
// abstract control function implementation
//---------------------------------------------------------------
abstract class BaseControlFunctionImpl {
    controllerState: UAStateMachineEx
    controller: LADSAnalogControlFunction

    constructor(controller: LADSAnalogControlFunction) {
        this.controller = controller
        const stateMachine = controller.controlFunctionState
        this.controllerState = promoteToFiniteStateMachine(stateMachine)
        this.controllerState.setState(LADSFunctionalState.Stopped)
        assert(this.controller)

        stateMachine.start?.bindMethod(this.startController.bind(this))
        stateMachine.stop?.bindMethod(this.stopController.bind(this))
        controller.currentValue.historizing = true
        controller.addressSpace.installHistoricalDataNode(controller.currentValue)
    }

    private async startController(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return { statusCode: this.start() }
    }

    private async stopController(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return { statusCode: this.stop() }
    }

    start(): StatusCode {
        const statusCode = startController(this.controller, this.controllerState, true)
        statusCode === StatusCodes.Good ? this.enterStart() : 0
        return statusCode
    }

    stop(): StatusCode {
        const statusCode = stopController(this.controller, this.controllerState, true)
        statusCode === StatusCodes.Good ? this.enterStop() : 0
        return statusCode
    }

    protected enterStart() { }
    protected enterStop() { }
}

//---------------------------------------------------------------
// abstract generic analog control function implementation
//---------------------------------------------------------------
export abstract class AnalogControlFunctionImpl extends BaseControlFunctionImpl{
    constructor(controller: LADSAnalogControlFunction, targetValue: number, currentValue: number) {
        super(controller)
        const name = controller.getDisplayName()
        const currentValueVariable = this.currentValue
        setNumericValue(this.targetValue, targetValue)
        setNumericValue(currentValueVariable, currentValue)
        currentValueVariable.historizing = true
        controller.addressSpace.installHistoricalDataNode(currentValueVariable)
        // currentValueVariable.on("value_changed", (dataValue: DataValue) => console.log(name, dataValue.sourcePicoseconds, dataValue.value.value))

    }

    private get controlFunction(): LADSAnalogControlFunction { return this.controller as LADSAnalogControlFunction}
    get targetValue(): UAAnalogUnitRange<number, DataType.Double> {return this.controlFunction.targetValue}
    get currentValue(): UAAnalogUnitRange<number, DataType.Double> {return this.controlFunction.currentValue}

}



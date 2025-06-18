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
import { LADSAnalogControlFunction, LADSFunctionalState } from "@interfaces"
import { AnalogControlFunctionImpl, setNumericValue, raiseEvent, getNumericValue } from "@utils"

//---------------------------------------------------------------
// abstract speed controller implementation
//---------------------------------------------------------------
export abstract class SpeedController extends AnalogControlFunctionImpl {

    constructor(controller: LADSAnalogControlFunction) {
        super(controller)
        setNumericValue(this.controller.currentValue, 0.0)
        setNumericValue(this.controller.targetValue, 30.0)
        this.controller.targetValue.on("value_changed", (dataValue => { raiseEvent(this.controller, `Speed set-point changed to ${dataValue.value.value}rpm`) }))
        AFODictionary.addControlFunctionReferences(this.controller, AFODictionaryIds.rotational_speed, AFODictionaryIds.rotational_speed)
    }
}

//---------------------------------------------------------------
// simulated speed controller implementation
//---------------------------------------------------------------
export class SpeedControllerSimulator extends SpeedController {

    constructor(controller: LADSAnalogControlFunction) {
        super(controller)
        const dT = 200
        setInterval(() => this.evaluateController(dT), dT)
    }

    private evaluateController(dT: number) {
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



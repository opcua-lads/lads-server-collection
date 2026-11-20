// SPDX-FileCopyrightText: 2025, 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 - 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


//---------------------------------------------------------------
// specialized control functions
//---------------------------------------------------------------

import { AFODictionary, AFODictionaryIds } from "@afo"
import { LADSMultiStateDiscreteControlFunction, LADSTimerControlFunction, LADSAnalogControlFunctionWithTotalizer } from "@interfaces"
import { MulitStateDiscreteControlFunctionImpl, setNumericValue, TimerControlFunctionImpl, AnalogControlFunctionWithTotalizerImpl, getNumericValue } from "@utils"
import { DataValue, UAVariable } from "node-opcua"

//---------------------------------------------------------------
export class DispenseModeControlFunctionImpl extends MulitStateDiscreteControlFunctionImpl {

    constructor(controlFunction: LADSMultiStateDiscreteControlFunction) {
        super(controlFunction)
        this.targetValue?.on("value_changed", (dataValue: DataValue) => { this.currentValue.setValueFromSource(dataValue.value) })
        setNumericValue(this.targetValue, 0)
        // the mode selects how water is dispensed; the target value keeps the default "control setting", the current
        // value (the active mode) is not a setting
        AFODictionary.addReferences(controlFunction, AFODictionaryIds.dispensing)
    }
}

export class DispenseTimerControlFunctionImpl extends TimerControlFunctionImpl {
    dispenseController: DispenseVolumeControlFunctionImpl
    constructor(controlFunction: LADSTimerControlFunction, dispenseController: DispenseVolumeControlFunctionImpl) {
        super(controlFunction, true)
        setNumericValue(this.targetValue, 60.0)
        this.dispenseController = dispenseController
        AFODictionary.addReferences(controlFunction, AFODictionaryIds.dispensing)
        AFODictionary.addReferences(controlFunction.targetValue, AFODictionaryIds.duration_setting)    // setpoint: how long to dispense
        AFODictionary.addReferences(controlFunction.currentValue, AFODictionaryIds.dispensing_duration) // actual: time dispensed so far
    }

    protected onStart(): Promise<void> {
        super.onStart()
        this.dispenseController.initComputeVolumes()
        return
    }

    evaluate(): boolean {
        const running = super.evaluate()
        if (running) this.dispenseController.computeVolumes()
        return running
    }
}

export class DispenseVolumeControlFunctionImpl extends AnalogControlFunctionWithTotalizerImpl {
    flow: UAVariable
    timeBase: number
    timestamp: number

    constructor(controlFunction: LADSAnalogControlFunctionWithTotalizer, flow: UAVariable, timeBase = 60000) {
        super(controlFunction)
        setNumericValue(this.targetValue, 1.0)
        this.flow = flow
        this.timeBase = timeBase
        this.timestamp = Date.now()
        AFODictionary.addReferences(controlFunction, AFODictionaryIds.dispensing)
        AFODictionary.addReferences(controlFunction.targetValue, AFODictionaryIds.volume_setting)      // setpoint: volume to dispense
        AFODictionary.addReferences(controlFunction.currentValue, AFODictionaryIds.dispensed_volume)   // actual: volume dispensed so far
        AFODictionary.addReferences(controlFunction.totalizedValue, AFODictionaryIds.dispensed_volume) // sum of all dispensed volumes
    }

    protected onStart(): Promise<void> {
        this.initComputeVolumes()
        return
    }

    initComputeVolumes() {
        setNumericValue(this.currentValue, 0.0)
        this.timestamp = Date.now()
    }

    computeVolumes(): number {
        const t = Date.now()
        const dT = t - this.timestamp
        const dV = getNumericValue(this.flow) * dT / this.timeBase
        const V = getNumericValue(this.currentValue) + dV
        const Vtotal = getNumericValue(this.totalizedValue) + dV
        this.timestamp = t
        setNumericValue(this.currentValue, V)
        setNumericValue(this.totalizedValue, Vtotal)
        return V
    }

    evaluate() {
        if (!this.isRunning) return   // count only while dispensing
        const V = this.computeVolumes()
        if ((getNumericValue(this.targetValue) - V) <= 0) {
            this.enterStop()
        }
    }

    protected onStop(): Promise<void> {
        this.computeVolumes()
        return
    }
}


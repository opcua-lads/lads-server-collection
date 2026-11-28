// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
AlarmMonitors of the HPLC unit (OPC 30500-1: AlarmMonitor of a control function = ExclusiveDeviationAlarmType, 7.6.1;
of an analog sensor function = ExclusiveLevelAlarmType, 7.5.2). The nodeset's AlarmMonitor, if any, is replaced by a live
condition with the same NodeId (ExclusiveDeviationAlarmImpl / ExclusiveLimitAlarmImpl of @utils).

  - ColumnOven: deviation from the TargetValue, High / Low = ±1 K (Warning: "not settled"), HighHigh / LowLow = ±5 K
    (Alarm). After a start of the oven or a new TargetValue the oven is "settling" until it reaches the narrow band:
    meanwhile a deviation beyond ±5 K is reported as Warning ("settling"), not as Alarm, so heating up raises no alarm.
    Enabled while the oven controller runs. The same narrow band is the default tolerance of the injection gate.
  - Pump/Pressure: level alarm, enabled only during a program run and armed once the pressure has built up (it reached
    the Low limit, or PRESSURE_ARM_S after the start): LowLow 20 bar, Low 50 bar (leak, air, no column), High 550 bar,
    HighHigh 600 bar (pressure limit of the 1260 Infinity II quaternary pump G7111B).
*/

import { DataValue, LocalizedText, StatusCodes } from "node-opcua"
import { ConditionInfo } from "node-opcua-address-space"
import { LADSAnalogControlFunction, LADSAnalogScalarSensorFunction } from "@interfaces"
import { EventSeverity, ExclusiveDeviationAlarmImpl, ExclusiveLimitAlarmImpl, getNumericValue } from "@utils"

export const OVEN_LIMITS = { highHighLimit: 5, highLimit: 1, lowLimit: -1, lowLowLimit: -5 }
export const PRESSURE_LIMITS = { highHighLimit: 600, highLimit: 550, lowLimit: 50, lowLowLimit: 20 }
export const PRESSURE_ARM_S = 60

/** deviation alarm of the column oven that knows whether the oven has settled since its last start / set point change */
export class ColumnOvenAlarm extends ExclusiveDeviationAlarmImpl {
    settled = false

    constructor(private readonly oven: LADSAnalogControlFunction) {
        super(oven, { logLimitChanges: true, ...OVEN_LIMITS })
        oven.targetValue.on("value_changed", () => this.restart())
        oven.currentValue.on("value_changed", () => { if (!this.settled && Math.abs(this.deviation) <= this.band) this.settled = true })
        this.setEnabledState(false)
    }

    get deviation(): number { return getNumericValue(this.oven.currentValue) - getNumericValue(this.oven.targetValue) }
    /** the narrow band: the smaller of High and -Low */
    get band(): number { return Math.min(Math.abs(getNumericValue(this.highLimit, 1)), Math.abs(getNumericValue(this.lowLimit, -1))) }

    /** oven started or a new set point: settling again */
    restart() { this.settled = Math.abs(this.deviation) <= this.band }

    protected getSeverity(stateData: string): number {
        if (!this.settled && (stateData === "HighHigh" || stateData === "LowLow")) return EventSeverity.Warning
        return super.getSeverity(stateData)
    }

    protected _calculateConditionInfo(stateData: string | null, isActive: boolean, value: string, oldCondition: ConditionInfo): ConditionInfo {
        const info = super._calculateConditionInfo(stateData, isActive, value, oldCondition)
        const name = this.oven.getDisplayName()
        const dev = `${this.deviation >= 0 ? "+" : ""}${this.deviation.toFixed(1)} K`
        const text = !stateData ? `${name} within ±${this.band} K of the set point`
            : !this.settled ? `${name} settling (${dev} from the set point)`
                : stateData === "High" || stateData === "Low" ? `${name} not settled (${dev} from the set point)`
                    : `${name} deviation ${dev} from the set point`
        return { ...info, message: new LocalizedText(text), quality: StatusCodes.Good }
    }
}

/** pressure level alarm, active during program runs only */
export class PressureAlarm extends ExclusiveLimitAlarmImpl {
    private armTimer?: NodeJS.Timeout
    private pending = false

    constructor(private readonly sensor: LADSAnalogScalarSensorFunction) {
        super(sensor, { logLimitChanges: true, ...PRESSURE_LIMITS })
        this.setEnabledState(false)
        sensor.sensorValue.on("value_changed", (dv: DataValue) => {
            if (this.pending && Number(dv.value.value) >= getNumericValue(this.lowLimit, 0)) this.activate("pressure built up")
        })
    }

    /** start of a run: enabled once the pressure has built up, at the latest after PRESSURE_ARM_S */
    arm() {
        this.disarm()
        this.pending = true
        this.armTimer = setTimeout(() => this.activate("arming time over"), PRESSURE_ARM_S * 1000)
    }

    /** end of a run */
    disarm() {
        this.pending = false
        clearTimeout(this.armTimer)
        if (this.getEnabledState()) this.setEnabledState(false)
    }

    private activate(_why: string) {
        if (!this.pending) return
        this.pending = false
        clearTimeout(this.armTimer)
        this.setEnabledState(true)
    }
}

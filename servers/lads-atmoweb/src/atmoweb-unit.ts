// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS AtmoWEB gateway
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

import EventEmitter from "events"
import { EUInformation, promoteToStateMachine, Range, standardUnits, UAObject, UAStateMachineEx } from "node-opcua"
import { LADSFunctionalState, LADSFunctionalUnit } from "@interfaces"
import { raiseEvent, touchNodes } from "@utils"
import { AFODictionaryIds } from "@afo"
import { AtmoWebDeviceConfig, AtmoWebServerImpl } from "./server"
import { AtmoWebDeviceImpl } from "./atmoweb-device"
import { AtmoWebClient, ClientEvent, ClientState } from "./atmoweb-client"
import { AnalogControlFunctionConfig, AnalogControlFunctionImpl, AnalogSensorFunctionImpl, CoverFunctionConfig, CoverFunctionImpl, FunctionImpl, TwoStateDiscreteControlFunctionConfig, TwoStateDiscreteControlFunctionImpl, VariableBinding } from "./atmoweb-functions"
import { AtmoWebProgramManagerImpl } from "./atmoweb-program-manager"

interface ValueRange { min: number, max: number }

export class AtmoWebUnitImpl extends EventEmitter {
    deviceConfig: AtmoWebDeviceConfig
    client: AtmoWebClient
    unit: LADSFunctionalUnit
    functionalUnitState: UAStateMachineEx
    functions: FunctionImpl[] = []
    variableBindings: VariableBinding[] = []
    programManager: AtmoWebProgramManagerImpl

    constructor(server: AtmoWebServerImpl, deviceImpl: AtmoWebDeviceImpl, deviceConfig: AtmoWebDeviceConfig) {
        super()
        this.deviceConfig = deviceConfig

        // create functional unit object
        const functionalUnitSet = deviceImpl.device.functionalUnitSet as UAObject
        const unitType = server.nameSpaceApp.findObjectType("AtmoWebUnitType")
        this.unit = unitType.instantiate({
            componentOf: functionalUnitSet,
            browseName: "AtmoWebUnit",
        }) as LADSFunctionalUnit
        this.functionalUnitState = promoteToStateMachine(this.unit.functionalUnitState)
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)

        // connect to client
        this.client = deviceImpl.client
        this.client.on(ClientEvent.error, (err) => console.warn(err))
        this.client.on(ClientEvent.state, this.stateHandler.bind(this))
        this.client.on(ClientEvent.config, this.configHandler.bind(this))
        this.client.on(ClientEvent.log, this.logHandler.bind(this))
    }

    logHandler(messages: string[]) {
        messages.forEach((message) => {
            const l = message.split("\t")
            if (l.length >= 4){
                raiseEvent(this.unit, l[3])
            }

        })

    }

    stateHandler(state: ClientState) {
        //console.log(state)
    }

    createAnalogControlFunction(data: any, parent: UAObject, name: string, euInformation: EUInformation, controllerDictionaryId: string, dictionaryIds: string[], id: string, currentValueId?: string): AnalogControlFunctionImpl {
        const currentValueKey = `${currentValueId ?? id}Read`
        const targetValueKey = `${id}Set`
        const targetValueRange: ValueRange = data[`${targetValueKey}_Range`]

        const alHiKey = `Al${id}Hi`
        const alHiRange: ValueRange = data[`${alHiKey}_Range`]
        const alLoKey = `Al${id}Lo`
        const alLoRange: ValueRange = data[`${alLoKey}_Range`]
        const hasAlRange = (alHiRange != undefined) && (alLoRange != undefined)
        const currentValueRange: ValueRange = hasAlRange ? {
            min: alLoRange.min < alHiRange.min ? alLoRange.min : alHiRange.min,
            max: alLoRange.max > alHiRange.max ? alLoRange.max : alHiRange.max,
        } : targetValueRange

        const config: AnalogControlFunctionConfig = {
            id: id,
            name: name,
            functionDictionaryId: controllerDictionaryId,
            dictionaryIds: dictionaryIds,
            euInformation: euInformation,
            targetValue: Number(data[targetValueKey]),
            targetValueRange: new Range({ low: Number(targetValueRange.min), high: Number(targetValueRange.max) }),
            currentValueId: currentValueId,
            currentValue: Number(data[currentValueKey]),
            currentValueRange: new Range({ low: Number(currentValueRange.min), high: Number(currentValueRange.max) }),
            alarmHi: Number(data[alHiKey]),
            alarmLo: Number(data[alLoKey]),
        }
        return new AnalogControlFunctionImpl(parent, config)
    }

    createAnalogSensorFunction(data: any, parent: UAObject, name: string, euInformation: EUInformation, controllerDictionaryId: string, dictionaryIds: string[], id: string, sensorValueRange?: Range) {
        return new AnalogSensorFunctionImpl(parent, { name: name, functionDictionaryId: controllerDictionaryId, dictionaryIds: dictionaryIds, euInformation: euInformation, id: id, sensorValue: Number(data[`${id}Read`]), sensorValueRange: sensorValueRange })
    }

    createTwoStateDiscreteControlFunction(data: any, parent: UAObject, name: string, falseState: string, trueState: string, dictionaryIds: string[], id: string): TwoStateDiscreteControlFunctionImpl {
        const config: TwoStateDiscreteControlFunctionConfig = {
            id: id,
            name: name,
            dictionaryIds: dictionaryIds,
            falseState: falseState,
            trueState: trueState,
            value: Boolean(data[id])
        }
        return new TwoStateDiscreteControlFunctionImpl(parent, config)
    }

    createCoverFunction(data: any, parent: UAObject, name: string): CoverFunctionImpl {
        const config: CoverFunctionConfig = {
            name: name,
            id: "DoorOpen",
            dictionaryIds: [],
            opened: Boolean(data["DoorOpen"])
        }
        if (this.isInstalled(data, "DoorLock")) {
            config.lockedId = "DoorLock"
            config.locked = Boolean(data["DoorLock"])
        }
        return new CoverFunctionImpl(parent, config)
    }

    isInstalled(data: any, id: string): boolean { return !isNaN(data[id]) }

    configHandler(data: any) {
        // build functions
        const functionSet = this.unit.functionSet as UAObject

        if (this.isInstalled(data, "Temp1Read")) {
            const tc = this.createAnalogControlFunction(data, functionSet, "Temperature Controller", standardUnits.degree_celsius, AFODictionaryIds.temperature_controller, [AFODictionaryIds.temperature], "Temp", "Temp1")
            const range = tc.config.currentValueRange
            this.functions.push(tc)
            if (this.isInstalled(data, "Temp2Read")) { this.functions.push(this.createAnalogSensorFunction(data, functionSet, "Temperature Sensor #2", standardUnits.degree_celsius, AFODictionaryIds.temperature_measurement, [AFODictionaryIds.temperature], "Temp2", range)) }
            if (this.isInstalled(data, "Temp3Read")) { this.functions.push(this.createAnalogSensorFunction(data, functionSet, "Temperature Sensor #3", standardUnits.degree_celsius, AFODictionaryIds.temperature_measurement, [AFODictionaryIds.temperature], "Temp3", range)) }
            if (this.isInstalled(data, "Temp4Read")) { this.functions.push(this.createAnalogSensorFunction(data, functionSet, "Temperature Sensor #4", standardUnits.degree_celsius, AFODictionaryIds.temperature_measurement, [AFODictionaryIds.temperature], "Temp4", range)) }
        }
        if (this.isInstalled(data, "VacRead")) {
            this.functions.push(this.createAnalogControlFunction(data, functionSet, "Vacuum Controller", standardUnits.hectopascal, AFODictionaryIds.pressure_control, [AFODictionaryIds.pressure], "Vac"))
        }
        if (this.isInstalled(data, "HumRead")) {
            this.functions.push(this.createAnalogControlFunction(data, functionSet, "Humidity Controller", standardUnits.percent, undefined, [AFODictionaryIds.relative_humidity], "Hum"))
        }
        if (this.isInstalled(data, "O2Read")) {
            this.functions.push(this.createAnalogControlFunction(data, functionSet, "O2 Controller", standardUnits.percent, undefined, [AFODictionaryIds.concentration, AFODictionaryIds.oxygen_gas], "O2"))
        }
        if (this.isInstalled(data, "CO2Read")) {
            this.functions.push(this.createAnalogControlFunction(data, functionSet, "CO2 Controller", standardUnits.percent, undefined, [AFODictionaryIds.concentration, AFODictionaryIds.carbon_dioxide_gas], "CO2"))
        }
        if (this.isInstalled(data, "FanRead")) {
            this.functions.push(this.createAnalogControlFunction(data, functionSet, "Fan Controller", standardUnits.percent, undefined, [AFODictionaryIds.relative_intensity], "Fan"))
        }
        if (this.isInstalled(data, "LightDay")) {
            this.functions.push(this.createTwoStateDiscreteControlFunction(data, functionSet, "Day Light", "off", "on", [AFODictionaryIds.visible_light], "LightDay"))
        }
        if (this.isInstalled(data, "LightUV")) {
            this.functions.push(this.createTwoStateDiscreteControlFunction(data, functionSet, "UV Light", "off", "on", [AFODictionaryIds.ultraviolet_radiation], "LightUV"))
        }
        if (this.isInstalled(data, "DoorOpen")) {
            this.functions.push(this.createCoverFunction(data, functionSet, "Door"))
        }
        

        // collect variable bindings
        this.functions.forEach(func => this.variableBindings.push(...func.variableBindings(this.client)))

        // register variable bindings
        const variableIds = this.variableBindings.map(binding => binding.id)
        // get rid of duplicates e.g. LightDay, LightUV
        const variableIdSet = [...new Set(variableIds)]
        this.client.setVariables(variableIdSet)
        this.client.on(ClientEvent.data, this.dataHandler.bind(this))

        touchNodes(functionSet)

        // initialize program manager
        this.programManager = new AtmoWebProgramManagerImpl(this, data)

        // raise initialized
        this.emit("initialized")
    }

    dataHandler(data: any) {
        for (const [key, value] of Object.entries(data)) {
            // there might be multiple targets for one key, e.g. LightDay.TargetValue & .CurrentValue
            const bindings = this.variableBindings.filter(binding => (binding.id === key))
            bindings.forEach(binding => binding.update(value))
        }
    }


}

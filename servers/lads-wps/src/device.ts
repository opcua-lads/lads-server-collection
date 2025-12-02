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

//---------------------------------------------------------------
// device implementation
//---------------------------------------------------------------
import { AFODictionary, AFODictionaryIds } from "@afo"
import { LADSComponentOptions, defaultLocation, initComponent, LADSDeviceHelper, getDeviceSet, setNumericValue, setNumericArrayValue, setDateTimeValue, getDateTimeValue, getNumericValue, getNumericArrayValue } from "@utils"
import { WpsDevice, WpsFunctionalUnit, WpsFunctionalUnitSet } from "./interfaces"
import { DeviceConfig, WpsServerImpl } from "./server"
import { IAddressSpace, INamespace, UAObject } from "node-opcua"
import { WpsUnitImpl } from "./unit"
import { LADSComponent, LifetimeVariableType } from "@interfaces"
import { MaintenanceTaskImpl } from "utils/src/lads-maintenance-task"


//--------------------------------------------------------------- 
export function getWpsNameSpace(addressSpace: IAddressSpace): INamespace { return addressSpace.getNamespace("http://aixengineers.de/WaterPurificationSystem/") }

export enum LifetimeStatus {Good, Warning, Exceeded}

interface WpsComponentOptions extends LADSComponentOptions {
    parent: UAObject
    name: string
    displayName?: string
    startValue: number
    warningValues: number[]
    remaining?: number
    optionals?: string[]
}

export class WpsDeviceImpl {
    parent: WpsServerImpl
    config: DeviceConfig
    device: WpsDevice
    deviceHelper: LADSDeviceHelper
    cartridge: WpsComponentImpl
    endfilter: WpsComponentImpl
    ultrafilter: WpsComponentImpl
    uvlamp: WpsComponentImpl
    components: WpsComponentImpl[] = []

    constructor(server: WpsServerImpl, config: DeviceConfig) {
        // create device object
        this.parent = server
        this.config = config
        const addressSpace = this.parent.server.engine.addressSpace
        const nameSpace = getWpsNameSpace(addressSpace)
        const deviceType = nameSpace.findObjectType("WPSDeviceType")
        const device = deviceType.instantiate({
            componentOf: getDeviceSet(addressSpace),
            browseName: config.name,
        }) as WpsDevice
        this.device = device
        this.initComponents(config)

        // create unit implementation
        const unitImpl = new WpsUnitImpl(this)

        // attach device helper
        this.deviceHelper = new LADSDeviceHelper(device)

        // set AFO dictionary entries
        AFODictionary.addDefaultDeviceReferences(device) // crawl through the complete information model tree and add default references
        AFODictionary.addReferences(device, AFODictionaryIds.purification)

        // evaluate asset managemnt
        setInterval(() => {
            this.components.forEach(component => component.evaluate())
        }, 1000)
    }


    getFunctionalUnitSet(): WpsFunctionalUnitSet { return this.device.getComponentByName("FunctionalUnitSet") as WpsFunctionalUnitSet }

    getFunctionalUnit(): WpsFunctionalUnit {
        const fus = this.device.getComponentByName("FunctionalUnitSet") as WpsFunctionalUnitSet
        return fus.getComponentByName("WPSUnit") as WpsFunctionalUnit
    }

    initComponents(config: DeviceConfig) {
        // initialize nameplates
        const deviceOptions: LADSComponentOptions = {
            manufacturer: config.manufacturer,
            model: config.model,
            serialNumber: config.serialNumber,
            softwareRevision: "1.0",
            deviceRevision: "1.0",
            assetId: "0815-4711",
            componentName: config.name,
            location: defaultLocation,
        }
        initComponent(this.device, deviceOptions)

        const components = this.device.components
        this.cartridge = new WpsComponentImpl({
            parent: components,
            name: "Cartridge",
            manufacturer: "sartorius",
            model: "Cartridge X",
            startValue: 12,
            warningValues: [1],
            remaining: 6,
        })
        this.endfilter = new WpsComponentImpl({
            parent: components,
            name: "Endfilter",
            manufacturer: "sartorius",
            model: "Endfilter A",
            startValue: 1,
            warningValues: [0.5],
            remaining: 0.25
        })
        if (config.hasUF) {
            this.ultrafilter = new WpsComponentImpl({
                parent: components,
                name: "Ultrafilter",
                manufacturer: "sartorius",
                model: "Ultrafilter Y",
                startValue: 12,
                warningValues: [1],
                remaining: 6,
            })
        }
        if (config.hasUV) {
            this.uvlamp = new WpsComponentImpl({
                parent: components,
                name: "UVLamp",
                displayName: "UV Lamp",
                manufacturer: "sartorius",
                model: "UV Lamp Z",
                startValue: 12,
                warningValues: [1],
                remaining: 3,
                optionals: ["OperationCounters.OperationCycleCounter"]
            })
            if (config.hasTOC) {}
        }
        this.components = [
            this.cartridge, 
            this.endfilter, 
            this.ultrafilter, 
            this.uvlamp]
            .filter(component => (component !== undefined))
    }

}

export class WpsComponentImpl {
    component: LADSComponent
    task: MaintenanceTaskImpl
    status: LifetimeStatus

    constructor(options: WpsComponentOptions) {

        const componentType = getWpsNameSpace(options.parent.addressSpace).findObjectType("WPSComponentType")
        if (!componentType) return
        const displayName = options.displayName ?? options.name
        const component = componentType.instantiate({
            componentOf: options.parent,
            browseName: options.name,
            displayName: displayName,
            optionals: options.optionals
        }) as LADSComponent
        initComponent(component, options)
        const remainingLifetime = remainingLifetimeVariable(component)
        if (remainingLifetime) {
            setNumericValue(remainingLifetime.startValue, options.startValue)
            setNumericValue(remainingLifetime.limitValue, 0)
            setNumericArrayValue(remainingLifetime.warningValues, options.warningValues)
            const now = Date.now()
            const dateInstalled = monthsBackApprox(now, options.remaining ? options.startValue - options.remaining : 0.5 * options.startValue)
            setDateTimeValue(component?.identification?.initialOperationDate, dateInstalled)
        }
        setNumericValue(component.operationCounters?.operationCycleCounter, 0)

        const task = new MaintenanceTaskImpl({
            parent: component.maintenance,
            name: `${options.name}ReplaceRequired`,
            displayName: `${displayName} Replace Required`,
            inputNode: component,
        })

        this.component = component
        this.task = task
        this.status = LifetimeStatus.Good
    }

    evaluateLifetimeStatus(): LifetimeStatus {
        const component = this.component
        if (!component) return
        const remainigLifetime = remainingLifetimeVariable(component)
        if (!remainigLifetime) return
        const dateInstalled = getDateTimeValue(component.identification.initialOperationDate)
        if (!dateInstalled) return
        const installedDuration = (Date.now() - dateInstalled.getTime()) / MS_PER_MONTH
        const remaining = getNumericValue(remainigLifetime.startValue) - installedDuration
        setNumericValue(remainigLifetime, remaining)
        // detemine lifetime status
        const warnings = getNumericArrayValue(remainigLifetime.warningValues, [])
        const warning = warnings.length > 0 ? warnings[0] : 0
        if (remaining < getNumericValue(remainigLifetime.limitValue)) {
            return LifetimeStatus.Exceeded
        } else if (remaining < warning) {
            return LifetimeStatus.Warning
        } else {
            return LifetimeStatus.Good
        }
    }

    evaluate() {
        const status = this.evaluateLifetimeStatus()
        if (status === this.status) return
        if (status === LifetimeStatus.Warning) {
            this.task.raiseWarningEvent()
        } else if (status === LifetimeStatus.Exceeded) {
            this.task.enterActive()
        } else if (status ==  LifetimeStatus.Good) {
            this.task.enterInactive()
        }
        this.status = status
    }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const APPROX_DAYS_PER_MONTH = 30
const MS_PER_MONTH = APPROX_DAYS_PER_MONTH * MS_PER_DAY

function monthsBackApprox(date: number, months: number): Date { return new Date(date - months * MS_PER_MONTH); }
function remainingLifetimeVariable(component: LADSComponent): LifetimeVariableType { return component.lifetimeCounters?.getComponentByName("RemainingLifetime") as LifetimeVariableType }




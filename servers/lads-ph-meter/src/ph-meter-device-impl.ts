// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

//---------------------------------------------------------------
// device implementation
//---------------------------------------------------------------

import { AFODictionary, AFODictionaryIds } from "@afo"
import { LADSComponent } from "@interfaces"
import { LADSComponentOptions, getStringValue, defaultLocation, initComponent, LADSDeviceHelper } from "@utils"
import { pHMeterDevice, pHMeterFunctionalUnit, pHMeterFunctionalUnitSet } from "./ph-meter-interfaces"
import { pHMeterUnitImpl } from "./ph-meter-unit-impl"
import { SevenEasyUnitImpl } from "./seven-easy-unit-impl"

//---------------------------------------------------------------
export class pHMeterDeviceImpl {
    serialPort: string
    device: pHMeterDevice
    
    constructor(device: pHMeterDevice, serialPort: string) {
        this.device = device
        this.serialPort = serialPort

        const functionalUnit = this.getFunctionalUnit()
        const functionalUnitImpl = serialPort.length == 0?new pHMeterUnitImpl(this, functionalUnit):new SevenEasyUnitImpl(this, functionalUnit, serialPort)

        // initialize nameplates
        const deviceOptions: LADSComponentOptions = {
            manufacturer: getStringValue(device.manufacturer, "Mettler Toledo"),
            model: getStringValue(device.model, "Super pH-Meter"),
            serialNumber: getStringValue(device.serialNumber, "4711"),
            softwareRevision: "1.0",
            deviceRevision: "1.0",
            assetId: "0815-4711",
            componentName: "My pH-meter",
            location: defaultLocation,
        }
        initComponent(device, deviceOptions)
        const components = device.getComponentByName("Components")
        const sensor = components.getComponentByName("pHSensor") as LADSComponent
        const sensorOptions: LADSComponentOptions = {
            manufacturer: "Mettler Toledo",
            model: "DPAS 405",
            serialNumber: "0815",
        }
        initComponent(sensor, sensorOptions)
        
        // attach device helper
        const helper = new LADSDeviceHelper(device)

        // set dictionary entries
        AFODictionary.addDefaultDeviceReferences(device)
        AFODictionary.addReferences(device, AFODictionaryIds.measurement_device, AFODictionaryIds.pH_measurement)
    }

    getFunctionalUnit(): pHMeterFunctionalUnit {
        if (true) {
            const fus = this.device.getComponentByName("FunctionalUnitSet") as pHMeterFunctionalUnitSet
            return fus.getComponentByName("pHMeterUnit") as pHMeterFunctionalUnit
        } else {
            return this.device.functionalUnitSet.pHMeterUnit
        }
    }

}


// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Device initialisation of the simulated HPLC (skeleton):

  1. DeviceTypeImage: the image files of resources/images (png, jpg, svg ...) as ByteString variables
  2. nameplates: initComponent writes the DI nameplate of the device and of every component and copies it to the
     Machinery Identification below (Manufacturer, Model, SerialNumber, ... and Identification/Location); ManufacturerUri and
     ProductInstanceUri are derived when not given
  3. locations: Identification/Location (geographical, from config/lads-site.json), HierarchicalLocation (site) and
     OperationalLocation (place in the lab)
  4. LADSDeviceHelper: Machinery building blocks, event notifier tree, DeviceState / MachineryItemState / OperationMode, DeviceHealth
  5. locks: device lock + one lock per functional unit (DeviceLocks)
  6. functional units: SimulatedUnitImpl for every unit with a FunctionalUnitState (StartProgram, Stop, Abort, Clear)
  7. simulation (simulation.ts): column oven (PT1) and pump with pressure, started / stopped with the runs of the unit
*/

import { join } from "path"
import { UAObject } from "node-opcua"
import { LADSDevice } from "@interfaces"
import { DefaultHierarchicalLocation, DefaultLocation, DeviceTypeImage, getLADSFunctionalUnits, initComponent, LADSComponentOptions, LADSDeviceHelper } from "@utils"
import { DeviceLocks } from "./locks"
import { SimulatedUnitImpl } from "./unit"
import { HPLCSimulation } from "./simulation"

export interface HPLCDeviceOptions {
    serialNumber: string
    componentName: string
    operationalLocation: string
}

const MANUFACTURER = "Agilent Technologies"   // ManufacturerUri agilent.com (known manufacturers in @utils, also the first part of the ProductInstanceUri)

/** nameplates of the components (browse name -> nameplate); components not listed get the manufacturer and a serial number */
const COMPONENTS: { [name: string]: LADSComponentOptions } = {
    AutoSampler: { manufacturer: MANUFACTURER, model: "G4294B", softwareRevision: "1.0" },
    Pump: { manufacturer: MANUFACTURER, model: "G7111B", softwareRevision: "1.0" },
    DAD: { manufacturer: MANUFACTURER, model: "G7115A", softwareRevision: "1.0" },
    VisLamp: { manufacturer: MANUFACTURER, model: "Tungsten lamp 5190-0917" },
    UVLamp: { manufacturer: MANUFACTURER, model: "Deuterium lamp 5190-0917" },
    ColumnCompartment: { manufacturer: MANUFACTURER, model: "G7116A", softwareRevision: "1.0" },
    Column1: { manufacturer: MANUFACTURER, model: "ZORBAX Eclipse Plus C18" },
    Column2: { manufacturer: MANUFACTURER, model: "ZORBAX Eclipse Plus C8" },
    Column3: { manufacturer: MANUFACTURER, model: "InfinityLab Poroshell 120" },
}

export class HPLCDeviceImpl {
    readonly locks: DeviceLocks
    readonly units: SimulatedUnitImpl[] = []

    constructor(readonly device: LADSDevice, options: HPLCDeviceOptions) {
        const name = (device as unknown as UAObject).getDisplayName()
        console.log(`Initializing HPLC device ${name} ..`)

        // 1. device type images
        DeviceTypeImage.create({ parent: device as any, imagesDir: join(__dirname, "resources", "images") })

        // 2. + 3. nameplate of the device (DI + Machinery Identification) with the locations
        const model = "1220 Infinity II LC"
        initComponent(device as any, {
            manufacturer: MANUFACTURER, model, serialNumber: options.serialNumber,
            softwareRevision: "1.0", hardwareRevision: "1.0", deviceRevision: "1.0",
            assetId: `HPLC-${options.serialNumber}`, componentName: options.componentName,
            location: DefaultLocation,                         // Identification/Location: geographical location of the site
            hierarchicalLocation: DefaultHierarchicalLocation,  // e.g. DE/Aachen/Landoltweg 1/Analytical Lab
            operationalLocation: options.operationalLocation,  // place in the lab
        })
        // nameplates of the components, recursively (components of components, e.g. the lamps of the DAD)
        let n = 0
        const walk = (parent: UAObject) => {
            const components = parent.getChildByName("Components") as UAObject | null
            for (const c of components?.getComponents() ?? []) {
                const component = c as UAObject
                const nameplate = COMPONENTS[component.browseName.name!] ?? { manufacturer: MANUFACTURER }
                initComponent(component as any, { serialNumber: `${options.serialNumber}-${++n}`, ...nameplate })
                walk(component)
            }
        }
        walk(device as unknown as UAObject)
        console.log(`Nameplates: device + ${n} components`)

        // 4. device helper (functions stay enabled: IsEnabled is set by the units)
        new LADSDeviceHelper(device, { initializationTime: 2000, shutdownTime: 2000, raiseEvents: true, adjustFunctionIsEnabled: false })

        // 5. locks
        this.locks = new DeviceLocks(device)

        // 6. functional units
        for (const unit of getLADSFunctionalUnits(device)) {
            if (!unit.functionalUnitState) continue
            const impl = new SimulatedUnitImpl(unit, this.locks.predicate(unit.browseName.name))
            this.units.push(impl)
            // 7. simulation loop of the unit with a column oven / pump, coupled to its program runs
            const fs = (unit as unknown as UAObject).getChildByName("FunctionSet") as UAObject | null
            if (fs?.getChildByName("ColumnOven") || fs?.getChildByName("Pump")) impl.hooks = new HPLCSimulation(unit, this.locks.predicate(unit.browseName.name))
        }
    }
}

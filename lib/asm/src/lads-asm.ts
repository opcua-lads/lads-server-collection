// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

//---------------------------------------------------------------
// LADS Allotrope Simple Model support
//---------------------------------------------------------------

import { resolve } from "path"
import { promises as fs } from "fs"
import { UAVariable, UAObject } from "node-opcua"
import { LADSResult, LADSResultFile, LADSSampleInfo } from "@interfaces"
import { VariableDataRecorder, ensureDirectoryExists, DataExporter } from "@utils"
import { UADevice } from "node-opcua-nodeset-di"
import { AFODictionary } from "@afo/lads-afo"
import { AFODictionaryIds } from "@afo/lads-afo-ids"

//---------------------------------------------------------------
// Interfaces
//---------------------------------------------------------------

export interface AllotropeSimpleModel {
    "$asm.manifest": string
}

export interface AggregateDocument {
    "device system document"?: DeviceSystemDocument
}

export interface MeasurementAggregateDocument {
    "analyst"?: string
    "measurement document": MeasurementDocument[]
    "submitter"?: string
}

export interface MeasurementDocument {
    "device control aggregate document": DeviceControlAggregateDocument
    "experimental data identifier"?: string
    "measurement identifier"?: string
    "measurement method identifier"?: string
    "measurement time": Date
    "sample document": SampleDocument
}

export interface DeviceControlAggregateDocument {
    "device control document": DeviceControlDocument[]
}

interface BaseDeviceDocument {
    "brand name"?: string
    "device identifier"?: string
    "equipment serial number"?: string
    "firmware version"?: string
    "model number"?: string
    "product manufacturer"?: string
}

export interface DeviceSystemDocument extends BaseDeviceDocument {
    "asset management identifier"?: string
    "device document": DeviceDocument[]
}

export interface DeviceDocument extends BaseDeviceDocument {
    "device type": string
}

export interface DeviceControlDocument extends DeviceDocument {
    "detection type"?: string
}

export interface SampleDocument {
    "batch identifier"?: string
    "description"?: any
    "location identifier"?: string
    "sample identifier": string
    "sample role type"?: string
    "written name"?: string
}

export interface DataCube {
    "cube-structure": DataCubeStructure
    "data": DataCubeData
    "label": string
}

export interface DataCubeStructure {
    "dimensions": DataCubeComponent[]
    "measures": DataCubeComponent[]
}

export interface DataCubeComponent {
    "@componentDatatype": string
    "concept": string
    "scale"?: string
    "unit": Units
}

export interface DataCubeData {
    "dimensions": Array<DimensionArrayType>
    "measures": Array<MeasureArrayType>
}

type DimensionArrayType = Array<string | number | boolean>
type MeasureArrayType = Array<string | number | boolean | null>

export class Units {
    static readonly degC = "degC"
    static readonly mm = "mm"
    static readonly N = "N"
    static readonly Nm = "N.m"
    static readonly Pa = "Pa"
    static readonly Pas = "Pa.s"
    static readonly pH = "pH"
    static readonly rad = "rad"
    static readonly rad_s = "rad/s"
    static readonly s = "s"
    static readonly _s = "s-1"
    static readonly µm = "µm"
    static readonly g = "g"
}

export interface Property {
    "unit": Units
    "value": number
}

//---------------------------------------------------------------
// Recorder implementation
//---------------------------------------------------------------
export interface DeviceInfo {
    deviceType: string
    device: UADevice
}

export interface AllotropeSimpleModelRecorderOptions {
    result: LADSResult
    devices: DeviceInfo[]
    sample: LADSSampleInfo
}

export abstract class AllotropeSimpleModelRecorder {

    static createDeviceSystemDocument(options: AllotropeSimpleModelRecorderOptions): DeviceSystemDocument {
        const deviceInfos = options.devices
        if (deviceInfos.length < 1) return
        const systemDevice = deviceInfos[0].device
        const deviceSystemDocument: DeviceSystemDocument = {
            "asset management identifier": systemDevice.assetId ? systemDevice.assetId.readValue().value.value : "",
            "device identifier": systemDevice.browseName.name,
            "device document": this.createDeviceDocuments(deviceInfos)
        }
        return deviceSystemDocument
    }

    static createDeviceControlDocuments(deviceInfos: DeviceInfo[]): DeviceControlDocument[] {
        return deviceInfos.map(deviceInfo => this.createDeviceControlDocument(deviceInfo))
    }

    static createDeviceControlDocument(deviceInfo: DeviceInfo): DeviceControlDocument {
        return this.createDeviceDocument(deviceInfo) as DeviceControlDocument
    }

    static createDeviceDocuments(deviceInfos: DeviceInfo[]): DeviceDocument[] {
        return deviceInfos.map(deviceInfo => this.createDeviceDocument(deviceInfo))
    }

    static createDeviceDocument(deviceInfo: DeviceInfo): DeviceDocument {
        const deviceDocument = this.createBaseDeviceDocument(deviceInfo.device) as DeviceDocument
        deviceDocument["device type"] = deviceInfo.deviceType
        return deviceDocument
    }

    private static createBaseDeviceDocument(device: UADevice): BaseDeviceDocument {
        const manufacturer = device.manufacturer ? device.manufacturer.readValue().value.value.text : ""
        return {
            "brand name": manufacturer,
            "equipment serial number": device.serialNumber ? device.serialNumber.readValue().value.value : "",
            "device identifier": device.browseName.name,
            "firmware version": device.softwareRevision ? device.softwareRevision.readValue().value.value : "",
            "model number": device.model ? device.model.readValue().value.value.text : "",
            "product manufacturer": manufacturer,
        }
    }

    static createSampleDocument(sample: LADSSampleInfo): SampleDocument {
        return {
            "sample identifier": sample.sampleId,
            "location identifier": sample.position,
        }
    }

    static createMeasurementDocument(options: AllotropeSimpleModelRecorderOptions): MeasurementDocument {
        const identifier = options.result.browseName.name
        const measurementDocument: MeasurementDocument = {
            "device control aggregate document": {
                "device control document": this.createDeviceControlDocuments(options.devices)
            },
            "experimental data identifier": identifier,
            "measurement identifier": identifier,
            "measurement method identifier": options.result.programTemplate.deviceTemplateId.readValue().value.value,
            "measurement time": options.result.started.readValue().value.value,
            "sample document": this.createSampleDocument(options.sample),
        }
        return measurementDocument
    }

    static createMeasurementAggregateDocument(options: AllotropeSimpleModelRecorderOptions, measurementDocuments: MeasurementDocument[]): MeasurementAggregateDocument {
        const measurementAggregateDocument: MeasurementAggregateDocument = {
            "analyst": options.result.user.readValue().value.value,
            "measurement document": measurementDocuments
        }
        return measurementAggregateDocument
    }

    dataRecorder: VariableDataRecorder
    referenceIds: string[] = [AFODictionaryIds.ASM_file]

    constructor(options: AllotropeSimpleModelRecorderOptions, variables: UAVariable[]) {
        const identifier = options.result.browseName.name
        this.dataRecorder = new VariableDataRecorder(identifier, variables)
    }

    addReferenceIds(...referenceIds: string[]) { this.referenceIds.push(...referenceIds) }

    createRecord() { this.dataRecorder.createRecord() }

    abstract createModel(): AllotropeSimpleModel

    async writeResultFile(fileSet: UAObject, name: string, dirName: string, fileName: string, model: AllotropeSimpleModel = undefined): Promise<LADSResultFile> {
        // eventually create directoy
        await ensureDirectoryExists(dirName)
        const path = resolve(dirName, `${fileName}.json`)
        const asmModel = model ? model : this.createModel()
        const json = JSON.stringify(asmModel, null, 2)
        await fs.writeFile(path, json, "utf8").then(
            () => console.log(`Created ASM file ${path}`),
            (err) => console.log(err)
        )
        const resultFile = DataExporter.createResultFile(fileSet, name, fileName, DataExporter.MimeTypeJSON, path)
        AFODictionary.addReferences(resultFile, ...this.referenceIds)
        AFODictionary.addReferences(resultFile.file, AFODictionaryIds.ASM_file)
        AFODictionary.addReferences(resultFile.name, AFODictionaryIds.ASM_file_identifier)
        return resultFile
    }
}

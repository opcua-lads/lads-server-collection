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
// LADS Allotrope Simple Model for pH monitoring
//---------------------------------------------------------------

import { MeasurementAggregateDocument, DataCube, MeasurementDocument, Property, DataCubeStructure, AllotropeSimpleModel, AllotropeSimpleModelRecorder, EngineeringUnits, AggregateDocument, DeviceDocument, AllotropeSimpleModelRecorderOptions  } from "./lads-asm"
import { UAVariable } from "node-opcua"
import { AFODictionaryIds } from "@afo"

//---------------------------------------------------------------
// Interfaces
//---------------------------------------------------------------
const pHSensorManifest = "http://purl.allotrope.org/manifests/ph/REC/2025/03/ph-sensor.manifest"

export interface pHSensorModel extends AllotropeSimpleModel {
    "pH monitoring aggregate document": pHSensorAggregateDocument
}

export interface pHSensorAggregateDocument extends AggregateDocument {
    "pH monitoring document": pHSensorDocument[]
}

export interface pHSensorDeviceDocument extends DeviceDocument {
    "calibration certificate identifier"?: string
    "calibration time"?: Date
}

export interface pHSensorDocument {
    "measurement aggregate document": pHSensorMeasurementAggregateDocument
}

export interface pHSensorMeasurementAggregateDocument extends Omit<MeasurementAggregateDocument, "measurement document"> {
    "experiment identifier": string
    "measurement document": pHSensorMeasurementDocument[]
}

export interface pHSensorMeasurementDocument extends MeasurementDocument {
    "pH"?: Property
    "temperature"?:Property
    "data cube"?: DataCube
}

const pHSensorDataCubeStructure: DataCubeStructure = {
    "dimensions": [
        {
            "@componentDatatype": "double",
            "concept": "elapsed time",
            "unit": EngineeringUnits.s
        },
    ],
    "measures": [
        {
            "@componentDatatype": "double",
            "concept": "pH",
            "unit": EngineeringUnits.pH
        },
        {
            "@componentDatatype": "double",
            "concept": "temperature",
            "unit": EngineeringUnits.degC
        },
    ]
}

//---------------------------------------------------------------
// Recorder implmentation
//---------------------------------------------------------------

export interface pHSensorRecorderOptions extends AllotropeSimpleModelRecorderOptions {
    runtime: UAVariable
    pH: UAVariable
    temperature: UAVariable
    includeEndPoint?: boolean
    includeProfile?: boolean
    calibrationCertficate?: string
    calibrationTime?: Date
}

export class pHSensorRecorder extends AllotropeSimpleModelRecorder {
    options: pHSensorRecorderOptions

    constructor(options: pHSensorRecorderOptions) {
        super(options, [
            options.runtime, options.pH,  options.temperature
        ])
        this.options = options
        this.referenceIds.push(AFODictionaryIds.pH, AFODictionaryIds.pH_monitoring_aggregate_document)
    }

    createModel(): pHSensorModel {
        const count = this.dataRecorder.records.length
        if (count === 0) {
            console.error(`No records found`)
            return undefined
        }
        const options = this.options
        const identifier = options.result.browseName.name
        
        // create measurement document
        const measurementDocument = AllotropeSimpleModelRecorder.createMeasurementDocument(options) as pHSensorMeasurementDocument
        const includePoints = options.includeEndPoint?options.includeEndPoint:true
        const includeProfile = options.includeProfile?options.includeProfile:true
        if (includePoints) {
            const endpoint = this.dataRecorder.records[count - 1]
            measurementDocument.pH = {
                unit: EngineeringUnits.pH,
                value: Number(endpoint.tracksRecord[1])
            }
            measurementDocument.temperature = {
                unit: EngineeringUnits.degC,
                value: Number(endpoint.tracksRecord[2])
            }
        }
        if (includeProfile) {
            const dataCube: DataCube = {
                "cube-structure": pHSensorDataCubeStructure,
                "data": {
                    "dimensions": [
                        this.dataRecorder.trackValues(options.runtime).map(value => 0.001 * Number(value)),
                    ],
                    "measures": [
                        this.dataRecorder.trackValues(options.pH),
                        this.dataRecorder.trackValues(options.temperature),
                    ]
                },
                "label": identifier
            }
            measurementDocument["data cube"] = dataCube
        }
        const measurementAggregateDocument = AllotropeSimpleModelRecorder.createMeasurementAggregateDocument(options, [measurementDocument]) as pHSensorMeasurementAggregateDocument
        measurementAggregateDocument["experiment identifier"] = identifier

        // convert generic device documents to pH specific device documents
        const deviceSystemDocument = AllotropeSimpleModelRecorder.createDeviceSystemDocument(options)
        const deviceDocuments = deviceSystemDocument["device document"].map(deviceDocument => deviceDocument as pHSensorDeviceDocument)
        const calibrationCertificate = options.calibrationCertficate?options.calibrationCertficate:"Default calibration certficicate"
        const calibrationTime = options.calibrationTime?options.calibrationTime:new Date()
        deviceDocuments.forEach((deviceDocument, index) => {
            deviceDocument["calibration certificate identifier"] = calibrationCertificate
            deviceDocument["calibration time"] = calibrationTime
        })
        deviceSystemDocument["device document"] = deviceDocuments
        
        // finally create model
        const model: pHSensorModel = {
            "$asm.manifest": pHSensorManifest,
            "pH monitoring aggregate document": {
                "device system document": deviceSystemDocument,
                "pH monitoring document": [
                    {
                        "measurement aggregate document": measurementAggregateDocument
                    }
                ]            
            }
        }
        return model
    }
}

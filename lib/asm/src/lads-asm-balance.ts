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
// LADS Allotrope Simple Model for balances / weighing
//---------------------------------------------------------------

import { MeasurementAggregateDocument, DataCube, MeasurementDocument, Property, DataCubeStructure, AllotropeSimpleModel, AllotropeSimpleModelRecorder, Units, AggregateDocument, DeviceDocument, AllotropeSimpleModelRecorderOptions  } from "./lads-asm"
import { UAVariable } from "node-opcua"
import { AFODictionaryIds } from "@afo"
import { ResultRecord } from "@utils"

//---------------------------------------------------------------
// Interfaces
//---------------------------------------------------------------
const BalanceManifest = "http://purl.allotrope.org/manifests/balance/REC/2025/03/balance.manifest"

export interface BalanceModel extends AllotropeSimpleModel {
    "weighing aggregate document": BalanceAggregateDocument
}

export interface BalanceAggregateDocument extends AggregateDocument {
    "weighing document": BalanceDocument[]
}

export interface BalanceDeviceDocument extends DeviceDocument {
    "calibration certificate identifier"?: string
    "calibration time"?: Date
}

export interface BalanceDocument {
    "measurement aggregate document": BalanceMeasurementAggregateDocument
}

export interface BalanceMeasurementAggregateDocument extends Omit<MeasurementAggregateDocument, "measurement document"> {
    "experiment identifier": string
    "measurement document": BalanceMeasurementDocument[]
}

export interface BalanceMeasurementDocument extends MeasurementDocument {
    "measurement identifier": string
    "gross weight"?: Property
    "sample weight":Property
    "tare weight"?:Property
    "data cube"?: DataCube
}

const BalanceDataCubeStructure: DataCubeStructure = {
    "dimensions": [
        {
            "@componentDatatype": "double",
            "concept": "elapsed time",
            "unit": Units.s
        },
    ],
    "measures": [
        {
            "@componentDatatype": "double",
            "concept": "sample weight",
            "unit": Units.g
        },
    ]
}

//---------------------------------------------------------------
// Recorder implmentation
//---------------------------------------------------------------
function toFixed3Number(value: number | string): number {return Number(Number(value).toFixed(3))}

export interface BalanceRecorderOptions extends AllotropeSimpleModelRecorderOptions {
    runtime: UAVariable
    sampleWeight: UAVariable
    grossWeight?: UAVariable
    tareWeight?: UAVariable
    includeEndPoint?: boolean
    includeProfile?: boolean
    calibrationCertficate?: string
    calibrationTime?: Date
}

export class BalanceRecorder extends AllotropeSimpleModelRecorder {
    options: BalanceRecorderOptions

    constructor(options: BalanceRecorderOptions) {
        const variables = [options.runtime, options.sampleWeight, options.tareWeight, options.grossWeight].filter((value) => (value))
        super(options, variables)
        this.options = options
        this.referenceIds.push(AFODictionaryIds.sample_weight, AFODictionaryIds.weighing_aggregate_document)
    }

    createModel(): BalanceModel {
        const count = this.dataRecorder.records.length
        if (count === 0) {
            console.error(`No records found`)
            return undefined
        }
        const options = this.options
        const identifier = options.result.browseName.name
        
        // create measurement document
        const measurementDocument = AllotropeSimpleModelRecorder.createMeasurementDocument(options) as BalanceMeasurementDocument
        const includePoints = options.includeEndPoint?options.includeEndPoint:true
        const includeProfile = options.includeProfile?options.includeProfile:false
        if (includePoints) {
            const endpoint: ResultRecord = this.dataRecorder.records[count - 1]
            endpoint.tracksRecord.forEach((trackValue, index) => {
                const track = endpoint.tracks[index]
                const property = {
                    unit: Units.g,
                    value: toFixed3Number(trackValue)
                }
                switch (track.variable){
                    case options.sampleWeight: 
                        measurementDocument["sample weight"] = property; break
                    case options.grossWeight: 
                        measurementDocument["gross weight"] = property; break
                    case options.tareWeight: 
                        measurementDocument["tare weight"] = property; break
                }
            })
        }
        if (includeProfile) {
            const dataCube: DataCube = {
                "cube-structure": BalanceDataCubeStructure,
                "data": {
                    "dimensions": [
                        this.dataRecorder.trackValues(options.runtime).map(value => 0.001 * Number(value)),
                    ],
                    "measures": [
                        this.dataRecorder.trackValues(options.sampleWeight),
                    ]
                },
                "label": identifier
            }
            measurementDocument["data cube"] = dataCube
        }
        const measurementAggregateDocument = AllotropeSimpleModelRecorder.createMeasurementAggregateDocument(options, [measurementDocument]) as BalanceMeasurementAggregateDocument
        measurementAggregateDocument["experiment identifier"] = identifier

        // convert generic device documents to model specific device documents
        const deviceSystemDocument = AllotropeSimpleModelRecorder.createDeviceSystemDocument(options)
        const deviceDocuments = deviceSystemDocument["device document"].map(deviceDocument => deviceDocument as BalanceDeviceDocument)
        const calibrationCertificate = options.calibrationCertficate?options.calibrationCertficate:"Default calibration certficicate"
        const calibrationTime = options.calibrationTime?options.calibrationTime:new Date()
        deviceDocuments.forEach((deviceDocument, index) => {
            deviceDocument["calibration certificate identifier"] = calibrationCertificate
            deviceDocument["calibration time"] = calibrationTime
        })
        deviceSystemDocument["device document"] = deviceDocuments
        
        // finally create model
        const model: BalanceModel = {
            "$asm.manifest": BalanceManifest,
            "weighing aggregate document": {
                "device system document": deviceSystemDocument,
                "weighing document": [
                    {
                        "measurement aggregate document": measurementAggregateDocument
                    }
                ]            
            }
        }
        return model
    }
}

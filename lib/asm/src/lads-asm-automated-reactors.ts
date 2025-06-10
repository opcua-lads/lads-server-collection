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
// LADS Allotrope Simple Model for automated-reactors
//---------------------------------------------------------------

import { MeasurementAggregateDocument, DataCube, MeasurementDocument, DataCubeStructure, AllotropeSimpleModel, AllotropeSimpleModelRecorder, Units, AggregateDocument, AllotropeSimpleModelRecorderOptions } from "./lads-asm"
import { UAVariable } from "node-opcua"
import { AFODictionaryIds } from "@afo"

//---------------------------------------------------------------
// Interfaces
//---------------------------------------------------------------
const AutomatedReactorsManifest = "http://purl.allotrope.org/manifests/automated-reactors/REC/2025/03/automated-reactors.manifest"

export interface AutomatedReactorModel extends AllotropeSimpleModel {
    "automated reactor aggregate document": AutomatedReactorAggregateDocument
}

export interface AutomatedReactorAggregateDocument extends AggregateDocument {
    "automated reactor document": AutomatedReactorDocument[]
}

export interface AutomatedReactorDocument {
    "measurement aggregate document": AutomatedReactorMeasurementAggregateDocument
}

export interface AutomatedReactorMeasurementAggregateDocument extends Omit<MeasurementAggregateDocument, "measurement document"> {
    "measurement document": AutomatedReactorMeasurementDocument[]
}

export interface AutomatedReactorMeasurementDocument extends MeasurementDocument {
    "detection type": string
    "analyte name": string
    "probe identifier"?: string
    "probe type"?: string
    "data cube": DataCube
}

//---------------------------------------------------------------
// Recorder implmentation
//---------------------------------------------------------------
const AutomatedReactorDataCubeDimensions = [
    {
        "@componentDatatype": "double",
        "concept": "elapsed time",
        "unit": Units.s
    },
]

export interface AutomatedReactorMeasurementOptions {
    variable: UAVariable
    detectionType: string
    analyteName: string
    unit: Units
    probeIdentifier?: string
    probeType?: string
    referenceIds: string[]
}

export interface AutomatedReactorRecorderOptions extends AllotropeSimpleModelRecorderOptions {
    runtime: UAVariable
    measurements: AutomatedReactorMeasurementOptions[]
}

export class AutomatedReactorRecorder extends AllotropeSimpleModelRecorder {
    options: AutomatedReactorRecorderOptions

    constructor(options: AutomatedReactorRecorderOptions) {
        const variables = options.measurements.map(measurement => measurement.variable)
        variables.unshift(options.runtime)
        super(options, variables)
        this.options = options
        this.referenceIds.push(AFODictionaryIds.automated_reactor_aggregate_document)
    }

    createModel(): AutomatedReactorModel {
        const count = this.dataRecorder.records.length
        if (count === 0) {
            console.error(`No records found`)
            return undefined
        }
        const options = this.options
        const identifier = options.result.browseName.name

        const elapsedTimeData = this.dataRecorder.trackValues(options.runtime).map(value => 0.001 * Number(value))
        const measurementDocuments = this.options.measurements.map(measurement => {
            // add reference ids
            this.addReferenceIds(...measurement.referenceIds)
            
            // create measurement document
            const measurementDocument = AllotropeSimpleModelRecorder.createMeasurementDocument(options) as AutomatedReactorMeasurementDocument
            const cubeStructure: DataCubeStructure = {
                dimensions: AutomatedReactorDataCubeDimensions,
                measures: [{
                    "@componentDatatype": "double",
                    "concept": measurement.analyteName,
                    "unit": measurement.unit
                }]
            }
            const dataCube: DataCube = {
                "cube-structure": cubeStructure,
                "data": {
                    "dimensions": [elapsedTimeData],
                    "measures": [ this.dataRecorder.trackValues(measurement.variable)]
                },
                "label": measurement.analyteName
            }
            measurementDocument["data cube"] = dataCube
            measurement.probeIdentifier ? measurementDocument["probe identifier"] = measurement.probeIdentifier : 0
            measurement.probeType ? measurementDocument["probe type"] = measurement.probeType : 0
            return measurementDocument
        })

        // create measurement aggreate document
        const measurementAggregateDocument = AllotropeSimpleModelRecorder.createMeasurementAggregateDocument(options, measurementDocuments) as AutomatedReactorMeasurementAggregateDocument
        measurementAggregateDocument["experiment identifier"] = identifier

        // convert generic device documents to pH specific device documents
        const deviceSystemDocument = AllotropeSimpleModelRecorder.createDeviceSystemDocument(options)
        // const deviceDocuments = deviceSystemDocument["device document"].map(deviceDocument => deviceDocument as DeviceDocument)
        // deviceSystemDocument["device document"] = deviceDocuments

        // finally create model
        const automatedReactorDocument: AutomatedReactorDocument = {
            "measurement aggregate document": measurementAggregateDocument
        }
        const automatedReactorAggregateDocument: AutomatedReactorAggregateDocument = {
            "automated reactor document": [automatedReactorDocument],
            "device system document": deviceSystemDocument
        }
        const model: AutomatedReactorModel = {
            "$asm.manifest": AutomatedReactorsManifest,
            "automated reactor aggregate document": automatedReactorAggregateDocument
        }
        return model
    }
}





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
// LADS Allotrope Simple Model for Rheometry
//---------------------------------------------------------------

import { MeasurementAggregateDocument, DataCube, MeasurementDocument, Property, DataCubeStructure, AllotropeSimpleModel, AllotropeSimpleModelRecorder, Units, AggregateDocument, AllotropeSimpleModelRecorderOptions  } from "./lads-asm"
import { UAVariable } from "node-opcua"
import { AFODictionaryIds } from "../../afo/src/lads-afo-ids"

//---------------------------------------------------------------
// Interfaces
//---------------------------------------------------------------
const RheometryManifest = "http://purl.allotrope.org/manifests/rheometry/REC/2024/12/rheometry.manifest"

export interface RheometryModel extends AllotropeSimpleModel {
    "rheometry aggregate document": RheometryAggregateDocument
}

export interface RheometryAggregateDocument extends AggregateDocument {
    "rheometry document": RheometryDocument[]
}

export interface RheometryDocument {
    "measurement aggregate document": RheometryMeasurementAggregateDocument
}

export interface RheometryMeasurementAggregateDocument extends Omit<MeasurementAggregateDocument, "measurement document"> {
    "measurement document": RheometryMeasurementDocument[]
}

export interface RheometryMeasurementDocument extends MeasurementDocument {
    "measurement chamber document": RheometryMeasurementChamberDocument
    "rheometry curve data cube": DataCube
}

class RheometryMeasurementChamberType {
    static readonly cone_plate = "cone-plate"
    static readonly plate_plate = "plate-plate"
    static readonly concentric_cylinder = "concentric-cylinder"
}

export interface RheometryMeasurementChamberDocument {
    "gap length": Property
    "measurement chamber type": RheometryMeasurementChamberType
    "radius": Property
}

const DefaultRheometryMeasurementChamberDocument: RheometryMeasurementChamberDocument = {
    "gap length": {
        value: 800,
        unit: Units.µm
    },
    "measurement chamber type": RheometryMeasurementChamberType.plate_plate,
    "radius": {
        value: 10,
        unit: Units.mm
    }
}

const RheometryCurveDataCubeStructure: DataCubeStructure = {
    "dimensions": [
        {
            "@componentDatatype": "double",
            "concept": "shear rate",
            "unit": Units._s
        },
        {
            "@componentDatatype": "double",
            "concept": "elapsed time",
            "unit": Units.s
        },
        {
            "@componentDatatype": "double",
            "concept": "step time",
            "unit": Units.s
        },
    ],
    "measures": [
        {
            "@componentDatatype": "double",
            "concept": "shear stress",
            "unit": Units.Pa
        },
        {
            "@componentDatatype": "double",
            "concept": "viscosity",
            "unit": Units.Pas
        },
        {
            "@componentDatatype": "double",
            "concept": "torque",
            "unit": Units.Nm
        },
        {
            "@componentDatatype": "double",
            "concept": "temperature",
            "unit": Units.degC
        },
    ]
}

//---------------------------------------------------------------
// Recorder implmentation
//---------------------------------------------------------------
export interface RheometryRecorderOptions extends AllotropeSimpleModelRecorderOptions {
    runtime: UAVariable
    stepRuntime: UAVariable
    shearRate: UAVariable
    shearStress: UAVariable
    viscosity: UAVariable
    torque: UAVariable
    temperature: UAVariable
}

export class RheometryRecorder extends AllotropeSimpleModelRecorder {
    options: RheometryRecorderOptions

    constructor(options: RheometryRecorderOptions) {
        super(options, [
            options.runtime, options.stepRuntime, options.shearRate, options.shearStress,
            options.viscosity, options.torque, options.temperature
        ])
        this.options = options
        this.referenceIds.push(AFODictionaryIds.rheometry, AFODictionaryIds.rheometry_aggregate_document)
    }

    createModel(): RheometryModel {
        const options = this.options
        const identifier = options.result.browseName.name
        const dataCube: DataCube = {
            "cube-structure": RheometryCurveDataCubeStructure,
            "data": {
                "dimensions": [
                    this.dataRecorder.trackValues(options.shearRate),
                    this.dataRecorder.trackValues(options.runtime).map(value => 0.001 * Number(value)),
                    this.dataRecorder.trackValues(options.stepRuntime).map(value => 0.001 * Number(value)),
                ],
                "measures": [
                    this.dataRecorder.trackValues(options.shearStress),
                    this.dataRecorder.trackValues(options.viscosity),
                    this.dataRecorder.trackValues(options.torque),
                    this.dataRecorder.trackValues(options.temperature),
                ]
            },
            "label": identifier
        }
        const measurementDocument = AllotropeSimpleModelRecorder.createMeasurementDocument(options) as RheometryMeasurementDocument
        measurementDocument["measurement chamber document"] = DefaultRheometryMeasurementChamberDocument
        measurementDocument["rheometry curve data cube"] = dataCube
        const measurementAggregateDocument = AllotropeSimpleModelRecorder.createMeasurementAggregateDocument(options, [measurementDocument]) as RheometryMeasurementAggregateDocument
        const model: RheometryModel = {
            "$asm.manifest": RheometryManifest,
            "rheometry aggregate document": {
                "rheometry document": [
                    {
                        "measurement aggregate document": measurementAggregateDocument
                    }
                ]            
            }
        }
        return model
    }

    
}

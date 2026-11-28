// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

//---------------------------------------------------------------
// LADS Allotrope Simple Model for Liquid Chromatography
//---------------------------------------------------------------
/*
Schema: lib/asm/schemas/liquid-chromatography.tabular.embed.schema.json (REC/2026/09). Validate a file with
    python3 lib/asm/tools/validate_asm.py <file.json>

Layout of the model (one liquid chromatography document per injection, one measurement document per detector channel):

    liquid chromatography aggregate document
      device system document            the LC system: nameplate, pump / detector model number, device document per module
      liquid chromatography document[]  one per injection (sample), with the analyst
        measurement aggregate document
          measurement document[]        one per detector channel (e.g. DAD1A … D)
            sample document, injection document (volume, identifier, time), chromatography column document,
            device control aggregate document (the detector: wavelength, sampling rate),
            chromatogram data cube (retention time [s] -> absorbance [mAU]),
            processed data aggregate document / peak list (retention time, area, height, width, start, end, relative area / height)

The recorder takes plain data (injections with their channel traces and peaks), so any LC server can fill it from its own
detector data; the UA nodes are only used for the device, sample and result documents (as in the other ASM recorders).
*/

import { AllotropeSimpleModel, AllotropeSimpleModelRecorder, AllotropeSimpleModelRecorderOptions, DeviceControlDocument, DeviceInfo, DeviceSystemDocument, Property, SampleDocument } from "./lads-asm"
import { UADevice } from "node-opcua-nodeset-di"
import { LADSSampleInfo } from "@interfaces"
import { AFODictionaryIds } from "@afo/lads-afo-ids"
import { getStringValue } from "@utils"

export const LiquidChromatographyManifest = "http://purl.allotrope.org/manifests/liquid-chromatography/REC/2026/09/liquid-chromatography.tabular.manifest"

//---------------------------------------------------------------
// Input data
//---------------------------------------------------------------
/** one peak of a channel, times in s after the injection */
export interface LCPeak {
    retentionTime: number
    height: number          // [mAU]
    area: number            // [mAU·s]
    widthAtHalfHeight?: number  // [s]
    start?: number          // [s]
    end?: number            // [s]
    name?: string
}

/** one detector channel of an injection: the chromatogram (equidistant or not) and its peaks */
export interface LCChannel {
    identifier: string      // e.g. "DAD1A"
    wavelength?: number     // [nm] detector wavelength setting
    bandwidth?: number      // [nm]
    samplingRate?: number   // [Hz]
    retentionTimes: number[]    // [s]
    absorbances: number[]       // [mAU]
    peaks: LCPeak[]
}

/** chromatography column (all optional) */
export interface LCColumn {
    name?: string
    manufacturer?: string
    serialNumber?: string
    partNumber?: string
    chemistry?: string      // e.g. "C18"
    length?: number         // [cm]
    innerDiameter?: number  // [mm]
    particleSize?: number   // [µm]
}

/** one injection of a run */
export interface LCInjection {
    sample: LADSSampleInfo
    injectionIdentifier: string
    injectionTime: Date
    injectionVolume: number     // [µl] = mm³
    column?: LCColumn
    /** method conditions, written as custom information (label -> value with unit), e.g. flow rate [mL/min] */
    conditions?: { label: string, value: number, unit: string }[]
    channels: LCChannel[]
}

export interface LiquidChromatographyRecorderOptions extends AllotropeSimpleModelRecorderOptions {
    /** the detector module (device control document of each channel); defaults to the first device */
    detector?: DeviceInfo
    /** the pump module (pump model number of the device system document) */
    pump?: DeviceInfo
    /** e.g. "absorbance" (default) */
    detectionType?: string
}

//---------------------------------------------------------------
// Recorder implementation
//---------------------------------------------------------------
const q = (value: number, unit: string): Property => ({ value: round(value), unit } as Property)
const round = (v: number, digits = 4) => Number.isFinite(v) ? Number(v.toFixed(digits)) : v
const text = (device: UADevice, name: "model" | "manufacturer") => (device as any)?.[name]?.readValue()?.value?.value?.text ?? ""
const value = (device: UADevice, name: "serialNumber" | "softwareRevision") => (device as any)?.[name]?.readValue()?.value?.value ?? ""

export class LiquidChromatographyRecorder extends AllotropeSimpleModelRecorder {
    options: LiquidChromatographyRecorderOptions
    injections: LCInjection[] = []

    constructor(options: LiquidChromatographyRecorderOptions) {
        super(options, [])
        this.options = options
        this.referenceIds.push(AFODictionaryIds.liquid_chromatography, AFODictionaryIds.liquid_chromatography_aggregate_document, AFODictionaryIds.chromatography_result)
    }

    addInjection(injection: LCInjection) { this.injections.push(injection) }

    createModel(): LiquidChromatographyModel {
        const options = this.options
        const analyst = getStringValue(options.result.user, "") || "unknown"
        const deviceSystemDocument: DeviceSystemDocument & { [key: string]: any } = AllotropeSimpleModelRecorder.createDeviceSystemDocument(options)
        if (deviceSystemDocument) {
            deviceSystemDocument["device document"] = deviceSystemDocument["device document"].map((d, i) => ({ ...d, "@index": i + 1 }))
            const systemDevice = options.devices[0].device
            if (text(systemDevice, "manufacturer")) deviceSystemDocument["product manufacturer"] = text(systemDevice, "manufacturer")
            if (text(systemDevice, "model")) deviceSystemDocument["model number"] = text(systemDevice, "model")
            if (value(systemDevice, "serialNumber")) deviceSystemDocument["equipment serial number"] = value(systemDevice, "serialNumber")
            if (options.pump && text(options.pump.device, "model")) deviceSystemDocument["pump model number"] = text(options.pump.device, "model")
            if (options.detector && text(options.detector.device, "model")) deviceSystemDocument["detector model number"] = text(options.detector.device, "model")
        }
        const documents = this.injections.map(injection => ({
            "analyst": analyst,
            "measurement aggregate document": {
                "analytical method identifier": options.result.programTemplate.deviceTemplateId.readValue().value.value,
                "measurement document": injection.channels.map((channel, i) => this.createMeasurementDocument(injection, channel, i + 1)),
            },
        }))
        const model: LiquidChromatographyModel = {
            "$asm.manifest": LiquidChromatographyManifest,
            "liquid chromatography aggregate document": {
                ...(deviceSystemDocument ? { "device system document": deviceSystemDocument } : {}),
                "liquid chromatography document": documents,
            }
        }
        return model
    }

    private sampleDocument(injection: LCInjection): SampleDocument {
        const sample = injection.sample
        const doc = AllotropeSimpleModelRecorder.createSampleDocument({ ...this.options, sample })
        if (!doc["location identifier"]) delete doc["location identifier"]
        return doc
    }

    private detectorDocument(channel: LCChannel, index: number): DeviceControlDocument & { [key: string]: any } {
        const detector = this.options.detector ?? this.options.devices[0]
        const doc: DeviceControlDocument & { [key: string]: any } = detector ? AllotropeSimpleModelRecorder.createDeviceControlDocument(detector) : { "device type": "detector" }
        doc["detection type"] = this.options.detectionType ?? "absorbance"
        if (channel.wavelength !== undefined) doc["detector wavelength setting"] = q(channel.wavelength, "nm")
        if (channel.bandwidth !== undefined) doc["detector bandwidth setting"] = q(channel.bandwidth, "nm")
        if (channel.samplingRate !== undefined) doc["detector sampling rate setting"] = q(channel.samplingRate, "Hz")
        doc["@index"] = index
        return doc
    }

    private columnDocument(column: LCColumn = {}): { [key: string]: any } {
        const doc: { [key: string]: any } = {}
        if (column.name) doc["written name"] = column.name
        if (column.manufacturer) doc["product manufacturer"] = column.manufacturer
        if (column.serialNumber) doc["chromatography column serial number"] = column.serialNumber
        if (column.partNumber) doc["chromatography column part number"] = column.partNumber
        if (column.chemistry) doc["chromatography column chemistry type"] = column.chemistry
        if (column.length !== undefined) doc["chromatography column length"] = q(column.length, "cm")
        if (column.innerDiameter !== undefined) doc["column inner diameter"] = q(column.innerDiameter, "mm")
        if (column.particleSize !== undefined) doc["chromatography column particle size"] = q(column.particleSize, "μm")
        return doc
    }

    private peakList(channel: LCChannel): { [key: string]: any } {
        const totalArea = channel.peaks.reduce((s, p) => s + p.area, 0)
        const totalHeight = channel.peaks.reduce((s, p) => s + p.height, 0)
        return {
            "peak": channel.peaks.map((p, i) => {
                const peak: { [key: string]: any } = {
                    "@index": i + 1,
                    "identifier": `${channel.identifier}-${i + 1}`,
                    "retention time": q(p.retentionTime, "s"),
                    "peak area": q(p.area, "mAU.s"),
                    "peak height": q(p.height, "mAU"),
                }
                if (p.name) peak["written name"] = p.name
                if (p.widthAtHalfHeight !== undefined) peak["peak width at half height"] = q(p.widthAtHalfHeight, "s")
                if (p.start !== undefined) peak["peak start"] = q(p.start, "s")
                if (p.end !== undefined) peak["peak end"] = q(p.end, "s")
                if (totalArea > 0) peak["relative peak area"] = q(100 * p.area / totalArea, "%")
                if (totalHeight > 0) peak["relative peak height"] = q(100 * p.height / totalHeight, "%")
                return peak
            })
        }
    }

    private createMeasurementDocument(injection: LCInjection, channel: LCChannel, index: number): { [key: string]: any } {
        const result = this.options.result
        const doc: { [key: string]: any } = {
            "measurement identifier": `${result.browseName.name}-${injection.injectionIdentifier}-${channel.identifier}`,
            "measurement time": injection.injectionTime.toISOString(),
            "detection type": this.options.detectionType ?? "absorbance",
            "sample document": this.sampleDocument(injection),
            "injection document": {
                "injection identifier": injection.injectionIdentifier,
                "injection time": injection.injectionTime.toISOString(),
                "autosampler injection volume setting (chromatography)": q(injection.injectionVolume, "mm^3"),
            },
            "chromatography column document": this.columnDocument(injection.column),
            "device control aggregate document": { "device control document": [this.detectorDocument(channel, 1)] },
            "chromatogram data cube": {
                "label": `${injection.injectionIdentifier} ${channel.identifier}${channel.wavelength !== undefined ? ` ${channel.wavelength} nm` : ""}`,
                "cube-structure": {
                    "dimensions": [{ "@componentDatatype": "double", "concept": "retention time", "unit": "s" }],
                    "measures": [{ "@componentDatatype": "double", "concept": "absorbance", "unit": "mAU" }],
                },
                "data": {
                    "dimensions": [channel.retentionTimes.map(t => round(t, 3))],
                    "measures": [channel.absorbances.map(a => round(a, 4))],
                },
            },
            "processed data aggregate document": { "processed data document": [{ "peak list": this.peakList(channel) }] },
        }
        if (injection.conditions?.length) doc["custom information aggregate document"] = {
            "custom information document": injection.conditions.map((c, i) => ({ "@index": i + 1, "datum label": c.label, "scalar double datum": round(c.value), "unit": c.unit })),
        }
        return doc
    }
}

export interface LiquidChromatographyModel extends AllotropeSimpleModel {
    "liquid chromatography aggregate document": {
        "device system document"?: DeviceSystemDocument
        "liquid chromatography document": any[]
    }
}

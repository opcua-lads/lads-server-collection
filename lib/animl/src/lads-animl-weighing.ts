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
// LADS initial AniML document support (experimental with focus on weighing)
//---------------------------------------------------------------

import { LADSDevice, LADSResult, LADSSampleInfo } from "@interfaces";
import { DataExporter, ensureDirectoryExists, getDateTimeValue, getStringValue } from "@utils";
import { DataType, DTBuildInfo } from "node-opcua";
import { resolve } from "path";
import { promises as fs } from "fs"
import { create } from "xmlbuilder2";
import type { XMLBuilder } from "xmlbuilder2/lib/interfaces"
import { AFODictionary, AFODictionaryIds } from "@afo";

const AnimlDocumentMimeType = "application/vnd.animl.animl+xml"

export interface AnimlDocumentOptions {
    name: string,
    dirName: string,
    fileName: string,
    result: LADSResult
    sample: LADSSampleInfo,
    device: LADSDevice,
    buildinfo: DTBuildInfo,
}

export interface AnimlWeighingDocumentOptions extends AnimlDocumentOptions{
    net: number,
    gross?: number,
    tare?: number
}

export async function addAnimlWeighingDocument(options: AnimlWeighingDocumentOptions) {
    const result = options.result
    const sample =  options.sample
    const sampleId = sample ? sample.sampleId ? sample.sampleId : sample.containerId : ""
    const device = options.device
    const buildInfo = options.buildinfo
    const documentOptions: DocumentOptions = {
        net: options.net,
        gross: options.gross,
        tare: options.tare,
        sampleId: sampleId,
        timestamp: getDateTimeValue(result.stopped).toISOString(),
        authorName: getStringValue(result.user),
        authorRole: "Operator",
        deviceName: device.getDisplayName(),
        deviceId: getStringValue(device.model),
        deviceManufacturer: getStringValue(device.manufacturer),
        deviceSerial: getStringValue(device.serialNumber),
        deviceFirmware: getStringValue(device.softwareRevision),
        softwareManufacturer: buildInfo.manufacturerName,
        softwareName: buildInfo.productName,
        softwareVersion: buildInfo.softwareVersion,
    }
    // create XML
    const xml = buildAnIML(documentOptions)

    // represent document as variable
    const variableSet = result.variableSet
    const resultVariable = variableSet.namespace.addVariable({
        propertyOf: variableSet,
        browseName: options.name,
        dataType: DataType.String,
        value: { dataType: DataType.String, value: xml}
    })

    // represent document as file
    await ensureDirectoryExists(options.dirName)
    const path = resolve(options.dirName, `${options.fileName}.xml`)
    await fs.writeFile(path, xml, "utf8").then(
        () => console.log(`Created AniML file ${path}`),
        (err) => console.log(err)
    )
    const resultFile = DataExporter.createResultFile(options.result.fileSet, options.name, options.fileName, AnimlDocumentMimeType, path)

    const references = [AFODictionaryIds.weighing, AFODictionaryIds.weighing_document, AFODictionaryIds.weighing_result]
    AFODictionary.addReferences(resultVariable,  ...references)
    AFODictionary.addReferences(resultFile,  ...references)
}

interface DocumentOptions {
    sampleId: string;
    timestamp: string;
    net: number;
    gross?: number;
    tare?: number;
    authorName: string;
    authorRole: string;
    deviceId: string;
    deviceName: string;
    deviceSerial: string;
    deviceManufacturer: string;
    deviceFirmware: string;
    softwareManufacturer: string;
    softwareName: string;
    softwareVersion: string;
}

class AnimlWeighingDocumentBuilder {
    constructor(private readonly options: DocumentOptions) { }

    build(): string {
        const root = create({
            version: "1.0",
            encoding: "UTF-8",
            standalone: true,
        }).ele("AnIML", {
            xmlns: "urn:org:astm:animl:schema:core:draft:0.90",
            "xmlns:ds": "http://www.w3.org/2000/09/xmldsig#",
            "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
            "xmlns:ns5": "http://schemas.animl.org/current/animl-core.xsd",
            version: "0.90",
            "xsi:schemaLocation": "http://schemas.animl.org/current/animl-core.xsd",
        });

        this.buildSampleSet(root);
        const step = this.buildExperimentStep(root);

        // Append results (Net + optional Gross/Tare)
        this.appendWeighingResults(step);

        // Close ExperimentStep
        step.up();

        // Empty AuditTrailEntrySet (as in example)
        root.ele("AuditTrailEntrySet").up();

        return root.end({ prettyPrint: true });
    }

    private buildSampleSet(root: XMLBuilder): void {
        const sampleSet = root.ele("SampleSet");
        const sample = sampleSet.ele("Sample", {
            id: this.options.sampleId,
            name: "WEIGHT-SAMPLE",
            sampleID: this.options.sampleId,
        });

        const cat = sample.ele("Category", { name: "Substance" });
        const param = cat.ele("Parameter", {
            name: "Name",
            parameterType: "String",
        });
        param.ele("S").txt("Net Weight").up();

        // close SampleSet branch
        cat.up();
        sample.up();
        sampleSet.up();
    }

    private buildExperimentStep(root: XMLBuilder): XMLBuilder {
        const experimentStepSet = root.ele("ExperimentStepSet");
        const experimentStep = experimentStepSet.ele("ExperimentStep", {
            id: "step_1",
            name: "Measurement",
            experimentStepID: "measurement",
        });

        const infrastructure = experimentStep.ele("Infrastructure");
        const sampleReferenceSet = infrastructure.ele("SampleReferenceSet");
        sampleReferenceSet.ele("SampleReference", {
            id: "sample_ref_1",
            samplePurpose: "consumed",
            role: "Weighted Sample",
            sampleID: this.options.sampleId,
        }).up();
        sampleReferenceSet.up();

        infrastructure.ele("Timestamp").txt(this.options.timestamp).up();
        infrastructure.up();

        const method = experimentStep.ele("Method", { id: "method_1", name: "Weighing" });
        this.appendAuthor(method);
        this.appendDevice(method);
        this.appendSoftware(method);
        method.up();

        // close ExperimentStepSet
        experimentStepSet.up();

        return experimentStep;
    }

    private appendAuthor(method: XMLBuilder): void {
        const author = method.ele("Author", { userType: "software" });
        author.ele("Name").txt(this.options.authorName).up();
        author.ele("Role").txt(this.options.authorRole).up();
        author.up();
    }

    private appendDevice(method: XMLBuilder): void {
        const device = method.ele("Device");
        device.ele("DeviceIdentifier").txt(this.options.deviceId).up();
        device.ele("Name").txt(this.options.deviceName).up();
        device.ele("SerialNumber").txt(this.options.deviceSerial).up();
        device.ele("Manufacturer").txt(this.options.deviceManufacturer).up();
        device.ele("FirmwareVersion").txt(this.options.deviceFirmware).up();
        device.up();
    }

    private appendSoftware(method: XMLBuilder): void {
        const sw = method.ele("Software");
        sw.ele("Manufacturer").txt(this.options.softwareManufacturer).up();
        sw.ele("Name").txt(this.options.softwareName).up();
        sw.ele("Version").txt(this.options.softwareVersion).up();
        sw.up();
    }

    private appendWeightParameter(
        parent: XMLBuilder,
        name: string,
        value: number,
    ): void {
        const unitLabel = "g";

        const param = parent.ele("Parameter", {
            name,
            parameterType: "Float32",
        });

        param.ele("F").txt(String(value)).up();

        const unitElem = param.ele("Unit", {
            quantity: "weight",
            label: unitLabel,
        });

        unitElem
            .ele("SIUnit", { exponent: "-3.0", factor: "0.001" })
            .txt("kg")
            .up();
    }

    private appendWeighingResults(step: XMLBuilder): void {
        const result = step.ele("Result", {
            id: "measurement",
            name: "Weighing Results",
        });

        const category = result.ele("Category", { name: "Assay" });

        // Net (required)
        this.appendWeightParameter(category, "Net Weight", this.options.net);

        // Gross (optional)
        if (this.options.gross !== undefined) {
            this.appendWeightParameter(category, "Gross Weight", this.options.gross);
        }

        // Tare (optional)
        if (this.options.tare !== undefined) {
            this.appendWeightParameter(category, "Tare Weight", this.options.tare);
        }

        category.up();
        result.up();
    }
}

// Convenience functional API preserving usage
function buildAnIML(input: DocumentOptions): string {
    const builder = new AnimlWeighingDocumentBuilder(input);
    return builder.build();
}

function test() {
    const options: DocumentOptions = {
        sampleId: "My Sample 1",
        net: 0.8,
        gross: 1.8,
        tare: 1.0,
        timestamp: new Date().toISOString(),
        authorName: "M. Arnold",
        authorRole: "Operator",
        deviceId: "My Balance",
        deviceManufacturer: "sartorius",
        deviceName: "Quintix 2",
        deviceFirmware: "1.0",
        deviceSerial: "4711",
        softwareManufacturer: "AixEngineers",
        softwareName: "LADS OPC UA Balance Gateway",
        softwareVersion: "0.1"
    }

    const xml: string = buildAnIML(options)
    console.log(xml)
}

test()

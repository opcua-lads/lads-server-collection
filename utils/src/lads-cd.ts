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
// LADS Compliance Documents Support
// LADS Digital Calibration Certifcate (DCC) Support
// To learn more about DCC visit https://www.ptb.de/dcc
//---------------------------------------------------------------

import { LADSComplianceDocument, LADSComplianceDocumentSet } from "@interfaces"
import { BaseNode, BrowseDirection, INamespace, UAFile, UAObject, UAObjectType } from "node-opcua"
import { setDateTimeValue, setStringValue } from "./lads-variable-utils"
import { assert } from "console"
import { join } from "path"
import { readFile } from "fs/promises"
import { DOMParser } from "xmldom"
import { raiseEvent } from "./lads-event-utils"
import { UADevice } from "node-opcua-nodeset-di"
import { installFileType } from "node-opcua-file-transfer"

export enum ComplianceDocumentReferences {
    HasComplianceDocument = "HasComplianceDocument",
    HasCalibrationCertificate = "HasCalibrationCertificate",
    HasValidationReport = "HasValidationReport",
    HasQualificationProtocol = "HasQualificationProtocol"
}

enum ComplianceDocumentIds {
    NameSpaceId = "http://aixengineers.de/LADS-CD/",
    ComplianceDocumentType = "ComplianceDocumentType",
    ComplianceDocumentSetType = "ComplianceDocumentSetType",
    ComplianceDocumentSet = "ComplianceDocumentSet",
}

export interface ComplianceDocumentOptions {
    browseName: string,
    documentName: string
    mimeType: string
    issuedAt: Date
    validFrom?: Date
    validUntil?: Date
    schemaUri?: string
    content?: string
    filePath?: string
    reference?: ComplianceDocumentReferences
    nodes?: BaseNode[]
}

export class ComplianceDocumentSetImpl {
    namespace: INamespace
    documentType: UAObjectType
    documentSetType: UAObjectType
    device: UADevice
    documentSet: LADSComplianceDocumentSet

    constructor(device: UADevice) {
        this.device = device
        this.namespace = device.addressSpace.getNamespace(ComplianceDocumentIds.NameSpaceId)
        this.documentType = this.namespace.findObjectType(ComplianceDocumentIds.ComplianceDocumentType)
        this.documentSetType = this.namespace.findObjectType(ComplianceDocumentIds.ComplianceDocumentSetType)
        const node = device.getChildByName(ComplianceDocumentIds.ComplianceDocumentSet, this.namespace.index) as LADSComplianceDocumentSet
        this.documentSet = node ? node : this.documentSetType.instantiate({
            browseName: ComplianceDocumentIds.ComplianceDocumentSet,
            componentOf: device,
            notifierOf: device,
        }) as LADSComplianceDocumentSet
    }

    addComplianceDocument(options: ComplianceDocumentOptions): LADSComplianceDocument {
        // create document object
        const optionals = []
        if (options.content) optionals.push("Content")
        if (options.filePath) optionals.push("File")
        if (options.schemaUri) optionals.push("SchemaUri")
        if (options.validFrom) optionals.push("ValidFrom")
        if (options.validUntil) optionals.push("ValidUntil")
        const document = this.documentType.instantiate({
            componentOf: this.documentSet,
            browseName: options.browseName,
            optionals: optionals
        }) as LADSComplianceDocument
        setStringValue(document.documentName, options.documentName)
        setDateTimeValue(document.issuedAt, options.issuedAt)
        setDateTimeValue(document.validFrom, options.validFrom)
        setDateTimeValue(document.validUntil, options.validUntil)
        setStringValue(document.content, options.content)
        setStringValue(document.mimeType, options.mimeType)
        setStringValue(document.schemaUri, options.schemaUri)

        // eventually create file object
        if (options.filePath) {
              installFileType(document.file, { filename: options.filePath, mimeType: options.mimeType })            
        }

        // create references
        const referenceTypeName = options.reference ? options.reference : ComplianceDocumentReferences.HasComplianceDocument
        const referenceType = this.namespace.findReferenceType(referenceTypeName)
        assert(referenceType)
        options.nodes?.forEach(node => {
            node.addReference({ referenceType: referenceType, nodeId: document.nodeId })
        })

        raiseEvent(this.documentSet, `Added compliance document "${options.documentName}"`)
        return document
    }

    addTextDocument(name: string, issuedAt: Date, content: string, nodes: BaseNode[], reference?: ComplianceDocumentReferences): LADSComplianceDocument {
        const options: ComplianceDocumentOptions = {
            browseName: name,
            documentName: name,
            issuedAt: issuedAt,
            reference: reference,
            nodes: nodes,
            mimeType: "text/plain; charset=us-ascii",
            content: content
        }
        return this.addComplianceDocument(options)
    }

    addPDFFile(name: string, issuedAt: Date, filePath: string, nodes: BaseNode[], reference?: ComplianceDocumentReferences): LADSComplianceDocument { return this.addFile(name, issuedAt, filePath, "application/pdf", nodes, reference) }

    addFile(name: string, issuedAt: Date, filePath: string, mimeType: string, nodes: BaseNode[], reference?: ComplianceDocumentReferences): LADSComplianceDocument {
        const options: ComplianceDocumentOptions = {
            browseName: name,
            documentName: name,
            issuedAt: issuedAt,
            reference: reference,
            nodes: nodes,
            mimeType: mimeType,
            filePath: filePath
        }
        return this.addComplianceDocument(options)
    }

    addDCC(name: string, content: string, nodes: BaseNode[]): LADSComplianceDocument {
        const data = this.parseDCC(content)
        const issuedAt = data.endDate ?? new Date()
        const options: ComplianceDocumentOptions = {
            browseName: `DCC-${name}`,
            documentName: `Digital Calibration Certifcate ${name}`,
            issuedAt: issuedAt,
            reference: ComplianceDocumentReferences.HasCalibrationCertificate,
            nodes: nodes,
            mimeType: "application/vnd.ptb.dcc+xml",
            schemaUri: "https://ptb.de/dcc/schema/3.3.0",
            content: content
        }
        return this.addComplianceDocument(options)
    }

    async addDCCFromFile(dir: string, name: string, nodes: BaseNode[]): Promise<LADSComplianceDocument> {
        const path = join(dir, `${name}.xml`)
        try {
            const content = await readFile(path, 'utf-8')
            const dccDocument = this.addDCC(name, content, nodes)
            return dccDocument
        } catch (err) {
            console.warn(`Failed to load DCC: ${path}`)
        }
        return undefined
    }

    private parseDCC(xmlString: string): { beginDate?: Date, endDate?: Date } {
        const parser = new DOMParser()
        const xml = parser.parseFromString(xmlString, "application/xml");
        const DCC_NS = "https://ptb.de/dcc";
        const beginEl = xml.getElementsByTagNameNS(DCC_NS, "beginPerformanceDate")[0];
        const endEl = xml.getElementsByTagNameNS(DCC_NS, "endPerformanceDate")[0];

        return {
            beginDate: new Date(beginEl?.textContent),
            endDate: new Date(endEl?.textContent)
        }
    }

    findComplianceDocumentsApplyingTo(node: UAObject, reference: ComplianceDocumentReferences = ComplianceDocumentReferences.HasComplianceDocument): LADSComplianceDocument[] {
        if (!node) return []
        const referenceType = this.namespace.findReferenceType(reference)
        const references = node.findReferencesEx(referenceType.nodeId, BrowseDirection.Forward)
        const documents = references.map((reference) => {
            return node.addressSpace.findNode(reference.nodeId) as LADSComplianceDocument
        })
        return documents
    }
}

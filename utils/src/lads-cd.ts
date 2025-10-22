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
import { AddressSpace, BaseNode, BrowseDirection, INamespace, OPCUAServer, UAFile, UAObject, UAObjectType } from "node-opcua"
import { setDateTimeValue, setStringValue } from "./lads-variable-utils"
import { assert } from "console"
import { join } from "path"
import { readFile } from "fs/promises"
import { DOMParser } from "xmldom"
import { raiseEvent } from "./lads-event-utils"
import { getBrowsePath } from "./lads-utils"

export enum ComplianceDocumentReferences {
    HasComplianceDocument = "HasComplianceDocument",
    HasCalibrationCertificate = "HasCalibrationCertificate",
    HasValidationReport = "HasValidationReport",
    HasQualificationProtocol = "HasQualificationProtocol"
}

enum ComplianceDocumentIds {
    ComplianceDocumentType = "ComplianceDocumentType",
    ComplianceDocumentSetType = "ComplianceDocumentSetType",
    ComplianceDocumentSet = "ComplianceDocumentSet",
}

export interface ComplianceDocumentOptions {
    parent: LADSComplianceDocumentSet
    browseName: string,
    documentName: string
    mimeType: string
    issuedAt: Date
    validFrom?: Date
    validUntil?: Date
    schemaUri?: string
    content?: string
    file?: UAFile
    reference?: ComplianceDocumentReferences
    nodes?: BaseNode[]
}

export class ComplianceDocuments {
    static readonly nameSpaceId = "http://aixengineers.de/LADS-CD/"
    static isInstalled = false
    static namespace: INamespace
    static complianceDocumentSetType: UAObjectType
    static complianceDocumentType: UAObjectType

    static checkInstalled(node: BaseNode) {
        if (!node) return
        if (this.isInstalled) return
        const addressSpace = node.addressSpace
        const namespace = addressSpace.getNamespace(this.nameSpaceId)
        this.namespace = namespace
        this.complianceDocumentSetType = namespace.findObjectType(ComplianceDocumentIds.ComplianceDocumentSetType)
        this.complianceDocumentType = namespace.findObjectType(ComplianceDocumentIds.ComplianceDocumentType)
        this.isInstalled = true
    }

    static getComplianceDocumentSet(parent: UAObject): LADSComplianceDocumentSet {
        if (!parent) return
        this.checkInstalled(parent)
        // check if node already exists
        const child = parent.getChildByName(ComplianceDocumentIds.ComplianceDocumentSet) as LADSComplianceDocumentSet
        if (child) return child
        // create new set
        const documentSet = this.complianceDocumentSetType.instantiate({
            browseName: ComplianceDocumentIds.ComplianceDocumentSet,
            componentOf: parent,
            notifierOf: parent,
            optionals: ["NodeVersion"]
        })
        // initialze node-version
        setStringValue(documentSet.getNodeVersion(), "0")
        return documentSet
    }

    static addComplianceDocument(options: ComplianceDocumentOptions): LADSComplianceDocument {
        const parent = options.parent
        if (!parent) return
        this.checkInstalled(parent)

        // create document object
        const optionals = []
        if (options.content) optionals.push("Content")
        if (options.file) optionals.push("File")
        if (options.schemaUri) optionals.push("SchemaUri")
        if (options.validFrom) optionals.push("ValidFrom")
        if (options.validUntil) optionals.push("ValidUntil")
        const document = this.complianceDocumentType.instantiate({
            componentOf: parent,
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

        // create references
        const referenceTypeName = options.reference ? options.reference : ComplianceDocumentReferences.HasComplianceDocument
        const referenceType = this.namespace.findReferenceType(referenceTypeName)
        assert(referenceType)
        options.nodes?.forEach(node => {
            node.addReference({ referenceType: referenceType, nodeId: document.nodeId })
        })

        raiseEvent(parent, `Added compliance document "${options.documentName}"`)
        return document
    }

    static addTextDocument(parent: UAObject, name: string, issuedAt: Date, content: string, nodes: BaseNode[], reference?: ComplianceDocumentReferences): LADSComplianceDocument {
        const options: ComplianceDocumentOptions = {
            parent: parent,
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

    static addDCC(parent: UAObject, name: string, content: string, nodes: BaseNode[]): LADSComplianceDocument {
        const data = this.parseDCC(content)
        const issuedAt = data.endDate ?? new Date()
        const options: ComplianceDocumentOptions = {
            parent: parent,
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

    static async addDCCFromFile(parent: UAObject, dir: string, name: string, nodes: BaseNode[]): Promise<LADSComplianceDocument> {
        const path = join(dir, `${name}.xml`)
        try {
            const content = await readFile(path, 'utf-8')
            const dccDocument = this.addDCC(parent, name, content, nodes)
            return dccDocument
        } catch (err) {
            console.warn(`Failed to load DCC: ${path}`)
        }
        return undefined
    }

    private static parseDCC(xmlString: string): {beginDate?: Date, endDate?: Date} {
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

    static findComplianceDocumentsApplyingTo(node: UAObject, reference: ComplianceDocumentReferences = ComplianceDocumentReferences.HasComplianceDocument): LADSComplianceDocument[] {
        if (!node) return []
        const referenceType = this.namespace.findReferenceType(reference)
        const references = node.findReferencesEx(referenceType.nodeId, BrowseDirection.Forward)
        const documents = references.map((reference) => {
            return node.addressSpace.findNode(reference.nodeId) as LADSComplianceDocument
        })
        return documents
    }

    static getComplianceDocumentUri(server: OPCUAServer, document: LADSComplianceDocument): string {
        if (!document) return ""
        const browsePath = getBrowsePath(document)
        const encodedBrowsePath = encodeURIComponent(browsePath)
        const endpointUrl = server.endpoints[0].endpointDescriptions()[0].endpointUrl
        const uri = `${endpointUrl}?path=${encodedBrowsePath}`
        return uri
    }
}


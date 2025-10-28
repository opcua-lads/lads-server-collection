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
import { AccessLevelFlag, BaseNode, BrowseDirection, DataType, INamespace, makeBrowsePath, QualifiedName, ReferenceTypeIds, UAObject, UAObjectType, UAReference } from "node-opcua"
import { getDateTimeValue, getStringValue, setDateTimeValue, setStringValue } from "./lads-variable-utils"
import { assert } from "console"
import { join, sep, relative, resolve } from "path"
import { access, mkdir, writeFile, readFile } from "fs/promises"
import { DOMParser } from "xmldom"
import { raiseEvent } from "./lads-event-utils"
import { installFileType } from "node-opcua-file-transfer"
import { getChildObjects } from "./lads-utils"

export enum ComplianceDocumentReferences {
    HasComplianceDocument = "HasComplianceDocument",
    HasCalibrationCertificate = "HasCalibrationCertificate",
    HasCalibrationReport = "HasCalibrationReport",
    HasValidationReport = "HasValidationReport",
    HasQualificationProtocol = "HasQualificationProtocol",
    HasDeclarationOfConformity = "HasDeclarationOfConformity",
}

enum ComplianceDocumentIds {
    NameSpaceId = "http://aixengineers.de/LADS-CD/",
    ComplianceDocumentType = "ComplianceDocumentType",
    ComplianceDocumentSetType = "ComplianceDocumentSetType",
    ComplianceDocumentSet = "ComplianceDocumentSet",
}

export interface ComplianceDocumentNodeReference {
    reference: ComplianceDocumentReferences
    node: BaseNode
}
export type ComplianceDocumentNodeReferences = ComplianceDocumentNodeReference[]

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
    nodeReferences?: ComplianceDocumentNodeReferences
    dictionaryEntries?: string[]
}
interface ComplianceDocumentExportOptions extends ComplianceDocumentOptions {
    contentFilePath?: string
    referencedNodes?: {
        reference: ComplianceDocumentReferences
        nodePath: string
    }[]
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

function constructFileName(baseName: string, mimeType: string): string {
    const mt = mimeType.split("/")
    assert(mt.length === 2)
    const rhs = mt[1]
    const ext = rhs.includes("+") ? ((rhs.split("+"))[1]).trim() : rhs.trim()
    return `${join(baseName)}.${ext}`
}

export class ComplianceDocumentSetImpl {
    namespace: INamespace
    documentType: UAObjectType
    documentSetType: UAObjectType
    parent: UAObject
    documentSet: LADSComplianceDocumentSet
    appDir: string
    documentsDir: string

    constructor(parent: UAObject, appDir: string, documentsDir: string) {
        this.parent = parent
        this.appDir = appDir
        this.documentsDir = documentsDir
        this.namespace = parent.addressSpace.getNamespace(ComplianceDocumentIds.NameSpaceId)
        this.documentType = this.namespace.findObjectType(ComplianceDocumentIds.ComplianceDocumentType)
        this.documentSetType = this.namespace.findObjectType(ComplianceDocumentIds.ComplianceDocumentSetType)
        const node = parent.getChildByName(ComplianceDocumentIds.ComplianceDocumentSet, this.namespace.index) as LADSComplianceDocumentSet
        this.documentSet = node ? node : this.documentSetType.instantiate({
            browseName: new QualifiedName({ name: ComplianceDocumentIds.ComplianceDocumentSet, namespaceIndex: this.namespace.index }),
            componentOf: parent,
            notifierOf: parent,
            optionals: ["NodeVersion"]
        }) as LADSComplianceDocumentSet
        setStringValue(this.documentSet.getNodeVersion(), "0")
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
            const filePath = options.filePath
            const fileName = filePath.split(sep)
            installFileType(document.file, { filename: filePath, mimeType: options.mimeType })
            // remember filename for later restoration
            document.namespace.addVariable({
                propertyOf: document.file,
                browseName: "FileName",
                dataType: DataType.String,
                accessLevel: AccessLevelFlag.CurrentRead,
                value: { dataType: DataType.String, value: fileName.pop() }
            })
        }

        // create references
        options.nodeReferences?.forEach(nr => {
            const referenceType = this.namespace.findReferenceType(nr.reference)
            assert(referenceType)
            nr.node.addReference({ referenceType: referenceType, nodeId: document.nodeId })
        })

        // eventually create dictionary references
        const hasDictionaryEntryType = document.addressSpace.findReferenceType(ReferenceTypeIds.HasDictionaryEntry)
        options.dictionaryEntries?.forEach(dictionaryEntry => {
            const node = this.findNode(dictionaryEntry)
            if (node) document.addReference({referenceType: hasDictionaryEntryType, nodeId: node})
        })

        // finished
        raiseEvent(this.documentSet, `Added compliance document "${options.documentName}"`)
        return document
    }

    get documents(): LADSComplianceDocument[] {
        const children = getChildObjects(this.documentSet)
        const documents = children.filter(child => (child.typeDefinitionObj.isSubtypeOf(this.documentType))) as LADSComplianceDocument[]
        return documents
    }

    async save() {
        const dir = this.documentsDir
        try {
            console.debug(`Creating documents directory ${resolve(dir)}`)
            await mkdir(dir, { recursive: true })
        } catch (err) {
            console.debug(err)
        }
        const documents = this.documents
        const optionsList: ComplianceDocumentExportOptions[] = []
        for (const document of documents) {
            const nodeReferences = this.findNodesReferencedbyComplianceDocument(document)
            const mimeType = getStringValue(document.mimeType)
            const content = document.content ? getStringValue(document.content) : undefined
            const fileName = content ? constructFileName(document.browseName.name, mimeType) : document.file.fileName ? getStringValue(document.file.fileName) : undefined
            const filePath = fileName ? relative(this.appDir, join(dir, fileName)) : undefined
            const options: ComplianceDocumentExportOptions = {
                browseName: document.browseName.name,
                documentName: getStringValue(document.documentName),
                issuedAt: getDateTimeValue(document.issuedAt),
                validFrom: document.validFrom ? getDateTimeValue(document.validFrom) : undefined,
                validUntil: document.validUntil ? getDateTimeValue(document.validUntil) : undefined,
                mimeType: mimeType,
                schemaUri: document.schemaUri ? getStringValue(document.schemaUri) : undefined,
                filePath: content ? undefined : filePath,
                contentFilePath: content ? filePath : undefined,
                referencedNodes: nodeReferences.length > 0 ? nodeReferences.map(referencedNode => {
                    return {
                        reference: referencedNode.reference,
                        nodePath: referencedNode.node.fullName()
                    }


                }) : undefined,
                dictionaryEntries: this.findDictionaryEntries(document).map(reference => { return reference.node.fullName() })
            }

            // eventually store content (if not alredy available, content should be immutable)
            if (content) {
                try {
                    if (!fileExists(filePath)) {
                        console.debug(`Saving document ${filePath}`)
                        await writeFile(filePath, content, "utf-8")
                    }
                } catch (err) {
                    console.debug(err)
                }
            }
            optionsList.push(options)
        }

        // save decription
        try {
            const data = JSON.stringify(optionsList, null, 2);
            await writeFile(join(dir, "compliance_documents.json"), data, "utf-8")
        } catch (err) {
            console.debug(err)
        }
    }

    findNode(nodePath: string) {
        try {
            const addressSpace = this.documentSet.addressSpace
            const objectsFolder = addressSpace.rootFolder.objects
            const bnf = `/${nodePath}`
            const browsePath = makeBrowsePath(objectsFolder, bnf)
            const result = addressSpace.browsePath(browsePath)
            const targets = result.targets
            if (targets?.length > 0) {
                return addressSpace.findNode(targets[0].targetId)
            }
            return undefined
        } catch (err) {
            console.debug(err)
        }
    }


    async load() {
        const addressSpace = this.documentSet.addressSpace
        const objectsFolder = addressSpace.rootFolder.objects
        const dir = this.documentsDir
        const appDir = this.appDir
        let optionsList: ComplianceDocumentExportOptions[] = []
        try {
            const data = await readFile(join(dir, "compliance_documents.json"), "utf-8")
            optionsList = JSON.parse(data)
        } catch (err) {
            console.debug(err)
        }
        for (const options of optionsList) {

            // adjust Date items
            options.issuedAt = new Date(options.issuedAt)
            options.validFrom = options.validFrom ? new Date(options.validFrom) : undefined
            options.validUntil = options.validUntil ? new Date(options.validUntil) : undefined

            // rebuild node references
            const nodeReferences: ComplianceDocumentNodeReferences = options.referencedNodes?.map(referencedNode => {
                const node = this.findNode(referencedNode.nodePath)
                if (node) return { node: node, reference: referencedNode.reference }
            })
            options.nodeReferences = nodeReferences

            // eventually rebuild content
            if (options.contentFilePath) {
                try {
                    const content: string = await readFile(join(appDir, options.contentFilePath), "utf-8")
                    options.content = content
                }
                catch (err) {
                    console.debug(err)
                }
            }

            // adjust filepath
            if (options.filePath) {
                options.filePath = join(appDir, options.filePath)
            }

            // create document
            this.addComplianceDocument(options)
        }
    }

    addTextDocument(name: string, issuedAt: Date, content: string, nodeReferences: ComplianceDocumentNodeReferences): LADSComplianceDocument {
        const options: ComplianceDocumentOptions = {
            browseName: name,
            documentName: name,
            issuedAt: issuedAt,
            mimeType: "text/plain; charset=us-ascii",
            content: content,
            nodeReferences: nodeReferences,
        }
        return this.addComplianceDocument(options)
    }

    addPDFFile(name: string, issuedAt: Date, filePath: string, nodeReferences?: ComplianceDocumentNodeReferences): LADSComplianceDocument {
        return this.addFile(name, issuedAt, filePath, "application/pdf", nodeReferences)
    }

    addFile(name: string, issuedAt: Date, filePath: string, mimeType: string, nodeReferences?: ComplianceDocumentNodeReferences): LADSComplianceDocument {
        const options: ComplianceDocumentOptions = {
            browseName: name,
            documentName: name,
            issuedAt: issuedAt,
            mimeType: mimeType,
            filePath: filePath,
            nodeReferences: nodeReferences,
        }
        return this.addComplianceDocument(options)
    }

    addDCC(name: string, content: string, nodeReferences: ComplianceDocumentNodeReferences): LADSComplianceDocument {
        const data = this.parseDCC(content)
        const issuedAt = data.endDate ?? new Date()
        const options: ComplianceDocumentOptions = {
            browseName: `DCC-${name}`,
            documentName: `Digital Calibration Certifcate ${name}`,
            issuedAt: issuedAt,
            mimeType: "application/vnd.ptb.dcc+xml",
            schemaUri: "https://ptb.de/dcc/schema/3.3.0",
            content: content,
            nodeReferences: nodeReferences,
        }
        return this.addComplianceDocument(options)
    }

    async addDCCFromFile(dir: string, name: string, nodeReferences: ComplianceDocumentNodeReferences): Promise<LADSComplianceDocument> {
        const path = join(dir, `${name}.xml`)
        try {
            const content = await readFile(path, 'utf-8')
            const dccDocument = this.addDCC(name, content, nodeReferences)
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

    findNodesReferencedbyComplianceDocument(document: LADSComplianceDocument, reference: ComplianceDocumentReferences = ComplianceDocumentReferences.HasComplianceDocument): ComplianceDocumentNodeReference[] {
        if (!document) return []
        const addressSpace = document.addressSpace
        const referenceType = this.namespace.findReferenceType(reference)
        const references = document.findReferencesEx(referenceType.nodeId, BrowseDirection.Inverse)
        return references.map(reference => {
            return {
                reference: ((addressSpace.findReferenceType(reference.referenceType)).browseName.name) as ComplianceDocumentReferences,
                node: reference.node
            }
        })
    }

    findDictionaryEntries(document: LADSComplianceDocument): UAReference[] {
        if (!document) return []
        const addressSpace = document.addressSpace
        const referenceType = addressSpace.findReferenceType(ReferenceTypeIds.HasDictionaryEntry)
        return document.findReferencesEx(referenceType.nodeId, BrowseDirection.Forward)

    }

    findComplianceDocumentsApplyingTo(node: UAObject, reference: ComplianceDocumentReferences = ComplianceDocumentReferences.HasComplianceDocument): LADSComplianceDocument[] {
        if (!node) return []
        const referenceType = this.namespace.findReferenceType(reference)
        const references = node.findReferencesEx(referenceType.nodeId, BrowseDirection.Forward)
        return references.map(reference => { return node.addressSpace.findNode(reference.nodeId) as LADSComplianceDocument })
    }
}

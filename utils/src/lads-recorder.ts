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
// LADS data recorder
//---------------------------------------------------------------
import { AccessLevelFlag, assert, coerceNodeId, DataType, IEventData, ReferenceTypeIds, UAAnalogItem, UAObject, UAVariable, VariableTypeIds, VariantT } from "node-opcua"
import Excel from "exceljs"
import { resolve } from "path"
import { LADSResultFile } from "@interfaces"
import { installFileType } from "node-opcua-file-transfer"
import { getLADSObjectType } from "@utils"
import { promises as fs } from "fs"
import { AFODictionary } from "@afo"

export async function ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
        const stats = await fs.stat(dirPath);
        if (!stats.isDirectory()) {
            throw new Error(`${dirPath} exists but is not a directory.`);
        }
        // Directory exists
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            // Directory does not exist, create it
            await fs.mkdir(dirPath, { recursive: true });
            console.log(`Directory created: ${dirPath}`);
        } else {
            // Some other error
            throw error;
        }
    }
}

//---------------------------------------------------------------
export class DataExporter {
    static MimeTypeXSLX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    static MimeTypeJSON = "application/json"

    static createResultFile(fileSet: UAObject, name: string, fileName: string, mimeType: string, path: string): LADSResultFile {
        // create LADS result file object in fileset
        const resultFileType = getLADSObjectType(fileSet.addressSpace, "ResultFileType")
        assert(resultFileType)
        const resultFile = resultFileType.instantiate({
            componentOf: fileSet,
            browseName: name,
            optionals: ["File"]
        }) as LADSResultFile
        resultFile.name.setValueFromSource({ dataType: DataType.String, value: fileName })
        resultFile.mimeType.setValueFromSource({ dataType: DataType.String, value: mimeType })
        installFileType(resultFile.file, { filename: path, mimeType: mimeType })
        AFODictionary.addDefaultResultFileReferences(resultFile)
        return resultFile
    }


    async writeXSLXResultFile(fileSet: UAObject, name: string, dirName: string, fileName: string, recorders: DataRecorder[]): Promise<LADSResultFile> {
        // create XSLX file
        const path = await this.writeXSLX(dirName, fileName, recorders)
        return DataExporter.createResultFile(fileSet, name, fileName, DataExporter.MimeTypeXSLX, path)
    }

    async writeXSLX(dirName: string, fileName: string, recorders: DataRecorder[]): Promise<string> {
        // eventually create directoy
        await ensureDirectoryExists(dirName)
        const path = resolve(dirName, `${fileName}.xlsx`)

        const workbook = new Excel.Workbook()
        recorders.forEach(recorder => recorder.addXLSXWorksheet(workbook))
        await workbook.xlsx.writeFile(path).then(
            () => { console.log("XSLX file created", path) },
            (reason) => { console.log(reason) }
        )
        return path
    }
}

//---------------------------------------------------------------
export abstract class DataRecorder {
    static timestampFormat = "dd.mm.yyyy hh:MM:ss"
    static delimiter = "\r\n"

    identifier: string


    constructor(identifier: string) {
        this.identifier = identifier
    }

    writeXLSX(fileName: string) { new DataExporter().writeXSLX(__dirname, fileName, [this]) }

    abstract addXLSXWorksheet(workbook: Excel.Workbook): Excel.Worksheet;
}

export class EventDataRecorder extends DataRecorder {
    eventSource: UAObject
    records: EventDataRecord[] = []

    constructor(identifier: string, eventSource: UAObject) {
        super(identifier)
        this.eventSource = eventSource
        eventSource.on("event", this.eventHandler.bind(this))
    }

    eventHandler(eventData: IEventData) {
        this.records.push(new EventDataRecord(eventData))
    }

    addXLSXWorksheet(workbook: Excel.Workbook): Excel.Worksheet {
        const worksheet = workbook.addWorksheet(this.identifier)
        // header
        worksheet.columns = [
            { header: "Timestamp", width: 20, style: { numFmt: DataRecorder.timestampFormat } },
            { header: "Source", width: 20 },
            { header: "Message", width: 40 },
            { header: "Severity", width: 8 },
        ]
        worksheet.getRow(1).eachCell(cell => cell.font = { bold: true })

        // records
        this.records.forEach(record => {
            const row = [record.timestamp, record.sourceName, record.message, record.severity]
            worksheet.addRow(row)
        })
        return worksheet
    }

}

interface EventData extends IEventData {
    time?: VariantT<Date, DataType.DateTime>
    localTime?: VariantT<Date, DataType.DateTime>
    severity?: VariantT<number, DataType.UInt16>
    sourceName?: VariantT<string, DataType.String>
    message?: VariantT<string, DataType.String>
}

export class EventDataRecord {
    timestamp: Date
    severity: number
    message: string
    sourceName: string

    constructor(eventData: IEventData) {
        const ed: EventData = eventData
        this.timestamp = ed.time ? ed.time.value : new Date()
        this.severity = ed.severity ? ed.severity.value : 0
        this.message = ed.message ? ed.message.value : "Unknown message"
        this.sourceName = ed.sourceName ? ed.sourceName.value : "Unknown source"
    }
}

export class VariableDataRecorder extends DataRecorder {
    tracks: ResultTrack[]
    records: ResultRecord[] = []

    constructor(identifier: string, variables: UAVariable[]) {
        super(identifier)
        this.tracks = variables.map(variable => { return new ResultTrack(variable) })
    }

    createRecord(): ResultRecord {
        const record = new ResultRecord(this.tracks)
        this.records.push(record)
        return record
    }

    getLastRecord(): ResultRecord {
        const count = this.records.length
        if (count === 0) return undefined
        return this.records[count - 1]
    }

    createCSVString(): string {
        let result = ""
        // header
        result += `"Timestamp"`
        this.tracks.forEach(track => {
            const name = track.eu.length > 0 ? `${track.name} [${track.eu}]` : track.name
            result += `, "${name}"`
        })
        result += DataRecorder.delimiter
        // records
        this.records.forEach(record => {
            result += `"${record.timestamp.toISOString()}"`
            record.tracksRecord.forEach((trackValue, index) => {
                const value = typeof trackValue === "string" ? `"${trackValue}"` : trackValue
                result += `, ${value}`
            })
            result += DataRecorder.delimiter
        })
        return result
    }

    addXLSXWorksheet(workbook: Excel.Workbook): Excel.Worksheet {
        const worksheet = workbook.addWorksheet(this.identifier)
        // header
        const header = ["Timestamp"]
        this.tracks.forEach(track => {
            const name = track.eu.length > 0 ? `${track.name} [${track.eu}]` : track.name
            header.push(name)
        })
        const headerRow = worksheet.addRow(header)
        worksheet.getColumn(1).numFmt = DataRecorder.timestampFormat
        headerRow.eachCell((cell, colNumber) => {
            cell.font = { bold: true }
            const col = worksheet.getColumn(colNumber)
            col.width = 20
        })

        // records
        this.records.forEach(record => {
            const recordRow: (Date | string | number)[] = [record.timestamp]
            record.tracksRecord.forEach(trackValue => { recordRow.push(trackValue) })
            worksheet.addRow(recordRow)
        })
        return worksheet
    }

    trackIndex(variable: UAVariable): number { return this.tracks.findIndex(track => (track.variable === variable)) }

    trackValues(variable: UAVariable): (number | string)[] {
        const trackIndex = this.trackIndex(variable)
        if (trackIndex >= 0) {
            return this.records.map(record => record.tracksRecord[trackIndex])
        } else {
            console.warn(`Unable to find track for variable ${variable.browseName.name}`)
        }
    }

}

export class ResultTrack {
    name: string
    eu: string
    variable: UAVariable
    dataType: DataType

    constructor(variable: UAVariable) {
        const parentName = variable.parent.getDisplayName()
        const variableName = variable.getDisplayName()
        const trailer = (variableName.includes("CurrentValue") || variableName.includes("SensorValue")) ? "PV" : (variableName.includes("TargetValue") ? "SP" : variableName)
        this.name = `${parentName}.${true?variableName:trailer}`
        this.dataType = variable.getBasicDataType()
        const variableType = variable.typeDefinitionObj
        const analogItemType = variable.addressSpace.findVariableType(coerceNodeId(VariableTypeIds.AnalogItemType))
        const isAnalogItem = variableType.isSubtypeOf(analogItemType)
        const euInformation = isAnalogItem ? (<UAAnalogItem<number, DataType.Double>>variable)?.engineeringUnits.readValue().value.value : undefined
        this.eu = euInformation ? euInformation.displayName.text : ""
        this.variable = variable
    }
}

export class ResultRecord {
    timestamp: Date
    tracks: ResultTrack[]
    tracksRecord: (number | string)[]

    constructor(tracks: ResultTrack[]) {
        this.timestamp = new Date()
        this.tracks = tracks
        this.tracksRecord = tracks.map(track => {
            const dataValue = track.variable.readValue()
            return track.dataType === DataType.LocalizedText ? dataValue.value.value.text : dataValue.value.value
        })
    }

    createResultVariables(name: string, parent: UAObject): UAObject {
        const namespace = parent.namespace

        const resultObject = namespace.addObject({
            componentOf: parent,
            browseName: name,
        })
        const hasDictionaryReferenceType = parent.addressSpace.findReferenceType(coerceNodeId(ReferenceTypeIds.HasDictionaryEntry))
        this.tracksRecord.forEach((trackValue, index) => {
            const track = this.tracks[index]
            const variable = namespace.addVariable({
                propertyOf: resultObject,
                browseName: track.name,
                description: `Sampled value of ${track.name} [${track.eu}]`,
                accessLevel: AccessLevelFlag.CurrentRead,
                dataType: track.dataType,
                value: { dataType: track.dataType, value: trackValue }
            })
            const referencedDictionaryObjects = track.variable.findReferencesAsObject(hasDictionaryReferenceType)
            referencedDictionaryObjects?.forEach(node => {
                // console.log(`Adding refrerence for ${track.name} => ${node.getDisplayName()}`)
                variable.addReference({
                    referenceType: hasDictionaryReferenceType,
                    nodeId: node.nodeId
                })
            })
        })
        return resultObject
    }
}



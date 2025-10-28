// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Balance
Copyright (C) 2025  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

//---------------------------------------------------------------
// functional unit implementation
//---------------------------------------------------------------

import { AFODictionary, AFODictionaryIds } from "@afo"
import { LADSProgramTemplate, LADSProperty, LADSSampleInfo, LADSResult, LADSAnalogScalarSensorFunction, LADSActiveProgram, LADSFunctionalState, LADSTwoStateDiscreteSensorFunction, LADSMultiStateDiscreteSensorFunction, LADSDeviceState, LADSComplianceDocumentSet } from "@interfaces"
import { getLADSObjectType, getDescriptionVariable, promoteToFiniteStateMachine, setNumericValue, touchNodes, raiseEvent, setStringValue, setDateTimeValue, copyProgramTemplate, setPropertiesValue, setSamplesValue, setSessionInformation, ProgramTemplateElement, addProgramTemplate, setBooleanValue, constructPropertiesExtensionObject, getNumericValue, getDateTimeValue, getStringValue, modifyStatusCode } from "@utils"
import { UAObject, DataType, UAStateMachineEx, StatusCodes, VariantLike, SessionContext, CallMethodResultOptions, Variant, StatusCode, DTKeyValuePair } from "node-opcua"
import { join } from "path"
import { BalanceDeviceImpl, getBalanceNameSpace } from "./device"
import { BalanceFunctionalUnit, BalanceFunctionalUnitStatemachine, BalanceFunctionSet } from "./interfaces"
import { BalanceRecorder } from "@asm"
import { Balance, BalanceCalibrationReport, BalanceEvents, BalanceReading, BalanceResponseType, BalanceStatus, BalanceTareMode } from "./balance"
import { EventEmitter } from "events"
import { ComplianceDocumentNodeReferences, ComplianceDocumentReferences, ComplianceDocumentSetImpl } from "utils/src/lads-cd"
import { BalanceDeviceConfig, BalanceProtocols } from "./server"

//---------------------------------------------------------------
interface CurrentRunOptions {
    programTemplateId: string
    runId: string,
    started: Date,
    startedMilliseconds: number
    minRunTimeMilliseconds: number
    maxRuntimeMilliseconds: number
    programTemplate: LADSProgramTemplate
    supervisoryJobId: string
    supervisoryTaskId: string
    properties?: LADSProperty[]
    samples?: LADSSampleInfo[]
    result?: LADSResult
    recorder?: BalanceRecorder
    recorderInterval?: NodeJS.Timeout
    runtimeInterval?: NodeJS.Timeout
}

export class ProgramTemplateIds {
    static readonly RegisterWeight = "Register Weight"
    static readonly SetZero = "Set Zero"
    static readonly SetTare = "Set Tare"
    static readonly SetPresetTare = "Set Preset Tare"
    static readonly ClearTare = "Clear Tare"
}

//---------------------------------------------------------------
export abstract class BalanceUnitImpl extends EventEmitter {
    parent: BalanceDeviceImpl
    balance: Balance
    config: BalanceDeviceConfig
    lastReading: BalanceReading
    functionalUnit: BalanceFunctionalUnit
    functionalUnitState: UAStateMachineEx
    currentWeight: LADSAnalogScalarSensorFunction
    netWeight: LADSAnalogScalarSensorFunction
    grossWeight: LADSAnalogScalarSensorFunction
    tareWeight: LADSAnalogScalarSensorFunction
    weightStable: LADSTwoStateDiscreteSensorFunction
    tareMode: LADSMultiStateDiscreteSensorFunction
    programTemplates: LADSProgramTemplate[] = []
    activeProgram: LADSActiveProgram
    currentRunOptions: CurrentRunOptions
    programTemplateElements: ProgramTemplateElement[] = []
    documentSet: ComplianceDocumentSetImpl

    constructor(parent: BalanceDeviceImpl, config: BalanceDeviceConfig, optionals: string[] = []) {
        super()
        this.parent = parent
        this.config = config
        // create unit object
        const functionalUnitSet = parent.getFunctionalUnitSet()
        const balanceUnitType = getBalanceNameSpace(functionalUnitSet.addressSpace).findObjectType("BalanceUnitType")
        this.functionalUnit = balanceUnitType.instantiate({
            browseName: "BalanceUnit",
            displayName: "Balance Unit",
            componentOf: functionalUnitSet,
            optionals: optionals
        }) as BalanceFunctionalUnit
    }

    async postInitialize() {
        // init functional unit & state machine
        const functionalUnit = this.functionalUnit
        const stateMachine = functionalUnit.functionalUnitState as BalanceFunctionalUnitStatemachine
        stateMachine.setZero.bindMethod(this.setZero.bind(this))
        stateMachine.setTare.bindMethod(this.setTare.bind(this))
        stateMachine.setPresetTare?.bindMethod(this.setPresetTare.bind(this))
        stateMachine.clearTare?.bindMethod(this.clearTare.bind(this))
        stateMachine.registerWeight.bindMethod(this.regsterWeight.bind(this))
        stateMachine.start.bindMethod(this.start.bind(this))
        stateMachine.startProgram.bindMethod(this.startProgram.bind(this))
        stateMachine.stop.bindMethod(this.stop.bind(this))
        stateMachine.abort.bindMethod(this.abort.bind(this))
        this.functionalUnitState = promoteToFiniteStateMachine(stateMachine)
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)

        // init sensors
        const addressSpace = this.functionalUnit.addressSpace
        const functionSet = true ? this.functionalUnit.getComponentByName("FunctionSet") as BalanceFunctionSet : functionalUnit.functionSet
        // balance sensor
        this.currentWeight = functionSet.currentWeight
        this.currentWeight.sensorValue.historizing = true
        addressSpace.installHistoricalDataNode(this.currentWeight.sensorValue)
        this.weightStable = functionSet.weightStable
        this.tareMode = functionSet.tareMode
        this.grossWeight = functionSet.currentWeight.functionSet?.gross
        this.netWeight = functionSet.currentWeight.functionSet?.net
        this.tareWeight = functionSet.currentWeight.functionSet?.tare
        // add AFO
        AFODictionary.addReferences(functionalUnit, AFODictionaryIds.measurement_device, AFODictionaryIds.weighing_device)
        AFODictionary.addSensorFunctionReferences(this.currentWeight, AFODictionaryIds.weighing, AFODictionaryIds.sample_weight)
        AFODictionary.addSensorFunctionReferences(this.grossWeight, AFODictionaryIds.weighing, AFODictionaryIds.gross_weight)
        AFODictionary.addSensorFunctionReferences(this.netWeight, AFODictionaryIds.weighing, AFODictionaryIds.sample_weight)
        AFODictionary.addSensorFunctionReferences(this.tareWeight, AFODictionaryIds.weighing, AFODictionaryIds.tare_weight)

        // experimental - create compliance-document-set & add fake DCC
        const device = this.parent.device
        const documentsDir = join(__dirname, "documents", device.browseName.name)
        this.documentSet = new ComplianceDocumentSetImpl(device, __dirname, documentsDir)

        // load nodes
        this.documentSet.load()

        // create some nodes
        const calibrationDocumentAppliesTo: ComplianceDocumentNodeReferences = [
            { node: device, reference: ComplianceDocumentReferences.HasCalibrationCertificate },
            { node: functionalUnit, reference: ComplianceDocumentReferences.HasCalibrationCertificate },
            { node: this.currentWeight, reference: ComplianceDocumentReferences.HasCalibrationCertificate },
        ]
        if (false) {
            // add example docments from resoucres
            const dir = join(__dirname, "resources")
            // const dir  = "resources"
            if (this.config.protocol === BalanceProtocols.SBI) {
                const dccDocument = await this.documentSet.addDCCFromFile(dir, "224G372", calibrationDocumentAppliesTo)
                const pdfDocument = this.documentSet.addPDFFile("24_08_224_G372_ME5_F_22313544", new Date(), join(dir, "24_08_224_G372_ME5_F_22313544_15_10_2025_14_37_07_UTC.pdf"), calibrationDocumentAppliesTo)
                const docDocument = this.documentSet.addPDFFile("EU Declaration of Conformity", new Date(), join(dir, "sartorius quintix doc.pdf"), [{ node: device, reference: ComplianceDocumentReferences.HasDeclarationOfConformity }])
                AFODictionary.addReferences(dccDocument, AFODictionaryIds.calibration_certificate, AFODictionaryIds.calibration_certificate_identifier)
                AFODictionary.addReferences(pdfDocument, AFODictionaryIds.calibration_certificate, AFODictionaryIds.calibration_certificate_identifier)
                AFODictionary.addReferences(docDocument, AFODictionaryIds.conformance_assessment)
            } else if (this.config.protocol === BalanceProtocols.SICS) {
                const docDocument = this.documentSet.addPDFFile("EU Declaration of Conformity", new Date(), join(dir, "DoC_MS8001TS_00.pdf"), [{ node: device, reference: ComplianceDocumentReferences.HasDeclarationOfConformity }])
                AFODictionary.addReferences(docDocument, AFODictionaryIds.conformance_assessment)
            }
            this.documentSet.save()
        }


        // connect to balance object
        this.setStatusCodes(StatusCodes.BadWaitingForInitialData)
        this.raiseMessage(`Connecting to balance ${this.balanceName}..`)
        //const status = await this.balance.getStatus()
        //if (status === BalanceStatus.Offline) await this.balance.connect()
        this.balance.startPolling()

        // update information model variables from balance object events
        this.balance.on(BalanceEvents.Reading, (reading: BalanceReading) => {
            if (!reading) return
            const responseType = reading.responseType ?? BalanceResponseType.Reading
            if (responseType === BalanceResponseType.Reading) {
                const statusCode = reading.stable ? StatusCodes.Good : StatusCodes.UncertainSensorNotAccurate
                setNumericValue(this.currentWeight.sensorValue, reading.weight, statusCode)
                setBooleanValue(this.weightStable.sensorValue, reading.stable)
                setNumericValue(this.tareMode.sensorValue, reading.tareMode)
                const tare = reading.tareWeight ?? 0
                const gross = (reading.tareMode === BalanceTareMode.None) ? reading.weight : reading.weight + tare
                const net = gross - tare
                setNumericValue(this.grossWeight?.sensorValue, gross)
                setNumericValue(this.netWeight?.sensorValue, net)
                setNumericValue(this.tareWeight?.sensorValue, tare)
            } else if ((responseType === BalanceResponseType.High) || (responseType === BalanceResponseType.Low)) {
                if (responseType != this.lastReading.responseType) {
                    raiseEvent(this.functionalUnit, `Weight exceeds ${responseType === BalanceResponseType.High ? "high" : "low"} limit!`, 1000)
                    modifyStatusCode(this.currentWeight.sensorValue, StatusCodes.BadOutOfRange)
                }
            }
            this.lastReading = reading
        })

        // update calibration report
        let lastCalibrationTimestamp = new Date().toISOString()
        this.balance.on(BalanceEvents.CalibrationReport, (calibrationReport: BalanceCalibrationReport) => {
            const timestampISOString = calibrationReport.timestamp.toISOString()
            if (timestampISOString != lastCalibrationTimestamp) {
                const document = this.documentSet.addTextDocument(`CalInternal-${timestampISOString}`, calibrationReport.timestamp, calibrationReport.report, calibrationDocumentAppliesTo)
                AFODictionary.addReferences(document, AFODictionaryIds.calibration_report)
                raiseEvent(this.functionalUnit, 'Received calibration report.')
                lastCalibrationTimestamp = timestampISOString
            }
        })

        // update connection status
        this.balance.on(BalanceEvents.Status, (status: BalanceStatus) => {
            if (status === BalanceStatus.Offline) {
                this.enterOffline()
            } else if (status === BalanceStatus.Online) {
                this.enterOnline()
            } else if (status === BalanceStatus.StandBy) {
                this.enterStandBy()
            }
        })

        // log error message
        this.balance.on(BalanceEvents.Error, (message: string) => {
            this.raiseMessage(`Balance ${this.balanceName} error: ${message}`)
        })

        // init program manager
        this.initProgramTemplates()
    }

    //---------------------------------------------------------------
    // program manager implementation
    //---------------------------------------------------------------
    private initProgramTemplates() {
        const programTemplateSet = this.functionalUnit.programManager.programTemplateSet as UAObject
        // pre-initialize nodeversion to avoid node-opcua stack messages
        setStringValue(programTemplateSet.getNodeVersion(), "0")
        const date = new Date(Date.parse("2025-09-01T00:00:00.000Z"))
        this.programTemplateElements.push(addProgramTemplate(programTemplateSet, {
            identifier: ProgramTemplateIds.RegisterWeight,
            description: "Weigh sample and create result record.",
            author: "AixEngineers",
            created: date,
            modified: date,
            referenceIds: [AFODictionaryIds.weighing, AFODictionaryIds.sample_weight],
        }))
        this.programTemplateElements.push(addProgramTemplate(programTemplateSet, {
            identifier: ProgramTemplateIds.SetTare,
            description: "Tare balance",
            author: "AixEngineers",
            created: date,
            modified: date,
            referenceIds: [AFODictionaryIds.calibration, AFODictionaryIds.weighing, AFODictionaryIds.tare_weight]
        }))
        if (this.balance?.supportsPresetTare) {
            this.programTemplateElements.push(addProgramTemplate(programTemplateSet, {
                identifier: ProgramTemplateIds.SetPresetTare,
                description: "Preset tare to a given value in grams. Provide the preset-tare value as property named 'tare'. If omitted the tare will be set to zero.",
                author: "AixEngineers",
                created: date,
                modified: date,
                referenceIds: [AFODictionaryIds.calibration, AFODictionaryIds.weighing, AFODictionaryIds.tare_weight]
            }))
            this.programTemplateElements.push(addProgramTemplate(programTemplateSet, {
                identifier: ProgramTemplateIds.ClearTare,
                description: "Clear tare.",
                author: "AixEngineers",
                created: date,
                modified: date,
                referenceIds: [AFODictionaryIds.calibration, AFODictionaryIds.weighing, AFODictionaryIds.tare_weight]
            }))
        }
        this.programTemplateElements.push(addProgramTemplate(programTemplateSet, {
            identifier: ProgramTemplateIds.SetZero,
            description: "Zero balance",
            author: "AixEngineers",
            created: date,
            modified: date,
            referenceIds: [AFODictionaryIds.calibration, AFODictionaryIds.weighing]
        }))
        touchNodes(programTemplateSet)
    }

    private touchResult() {
        const result = this.currentRunOptions.result
        touchNodes(this.functionalUnit.programManager.resultSet as UAObject, result, result?.fileSet, result?.variableSet)
    }

    private readyToStart(): boolean {
        const currentState = this.functionalUnitState.getCurrentState();
        return (currentState.includes(LADSFunctionalState.Stopped) || currentState.includes(LADSFunctionalState.Aborted))
    }

    private readyToStop(): boolean {
        const currentState = this.functionalUnitState.getCurrentState();
        return (currentState.includes(LADSFunctionalState.Running))
    }

    private initCurrentRunOptions(template: ProgramTemplateElement) {
        const started = new Date()
        const iso = started.toISOString()
        const date = iso.slice(0, 10).replace(/-/g, "")
        const time = iso.slice(11, 19).replace(/:/g, "")
        const deviceProgramRunId = `${date}-${time}-${this.parent.config.name}-${template.identifier}`.replace(/[ (),°]/g, "")
        this.currentRunOptions = {
            programTemplateId: template.identifier,
            started: started,
            startedMilliseconds: Date.now(),
            minRunTimeMilliseconds: 1000,
            maxRuntimeMilliseconds: template.identifier === ProgramTemplateIds.RegisterWeight ? 5000 : 2000,
            programTemplate: template.programTemplate,
            runId: deviceProgramRunId,
            supervisoryJobId: "",
            supervisoryTaskId: "",
        }
    }

    setStatusCodes(statusCode: StatusCode) {
        modifyStatusCode(this.currentWeight.sensorValue, statusCode)
        modifyStatusCode(this.weightStable.sensorValue, statusCode)
        modifyStatusCode(this.tareMode.sensorValue, statusCode)
        modifyStatusCode(this.tareWeight?.sensorValue, statusCode)
    }

    private get balanceName(): string { return this.parent.config.name }

    private raiseMessage(message: string, severity = 0) {
        console.info(message)
        raiseEvent(this.functionalUnit, message, severity)
    }

    protected enterOnline() {
        this.raiseMessage(`Balance ${this.balanceName} online`)
        this.parent.deviceHelper.enterDeviceOperating()
    }

    protected enterOffline() {
        this.raiseMessage(`Balance ${this.balanceName} offline`, 1000)
        this.setStatusCodes(StatusCodes.UncertainLastUsableValue)
        this.parent.deviceHelper.enterDeviceInitialzation()
    }

    protected enterStandBy() {
        this.raiseMessage(`Balance ${this.balanceName} standby`, 100)
        this.setStatusCodes(StatusCodes.UncertainLastUsableValue)
        this.parent.deviceHelper.enterDeviceSleep()
    }

    protected async enterMeasuring(context: SessionContext) {
        const options = this.currentRunOptions
        const programTemplateId = options.programTemplateId
        raiseEvent(this.functionalUnit, `Starting method ${programTemplateId} with identifier ${options.runId}.`)

        // execute methods
        switch (programTemplateId) {
            case ProgramTemplateIds.SetTare:
                this.balance.setTare()
                break
            case ProgramTemplateIds.SetZero:
                this.balance.setZero()
                break
            case ProgramTemplateIds.ClearTare:
                this.balance.clearTare()
                break
            case ProgramTemplateIds.SetPresetTare:
                const property = options.properties?.find((property) => (property.key.toLowerCase().includes("tare")))
                const tare = property ? Number(property.value) : 0.0
                this.balance.setPresetTare(tare)
                break
        }

        // create result
        const createResult = (programTemplateId === ProgramTemplateIds.RegisterWeight)
        if (createResult) {
            const referenceIds: string[] = [AFODictionaryIds.weighing, AFODictionaryIds.weighing_aggregate_document, AFODictionaryIds.weighing_document, AFODictionaryIds.weighing_result]
            const resultType = getLADSObjectType(this.functionalUnit.addressSpace, "ResultType")
            const resultSet = <UAObject>this.functionalUnit.programManager.resultSet
            options.result = <LADSResult><unknown>resultType.instantiate({
                componentOf: resultSet,
                browseName: options.runId,
                optionals: ["NodeVersion", "FileSet.NodeVersion", "VariableSet.NodeVersion"]
            })
            const result = options.result
            AFODictionary.addDefaultResultReferences(result)
            AFODictionary.addReferences(result, ...referenceIds)

            setSessionInformation(result, context)
            setStringValue(getDescriptionVariable(result), `Run based on template ${options.programTemplateId}, started ${options.started.toLocaleDateString()}.`)
            setPropertiesValue(result.properties, options.properties)
            setSamplesValue(result.samples, options.samples)
            setStringValue(result.supervisoryJobId, options.supervisoryJobId)
            setStringValue(result.supervisoryTaskId, options.supervisoryTaskId)
            setStringValue(result.deviceProgramRunId, options.runId)
            setDateTimeValue(result.started, options.started)
            copyProgramTemplate(options.programTemplate, result.programTemplate)
            this.touchResult()

            // build ASM recorder
            // if net-weight is available choose it as source for sample-weight over current-weight
            const sampleWeight = (this.netWeight) ? this.netWeight : this.currentWeight
            const calibrationCertificates = this.documentSet.findComplianceDocumentsApplyingTo(this.functionalUnit, ComplianceDocumentReferences.HasCalibrationCertificate)
            const digitalCalibrationCertificates = calibrationCertificates.filter((document) => (getStringValue(document.schemaUri, "")?.includes("dcc")))
            const calibrationCertificate = digitalCalibrationCertificates.length > 0 ? digitalCalibrationCertificates[0] : calibrationCertificates.length > 0 ? calibrationCertificates[0] : undefined
            options.recorder = new BalanceRecorder({
                devices: [{ device: this.parent.device, deviceType: "Balance" }],
                sample: options.samples[0],
                result: result,
                runtime: this.functionalUnit.programManager.activeProgram.currentRuntime,
                sampleWeight: sampleWeight.sensorValue,
                tareWeight: this.tareWeight?.sensorValue,
                grossWeight: this.grossWeight?.sensorValue,
                calibrationTime: getDateTimeValue(calibrationCertificate?.issuedAt),
                calibrationCertficate: getStringValue(calibrationCertificate?.documentName)
            })
            options.recorder.addReferenceIds(...referenceIds)
            this.balance.on(BalanceEvents.Reading, (reading: BalanceReading) => { options.recorder.createRecord() })
        }

        // runtime recording
        const activeProgram = this.functionalUnit.programManager.activeProgram
        setNumericValue(activeProgram.currentRuntime, 0)
        setNumericValue(activeProgram.estimatedRuntime, options.maxRuntimeMilliseconds)
        setStringValue(activeProgram.deviceProgramRunId, options.runId)
        options.runtimeInterval = setInterval(() => {
            const runtime = Date.now() - options.startedMilliseconds
            setNumericValue(activeProgram.currentRuntime, runtime)

            // check if method can be finished
            if (runtime > options.minRunTimeMilliseconds) {
                if (this.lastReading) {
                    if (this.lastReading.stable) {
                        this.leaveMeasuring(LADSFunctionalState.Stopping)
                    } else if (runtime > options.maxRuntimeMilliseconds) {
                        this.leaveMeasuring(LADSFunctionalState.Aborting)
                    }
                }
            }
        }, 500)
        this.functionalUnitState.setState(LADSFunctionalState.Running)
    }

    private async leaveMeasuring(state: LADSFunctionalState) {
        const stateMachine = this.functionalUnitState
        stateMachine.setState(state)

        const options = this.currentRunOptions
        if (!options) {
            // if options not defined simply leave
            stateMachine.setState(LADSFunctionalState.Stopped)
            raiseEvent(this.functionalUnit, `Stopping run.`, 100)
        } else {
            // clear timers
            clearInterval(options.runtimeInterval)
            options.recorderInterval ? clearInterval(options.recorderInterval) : 0
            const result = options.result
            if (state === LADSFunctionalState.Aborting) {
                // delete result and leave
                result?.namespace.deleteNode(options.result)
                stateMachine.setState(LADSFunctionalState.Aborted)
                raiseEvent(this.functionalUnit, `Aborting method ${options.programTemplateId} with identifier ${options.runId}.`, 500)
            } else {
                if (result) {
                    // set stopped timestamp
                    setDateTimeValue(result.stopped, new Date())

                    // add end-points
                    const variableSet = result.variableSet
                    const dataRecorder = options.recorder.dataRecorder
                    const lastRecord = dataRecorder.getLastRecord()
                    if (lastRecord) {
                        const sampleWeight = (this.netWeight) ? this.netWeight : this.currentWeight
                        const sampleWeightTrackIndex = dataRecorder.trackIndex(sampleWeight.sensorValue)
                        if (sampleWeightTrackIndex >= 0) {
                            const sampleWeightResult = result.namespace.addVariable({
                                componentOf: variableSet,
                                browseName: "Sample Weight",
                                description: "Weighing endpoint.",
                                dataType: DataType.Double,
                                value: { dataType: DataType.Double, value: lastRecord.tracksRecord[sampleWeightTrackIndex] }
                            })
                            AFODictionary.addReferences(sampleWeightResult, AFODictionaryIds.weighing_result, AFODictionaryIds.sample_weight)
                        }
                    }

                    // create ASM
                    const model = options.recorder.createModel()
                    if (model) {
                        const resultsDirectory = join(__dirname, "data", "results")
                        options.recorder.writeResultFile(result.fileSet, "ASM", resultsDirectory, options.runId, model)
                        const json = JSON.stringify(model, null, 2)
                        const asm = result.namespace.addVariable({
                            componentOf: variableSet,
                            browseName: "ASM",
                            dataType: DataType.String,
                            value: { dataType: DataType.String, value: json }
                        })
                        AFODictionary.addReferences(asm, AFODictionaryIds.ASM_file, AFODictionaryIds.weighing, AFODictionaryIds.weighing_document, AFODictionaryIds.weighing_result)
                    }
                }
                // set state to stopped and leave    
                stateMachine.setState(LADSFunctionalState.Stopped)
                raiseEvent(this.functionalUnit, `Finalized method ${options.programTemplateId} with identifier ${options.runId}.`, 100)
            }
            // touch everything
            this.touchResult()
        }
        this.currentRunOptions = undefined
    }

    private findProgramTemplate(programTemplateId: string): ProgramTemplateElement {
        const id = programTemplateId.toLowerCase()
        return this.programTemplateElements.find(value => value.identifier.toLowerCase().includes(id))
    }

    private async startMethod(context: SessionContext, programTemplateId: string, properties?: LADSProperty[], samples?: LADSSampleInfo[]): Promise<CallMethodResultOptions> {
        if (!this.readyToStart()) return { statusCode: StatusCodes.BadInvalidState }
        this.initCurrentRunOptions(this.findProgramTemplate(programTemplateId))
        this.currentRunOptions.properties = properties ?? []
        this.currentRunOptions.samples = samples ?? []
        this.enterMeasuring(context)
        return { statusCode: StatusCodes.Good }
    }
    private async setTare(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return await this.startMethod(context, ProgramTemplateIds.SetTare)
    }
    private async setPresetTare(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        const property: LADSProperty = { key: "Tare", value: inputArguments[0].value }
        return await this.startMethod(context, ProgramTemplateIds.SetPresetTare, [property])
    }
    private async clearTare(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return await this.startMethod(context, ProgramTemplateIds.ClearTare)
    }
    private async setZero(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return await this.startMethod(context, ProgramTemplateIds.SetZero)
    }
    private async regsterWeight(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        const sampleId = String(inputArguments[0]?.value.value)
        const sampleInfo: LADSSampleInfo = { containerId: "", sampleId: sampleId, position: "", customData: "", }
        return await this.startMethod(context, ProgramTemplateIds.RegisterWeight, undefined, [sampleInfo])
    }
    private async start(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        // search key-value pairs for sampleId
        const inputArgument = inputArguments[0].value
        const keyValuePairs = (inputArgument === null) ? [] : (inputArgument as Variant[]).map(item => { return (<any>item) as DTKeyValuePair })
        const sampleKeyValuePair = keyValuePairs.find(keyValuePair => (keyValuePair.key.name.toLowerCase().includes("sampleid")))
        const sampleId: string = sampleKeyValuePair ? String(sampleKeyValuePair.value.value) : "Unknown"
        const sampleInfo: LADSSampleInfo = { containerId: "", sampleId: sampleId, position: "", customData: "" }
        return await this.startMethod(context, ProgramTemplateIds.RegisterWeight, undefined, [sampleInfo])
    }

    private async startProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStart()) return { statusCode: StatusCodes.BadInvalidState }
        const programTemplateId: string = inputArguments[0].value
        const programTemplate = this.programTemplateElements.find(value => value.identifier.toLowerCase().includes(programTemplateId.toLowerCase()))
        if (programTemplate) {
            this.initCurrentRunOptions(programTemplate)
            this.runProgram(inputArguments, context)
            return {
                outputArguments: [new Variant({ dataType: DataType.String, value: this.currentRunOptions.runId })],
                statusCode: StatusCodes.Good
            }
        } else {
            return { statusCode: StatusCodes.BadInvalidArgument }
        }
    }

    private async runProgram(inputArguments: VariantLike[], context: SessionContext) {
        const options = this.currentRunOptions
        options.supervisoryJobId = inputArguments[2].value ? inputArguments[2].value : ""
        options.supervisoryTaskId = inputArguments[3].value ? inputArguments[3].value : ""

        // analyze properties
        const propertiesValue = inputArguments[1].value
        options.properties = propertiesValue === null ? [] : (propertiesValue as Variant[]).map(item => { return (<any>item) as LADSProperty })

        // analyze samples
        const samplesValue = inputArguments[4].value
        options.samples = samplesValue === null ? [] : (samplesValue as Variant[]).map(item => { return (<any>item) as LADSSampleInfo })

        this.enterMeasuring(context)
    }

    private async stop(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStop()) return { statusCode: StatusCodes.BadInvalidState }
        this.leaveMeasuring(LADSFunctionalState.Stopping)
        return { statusCode: StatusCodes.Good }
    }

    private async abort(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStop()) return { statusCode: StatusCodes.BadInvalidState }
        this.leaveMeasuring(LADSFunctionalState.Aborting)
        return { statusCode: StatusCodes.Good }
    }
}

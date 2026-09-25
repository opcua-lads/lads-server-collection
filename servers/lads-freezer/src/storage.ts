import { LADSAnalogControlFunction, LADSCoverFunction, LADSProgramManager, LADSProperty, LADSResult, LADSRunnnigState, LADSSampleInfo } from "@interfaces"
import { FreezerDeviceImpl } from "./device"
import { UAComponent } from "node-opcua-nodeset-di"
import { CallMethodResultOptions, coerceNodeId, DataType, ISessionContext, readUAAnalogItem, ReferenceTypeIds, StatusCodes, UAAnalogItemEx, UAAnalogUnit, UAAnalogUnitRange, UAObject, UAProperty, UAStateMachineEx, UAVariable, Variant, VariantLike, VariantOptions } from "node-opcua"
import { addAnalogUnitRangeBasedOn, addProgramTemplate, addSampleInfoVariable, addStringVariable, copyProgramTemplate, createDeviceProgramRunId, createResult, createSamplesValue, EventSeverity, getDescriptionVariable, getEUInformation, getNumericValue, getStringValue, ProgramTemplateElement, raiseEvent, setDateTimeValue, setNumericValue, setPropertiesValue, setSamplesValue, setSessionInformation, setStringValue, sleepMilliSeconds } from "@utils"
import { AFODictionary, AFODictionaryIds } from "@afo"


interface Compartment extends UAComponent {
    samples: UAProperty<any, DataType.ExtensionObject>
}

function pad(n: number, m: number): string {
    return n.toString().padStart(m, "0");
}

export function toSampleInfos(variant: VariantOptions): LADSSampleInfo[] {
    if (variant.value == null) return []
    const sampleInfos: LADSSampleInfo[] = (variant.value as any[]).map(sample => ({
        containerId: sample.containerId,
        sampleId: sample.sampleId,
        position: sample.position,
        customData: sample.customData
    }))
    return sampleInfos
}

export function getSampleInfos(variable: UAVariable, defaultValue: LADSSampleInfo[] = []): LADSSampleInfo[] {
    if (!variable) return defaultValue
    try {
        return toSampleInfos(variable.readValue().value)
    }
    catch {
        return defaultValue
    }
}

export function toProperties(variant: VariantOptions): LADSProperty[] {
    if (variant.value == null) return []
    const properties: LADSProperty[] = (variant.value as any[]).map(property => ({
        key: property.key,
        value: property.value,
    }))
    return properties
}


export function getProperties(variable: UAVariable, defaultValue: LADSProperty[] = []): LADSProperty[] {
    if (!variable) return defaultValue
    try {
        return toProperties(variable.readValue().value)
    }
    catch {
        return defaultValue
    }
}

export function findProperty(propertyKey: string, properties: LADSProperty[]) : LADSProperty | undefined {
    if (!properties) return undefined
    const key = propertyKey.trim().toLowerCase()
    const property = properties.find(property => property.key.trim().toLowerCase() == key)
    return property
}



enum StorageAction {Unknown, CheckIn, CheckOut, ReportInventory}

interface StorageEvent {
    action: StorageAction
    compartmentName: string
    sampleInfo: LADSSampleInfo
}
type StorageEvents = StorageEvent[]

function dictionaryIds(action: StorageAction): string[] {
    switch(action) {
        case StorageAction.CheckIn: return [AFODictionaryIds.adding_of_material]
        case StorageAction.CheckOut: return [AFODictionaryIds.removing_material]
        case StorageAction.ReportInventory: return [AFODictionaryIds.reporting]
        default: return []
    }            
}
        
export class StorageImpl {
    deviceImpl: FreezerDeviceImpl
    programManagerImpl: ProgramManagerImpl
    cabinet: UAObject
    compartments: Compartment[] = []

    constructor(deviceImpl: FreezerDeviceImpl, manufacturer = "Eppendorf", compartmentCount = 3, samplesPerCompartment = 24) {
        this.deviceImpl = deviceImpl
        this.programManagerImpl = new ProgramManagerImpl(this)

        // create compartments w/ samples
        const device = this.deviceImpl.device
        const functionalUnit = this.deviceImpl.freezerUnit.functionalUnit
        const addressSpace = device.addressSpace
        const nameSpace = device.namespace
        const nameSpaceLADS = addressSpace.getNamespace('http://opcfoundation.org/UA/LADS/')
        const sampleInfoType = nameSpaceLADS.findDataType("SampleInfoType")
        const controlsReferenceType = addressSpace.findReferenceType(coerceNodeId(ReferenceTypeIds.Controls))
        const storageSet = nameSpace.addObject({
            componentOf: device,
            browseName: "StorageSet",
            displayName: "Storage Set",
            eventSourceOf: device,
            nodeVersion: "0"
        })
        this.cabinet = nameSpace.addObject({
            componentOf: storageSet,
            browseName: "Cabinet",
            eventSourceOf: storageSet,
            nodeVersion: "0"
        })
        functionalUnit.addReference({
            referenceType: controlsReferenceType,
            nodeId: this.cabinet
        })
        AFODictionary.addReferences(storageSet, AFODictionaryIds.container, AFODictionaryIds.to_store)
        AFODictionary.addReferences(this.cabinet, AFODictionaryIds.container, AFODictionaryIds.to_store, AFODictionaryIds.temperature_controlled_chamber)

        // cretae compartments
        for (let i = 1; i <= compartmentCount; i++) {
            const name = `Compartment ${i}`
            const compartment = nameSpace.addObject({
                componentOf: this.cabinet,
                browseName: name.replaceAll(" ", ""),
                displayName: name
            })
            const header = `47${pad(i, 2)}`
            const sampleInfos: LADSSampleInfo[] = []
            for (let id = 1; id <= samplesPerCompartment; id++) {
                sampleInfos.push({
                    containerId: pad(i, 4),
                    sampleId: `${header}${pad(id, 4)}`,
                    position: "",
                    customData: ""
                })
            }
            const samples = compartment.namespace.addVariable({
                propertyOf: compartment,
                browseName: "Samples",
                dataType: sampleInfoType,
                valueRank: 1,
                value: createSamplesValue(addressSpace, sampleInfos)

            })
            this.compartments.push(compartment as Compartment)

            AFODictionary.addReferences(compartment, AFODictionaryIds.container, AFODictionaryIds.container_identifier, AFODictionaryIds.to_store, AFODictionaryIds.temperature_controlled_chamber)
            AFODictionary.addReferences(samples, AFODictionaryIds.sample_identifier)
        }        
    }
}

interface EUInformationReport {
    namespaceUri: string
    unitId: number
    displayName: string
    description: string
}

interface CompartmentReport {
    compartment: string
    samples: LADSSampleInfo[]
}

interface StorageReport {
    programTemplate: string
    storage: string
    timestamp: string
    temperature: number
    temperatureEU: EUInformationReport
    compartments: CompartmentReport[]
}

class ProgramManagerImpl {
    storage: StorageImpl
    programTemplateElements: ProgramTemplateElement[] = []
    door: LADSCoverFunction
    temperatureController: LADSAnalogControlFunction
    programManager: LADSProgramManager
    runningStateMachine: UAStateMachineEx
    isRunning: boolean = false
    started = 0

    constructor(storage: StorageImpl) {
        this.storage = storage
        const unit = storage.deviceImpl.freezerUnit
        const functionalUnit = unit.functionalUnit
        this.programManager = functionalUnit.programManager
        this.runningStateMachine = unit.runningStateMachine
        if (!this.programManager) {
            console.debug("Storage requires ProgramManager")
            return
        }
        const programTemplates = this.programManager.programTemplateSet as UAObject
        const date = new Date("2026-09-08T12:00:00.000Z")
        const author = "M. Arnold, AixEngineers"
        this.programTemplateElements.push(addProgramTemplate(programTemplates, {
            identifier: "Check Out",
            description: "Checks-out samples with sample-ids provided by the samples list argument.",
            created: date,
            modified: date,
            author: author,
            version: "1.0",
            referenceIds: [AFODictionaryIds.removing_material]
        }))
        this.programTemplateElements.push(addProgramTemplate(programTemplates, {
            identifier: "Check In",
            description: "Checks-in samples provided by the samples list argument. The targeted sample compartment should be provided in the properties list with key-value 'Compartment': <CompartmentName>'.",
            created: date,
            modified: date,
            author: author,
            version: "1.0",
            referenceIds: [AFODictionaryIds.adding_of_material]
        }))
        this.programTemplateElements.push(addProgramTemplate(programTemplates, {
            identifier: "Report Inventory",
            description: "Create an report of the current inventory. The report is modeled as variable name 'Inventory' in the result's VariableSet.",
            created: date,
            modified: date,
            author: author,
            version: "1.0",
            referenceIds: [AFODictionaryIds.reporting]
        }))
        const functionSet = functionalUnit.functionSet
        this.door = functionSet.door
        this.temperatureController = functionSet.temperatureController
        const stateMachine = functionalUnit.functionalUnitState
        stateMachine.startProgram?.bindMethod(this.startProgram.bind(this))
        //stateMachine.stop?.bindMethod()
    }


    private findSample(sampleId: string): [LADSSampleInfo, Compartment] | undefined {
        for (const compartment of this.storage.compartments) {
            const samples = getSampleInfos(compartment.samples)
            for (const sample of samples) {
                if (sample.sampleId === sampleId) {
                    return [sample, compartment]
                }
            }
        }
        return [undefined, undefined]
    }

    private findSamples(sampleInfos: LADSSampleInfo[]): LADSSampleInfo[] {
        const foundSamples: LADSSampleInfo[] = []
        sampleInfos.forEach(sampleInfo => {
            const [found, _] = this.findSample(sampleInfo.sampleId)
            if (found) foundSamples.push(found)
        })
        return foundSamples  
    }

    private findCompartment(compartmentName: string | undefined): Compartment | undefined {
        if (compartmentName == undefined) return undefined
        const name = compartmentName.trim().toLowerCase()
        for (const compartment of this.storage.compartments) {
            if (compartment.getDisplayName().trim().toLowerCase() == name) {
                return compartment
            }
        }
        return undefined
    }

    private checkIn(compartment: Compartment, sampleInfos : LADSSampleInfo[]) {
        const events: StorageEvents = []
        if (!compartment) return events
        const compartmentName = compartment.getDisplayName()
        const samples = getSampleInfos(compartment.samples)
        const samplesLength = samples.length
        for (const sampleInfo of sampleInfos) {
            const [sample, compartment] = this.findSample(sampleInfo.sampleId)
            if (sample) {
                raiseEvent(this.storage.cabinet, `Sample with sample-id ${sample.sampleId} alreaday stored in comartmemt ${compartmentName}.`, EventSeverity.Warning)
            } else {
                samples.push(sampleInfo)
                raiseEvent(this.storage.cabinet, `Stored sample with sample-id ${sampleInfo.sampleId} in compartment ${compartmentName}.`)
                events.push({
                    action: StorageAction.CheckIn,
                    compartmentName: compartmentName,
                    sampleInfo: sampleInfo,
                })
            }
        }
        if (samples.length > samplesLength) {
            setSamplesValue(compartment.samples, samples)
        }
        return events
    }

    private checkOut(sampleInfos: LADSSampleInfo[]): StorageEvents {
        const events: StorageEvents = []
        for (const sampleInfo of sampleInfos) {
            const [sample, compartment] = this.findSample(sampleInfo.sampleId)
            if (compartment) {
                const samples = getSampleInfos(compartment.samples)
                const remainingSamples = samples.filter(sample => sample.sampleId != sampleInfo.sampleId)
                setSamplesValue(compartment.samples, remainingSamples)
                raiseEvent(this.storage.cabinet, `Removed sample with sample-id ${sampleInfo.sampleId} from compartment ${compartment.getDisplayName()}.`)
                events.push({
                    action: StorageAction.CheckOut,
                    compartmentName: compartment.getDisplayName(),
                    sampleInfo: sample,
                })
            }
        }
        return events
    }

    private async startProgram(inputArguments: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {

        // if (!this.isAccessibleBy(context)) return {statusCode: StatusCodes.BadLocked }
        function getAction(element: ProgramTemplateElement): StorageAction {
            if (!element) return StorageAction.Unknown
            const identifier = element.identifier.trim().replaceAll(" ", "").toLowerCase()
            switch (identifier) {
                case "checkin": return StorageAction.CheckIn
                case "checkout": return StorageAction.CheckOut
                case "reportinventory": return StorageAction.ReportInventory
                default: return StorageAction.Unknown
            }
        }

        function readyToRun(element: ProgramTemplateElement, action: StorageAction, samples: LADSSampleInfo[], samplesFound: LADSSampleInfo[], compartment: Compartment): boolean {
            if (!element) return false
            const samplesLength = samples.length
            const samplesFoundLength = samplesFound.length
            switch (action) {
                case StorageAction.CheckIn: return (samplesLength > 0) && (samplesFoundLength == 0) && (compartment != undefined)
                case StorageAction.CheckOut: return (samplesFoundLength > 0) 
                case StorageAction.ReportInventory: return true
                default: return false
            }
        }

        if (this.isRunning) return { statusCode: StatusCodes.BadInvalidState }
        const programTemplateId = String(inputArguments[0].value)
        const properties = toProperties(inputArguments[1])
        const jobId = String(inputArguments[2].value)
        const taskId = String(inputArguments[3].value)
        const samples = toSampleInfos(inputArguments[4])
        const element = this.programTemplateElements.find(value => value.identifier.toLowerCase().includes(programTemplateId.toLowerCase()))
        const action = getAction(element)
        const samplesFound = this.findSamples(samples)
        const compartmemtProperty = findProperty("Compartment", properties)
        const compartment = this.findCompartment(compartmemtProperty?.value)
        if (readyToRun(element, action, samples, samplesFound, compartment)) {
            const runId = createDeviceProgramRunId(programTemplateId)
            this.runProgram(runId, element, action, compartment, properties, jobId, taskId, samples, context)
            return {
                outputArguments: [new Variant({ dataType: DataType.String, value: runId })],
                statusCode: StatusCodes.Good
            }
        } else {
            return { statusCode: StatusCodes.BadInvalidArgument }
        }
    }

    private async runProgram(runId: string, programTemplateElement: ProgramTemplateElement, action: StorageAction, compartment: Compartment, properties: LADSProperty[], jobId: string, taskId: string , samples: LADSSampleInfo[], context: ISessionContext) {
        const runTime = action == StorageAction.ReportInventory ? 500 : 10000
        const startedMilliseconds = Date.now()
        const activeProgram = this.programManager.activeProgram
        this.runningStateMachine.setState(LADSRunnnigState.Starting)
        setNumericValue(activeProgram.currentRuntime, 0)
        setNumericValue(activeProgram.estimatedRuntime, runTime)
        setStringValue(activeProgram.deviceProgramRunId, runId)

        async function updateAndSleepUntil(runTime: number): Promise<void> {
            let dt = 0
            do {
                await sleepMilliSeconds(500)
                dt = Date.now() - startedMilliseconds
                setNumericValue(activeProgram.currentRuntime, dt)
            } while(dt < runTime)
        }

        const result = createResult(this.programManager.resultSet as UAObject, runId)
        const programTemplate = programTemplateElement.programTemplate
        copyProgramTemplate(programTemplate, result.programTemplate)
        setStringValue(getDescriptionVariable(result), getStringValue(getDescriptionVariable(programTemplate)))
        setPropertiesValue(result.properties, action == StorageAction.ReportInventory ? [] : properties)
        setStringValue(result.supervisoryJobId, jobId)
        setStringValue(result.supervisoryTaskId, taskId)
        setSamplesValue(result.samples, action == StorageAction.ReportInventory ? [] : samples)
        setStringValue(result.deviceProgramRunId, runId)
        setDateTimeValue(result.started, new Date())
        setSessionInformation(result, context)
        AFODictionary.addDefaultResultReferences(result)
        AFODictionary.addReferences(result, ...dictionaryIds(action))
        
        this.runningStateMachine.setState(LADSRunnnigState.Execute)
        const identifier = programTemplateElement.identifier
        if (action == StorageAction.ReportInventory) {
            this.documentInventory(result, identifier)
            await updateAndSleepUntil(runTime)
        } else {
            // open door
            await this.door.coverState.open.execute(this.door, [], context)
            // wait
            await updateAndSleepUntil(0.5 * runTime)
            // handle samples
            const events: StorageEvents = action == StorageAction.CheckOut ? this.checkOut(samples) : action == StorageAction.CheckIn ? this.checkIn(compartment, samples) : []
            this.documentTransactions(result, identifier, action, events)
            // wait
            await updateAndSleepUntil(runTime)
            // close door
            await this.door.coverState.close.execute(this.door, [], context)
        }
        this.runningStateMachine.setState(LADSRunnnigState.Completing)
        this.runningStateMachine.setState(LADSRunnnigState.Complete)
        setDateTimeValue(result.stopped, new Date())
        this.runningStateMachine.setState(LADSRunnnigState.Idle)
    }

    private documentEvents(result: LADSResult, identifier: string, action: StorageAction, events: StorageEvents) {
        const variableSet = result.variableSet
        const namespace = variableSet.namespace
        events.filter(storageEvent => storageEvent.action == action).forEach((filteredEvent, index) => {
            const name = `${identifier} #${index + 1}`
            const event = namespace.addObject({
                componentOf: variableSet,
                browseName: name.replaceAll(" ", ""),
                displayName: name
            })
            addStringVariable(event, "Compartment", filteredEvent.compartmentName)
            addSampleInfoVariable(event, "Sample", filteredEvent.sampleInfo)
        })
    }

    private createReport(result: LADSResult, identifier: string, action: StorageAction, compartmentReports: CompartmentReport[]) {
        const variableSet = result.variableSet
        const currentTemperatureVariable = this.temperatureController.currentValue
        const currentTemperature = getNumericValue(currentTemperatureVariable)
        const euInformation = getEUInformation(currentTemperatureVariable)
        const temperature = addAnalogUnitRangeBasedOn(variableSet, "Temperature", currentTemperatureVariable)
        AFODictionary.addReferences(temperature, AFODictionaryIds.compartment_temperature)
        const storageReport: StorageReport = {
            programTemplate: identifier,
            storage: this.storage.cabinet.getDisplayName(),
            timestamp: new Date().toISOString(),
            temperature: currentTemperature,
            temperatureEU: {
                namespaceUri: euInformation.namespaceUri,
                unitId: euInformation.unitId,
                displayName: euInformation.displayName.text,
                description: euInformation.description.text
            },
            compartments: compartmentReports
        }

        try {
            const report = addStringVariable(variableSet, "Report", JSON.stringify(storageReport, null, 2))
            AFODictionary.addReferences(report, AFODictionaryIds.report, ...dictionaryIds(action))
        }
        catch {
            console.debug("Unable to create report!")
        }
    }

    private documentInventory(result: LADSResult, identifier: string) {
        const compartmentReports = this.storage.compartments.map(compartment => {
            const report: CompartmentReport = {
                compartment: compartment.getDisplayName(),
                samples: getSampleInfos(compartment.samples)
            }
            return report
        })
        this.createReport(result, identifier, StorageAction.ReportInventory, compartmentReports)
    }

    private documentTransactions(result: LADSResult, identifier: string, action: StorageAction, events: StorageEvents) {
        const compartmentReports: CompartmentReport[] = []
        const filteredEvents = events.filter(storageEvent => storageEvent.action == action)
        filteredEvents.forEach(ev => {
            let compartment = compartmentReports.find(item => item.compartment == ev.compartmentName)
            if (!compartment) {
                compartment = { compartment: ev.compartmentName, samples: []}
                compartmentReports.push(compartment)
            }
            compartment.samples.push(ev.sampleInfo)
        })
        this.createReport(result, identifier, action, compartmentReports)
    }


}
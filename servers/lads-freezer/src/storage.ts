import { LADSAnalogControlFunction, LADSCoverFunction, LADSProgramManager, LADSProperty, LADSResult, LADSSampleInfo } from "@interfaces"
import { FreezerDeviceImpl } from "./device"
import { UAComponent } from "node-opcua-nodeset-di"
import { CallMethodResultOptions, DataType, ISessionContext, StatusCodes, UAObject, UAProperty, UAVariable, Variant, VariantLike, VariantOptions } from "node-opcua"
import { addAnalogUnitRangeBasedOn, addProgramTemplate, addSampleInfoVariable, addStringVariable, copyProgramTemplate, createDeviceProgramRunId, createResult, createSamplesValue, EventSeverity, getDescriptionVariable, getStringValue, ProgramTemplateElement, raiseEvent, setDateTimeValue, setNumericValue, setPropertiesValue, setSamplesValue, setSessionInformation, setStringValue, sleepMilliSeconds } from "@utils"


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



enum StorageAction {Unknown, CheckIn, CheckOut}

interface StorageEvent {
    action: StorageAction
    compartmentName: string
    sampleInfo: LADSSampleInfo
}
type StorageEvents = StorageEvent[]

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
        const addressSpace = device.addressSpace
        const nameSpace = device.namespace
        const nameSpaceLADS = addressSpace.getNamespace('http://opcfoundation.org/UA/LADS/')
        const sampleInfoType = nameSpaceLADS.findDataType("SampleInfoType")
        this.cabinet = nameSpace.addObject({
            componentOf: device,
            browseName: "Cabinet",
            eventSourceOf: device
        })
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
            compartment.namespace.addVariable({
                propertyOf: compartment,
                browseName: "Samples",
                dataType: sampleInfoType,
                valueRank: 1,
                value: createSamplesValue(addressSpace, sampleInfos)

            })
            this.compartments.push(compartment as Compartment)
        }        
    }
}

class ProgramManagerImpl {
    storage: StorageImpl
    programTemplateElements: ProgramTemplateElement[] = []
    door: LADSCoverFunction
    temperatureController: LADSAnalogControlFunction
    programManager: LADSProgramManager
    isRunning: boolean = false
    started = 0

    constructor(storage: StorageImpl) {
        this.storage = storage
        const unit = storage.deviceImpl.freezerUnit
        const functionalUnit = unit.functionalUnit
        this.programManager = functionalUnit.programManager
        if (!this.programManager) {
            console.debug("Storage requires ProgramManager")
            return
        }
        const programTemplates = this.programManager.programTemplateSet as UAObject
        const date = new Date("2026-09-08T12:00:00.000Z")
        const author = "M. Arnold, AixEngineers"
        this.programTemplateElements.push(addProgramTemplate(programTemplates, {
            identifier: "Check-out",
            description: "Checks-out samples with sample-ids provided by the samples list argument.",
            created: date,
            modified: date,
            author: author
        }))
        this.programTemplateElements.push(addProgramTemplate(programTemplates, {
            identifier: "Check-in",
            description: "Checks-in samples provided by the samples list argument. The targeted sample compartment should be provided in the properties list with key-value 'Compartment': <CompartmentName>'.",
            created: date,
            modified: date,
            author: author
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

    private findCompartment(compartmentName: string): Compartment | undefined {
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
        if (this.isRunning) return { statusCode: StatusCodes.BadInvalidState }
        const programTemplateId = String(inputArguments[0].value)
        const properties = toProperties(inputArguments[1])
        const jobId = String(inputArguments[2].value)
        const taskId = String(inputArguments[3].value)
        const samples = toSampleInfos(inputArguments[4])
        const programTemplate = this.programTemplateElements.find(value => value.identifier.toLowerCase().includes(programTemplateId.toLowerCase()))
        const action = programTemplate == undefined ? StorageAction.Unknown : programTemplate.identifier == "Check-in" ? StorageAction.CheckIn : StorageAction.CheckOut
        const foundSamples = this.findSamples(samples)
        const compartmemtProperty = findProperty("Compartment", properties)
        const compartment = this.findCompartment(compartmemtProperty?.value)
        const hasSamples = action == StorageAction.CheckIn ? (samples.length > 0) && (foundSamples.length == 0) : StorageAction.CheckOut ? (foundSamples.length > 0) && compartment : false
        if (programTemplate && hasSamples) {
            const runId = createDeviceProgramRunId(programTemplateId)
            this.runProgram(runId, programTemplate, action, compartment, properties, jobId, taskId, samples, context)
            return {
                outputArguments: [new Variant({ dataType: DataType.String, value: runId })],
                statusCode: StatusCodes.Good
            }
        } else {
            return { statusCode: StatusCodes.BadInvalidArgument }
        }
    }

    private async runProgram(runId: string, programTemplateElement: ProgramTemplateElement, action: StorageAction, compartment: Compartment, properties: LADSProperty[], jobId: string, taskId: string , samples: LADSSampleInfo[], context: ISessionContext) {
        const runTime = 10000
        const startedMilliseconds = Date.now()
        const activeProgram = this.programManager.activeProgram
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
        setPropertiesValue(result.properties, properties)
        setStringValue(result.supervisoryJobId, jobId)
        setStringValue(result.supervisoryTaskId, taskId)
        setSamplesValue(result.samples, samples)
        setStringValue(result.deviceProgramRunId, runId)
        setDateTimeValue(result.started, new Date())
        setSessionInformation(result, context)
        
        // open door
        await this.door.coverState.open.execute(this.door, [], context)
        // wait
        await updateAndSleepUntil(0.5 * runTime)
        // handle samples
        const events: StorageEvents = action == StorageAction.CheckOut ? this.checkOut(samples) : action == StorageAction.CheckIn ? this.checkIn(compartment, samples) : []
        this.documentEvents(result, programTemplateElement.identifier, action, events)
        if (events.length > 0) {
            addAnalogUnitRangeBasedOn(result.variableSet, "Temperature", this.temperatureController.currentValue)
        }
        // wait
        await updateAndSleepUntil(runTime)
        // close door
        await this.door.coverState.close.execute(this.door, [], context)
        setDateTimeValue(result.stopped, new Date())
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




}
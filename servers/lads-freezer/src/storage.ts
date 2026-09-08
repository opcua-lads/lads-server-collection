import { LADSCoverFunction, LADSProgramManager, LADSProgramTemplate, LADSProperty, LADSResult, LADSSampleInfo } from "@interfaces"
import { FreezerDeviceImpl } from "./device"
import { UAComponent } from "node-opcua-nodeset-di"
import { CallMethodResultOptions, DataType, ISessionContext, StatusCodes, UAObject, UAProperty, UAVariable, Variant, VariantLike, VariantOptions } from "node-opcua"
import { addProgramTemplate, copyProgramTemplate, createDeviceProgramRunId, createResult, createSamplesValue, initComponent, ProgramTemplateElement, raiseEvent, setDateTimeValue, setNumericValue, setPropertiesValue, setSamplesValue, setStringValue, sleepMilliSeconds } from "@utils"


interface Compartment extends UAComponent {
    samples: UAProperty<any, DataType.ExtensionObject>
}

function pad(n: number, m: number): string {
    return n.toString().padStart(m, "0");
}

export function toSampleInfos(variant: VariantOptions): LADSSampleInfo[] {
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


enum StorageActions {Unknown, CheckIn, CheckOut}

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
        this.door = functionalUnit.functionSet.door
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
        return undefined
    }

    private findSamples(sampleInfos: LADSSampleInfo[]): LADSSampleInfo[] {
        const foundSamples: LADSSampleInfo[] = []
        sampleInfos.forEach(sampleInfo => {
            const [found, _] = this.findSample(sampleInfo.sampleId)
            if (found) foundSamples.push(found)
        })
        return foundSamples
    }

    private checkOut(sampleInfos: LADSSampleInfo[]) {
        const checkedOutSamples: LADSSampleInfo[] = []
        for (const sampleInfo of sampleInfos) {
            const [sample, compartment] = this.findSample(sampleInfo.sampleId)
            if (compartment) {
                const samples = getSampleInfos(compartment.samples)
                const remainingSamples = samples.filter(sample => sample.sampleId != sampleInfo.sampleId)
                setSamplesValue(compartment.samples, remainingSamples)
                raiseEvent(this.storage.cabinet, `Removed sample with sample-id ${sampleInfo.sampleId} from compartment ${compartment.getDisplayName()}.`)
                checkedOutSamples.push(sample)
            }
        }
    }

    private async startProgram(inputArguments: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {

        // if (!this.isAccessibleBy(context)) return {statusCode: StatusCodes.BadLocked }
        if (this.isRunning) return { statusCode: StatusCodes.BadInvalidState }
        const programTemplateId: string = inputArguments[0].value
        const properties = Array(inputArguments[1].value) as LADSProperty[]
        const jobId = String(inputArguments[2].value)
        const taskId = String(inputArguments[3].value)
        const samples = toSampleInfos(inputArguments[4])
        const programTemplate = this.programTemplateElements.find(value => value.identifier.toLowerCase().includes(programTemplateId.toLowerCase()))
        const action = programTemplate == undefined ? StorageActions.Unknown : programTemplate.identifier == "Check-in" ? StorageActions.CheckIn : StorageActions.CheckOut
        const foundSamples = this.findSamples(samples)
        const hasSamples = action == StorageActions.CheckIn ? (samples.length > 0) && (foundSamples.length == 0) : StorageActions.CheckOut ? (foundSamples.length > 0) : false
        if (programTemplate && hasSamples) {
            const runId = createDeviceProgramRunId(programTemplateId)
            this.runProgram(runId, programTemplate.programTemplate, action, properties, jobId, taskId, samples, context)
            return {
                outputArguments: [new Variant({ dataType: DataType.String, value: runId })],
                statusCode: StatusCodes.Good
            }
        } else {
            return { statusCode: StatusCodes.BadInvalidArgument }
        }
    }

    private async runProgram(runId: string, programTemplate: LADSProgramTemplate, action: StorageActions, properties: LADSProperty[], jobId: string, taskId: string , samples: LADSSampleInfo[], context: ISessionContext) {
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
        copyProgramTemplate(programTemplate, result.programTemplate)
        //setPropertiesValue(result.properties, properties)
        setStringValue(result.supervisoryJobId, jobId)
        setStringValue(result.supervisoryTaskId, taskId)
        setSamplesValue(result.samples, samples)
        setStringValue(result.deviceProgramRunId, runId)
        setDateTimeValue(result.started, new Date())
        
        // open door
        await this.door.coverState.open.execute(this.door, [], context)
        // wait
        await updateAndSleepUntil(0.5 * runTime)
        // handle samples 
        if (action === StorageActions.CheckOut) {
            const checkedOutSamples = this.checkOut(samples)
        }
        // wait
        await updateAndSleepUntil(runTime)
        // close door
        await this.door.coverState.close.execute(this.door, [], context)
        setDateTimeValue(result.stopped, new Date())

    }




}
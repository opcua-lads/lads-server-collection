// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { join } from "path"
import assert from "assert";
import {
    ApplicationType,
    CallMethodResultOptions,
    DataType,
    IAddressSpace,
    LocalizedText,
    OPCUAServer,
    ObjectTypeIds,
    ReferenceTypeIds,
    SessionContext,
    StatusCodes,
    UAEventType,
    UAMultiStateDiscrete,
    UAObject,
    UAStateMachineEx,
    Variant,
    VariantArrayType,
    VariantLike,
    coerceNodeId,
} from "node-opcua"
import { UADevice } from "node-opcua-nodeset-di"

import {
    DIObjectIds,
    LADSDeviceHelper,
    constructNameNodeIdExtensionObject,
    getChildObjects,
    getDescriptionVariable,
    getLADSObjectType,
    getLADSSupportedProperties,
    promoteToFiniteStateMachine,
    raiseEvent,
    sleepMilliSeconds,
} from "@utils"

import {
    LADSActiveProgram,
    LADSDevice,
    LADSFunctionalState,
    LADSFunctionalUnit,
    LADSMultiStateDiscreteControlFunction,
    LADSProgramTemplate,
    LADSResult,
} from "@interfaces"

//---------------------------------------------------------------
// interfaces
//---------------------------------------------------------------
interface FtNirFunctionSet extends UAObject {
    carouselController: LADSMultiStateDiscreteControlFunction
}

interface FtNirFunctionalUnit extends Omit<LADSFunctionalUnit, "functionSet"> {
    functionSet: FtNirFunctionSet
}

interface FtNirFunctionalUnitSet extends UAObject {
    ["fT-NIR-Unit"]: FtNirFunctionalUnit
}
interface FtNirDevice extends Omit<LADSDevice, "functionalUnitSet"> {
    functionalUnitSet: FtNirFunctionalUnitSet
}

//---------------------------------------------------------------
// server implmentation
//---------------------------------------------------------------
class FtNirServerImpl {
    server: OPCUAServer
    devices: FtNirDeviceImpl[] = []

    constructor(port: number = 4840) {
        // provide paths for the nodeset files
        const nodeset_path = join(__dirname, '../../../../nodesets')
        const nodeset_standard = join(nodeset_path, 'Opc.Ua.NodeSet2.xml')
        const nodeset_di = join(nodeset_path, 'Opc.Ua.DI.NodeSet2.xml')
        const nodeset_amb = join(nodeset_path, 'Opc.Ua.AMB.NodeSet2.xml')
        const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
        const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
        const nodeset_ft_nir = join(nodeset_path, 'FT-NIR.xml')

        try {
            // list of node-set files
            const node_set_filenames = [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_ft_nir,]

            // build the server object
            const uri = "LADS-FT-NIR-Server"
            this.server = new OPCUAServer({
                port: port,
                // basic information about the server
                buildInfo: {
                    manufacturerName: "AixEngineers",
                    productName: uri,
                    productUri: uri,
                    softwareVersion: "1.0.0",
                },
                serverInfo: {
                    applicationName: "LADS FT-NIR",
                    applicationType: ApplicationType.Server,
                    productUri: uri,
                    applicationUri: uri,

                },
                // nodesets used by the server
                nodeset_filename: node_set_filenames,
            })

        }
        catch (err) {
            console.log(err)
        }
    }

    async start() {
        
        // get objects
        await this.server.start()
        const addressSpace = this.server.engine.addressSpace
        const nameSpaceDI = addressSpace.getNamespace('http://opcfoundation.org/UA/DI/')
        const nameSpaceFtNir = addressSpace.getNamespace("http://aixengineers.de/FT-NIR/")
        assert(nameSpaceFtNir)
        const deviceType = nameSpaceFtNir.findObjectType("FT-NIR-DeviceType")
        assert(deviceType)
        const deviceSet = <UAObject>addressSpace.findNode(coerceNodeId(DIObjectIds.deviceSet, nameSpaceDI.index))
        assert(deviceSet)
        const devices = <UADevice[]>getChildObjects(deviceSet)
        devices.forEach((device) => {
            if (device.typeDefinitionObj.isSubtypeOf(deviceType)) {
                this.devices.push(new FtNirDeviceImpl(<FtNirDevice>device))
            }
        })

        // finalize start
        const endpoint = this.server.endpoints[0].endpointDescriptions()[0].endpointUrl;
        console.log(this.server.buildInfo.productName, "is ready on", endpoint);
        console.log("CTRL+C to stop");
    }
}

//---------------------------------------------------------------
// device implmentation
//---------------------------------------------------------------
class FtNirDeviceImpl {
    addressSpace: IAddressSpace
    baseEventType: UAEventType
    device: FtNirDevice
    functionalUnit: FtNirFunctionalUnit
    functionalUnitState: UAStateMachineEx
    carouselContoller: LADSMultiStateDiscreteControlFunction
    programTemplates: LADSProgramTemplate[] = []
    activeProgram: LADSActiveProgram
    results: LADSResult[] = []
    runId: number = -1

    constructor(device: FtNirDevice) {
        this.device = device
        console.log(`Initializing FT-NIR device ${this.device.getDisplayName()}..`)
        this.addressSpace = this.device.addressSpace
        this.baseEventType = this.addressSpace.findEventType(coerceNodeId(ObjectTypeIds.BaseEventType))
        this.functionalUnit = this.device.functionalUnitSet["fT-NIR-Unit"]
        assert(this.functionalUnit)
        this.carouselContoller = this.functionalUnit.functionSet.carouselController
        assert(this.carouselContoller)
        this.activeProgram = this.functionalUnit.programManager.activeProgram
        assert(this.activeProgram)
        this.programTemplates = <LADSProgramTemplate[]>getChildObjects(this.functionalUnit.programManager.programTemplateSet as UAObject)
        assert(this.programTemplates)
        this.results = <LADSResult[]><unknown>getChildObjects(this.functionalUnit.programManager.resultSet as UAObject)
        assert(this.results)

        // initialize device
        const deviceHelper = new LADSDeviceHelper(this.device, {initializationTime: 2000, shutdownTime: 2000, raiseEvents: true})

        // intialize functional unit
        const stateMachine = this.functionalUnit.functionalUnitState
        stateMachine.startProgram?.bindMethod(this.startProgram.bind(this))
        stateMachine.stop?.bindMethod(this.stopProgram.bind(this))
        stateMachine.abort?.bindMethod(this.abortProgram.bind(this))
        this.functionalUnitState = promoteToFiniteStateMachine(stateMachine)
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)

        // initialize program mananger
        this.initPogramTemplates()

        // initialize carousel-controller
        this.initCarouselPositionNames(this.carouselContoller.targetValue)
        this.initCarouselPositionNames(this.carouselContoller.currentValue)
        this.runCarouselController()
    }
    
    private initPogramTemplates(){
        // build some fake program templates
        const programTemplateType = getLADSObjectType(this.addressSpace, "ProgramTemplateType")
        const programTemplateSetNode = <UAObject>this.functionalUnit.programManager.programTemplateSet
        const programTemplatNames: string[] = ["Analytical Method 1", "Analytical Method 2"]
        programTemplatNames.forEach((name) => {
            const programTemplate = <LADSProgramTemplate>programTemplateType.instantiate({ 
                componentOf: programTemplateSetNode,
                browseName: name,
            })
            programTemplate.author?.setValueFromSource({dataType: DataType.String, value: "AixEngineers"})
            this.programTemplates.push(programTemplate)
        })
    }

    private async startProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        // validate current state
        const currentState = this.functionalUnitState.getCurrentState();
        if (!(currentState && (currentState.includes(LADSFunctionalState.Stopped) || currentState.includes(LADSFunctionalState.Aborted)))) {
            return { statusCode: StatusCodes.BadInvalidState }
        }

        // valdate input arguments
        for (const inputArgumentIndex in inputArguments) {
            const inputArgument = inputArguments[inputArgumentIndex];
            // TODO validate argument at position index
            const validationFailed = false
            if (validationFailed) return { statusCode: StatusCodes.BadInvalidArgument }
        }

        // initiate program run (async)
        const deviceProgramRunId = `Run-${++this.runId}`
        this.runProgram(deviceProgramRunId, inputArguments)

        // return run-Id
        return {
            outputArguments: [new Variant({ dataType: DataType.String, value: deviceProgramRunId })],
            statusCode: StatusCodes.Good
        }
    }

    private async stopProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return this.stopOrAbortProgram(LADSFunctionalState.Stopping, LADSFunctionalState.Stopped)
    }

    private async abortProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return this.stopOrAbortProgram(LADSFunctionalState.Aborting, LADSFunctionalState.Aborted)
    }

    private async stopOrAbortProgram(transitiveState: string, finalState: string) {
        const stateMachine = this.functionalUnitState
        const currentState = stateMachine.getCurrentState();
        if (!(currentState && currentState.includes(LADSFunctionalState.Running))) return { statusCode: StatusCodes.BadInvalidState }
        stateMachine.setState(transitiveState)
        sleepMilliSeconds(500).then(() => stateMachine.setState(finalState))
        return { statusCode: StatusCodes.Good }
    }

    private async runProgram(deviceProgramRunId: string, inputArguments: VariantLike[]) {
        // dynamically create an new result object in the result set and update node-version attribute
        const startedTimestamp = new Date()
        const resultType = getLADSObjectType(this.addressSpace, "ResultType")
        const resultSetNode = <UAObject>this.functionalUnit.programManager.resultSet
        const result = <LADSResult><unknown>resultType.instantiate({ 
            componentOf: resultSetNode,
            browseName: deviceProgramRunId, 
            optionals: ["SupervisoryJobId", "SupervisoryTaskId"] })
        resultSetNode.nodeVersion?.setValueFromSource({dataType: DataType.String, value: startedTimestamp.toISOString()})


        // get program template-id
        const activeProgram = this.activeProgram
        const programTemplateId: string = inputArguments[0].value
        const programTemplateSet = <UAObject>this.functionalUnit.programManager.programTemplateSet            
        const programTemplateReferences = programTemplateSet.findReferencesExAsObject(coerceNodeId(ReferenceTypeIds.Aggregates))
        const programTemplates = programTemplateReferences.map((template) => <LADSProgramTemplate>template)
        const programTemplate = programTemplates.find((template) => (template.browseName.name == programTemplateId))
        if (programTemplate) {
            const value = constructNameNodeIdExtensionObject(
                this.addressSpace,
                programTemplateId, 
                programTemplate.nodeId 
            )
            activeProgram?.currentProgramTemplate?.setValueFromSource({
                dataType: DataType.ExtensionObject, 
                value: value,
            })
        }

        // scan supported properties
        const properties = inputArguments[1]
        if (properties?.arrayType === VariantArrayType.Array) {
            const keyVariables = getLADSSupportedProperties(this.functionalUnit)
            const keyValues = properties.value as Variant[]
            keyValues?.forEach((item) =>{
                try {
                    const keyValue: {key: string, value: string} = <any>item
                    const property = keyVariables.find(keyVariable => (keyVariable.key == keyValue.key))
                    if (property) {
                        const variable = property.variable
                        const dataType = variable.dataTypeObj
                        variable.setValueFromSource({dataType: dataType.browseName.name , value: keyValue.value})
                    }
                }
                catch(err) {
                    console.log(err)
                }
            })
        }

        // scan samples
        interface SampleInfo {
            containerId: string
            sampleId: string
            position: string
            customData: string
        }
        const samples: SampleInfo[] = []
        const samplesArguments = inputArguments[4]
        if (samplesArguments.value != null ) {
            try {
                const samplesInfo = samplesArguments.value as Variant[]
                samplesInfo?.forEach((item) => {
                    const sampleInfo: SampleInfo = <any>item
                    samples.push(sampleInfo)
                })
            }
            catch(err) {
                console.log(err)
            }
        } else {
            // create fake samples
            samples.push({containerId: "4711", sampleId: "08150001", position: "1", customData: ""})
            samples.push({containerId: "4711", sampleId: "08150002", position: "2", customData: ""})
            samples.push({containerId: "4711", sampleId: "08150003", position: "4", customData: ""})
            samples.push({containerId: "4711", sampleId: "08150004", position: "8", customData: ""})
        }
        
        // set context information provided by input-arguments
        getDescriptionVariable(result).setValueFromSource({dataType: DataType.LocalizedText, value: `Run based on template ${programTemplateId}, started ${startedTimestamp.toLocaleDateString()}.`})
        result.properties?.setValueFromSource(inputArguments[1])
        result.supervisoryJobId?.setValueFromSource(inputArguments[2])
        result.supervisoryTaskId?.setValueFromSource(inputArguments[3])
        result.samples?.setValueFromSource(inputArguments[4])
        result.started?.setValueFromSource({ dataType: DataType.DateTime, value: startedTimestamp })

        // initialize active-program runtime properties
        const postionTime = 2000
        const analyzeTime = 5000
        const stepTime = postionTime + analyzeTime
        activeProgram.currentRuntime?.setValueFromSource({ dataType: DataType.Double, value: 0 })
        activeProgram.currentStepName?.setValueFromSource({ dataType: DataType.LocalizedText, value: 'Measure' })
        activeProgram.currentStepNumber?.setValueFromSource({ dataType: DataType.UInt32, value: 1 })
        activeProgram.currentStepRuntime?.setValueFromSource({ dataType: DataType.Double, value: 0 })
        activeProgram.estimatedRuntime?.setValueFromSource({ dataType: DataType.Double, value: samples.length * stepTime })
        activeProgram.estimatedStepRuntime?.setValueFromSource({ dataType: DataType.Double, value: stepTime })
        activeProgram.estimatedStepNumbers?.setValueFromSource({ dataType: DataType.UInt32, value: samples.length })
        activeProgram.deviceProgramRunId?.setValueFromSource({ dataType: DataType.String, value: deviceProgramRunId })

        // start analytical method
        function updateTimers(startTime: number, stepStartTime: number) {
            const t = Date.now()
            activeProgram.currentRuntime?.setValueFromSource({ dataType: DataType.Double, value: t - startTime })
            activeProgram.currentStepRuntime?.setValueFromSource({ dataType: DataType.Double, value: t - stepStartTime })
        }

        this.functionalUnitState.setState(LADSFunctionalState.Running)
        raiseEvent(this.functionalUnit, `Starting method ${programTemplateId}`)
        const startTime = Date.now()
        const controlFunctionState = promoteToFiniteStateMachine(this.carouselContoller.controlFunctionState)
        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i]
            const stepStartTime = Date.now()

            const stepName = `Analyzing sample ${sample.sampleId}`
            raiseEvent(this.functionalUnit, stepName)
            activeProgram.currentStepName?.setValueFromSource({ dataType: DataType.LocalizedText, value: stepName })
            activeProgram.currentStepNumber?.setValueFromSource({ dataType: DataType.UInt32, value: i + 1 })

            // get sample
            raiseEvent(this.functionalUnit, `Getting sample ${sample.sampleId} at position ${sample.position}`)
            const position = Number(sample.position) - 1
            this.carouselContoller.targetValue.setValueFromSource({dataType: DataType.UInt32, value: position>=0?position:0})
            do {
                await sleepMilliSeconds(500)
                updateTimers(startTime, stepStartTime)
            } while (controlFunctionState.getCurrentState().includes(LADSFunctionalState.Running))
         
            // do measurements
            raiseEvent(this.functionalUnit, `Measuring sample ${sample.sampleId}`)
            const analysisFinished = Date.now() + analyzeTime
            do {
                await sleepMilliSeconds(100)
                updateTimers(startTime, stepStartTime)
            } while (Date.now() < analysisFinished)

            // calculate reults
            const namespace = this.device.namespace
            const sampleObject = namespace.addObject({
                componentOf: result.variableSet,
                browseName: `Sample ${sample.sampleId}`
            })
            const resultNames = ["Result A", "Result B"]
            resultNames.forEach((name) => {
                const sampleResult = namespace.addVariable({
                    propertyOf: sampleObject,
                    browseName: name,
                    dataType: DataType.Double,
                    value: {dataType: DataType.Double, value: 10 * Math.random()}
                })    
            })

            // check if run was stopped or aborted from remote
            const currentState  = this.functionalUnitState.getCurrentState()
            if (currentState && !currentState.includes(LADSFunctionalState.Running)) { 
                raiseEvent(this.device, `Method ${programTemplateId} aborted`)
                break 
            }
        }
        // finalize
        raiseEvent(this.functionalUnit, `Finalizing method ${programTemplateId}`)
        result.stopped?.setValueFromSource({ dataType: DataType.DateTime, value: new Date() })
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)
    }

    private initCarouselPositionNames(variable: UAMultiStateDiscrete<number, DataType.UInt32>) {
        const dimension = variable.enumStrings.arrayDimensions[0]
        const names = Array<LocalizedText>(dimension).fill(new LocalizedText({text: ""})).map((value, index) => { 
            return new LocalizedText({text: `Position ${index + 1}`})
        })
        variable.enumStrings.setValueFromSource({dataType: DataType.LocalizedText, value: names})
    }

    private async runCarouselController() {
        const stateMachine = promoteToFiniteStateMachine(this.carouselContoller.controlFunctionState)
        const targetValue = this.carouselContoller.targetValue
        const currentValue = this.carouselContoller.currentValue
        const stateNames = currentValue.enumStrings.readValue().value.value
        const timerInterval = 500
        stateMachine.setState(LADSFunctionalState.Stopped)    
        const timer = setInterval(() => {
            const state = stateMachine.getCurrentState()
            const i = currentValue.readValue().value.value
            const j = targetValue.readValue().value.value
            if ((state.includes(LADSFunctionalState.Stopped)) && (i != j)) {
                try {
                    raiseEvent(this.carouselContoller, `Carousel moving from ${stateNames[i].text} to ${stateNames[j].text}.`)
                }
                catch(err) {}
                stateMachine.setState(LADSFunctionalState.Running)
            }
            if ((state.includes(LADSFunctionalState.Running)) && (i == j)) {
                try {
                    raiseEvent(this.carouselContoller, `Carousel moved to ${stateNames[j].text}.`)
                }
                catch(err) {}
                stateMachine.setState(LADSFunctionalState.Stopped)
                currentValue.setValueFromSource({dataType: DataType.UInt32, value: j}, StatusCodes.Good)
            }
            if (i != j) {
                const k = i<j?i+1:i-1
                currentValue.setValueFromSource({dataType: DataType.UInt32, value: k}, StatusCodes.GoodDependentValueChanged)
            }
        }, timerInterval)    
    }

}

export async function main() {
    const server = new FtNirServerImpl(12345)
    await server.start()
}

// main()

// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Viscometer
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

import { AccessLevelFlag, CallMethodResultOptions, DataType, DataValue, LocalizedText, SessionContext, StatusCode, StatusCodes, UAObject, UAStateMachineEx, Variant, VariantArrayType, VariantLike } from "node-opcua"
import { ViscometerFunctionalUnit } from "./interfaces"
import { ViscometerModelParameters, ViscometerModels, ViscometerSpindleParameters, ViscometerSpindles, ViscometerDeviceImpl } from "./device"
import { LADSActiveProgram, LADSFunctionalState, LADSProgramTemplate, LADSResult, LADSSampleInfo } from "@interfaces"
import { AFODictionary, AFODictionaryIds } from "@afo"
import { RheometryRecorderOptions, RheometryRecorder } from "@asm"
import { raiseEvent, promoteToFiniteStateMachine, getChildObjects, getLADSObjectType, getDescriptionVariable, sleepMilliSeconds, touchNodes, getLADSSupportedProperties, VariableDataRecorder, EventDataRecorder, DataExporter, copyProgramTemplate, setNumericValue, setStringArrayValue, setStringValue, setDateTimeValue, setNameNodeIdValue, setSessionInformation } from "@utils"
import { join } from "path"
import { ViscometerProgram, loadViscometerProgramsFromDirectory, DataDirectory, DefaultViscometerPrograms } from "./programs"
import { TemperatureControllerImpl } from "./temperature-controller"
import { ViscometerControllerImpl } from "./viscometer-controller"
import { DeviceOptions } from "./server"


//---------------------------------------------------------------
// functional unit implementation
//---------------------------------------------------------------
export class ViscometerUnitImpl {
    parent: ViscometerDeviceImpl
    model: ViscometerModelParameters
    spindle: ViscometerSpindleParameters
    functionalUnit: ViscometerFunctionalUnit
    functionalUnitState: UAStateMachineEx
    temperatureController: TemperatureControllerImpl
    viscometerController: ViscometerControllerImpl

    // program manager
    viscometerPrograms: ViscometerProgram[]
    programTemplates: LADSProgramTemplate[] = []
    activeProgram: LADSActiveProgram
    results: LADSResult[] = []

    constructor(parent: ViscometerDeviceImpl, functionalUnit: ViscometerFunctionalUnit, options: DeviceOptions) {
        this.parent = parent
        this.functionalUnit = functionalUnit

        // set model
        this.model = ViscometerModels[0]
        // initialize spindle list
        this.initSpindle()

        // intialize speed controller
        this.viscometerController = new ViscometerControllerImpl(this, options.viscometerController, parent.device.components.viscometer)
        // intialize temperature controller
        this.temperatureController = new TemperatureControllerImpl(this, options.temperatureController, parent.device.components.temperatureController)

        // add Allotrope Ontology References
        AFODictionary.addReferences(this.functionalUnit, AFODictionaryIds.measurement_device, AFODictionaryIds.rheometry, AFODictionaryIds.viscometry)

        // future - initialize program mananger
        this.initProgramManager()
    }

    // viscometer system
    private startViscometer(): StatusCode {
        const currentState = this.functionalUnitState.getCurrentState();
        if (!(currentState && (currentState.includes(LADSFunctionalState.Stopped) || currentState.includes(LADSFunctionalState.Aborted)))) {
            return StatusCodes.BadInvalidState
        }
        this.functionalUnitState.setState(LADSFunctionalState.Running)
        this.viscometerController.start()
        this.temperatureController.start()
        raiseEvent(this.functionalUnit, `Viscometer started with speed set-point ${this.viscometerController.speedControlFunction.targetValue.readValue().value.value}rpm`)
        return StatusCodes.Good
    }

    private stopViscometer(): StatusCode {  
        const currentState = this.functionalUnitState.getCurrentState();
        if (!(currentState && currentState.includes(LADSFunctionalState.Running))) {
            return StatusCodes.BadInvalidState
        }
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)
        this.viscometerController.stop()
        this.temperatureController.stop()
        raiseEvent(this.functionalUnit, "Viscometer stopped")
        return StatusCodes.Good
    }

    // spindle
    private initSpindle() {
        const names = ViscometerSpindles.map(spindle => new LocalizedText({text: spindle.name}) )
        const codes = ViscometerSpindles.map(spindle => new LocalizedText({text: (spindle.code < 10)?`0${spindle.code}`:`${spindle.code}`}))
        const spindle = this.functionalUnit.functionSet.spindle
        setStringArrayValue(spindle.targetValue.enumStrings, names)
        setStringArrayValue(spindle.currentValue.enumStrings, codes)
        const index = ViscometerSpindles.findIndex(spindle => (spindle.name == "SC4-31"))
        const value = index >= 0?index:0
        spindle.targetValue.on("value_changed", this.setCurrentSpindle.bind(this))
        setNumericValue(spindle.targetValue, value)
    }

    private setCurrentSpindle(dataValue: DataValue) {
        const index = Number(dataValue.value.value)
        setNumericValue(this.functionalUnit.functionSet.spindle.currentValue, index)
        this.spindle = ViscometerSpindles[index]
        raiseEvent(this.functionalUnit, `Spindle changed to type ${this.spindle.name} w/ code ${this.spindle.code}`)
    }
    
    //---------------------------------------------------------------
    // program manager implementation
    //---------------------------------------------------------------
    private initProgramManager() {
        const stateMachine = this.functionalUnit.functionalUnitState
        stateMachine.startProgram?.bindMethod(this.startProgram.bind(this))
        stateMachine.stop?.bindMethod(this.stopProgram.bind(this))
        stateMachine.abort?.bindMethod(this.abortProgram.bind(this))
        this.functionalUnitState = promoteToFiniteStateMachine(stateMachine)
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)
        this.activeProgram = this.functionalUnit.programManager?.activeProgram
        this.programTemplates = <LADSProgramTemplate[]>getChildObjects(this.functionalUnit.programManager?.programTemplateSet as UAObject)
        this.results = <LADSResult[]><unknown>getChildObjects(this.functionalUnit.programManager?.resultSet as UAObject)
        this.initProgramTemplates()
    }

    private async initProgramTemplates(){
        // build some fake program templates
        const programTemplateType = getLADSObjectType(this.parent.addressSpace, "ProgramTemplateType")
        const programTemplateSetNode = <UAObject>this.functionalUnit.programManager?.programTemplateSet
        if (!programTemplateSetNode) return
        const loadedViscometerPrograms = await loadViscometerProgramsFromDirectory(join(DataDirectory, "programs"))
        this.viscometerPrograms = loadedViscometerPrograms.length > 0?loadedViscometerPrograms:DefaultViscometerPrograms
        const programTemplateNames: string[] = this.viscometerPrograms.map(value => {return value.name})
        programTemplateNames.forEach((name, index) => {
            const programTemplate = <LADSProgramTemplate>programTemplateType.instantiate({ 
                componentOf: programTemplateSetNode,
                browseName: name,
            })
            const viscometerProgram = this.viscometerPrograms[index]
            const description = getDescriptionVariable(programTemplate)
            this.programTemplates.push(programTemplate)
            setStringValue(programTemplate.author, viscometerProgram.author)
            setStringValue(programTemplate.deviceTemplateId, name)
            setStringValue(description, viscometerProgram.description)
            viscometerProgram.created?setDateTimeValue(programTemplate.created, new Date(viscometerProgram.created)):0
            viscometerProgram.modified?setDateTimeValue(programTemplate.modified, new Date(viscometerProgram.modified)):0
            viscometerProgram.version?setStringValue(programTemplate.version, viscometerProgram.version):0

            // Allotrope Foundation Ontology
            AFODictionary.addDefaultProgramTemplateReferences(programTemplate)
            AFODictionary.addReferences(programTemplate, AFODictionaryIds.measurement_method, AFODictionaryIds.rheometry, AFODictionaryIds.viscometry)
        })
    }

    private async startProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        // validate current state
        const currentState = this.functionalUnitState.getCurrentState();
        if (!(currentState && (currentState.includes(LADSFunctionalState.Stopped) || currentState.includes(LADSFunctionalState.Aborted)))) {
            return { statusCode: StatusCodes.BadInvalidState }
        }

        // valdate input arguments
        const template = this.findProgramTemplate(inputArguments[0].value)
        const programTemplate = template?template:this.programTemplates[0]
        const programTemplateId = programTemplate.browseName.name
        const startedTimestamp = new Date()
        const iso = startedTimestamp.toISOString()
        const date = iso.slice(0, 10).replace(/-/g, "")
        const time = iso.slice(11, 19).replace(/:/g, "")
        const deviceProgramRunId = `${date}-${time}-${programTemplateId.replace(/[ (),°]/g,"")}`

        // initiate program run (async)
        this.runProgram(deviceProgramRunId, startedTimestamp, inputArguments, context)

        // return run-Id
        return {
            outputArguments: [new Variant({ dataType: DataType.String, value: deviceProgramRunId })],
            statusCode: StatusCodes.Good
        }
    }

    private findProgramTemplate(name: string): LADSProgramTemplate {
        const programTemplate = this.programTemplates.find((template) => (template.browseName.name == name))
        return programTemplate
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

    private async runProgram(deviceProgramRunId: string, startedTimestamp: Date, inputArguments: VariantLike[], context: SessionContext) {
        // dynamically create an new result object in the result set and update node-version attribute
        const resultType = getLADSObjectType(this.parent.addressSpace, "ResultType")
        const resultSetNode = <UAObject>this.functionalUnit.programManager.resultSet
        const result = <LADSResult><unknown>resultType.instantiate({ 
            componentOf: resultSetNode,
            browseName: deviceProgramRunId, 
            optionals: ["NodeVersion", "VariableSet.NodeVersion", "FileSet.NodeVersion"] 
        })
        touchNodes(resultSetNode)

        // get program template-id
        const activeProgram = this.activeProgram
        const programTemplateId: string = inputArguments[0].value
        const programTemplate = this.findProgramTemplate(programTemplateId)
        if (programTemplate) {
            setNameNodeIdValue(activeProgram?.currentProgramTemplate, programTemplateId, programTemplate.nodeId)
        }
        const program: ViscometerProgram = programTemplate?this.viscometerPrograms.find((program) => (programTemplate.browseName.name.includes(program.name))):this.viscometerPrograms[0]

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
                        setStringValue(variable, keyValue.value)
                    }
                }
                catch(err) {
                    console.log(err)
                }
            })
        }

        // scan samples
        const samples: LADSSampleInfo[] = []
        const samplesArguments = inputArguments[4]
        if (samplesArguments.value != null ) {
            try {
                const samplesInfo = samplesArguments.value as Variant[]
                samplesInfo?.forEach((item) => {
                    const sampleInfo: LADSSampleInfo = <any>item
                    samples.push(sampleInfo)
                })
            }
            catch(err) {
                console.log(err)
            }
        } else {
            // create fake samples
            samples.push({containerId: "4711", sampleId: "08150001", position: "1", customData: ""})
        }
        
        // set context information provided by input-arguments
        setSessionInformation(result, context)
        setStringValue(getDescriptionVariable(result), `Run based on template ${programTemplateId}, started ${startedTimestamp.toLocaleDateString()}.`)
        result.properties?.setValueFromSource(inputArguments[1])
        result.supervisoryJobId?.setValueFromSource(inputArguments[2])
        result.supervisoryTaskId?.setValueFromSource(inputArguments[3])
        result.samples?.setValueFromSource(inputArguments[4])
        setDateTimeValue(result.started, startedTimestamp )
        copyProgramTemplate(programTemplate, result.programTemplate)

        // Allotrope Foundation Ontology
        AFODictionary.addDefaultResultReferences(result)
        AFODictionary.addReferences(result, AFODictionaryIds.rheometry, AFODictionaryIds.viscometry)
        AFODictionary.addReferences(result.programTemplate, AFODictionaryIds.rheometry, AFODictionaryIds.viscometry)

        // initialize active-program runtime properties
        const steps = program.steps
        const estimatedRuntime = steps.reduce((time, step) => time + step.dt, 0)
        setNumericValue(activeProgram.currentRuntime, 0)
        setNumericValue(activeProgram.estimatedRuntime, estimatedRuntime )
        setNumericValue(activeProgram.estimatedStepNumbers, steps.length )
        setStringValue(activeProgram.deviceProgramRunId, deviceProgramRunId )

        // create recorders
        const viscometer = this.viscometerController
        const endPointRecorder = new VariableDataRecorder("End-points", [
            activeProgram.currentStepName, viscometer.temperature.sensorValue, viscometer.viscosity.sensorValue, viscometer.shearStress.sensorValue, viscometer.shearRate.sensorValue, 
            viscometer.relativeTorque.sensorValue, viscometer.torque.sensorValue, viscometer.speedControlFunction.currentValue, this.temperatureController.temperatureControlFunction.currentValue
        ])
        const trendRecorder = new VariableDataRecorder("Trends", [viscometer.temperature.sensorValue, viscometer.viscosity.sensorValue, ])
        const trendRecorderInterval = setInterval(() => {trendRecorder.createRecord()}, 1000)
        const eventRecorder = new EventDataRecorder("Events", this.functionalUnit)

        const rheometryRecorderOptions: RheometryRecorderOptions = {
            result: result,
            devices: [{deviceType: "Viscometer", device: this.parent.device}],
            runtime: this.activeProgram.currentRuntime,
            stepRuntime: this.activeProgram.currentStepRuntime,
            shearRate: viscometer.shearRate.sensorValue,
            shearStress: viscometer.shearStress.sensorValue,
            viscosity: viscometer.viscosity.sensorValue,
            torque: viscometer.torque.sensorValue,
            temperature: viscometer.temperature.sensorValue,
            sample: samples[0],
        }
        const rheometryRecorder = new RheometryRecorder(rheometryRecorderOptions)

        // start everything
        this.startViscometer()
        raiseEvent(this.functionalUnit, `Starting run ${deviceProgramRunId}`)
        const tsRuntime = Date.now()
        for (let index = 0; index < steps.length; index++) {
            const step = steps[index]
            raiseEvent(this.functionalUnit, `Starting step ${step.name}`)
            // set step specific information
            setStringValue(activeProgram.currentStepName, step.name)
            setNumericValue(activeProgram.currentStepNumber, index + 1)
            setNumericValue(activeProgram.currentStepRuntime, 0)
            setNumericValue(activeProgram.estimatedStepRuntime, step.dt)

            // set target-values
            setNumericValue(this.viscometerController.speedControlFunction.targetValue, step.nsp)
            setNumericValue(this.temperatureController.temperatureControlFunction.targetValue, step.tsp)

            // wait and update
            const tsStepRuntime = Date.now()
            const updateInterval = setInterval(() => { 
                const now = Date.now()
                setNumericValue(activeProgram.currentRuntime, now - tsRuntime)
                setNumericValue(activeProgram.currentStepRuntime, now - tsStepRuntime)
            }, 200)
            await sleepMilliSeconds(step.dt)
            clearInterval(updateInterval)

            // record end-points
            const endPointRecord = endPointRecorder.createRecord()
            const endPointVariables = endPointRecord.createResultVariables(step.name, result.variableSet)
            AFODictionary.addReferences(endPointVariables, AFODictionaryIds.recording)
            rheometryRecorder.createRecord()
            touchNodes(result, result.variableSet)
        
            // check if run was stopped or aborted from remote
            const currentState  = this.functionalUnitState.getCurrentState()
            if (currentState && !currentState.includes(LADSFunctionalState.Running)) { 
                raiseEvent(this.functionalUnit, `Run ${deviceProgramRunId} aborted`)
                break 
            }
        }

        // finalize
        //console.log(resultRecorder.createCSVString())
        setDateTimeValue(result.stopped, new Date())
        this.stopViscometer()
        clearInterval(trendRecorderInterval)

        // creat files
        const resultsDirectory = join(DataDirectory, "results")
        new DataExporter().writeXSLXResultFile(result.fileSet, "XLSX", resultsDirectory, deviceProgramRunId, [endPointRecorder, trendRecorder, eventRecorder])        
        const model = rheometryRecorder.createModel()
        rheometryRecorder.writeResultFile(result.fileSet, "ASM", resultsDirectory, deviceProgramRunId, model)
         
        // finally represent ASM model as JSON string in VariableSet
        const jsonModel = result.namespace.addVariable({
            componentOf: result.variableSet,
            browseName: "ASM",
            description: "Result as Allotrope Simple Model (ASM) in JSON format.",
            dataType: DataType.String,
            value: {dataType: DataType.String, value: JSON.stringify(model, null, 2)},
            accessLevel: AccessLevelFlag.CurrentRead
        })
        AFODictionary.addReferences(jsonModel, AFODictionaryIds.ASM_file, AFODictionaryIds.rheometry_aggregate_document)
        
        // update node version of resultset
        touchNodes(result, result.fileSet, result.variableSet)
    }
}

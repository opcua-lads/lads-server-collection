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

import { AccessLevelFlag, assert, CallMethodResultOptions, DataType, DataValue, LocalizedText, SessionContext, StatusCode, StatusCodes, UAObject, UAStateMachineEx, Variant, VariantArrayType, VariantLike } from "node-opcua"
import { ViscometerFunctionalUnit } from "./viscometer-interfaces"
import { ViscometerModelParameters, ViscometerModels, ViscometerSpindleParameters, ViscometerSpindles, ViscometerDeviceImpl } from "./viscometer-device"
import { LADSActiveProgram, LADSAnalogControlFunction, LADSAnalogScalarSensorFunction, LADSBaseControlFunction, LADSFunctionalState, LADSProgramTemplate, LADSResult, LADSSampleInfo } from "@interfaces"
import { AFODictionary, AFODictionaryIds } from "@afo"
import { RheometryRecorderOptions, RheometryRecorder } from "@asm"
import { raiseEvent, promoteToFiniteStateMachine, getChildObjects, getLADSObjectType, getDescriptionVariable, sleepMilliSeconds, touchNodes, getLADSSupportedProperties, VariableDataRecorder, EventDataRecorder, DataExporter, copyProgramTemplate, setNumericValue, getNumericValue, setStringArrayValue, setStringValue, setDateTimeValue, setNameNodeIdValue } from "@utils"
import { join } from "path"
import { ViscometerProgram, loadViscometerProgramsFromDirectory, DataDirectory, DefaultViscometerPrograms } from "./viscometer-programs"

//---------------------------------------------------------------
// functional unit implementation
//---------------------------------------------------------------
export abstract class ViscometerUnitImpl {
    parent: ViscometerDeviceImpl
    functionalUnit: ViscometerFunctionalUnit
    functionalUnitState: UAStateMachineEx
    speedController: LADSAnalogControlFunction
    speedControllerState: UAStateMachineEx
    temperature: LADSAnalogScalarSensorFunction
    temperatureController: LADSAnalogControlFunction
    temperatureControllerState: UAStateMachineEx
    relativeTorque: LADSAnalogScalarSensorFunction
    torque: LADSAnalogScalarSensorFunction
    viscosity: LADSAnalogScalarSensorFunction
    shearStress: LADSAnalogScalarSensorFunction
    shearRate: LADSAnalogScalarSensorFunction
    model: ViscometerModelParameters
    spindle: ViscometerSpindleParameters
    // program manager
    viscometerPrograms: ViscometerProgram[]
    programTemplates: LADSProgramTemplate[] = []
    activeProgram: LADSActiveProgram
    results: LADSResult[] = []

    constructor(parent: ViscometerDeviceImpl, functionalUnit: ViscometerFunctionalUnit) {
        this.parent = parent
        this.functionalUnit = functionalUnit
        const addressSpace = functionalUnit.addressSpace
        const functionSet = this.functionalUnit.functionSet

        // set model
        this.model = ViscometerModels[0]

        // initialize spindle list
        this.initSpindle()

        // intialize speed controller
        this.initSpeedController()

        // intialize temperature controller
        this.initTemperatureController()

        // initialize viscosity with history
        this.viscosity = functionSet.viscosity
        const viscosityValue = this.viscosity.sensorValue
        viscosityValue.historizing = true
        addressSpace.installHistoricalDataNode(viscosityValue)
        // initialize other functions
        this.relativeTorque = functionSet.relativeTorque
        this.torque = functionSet.torque
        this.shearStress = functionSet.shearStress
        this.shearRate = functionSet.shearRate
        this.temperature = functionSet.temperature
        this.temperature.sensorValue.setValueFromSource({dataType: DataType.Double, value: 25.0})

        // add Allotrope Ontology References
        AFODictionary.addReferences(this.functionalUnit, AFODictionaryIds.measurement_device, AFODictionaryIds.rheometry, AFODictionaryIds.viscometry)
        AFODictionary.addSensorFunctionReferences(this.viscosity, AFODictionaryIds.viscosity)
        AFODictionary.addSensorFunctionReferences(this.relativeTorque, AFODictionaryIds.relative_intensity)
        AFODictionary.addSensorFunctionReferences(this.torque, AFODictionaryIds.torque)
        AFODictionary.addSensorFunctionReferences(this.shearStress, AFODictionaryIds.shear_stress_of_quality)
        AFODictionary.addSensorFunctionReferences(this.shearRate, AFODictionaryIds.rate)
        AFODictionary.addSensorFunctionReferences(this.temperature, AFODictionaryIds.temperature_measurement, AFODictionaryIds.temperature)
        AFODictionary.addControlFunctionReferences(this.temperatureController, AFODictionaryIds.temperature_controller, AFODictionaryIds.temperature)
        AFODictionary.addControlFunctionReferences(this.speedController, AFODictionaryIds.rotational_speed, AFODictionaryIds.rotational_speed)

        // future - initialize program mananger
        this.initProgramManager()

        // start run loop
        const dT = 200 
        setInterval( () => {this.evaluate(dT)}, dT)
    }

    protected evaluate(dT: number) {
        this.evaluateTemperatureController(dT)
        this.evaluateSpeedController(dT)
    }

    private startController(controller: LADSBaseControlFunction, stateMachine: UAStateMachineEx, withEvent: boolean): StatusCode {
        const currentState = stateMachine.getCurrentState();
        if (currentState.includes(LADSFunctionalState.Running)) {
            return StatusCodes.BadInvalidState
        }
        stateMachine.setState(LADSFunctionalState.Running)
        if (withEvent) {
            raiseEvent(controller, `${controller.getDisplayName()} started`)
        }

    }
    
    private stopController(controller: LADSBaseControlFunction, stateMachine: UAStateMachineEx, withEvent: boolean): StatusCode {
        const currentState = stateMachine.getCurrentState();
        if (currentState.includes(LADSFunctionalState.Stopped) || currentState.includes(LADSFunctionalState.Stopping)) {
            return StatusCodes.BadInvalidState
        }
        stateMachine.setState(LADSFunctionalState.Stopped)
        if (withEvent) {
            raiseEvent(controller, `${controller.getDisplayName()} stopped`)
        }
    }
    
    // speed controller
    private initSpeedController() {
        this.speedController = this.functionalUnit.functionSet.speedController
        assert(this.speedController)
        const stateMachine = this.speedController.controlFunctionState
        stateMachine.start?.bindMethod(this.startSpeedController.bind(this))
        stateMachine.stop?.bindMethod(this.stopSpeedController.bind(this))
        this.speedControllerState = promoteToFiniteStateMachine(stateMachine)
        this.speedControllerState.setState(LADSFunctionalState.Stopped)
        setNumericValue(this.speedController.currentValue, 0.0)
        setNumericValue(this.speedController.targetValue, 30.0)
        this.speedController.targetValue.on("value_changed", (dataValue => {raiseEvent(this.speedController, `Speed set-point changed to ${dataValue.value.value}rpm`)}))
    }

    private async startSpeedController(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return { statusCode: this.startController(this.speedController, this.speedControllerState, true) }
    }

    private async stopSpeedController(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return { statusCode: this.stopController(this.speedController, this.speedControllerState, true) }
    }

    private evaluateSpeedController(dT: number) {
        function calcSpeed(sp: number, pv: number):  number {
            const delta = 0.001 * dT * 10 // 10rpm/s
            if (Math.abs(sp - pv) < delta) {
                return sp
            } else if (pv < sp) {
                return pv + delta
            } else {
                return pv - delta
            }
        }

        const running =  this.speedControllerState.getCurrentState().includes(LADSFunctionalState.Running)
        const sp = getNumericValue(this.speedController.targetValue)
        const pv = getNumericValue(this.speedController.currentValue)
        const newpv = running?calcSpeed(sp, pv):0
        setNumericValue(this.speedController.currentValue, newpv)
    }

    // temperature controller
    private initTemperatureController() {
        const controller = this.functionalUnit.functionSet.temperatureController
        assert(controller)
        this.temperatureController = controller
        const stateMachine = this.temperatureController.controlFunctionState
        stateMachine.start?.bindMethod(this.startTemperatureController.bind(this))
        stateMachine.stop?.bindMethod(this.stopTemperatureController.bind(this))
        this.temperatureControllerState = promoteToFiniteStateMachine(stateMachine)
        this.temperatureControllerState.setState(LADSFunctionalState.Stopped)
        setNumericValue(controller.currentValue, 25.0)
        controller.currentValue.historizing = true
        controller.addressSpace.installHistoricalDataNode(controller.currentValue)
        setNumericValue(controller.targetValue, 50.0)
        controller.targetValue.on("value_changed", (dataValue => {raiseEvent(this.temperatureController, `Temperature set-point changed to ${dataValue.value.value}°C`)}))
    }

    private async startTemperatureController(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return { statusCode: this.startController(this.temperatureController, this.temperatureControllerState, true) }
    }

    private async stopTemperatureController(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return { statusCode: this.stopController(this.temperatureController, this.temperatureControllerState, true) }
    }

    private evaluateTemperatureController(dT: number) {

        const running =  this.temperatureControllerState.getCurrentState().includes(LADSFunctionalState.Running)
        const sp = running?getNumericValue(this.temperatureController.targetValue):25
        const pv = getNumericValue(this.temperatureController.currentValue)
        const noise = 0.02 * (Math.random() - 0.5)
        const cf = running?dT / 2000:dT / 10000
        const newpv = (cf * sp) + (1.0 - cf) * pv + noise
        setNumericValue(this.temperatureController.currentValue, newpv)
    }

    // viscometer system
    private startViscometer(): StatusCode {
        const currentState = this.functionalUnitState.getCurrentState();
        if (!(currentState && (currentState.includes(LADSFunctionalState.Stopped) || currentState.includes(LADSFunctionalState.Aborted)))) {
            return StatusCodes.BadInvalidState
        }
        this.functionalUnitState.setState(LADSFunctionalState.Running)
        this.startController(this.speedController, this.speedControllerState, false)
        this.startController(this.temperatureController, this.temperatureControllerState, false)
        raiseEvent(this.functionalUnit, `Viscometer started with speed set-point ${this.speedController.targetValue.readValue().value.value}rpm`)
        return StatusCodes.Good
    }

    private stopViscometer(): StatusCode {  
        const currentState = this.functionalUnitState.getCurrentState();
        if (!(currentState && currentState.includes(LADSFunctionalState.Running))) {
            return StatusCodes.BadInvalidState
        }
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)
        this.stopController(this.speedController, this.speedControllerState, false)
        this.stopController(this.temperatureController, this.temperatureControllerState, false)
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
        this.runProgram(deviceProgramRunId, startedTimestamp, inputArguments)

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

    private async runProgram(deviceProgramRunId: string, startedTimestamp: Date, inputArguments: VariantLike[]) {
        // dynamically create an new result object in the result set and update node-version attribute
        const resultType = getLADSObjectType(this.parent.addressSpace, "ResultType")
        const resultSetNode = <UAObject>this.functionalUnit.programManager.resultSet
        const result = <LADSResult><unknown>resultType.instantiate({ 
            componentOf: resultSetNode,
            browseName: deviceProgramRunId, 
            optionals: ["NodeVersion", "VariableSet.NodeVersion"] 
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
        const endPointRecorder = new VariableDataRecorder("End-points", [
            activeProgram.currentStepName, this.temperature.sensorValue, this.viscosity.sensorValue, this.shearStress.sensorValue, this.shearRate.sensorValue, 
            this.relativeTorque.sensorValue, this.torque.sensorValue, this.speedController.currentValue, this.temperatureController.currentValue
        ])
        const trendRecorder = new VariableDataRecorder("Trends", [this.temperature.sensorValue, this.viscosity.sensorValue, ])
        const trendRecorderInterval = setInterval(() => {trendRecorder.createRecord()}, 1000)
        const eventRecorder = new EventDataRecorder("Events", this.functionalUnit)

        const rheometryRecorderOptions: RheometryRecorderOptions = {
            result: result,
            devices: [{deviceType: "Viscometer", device: this.parent.device}],
            runtime: this.activeProgram.currentRuntime,
            stepRuntime: this.activeProgram.currentStepRuntime,
            shearRate: this.shearRate.sensorValue,
            shearStress: this.shearStress.sensorValue,
            viscosity: this.viscosity.sensorValue,
            torque: this.torque.sensorValue,
            temperature: this.temperature.sensorValue,
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
            setNumericValue(this.speedController.targetValue, step.nsp)
            setNumericValue(this.temperatureController.targetValue, step.tsp)

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
        new DataExporter().writeXSLXResultFile(result.fileSet, "XLSX",resultsDirectory, deviceProgramRunId, [endPointRecorder, trendRecorder, eventRecorder])        
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

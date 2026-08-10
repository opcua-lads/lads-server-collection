// SPDX-FileCopyrightText: 2025-2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS AtmoWEB gateway
Copyright (C) 2025-2026  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.

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


import { CallMethodResultOptions, DataType, ISessionContext, StatusCodes, UAObject, UAStateMachineEx, VariantLike } from "node-opcua"
import { LADSProgramManager, LADSProgramTemplate, LADSResult, LADSRunnnigState } from "@interfaces"
import { copyProgramTemplate, createDeviceProgramRunId, DataExporter, EventDataRecorder, getDescriptionVariable, getLADSObjectType, raiseEvent, setDateTimeValue, setNameNodeIdValue, setNumericValue, setSessionInformation, setStringValue, touchNodes, VariableDataRecorder } from "@utils"
import { AtmoWebUnitImpl } from "./unit"
import { join } from "path"
import { AFODictionary, AFODictionaryIds } from "@afo"

const Measure = "Measure"

interface ProgramRunOptions {
    context: ISessionContext
    programTemplate: LADSProgramTemplate
    properties: VariantLike
    jobId: VariantLike
    taskId: VariantLike
    samples: VariantLike
    deviceProgramRunId: string
    result?: LADSResult
    started?: number
    stopped?: number
    eventRecorder?: EventDataRecorder
    variableRecorder?: VariableDataRecorder
    variableRecorderTimer?: NodeJS.Timeout
    progressTimer?: NodeJS.Timeout
}

export class AtmoWebProgramManagerImpl {
    unitImpl: AtmoWebUnitImpl
    runningStateMachine: UAStateMachineEx
    programManager: LADSProgramManager
    programTemplates: LADSProgramTemplate[] = []
    programRunOptions: ProgramRunOptions

    constructor(unitImpl: AtmoWebUnitImpl, data: any) {
        this.unitImpl = unitImpl
        const functionalUnit = unitImpl.unit
        this.programManager = functionalUnit.programManager

        const stateMachine = functionalUnit.functionalUnitState
        stateMachine.startProgram.bindMethod(this.startProgramMethod.bind(this))
        stateMachine.start.bindMethod(this.startMethod.bind(this))
        stateMachine.stop.bindMethod(this.stopMethod.bind(this))
        this.runningStateMachine = unitImpl.runningStateMachine

        this.initProgramTemplates(data)
    }

    initProgramTemplates(data: any) {
        const date = new Date("2025-06-01T12:00:00Z")
        const programTemplateSet = this.programManager.programTemplateSet as UAObject
        const templateNames = [Measure]
        const progs: string[] = data["ProgList"]
        if (progs) { templateNames.push(...progs) }
        const programTemplateType = getLADSObjectType(programTemplateSet.addressSpace, "ProgramTemplateType")
        templateNames.forEach((templateName, index) => {
            const description = index === 0 ? `LADS server based measurement program.` : `Device based program "${templateName}".`
            const programTemplate = programTemplateType.instantiate({
                componentOf: programTemplateSet,
                browseName: templateName,
                description: description,
            }) as LADSProgramTemplate
            setStringValue(getDescriptionVariable(programTemplate), description)
            setStringValue(programTemplate.author, "AixEngineers")
            setDateTimeValue(programTemplate.created, date)
            setDateTimeValue(programTemplate.modified, date)
            setStringValue(programTemplate.version, "1.0")
            this.programTemplates.push(programTemplate)
            AFODictionary.addReferences(programTemplate, AFODictionaryIds.measurement_method)
        })
        touchNodes(programTemplateSet)
    }

    private async startMethod(inputArguments: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        return await this.startProgramMethod([
            { dataType: DataType.String, value: "Measure" },
            { dataType: DataType.ExtensionObject, value: [] },
            { dataType: DataType.String, value: "" },
            { dataType: DataType.String, value: "" },
            { dataType: DataType.ExtensionObject, value: [] },
        ], context)
    }

    private async startProgramMethod(inputArguments: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        if (!this.unitImpl.isAccessibleBy(context)) return {statusCode: StatusCodes.BadLocked }
         const state = this.runningStateMachine.getCurrentState()
        if (!state.includes(LADSRunnnigState.Idle)) {
            return { statusCode: StatusCodes.BadInvalidState }
        }
        const programTemplate = this.programTemplates[0]
        this.programRunOptions = {
            context: context,
            programTemplate: programTemplate,
            properties: inputArguments[1],
            jobId: inputArguments[2],
            taskId: inputArguments[3],
            samples: inputArguments[4],
            deviceProgramRunId: createDeviceProgramRunId(programTemplate.browseName.name)
        }
        this.enterRunning()
        return { statusCode: StatusCodes.Good }
    }

    private async stopMethod(inputArguments: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        if (!this.unitImpl.isAccessibleBy(context)) return {statusCode: StatusCodes.BadLocked }
        const state = this.runningStateMachine.getCurrentState()
        if (!state.includes(LADSRunnnigState.Execute)) {
            return { statusCode: StatusCodes.BadInvalidState }
        }
        this.leaveRunning()
        return { statusCode: StatusCodes.Good }
    }

    private async enterRunning() {
        this.runningStateMachine.setState(LADSRunnnigState.Starting)
        const options = this.programRunOptions
        // build result
        const result = getLADSObjectType(this.programManager.addressSpace, "ResultType").instantiate({
            componentOf: this.programManager.resultSet as UAObject,
            browseName: options.deviceProgramRunId,
            optionals: ["NodeVersion", "VariableSet.NodeVersion", "FileSet.NodeVersion"]
        }) as LADSResult
        result.properties.setValueFromSource(options.properties)
        result.supervisoryJobId.setValueFromSource(options.jobId)
        result.supervisoryTaskId.setValueFromSource(options.taskId)
        result.samples.setValueFromSource(options.samples)
        setStringValue(getDescriptionVariable(result), `Run with id ${options.deviceProgramRunId} based on program-template ${options.programTemplate.browseName.name}.`)
        setSessionInformation(result, options.context)
        setDateTimeValue(result.started, new Date())
        copyProgramTemplate(options.programTemplate, result.programTemplate)
        touchNodes(this.programManager.resultSet as UAObject)
        options.result = result
        AFODictionary.addDefaultResultReferences(result)
        AFODictionary.addReferences(result, AFODictionaryIds.temperature_measurement_result)

        // initialize active program
        const activeProgram = this.programManager.activeProgram
        setNumericValue(activeProgram.currentRuntime, 0)
        setNameNodeIdValue(activeProgram.currentProgramTemplate, options.programTemplate.browseName.name, options.programTemplate.nodeId)
        setStringValue(activeProgram.deviceProgramRunId, options.deviceProgramRunId)
        
        // initialize recorder?
        const recorderVariables = this.unitImpl.functions.flatMap(func => func.recorderVariables())
        options.eventRecorder = new EventDataRecorder("Events", this.unitImpl.unit)
        options.variableRecorder = new VariableDataRecorder("Time Series", recorderVariables)
        options.started = Date.now()
        const recorderInterval = this.unitImpl.deviceConfig.recorderInterval ? 1000 * Number(this.unitImpl.deviceConfig.recorderInterval) : 10000
        options.variableRecorderTimer = setInterval(() => options.variableRecorder.createRecord(), recorderInterval)
        options.progressTimer = setInterval(() => setNumericValue(this.programManager.activeProgram.currentRuntime, Date.now() - options.started), 1000)

        this.runningStateMachine.setState(LADSRunnnigState.Execute)

        // generate event
        raiseEvent(this.unitImpl.unit, `Run with id ${options.deviceProgramRunId} based on program-template ${options.programTemplate.browseName.name} started.`)
    }

    private async leaveRunning() {
        this.runningStateMachine.setState(LADSRunnnigState.Completing)
        const options = this.programRunOptions
        if (options) {
            options.stopped = Date.now()
            clearInterval(options.variableRecorderTimer)
            clearInterval(options.progressTimer)
            const result = options.result
            setDateTimeValue(result.stopped, new Date())
            const resultsDirectory = join(__dirname, "results")
            const xlsx = await new DataExporter().writeXSLXResultFile(result.fileSet, "XLSX", resultsDirectory, options.deviceProgramRunId, [options.variableRecorder, options.eventRecorder])
            AFODictionary.addReferences(xlsx, AFODictionaryIds.temperature_measurement_result)
            touchNodes(result, result.fileSet, result.variableSet)
            // generate event
            raiseEvent(this.unitImpl.unit, `Run with id ${options.deviceProgramRunId} stopped.`)
        } else {
            raiseEvent(this.unitImpl.unit, `Run stopped.`)
        }
        this.programRunOptions = undefined
        this.runningStateMachine.setState(LADSRunnnigState.Complete)
        this.runningStateMachine.setState(LADSRunnnigState.Idle)
    }



}
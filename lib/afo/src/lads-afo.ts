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
// LADS Allotrope Foundation Ontologies (AFO) support
//---------------------------------------------------------------
import { BaseNode, coerceNodeId, INamespace, ReferenceTypeIds, UAObject, UAObjectType, UAReferenceType, UAStateMachine } from "node-opcua";
import { UAComponent } from "node-opcua-nodeset-di";
import { AFODictionaryIds } from "@afo";
import {
    LADSActiveProgram, LADSAnalogArraySensorFunction, LADSAnalogControlFunction, LADSAnalogScalarSensorFunction,
    LADSComponent, LADSDevice, LADSFunction, LADSFunctionalUnit, LADSMultiStateDiscreteControlFunction, LADSMultiStateDiscreteSensorFunction,
    LADSProgramManager, LADSProgramTemplate, LADSResult, LADSResultFile,
    LADSTwoStateDiscreteControlFunction, LADSTwoStateDiscreteSensorFunction, MachineIdentificationType
} from "@interfaces";
import { getChildObjects, getDescriptionVariable } from "@utils";

type LADSSensorFunction = LADSAnalogScalarSensorFunction | LADSAnalogArraySensorFunction | LADSTwoStateDiscreteSensorFunction | LADSMultiStateDiscreteSensorFunction
type LADSControlFunction = LADSAnalogControlFunction | LADSTwoStateDiscreteControlFunction | LADSMultiStateDiscreteControlFunction

export class AFODictionary {
    static referenceCount = 0
    static isInstalled: boolean
    static afoNamespace: INamespace
    static ladsNamespace: INamespace
    static hasDictionaryReferenceType: UAReferenceType
    static baseSensorFunctionType: UAObjectType
    static baseControlFunctionType: UAObjectType
    static analogControlFunctionType: UAObjectType
    static discreteControlFunctionType: UAObjectType

    private static checkInstall(node: BaseNode): boolean {
        if (this.isInstalled) return true
        if (!node) return false
        if (this.isInstalled === undefined) {
            if (!this.hasDictionaryReferenceType) {
                const addressSpace = node.addressSpace
                this.afoNamespace = addressSpace.getNamespace("http://aixengineers.de/UA/Dictionary/AFO")
                if (this.afoNamespace) {
                    this.isInstalled = true
                    this.hasDictionaryReferenceType = addressSpace.findReferenceType(coerceNodeId(ReferenceTypeIds.HasDictionaryEntry))
                    this.ladsNamespace = addressSpace.getNamespace("http://opcfoundation.org/UA/LADS/")
                    this.baseSensorFunctionType = this.ladsNamespace.findObjectType("BaseSensorFunctionType")
                    this.baseControlFunctionType = this.ladsNamespace.findObjectType("BaseControlFunctionType")
                    this.analogControlFunctionType = this.ladsNamespace.findObjectType("AnalogControlFunctionType")
                    this.discreteControlFunctionType = this.ladsNamespace.findObjectType("DiscreteControlFunctionType")
                } else {
                    this.isInstalled = false
                    console.log(`LADS AFO support unavailable..`)
                }
            }
        }
        return this.isInstalled
    }

    static addReferences(node: BaseNode, ...ids: string[]) {
        if (!node) return
        if (!this.checkInstall(node)) return

        ids.forEach(id => {
            if (id !== undefined) {
                const nodeId = coerceNodeId(`s=${id}`, this.afoNamespace.index)
                const dictionaryEntry = this.afoNamespace.findNode(nodeId)
                if (!dictionaryEntry) {
                    console.warn(`Unable to find dictionary entry ${id}`)
                } else {
                    try {
                        node.addReference({
                            referenceType: this.hasDictionaryReferenceType,
                            nodeId: dictionaryEntry.nodeId
                        })
                        this.referenceCount++
                    }
                    catch (err) {
                        console.info(`AFO Reference ${id} already exits for ${node.browseName.name}`)
                    }
                }
            }
        })
    }

    private static addDefaultFunctionalUnitRefences(functionalUnit: LADSFunctionalUnit) {
        const functions = getChildObjects(functionalUnit.functionSet as UAObject) as LADSFunction[]
        functions.forEach(abstractFunction => this.addDefaultFunctionReferences(abstractFunction))
        this.addDefaultStatemachineReferences(functionalUnit.functionalUnitState)
        this.addDefaultProgramManagerReferences(functionalUnit.programManager)
    }

    private static addDefaultStatemachineReferences(stateMachine: UAStateMachine) {
        if (!stateMachine) return
        this.addReferences(stateMachine, AFODictionaryIds.process_state)
        this.addReferences(stateMachine.currentState, AFODictionaryIds.process_state)
    }

    private static addDefaultFunctionReferences(abstractFunction: LADSFunction) {
        if (!abstractFunction) return
        const objectType = abstractFunction.typeDefinitionObj
        if (objectType.isSubtypeOf(this.baseSensorFunctionType)) {
            this.addDefaultSensorFunctionReferences(abstractFunction as LADSSensorFunction)
        } else if (objectType.isSubtypeOf(this.baseControlFunctionType)) {
            this.addDefaultControlFunctionReferences(abstractFunction as LADSControlFunction)
        }
    }

    private static addDefaultSensorFunctionReferences(sensorFunction: LADSSensorFunction) {
        if (!sensorFunction) return
        this.addReferences(sensorFunction, AFODictionaryIds.sensor, AFODictionaryIds.measurement_function)
    }

    private static addDefaultControlFunctionReferences(controlFunction: LADSControlFunction) {
        if (!controlFunction) return
        this.addReferences(controlFunction, AFODictionaryIds.controller)
        this.addDefaultStatemachineReferences(controlFunction.controlFunctionState)
        this.addReferences(controlFunction.targetValue, AFODictionaryIds.control_setting)
        this.addReferences(controlFunction.currentValue, AFODictionaryIds.current_setting)
    }

    static addSensorFunctionReferences(sensorFunction: LADSSensorFunction, sensorId: string, ...id: string[]) {
        if (!sensorFunction) return
        AFODictionary.addReferences(sensorFunction, sensorId, ...id)
        if (id.length === 0) { id.push(sensorId) }
        AFODictionary.addReferences(sensorFunction.sensorValue, ...id)
    }

    static addControlFunctionReferences(controlFunction: LADSControlFunction, controllerId: string, ...id: string[]) {
        if (!controlFunction) return
        AFODictionary.addReferences(controlFunction, controllerId, ...id)
        AFODictionary.addReferences(controlFunction.targetValue, ...id)
        AFODictionary.addReferences(controlFunction.currentValue, ...id)
    }

    private static addDefaultProgramManagerReferences(programManager: LADSProgramManager) {
        if (!programManager) return
        const programTemplates = getChildObjects(programManager.programTemplateSet as UAObject) as LADSProgramTemplate[]
        programTemplates.forEach(programTemplate => this.addDefaultProgramTemplateReferences(programTemplate))
        this.addDefaultActiveProgramReferences(programManager.activeProgram)
        const results = getChildObjects(programManager.resultSet as UAObject) as LADSResult[]
        results.forEach(result => this.addDefaultResultReferences(result))
    }

    static addDefaultProgramTemplateReferences(programTemplate: LADSProgramTemplate) {
        if (!this.checkInstall(programTemplate)) return
        const description = getDescriptionVariable(programTemplate)
        this.addReferences(programTemplate, AFODictionaryIds.device_method, AFODictionaryIds.method_name)
        this.addReferences(description, AFODictionaryIds.description)
        this.addReferences(programTemplate.author, AFODictionaryIds.author_result)
        this.addReferences(programTemplate.deviceTemplateId, AFODictionaryIds.method_identifier)
        this.addReferences(programTemplate.created, AFODictionaryIds.creation_time)
        this.addReferences(programTemplate.modified, AFODictionaryIds.modified_time)
        this.addReferences(programTemplate.version, AFODictionaryIds.method_version)
    }

    private static addDefaultActiveProgramReferences(activeProgram: LADSActiveProgram) {
        this.addReferences(activeProgram.currentRuntime, AFODictionaryIds.elapsed_time)
    }

    static addDefaultResultReferences(result: LADSResult) {
        if (!this.checkInstall(result)) return
        const description = getDescriptionVariable(result)
        this.addReferences(result, AFODictionaryIds.experimental_data, AFODictionaryIds.experiment_result)
        this.addReferences(description, AFODictionaryIds.description)
        this.addReferences(result.properties, AFODictionaryIds.process_property)
        this.addReferences(result.started, AFODictionaryIds.start_time)
        this.addReferences(result.stopped, AFODictionaryIds.end_time)
        this.addReferences(result.samples, AFODictionaryIds.sample_identifier)
        this.addReferences(result.supervisoryJobId, AFODictionaryIds.lot_number)
        this.addReferences(result.supervisoryTaskId, AFODictionaryIds.lot_number)
        this.addReferences(result.user, AFODictionaryIds.analyst)
        this.addDefaultProgramTemplateReferences(result.programTemplate)
        const resultFiles = getChildObjects(result.fileSet) as LADSResultFile[]
        resultFiles.forEach(resultFile => this.addDefaultResultFileReferences(resultFile))
    }

    static addDefaultResultFileReferences(resultFile: LADSResultFile) {
        if (!this.checkInstall(resultFile)) return
        this.addReferences(resultFile.file, AFODictionaryIds.file_result)
        this.addReferences(resultFile.name, AFODictionaryIds.file_name)
        this.addReferences(resultFile.mimeType, AFODictionaryIds.media_type)
        this.addReferences(resultFile.uRL, AFODictionaryIds.URL)
    }

    private static addDefaultComponentReferences(component: LADSComponent) {
        if (!component) return
        this.addReferences(component.manufacturer, AFODictionaryIds.manufacturer)
        this.addReferences(component.model, AFODictionaryIds.model_number)
        this.addReferences(component.serialNumber, AFODictionaryIds.equipment_serial_number)
        this.addReferences(component.hardwareRevision, AFODictionaryIds.version_number)
        this.addReferences(component.softwareRevision, AFODictionaryIds.software_version)
        this.addReferences(component.assetId, AFODictionaryIds.asset_management_identifier)
        this.addReferences(component.componentName, AFODictionaryIds.local_identifier, AFODictionaryIds.nick_name)
        this.addDefaultIdentifictaionReferences(component.identification)
        const components = component.components?.getAggregates() as UAComponent[]
        components?.forEach(component => {
            this.addDefaultComponentReferences(component)
        })
    }

    private static addDefaultIdentifictaionReferences(identification: MachineIdentificationType) {
        if (!identification) return
        this.addDefaultComponentReferences(identification)
        this.addReferences(identification.location, AFODictionaryIds.location_specification)
    }

    static addDefaultDeviceReferences(device: LADSDevice) {
        if (!this.checkInstall(device)) return
        this.addDefaultComponentReferences(device)
        this.addReferences(device.deviceState, AFODictionaryIds.process_state)
        const functionalUnits = getChildObjects(device.functionalUnitSet as UAObject) as LADSFunctionalUnit[]
        functionalUnits.forEach(functionalUnit => this.addDefaultFunctionalUnitRefences(functionalUnit))
    }


}
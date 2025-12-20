import { BaseNode, CallMethodResultOptions, ConditionInfoOptions, DataType, InstantiateAlarmConditionOptions, LocalizedText, makeNodeId, Namespace, NodeId, ReferenceTypeIds, SessionContext, StatusCodes, UADiscreteAlarmEx, UAFiniteStateMachine, UAMethod, UAObject, UAObjectType, UAProperty, UAState, UAStateMachineEx, VariantLike } from "node-opcua";
import { UAMaintenanceRequiredAlarm } from "node-opcua-nodeset-di";
import { getLADSNamespace, promoteToFiniteStateMachine } from "./lads-utils";
import { getBooleanValue } from "./lads-variable-utils";
import { EventSeverity } from "./lads-functions";
import { LADSComponent } from "@interfaces";
import EventEmitter from "events";

//---------------------------------------------------------------
// maintenance task definitions
//---------------------------------------------------------------
export enum LADSMaintenanceState {
    Planned = "Planned",
    Executing = "Executing",
    Finished = "Finished"
}

export interface MaintenanceEventStateMachine extends UAFiniteStateMachine { }

export interface NameNodeId {
    name: string
    nodeId: NodeId
}

export enum LADSMaintenanceTaskResult { Success = 0, Failure = 1, Undetermined = 2 }

export interface LADSMaintenanceTask extends UAMaintenanceRequiredAlarm {
    maintenanceState: MaintenanceEventStateMachine
    resetTask?: UAMethod
    startTask?: UAMethod
    stopTask?: UAMethod
    partsOfAssetReplaced: UAProperty<NameNodeId[], DataType.ExtensionObject>
    partsOfAssetServiced: UAProperty<NameNodeId[], DataType.ExtensionObject>
}

export interface MaintenanceTaskOptions {
    parent: UAObject
    conditionSource: UAObject
    name: string
    displayName?: string
    conditionClass: UAObjectType
    optionals?: string[]
    inputNode: BaseNode
    component?: LADSComponent
}

//---------------------------------------------------------------
// maintenance task implementation
//---------------------------------------------------------------
interface MaintenanceTaskEvents {
    "warning": []
    "alarm": []
    "executing": []
    "finished": []
    "planned": []
}


export class MaintenanceTaskImpl extends EventEmitter<MaintenanceTaskEvents> {
    options: MaintenanceTaskOptions
    discreteAlarm: UADiscreteAlarmEx
    maintenanceTask: LADSMaintenanceTask
    maintenanceState: UAStateMachineEx
    statePlanned: UAState
    stateExecuting: UAState
    stateFinished: UAState

    constructor(options: MaintenanceTaskOptions) {
        super()
        this.options = options

        // mark the conditionSource (component/device) as EventSoucre
        const conditionSource = options.conditionSource
        const addressSpace = conditionSource.addressSpace
        const hasEventSource = addressSpace.findReferenceType(makeNodeId(ReferenceTypeIds.HasEventSource))
        conditionSource.parent.addReference({ referenceType: hasEventSource, nodeId: conditionSource })

        const namespace = options.parent.namespace as Namespace
        const instantiateOptions: InstantiateAlarmConditionOptions = {
            browseName: options.name,
            displayName: options.displayName,
            componentOf: options.parent,
            conditionOf: options.parent,
            eventSourceOf: options.parent,
            conditionClass: options.conditionClass,
            conditionSource: options.conditionSource,
            inputNode: options.inputNode,
            conditionName: options.name,
            optionals: options.optionals
        }
        this.discreteAlarm = namespace.instantiateDiscreteAlarm(this.objectType, instantiateOptions)
        this.maintenanceTask = (this.discreteAlarm as unknown) as LADSMaintenanceTask
        this.postInitialize()

        // testing
        namespace.addMethod(this.maintenanceTask, { browseName: "RaiseWarning" }).bindMethod(
            (async (inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> => {
                this.raiseWarningEvent()
                return { statusCode: StatusCodes.Good }
            }).bind(this)
        )
        namespace.addMethod(this.maintenanceTask, { browseName: "RaiseAlarm" }).bindMethod(
            (async (inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> => {
                this.raiseAlarmEvent()
                return { statusCode: StatusCodes.Good }
            }).bind(this)
        )
        namespace.addMethod(this.maintenanceTask, { browseName: "EnterActive" }).bindMethod(
            (async (inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> => {
                this.enterActive()
                console.log(this.discreteAlarm)
                return { statusCode: StatusCodes.Good }
            }).bind(this)
        )
        namespace.addMethod(this.maintenanceTask, { browseName: "EnterInactive" }).bindMethod(
            (async (inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> => {
                this.enterInactive()
                console.log(this.discreteAlarm)
                return { statusCode: StatusCodes.Good }
            }).bind(this)
        )
    }

    protected get objectType(): UAObjectType {
        const ns = getLADSNamespace(this.options.parent.addressSpace)
        return ns.findObjectType("MaintenanceTaskType")
    }

    protected postInitialize() {
        this.maintenanceState = promoteToFiniteStateMachine(this.maintenanceTask.maintenanceState)
        this.maintenanceTask.startTask?.bindMethod(this.startTask.bind(this))
        this.maintenanceTask.stopTask?.bindMethod(this.stopTask.bind(this))
        this.maintenanceTask.resetTask?.bindMethod(this.resetTask.bind(this))
        this.statePlanned = this.maintenanceState.getStateByName(LADSMaintenanceState.Planned)
        this.stateExecuting = this.maintenanceState.getStateByName(LADSMaintenanceState.Executing)
        this.stateFinished = this.maintenanceState.getStateByName(LADSMaintenanceState.Finished)
        this.maintenanceState.setState(this.stateFinished) 
    }

    raiseEvent(message: string, severity: EventSeverity, event: keyof MaintenanceTaskEvents) {
        const conditionInfo: ConditionInfoOptions = {
            message: message,
            time: new Date(),
            severity: severity,
        }
        this.discreteAlarm.raiseNewCondition(conditionInfo)
        if (event) this.emit(event)
    }
    raiseWarningEvent() { this.raiseEvent(`${this.taskName} due warning`, EventSeverity.Warning, "warning") }
    raiseAlarmEvent() { this.raiseEvent(`${this.taskName} required alarm`, EventSeverity.Alarm, "alarm") }

    enterPlanned() { 
        this.maintenanceState.setState(this.statePlanned) 
    }
    private get taskName(): string {return this.maintenanceTask.getDisplayName() }
    private get conditionSourceName(): string { return this.options.conditionSource.getDisplayName() }

    enterExecuting() { 
        this.maintenanceState.setState(this.stateExecuting) 
        this.raiseEvent(`Executing ${this.taskName}`, EventSeverity.Info, "executing")    
    }
    enterFinished(result: LADSMaintenanceTaskResult, comment: VariantLike = undefined) { 
        this.maintenanceState.setState(this.stateFinished) 
        if (comment) this.maintenanceTask.comment.setValueFromSource(comment)
        this.raiseEvent(`Finished ${this.taskName} with result ${LADSMaintenanceTaskResult[result]}`, EventSeverity.Info, "finished")    
    }

    get activeState(): boolean { return getBooleanValue(this.discreteAlarm.activeState.id) }

    enterActive() {
        if (this.activeState) return
        this.discreteAlarm.activateAlarm()
        this.raiseAlarmEvent()
    }
    enterInactive() {
        if (!this.activeState) return
        this.discreteAlarm.deactivateAlarm()
    }

    private async startTask(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (this.maintenanceState.currentStateNode === this.stateExecuting) return { statusCode: StatusCodes.BadInvalidState }
        this.enterExecuting()
        return { statusCode: StatusCodes.Good }
    }

    private async stopTask(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (this.maintenanceState.currentStateNode !== this.stateExecuting) return { statusCode: StatusCodes.BadInvalidState }
        const result = Number(inputArguments[0].value.value) as LADSMaintenanceTaskResult
        const comment: VariantLike = inputArguments[1]
        this.enterFinished(result, comment)
        return { statusCode: StatusCodes.Good }
    }

    private async resetTask(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (this.maintenanceState.currentStateNode !== this.stateFinished) return { statusCode: StatusCodes.BadInvalidState }
        this.enterPlanned()
        return { statusCode: StatusCodes.Good }
    }

}

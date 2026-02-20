import EventEmitter from "events";
import { LocalizedText, TransitionSelector, UAFiniteStateMachine, UAInitialState, UAMethod, UAState, UAStateMachine, UAStateMachine_Base, UAStateMachineEx, UAStateMachineHelper, UAStateVariable, UATransitionEx, UATransitionVariable } from "node-opcua";
import { promoteToFiniteStateMachine } from "./lads-utils";
import { get } from "http";
import { LADSFunctionalStateMachine, LADSFunctionalStateMachine_Base } from "@interfaces";

export class StateMachineImpl extends EventEmitter implements UAStateMachineHelper, UAStateMachine_Base {
    stateMachine: UAStateMachineEx

    constructor(stateMachine: UAFiniteStateMachine) {
        super()
        this.stateMachine = promoteToFiniteStateMachine(stateMachine)
    }

    // delegation
    get currentState(): UAStateVariable<LocalizedText> { return this.stateMachine.currentState }
    get lastTransition(): UATransitionVariable<LocalizedText> | undefined { return this.stateMachine.lastTransition }
    get initialState(): UAInitialState | null { return this.stateMachine.initialState }
    get states(): UAState[] { return this.stateMachine.states }
    get transitions(): UATransitionEx[] { return this.stateMachine.transitions }
    get currentStateNode(): UAState | null { return this.stateMachine.currentStateNode }
    getStates(): UAState[] { return this.stateMachine.getStates() }
    getTransitions(): UATransitionEx[] { return this.stateMachine.getTransitions() }
    getStateByName(name: string): UAState | null { return this.stateMachine.getStateByName(name) }
    isValidTransition(toStateNode: UAState | string, predicate?: TransitionSelector): boolean { return this.stateMachine.isValidTransition(toStateNode, predicate) }
    findTransitionNode(fromStateNode: UAState, toStateNode: UAState, predicate?: TransitionSelector): UATransitionEx | null { return this.stateMachine.findTransitionNode(fromStateNode, toStateNode, predicate) }
    getCurrentState(): string | null { return this.stateMachine.getCurrentState() }
    setState(toStateNode: UAState | string | null, predicate?: TransitionSelector) { this.stateMachine.setState(toStateNode, predicate) }
}

export class FunctionalStateMachineImpl extends StateMachineImpl implements LADSFunctionalStateMachine_Base {
    constructor(stateMachine: LADSFunctionalStateMachine) { super(stateMachine) }
    get functionalStateMachine(): LADSFunctionalStateMachine { return this.stateMachine as unknown as LADSFunctionalStateMachine }
    get start(): UAMethod { return this.functionalStateMachine.start }
    get stop(): UAMethod { return this.functionalStateMachine.stop }
    get abort(): UAMethod { return this.functionalStateMachine.abort }
}



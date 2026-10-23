import EventEmitter from "events";
import { LocalizedText, TransitionSelector, UAFiniteStateMachine, UAObject, UAInitialState, UAMethod, UAState, UAStateMachine, UAStateMachine_Base, UAStateMachineEx, UAStateMachineHelper, UAStateVariable, UATransitionEx, UATransitionVariable } from "node-opcua";
import { promoteToFiniteStateMachine, sleepMilliSeconds } from "./lads-utils";
import { get } from "http";
import { LADSFunctionalState, LADSFunctionalStateMachine, LADSFunctionalStateMachine_Base, LADSRunnnigState } from "@interfaces";
import { raiseEvent } from "./lads-event-utils";
import { EventSeverity } from "./lads-functions";

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
    get clear(): UAMethod | undefined { return this.functionalStateMachine.clear }
}



//---------------------------------------------------------------
// FunctionalStateMachine transition chains (simulated device delays)
//---------------------------------------------------------------
export const FunctionalStateDelayMilliSeconds = 100

/** Enter the given states one after the other, each after a short delay. No events are raised for the transitory states. */
export async function enterStateChain(stateMachine: UAStateMachineEx, states: (LADSFunctionalState | LADSRunnnigState)[], delayMilliSeconds: number = FunctionalStateDelayMilliSeconds) {
    for (const state of states) {
        await sleepMilliSeconds(delayMilliSeconds)
        stateMachine.setState(state)
    }
}

/** Continue Aborting -> Aborted (Aborting must already be entered by the caller). Raises one final event. */
export async function enterAborted(stateMachine: UAStateMachineEx, eventSource: UAObject, message: string) {
    try {
        await enterStateChain(stateMachine, [LADSFunctionalState.Aborted])
        raiseEvent(eventSource, message, EventSeverity.Warning)
    } catch (err) {
        raiseEvent(eventSource, `Entering Aborted failed: ${err}`, EventSeverity.Alarm)
    }
}

/** Aborted -> Clearing -> Stopped. Clearing is entered immediately, Stopped after a short delay. Raises one final event. */
export async function enterClearing(stateMachine: UAStateMachineEx, eventSource: UAObject, message: string = "Cleared, now stopped.") {
    try {
        stateMachine.setState(LADSFunctionalState.Clearing)
        await enterStateChain(stateMachine, [LADSFunctionalState.Stopped])
        raiseEvent(eventSource, message, EventSeverity.Info)
    } catch (err) {
        raiseEvent(eventSource, `Clearing failed: ${err}`, EventSeverity.Alarm)
    }
}

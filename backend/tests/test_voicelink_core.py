from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.call_manager import CallState, CallStateMachine


def test_call_state_machine_valid_transitions():
    manager = CallStateMachine()

    assert manager.state == CallState.IDLE
    assert manager.transition(CallState.DIALING)
    assert manager.state == CallState.DIALING
    assert manager.transition(CallState.CONNECTING)
    assert manager.state == CallState.CONNECTING
    assert manager.transition(CallState.CONNECTED)
    assert manager.state == CallState.CONNECTED
    assert manager.transition(CallState.LISTENING)
    assert manager.state == CallState.LISTENING
    assert manager.transition(CallState.PROCESSING)
    assert manager.state == CallState.PROCESSING
    assert manager.transition(CallState.SPEAKING)
    assert manager.state == CallState.SPEAKING
    assert manager.transition(CallState.LISTENING)
    assert manager.transition(CallState.ENDED)
    assert manager.state == CallState.ENDED


def test_call_state_machine_invalid_transition_rejected():
    manager = CallStateMachine()
    assert manager.state == CallState.IDLE
    assert not manager.transition(CallState.CONNECTED)
    assert manager.state == CallState.IDLE


def test_call_state_machine_terminal_state_rejects_reuse():
    manager = CallStateMachine()
    assert manager.transition(CallState.DIALING)
    assert manager.transition(CallState.CONNECTING)
    assert manager.transition(CallState.CONNECTED)
    assert manager.transition(CallState.LISTENING)
    assert manager.transition(CallState.ENDED)
    assert not manager.transition(CallState.LISTENING)

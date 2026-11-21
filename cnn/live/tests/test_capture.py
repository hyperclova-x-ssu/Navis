"""Replay the same capture frames the live worker receives."""
from types import SimpleNamespace

from capture import StablePeople, create_frame_pipeline
from config import Config, load_config
from pipeline import load_numbers
from test_pipeline import FakeModel, PERSON_A, frame, settings
import pipeline


def capture(detector, cups=None):
    return create_frame_pipeline(Config(), detector=detector, engine=load_numbers().LiveNumberEngine(), cups=cups)


def test_live_modes_default_to_same_inputs_and_cadence(monkeypatch):
    monkeypatch.setenv("CNN_MODE", "weak")
    cpu = load_config()
    monkeypatch.setenv("CNN_MODE", "gpu")
    gpu = load_config()
    assert (cpu.imgsz, cpu.detect_hz, cpu.detect_plan) == (gpu.imgsz, gpu.detect_hz, gpu.detect_plan)
    assert cpu.detect_plan == "full+zones"


def test_capture_confirms_people_causally_and_counts_the_drawn_people():
    detector = pipeline.YoloDetector(settings(detect_plan="full+zones"), model=FakeModel([[PERSON_A]]*5))
    pipe = capture(detector, cups=SimpleNamespace(step=lambda *args, **kwargs: [], reset=lambda: None))
    results = [pipe.step(frame(i,i/15), None) for i in range(7)]
    assert [item.detected for item in results] == [True,False,False,True,False,False,True]
    assert [item.result.counts.inStore for item in results] == [1,1,1,1,1,1,1]
    assert all(item.result.counts.inStore == len(item.result.persons) for item in results)


def test_display_holds_through_a_brief_miss_and_rejects_a_one_frame_spike():
    people = StablePeople()
    guest = (0.2, 0.4, 0.3, 0.8, 1)
    passer = (0.6, 0.3, 0.7, 0.9, 2)
    assert people.update(0, [guest]) == [guest]
    assert people.update(0.2, [guest, passer]) == [guest]
    assert people.update(0.4, []) == [guest]
    assert people.update(0.6, [guest]) == [guest]
    assert people.update(2.1, []) == []


def test_body_and_head_boxes_for_one_person_use_one_display_slot():
    people = StablePeople()
    body = (0.21, 0.4, 0.29, 0.8, 1)
    head = (0.22, 0.401, 0.28, 0.53, 2)
    assert len(people.update(0, [body, head])) == 1
    assert len(people.update(0.2, [head])) == 1


def test_count_increase_requires_elapsed_evidence_from_current_detections():
    people = StablePeople()
    guest = (0.2, 0.4, 0.3, 0.8, 1)
    entrant = (0.6, 0.3, 0.7, 0.9)
    assert len(people.update(0, [guest])) == 1
    # The detector sees the entrant before ByteTrack emits its active track.
    for t in (0.2, 0.4, 0.6):
        assert people.update(t, [guest], [guest[:4], entrant]) == [guest]
    drawn = people.update(0.8, [guest], [guest[:4], entrant])
    assert drawn == [guest, (*entrant, -1)]


def test_cup_pass_runs_between_person_passes_and_updates_the_same_result():
    class Cups:
        def __init__(self):
            self.calls = []
        def step(self, f, zones, people, *, can_scan):
            self.calls.append(can_scan)
            return [(0.4,0.5,0.5,0.6)] if can_scan else []
        def reset(self):
            pass
    cups = Cups()
    detector = pipeline.YoloDetector(settings(), model=FakeModel([[PERSON_A]]*5))
    pipe = capture(detector, cups=cups)
    first = pipe.step(frame(0,0), None)
    between = pipe.step(frame(1,1/15), None)
    assert first.result.cups == []
    assert between.detected is False
    assert between.result.cups == [[0.4,0.5,0.5,0.6]]
    assert cups.calls == [False,True]



def test_table_cup_uses_consecutive_scans_and_survives_a_missed_scan():
    import numpy as np
    from capture import TableCups
    from zones import Zone, ZoneSet, encode_mask

    mask = np.zeros((90, 160), dtype=bool)
    mask[30:60, 60:100] = True
    zones = ZoneSet(revision=1, zones=[
        Zone("ztables01", 1, "drawn", {"cols": 160, "rows": 90, "runs": encode_mask(mask)}),
    ])
    cup = [175, 130, 195, 150, 0.7, 41]
    model = FakeModel([[cup], [cup], [], [], []])
    cups = TableCups(settings(), model=model)
    person_near = [(0.51, 0.30, 0.55, 0.65, 1)]
    assert cups.step(frame(0, 0), zones, person_near, can_scan=True) == []
    assert cups.step(frame(1, 0.2), zones, person_near, can_scan=True) == []
    found = cups.step(frame(2, 0.4), zones, person_near, can_scan=True)
    assert len(found) == 1
    assert cups.step(frame(3, 0.8), zones, person_near, can_scan=True) == found
    assert cups.step(frame(4, 1.2), zones, person_near, can_scan=True) == found
    assert cups.step(frame(5, 1.6), zones, person_near, can_scan=True) == found
    assert cups.step(frame(6, 2.0), zones, person_near, can_scan=True) == found
    assert cups.step(frame(7, 2.4), zones, person_near, can_scan=True) == []

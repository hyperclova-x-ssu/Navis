import json
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import zones as Z  # noqa: E402

VEC = json.load(open(os.path.join(os.path.dirname(__file__), "vectors", "zones_rle.json")))


def rect_mask(c0, r0, c1, r1):
    m = np.zeros((Z.ROWS, Z.COLS), bool)
    m[r0:r1, c0:c1] = True
    return m


def mk(i, rect, number=None, zid=None):
    return Z.Zone(id=zid or f"z{i:08d}", number=number or i, source="drawn",
                  mask={"cols": 160, "rows": 90, "runs": Z.encode_mask(rect_mask(*rect))})


def body(*zs, aspect=1.778):
    return Z.ZoneSetIn(frame_aspect=aspect, zones=list(zs))


@pytest.mark.parametrize("case", VEC["cases"], ids=lambda c: c["name"])
def test_vectors_roundtrip(case):
    m = np.zeros((Z.ROWS, Z.COLS), bool)
    for c0, r0, c1, r1 in case["rects"]:
        m[r0:r1, c0:c1] = True
    assert Z.encode_mask(m) == case["runs"]
    assert int(Z.decode_runs(case["runs"]).sum()) == case["cells"]
    assert (Z.decode_runs(case["runs"]) == m).all()


def test_roundtrip_random():
    rng = np.random.default_rng(0)
    for _ in range(20):
        m = rng.random((Z.ROWS, Z.COLS)) > rng.random()
        assert (Z.decode_runs(Z.encode_mask(m)) == m).all()


@pytest.mark.parametrize("runs,rule", [
    ([14399], 1), ([14401], 1), ([0, 0, 14400], 1), ([-1, 14401], 1), ([1.5, 14398.5], 1),
    ([True, 14399], 1), ([], 1)])
def test_bad_runs_rejected(runs, rule):
    with pytest.raises(Z.InvalidZones) as e:
        Z.decode_runs(runs)
    assert e.value.rule == rule


def test_rule2_too_small():
    with pytest.raises(Z.InvalidZones) as e:
        Z.validate_zones([mk(1, (0, 0, 3, 3))])   # 9 cells
    assert e.value.rule == 2


def test_rule3_overlap():
    with pytest.raises(Z.InvalidZones) as e:
        Z.validate_zones([mk(1, (0, 0, 10, 10)), mk(2, (9, 9, 20, 20))])
    assert e.value.rule == 3


def test_rule4_numbers():
    with pytest.raises(Z.InvalidZones) as e:
        Z.validate_zones([mk(1, (0, 0, 10, 10), number=1), mk(2, (20, 0, 30, 10), number=1)])
    assert e.value.rule == 4
    with pytest.raises(Z.InvalidZones) as e:
        Z.validate_zones([mk(1, (0, 0, 10, 10), number=2)])
    assert e.value.rule == 4


@pytest.mark.parametrize("zid", ["abc", "Zabcdefgh", "z1234567", "z123456789", "zABCDEFGH"])
def test_rule5_bad_id(zid):
    with pytest.raises(Z.InvalidZones) as e:
        Z.validate_zones([mk(1, (0, 0, 10, 10), zid=zid)])
    assert e.value.rule == 5


def test_rule5_duplicate_id():
    with pytest.raises(Z.InvalidZones) as e:
        Z.validate_zones([mk(1, (0, 0, 10, 10), zid="zaaaaaaaa"), mk(2, (20, 0, 30, 10), zid="zaaaaaaaa")])
    assert e.value.rule == 5


def test_rule6_too_many():
    zs = [Z.Zone(id=f"z{i:08d}", number=i + 1, source="drawn", mask={"runs": [1]}) for i in range(33)]
    with pytest.raises(Z.InvalidZones) as e:
        Z.validate_zones(zs)
    assert e.value.rule == 6


def test_rule7_body_size():
    with pytest.raises(Z.InvalidZones) as e:
        Z.validate_zones([], body_bytes=Z.MAX_BODY_BYTES + 1)
    assert e.value.rule == 7


def test_valid_and_empty_ok():
    Z.validate_zones([])
    Z.validate_zones([mk(1, (0, 0, 10, 10)), mk(2, (20, 0, 30, 10))])


def test_from_dict_rejects_malformed():
    with pytest.raises(Z.InvalidZones):
        Z.ZoneSetIn.from_dict({"zones": "x"})
    with pytest.raises(Z.InvalidZones):
        Z.ZoneSetIn.from_dict({"frameAspect": 1.7, "zones": [{"id": "z", "mask": {"cols": 1}}]})


# ------------------------------------------------------------- store

def test_load_missing_is_empty(tmp_path):
    s = Z.FileZoneStore(str(tmp_path / "zones.json")).load()
    assert (s.revision, s.saved_at, s.frame_aspect, s.zones) == (0, None, None, [])


def test_save_load_and_revision(tmp_path):
    st = Z.FileZoneStore(str(tmp_path / "zones.json"))
    seen = []
    st.on_change(seen.append)
    out = st.save(body(mk(1, (0, 0, 10, 10))), 0)
    assert out.revision == 1 and out.saved_at
    again = Z.FileZoneStore(str(tmp_path / "zones.json")).load()
    assert again.to_dict() == out.to_dict()
    assert [s.revision for s in seen] == [1]


def test_retry_same_request_single_effect(tmp_path):
    st = Z.FileZoneStore(str(tmp_path / "zones.json"))
    seen = []
    st.on_change(seen.append)
    b = body(mk(1, (0, 0, 10, 10), zid="zaaaaaaaa"))
    a1 = st.save(b, 0)
    a2 = st.save(b, 0)
    assert a1.to_dict() == a2.to_dict() and a2.revision == 1 and len(seen) == 1


def test_conflict_carries_current(tmp_path):
    st = Z.FileZoneStore(str(tmp_path / "zones.json"))
    st.save(body(mk(1, (0, 0, 10, 10))), 0)
    with pytest.raises(Z.RevisionConflict) as e:
        st.save(body(mk(1, (50, 0, 60, 10))), 0)   # stale base, different body
    assert e.value.current.revision == 1
    with pytest.raises(Z.RevisionConflict):
        st.save(body(), 7)


def test_invalid_does_not_change_file(tmp_path):
    st = Z.FileZoneStore(str(tmp_path / "zones.json"))
    st.save(body(mk(1, (0, 0, 10, 10))), 0)
    with pytest.raises(Z.InvalidZones):
        st.save(body(mk(1, (0, 0, 3, 3))), 1)
    assert st.load().revision == 1


def test_atomic_write_failure_keeps_previous(tmp_path, monkeypatch):
    p = tmp_path / "zones.json"
    st = Z.FileZoneStore(str(p))
    st.save(body(mk(1, (0, 0, 10, 10))), 0)
    before = p.read_bytes()
    monkeypatch.setattr(Z.os, "replace", lambda *a: (_ for _ in ()).throw(OSError("disk")))
    with pytest.raises(OSError):
        st.save(body(mk(1, (50, 0, 60, 10))), 1)
    monkeypatch.undo()
    assert p.read_bytes() == before
    assert [f.name for f in tmp_path.iterdir()] == ["zones.json"]   # no temp leftovers


def test_listener_failure_does_not_break_save(tmp_path):
    st = Z.FileZoneStore(str(tmp_path / "zones.json"))
    st.on_change(lambda z: 1 / 0)
    assert st.save(body(), 0).revision == 1

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import suggest as S  # noqa: E402
import zones as Z  # noqa: E402


def cov(c0, r0, c1, r1, v=1.0):
    m = np.zeros((Z.ROWS, Z.COLS), np.float32)
    m[r0:r1, c0:c1] = v
    return m


def grids(out):
    return [Z.decode_runs(z.mask["runs"]) for z in out]


def test_segment_threshold_50pct():
    out = S.combine([cov(10, 10, 30, 20, 0.5), cov(60, 10, 80, 20, 0.49)], None, None)
    assert len(out) == 1 and out[0].method == "segment" and grids(out)[0].sum() == 200


def test_small_dropped_and_max12():
    masks = [cov(i * 12, 0, i * 12 + 3, 3) for i in range(5)]   # 9 cells -> dropped
    assert S.combine(masks, None, None) == []
    many = [cov((i % 13) * 12, (i // 13) * 10, (i % 13) * 12 + 6, (i // 13) * 10 + 6) for i in range(15)]
    assert len(S.combine(many, None, None)) == 12


def test_merge_over_50pct_overlap():
    seg = cov(10, 10, 30, 20)
    heat = np.zeros((Z.ROWS, Z.COLS), np.float32)
    heat[12:18, 12:28] = 5   # inside the table
    out = S.combine([seg], heat, None)
    assert len(out) == 1 and out[0].method == "segment"


def test_heat_alone_gives_seated_group():
    heat = np.zeros((Z.ROWS, Z.COLS), np.float32)
    heat[40:44, 50:60] = 10
    heat[0, 0] = 1            # below threshold: ignored
    out = S.combine([], heat, None)
    assert len(out) == 1 and out[0].method == "seated"


def test_output_disjoint_and_excludes_existing():
    existing = Z.ZoneSet(revision=1, zones=[Z.Zone("zaaaaaaaa", 1, "drawn",
                         {"runs": Z.encode_mask(cov(10, 10, 30, 20) > 0)})])
    out = S.combine([cov(10, 10, 30, 20), cov(25, 10, 45, 20)], None, existing)
    g = grids(out)
    assert len(out) == 1 and not (g[0] & (cov(10, 10, 30, 20) > 0)).any()
    out2 = S.combine([cov(0, 0, 20, 10), cov(15, 0, 35, 10)], None, None)  # 25% overlap: kept apart
    g2 = grids(out2)
    assert len(out2) == 2 and not (g2[0] & g2[1]).any()


def test_suggestions_pass_validation_once_numbered():
    out = S.combine([cov(0, 0, 20, 10), cov(50, 30, 80, 50)], None, None)
    for i, z in enumerate(out, 1):
        z.number = i
    Z.validate_zones(out)


def test_bad_heat_shape():
    with pytest.raises(ValueError):
        S.combine([], np.zeros((10, 10)), None)


def test_suggest_zones_uses_injected_segmenter_and_rejects_bad_jpeg():
    import cv2
    ok, buf = cv2.imencode(".jpg", np.zeros((90, 160, 3), np.uint8))
    S.set_segmenter(lambda img: [cov(10, 10, 30, 20)])
    try:
        out = S.suggest_zones(buf.tobytes(), Z.ZoneSet(), None)
        assert len(out) == 1
        with pytest.raises(ValueError):
            S.suggest_zones(b"nope", Z.ZoneSet(), None)
    finally:
        S.set_segmenter(None)


@pytest.mark.gpu
def test_real_model_finds_a_table():
    """Needs yolo11s-seg weights and a table photo outside the repo: CNN_TEST_TABLE_JPG."""
    path = os.environ.get("CNN_TEST_TABLE_JPG")
    if not path or not os.path.exists(path):
        pytest.skip("CNN_TEST_TABLE_JPG not set")
    out = S.suggest_zones(open(path, "rb").read(), Z.ZoneSet(), None)
    assert len(out) >= 1
    for i, z in enumerate(out, 1):
        z.number = i
    Z.validate_zones(out)

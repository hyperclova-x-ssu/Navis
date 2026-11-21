from common import point_in_polygon
from evaluate import errors, gt_counts

SQ = [[0, 0], [10, 0], [10, 10], [0, 10]]


def test_point_in_polygon():
    assert point_in_polygon((5, 5), SQ)
    assert not point_in_polygon((11, 5), SQ)


def test_counts_and_errors():
    g = gt_counts([(0, 0, 1, 1, 0, 1), (0, 0, 1, 1, 1, 3), (0, 0, 1, 1, 1, 4), (0, 0, 1, 1, -1, 7)])
    assert g == {"persons": 4, "queue": 1, "seated": 2, "seated_groups": 1}
    assert errors([1, 3], [2, 2])["mae"] == 1.0

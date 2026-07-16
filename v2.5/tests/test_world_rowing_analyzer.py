import unittest

from scripts.analyze_world_rowing_2017 import first_plausible_rig_distance


class RigDistanceSelectionTest(unittest.TestCase):
    def test_column_n_is_preferred_when_both_values_are_plausible(self):
        self.assertEqual(first_plausible_rig_distance({14: 160.0, 15: 162.0}, 145, 175), 160.0)

    def test_column_o_is_used_when_column_n_is_missing_or_implausible(self):
        self.assertEqual(first_plausible_rig_distance({14: 999.0, 15: 158.0}, 145, 175), 158.0)

    def test_row_without_a_plausible_value_contributes_no_sample(self):
        self.assertIsNone(first_plausible_rig_distance({14: 100.0, 15: 200.0}, 145, 175))


if __name__ == '__main__':
    unittest.main()

"""
Tests for scheduling constraint logic.

Simple tests that verify basic configuration and concepts.
"""

from scheduler.config import DAY_NAMES, FRONT_DESK_ROLE, SLOT_MINUTES, SLOT_NAMES, TIME_SLOT_STARTS


def test_day_names_count():
    """Test that we have 5 working days."""
    assert len(DAY_NAMES) == 5
    assert DAY_NAMES == ["Mon", "Tue", "Wed", "Thu", "Fri"]


def test_time_slots_count():
    """Test that we have 54 ten-minute slots (8am-5pm)."""
    assert len(TIME_SLOT_STARTS) == 54
    assert len(SLOT_NAMES) == 54


def test_time_slots_start_at_8am():
    """Test that the first time slot starts at 8:00 AM."""
    assert TIME_SLOT_STARTS[0] == "08:00"
    assert SLOT_NAMES[0] == "8:00-8:10"


def test_time_slots_end_at_5pm():
    """Test that the last time slot ends at 5:00 PM."""
    assert TIME_SLOT_STARTS[-1] == "16:50"
    assert SLOT_NAMES[-1] == "4:50-5:00"


def test_front_desk_role_defined():
    """Test that the front desk role is defined."""
    assert FRONT_DESK_ROLE == "front_desk"


def test_availability_matrix_size():
    """Test that availability matrix has correct dimensions."""
    # Should have 5 days × 54 slots = 270 availability entries
    total_slots = len(DAY_NAMES) * len(TIME_SLOT_STARTS)
    assert total_slots == 270


def test_slot_duration():
    """Test that each slot represents 10 minutes."""
    total_hours = 9.0
    hours_per_slot = total_hours / len(TIME_SLOT_STARTS)
    assert hours_per_slot == SLOT_MINUTES / 60

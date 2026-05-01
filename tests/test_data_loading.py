"""
Tests for CSV data loading and validation.

Simple tests that verify data loading functions work correctly.
"""

import pandas as pd

from scheduler.config import DAY_NAMES, LEGACY_TIME_SLOT_STARTS, TIME_SLOT_STARTS
from scheduler.data_access.department_loader import load_department_requirements
from scheduler.data_access.staff_loader import _coerce_numeric, _normalize_columns, _parse_roles, load_staff_data


def test_normalize_basic_columns():
    """Test that basic column names are normalized correctly."""
    df = pd.DataFrame(columns=["Name", "ROLES", "target_hours"])
    normalized = _normalize_columns(df)
    
    assert "name" in normalized
    assert "roles" in normalized
    assert "target_hours" in normalized


def test_parse_semicolon_separated_roles():
    """Test parsing roles separated by semicolons."""
    result = _parse_roles("front_desk;marketing;events")
    assert result == ["front_desk", "marketing", "events"]


def test_parse_comma_separated_roles():
    """Test parsing roles separated by commas."""
    result = _parse_roles("front_desk,marketing,events")
    assert result == ["front_desk", "marketing", "events"]


def test_parse_roles_with_whitespace():
    """Test that whitespace is stripped from role names."""
    result = _parse_roles("  front_desk ; marketing  ; events  ")
    assert result == ["front_desk", "marketing", "events"]


def test_parse_empty_roles():
    """Test that empty or NaN roles return empty list."""
    assert _parse_roles(None) == []
    assert _parse_roles("") == []


def test_coerce_integer():
    """Test coercing integer values."""
    result = _coerce_numeric(10, "test_col", "test_record")
    assert result == 10.0


def test_coerce_float():
    """Test coercing float values."""
    result = _coerce_numeric(10.5, "test_col", "test_record")
    assert result == 10.5


def test_coerce_string_number():
    """Test coercing string representations of numbers."""
    result = _coerce_numeric("10.5", "test_col", "test_record")
    assert result == 10.5


def test_coerce_invalid_raises_error():
    """Test that invalid values raise a descriptive error."""
    try:
        _coerce_numeric("not_a_number", "hours", "John")
        assert False, "Should have raised ValueError"
    except ValueError as e:
        assert "Invalid numeric value" in str(e)


def _make_staff_row(name: str, availability: dict[str, bool], extra: dict[str, int] | None = None) -> dict[str, object]:
    row: dict[str, object] = {
        "name": name,
        "roles": "front_desk",
        "target_hours": 10,
        "max_hours": 15,
        "year": 2,
    }
    row.update(extra or {})
    for day in DAY_NAMES:
        for time in TIME_SLOT_STARTS:
            row[f"{day}_{time}"] = 1 if availability.get(f"{day}_{time}", True) else 0
    return row


def test_load_staff_data_defaults_missing_travel_buffer_columns(tmp_path):
    availability = {f"Mon_{time}": True for time in TIME_SLOT_STARTS}
    csv_path = tmp_path / "staff.csv"
    pd.DataFrame([_make_staff_row("Alice", availability)]).to_csv(csv_path, index=False)

    staff_data = load_staff_data(csv_path)

    assert "Alice" in staff_data.qual
    assert staff_data.unavailable == {}


def test_load_staff_data_accepts_legacy_30_minute_availability_grid(tmp_path):
    row = {
        "name": "Alice",
        "roles": "front_desk",
        "target_hours": 10,
        "max_hours": 15,
        "year": 2,
    }
    for day in DAY_NAMES:
        for time in LEGACY_TIME_SLOT_STARTS:
            row[f"{day}_{time}"] = 1 if time == "08:00" and day == "Mon" else 0

    csv_path = tmp_path / "legacy-staff.csv"
    pd.DataFrame([row]).to_csv(csv_path, index=False)

    staff_data = load_staff_data(csv_path)
    unavailable_slots = set(staff_data.unavailable["Alice"]["Mon"])

    assert 0 not in unavailable_slots
    assert 1 not in unavailable_slots
    assert 2 not in unavailable_slots
    assert 3 in unavailable_slots


def test_load_staff_data_applies_travel_buffer_flags(tmp_path):
    availability = {f"{day}_{time}": False for day in DAY_NAMES for time in TIME_SLOT_STARTS}
    for time in ("08:00", "08:10", "08:20"):
        availability[f"Mon_{time}"] = True
    for time in ("08:40", "08:50", "09:00"):
        availability[f"Mon_{time}"] = True

    csv_path = tmp_path / "staff-with-buffers.csv"
    pd.DataFrame([
        _make_staff_row(
            "Alice",
            availability,
            extra={
                "Mon_before_next_commitment": 1,
                "Mon_after_previous_commitment": 1,
            },
        )
    ]).to_csv(csv_path, index=False)

    staff_data = load_staff_data(csv_path)
    unavailable_slots = set(staff_data.unavailable["Alice"]["Mon"])

    assert 2 in unavailable_slots  # 08:20 trimmed before the next unavailable block
    assert 4 in unavailable_slots  # 08:40 trimmed after the previous unavailable block
    assert 0 not in unavailable_slots
    assert 5 not in unavailable_slots


def test_load_staff_data_rejects_misaligned_hours(tmp_path):
    availability = {f"Mon_{time}": True for time in TIME_SLOT_STARTS}
    csv_path = tmp_path / "misaligned-staff.csv"
    pd.DataFrame([
        _make_staff_row(
            "Alice",
            availability,
            extra={
                "target_hours": 10.25,
                "max_hours": 15,
            },
        )
    ]).to_csv(csv_path, index=False)

    try:
        load_staff_data(csv_path)
        assert False, "Should have raised ValueError for misaligned hours"
    except ValueError as exc:
        assert "10-minute slot grid" in str(exc)


def test_load_department_requirements_rejects_misaligned_hours(tmp_path):
    csv_path = tmp_path / "departments.csv"
    pd.DataFrame([
        {"department": "Marketing", "target_hours": 12.25, "max_hours": 15}
    ]).to_csv(csv_path, index=False)

    try:
        load_department_requirements(csv_path)
        assert False, "Should have raised ValueError for misaligned department hours"
    except ValueError as exc:
        assert "10-minute slot grid" in str(exc)

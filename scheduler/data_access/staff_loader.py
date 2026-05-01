"""CSV loading utilities for staff data."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List, Optional, Set

import pandas as pd

from scheduler.config import (
    AVAILABILITY_COLUMNS,
    DAY_NAMES,
    FRONT_DESK_ROLE,
    LEGACY_AVAILABILITY_COLUMNS,
    LEGACY_SLOT_MINUTES,
    LEGACY_TIME_SLOT_STARTS,
    SLOT_MINUTES,
    TIME_SLOT_STARTS,
    TRAVEL_BUFFER_AFTER_COLUMNS,
    TRAVEL_BUFFER_BEFORE_COLUMNS,
    is_slot_aligned_hours,
)
from scheduler.domain.models import StaffData, normalize_department_name


def _normalize_columns(df: pd.DataFrame) -> Dict[str, str]:
    """Create mapping from lowercase column names to original names."""
    normalized: Dict[str, str] = {}
    for column in df.columns:
        key = column.strip().lower()
        if key in normalized:
            raise ValueError(f"Duplicate column detected when normalizing headers: '{column}'")
        normalized[key] = column.strip()
    return normalized


def _parse_roles(raw_roles: Optional[str]) -> List[str]:
    """Parse roles from a semicolon/comma-separated string, normalized for matching.
    
    Handles both spaces and underscores: "Career Education" and "career_education"
    both become "career_education".
    """
    if pd.isna(raw_roles):
        return []
    return [normalize_department_name(role) for role in re.split(r"[;,]", str(raw_roles)) if role.strip()]


def _coerce_numeric(value, column_name: str, record_name: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ValueError(
            f"Invalid numeric value '{value}' for column '{column_name}' on record '{record_name}'"
        ) from None


def _coerce_bool_flag(value) -> bool:
    try:
        return int(float(value)) == 1
    except (TypeError, ValueError):
        return False


def _require_slot_aligned_hours(value: float, column_name: str, record_name: str) -> float:
    if not is_slot_aligned_hours(value):
        raise ValueError(
            f"Invalid hour value '{value}' for column '{column_name}' on record '{record_name}': "
            "values must align to the 10-minute slot grid."
        )
    return value


def _resolve_availability_schema(column_map: Dict[str, str], path: Path) -> str:
    has_current_grid = all(column.lower() in column_map for column in AVAILABILITY_COLUMNS)
    has_legacy_grid = all(column.lower() in column_map for column in LEGACY_AVAILABILITY_COLUMNS)

    if has_current_grid:
        return "current"
    if has_legacy_grid:
        return "legacy"

    missing_current = [col for col in AVAILABILITY_COLUMNS if col.lower() not in column_map]
    preview = ", ".join(missing_current[:5])
    suffix = "..." if len(missing_current) > 5 else ""
    raise ValueError(
        f"Missing availability columns in {path}: {preview}{suffix}. "
        "Provide either the full 10-minute grid or the legacy 30-minute grid."
    )


def load_staff_data(path: Path) -> StaffData:
    if not path.exists():
        raise FileNotFoundError(f"Staff CSV not found: {path}")

    df = pd.read_csv(path)
    df.columns = [col.strip() for col in df.columns]
    column_map = _normalize_columns(df)

    def require_column(name: str) -> str:
        if name not in column_map:
            raise ValueError(f"Required column '{name}' not found in {path}")
        return column_map[name]

    name_col = require_column("name")
    roles_col = require_column("roles")
    target_col = require_column("target_hours")
    max_col = require_column("max_hours")
    year_col = require_column("year")

    availability_schema = _resolve_availability_schema(column_map, path)
    legacy_stride = LEGACY_SLOT_MINUTES // SLOT_MINUTES

    employees: List[str] = []
    qual: Dict[str, Set[str]] = {}
    weekly_hour_limits: Dict[str, float] = {}
    target_weekly_hours: Dict[str, float] = {}
    employee_year: Dict[str, int] = {}
    unavailable: Dict[str, Dict[str, List[int]]] = {}
    all_roles: Set[str] = set()

    for _, row in df.iterrows():
        name = str(row[name_col]).strip()
        if not name:
            raise ValueError("Encountered employee row with empty name.")
        if name in qual:
            raise ValueError(f"Duplicate employee name detected: '{name}'")

        roles = _parse_roles(row[roles_col])
        if not roles:
            raise ValueError(f"Employee '{name}' must have at least one role defined.")
        role_set = set(roles)
        all_roles.update(role_set)
        qual[name] = role_set

        max_hours = _require_slot_aligned_hours(
            _coerce_numeric(row[max_col], max_col, name),
            max_col,
            name,
        )
        target_hours = min(
            _require_slot_aligned_hours(
                _coerce_numeric(row[target_col], target_col, name),
                target_col,
                name,
            ),
            max_hours,
        )
        weekly_hour_limits[name] = max_hours
        target_weekly_hours[name] = target_hours

        year_value = _coerce_numeric(row[year_col], year_col, name)
        employee_year[name] = int(year_value)

        availability: Dict[str, List[int]] = {}
        for day in DAY_NAMES:
            before_buffer_col = column_map.get(TRAVEL_BUFFER_BEFORE_COLUMNS[day].lower())
            after_buffer_col = column_map.get(TRAVEL_BUFFER_AFTER_COLUMNS[day].lower())
            before_buffer = _coerce_bool_flag(row[before_buffer_col]) if before_buffer_col else False
            after_buffer = _coerce_bool_flag(row[after_buffer_col]) if after_buffer_col else False

            raw_available: List[bool]
            if availability_schema == "current":
                raw_available = []
                for start_time in TIME_SLOT_STARTS:
                    column = column_map[f"{day}_{start_time}".lower()]
                    raw_available.append(_coerce_bool_flag(row[column]))
            else:
                raw_available = []
                for start_time in LEGACY_TIME_SLOT_STARTS:
                    column = column_map[f"{day}_{start_time}".lower()]
                    is_available = _coerce_bool_flag(row[column])
                    raw_available.extend([is_available] * legacy_stride)

            blocked_slots = set()
            if before_buffer:
                blocked_slots.update(
                    slot_index
                    for slot_index in range(len(raw_available) - 1)
                    if raw_available[slot_index] and not raw_available[slot_index + 1]
                )
            if after_buffer:
                blocked_slots.update(
                    slot_index
                    for slot_index in range(1, len(raw_available))
                    if raw_available[slot_index] and not raw_available[slot_index - 1]
                )

            unavailable_slots = [
                slot_index
                for slot_index, can_work in enumerate(raw_available)
                if not can_work or slot_index in blocked_slots
            ]
            if unavailable_slots:
                availability[day] = unavailable_slots
        if availability:
            unavailable[name] = availability

        employees.append(name)

    if FRONT_DESK_ROLE not in all_roles:
        raise ValueError(f"No employees qualified for required role '{FRONT_DESK_ROLE}'.")

    return StaffData(
        employees=employees,
        qual=qual,
        weekly_hour_limits=weekly_hour_limits,
        target_weekly_hours=target_weekly_hours,
        employee_year=employee_year,
        unavailable=unavailable,
        roles=sorted(all_roles),
    )

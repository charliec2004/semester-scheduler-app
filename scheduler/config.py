"""Centralized knobs for the scheduler. Tweak values here instead of touching the solver."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

# ---------------------------------------------------------------------------
# Calendar + availability grid configuration
# ---------------------------------------------------------------------------
DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri"]

SLOT_MINUTES = 10
LEGACY_SLOT_MINUTES = 30
MINUTES_PER_HOUR = 60
MINUTE_ALIGNMENT_TOLERANCE = 0.01
SLOTS_PER_HOUR = MINUTES_PER_HOUR / SLOT_MINUTES
DEPARTMENT_UNITS_PER_HOUR = int(SLOTS_PER_HOUR * 2)
TRAVEL_BUFFER_MINUTES = 10
DAY_START_MINUTES = 8 * MINUTES_PER_HOUR
DAY_END_MINUTES = 17 * MINUTES_PER_HOUR


def _format_24h(total_minutes: int) -> str:
    hours = total_minutes // MINUTES_PER_HOUR
    minutes = total_minutes % MINUTES_PER_HOUR
    return f"{hours:02d}:{minutes:02d}"


def _format_slot_range(start_minutes: int, end_minutes: int) -> str:
    def _format_12h(total_minutes: int) -> str:
        hours = total_minutes // MINUTES_PER_HOUR
        minutes = total_minutes % MINUTES_PER_HOUR
        suffix = "am" if hours < 12 else "pm"
        hour12 = hours % 12 or 12
        if minutes == 0:
            return f"{hour12}:00"
        return f"{hour12}:{minutes:02d}"

    return f"{_format_12h(start_minutes)}-{_format_12h(end_minutes)}"


def minutes_to_slots(minutes: int) -> int:
    if minutes % SLOT_MINUTES != 0:
        raise ValueError(f"{minutes} minutes is not divisible by the slot duration ({SLOT_MINUTES}).")
    return minutes // SLOT_MINUTES


def hours_to_slots(hours: float) -> int:
    minutes = float(hours) * MINUTES_PER_HOUR
    rounded_minutes = round(minutes)
    if (
        abs(minutes - rounded_minutes) > MINUTE_ALIGNMENT_TOLERANCE
        or rounded_minutes % SLOT_MINUTES != 0
    ):
        raise ValueError(
            f"{hours} hours is not aligned to the {SLOT_MINUTES}-minute slot grid."
        )
    return int(rounded_minutes // SLOT_MINUTES)


def is_slot_aligned_hours(hours: float) -> bool:
    minutes = float(hours) * MINUTES_PER_HOUR
    rounded_minutes = round(minutes)
    return (
        abs(minutes - rounded_minutes) <= MINUTE_ALIGNMENT_TOLERANCE
        and rounded_minutes % SLOT_MINUTES == 0
    )


def slots_to_hours(slots: int) -> float:
    return slots / SLOTS_PER_HOUR


def slot_index_to_start_minutes(slot_index: int) -> int:
    return DAY_START_MINUTES + (slot_index * SLOT_MINUTES)


def legacy_per_slot_weight(weight: int | float) -> int:
    return int(round(weight * SLOT_MINUTES / LEGACY_SLOT_MINUTES))


TIME_SLOT_STARTS = [
    _format_24h(total_minutes)
    for total_minutes in range(DAY_START_MINUTES, DAY_END_MINUTES, SLOT_MINUTES)
]
LEGACY_TIME_SLOT_STARTS = [
    _format_24h(total_minutes)
    for total_minutes in range(DAY_START_MINUTES, DAY_END_MINUTES, LEGACY_SLOT_MINUTES)
]

SLOT_NAMES = [
    _format_slot_range(total_minutes, total_minutes + SLOT_MINUTES)
    for total_minutes in range(DAY_START_MINUTES, DAY_END_MINUTES, SLOT_MINUTES)
]

AVAILABILITY_COLUMNS = [f"{day}_{time}" for day in DAY_NAMES for time in TIME_SLOT_STARTS]
LEGACY_AVAILABILITY_COLUMNS = [f"{day}_{time}" for day in DAY_NAMES for time in LEGACY_TIME_SLOT_STARTS]
TRAVEL_BUFFER_BEFORE_COLUMNS = {day: f"{day}_before_next_commitment" for day in DAY_NAMES}
TRAVEL_BUFFER_AFTER_COLUMNS = {day: f"{day}_after_previous_commitment" for day in DAY_NAMES}
T_SLOTS = list(range(len(SLOT_NAMES)))

# ---------------------------------------------------------------------------
# Role + shift defaults
# ---------------------------------------------------------------------------
FRONT_DESK_ROLE = "front_desk"
DEPARTMENT_HOUR_THRESHOLD = 4  # Allowable +/- hour wiggle room for departments

MIN_SLOTS = hours_to_slots(2)  # 2 hours minimum shift
MAX_SLOTS = hours_to_slots(4)  # 4 hours maximum shift
MIN_FRONT_DESK_SLOTS = MIN_SLOTS  # Front desk shifts must meet the same minimum length
FAVORED_MIN_SLOTS = hours_to_slots(1)  # Favored employees must still work at least 1 hour
FAVORED_MAX_SLOTS = hours_to_slots(8)  # Favored employees can work up to 8 hours in a day
TRAVEL_BUFFER_SLOTS = minutes_to_slots(TRAVEL_BUFFER_MINUTES)

TRAINING_MIN_HOURS = 1  # Minimum overlapping hours for training pairs
TRAINING_MIN_SLOTS = hours_to_slots(TRAINING_MIN_HOURS)
TRAINING_TARGET_FRACTION = 0.35  # Portion of the smaller target hours to aim for
TRAINING_OVERLAP_WEIGHT = 5000  # Penalty weight for missing training overlap target
TRAINING_OVERLAP_BONUS = legacy_per_slot_weight(200)  # Bonus per slot where trainees overlap in the department

FAVOR_DEPARTMENT_TARGET_MULTIPLIER = 1.5  # Boost favored departments' target adherence
FAVORED_DEPARTMENT_FOCUSED_BONUS = legacy_per_slot_weight(30)  # Bonus per focused slot for favored departments
FAVORED_DEPARTMENT_DUAL_PENALTY = legacy_per_slot_weight(20)  # Penalty per dual-counted slot for favored departments
FAVORED_FRONT_DESK_DEPT_BONUS = legacy_per_slot_weight(40)  # Bonus per front desk slot filled by favored department members
FAVORED_EMPLOYEE_DEPT_BONUS = legacy_per_slot_weight(50)  # Bonus per slot when a favored employee works their preferred department
TARGET_HARD_DELTA_HOURS = 5  # Hard bound: keep each employee within +/- this many hours of target (when feasible)

# ---------------------------------------------------------------------------
# Solver + objective tuning knobs
# ---------------------------------------------------------------------------
DEFAULT_SOLVER_MAX_TIME = 180  # Seconds

FRONT_DESK_COVERAGE_WEIGHT = legacy_per_slot_weight(10_000)  # Weight applied to every covered slot
SHIFT_LENGTH_DAILY_COST = hours_to_slots(3)  # Slots subtracted per worked day (encourages longer blocks)
DEPARTMENT_SCARCITY_BASE_WEIGHT = 10.0  # Higher values penalize pulling scarce dept staff to front desk
TIMESET_BONUS_WEIGHT = 20_000  # Huge bonus for satisfying --timeset requests

YEAR_TARGET_MULTIPLIERS = {  # Target-hour adherence weight by academic year
    1: 1.0,
    2: 1.2,
    3: 1.5,
    4: 2.0,
}

LARGE_DEVIATION_SLOT_THRESHOLD = hours_to_slots(2)  # 2 hours from target
EMPLOYEE_LARGE_DEVIATION_PENALTY = 5000  # Per-employee massive penalty
DEPARTMENT_LARGE_DEVIATION_PENALTY = 4000  # Per-department penalty when missing ±threshold
FAVOR_TARGET_MULTIPLIER = 10  # Additional weight for favored employees' target adherence
FAVORED_HOURS_BONUS_WEIGHT = legacy_per_slot_weight(200)  # Bonus per slot worked by favored employees

COLLABORATION_MINIMUM_HOURS: Dict[str, int] = {
    # Expected collaborative hours (2+ people in the same department simultaneously)
    "career_education": 1,
    "marketing": 1,
    "employer_engagement": 2,
    "events": 4,
    "data_systems": 0,  # Single-person team; no collaboration requirement
}


@dataclass(frozen=True)
class ObjectiveWeights:
    """Scalar weights applied to each score/penalty component in the objective."""

    department_target: float = legacy_per_slot_weight(1000.0)
    collaborative_hours: float = legacy_per_slot_weight(200.0)
    office_coverage: float = legacy_per_slot_weight(150.0)
    single_coverage: float = legacy_per_slot_weight(500.0)
    target_adherence: float = legacy_per_slot_weight(100.0)
    department_spread: float = legacy_per_slot_weight(60.0)
    department_day_coverage: float = 30.0
    shift_length: float = legacy_per_slot_weight(20.0)
    department_scarcity: float = legacy_per_slot_weight(8.0)
    underclassmen_front_desk: float = legacy_per_slot_weight(3.0)
    morning_preference: float = 0.5 / (LEGACY_SLOT_MINUTES / SLOT_MINUTES)
    department_total: float = 1.0 / (LEGACY_SLOT_MINUTES / SLOT_MINUTES)


OBJECTIVE_WEIGHTS = ObjectiveWeights()

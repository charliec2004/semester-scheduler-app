"""Command-line interface for the semester scheduler."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from scheduler.config import DAY_NAMES, DEFAULT_SOLVER_MAX_TIME, MAX_SLOTS, MIN_SLOTS, SLOT_MINUTES, TIME_SLOT_STARTS
from scheduler.domain.models import (
    EqualityRequest,
    FavoredEmployeeDepartment,
    ShiftTimePreference,
    TimesetRequest,
    TrainingRequest,
    normalize_department_name,
)
from scheduler.engine.solver import solve_schedule


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate an optimized weekly schedule for CPD student employees."
    )
    parser.add_argument(
        "staff_csv",
        type=Path,
        help="CSV file containing employee information, roles, hours, and availability.",
    )
    parser.add_argument(
        "requirements_csv",
        type=Path,
        help="CSV file specifying department hour targets and maximums.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("schedule.xlsx"),
        help="Destination path for the exported Excel schedule (default: schedule.xlsx).",
    )
    parser.add_argument(
        "--max-solve-seconds",
        type=int,
        default=None,
        help="Optional override for the solver time limit in seconds.",
    )
    parser.add_argument(
        "--favor",
        "-f",
        action="append",
        default=[],
        metavar="EMPLOYEE[:MULT]",
        help=(
            "Employee name to prioritize hitting target hours, with optional multiplier (default 1.0). "
            "Higher multiplier = stronger preference. Use multiple times to favor more than one person."
        ),
    )
    parser.add_argument(
        "--training",
        action="append",
        default=[],
        metavar="DEPT,PERSON1,PERSON2",
        help=(
            "Specify a training trio: department,trainee1,trainee2 (brackets optional). "
            "Use multiple times for multiple training pairs."
        ),
    )
    parser.add_argument(
        "--favor-dept",
        action="append",
        default=[],
        metavar="DEPT[:MULT]",
        help=(
            "Softly favor a department: DEPT or DEPT:multiplier to boost focused hours and target adherence. "
            "Repeatable."
        ),
    )
    parser.add_argument(
        "--favor-frontdesk-dept",
        action="append",
        default=[],
        metavar="DEPT[:MULT]",
        help=(
            "Softly favor a department's members for front desk duty. Optional multiplier (default 1.0). "
            "Repeatable."
        ),
    )
    parser.add_argument(
        "--progress",
        action="store_true",
        help="Show a simple progress timer toward the max solve time.",
    )
    parser.add_argument(
        "--timeset",
        action="append",
        nargs=5,
        metavar=("NAME", "DAY", "DEPT", "START", "END"),
        default=[],
        help=(
            "Strongly enforce assigning NAME to DEPT on DAY from START (inclusive) to END (exclusive) "
            f"in {SLOT_MINUTES}-minute increments. Repeatable."
        ),
    )
    parser.add_argument(
        "--favor-employee-dept",
        action="append",
        default=[],
        metavar="EMPLOYEE,DEPT[:MULT]",
        help=(
            "Softly favor assigning EMPLOYEE to work in DEPT with optional multiplier (default 1.0). "
            "Higher multiplier = stronger preference. Employee must be qualified. Repeatable."
        ),
    )
    parser.add_argument(
        "--shift-pref",
        action="append",
        default=[],
        metavar="EMPLOYEE,DAY,PREF",
        help=(
            "Soft preference for an employee's shift time on a specific day. "
            "PREF should be 'morning' (8am-12pm) or 'afternoon' (12pm-5pm). Repeatable."
        ),
    )
    parser.add_argument(
        "--equality",
        action="append",
        default=[],
        metavar="DEPT,PERSON1,PERSON2",
        help=(
            "Soft constraint to equalize hours between two employees in a specific department. "
            "Both must be qualified for the department. Repeatable."
        ),
    )
    parser.add_argument(
        "--enforce-min-dept-block",
        action="store_true",
        default=True,
        dest="enforce_min_dept_block",
        help="Enforce 2-hour minimum for non-Front-Desk department blocks (default: enabled).",
    )
    parser.add_argument(
        "--no-enforce-min-dept-block",
        action="store_false",
        dest="enforce_min_dept_block",
        help="Disable 2-hour minimum department block enforcement.",
    )
    # Settings-based overrides (from UI Settings panel)
    parser.add_argument(
        "--min-slots",
        type=int,
        default=None,
        help=f"Minimum shift length in {SLOT_MINUTES}-minute slots (default: {MIN_SLOTS} = 2 hours).",
    )
    parser.add_argument(
        "--max-slots",
        type=int,
        default=None,
        help=f"Maximum shift length in {SLOT_MINUTES}-minute slots (default: {MAX_SLOTS} = 4 hours).",
    )
    parser.add_argument(
        "--front-desk-weight",
        type=int,
        default=None,
        help="Weight for front desk coverage priority (default: 10000).",
    )
    parser.add_argument(
        "--dept-target-weight",
        type=int,
        default=None,
        help="Weight for department target adherence (default: 1000).",
    )
    parser.add_argument(
        "--target-adherence-weight",
        type=int,
        default=None,
        help="Weight for employee target adherence (default: 100).",
    )
    parser.add_argument(
        "--collab-weight",
        type=int,
        default=None,
        help="Weight for collaborative hours bonus (default: 200).",
    )
    parser.add_argument(
        "--shift-length-weight",
        type=int,
        default=None,
        help="Weight for shift length bonus (default: 20).",
    )
    parser.add_argument(
        "--favor-emp-dept-weight",
        type=int,
        default=None,
        help="Bonus per slot for favored employee-department pairings (default: 50).",
    )
    parser.add_argument(
        "--dept-hour-threshold",
        type=int,
        default=None,
        help="Allowable +/- hours from department targets (default: 4).",
    )
    parser.add_argument(
        "--target-hard-delta",
        type=int,
        default=None,
        help="Hard bound: keep employees within +/- this many hours of target (default: 5).",
    )
    return parser


def _parse_favored_employees(raw: list[str]) -> dict[str, float]:
    """Parse --favor arguments into dict of employee name -> multiplier.
    
    Format: EMPLOYEE or EMPLOYEE:MULTIPLIER
    """
    favored: dict[str, float] = {}
    for entry in raw:
        value = entry.strip()
        if not value:
            continue
        if ":" in value:
            emp, mult = value.split(":", 1)
            emp = emp.strip()
            try:
                multiplier = float(mult.strip())
            except ValueError:
                raise ValueError(f"Invalid --favor multiplier in '{entry}'. Expected a number after ':'.") from None
        else:
            emp = value
            multiplier = 1.0
        if not emp:
            raise ValueError(f"Invalid --favor value '{entry}'. Employee name is required.")
        favored[emp] = multiplier
    return favored


def _parse_training_args(raw_training: list[str]) -> list[TrainingRequest]:
    """Parse raw --training arguments into structured requests."""
    requests: list[TrainingRequest] = []
    for raw in raw_training:
        value = raw.strip()
        if value.startswith("[") and value.endswith("]"):
            value = value[1:-1]
        parts = [part.strip() for part in value.split(",") if part.strip()]
        if len(parts) != 3:
            raise ValueError(
                f"Invalid --training value '{raw}'. Expected format: DEPT,PERSON1,PERSON2"
            )
        dept, person_one, person_two = parts
        if person_one.lower() == person_two.lower():
            raise ValueError(f"Invalid --training value '{raw}': trainees must be different people.")
        requests.append(
            TrainingRequest(department=normalize_department_name(dept), trainee_one=person_one, trainee_two=person_two)
        )
    return requests


def _parse_favored_departments(raw: list[str]) -> dict[str, float]:
    favored: dict[str, float] = {}
    for entry in raw:
        value = entry.strip()
        if not value:
            continue
        if ":" in value:
            dept, mult = value.split(":", 1)
            dept = dept.strip()
            try:
                multiplier = float(mult.strip())
            except ValueError:
                raise ValueError(f"Invalid --favor-dept multiplier in '{entry}'. Expected a number after ':'.") from None
        else:
            dept = value
            multiplier = None
        if not dept:
            raise ValueError(f"Invalid --favor-dept value '{entry}'. Department name is required.")
        favored[normalize_department_name(dept)] = multiplier if multiplier is not None else 1.0
    return favored


def _parse_favored_fd_departments(raw: list[str]) -> dict[str, float]:
    favored: dict[str, float] = {}
    for entry in raw:
        value = entry.strip()
        if not value:
            continue
        if ":" in value:
            dept, mult = value.split(":", 1)
            dept = dept.strip()
            try:
                multiplier = float(mult.strip())
            except ValueError:
                raise ValueError(f"Invalid --favor-frontdesk-dept multiplier in '{entry}'. Expected a number after ':'.") from None
        else:
            dept = value
            multiplier = None
        if not dept:
            raise ValueError(f"Invalid --favor-frontdesk-dept value '{entry}'. Department name is required.")
        favored[normalize_department_name(dept)] = multiplier if multiplier is not None else 1.0
    return favored


def _parse_favored_employee_depts(raw: list[str]) -> list[FavoredEmployeeDepartment]:
    """Parse --favor-employee-dept arguments into structured requests.
    
    Format: EMPLOYEE,DEPT or EMPLOYEE,DEPT:MULTIPLIER
    """
    result: list[FavoredEmployeeDepartment] = []
    for entry in raw:
        value = entry.strip()
        if not value:
            continue
        parts = [p.strip() for p in value.split(",")]
        if len(parts) != 2:
            raise ValueError(
                f"Invalid --favor-employee-dept value '{entry}'. Expected format: EMPLOYEE,DEPT[:MULT]"
            )
        employee, dept_part = parts
        
        # Parse optional multiplier from department part (DEPT or DEPT:MULT)
        multiplier = 1.0
        if ":" in dept_part:
            dept, mult_str = dept_part.split(":", 1)
            dept = dept.strip()
            try:
                multiplier = float(mult_str.strip())
            except ValueError:
                raise ValueError(
                    f"Invalid --favor-employee-dept multiplier in '{entry}'. Expected a number after ':'."
                ) from None
        else:
            dept = dept_part
        
        if not employee or not dept:
            raise ValueError(
                f"Invalid --favor-employee-dept value '{entry}'. Both employee and department are required."
            )
        result.append(FavoredEmployeeDepartment(employee=employee, department=normalize_department_name(dept), multiplier=multiplier))
    return result


def _parse_shift_time_preferences(raw: list[str]) -> list[ShiftTimePreference]:
    """Parse --shift-pref arguments into structured requests.
    
    Format: EMPLOYEE,DAY,PREFERENCE (morning or afternoon)
    """
    day_lookup = {d.lower(): d for d in DAY_NAMES}
    result: list[ShiftTimePreference] = []
    for entry in raw:
        value = entry.strip()
        if not value:
            continue
        parts = [p.strip() for p in value.split(",")]
        if len(parts) != 3:
            raise ValueError(
                f"Invalid --shift-pref value '{entry}'. Expected format: EMPLOYEE,DAY,PREFERENCE"
            )
        employee, day, preference = parts
        
        # Normalize day name
        day_lower = day.lower()
        normalized_day = None
        for name in DAY_NAMES:
            if day_lower == name.lower() or day_lower == name.lower()[:3]:
                normalized_day = name
                break
        if not normalized_day:
            raise ValueError(
                f"Invalid day '{day}' in --shift-pref '{entry}'. Use one of: {', '.join(DAY_NAMES)}."
            )
        
        # Validate preference
        pref_lower = preference.lower()
        if pref_lower not in ('morning', 'afternoon'):
            raise ValueError(
                f"Invalid preference '{preference}' in --shift-pref '{entry}'. Use 'morning' or 'afternoon'."
            )
        
        if not employee:
            raise ValueError(
                f"Invalid --shift-pref value '{entry}'. Employee name is required."
            )
        
        result.append(ShiftTimePreference(employee=employee, day=normalized_day, preference=pref_lower))
    return result


def _parse_equality_constraints(raw: list[str]) -> list[EqualityRequest]:
    """Parse --equality arguments into structured requests.
    
    Format: DEPT,PERSON1,PERSON2
    """
    result: list[EqualityRequest] = []
    for entry in raw:
        value = entry.strip()
        if value.startswith("[") and value.endswith("]"):
            value = value[1:-1]
        parts = [p.strip() for p in value.split(",")]
        if len(parts) != 3:
            raise ValueError(
                f"Invalid --equality value '{entry}'. Expected format: DEPT,PERSON1,PERSON2"
            )
        dept, person1, person2 = parts
        if not dept or not person1 or not person2:
            raise ValueError(
                f"Invalid --equality value '{entry}'. Department and both employee names are required."
            )
        if person1.lower() == person2.lower():
            raise ValueError(
                f"Invalid --equality value '{entry}': employees must be different people."
            )
        result.append(
            EqualityRequest(
                department=normalize_department_name(dept),
                employee1=person1,
                employee2=person2,
            )
        )
    return result


def _parse_timesets(raw_timesets: list[list[str]]) -> list[TimesetRequest]:
    """Parse --timeset entries into structured requests."""
    time_to_slot = {t: idx for idx, t in enumerate(TIME_SLOT_STARTS)}
    day_lookup = {d.lower(): d for d in DAY_NAMES}
    last_start_minutes = int(TIME_SLOT_STARTS[-1].split(":")[0]) * 60 + int(TIME_SLOT_STARTS[-1].split(":")[1])
    final_edge_minutes = last_start_minutes + SLOT_MINUTES
    final_edge_label = f"{final_edge_minutes // 60:02d}:{final_edge_minutes % 60:02d}"

    def _normalize_day(day: str) -> str:
        key = day.strip().lower()
        for name in DAY_NAMES:
            lower = name.lower()
            if key == lower or key == lower[:3] or key.startswith(lower):
                return name
        if key in day_lookup:
            return day_lookup[key]
        raise ValueError(f"Invalid day '{day}' for --timeset. Use one of: {', '.join(DAY_NAMES)}.")

    def _normalize_time(value: str, *, is_end: bool = False) -> int:
        text = value.strip()
        if len(text) == 4 and text[1] == ":":
            text = f"0{text}"
        if is_end and text == final_edge_label:
            return len(TIME_SLOT_STARTS)
        if text not in time_to_slot:
            raise ValueError(
                f"Invalid time '{value}' for --timeset. Expected HH:MM on {SLOT_MINUTES}-minute increments "
                f"from {TIME_SLOT_STARTS[0]} to {TIME_SLOT_STARTS[-1]}."
            )
        return time_to_slot[text]

    requests: list[TimesetRequest] = []
    for entry in raw_timesets:
        if len(entry) != 5:
            raise ValueError(
                f"Invalid --timeset entry '{entry}'. Expected: NAME DAY DEPT START END ({SLOT_MINUTES}-minute aligned)."
            )
        name, day, dept, start, end = entry
        start_slot = _normalize_time(start)
        end_slot = _normalize_time(end, is_end=True)
        if end_slot <= start_slot:
            raise ValueError(f"--timeset end time must be after start time (got {start} to {end}).")
        requests.append(
            TimesetRequest(
                employee=name.strip(),
                day=_normalize_day(day),
                department=normalize_department_name(dept),
                start_slot=start_slot,
                end_slot=end_slot,
            )
        )
    return requests


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        time_limit = args.max_solve_seconds if args.max_solve_seconds is not None else DEFAULT_SOLVER_MAX_TIME
        training_requests = _parse_training_args(args.training)
        favored_departments = _parse_favored_departments(args.favor_dept)
        favored_frontdesk_departments = _parse_favored_fd_departments(args.favor_frontdesk_dept)
        timeset_requests = _parse_timesets(args.timeset)
        favored_employee_depts = _parse_favored_employee_depts(args.favor_employee_dept)
        shift_time_preferences = _parse_shift_time_preferences(args.shift_pref)
        equality_requests = _parse_equality_constraints(args.equality)
        output_path = args.output
        if not str(output_path).lower().endswith(".xlsx"):
            output_path = output_path.with_name(output_path.name + ".xlsx")
        favored_employees = _parse_favored_employees(args.favor)
        status = solve_schedule(
            staff_csv=args.staff_csv,
            requirements_csv=args.requirements_csv,
            output_path=output_path,
            solver_max_time=time_limit,
            favored_employees=favored_employees,
            training_requests=training_requests,
            favored_departments=favored_departments,
            favored_frontdesk_departments=favored_frontdesk_departments,
            timeset_requests=timeset_requests,
            favored_employee_depts=favored_employee_depts,
            shift_time_preferences=shift_time_preferences,
            equality_requests=equality_requests,
            show_progress=args.progress,
            enforce_min_dept_block=args.enforce_min_dept_block,
            # Settings overrides
            min_slots_override=args.min_slots,
            max_slots_override=args.max_slots,
            front_desk_weight_override=args.front_desk_weight,
            dept_target_weight_override=args.dept_target_weight,
            target_adherence_weight_override=args.target_adherence_weight,
            collab_weight_override=args.collab_weight,
            shift_length_weight_override=args.shift_length_weight,
            favor_emp_dept_weight_override=args.favor_emp_dept_weight,
            dept_hour_threshold_override=args.dept_hour_threshold,
            target_hard_delta_override=args.target_hard_delta,
        )
        # Exit with error code if no solution found (INFEASIBLE or other non-success status)
        from ortools.sat.python import cp_model
        if status not in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
            sys.exit(2)  # Exit code 2 = no solution found (distinct from 1 = exception)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

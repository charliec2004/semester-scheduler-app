from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Dict, List, Set
import threading

from ortools.sat.python import cp_model

from scheduler.config import (
    COLLABORATION_MINIMUM_HOURS,
    DAY_NAMES,
    DAY_END_MINUTES,
    DEFAULT_SOLVER_MAX_TIME,
    DEPARTMENT_UNITS_PER_HOUR,
    DEPARTMENT_HOUR_THRESHOLD,
    DEPARTMENT_LARGE_DEVIATION_PENALTY,
    DEPARTMENT_SCARCITY_BASE_WEIGHT,
    EMPLOYEE_LARGE_DEVIATION_PENALTY,
    FAVORED_MIN_SLOTS,
    FAVORED_MAX_SLOTS,
    FAVORED_HOURS_BONUS_WEIGHT,
    FAVORED_EMPLOYEE_DEPT_BONUS,
    FAVOR_TARGET_MULTIPLIER,
    FRONT_DESK_COVERAGE_WEIGHT,
    FRONT_DESK_ROLE,
    LARGE_DEVIATION_SLOT_THRESHOLD,
    MAX_SLOTS,
    MIN_FRONT_DESK_SLOTS,
    MIN_SLOTS,
    OBJECTIVE_WEIGHTS,
    ObjectiveWeights,
    SHIFT_LENGTH_DAILY_COST,
    SLOT_NAMES,
    T_SLOTS,
    YEAR_TARGET_MULTIPLIERS,
    TRAINING_MIN_SLOTS,
    TRAINING_OVERLAP_WEIGHT,
    TRAINING_TARGET_FRACTION,
    TRAINING_OVERLAP_BONUS,
    FAVOR_DEPARTMENT_TARGET_MULTIPLIER,
    FAVORED_DEPARTMENT_FOCUSED_BONUS,
    FAVORED_DEPARTMENT_DUAL_PENALTY,
    FAVORED_FRONT_DESK_DEPT_BONUS,
    TARGET_HARD_DELTA_HOURS,
    TIME_SLOT_STARTS,
    TIMESET_BONUS_WEIGHT,
    hours_to_slots,
    legacy_per_slot_weight,
    slots_to_hours,
)
from scheduler.data_access.department_loader import load_department_requirements
from scheduler.data_access.staff_loader import load_staff_data
from scheduler.domain.models import (
    EqualityRequest,
    FavoredDepartment,
    FavoredEmployeeDepartment,
    FavoredFrontDeskDepartment,
    ShiftTimePreference,
    TimesetRequest,
    TrainingRequest,
    normalize_department_name,
)
from scheduler.reporting.console import print_schedule
from scheduler.reporting.export import export_schedule_to_excel, export_formatted_schedule


def solve_schedule(
    staff_csv: Path,
    requirements_csv: Path,
    output_path: Path,
    solver_max_time: int = DEFAULT_SOLVER_MAX_TIME,
    favored_employees: dict[str, float] | None = None,  # employee name -> multiplier
    training_requests: List[TrainingRequest] | None = None,
    favored_departments: dict[str, float] | None = None,
    favored_frontdesk_departments: dict[str, float] | None = None,
    timeset_requests: List[TimesetRequest] | None = None,
    favored_employee_depts: List[FavoredEmployeeDepartment] | None = None,
    shift_time_preferences: List["ShiftTimePreference"] | None = None,
    equality_requests: List[EqualityRequest] | None = None,
    show_progress: bool = False,
    enforce_min_dept_block: bool = True,
    # Settings overrides (from UI Settings panel)
    min_slots_override: int | None = None,
    max_slots_override: int | None = None,
    front_desk_weight_override: int | None = None,
    dept_target_weight_override: int | None = None,
    target_adherence_weight_override: int | None = None,
    collab_weight_override: int | None = None,
    shift_length_weight_override: int | None = None,
    favor_emp_dept_weight_override: int | None = None,
    dept_hour_threshold_override: int | None = None,
    target_hard_delta_override: int | None = None,
):
    """Main function to build and solve the scheduling model"""
    
    # Apply settings overrides (or use config defaults)
    MIN_SLOTS_LOCAL = min_slots_override if min_slots_override is not None else MIN_SLOTS
    MAX_SLOTS_LOCAL = max_slots_override if max_slots_override is not None else MAX_SLOTS
    FRONT_DESK_COVERAGE_WEIGHT_LOCAL = front_desk_weight_override if front_desk_weight_override is not None else FRONT_DESK_COVERAGE_WEIGHT
    DEPARTMENT_HOUR_THRESHOLD_LOCAL = dept_hour_threshold_override if dept_hour_threshold_override is not None else DEPARTMENT_HOUR_THRESHOLD
    TARGET_HARD_DELTA_HOURS_LOCAL = target_hard_delta_override if target_hard_delta_override is not None else TARGET_HARD_DELTA_HOURS
    FAVORED_EMPLOYEE_DEPT_BONUS_LOCAL = favor_emp_dept_weight_override if favor_emp_dept_weight_override is not None else FAVORED_EMPLOYEE_DEPT_BONUS
    
    # Build custom objective weights with overrides
    objective_weights = ObjectiveWeights(
        department_target=dept_target_weight_override if dept_target_weight_override is not None else OBJECTIVE_WEIGHTS.department_target,
        collaborative_hours=collab_weight_override if collab_weight_override is not None else OBJECTIVE_WEIGHTS.collaborative_hours,
        target_adherence=target_adherence_weight_override if target_adherence_weight_override is not None else OBJECTIVE_WEIGHTS.target_adherence,
        shift_length=shift_length_weight_override if shift_length_weight_override is not None else OBJECTIVE_WEIGHTS.shift_length,
        # Keep other weights at defaults
        office_coverage=OBJECTIVE_WEIGHTS.office_coverage,
        single_coverage=OBJECTIVE_WEIGHTS.single_coverage,
        department_spread=OBJECTIVE_WEIGHTS.department_spread,
        department_day_coverage=OBJECTIVE_WEIGHTS.department_day_coverage,
        department_scarcity=OBJECTIVE_WEIGHTS.department_scarcity,
        underclassmen_front_desk=OBJECTIVE_WEIGHTS.underclassmen_front_desk,
        morning_preference=OBJECTIVE_WEIGHTS.morning_preference,
        department_total=OBJECTIVE_WEIGHTS.department_total,
    )

    staff_data = load_staff_data(staff_csv)
    department_requirements = load_department_requirements(requirements_csv)
    department_hour_targets_raw = department_requirements.targets
    department_max_hours_raw = department_requirements.max_hours
    # Normalize favored employees: lowercase name -> multiplier
    favored_employees_normalized: dict[str, float] = {
        emp.strip().lower(): mult 
        for emp, mult in (favored_employees or {}).items() 
        if str(emp).strip()
    }
    training_requests = training_requests or []
    favored_departments = favored_departments or {}
    favored_frontdesk_departments = favored_frontdesk_departments or {}
    timeset_requests = timeset_requests or []
    shift_time_preferences = shift_time_preferences or []
    equality_requests = equality_requests or []
    
    # ============================================================================
    # STEP 1: INITIALIZE THE CONSTRAINT PROGRAMMING MODEL
    # ============================================================================
    
    model = cp_model.CpModel()
    
    
    # ============================================================================
    # STEP 2: DEFINE THE PROBLEM DOMAIN
    # ============================================================================
    
    employees: List[str] = staff_data.employees
    qual: Dict[str, Set[str]] = staff_data.qual
    weekly_hour_limits = {emp: float(hours) for emp, hours in staff_data.weekly_hour_limits.items()}
    target_weekly_hours = {emp: float(hours) for emp, hours in staff_data.target_weekly_hours.items()}
    employee_year = {emp: int(year) for emp, year in staff_data.employee_year.items()}
    unavailable: Dict[str, Dict[str, List[int]]] = staff_data.unavailable
    
    days = DAY_NAMES[:]
    roles = list(staff_data.roles)
    if FRONT_DESK_ROLE not in roles:
        raise ValueError(f"Role '{FRONT_DESK_ROLE}' is required but missing from staff data.")
    roles = [FRONT_DESK_ROLE] + [role for role in roles if role != FRONT_DESK_ROLE]
    
    # Build department_roles in the order they appear in the departments CSV
    # This preserves user-defined ordering from the UI
    csv_order = department_requirements.order
    all_dept_roles = [role for role in roles if role != FRONT_DESK_ROLE]
    # Put departments in CSV order first, then any extras not in CSV
    department_roles = [r for r in csv_order if r in all_dept_roles]
    department_roles += [r for r in all_dept_roles if r not in csv_order]
    
    missing_targets = [role for role in department_roles if role not in department_hour_targets_raw]
    missing_max = [role for role in department_roles if role not in department_max_hours_raw]
    if missing_targets:
        raise ValueError(f"Department targets missing for: {', '.join(missing_targets)}")
    if missing_max:
        raise ValueError(f"Department max hours missing for: {', '.join(missing_max)}")
    extra_departments = [dept for dept in department_hour_targets_raw if dept not in roles]
    if extra_departments:
        print(f"WARNING: Ignoring department requirements with no matching role: {', '.join(extra_departments)}", file=sys.stderr)

    department_hour_targets = {
        role: float(department_hour_targets_raw[role])
        for role in department_roles
    }
    department_max_hours = {
        role: float(department_max_hours_raw[role])
        for role in department_roles
    }
    department_hour_threshold = DEPARTMENT_HOUR_THRESHOLD_LOCAL
    
    department_sizes = {
        role: sum(1 for employee in employees if role in qual[employee])
        for role in department_roles
    }
    zero_capacity_departments = [role for role, size in department_sizes.items() if size == 0]
    if zero_capacity_departments:
        raise ValueError(
            "No qualified employees found for departments: " + ", ".join(zero_capacity_departments)
        )
    
    ROLE_DISPLAY_NAMES = {
        role: " ".join(word.capitalize() for word in role.split("_"))
        for role in roles
    }
    ROLE_DISPLAY_NAMES[FRONT_DESK_ROLE] = "Front Desk"
    # Override with user's original names from CSV (preserves their capitalization)
    for normalized, original in department_requirements.display_names.items():
        if normalized in ROLE_DISPLAY_NAMES:
            ROLE_DISPLAY_NAMES[normalized] = original

    if favored_employees_normalized:
        unknown_favored = [
            name for name in favored_employees_normalized.keys() if name not in {emp.lower() for emp in employees}
        ]
        if unknown_favored:
            print(
                f"WARNING: Ignoring --favor names not found in staff data: {', '.join(sorted(unknown_favored))}",
                file=sys.stderr,
            )
    employees_lower = {emp.lower(): emp for emp in employees}
    role_lookup_lower = {normalize_department_name(role): role for role in department_roles}
    day_lookup_lower = {day.lower(): day for day in days}

    forced_assignments: Set[tuple[str, str, int, str]] = set()
    timeset_details: list[dict] = []  # Track details for diagnostics
    for req in timeset_requests:
        emp_key = req.employee.strip().lower()
        if emp_key not in employees_lower:
            raise ValueError(
                f"TIMESET ERROR: Employee '{req.employee}' not found.\n"
                f"  Available employees: {', '.join(sorted(employees)[:10])}{'...' if len(employees) > 10 else ''}\n"
                f"  Fix: Check spelling or add this employee to the Staff tab."
            )
        employee = employees_lower[emp_key]

        day_key = req.day.strip().lower()
        if day_key not in day_lookup_lower:
            raise ValueError(
                f"TIMESET ERROR: Day '{req.day}' is invalid.\n"
                f"  Valid days: {', '.join(days)}\n"
                f"  Fix: Use a valid weekday name."
            )
        day = day_lookup_lower[day_key]

        dept_key = normalize_department_name(req.department)
        if dept_key not in role_lookup_lower and dept_key != FRONT_DESK_ROLE:
            raise ValueError(
                f"TIMESET ERROR: Department '{req.department}' not found.\n"
                f"  Available departments: {', '.join(sorted(department_roles))}\n"
                f"  Fix: Check spelling or add this department to the Departments tab."
            )
        role_name = role_lookup_lower.get(dept_key, FRONT_DESK_ROLE if dept_key == FRONT_DESK_ROLE else dept_key)

        # Note: Qualification check removed - timesets can assign any employee to any department
        # The solver will create the necessary assignment variables even if the employee
        # isn't normally qualified for the role

        slots = list(range(req.start_slot, req.end_slot))
        if not slots:
            raise ValueError(
                f"TIMESET ERROR: Empty time range for {employee} on {day}.\n"
                f"  Fix: End time must be after start time."
            )

        unavailable_slots = set(unavailable.get(employee, {}).get(day, []))
        blocked = [SLOT_NAMES[t] for t in slots if t in unavailable_slots]
        if blocked:
            raise ValueError(
                f"TIMESET ERROR: {employee} is marked unavailable on {day} at: {', '.join(blocked)}.\n"
                f"  Fix: Either change their availability in the Staff tab, or choose a different time."
            )

        weekly_limit_slots = hours_to_slots(weekly_hour_limits.get(employee, 0))
        if weekly_limit_slots and len(slots) > weekly_limit_slots:
            raise ValueError(
                f"TIMESET ERROR: {employee}'s timeset requires {slots_to_hours(len(slots)):.1f} hours.\n"
                f"  Their max weekly hours is only {weekly_hour_limits[employee]:.1f}.\n"
                f"  Fix: Reduce the timeset duration or increase their max hours in the Staff tab."
            )

        # Check if employee is qualified for this role (warning only, not error)
        is_qualified = role_name in qual[employee]

        for t in slots:
            forced_assignments.add((employee, day, t, role_name))

        # Store details for diagnostics
        timeset_details.append({
            "employee": employee,
            "day": day,
            "role": role_name,
            "slots": slots,
            "slot_names": [SLOT_NAMES[t] for t in slots],
            "is_qualified": is_qualified,
        })

    # Print timeset summary
    if timeset_details:
        print(f"\nTimesets configured: {len(timeset_details)}")
        for ts in timeset_details:
            qual_note = "" if ts["is_qualified"] else " (special assignment)"
            # Get start and end times properly
            start_time = TIME_SLOT_STARTS[ts['slots'][0]]
            end_time = (
                TIME_SLOT_STARTS[ts['slots'][-1] + 1]
                if ts['slots'][-1] + 1 < len(TIME_SLOT_STARTS)
                else f"{DAY_END_MINUTES // 60:02d}:{DAY_END_MINUTES % 60:02d}"
            )
            print(f"  - {ts['employee']} -> {ts['role']} on {ts['day']} at {start_time}-{end_time}{qual_note}")

    favored_departments_normalized: Dict[str, FavoredDepartment] = {}
    for key, mult in favored_departments.items():
        dept_key = normalize_department_name(key)
        if dept_key not in role_lookup_lower:
            raise ValueError(f"--favor-dept department '{key}' not found among department roles.")
        role_name = role_lookup_lower[dept_key]
        multiplier = mult if mult is not None else 1.0
        favored_departments_normalized[role_name] = FavoredDepartment(name=role_name, multiplier=multiplier)
    favored_fd_departments_normalized: Dict[str, FavoredFrontDeskDepartment] = {}
    for key, mult in favored_frontdesk_departments.items():
        dept_key = normalize_department_name(key)
        if dept_key not in role_lookup_lower:
            raise ValueError(f"--favor-frontdesk-dept department '{key}' not found among department roles.")
        role_name = role_lookup_lower[dept_key]
        multiplier = mult if mult is not None else 1.0
        favored_fd_departments_normalized[role_name] = FavoredFrontDeskDepartment(name=role_name, multiplier=multiplier)

    # Validate and normalize --favor-employee-dept requests
    favored_employee_depts = favored_employee_depts or []
    validated_favored_emp_depts: List[FavoredEmployeeDepartment] = []
    for fed in favored_employee_depts:
        emp_key = fed.employee.strip().lower()
        if emp_key not in employees_lower:
            raise ValueError(f"--favor-employee-dept employee '{fed.employee}' not found in staff data.")
        employee = employees_lower[emp_key]
        
        dept_key = normalize_department_name(fed.department)
        
        # Special case: front_desk is a role, not a department
        if dept_key == FRONT_DESK_ROLE:
            role_name = FRONT_DESK_ROLE
        elif dept_key not in role_lookup_lower:
            raise ValueError(f"--favor-employee-dept role '{fed.department}' not found among roles.")
        else:
            role_name = role_lookup_lower[dept_key]
        
        # Verify employee is qualified for this role
        if role_name not in qual[employee]:
            raise ValueError(
                f"--favor-employee-dept: '{employee}' is not qualified for '{role_name}'. "
                f"Their qualifications are: {', '.join(qual[employee]) or 'none'}"
            )
        
        multiplier = getattr(fed, 'multiplier', 1.0) if hasattr(fed, 'multiplier') else 1.0
        validated_favored_emp_depts.append(FavoredEmployeeDepartment(employee=employee, department=role_name, multiplier=multiplier))

    validated_training: List[dict] = []
    for request in training_requests:
        dept_key = normalize_department_name(request.department)
        if dept_key not in role_lookup_lower:
            raise ValueError(f"--training department '{request.department}' not found among department roles.")
        dept_role = role_lookup_lower[dept_key]

        person_keys = []
        for person in (request.trainee_one, request.trainee_two):
            person_key = person.strip().lower()
            if person_key not in employees_lower:
                raise ValueError(f"--training person '{person}' not found in staff data.")
            person_keys.append(person_key)
        if person_keys[0] == person_keys[1]:
            raise ValueError("--training requires two distinct people.")

        trainee_one = employees_lower[person_keys[0]]
        trainee_two = employees_lower[person_keys[1]]
        if dept_role not in qual[trainee_one]:
            raise ValueError(f"--training person '{trainee_one}' is not qualified for department '{dept_role}'.")
        if dept_role not in qual[trainee_two]:
            raise ValueError(f"--training person '{trainee_two}' is not qualified for department '{dept_role}'.")

        min_target_slots = hours_to_slots(min(target_weekly_hours[trainee_one], target_weekly_hours[trainee_two]))
        if min_target_slots > 0:
            target_slots = int(round(min_target_slots * TRAINING_TARGET_FRACTION))
            goal_slots = max(TRAINING_MIN_SLOTS, target_slots)
            goal_slots = min(goal_slots, min_target_slots)
        else:
            goal_slots = 0

        validated_training.append(
            {
                "department": dept_role,
                "trainee_one": trainee_one,
                "trainee_two": trainee_two,
                "goal_slots": goal_slots,
            }
        )
    
    # Validate equality requests
    validated_equality: List[dict] = []
    for request in equality_requests:
        dept_key = normalize_department_name(request.department)
        if dept_key not in role_lookup_lower:
            raise ValueError(f"--equality department '{request.department}' not found among department roles.")
        dept_role = role_lookup_lower[dept_key]

        person_keys = []
        for person in (request.employee1, request.employee2):
            person_key = person.strip().lower()
            if person_key not in employees_lower:
                raise ValueError(f"--equality person '{person}' not found in staff data.")
            person_keys.append(person_key)
        if person_keys[0] == person_keys[1]:
            raise ValueError("--equality requires two distinct people.")

        employee1 = employees_lower[person_keys[0]]
        employee2 = employees_lower[person_keys[1]]
        if dept_role not in qual[employee1]:
            raise ValueError(f"--equality person '{employee1}' is not qualified for department '{dept_role}'.")
        if dept_role not in qual[employee2]:
            raise ValueError(f"--equality person '{employee2}' is not qualified for department '{dept_role}'.")

        validated_equality.append(
            {
                "department": dept_role,
                "employee1": employee1,
                "employee2": employee2,
            }
        )
    
    # Time slot configuration
    T = T_SLOTS

    # Choose a primary department for each employee (for dual front desk credit)
    primary_department_for_employee: Dict[str, str | None] = {}
    for e in employees:
        depts = [r for r in department_roles if r in qual[e]]
        if not depts:
            primary_department_for_employee[e] = None
        else:
            # Pick the smallest department (scarcer) to credit dual hours; tie-break alphabetically
            depts_sorted = sorted(depts, key=lambda r: (department_sizes[r], r))
            primary_department_for_employee[e] = depts_sorted[0]

    # Availability diagnostics (used if model is infeasible)
    front_desk_unavailable_slots: List[tuple[str, int]] = []
    for d in days:
        for t in T:
            available_fd = [
                e for e in employees if FRONT_DESK_ROLE in qual[e] and not (e in unavailable and d in unavailable[e] and t in unavailable[e][d])
            ]
            if not available_fd:
                front_desk_unavailable_slots.append((d, t))

    training_available_overlap: Dict[int, int] = {}

    # Precompute slots where each employee can legally work a minimum-length shift
    workable_slots = {}
    for e in employees:
        min_len = MIN_SLOTS_LOCAL if e.lower() not in favored_employees_normalized else FAVORED_MIN_SLOTS
        workable_slots[e] = {}
        for d in days:
            avail_slots = [t for t in T if not (e in unavailable and d in unavailable[e] and t in unavailable[e][d])]
            feasible = set()
            if avail_slots:
                start = prev = avail_slots[0]
                for s in avail_slots[1:] + [None]:
                    if s is not None and s == prev + 1:
                        prev = s
                        continue
                    run = list(range(start, prev + 1))
                    if len(run) >= min_len:
                        feasible.update(run)
                    if s is not None:
                        start = prev = s
                # handle last run included via sentinel
            workable_slots[e][d] = feasible
    
    
    # ============================================================================
    # STEP 3: DEFINE COVERAGE REQUIREMENTS
    # ============================================================================
    
    # Initialize demand dictionary: demand[role][day][time_slot]
    # Value of 1 means "we need 1 person in this role at this time"
    # Value of 0 means "no requirement for this role at this time"
    demand = {
        role: {                    # Dictionary (outer level)
            day: [0] * len(T)      # Dictionary (middle level) -> List (inner level)
            for day in days
        } for role in roles
    }
    
    # front_desk coverage is CRITICAL - must be present at all times
    for day in days:
        for time_slot in T:
            demand["front_desk"][day][time_slot] = 1
    
    # Note: Department roles have no fixed demand - they're assigned flexibly
    # based on availability and the objective function
    
    
    # ============================================================================
    # STEP 4 & STEP 5: QUALIFICATIONS AND AVAILABILITY
    # ============================================================================
    # Qualifications and availability are loaded from the staff CSV input.

    # ============================================================================
    # STEP 6: CREATE DECISION VARIABLES
    # ============================================================================
    
    # Boolean variable: Is employee 'e' working on day 'd' during time slot 't'?
    # work[e,d,t] = 1 means "yes", 0 means "no"
    work = {
        (e, d, t): model.new_bool_var(f"work[{e},{d},{t}]") 
        for e in employees 
        for d in days 
        for t in T
    }
    
    # Boolean variable: Does employee 'e' START their shift at time slot 't' on day 'd'?
    # Used to enforce continuous shift blocks
    start = {
        (e, d, t): model.new_bool_var(f"start[{e},{d},{t}]") 
        for e in employees 
        for d in days 
        for t in T
    }
    
    # Boolean variable: Does employee 'e' END their shift at time slot 't' on day 'd'?
    # Used to enforce continuous shift blocks
    end = {
        (e, d, t): model.new_bool_var(f"end[{e},{d},{t}]") 
        for e in employees 
        for d in days 
        for t in T
    }
    
    # Boolean variables to track front desk assignment transitions (ensures contiguous front desk duty)
    frontdesk_allowed_slots = {
        (e, d, t)
        for e in employees
        for d in days
        for t in T
        if FRONT_DESK_ROLE in qual[e] or (e, d, t, FRONT_DESK_ROLE) in forced_assignments
    }
    frontdesk_employees = {e for (e, _, _) in frontdesk_allowed_slots}
    frontdesk_start = {
        (e, d, t): model.new_bool_var(f"frontdesk_start[{e},{d},{t}]")
        for (e, d, t) in frontdesk_allowed_slots
    }
    frontdesk_end = {
        (e, d, t): model.new_bool_var(f"frontdesk_end[{e},{d},{t}]")
        for (e, d, t) in frontdesk_allowed_slots
    }
    
    # Boolean variable: Is employee 'e' assigned to role 'r' on day 'd' at time 't'?
    # Only create this variable if the employee is qualified for the role
    assign = {
        (e, d, t, r): model.new_bool_var(f"assign[{e},{d},{t},{r}]")
        for e in employees 
        for d in days 
        for t in T 
        for r in roles 
        if r in qual[e] or (e, d, t, r) in forced_assignments  # Include forced assignments even if not normally qualified
    }

    # Enforce timeset requests: lock work/assignment to 1 for requested slots
    for (e, d, t, r) in forced_assignments:
        if (e, d, t, r) not in assign:
            print(f"ERROR: Missing assignment variable for timeset: {e}, {d}, slot {t}, {r}")
            print(f"  Role '{r}' in roles list: {r in roles}")
            print(f"  Employee qualifications: {qual.get(e, [])}")
            raise ValueError(
                f"TIMESET ERROR: Cannot create assignment for {e} -> {r} on {d}.\n"
                f"  The role '{r}' may not be configured correctly.\n"
                f"  Fix: Make sure at least one employee is qualified for '{r}' in the Staff tab."
            )
        # Check for conflict with availability constraints
        if e in unavailable and d in unavailable[e] and t in unavailable[e][d]:
            print(f"  WARNING: Timeset conflict - {e} has {r} timeset at {d} slot {t}, but marked unavailable!")
        model.add(work[e, d, t] == 1)
        model.add(assign[(e, d, t, r)] == 1)
        print(f"  Forced: {e} must work {r} on {d} slot {t} ({SLOT_NAMES[t]})")

    # Track which (employee, day) pairs have forced assignments - these are exempt from min shift constraints
    forced_employee_days: Set[tuple[str, str]] = {(e, d) for (e, d, t, r) in forced_assignments}

    # Track which (employee, day) pairs have GAPS in their timesets (need split shifts)
    # A gap exists if the forced slots are not contiguous
    from collections import defaultdict
    emp_day_slots = defaultdict(set)
    for (emp, day, slot, role) in forced_assignments:
        emp_day_slots[(emp, day)].add(slot)

    # Track forced slot count per employee-day (for adjusting max constraint)
    forced_slot_count: dict[tuple[str, str], int] = {
        (emp, day): len(slots) for (emp, day), slots in emp_day_slots.items()
    }

    forced_employee_days_with_gaps: Set[tuple[str, str]] = set()
    for (emp, day), slots in emp_day_slots.items():
        sorted_slots = sorted(slots)
        # Check for gaps: if any consecutive slots differ by more than 1, there's a gap
        has_gap = any(sorted_slots[i+1] - sorted_slots[i] > 1 for i in range(len(sorted_slots)-1))
        if has_gap:
            forced_employee_days_with_gaps.add((emp, day))

    # Collect any roles from forced assignments that might not be in the standard roles list
    forced_roles: Set[str] = {r for (_, _, _, r) in forced_assignments}
    all_roles_including_forced = list(set(roles) | forced_roles)


    # ============================================================================
    # STEP 7: ADD SHIFT CONTIGUITY CONSTRAINTS
    # ============================================================================
    # Default: one continuous block per day (no split shifts).
    # Split shifts are ONLY allowed when timesets create gaps (non-contiguous forced slots).

    for e in employees:
        is_favored = e.lower() in favored_employees_normalized
        for d in days:
            # Allow split shifts ONLY when timesets create gaps (non-contiguous forced slots)
            # No one else gets split shifts - not even favored employees
            needs_split_shift = (e, d) in forced_employee_days_with_gaps
            effective_max_shifts = 2 if needs_split_shift else 1

            # Constraint 7.1: Limit shift starts per day
            # Default: one shift start (continuous block)
            # Exception: Days with timeset gaps allow 2 starts (timesets create multiple blocks)
            model.add(sum(start[e, d, t] for t in T) <= effective_max_shifts)

            # Constraint 7.2: Matching number of shift ends per day
            model.add(sum(end[e, d, t] for t in T) <= effective_max_shifts)
            
            # Constraint 7.2b: Number of starts must equal number of ends
            # This ensures if someone starts, they must end (and vice versa)
            model.add(sum(start[e, d, t] for t in T) == sum(end[e, d, t] for t in T))
            
            # Constraint 7.3: First time slot boundary
            # If working at time 0, that must be the start (no previous slot exists)
            model.add(work[e, d, 0] == start[e, d, 0])
            
            # Constraint 7.4: Internal time slot transitions
            # This is the KEY constraint for continuous blocks
            # For each time slot after the first:
            #   - If work changes from 0→1, we started (start=1, end(prev)=0)
            #   - If work changes from 1→0, we ended (start=0, end(prev)=1)
            #   - If work stays same, no transition (start=0, end(prev)=0)
            for t in T[1:]:
                model.add(
                    work[e, d, t] - work[e, d, t-1] == start[e, d, t] - end[e, d, t-1]
                )
            
            # Constraint 7.5: Last time slot boundary
            # If working in the last slot, that must be the end (no next slot exists)
            model.add(end[e, d, T[-1]] == work[e, d, T[-1]])
            
            # Calculate total slots worked this day
            total_slots_today = sum(work[e, d, t] for t in T)
            
            # Constraint 7.6 & 7.7: HARD minimum shift length constraint
            # Non-favored: 4 slots (2 hours). Favored: 2 slots (1 hour).
            
            # CRITICAL HARD CONSTRAINT: Enforce minimum shift length
            # We cannot use a simple indicator variable because it creates weak implications
            # Instead, we use a direct constraint: total_slots must be EITHER 0 OR >= MIN_SLOTS
            # 
            # Create boolean: is employee working today?
            works_today = model.new_bool_var(f"works_today[{e},{d}]")
            
            # Force works_today to be 1 if and only if total_slots_today > 0
            # This creates a tight bidirectional link
            model.add(total_slots_today >= 1).only_enforce_if(works_today)
            model.add(total_slots_today == 0).only_enforce_if(works_today.Not())
            
            # Check if this employee/day has a forced assignment (timeset)
            # If so, exempt from minimum shift constraints - the user explicitly wants this shift length
            has_forced_assignment = (e, d) in forced_employee_days

            # HARD CONSTRAINT: If working (works_today=1), MUST meet min slots by favor status
            # EXCEPTION: Days with forced assignments (timesets) are exempt from minimum
            if not has_forced_assignment:
                min_slots_today = FAVORED_MIN_SLOTS if is_favored else MIN_SLOTS_LOCAL
                model.add(total_slots_today >= min_slots_today).only_enforce_if(works_today)

            # HARD CONSTRAINT: If not working (works_today=0), total must be exactly 0
            model.add(total_slots_today == 0).only_enforce_if(works_today.Not())

            # Maximum shift length
            # If timesets force more slots than the standard max, use the forced count as the minimum max
            standard_max = FAVORED_MAX_SLOTS if is_favored else MAX_SLOTS_LOCAL
            forced_slots = forced_slot_count.get((e, d), 0)
            max_slots_today = max(standard_max, forced_slots)

            model.add(total_slots_today <= max_slots_today)

            # Block tiny shifts UNLESS this day has a forced assignment.
            # Non-favored staff need 2 hours minimum; favored staff still need at least 1 hour.
            if not has_forced_assignment:
                minimum_shift_slots = FAVORED_MIN_SLOTS if is_favored else MIN_SLOTS_LOCAL
                for disallowed_slots in range(1, minimum_shift_slots):
                    model.add(total_slots_today != disallowed_slots)
    
    
    # ============================================================================
    # STEP 7B: ADD WEEKLY HOUR LIMIT CONSTRAINTS
    # ============================================================================
    # Limit total hours per employee per week (prevents overwork)
    # Two levels: individual personal maximum preferences AND universal 19-hour limit
    
    UNIVERSAL_MAXIMUM_HOURS = 19  # Universal limit - no one can exceed this regardless of personal preference
    availability_slots = {
        e: len(days) * len(T) - sum(len(unavailable.get(e, {}).get(d, [])) for d in days)
        for e in employees
    }
    
    for e in employees:
        # Sum up all SLOTS worked across the entire week
        total_weekly_slots = sum(
            work[e, d, t] 
            for d in days 
            for t in T
        )
        
        # Individual personal preference limit (customized per employee)
        max_weekly_hours = weekly_hour_limits.get(e, 40)  # Default to 40 if not specified
        max_weekly_slots = hours_to_slots(max_weekly_hours)
        model.add(total_weekly_slots <= max_weekly_slots)
        
        # Universal maximum (applies to everyone)
        universal_max_slots = hours_to_slots(UNIVERSAL_MAXIMUM_HOURS)
        model.add(total_weekly_slots <= universal_max_slots)
        
        print(f"   └─ {e}: max {max_weekly_hours} hours/week (universal limit: {UNIVERSAL_MAXIMUM_HOURS}h)")
    
    
    # ============================================================================
    # STEP 8: ADD AVAILABILITY CONSTRAINTS
    # ============================================================================
    # Employees cannot work during times they've marked as unavailable
    
    for e in employees:
        for d in days:
            # Check if this employee has any unavailability
            if e in unavailable and d in unavailable[e]:
                # Force work variable to 0 for each unavailable time slot
                for t in unavailable[e][d]:
                    if t in T:  # Validate it's a valid time slot
                        model.add(work[e, d, t] == 0)
    
    
    # ============================================================================
    # STEP 9: ADD ROLE ASSIGNMENT CONSTRAINTS
    # ============================================================================
    
    for e in employees:
        for d in days:
            for t in T:
                # Get roles this employee has assignment variables for at this slot
                employee_roles_at_slot = [r for r in all_roles_including_forced if (e, d, t, r) in assign]

                # Constraint 9.1: Can't do two roles simultaneously
                # An employee can be assigned to at most one role at a time
                if len(employee_roles_at_slot) > 1:
                    # Only add constraint if employee has multiple role options
                    model.add(sum(assign[(e, d, t, r)] for r in employee_roles_at_slot) <= 1)

                # Constraint 9.2: Must be working to be assigned a role
                # If assigned to a role, the employee must be working that slot
                for r in employee_roles_at_slot:
                    model.add(assign[(e, d, t, r)] <= work[e, d, t])

                # Constraint 9.2b: CRITICAL REVERSE CONSTRAINT
                # If working, MUST be assigned to exactly one role
                # This ensures work[e,d,t]=1 implies they have a role assignment
                if employee_roles_at_slot:
                    model.add(sum(assign[(e, d, t, r)] for r in employee_roles_at_slot) == work[e, d, t])
                else:
                    # No roles available for this employee at this slot - they can't work here
                    model.add(work[e, d, t] == 0)
                
                # Constraint 9.3: CRITICAL - Non-front desk roles need front desk supervision
                # Any departmental assignment can ONLY happen when at least one front_desk is present
                # This prevents scenarios where only departmental work is happening unsupervised
                for r in department_roles:
                    if (e, d, t, r) in assign:
                        model.add(
                            sum(assign.get((emp, d, t, "front_desk"), 0) for emp in employees) >= 1
                        ).only_enforce_if(assign[(e, d, t, r)])

    # ============================================================================
    # STEP 9B: FRONT DESK ASSIGNMENT CONTIGUITY
    # ============================================================================
    # Prevent employees from toggling in and out of front desk duty within the same shift

    for e in employees:
        if all((e, d, t, FRONT_DESK_ROLE) not in assign for d in days for t in T):
            continue
        for d in days:
            fd_starts = [frontdesk_start.get((e, d, t), 0) for t in T]
            fd_ends = [frontdesk_end.get((e, d, t), 0) for t in T]
            model.add(sum(fd_starts) <= 1)
            model.add(sum(fd_ends) <= 1)
            model.add(sum(fd_starts) == sum(fd_ends))
            
            assign_fd_0 = assign.get((e, d, 0, "front_desk"), 0)
            model.add(assign_fd_0 == frontdesk_start.get((e, d, 0), 0))
            
            for t in T[1:]:
                assign_curr = assign.get((e, d, t, "front_desk"), 0)
                assign_prev = assign.get((e, d, t-1, "front_desk"), 0)
                model.add(
                    assign_curr - assign_prev == frontdesk_start.get((e, d, t), 0) - frontdesk_end.get((e, d, t-1), 0)
                )
            
            model.add(frontdesk_end.get((e, d, T[-1]), 0) == assign.get((e, d, T[-1], "front_desk"), 0))
            
            # HARD CONSTRAINT: Front desk assignments must respect the same minimum shift length
            # rules as the employee's overall day.
            total_front_desk_slots = sum(assign.get((e, d, t, "front_desk"), 0) for t in T)
            is_favored = e.lower() in favored_employees_normalized

            # Check if THIS employee has forced front desk assignment on this day (via timeset)
            has_forced_fd_assignment = any(
                r == FRONT_DESK_ROLE
                for (emp, day, slot, r) in forced_assignments
                if emp == e and day == d
            )

            # Check if ANY employee has forced front desk assignment on this day
            # This affects other employees because forced FD "blocks" adjacent slots
            # E.g., if Natalya is forced to FD at 4pm-5pm, someone covering FD 2pm-4pm
            # can't extend to 5pm (conflict), so they might need a shorter-than-minimum shift
            day_has_any_forced_fd = any(
                r == FRONT_DESK_ROLE
                for (emp, day_check, slot, r) in forced_assignments
                if day_check == d
            )

            # Explicitly forbid undersized front desk blocks.
            # EXCEPTION 1: Employee with forced FD assignment is exempt
            # EXCEPTION 2: ALL employees exempt on days with ANY forced FD assignment
            #              (forced FD can block adjacent slots, making normal minimums impossible)
            min_front_desk_slots = FAVORED_MIN_SLOTS if is_favored else MIN_FRONT_DESK_SLOTS
            # EXCEPTION 1: Employee with forced FD assignment is exempt
            # EXCEPTION 2: ALL employees exempt on days with ANY forced FD assignment
            #              (forced FD can block adjacent slots, making normal minimums impossible)
            if not has_forced_fd_assignment and not day_has_any_forced_fd:
                for disallowed_slots in range(1, min_front_desk_slots):
                    model.add(total_front_desk_slots != disallowed_slots)
    
    
    # ============================================================================
    # STEP 9C: MINIMUM ROLE DURATION CONSTRAINT (ALL ROLES)
    # ============================================================================
    # Prevent employees from doing any role for less than 1 hour (2 slots)
    # Example: Can't do front_desk 8am-10am, then marketing 10am-10:30am
    # If you switch to a role, you must do it for at least 1 hour continuously
    
    # Create role start/end tracking variables for ALL roles
    role_start = {
        (e, d, t, r): model.new_bool_var(f"role_start[{e},{d},{t},{r}]")
        for e in employees
        for d in days
        for t in T
        for r in all_roles_including_forced
        if (e, d, t, r) in assign
    }
    role_end = {
        (e, d, t, r): model.new_bool_var(f"role_end[{e},{d},{t},{r}]")
        for e in employees
        for d in days
        for t in T
        for r in all_roles_including_forced
        if (e, d, t, r) in assign
    }

    for e in employees:
        for d in days:
            for r in all_roles_including_forced:
                has_role_slots = any((e, d, t, r) in assign for t in T)
                if not has_role_slots:
                    continue

                # Enforce contiguous role assignment (can't toggle in and out of a role)
                # At most one start and one end per role per day
                model.add(sum(role_start.get((e, d, t, r), 0) for t in T) <= 1)
                model.add(sum(role_end.get((e, d, t, r), 0) for t in T) <= 1)
                model.add(
                    sum(role_start.get((e, d, t, r), 0) for t in T) == 
                    sum(role_end.get((e, d, t, r), 0) for t in T)
                )
                
                # First slot boundary - find the FIRST slot with an assign variable
                first_slot_with_assign = None
                for t in T:
                    if (e, d, t, r) in assign:
                        first_slot_with_assign = t
                        break

                if first_slot_with_assign is not None:
                    # The first slot with an assign variable is a start if the assignment is 1
                    model.add(assign[(e, d, first_slot_with_assign, r)] == role_start.get((e, d, first_slot_with_assign, r), 0))

                # Internal transitions
                for t in T[1:]:
                    if (e, d, t, r) in assign and (e, d, t-1, r) in assign:
                        model.add(
                            assign[(e, d, t, r)] - assign[(e, d, t-1, r)] == 
                            role_start[(e, d, t, r)] - role_end[(e, d, t-1, r)]
                        )
                
                # Last slot boundary
                if (e, d, T[-1], r) in assign:
                    model.add(role_end.get((e, d, T[-1], r), 0) == assign[(e, d, T[-1], r)])
                
                # HARD CONSTRAINT: Minimum 1 hour per role assignment
                total_role_slots = sum(assign.get((e, d, t, r), 0) for t in T)

                # Check if employee has forced assignment for this role on this day (via timeset)
                has_forced_role_assignment = any(
                    forced_role == r
                    for (emp, day, slot, forced_role) in forced_assignments
                    if emp == e and day == d
                )

                # Check if ANY employee has forced FD on this day (affects FD minimums for all)
                day_has_any_forced_fd_for_step9c = any(
                    forced_role == FRONT_DESK_ROLE
                    for (emp, day_check, slot, forced_role) in forced_assignments
                    if day_check == d
                )

                # Forbid role blocks shorter than 1 hour for any role.
                # EXCEPTION 1: Days with forced role assignments are exempt
                # EXCEPTION 2: For front_desk, also exempt if ANY forced FD exists on this day
                #              (forced FD can block adjacent slots, making normal minimums impossible)
                fd_day_exempt = (r == FRONT_DESK_ROLE and day_has_any_forced_fd_for_step9c)
                if not has_forced_role_assignment and not fd_day_exempt:
                    for disallowed_slots in range(1, FAVORED_MIN_SLOTS):
                        model.add(total_role_slots != disallowed_slots)

                # CONDITIONAL: Enforce 2-hour minimum for non-FD departments (when toggle ON)
                # Non-favored employees: each non-FD department block must be >= 2 hours.
                # EXCEPTION: Days with forced role assignments are exempt (timesets override minimums)
                if enforce_min_dept_block:
                    is_favored = e.lower() in favored_employees_normalized
                    if not is_favored and r != FRONT_DESK_ROLE and not has_forced_role_assignment:
                        for disallowed_slots in range(FAVORED_MIN_SLOTS, MIN_SLOTS_LOCAL):
                            model.add(total_role_slots != disallowed_slots)
    
    # ============================================================================
    # STEP 9D: CROSS-DEPARTMENT SPLIT RESTRICTION (EXPERIMENTAL)
    # ============================================================================
    # Forbid 2-hour shifts split 1h+1h across two non-Front-Desk departments
    # This applies to EVERYONE including favored employees
    # A 4-slot shift cannot have exactly 2 slots in one non-FD dept and 2 in another
    
    if enforce_min_dept_block:
        for e in employees:
            for d in days:
                # Track which non-FD departments have exactly 1 hour assigned.
                has_one_hour_block = {}
                for r in department_roles:
                    total_r = sum(assign.get((e, d, t, r), 0) for t in T)
                    has_one_hour = model.new_bool_var(f"has_one_hour_block[{e},{d},{r}]")
                    model.add(total_r == FAVORED_MIN_SLOTS).only_enforce_if(has_one_hour)
                    model.add(total_r != FAVORED_MIN_SLOTS).only_enforce_if(has_one_hour.Not())
                    has_one_hour_block[r] = has_one_hour
                
                # Count departments with exactly one hour assigned.
                num_with_2 = sum(has_one_hour_block.values())
                
                # Total shift length
                total_shift = sum(work[e, d, t] for t in T)
                
                # If a 2-hour shift exists, it can't be split into two separate 1-hour blocks.
                is_4_slot_shift = model.new_bool_var(f"is_min_shift[{e},{d}]")
                model.add(total_shift == MIN_SLOTS_LOCAL).only_enforce_if(is_4_slot_shift)
                model.add(total_shift != MIN_SLOTS_LOCAL).only_enforce_if(is_4_slot_shift.Not())
                
                model.add(num_with_2 <= 1).only_enforce_if(is_4_slot_shift)
    
    
    # ============================================================================
    # STEP 10: ADD COVERAGE REQUIREMENTS
    # ============================================================================
    # Ensure minimum staffing levels are met for each role
    
    # Create coverage tracking variables (soft constraints via objective)
    front_desk_coverage_score = 0
    
    for d in days:
        for t in T:
            # Create indicator: is front desk covered at this time?
            has_front_desk = model.new_bool_var(f"has_front_desk[{d},{t}]")
            num_front_desk = sum(assign.get((e, d, t, "front_desk"), 0) for e in employees)
            
            # Link indicator to actual coverage (at least 1 front desk)
            model.add(num_front_desk >= 1).only_enforce_if(has_front_desk)
            model.add(num_front_desk == 0).only_enforce_if(has_front_desk.Not())
            
            # VERY STRONG SOFT CONSTRAINT: Front desk should be covered at all times
            # We use MASSIVE weight (10000) to make this extremely high priority
            # This is NOT a hard constraint - if truly impossible, solver can still find a solution
            # But practically, front desk will only be uncovered if NO front-desk-qualified 
            # employee is available at that time slot
            front_desk_coverage_score += FRONT_DESK_COVERAGE_WEIGHT_LOCAL * has_front_desk
            
            # HARD CONSTRAINT: At most 1 front desk at a time (no overstaffing at front desk)
            model.add(num_front_desk <= 1)
            
            # NOTE: Department roles CAN have multiple people working at the same time
            # We removed the hard cap - instead we'll use soft constraints in the objective
            # to encourage spreading people out throughout the week
    
    
    # ============================================================================
    # STEP 11: DEFINE THE OBJECTIVE FUNCTION
    # ============================================================================
    # What we're trying to optimize (maximize in this case)
    
    # Count total departmental assignments across all employees, days, and times
    department_assignments = {
        role: sum(
            assign.get((e, d, t, role), 0)
            for e in employees
            for d in days
            for t in T
        )
        for role in department_roles
    }
    front_desk_slots_by_employee = {
        e: sum(assign.get((e, d, t, FRONT_DESK_ROLE), 0) for d in days for t in T)
        for e in employees
    }
    dual_front_desk_slots = {
        role: sum(
            front_desk_slots_by_employee[e]
            for e in employees
            if primary_department_for_employee.get(e) == role
        )
        for role in department_roles
    }
    department_effective_units = {
        role: 2 * department_assignments[role] + dual_front_desk_slots[role]
        for role in department_roles
    }
    favored_department_bonus = 0
    favored_fd_bonus = 0
    for role in department_roles:
        if role in favored_departments_normalized:
            mult = favored_departments_normalized[role].multiplier
            focused_slots = department_assignments[role]
            dual_slots = dual_front_desk_slots[role]
            favored_department_bonus += mult * (
                FAVORED_DEPARTMENT_FOCUSED_BONUS * focused_slots
                - FAVORED_DEPARTMENT_DUAL_PENALTY * dual_slots
            )
        if role in favored_fd_departments_normalized:
            mult = favored_fd_departments_normalized[role].multiplier
            # Bonus for each front desk slot filled by members of this department
            fd_slots = sum(assign.get((e, d, t, FRONT_DESK_ROLE), 0) for e in employees if role in qual[e] for d in days for t in T)
            favored_fd_bonus += mult * FAVORED_FRONT_DESK_DEPT_BONUS * fd_slots
    
    # Bonus for favored employee-department assignments
    favored_emp_dept_bonus = 0
    for fed in validated_favored_emp_depts:
        emp = fed.employee
        dept = fed.department
        mult = fed.multiplier if fed.multiplier else 1.0
        # Bonus for each slot this employee works in their preferred department
        slots_in_dept = sum(
            assign.get((emp, d, t, dept), 0) 
            for d in days 
            for t in T 
            if (emp, d, t, dept) in assign
        )
        favored_emp_dept_bonus += int(mult * FAVORED_EMPLOYEE_DEPT_BONUS_LOCAL) * slots_in_dept
    
    total_department_units = sum(department_effective_units.values())
    department_max_units = {
        role: int(round(department_max_hours[role] * DEPARTMENT_UNITS_PER_HOUR))
        for role in department_roles
    }

    # Check if forced timesets might exceed department max (warning only)
    forced_dept_slots: dict[str, int] = {}
    for (emp, day, slot, role) in forced_assignments:
        if role in department_roles:
            forced_dept_slots[role] = forced_dept_slots.get(role, 0) + 1
    for role, forced_slots in forced_dept_slots.items():
        forced_units = 2 * forced_slots  # department_effective_units = 2 * assignments
        max_units = department_max_units.get(role, 0)
        max_hours = department_max_hours.get(role, 0)
        forced_hours = slots_to_hours(forced_slots)
        if forced_units > max_units:
            print(f"  WARNING: DEPT MAX EXCEEDED - {role}: forced {forced_hours}hrs ({forced_units} units) > max {max_hours}hrs ({max_units} units)")

    for role in department_roles:
        model.add(department_effective_units[role] <= department_max_units[role])
    
    # Calculate "spread" metric for each department: count how many time slots have at least 1 worker
    # This encourages distribution throughout the day rather than clustering
    department_spread_score = 0
    for role in department_roles:
        for d in days:
            for t in T:
                has_role = model.new_bool_var(f"has_{role}[{d},{t}]")
                num_role = sum(assign.get((e, d, t, role), 0) for e in employees)
                
                model.add(num_role >= 1).only_enforce_if(has_role)
                model.add(num_role == 0).only_enforce_if(has_role.Not())
                
                department_spread_score += has_role
    
    # Encourage each department to appear across multiple days
    department_day_coverage_score = 0
    for role in department_roles:
        for d in days:
            has_role_day = model.new_bool_var(f"has_{role}[{d}]")
            total_role_day = sum(assign.get((e, d, t, role), 0) for e in employees for t in T)
            model.add(total_role_day >= 1).only_enforce_if(has_role_day)
            model.add(total_role_day == 0).only_enforce_if(has_role_day.Not())
            department_day_coverage_score += has_role_day

    # Encourage departments to hit target weekly hours (soft constraint)
    department_target_score = 0
    department_large_deviation_penalty = 0
    threshold_units = int(round(department_hour_threshold * DEPARTMENT_UNITS_PER_HOUR))

    for role in department_roles:
        target_hours = department_hour_targets.get(role)
        if target_hours is None:
            continue
        max_capacity_hours = sum(weekly_hour_limits.get(e, 0) for e in employees if role in qual[e])
        max_requirement_hours = department_max_hours.get(role, max_capacity_hours)
        adjusted_target_hours = min(target_hours, max_capacity_hours, max_requirement_hours)
        target_units = int(round(adjusted_target_hours * DEPARTMENT_UNITS_PER_HOUR))
        total_role_units = department_effective_units[role]

        over = model.new_int_var(0, 400, f"department_over[{role}]")
        under = model.new_int_var(0, 400, f"department_under[{role}]")
        model.add(total_role_units == target_units + over - under)

        favor_mult = favored_departments_normalized.get(role).multiplier if role in favored_departments_normalized else 1.0     # type: ignore
        department_target_score -= favor_mult * (over + under)

        if threshold_units > 0:
            large_over = model.new_bool_var(f"department_large_over[{role}]")
            large_under = model.new_bool_var(f"department_large_under[{role}]")

            model.add(over >= threshold_units).only_enforce_if(large_over)
            model.add(over < threshold_units).only_enforce_if(large_over.Not())

            model.add(under >= threshold_units).only_enforce_if(large_under)
            model.add(under < threshold_units).only_enforce_if(large_under.Not())

            department_large_deviation_penalty -= favor_mult * DEPARTMENT_LARGE_DEVIATION_PENALTY * (large_over + large_under)
    
    # Calculate target hours encouragement (SOFT constraint via objective)
    # We want to encourage employees to work close to their target hours
    # This is NOT a hard constraint - solver will try to get close but won't fail if impossible
    # We'll create penalty variables for being over/under target
    # IMPORTANT: Apply graduated weights based on year - upperclassmen get stronger adherence
    # This counterbalances the front desk preference that favors underclassmen
    target_adherence_score = 0
    large_deviation_penalty = 0  # Steep penalty for being 2+ hours off target
    
    for e in employees:
        # Calculate total slots worked by this employee across the week
        total_slots = sum(work[e, d, t] for d in days for t in T)
        
        # Get this employee's target (in hours, convert to slots)
        target_hours = target_weekly_hours.get(e, 11)  # Default 11 hours
        target_slots = hours_to_slots(target_hours)
        delta_slots = hours_to_slots(TARGET_HARD_DELTA_HOURS_LOCAL)
        lower_bound = max(0, target_slots - delta_slots)
        upper_bound = target_slots + delta_slots
        max_weekly_hours = weekly_hour_limits.get(e, 40)
        max_weekly_slots = hours_to_slots(max_weekly_hours)
        universal_max_slots = hours_to_slots(UNIVERSAL_MAXIMUM_HOURS)
        feasible_upper = min(upper_bound, max_weekly_slots, universal_max_slots)
        feasible_lower = min(lower_bound, availability_slots.get(e, lower_bound), feasible_upper)

        # When timesets are active, they consume coverage capacity and may make
        # it impossible for FD-qualified employees to meet their hour targets
        # while also providing required FD coverage. Relax the lower bound.
        if forced_assignments and feasible_lower > 0:
            # Count total forced department slots that need FD coverage
            total_forced_dept_slots = sum(
                1 for (emp, day, slot, role) in forced_assignments
                if role != FRONT_DESK_ROLE
            )

            # Count FD-qualified employees
            fd_qualified_employees = [emp for emp in employees if FRONT_DESK_ROLE in qual[emp]]
            num_fd_qualified = max(1, len(fd_qualified_employees))

            # FD-qualified employees bear the burden of covering timeset FD requirements
            # Their lower bound should be reduced by approximately their share of FD coverage
            is_fd_qualified = FRONT_DESK_ROLE in qual[e]

            if total_forced_dept_slots >= hours_to_slots(2):  # At least 2 hours of forced dept work
                # Heavy timeset load creates significant FD coverage demand
                # which constrains the entire system. Reduce lower bounds accordingly.
                if total_forced_dept_slots >= hours_to_slots(15):  # Very heavy load (15+ hours of dept work)
                    # Drop ALL lower bounds to 0 - let soft constraints guide scheduling
                    reduction = feasible_lower
                elif is_fd_qualified:
                    # FD-qualified employees bear the coverage burden
                    if total_forced_dept_slots >= hours_to_slots(10):  # Heavy load (10+ hours)
                        reduction = max(0, feasible_lower - hours_to_slots(1))  # Keep 1 hour minimum
                    else:
                        fd_burden = total_forced_dept_slots // num_fd_qualified
                        reduction = min(feasible_lower, fd_burden)
                else:
                    # Non-FD employees: moderate reduction
                    if total_forced_dept_slots >= hours_to_slots(10):
                        reduction = feasible_lower // 2
                    else:
                        reduction = min(feasible_lower, total_forced_dept_slots // hours_to_slots(5))

                feasible_lower = max(0, feasible_lower - reduction)

        model.add(total_slots >= feasible_lower)
        model.add(total_slots <= feasible_upper)
        
        # Create variables to track deviation from target
        over_target = model.new_int_var(0, 100, f"over_target[{e}]")
        under_target = model.new_int_var(0, 100, f"under_target[{e}]")
        
        # Deviation equation: total_slots = target_slots + over_target - under_target
        model.add(total_slots == target_slots + over_target - under_target)
        
        # Graduated weighting based on year:
        # Seniors and juniors get higher weight to ensure they hit their hours
        # even if it means putting them at front desk (overriding the underclassmen preference)
        year = employee_year.get(e, 2)
        year_multiplier = YEAR_TARGET_MULTIPLIERS.get(year, 1.0)
        # Use favored employee multiplier if set, with base FAVOR_TARGET_MULTIPLIER
        emp_lower = e.lower()
        favored_multiplier = (FAVOR_TARGET_MULTIPLIER * favored_employees_normalized.get(emp_lower, 0)) if emp_lower in favored_employees_normalized else 1.0
        
        # Penalize deviation with graduated weight
        # Upperclassmen deviations are penalized more heavily
        target_adherence_score -= favored_multiplier * year_multiplier * (over_target + under_target)
        
        # STEEP PENALTY for large deviations (2+ hours = 4+ slots off target)
        # This applies to EVERYONE regardless of year
        # Create indicator variables for "large deviation"
        large_over = model.new_bool_var(f"large_over[{e}]")
        large_under = model.new_bool_var(f"large_under[{e}]")
        
        # Large over = more than threshold slots (default 4 -> 2 hours)
        model.add(over_target >= LARGE_DEVIATION_SLOT_THRESHOLD).only_enforce_if(large_over)
        model.add(over_target < LARGE_DEVIATION_SLOT_THRESHOLD).only_enforce_if(large_over.Not())
        
        # Large under = more than threshold slots under target
        model.add(under_target >= LARGE_DEVIATION_SLOT_THRESHOLD).only_enforce_if(large_under)
        model.add(under_target < LARGE_DEVIATION_SLOT_THRESHOLD).only_enforce_if(large_under.Not())
        
        # Apply MASSIVE penalty for large deviations
        large_deviation_penalty -= (
            favored_multiplier * EMPLOYEE_LARGE_DEVIATION_PENALTY * (large_over + large_under)
        )
    
    # Calculate shift length preference (encourage longer shifts)
    # Prefer fewer, longer shifts (e.g., three 4-hour shifts) over many short shifts (e.g., five 2-hour shifts)
    # We do this by rewarding the total hours worked while penalizing the number of shifts
    shift_length_bonus = 0
    
    for e in employees:
        for d in days:
            # Count if employee works at all this day (this is a "shift day")
            works_this_day = model.new_bool_var(f"works_this_day[{e},{d}]")
            day_slots = sum(work[e, d, t] for t in T)
            
            # Link indicator: works_this_day = 1 if day_slots > 0
            model.add(day_slots >= 1).only_enforce_if(works_this_day)
            model.add(day_slots == 0).only_enforce_if(works_this_day.Not())
            
            # Reward the shift length (more slots per shift = better)
            # But penalize having many shifts (fewer shifts = better)
            # Net effect: encourages longer, fewer shifts
            shift_length_bonus += day_slots  # Reward hours worked
            shift_length_bonus -= SHIFT_LENGTH_DAILY_COST * works_this_day  # Penalize number of distinct shifts
    
    # Calculate underclassmen front desk preference (SOFT preference)
    # Prefer to put freshmen and sophomores at front desk over juniors and seniors
    # This is NOT a hard constraint - just a gentle nudge when solver has options
    # Scoring: Higher year = penalty for front desk assignment
    # Freshman (1): -1 penalty = prefer them most
    # Sophomore (2): -2 penalty = still good
    # Junior (3): -3 penalty = prefer to avoid
    # Senior (4): -4 penalty = prefer to avoid most
    underclassmen_preference_score = 0
    
    for e in employees:
        year = employee_year.get(e, 2)  # Default to sophomore if not specified
        
        # For each front desk assignment, apply a penalty based on year
        # Lower year (freshman) = smaller penalty = more preferred
        for d in days:
            for t in T:
                if (e, d, t, "front_desk") in assign:
                    # Subtract the year value: freshmen (1) are least penalized
                    underclassmen_preference_score -= year * assign[(e, d, t, "front_desk")]
    
    # ============================================================================
    # DEPARTMENT SCARCITY PENALTY FOR FRONT DESK
    # ============================================================================
    # Prefer pulling people to front desk from departments with MORE qualified people
    # (more options, more flexible scheduling) rather than departments with FEWER
    # This protects scarce resources in small departments (Marketing=2, Employer Engagement=2)
    # and lets bigger departments (Career Education=3, Events=3) contribute more to front desk
    # 
    # Scarcity score: Inverse of department size - smaller departments get higher penalty
    # This takes precedence over seniority - spreading the wealth is the priority!
    
    department_scarcity_penalty = 0
    
    for e in employees:
        # Find which non-front-desk departments this employee belongs to
        employee_departments = [r for r in qual[e] if r != "front_desk" and r in department_roles]
        
        # Calculate scarcity: average inverse of department sizes for this employee's departments
        # If employee is in multiple departments, use the SMALLEST department (most scarce)
        if employee_departments:
            # Get the smallest department size this employee belongs to
            min_dept_size = min(department_sizes[dept] for dept in employee_departments)
            
            # Scarcity penalty: smaller department = higher penalty for using at front desk
            scarcity_factor = DEPARTMENT_SCARCITY_BASE_WEIGHT / min_dept_size
            
            # Apply penalty for each front desk assignment
            for d in days:
                for t in T:
                    if (e, d, t, "front_desk") in assign:
                        # Penalize pulling scarce resources to front desk
                        department_scarcity_penalty -= scarcity_factor * assign[(e, d, t, "front_desk")]
    
    # ============================================================================
    # COLLABORATIVE HOURS TRACKING
    # ============================================================================
    # Track when multiple people work together in the same department (collaboration)
    # We want to ENCOURAGE collaboration - it's good for teamwork and training!
    # Note: Single 30-minute overlaps don't count - must be at least 1 hour together
    
    # Track collaborative slots per department
    collaborative_slots = {}
    for role in department_roles:
        # Count slots where 2+ people work this role simultaneously
        collab_slot_vars = []
        for d in days:
            for t in T:
                # Count how many people are working this department role at this time
                num_in_role = sum(assign.get((e, d, t, role), 0) for e in employees)
                
                # Create a boolean indicator: are there 2+ people in this role right now?
                has_collaboration = model.new_bool_var(f"collab_{role}[{d},{t}]")
                model.add(num_in_role >= 2).only_enforce_if(has_collaboration)
                model.add(num_in_role <= 1).only_enforce_if(has_collaboration.Not())
                
                collab_slot_vars.append(has_collaboration)
        
        # Sum up total collaborative slots for this department
        collaborative_slots[role] = sum(collab_slot_vars)
    
    # Calculate penalty for not meeting collaborative hour minimums
    # This is a SOFT constraint - encourages collaboration but doesn't require it
    collaborative_hours_score = 0
    
    for role in department_roles:
        if role not in COLLABORATION_MINIMUM_HOURS:
            continue
        
        min_slots = hours_to_slots(COLLABORATION_MINIMUM_HOURS[role])
        
        if min_slots == 0:
            # No collaboration requirement for this department (e.g., data_systems with 1 person)
            continue
        
        # Calculate how far we are from the minimum
        under_collab = model.new_int_var(0, 200, f"under_collab[{role}]")
        model.add(collaborative_slots[role] + under_collab >= min_slots)
        
        # Penalize being under the collaborative minimum
        # Increased penalty to make collaboration a higher priority
        collaborative_hours_score -= under_collab  # Will be multiplied by 200 in objective function

    # ============================================================================
    # TRAINING OVERLAP - Encourage paired trainees to work together in a department
    # ============================================================================
    training_overlap_penalty = 0
    training_overlap_bonus = 0
    for idx, training in enumerate(validated_training):
        dept = training["department"]
        person_one = training["trainee_one"]
        person_two = training["trainee_two"]
        goal_slots = training["goal_slots"]

        overlap_bools = []
        available_overlap_slots = 0
        for d in days:
            for t in T:
                # Check mutual availability and feasibility with min shift length
                p1_feasible = t in workable_slots[person_one][d]
                p2_feasible = t in workable_slots[person_two][d]
                if not (p1_feasible and p2_feasible):
                    continue
                if (person_one, d, t, dept) not in assign or (person_two, d, t, dept) not in assign:
                    continue
                available_overlap_slots += 1
                # Both trainees working the same department at the same time
                overlap = model.new_bool_var(f"training_overlap[{idx},{d},{t}]")
                assign_one = assign[(person_one, d, t, dept)]
                assign_two = assign[(person_two, d, t, dept)]
                model.add(overlap <= assign_one)
                model.add(overlap <= assign_two)
                model.add(overlap >= assign_one + assign_two - 1)
                overlap_bools.append(overlap)

        total_overlap = sum(overlap_bools)
        if available_overlap_slots > 0:
            goal_slots = min(goal_slots, available_overlap_slots)
            training_available_overlap[idx] = available_overlap_slots
            # Training overlap is purely soft - no hard constraint
            # The bonus/penalty system will encourage overlap without making the model infeasible
        training_overlap_bonus += TRAINING_OVERLAP_BONUS * total_overlap
        max_week_slots = len(T) * len(days)
        under = model.new_int_var(0, max_week_slots, f"training_under[{idx}]")
        model.add(total_overlap + under >= goal_slots)

        training_overlap_penalty -= TRAINING_OVERLAP_WEIGHT * under
    
    # ============================================================================
    # EQUALITY CONSTRAINTS - Equalize department hours between pairs of employees
    # ============================================================================
    # Soft constraint: minimize the difference in department hours between two employees
    equality_penalty = 0
    EQUALITY_WEIGHT = legacy_per_slot_weight(200)  # Penalty per slot of difference
    
    for idx, eq in enumerate(validated_equality):
        dept = eq["department"]
        emp1 = eq["employee1"]
        emp2 = eq["employee2"]
        
        # Sum department slots for each employee across all days
        emp1_dept_slots = []
        emp2_dept_slots = []
        for d in days:
            for t in T:
                if (emp1, d, t, dept) in assign:
                    emp1_dept_slots.append(assign[(emp1, d, t, dept)])
                if (emp2, d, t, dept) in assign:
                    emp2_dept_slots.append(assign[(emp2, d, t, dept)])
        
        if not emp1_dept_slots or not emp2_dept_slots:
            # One or both employees have no possible assignments in this department
            continue
        
        emp1_total = sum(emp1_dept_slots)
        emp2_total = sum(emp2_dept_slots)
        
        # Create variable for difference (can be negative)
        max_possible_slots = len(T) * len(days)
        diff = model.new_int_var(-max_possible_slots, max_possible_slots, f"eq_diff[{idx}]")
        model.add(diff == emp1_total - emp2_total)
        
        # Create variable for absolute value of difference
        abs_diff = model.new_int_var(0, max_possible_slots, f"eq_abs_diff[{idx}]")
        model.add_abs_equality(abs_diff, diff)
        
        # Penalize the absolute difference (soft constraint)
        equality_penalty -= EQUALITY_WEIGHT * abs_diff
    
    # ============================================================================
    # OFFICE COVERAGE - Encourage at least 2 people in office at all times
    # ============================================================================
    # Track how many people are working (in ANY role) at each time slot
    # We want front desk (1 person) + at least 1 department worker = 2+ total
    # CRITICAL: Having only 1 person (front desk alone) is risky - no backup if they get sick!
    
    office_coverage_score = 0
    single_coverage_penalty = 0  # NEW: penalty for having only 1 person
    
    for d in days:
        for t in T:
            # Count total people working at this time slot (any role)
            total_people = sum(assign.get((e, d, t, r), 0)
                             for e in employees
                             for r in all_roles_including_forced
                             if (e, d, t, r) in assign)
            
            # Encourage having at least 2 people in the office
            # Reward each person beyond 1 (so 2 people = +1 bonus, 3 people = +2 bonus, etc.)
            office_coverage_score += total_people - 1
            
            # NEW: Heavy penalty if only 1 person in office (front desk alone - very risky!)
            # Create a boolean variable for "only 1 person working"
            only_one_person = model.new_bool_var(f"only_one_{d}_{t}")
            
            # If total_people == 1, then only_one_person = 1, otherwise 0
            model.add(total_people == 1).only_enforce_if(only_one_person)
            model.add(total_people != 1).only_enforce_if(only_one_person.Not())
            
            # Apply penalty for single coverage
            single_coverage_penalty -= only_one_person  # Will be multiplied by weight in objective
    
    # ============================================================================
    # TIME OF DAY PREFERENCE - Very slight favor toward morning staffing
    # ============================================================================
    # Slightly prefer having more people working in morning hours (8am-12pm)
    # This is a VERY gentle nudge - only matters when everything else is equal
    # Helps avoid scenarios where afternoons are understaffed relative to mornings
    
    morning_preference_score = 0
    morning_slots = [t for t in T if t < hours_to_slots(4)]  # 8:00am-12:00pm
    
    for d in days:
        for t in morning_slots:
            # Count people working in morning time slots
            morning_workers = sum(assign.get((e, d, t, r), 0)
                                for e in employees
                                for r in all_roles_including_forced
                                if (e, d, t, r) in assign)
            morning_preference_score += morning_workers
    
    # ============================================================================
    # SHIFT TIME PREFERENCE - Per-employee, per-day morning/afternoon soft nudge
    # ============================================================================
    # Allow users to specify soft preferences for when specific employees should work
    # Morning = 8am-12pm, Afternoon = 12pm-5pm
    # This is a gentle nudge - won't override hard constraints or availability
    
    SHIFT_PREF_BONUS_WEIGHT = legacy_per_slot_weight(15)  # Moderate weight - noticeable but not overwhelming
    shift_time_pref_score = 0
    
    # Build a lookup for preferences: (employee_lower, day) -> 'morning' or 'afternoon'
    shift_pref_lookup: Dict[tuple, str] = {}
    employees_lower_lookup = {e.lower(): e for e in employees}
    day_lookup_lower = {d.lower(): d for d in days}
    
    for pref in shift_time_preferences:
        emp_key = pref.employee.strip().lower()
        day_key = pref.day.strip().lower()
        
        # Skip if employee not found
        if emp_key not in employees_lower_lookup:
            continue
        
        # Normalize day name
        if day_key in day_lookup_lower:
            normalized_day = day_lookup_lower[day_key]
        elif day_key[:3] in [d.lower()[:3] for d in days]:
            # Match by prefix (Mon, Tue, etc.)
            for d in days:
                if d.lower().startswith(day_key[:3]):
                    normalized_day = d
                    break
        else:
            continue
        
        employee_name = employees_lower_lookup[emp_key]
        shift_pref_lookup[(employee_name, normalized_day)] = pref.preference
    
    # Now calculate bonus for matching preferences
    morning_time_slots = [t for t in T if t < hours_to_slots(4)]
    afternoon_time_slots = [t for t in T if t >= hours_to_slots(4)]
    
    for (emp, day), pref_type in shift_pref_lookup.items():
        if pref_type == 'morning':
            preferred_slots = morning_time_slots
        else:  # afternoon
            preferred_slots = afternoon_time_slots
        
        # Add bonus for each slot worked in preferred time range
        for t in preferred_slots:
            if (emp, day, t) in work:
                shift_time_pref_score += SHIFT_PREF_BONUS_WEIGHT * work[emp, day, t]
    
    # ============================================================================
    # FAVORED HOURS BONUS - Encourage filling favored employees' available time
    # ============================================================================
    favored_hours_bonus = 0
    if favored_employees_normalized:
        for e in employees:
            emp_lower = e.lower()
            if emp_lower in favored_employees_normalized:
                mult = favored_employees_normalized[emp_lower]
                # Scale multiplier by 10 to preserve fractional precision (1.5 -> 15)
                # OR-Tools requires integer coefficients
                weight = int(mult * 10)
                favored_hours_bonus += weight * sum(work[e, d, t] for d in days for t in T)

    # Massive bonus for meeting explicit --timeset requests (paired with hard constraints)
    timeset_bonus = sum(TIMESET_BONUS_WEIGHT * assign[(e, d, t, r)] for (e, d, t, r) in forced_assignments)

    # Objective: Maximize coverage with priorities:
    # 1. Front desk coverage (weight 10000) - EXTREMELY HIGH PRIORITY - virtually guarantees coverage
    # 2. Large deviation penalty (weight 1) - MASSIVE penalty for being 2+ hours off target (-5000 per person)
    # 3. Department target hours (weight 1000) - DOUBLED to prioritize department hours
    # 4. Collaborative hours (weight 200) - STRONGLY encourage collaboration
    # 5. Office coverage (weight 150) - Encourage 2+ people in office at all times
    # 5b. Single coverage penalty (weight 500) - HEAVILY discourage only 1 person in office (risky!)
    # 6. Target adherence (weight 100) - STRONGLY encourage hitting target hours (graduated by year)
    # 7. Department spread (weight 60) - Prefer departmental presence across many time slots
    # 8. Department day coverage (weight 30) - Encourage each department to appear throughout the week
    # 9. Shift length preference (weight 20) - Gently prefer longer shifts (reduced to allow flexibility)
    # 10. Department scarcity penalty (weight 8) - Prefer pulling from richer departments to front desk
    # 11. Underclassmen at front desk (weight 3) - Moderate preference for freshmen at front desk
    # 12. Morning preference (weight 0.5) - VERY slight favor toward morning staffing (tiebreaker only)
    # 13. Total department hours (weight 1) - Fill available departmental capacity
    # Note: Front desk weight is 10x larger than before - will only be uncovered if IMPOSSIBLE
    #       (i.e., no front-desk-qualified employee available at that time slot)
    model.maximize(
        front_desk_coverage_score +             # Massive weighting baked into coverage score itself
        large_deviation_penalty +               # MASSIVE penalty for 2+ hour deviations (-5000 per person)
        objective_weights.department_target * department_target_score +
        department_large_deviation_penalty +    # Severe penalty for large department deviations
        objective_weights.collaborative_hours * collaborative_hours_score +
        training_overlap_penalty +
        objective_weights.office_coverage * office_coverage_score +
        objective_weights.single_coverage * single_coverage_penalty +
        objective_weights.target_adherence * target_adherence_score +
        objective_weights.department_spread * department_spread_score +
        objective_weights.department_day_coverage * department_day_coverage_score +
        objective_weights.shift_length * shift_length_bonus +
        objective_weights.department_scarcity * department_scarcity_penalty +
        objective_weights.underclassmen_front_desk * underclassmen_preference_score +
        objective_weights.morning_preference * morning_preference_score +
        shift_time_pref_score +                 # Per-employee shift time preferences (morning/afternoon)
        FAVORED_HOURS_BONUS_WEIGHT * favored_hours_bonus +
        objective_weights.department_total * total_department_units +
        timeset_bonus +
        favored_department_bonus +
        favored_fd_bonus +
        favored_emp_dept_bonus +
        training_overlap_bonus +
        equality_penalty
    )
    
    
    # ============================================================================
    # STEP 12: SOLVE THE MODEL
    # ============================================================================
    
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = solver_max_time

    stop_event = threading.Event()
    progress_thread = None
    if show_progress and solver_max_time:
        def _progress():
            start = time.time()
            while not stop_event.is_set():
                elapsed = time.time() - start
                pct = min(100, (elapsed / solver_max_time) * 100) if solver_max_time else 0
                try:
                    print(f"\rProgress: {elapsed:5.1f}s / {solver_max_time}s ({pct:4.1f}%)", end="", flush=True)
                except BrokenPipeError:
                    break  # Pipe closed, exit the progress loop
                stop_event.wait(1)
            try:
                print("\r", end="", flush=True)
            except BrokenPipeError:
                pass  # Ignore if pipe already closed
        progress_thread = threading.Thread(target=_progress, daemon=True)
        progress_thread.start()
    
    print("Solving the scheduling problem...")
    print(f"   - {len(employees)} employees")
    print(f"   - {len(days)} days")
    print(f"   - {len(T)} time slots per day")
    print(f"   - {len(assign)} assignment variables")

    # Debug: Validate model before solving
    validation_errors = model.validate()
    if validation_errors:
        print(f"\n  MODEL VALIDATION ERRORS:")
        print(f"    {validation_errors}")

    # Debug: Print model statistics
    model_proto = model.Proto()
    print(f"   - {len(model_proto.constraints)} constraints")
    print(f"   - {len(model_proto.variables)} total variables")
    print()

    # Track total execution time
    start_time = time.time()
    status = solver.solve(model)
    stop_event.set()
    if progress_thread:
        progress_thread.join(timeout=1)
    end_time = time.time()
    total_time = end_time - start_time

    # ============================================================================
    # STEP 12B: VALIDATE SOLUTION (detect impossible conditions)
    # ============================================================================
    if status in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
        validation_errors = []

        # Check for duplicate role assignments (same employee, same time, multiple roles)
        for e in employees:
            for d in days:
                for t in T:
                    assigned_roles = [
                        r for r in all_roles_including_forced
                        if (e, d, t, r) in assign and solver.value(assign[(e, d, t, r)])
                    ]
                    if len(assigned_roles) > 1:
                        validation_errors.append(
                            f"DUPLICATE: {e} assigned to {assigned_roles} at {d} slot {t} ({SLOT_NAMES[t]})"
                        )

        # Check for shift gaps (non-contiguous work without timeset gaps)
        for e in employees:
            for d in days:
                working_slots = [t for t in T if solver.value(work[e, d, t])]
                if len(working_slots) >= 2:
                    # Check for gaps
                    sorted_slots = sorted(working_slots)
                    for i in range(len(sorted_slots) - 1):
                        gap = sorted_slots[i + 1] - sorted_slots[i]
                        if gap > 1:
                            # Gap detected - check if this is allowed by timeset
                            if (e, d) not in forced_employee_days_with_gaps:
                                validation_errors.append(
                                    f"GAP: {e} on {d} has gap between slots {sorted_slots[i]} and {sorted_slots[i+1]}"
                                )

        if validation_errors:
            print("\n" + "=" * 60)
            print("VALIDATION ERRORS DETECTED IN SOLUTION")
            print("=" * 60)
            for err in validation_errors[:20]:  # Limit output
                print(f"  {err}")
            if len(validation_errors) > 20:
                print(f"  ... and {len(validation_errors) - 20} more errors")
            print()

    # ============================================================================
    # STEP 13: DISPLAY THE RESULTS
    # ============================================================================
    if status not in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
        print("\n" + "=" * 60)
        print("SCHEDULE COULD NOT BE GENERATED")
        print("=" * 60)
        print("\nThe solver couldn't find a valid schedule. Here's what we found:\n")

        issues_found = False

        # Check for timeset conflicts
        if timeset_details:
            print(f"TIMESETS ACTIVE ({len(timeset_details)} configured)")
            for ts in timeset_details:
                emp = ts["employee"]
                day = ts["day"]
                role = ts["role"]
                start_time = TIME_SLOT_STARTS[ts['slots'][0]]
                end_time = (
                    TIME_SLOT_STARTS[ts['slots'][-1] + 1]
                    if ts['slots'][-1] + 1 < len(TIME_SLOT_STARTS)
                    else f"{DAY_END_MINUTES // 60:02d}:{DAY_END_MINUTES % 60:02d}"
                )
                slot_range = f"{start_time}-{end_time}"
                hours = slots_to_hours(len(ts["slots"]))

                # Check potential issues with this timeset
                issues = []
                if not ts["is_qualified"]:
                    issues.append(f"{emp} is not normally qualified for {role}")

                # Check if this conflicts with other constraints
                emp_max = weekly_hour_limits.get(emp, 0)
                if hours > emp_max:
                    issues.append(f"Timeset ({hours}hrs) exceeds {emp}'s max hours ({emp_max}hrs)")

                # Double-check availability (shouldn't happen if validation passed, but just in case)
                emp_unavail = unavailable.get(emp, {}).get(day, [])
                blocked_slots = [SLOT_NAMES[t] for t in ts["slots"] if t in emp_unavail]
                if blocked_slots:
                    issues.append(f"CONFLICT: {emp} is unavailable on {day} at {', '.join(blocked_slots)}")

                print(f"  - {emp} -> {role} on {day} {slot_range} ({hours}hrs)")
                if issues:
                    issues_found = True
                    for issue in issues:
                        print(f"    WARNING: {issue}")

            # General timeset advice
            print(f"\n  Timesets create HARD constraints that MUST be satisfied.")
            print(f"  If your timeset conflicts with other requirements, the schedule will fail.")
            print(f"  Try removing timesets one at a time to identify the conflict.\n")
            issues_found = True

        # Check for SPECIFIC conflicts - front desk coverage during timesets
        if timeset_details:
            print("CHECKING FRONT DESK COVERAGE DURING TIMESETS")
            # Get all employees qualified for front desk
            fd_qualified = [e for e in employees if FRONT_DESK_ROLE in qual[e]]
            print(f"  Front desk qualified employees: {', '.join(fd_qualified)}")

            # For each timeset that's NOT front desk, check if front desk can be covered
            for ts in timeset_details:
                if ts["role"] == FRONT_DESK_ROLE:
                    continue  # This timeset IS front desk, no conflict

                emp = ts["employee"]
                day = ts["day"]
                slots = ts["slots"]
                start_time = TIME_SLOT_STARTS[slots[0]]
                end_time = (
                    TIME_SLOT_STARTS[slots[-1] + 1]
                    if slots[-1] + 1 < len(TIME_SLOT_STARTS)
                    else f"{DAY_END_MINUTES // 60:02d}:{DAY_END_MINUTES % 60:02d}"
                )

                # Check each slot - who can cover front desk?
                problem_slots = []
                for t in slots:
                    # Find who can cover front desk at this time (excluding the employee doing dept work)
                    available_fd = []
                    for fd_emp in fd_qualified:
                        if fd_emp == emp:
                            continue  # This person is doing dept work
                        # Check if they're available
                        if t not in unavailable.get(fd_emp, {}).get(day, []):
                            # Check if they're not also doing forced dept work at this time
                            is_forced_elsewhere = any(
                                fe == fd_emp and fd == day and ft == t and fr != FRONT_DESK_ROLE
                                for (fe, fd, ft, fr) in forced_assignments
                            )
                            if not is_forced_elsewhere:
                                available_fd.append(fd_emp)

                    if not available_fd:
                        problem_slots.append((t, TIME_SLOT_STARTS[t]))

                if problem_slots:
                    print(f"\n  CONFLICT: {emp} is forced to work {ts['role']} on {day} {start_time}-{end_time}")
                    print(f"    But NO ONE can cover front desk at these times:")
                    for slot, slot_time in problem_slots[:5]:
                        # Show why each FD-qualified person can't cover
                        print(f"      {slot_time}:")
                        for fd_emp in fd_qualified:
                            if fd_emp == emp:
                                print(f"        - {fd_emp}: doing {ts['role']} (this timeset)")
                            elif slot in unavailable.get(fd_emp, {}).get(day, []):
                                print(f"        - {fd_emp}: marked unavailable")
                            else:
                                # Check if forced elsewhere
                                forced_role = None
                                for (fe, fd, ft, fr) in forced_assignments:
                                    if fe == fd_emp and fd == day and ft == slot:
                                        forced_role = fr
                                        break
                                if forced_role:
                                    print(f"        - {fd_emp}: forced to work {forced_role}")
                                else:
                                    print(f"        - {fd_emp}: should be available (check other constraints)")
                    if len(problem_slots) > 5:
                        print(f"      ... and {len(problem_slots) - 5} more time slots")
                    issues_found = True
            print()

        if front_desk_unavailable_slots:
            issues_found = True
            preview = ", ".join(f"{d} {SLOT_NAMES[t]}" for d, t in front_desk_unavailable_slots[:5])
            more = "" if len(front_desk_unavailable_slots) <= 5 else f" (+{len(front_desk_unavailable_slots)-5} more)"
            print(f"FRONT DESK COVERAGE GAP")
            print(f"  No one is available to cover front desk at: {preview}{more}")
            print(f"  Fix: Add more employees with front desk qualification or expand their availability.\n")

        if training_available_overlap:
            for idx, available in training_available_overlap.items():
                req = validated_training[idx]
                if available == 0:
                    issues_found = True
                    print(f"TRAINING PAIR CONFLICT")
                    print(f"  {req['trainee_one']} & {req['trainee_two']} in {req['department']}")
                    print(f"  These employees have no overlapping availability - they can never work together.")
                    print(f"  Fix: Adjust their availability or remove this training pair.\n")
                elif available < TRAINING_MIN_SLOTS:
                    print(f"TRAINING PAIR WARNING")
                    print(f"  {req['trainee_one']} & {req['trainee_two']} in {req['department']}")
                    print(f"  Only {slots_to_hours(available):.1f} hours of overlapping availability (may be insufficient).\n")
        elif validated_training:
            issues_found = True
            print(f"TRAINING PAIR ISSUE")
            print(f"  Training pairs have no overlapping availability detected.")
            print(f"  Fix: Check that both employees are available at the same times.\n")

        # Calculate some helpful stats
        total_employee_target_hours = sum(target_weekly_hours.values())
        total_dept_target_hours = sum(department_hour_targets.values())
        total_available_slots = sum(
            1 for e in employees for d in days for t in T
            if t not in unavailable.get(e, {}).get(d, [])
        )
        total_available_hours = slots_to_hours(total_available_slots)

        print(f"SCHEDULE STATISTICS")
        print(f"  Total employee target hours: {total_employee_target_hours:.1f}")
        print(f"  Total department target hours: {total_dept_target_hours:.1f}")
        print(f"  Total available employee-hours: {total_available_hours:.1f}")
        if total_employee_target_hours > total_available_hours:
            print(f"  WARNING: Target hours ({total_employee_target_hours:.1f}) exceed available hours ({total_available_hours:.1f})!")
            issues_found = True
        print()

        if not issues_found:
            print("NO SPECIFIC ISSUE DETECTED")
            print("  The combination of constraints may be too restrictive.")
            print("  Suggestions:")
            print("    - Reduce employee target hours")
            print("    - Expand employee availability windows")
            print("    - Lower department hour targets")
            print("    - Remove some flags (training pairs, forced assignments, etc.)")
            print("    - Increase solver time limit\n")

        print("=" * 60)

    print_schedule(
        status,
        solver,
        employees,
        days,
        T,
        SLOT_NAMES,
        qual,
        work,
        assign,
        weekly_hour_limits,
        target_weekly_hours,
        total_time,
        roles,
        department_roles,
        ROLE_DISPLAY_NAMES,
        department_hour_targets,
        department_max_hours,
        primary_department_for_employee,
    )
    export_schedule_to_excel(
        status,
        solver,
        employees,
        days,
        T,
        SLOT_NAMES,
        qual,
        work,
        assign,
        weekly_hour_limits,
        target_weekly_hours,
        roles,
        department_roles,
        ROLE_DISPLAY_NAMES,
        department_hour_targets,
        department_max_hours,
        output_path,
        primary_department_for_employee,
    )
    export_formatted_schedule(
        status,
        solver,
        employees,
        days,
        T,
        TIME_SLOT_STARTS,
        SLOT_NAMES,
        qual,
        assign,
        department_roles,
        ROLE_DISPLAY_NAMES,
        department_hour_targets,
        department_max_hours,
        primary_department_for_employee,
        output_path,
    )
    return status

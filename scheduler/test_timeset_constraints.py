#!/usr/bin/env python3
"""
Comprehensive test to isolate the double-timeset infeasibility issue.

This script progressively adds constraints to find the breaking point.
"""

from ortools.sat.python import cp_model

from scheduler.config import (
    DEPARTMENT_UNITS_PER_HOUR,
    FAVORED_MIN_SLOTS,
    MIN_SLOTS,
    TIME_SLOT_STARTS,
    hours_to_slots,
)


def legacy_slot(slot_index: int) -> int:
    """Convert an old 30-minute slot index to the 10-minute grid."""
    return slot_index * 3


def legacy_slot_range(start: int, stop: int) -> range:
    """Convert an old half-hour slot range [start, stop) to the 10-minute grid."""
    return range(legacy_slot(start), legacy_slot(stop))


def run_real_scenario_diagnostic():
    """
    Diagnostic helper with more realistic data matching the actual solver.
    """
    print("\n" + "=" * 70)
    print("PROGRESSIVE CONSTRAINT TEST")
    print("=" * 70)

    T = list(range(len(TIME_SLOT_STARTS)))  # 8am-5pm in 10-minute slots
    days = ["Mon", "Tue", "Wed", "Thu", "Fri"]

    # Match the actual employees (12 employees)
    employees = [
        "Natalya", "Melissa", "Charlie", "Charley", "Elise", "Jaclynn",
        "Arushi", "Omar", "Reya", "Wednesday", "Natalie", "Devan"
    ]

    # Qualifications (simplified - FD qualified or not)
    fd_qualified = {"Melissa", "Charlie", "Elise", "Jaclynn", "Arushi", "Reya", "Devan"}

    qual = {}
    for e in employees:
        if e in fd_qualified:
            qual[e] = ["front_desk", "career_education", "cpd_support"]
        elif e == "Natalya":
            qual[e] = ["career_education"]  # NOT FD qualified
        elif e == "Wednesday":
            qual[e] = ["career_education"]  # NOT FD qualified
        else:
            qual[e] = ["career_education"]  # Default

    roles = ["front_desk", "career_education", "cpd_support"]

    # ALL timesets from the actual scenario
    forced_assignments = []
    # Natalya: career_education Wed 9am-1pm
    for t in legacy_slot_range(2, 10):
        forced_assignments.append(("Natalya", "Wed", t, "career_education"))
    # Natalya: front_desk Wed 4pm-5pm
    for t in legacy_slot_range(16, 18):
        forced_assignments.append(("Natalya", "Wed", t, "front_desk"))
    # Wednesday: career_education Wed 9am-1pm
    for t in legacy_slot_range(2, 10):
        forced_assignments.append(("Wednesday", "Wed", t, "career_education"))
    # Devan: cpd_support Mon 9am-3pm
    for t in legacy_slot_range(2, 14):
        forced_assignments.append(("Devan", "Mon", t, "cpd_support"))
    # Devan: cpd_support Wed 8am-12:30pm
    for t in legacy_slot_range(0, 9):
        forced_assignments.append(("Devan", "Wed", t, "cpd_support"))

    print(f"Employees: {len(employees)}")
    print(f"Days: {len(days)}")
    print(f"Timesets: {len(forced_assignments)} forced assignments")

    # Track which constraints groups are active
    constraint_groups = [
        "1. Forced assignments",
        "2. Work-to-assign link",
        "3. Shift contiguity (per day)",
        "4. Max shift length (per day)",
        "5. Weekly hour limits",
        "6. FD coverage when dept work",
        "7. Max 1 FD per slot",
        "8. FD minimum (2 hours with day exemption)",
        "9. FD contiguity",
        "10. Role contiguity",
        "11. Minimum shift length (2 hours)",
        "12. Department min block (2 hours non-FD)",
        "13. Role minimum (1 slot forbidden)",
        "14. STEP 9D cross-dept split restriction",
        "15. Department max hours",
        "16. Employee availability (basic)",
        "17. Target hours lower bound (HARD)",
    ]

    # Test incrementally
    for num_constraints in range(1, len(constraint_groups) + 1):
        result = _run_with_n_constraints(
            employees, days, T, roles, qual, forced_assignments,
            num_constraints, constraint_groups[:num_constraints]
        )
        if not result:
            print(f"\n>>> BREAKING CONSTRAINT: {constraint_groups[num_constraints-1]}")
            assert False, f"Breaking constraint: {constraint_groups[num_constraints-1]}"

    print("\n✓ ALL CONSTRAINTS PASS!")
    assert True


def _run_with_n_constraints(employees, days, T, roles, qual, forced_assignments, n, active_groups):
    """Test with first n constraint groups active."""
    print(f"\n[{n}] Testing with: {active_groups[-1]}...")

    model = cp_model.CpModel()

    # Track days with gaps in forced assignments
    from collections import defaultdict
    emp_day_slots = defaultdict(set)
    for (e, d, t, r) in forced_assignments:
        emp_day_slots[(e, d)].add(t)

    days_with_gaps = set()
    for (e, d), slots in emp_day_slots.items():
        sorted_slots = sorted(slots)
        has_gap = any(sorted_slots[i+1] - sorted_slots[i] > 1 for i in range(len(sorted_slots)-1))
        if has_gap:
            days_with_gaps.add((e, d))

    forced_employee_days = set((e, d) for (e, d) in emp_day_slots.keys())
    forced_slot_count = {(e, d): len(slots) for (e, d), slots in emp_day_slots.items()}

    # Create work variables
    work = {
        (e, d, t): model.new_bool_var(f"work[{e},{d},{t}]")
        for e in employees for d in days for t in T
    }

    # Create assign variables
    assign = {}
    for e in employees:
        for d in days:
            for t in T:
                for r in roles:
                    if r in qual[e] or (e, d, t, r) in forced_assignments:
                        assign[(e, d, t, r)] = model.new_bool_var(f"assign[{e},{d},{t},{r}]")

    # ========================================
    # CONSTRAINT GROUP 1: Forced assignments
    # ========================================
    if n >= 1:
        for (e, d, t, r) in forced_assignments:
            model.add(work[(e, d, t)] == 1)
            model.add(assign[(e, d, t, r)] == 1)

    # ========================================
    # CONSTRAINT GROUP 2: Work-to-assign link
    # ========================================
    if n >= 2:
        for e in employees:
            for d in days:
                for t in T:
                    role_sum = sum(assign.get((e, d, t, r), 0) for r in roles)
                    model.add(role_sum <= 1)
                    model.add(role_sum == work[(e, d, t)])

    # ========================================
    # CONSTRAINT GROUP 3: Shift contiguity
    # ========================================
    start = {}
    end = {}
    if n >= 3:
        start = {(e, d, t): model.new_bool_var(f"start[{e},{d},{t}]") for e in employees for d in days for t in T}
        end = {(e, d, t): model.new_bool_var(f"end[{e},{d},{t}]") for e in employees for d in days for t in T}

        for e in employees:
            for d in days:
                needs_split = (e, d) in days_with_gaps
                max_shifts = 2 if needs_split else 1

                model.add(sum(start[(e, d, t)] for t in T) <= max_shifts)
                model.add(sum(end[(e, d, t)] for t in T) <= max_shifts)
                model.add(sum(start[(e, d, t)] for t in T) == sum(end[(e, d, t)] for t in T))
                model.add(work[(e, d, 0)] == start[(e, d, 0)])
                for t in T[1:]:
                    model.add(work[(e, d, t)] - work[(e, d, t-1)] == start[(e, d, t)] - end[(e, d, t-1)])
                model.add(end[(e, d, T[-1])] == work[(e, d, T[-1])])

    # ========================================
    # CONSTRAINT GROUP 4: Max shift length
    # ========================================
    if n >= 4:
        for e in employees:
            for d in days:
                total_slots = sum(work[(e, d, t)] for t in T)
                forced_count = forced_slot_count.get((e, d), 0)
                max_slots = max(8, forced_count)  # Allow at least the forced count
                model.add(total_slots <= max_slots)

    # ========================================
    # CONSTRAINT GROUP 5: Weekly hour limits
    # ========================================
    if n >= 5:
        # Use actual limits from the debug output
        weekly_limits = {
            "Natalya": 14, "Melissa": 14, "Charlie": 12, "Charley": 15,
            "Elise": 14, "Jaclynn": 15.5, "Arushi": 14, "Omar": 12,
            "Reya": 14, "Wednesday": 14, "Natalie": 12, "Devan": 19
        }
        for e in employees:
            total_weekly_slots = sum(work[(e, d, t)] for d in days for t in T)
            max_hours = weekly_limits.get(e, 14)
            max_slots = hours_to_slots(max_hours)
            model.add(total_weekly_slots <= max_slots)
            # Also add universal 19h limit
            model.add(total_weekly_slots <= hours_to_slots(19))

    # ========================================
    # CONSTRAINT GROUP 6: FD coverage
    # ========================================
    if n >= 6:
        dept_roles = ["career_education", "cpd_support"]
        for e in employees:
            for d in days:
                for t in T:
                    for r in dept_roles:
                        if (e, d, t, r) in assign:
                            fd_coverage = sum(assign.get((emp, d, t, "front_desk"), 0) for emp in employees)
                            model.add(fd_coverage >= 1).only_enforce_if(assign[(e, d, t, r)])

    # ========================================
    # CONSTRAINT GROUP 7: Max 1 FD per slot
    # ========================================
    if n >= 7:
        for d in days:
            for t in T:
                fd_count = sum(assign.get((e, d, t, "front_desk"), 0) for e in employees)
                model.add(fd_count <= 1)

    # ========================================
    # CONSTRAINT GROUP 8: FD minimum (with day exemption)
    # ========================================
    if n >= 8:
        for e in employees:
            for d in days:
                total_fd = sum(assign.get((e, d, t, "front_desk"), 0) for t in T)
                has_forced_fd = any(f[0] == e and f[1] == d and f[3] == "front_desk" for f in forced_assignments)
                day_has_any_forced_fd = any(f[1] == d and f[3] == "front_desk" for f in forced_assignments)
                if not has_forced_fd and not day_has_any_forced_fd:
                    for short_fd_shift in range(1, MIN_SLOTS):
                        model.add(total_fd != short_fd_shift)

    # ========================================
    # CONSTRAINT GROUP 9: FD contiguity
    # ========================================
    if n >= 9:
        fd_start = {}
        fd_end = {}
        for e in employees:
            for d in days:
                for t in T:
                    if (e, d, t, "front_desk") in assign or "front_desk" in qual[e]:
                        fd_start[(e, d, t)] = model.new_bool_var(f"fd_start[{e},{d},{t}]")
                        fd_end[(e, d, t)] = model.new_bool_var(f"fd_end[{e},{d},{t}]")

        for e in employees:
            for d in days:
                if not any((e, d, t, "front_desk") in assign for t in T):
                    continue
                model.add(sum(fd_start.get((e, d, t), 0) for t in T) <= 1)
                model.add(sum(fd_end.get((e, d, t), 0) for t in T) <= 1)
                model.add(sum(fd_start.get((e, d, t), 0) for t in T) == sum(fd_end.get((e, d, t), 0) for t in T))

                for t in T:
                    if (e, d, t) not in fd_start:
                        continue
                    assign_curr = assign.get((e, d, t, "front_desk"), 0)
                    assign_prev = assign.get((e, d, t-1, "front_desk"), 0) if t > 0 else 0
                    if t == 0:
                        model.add(assign_curr == fd_start.get((e, d, 0), 0))
                    else:
                        model.add(assign_curr - assign_prev == fd_start.get((e, d, t), 0) - fd_end.get((e, d, t-1), 0))
                if (e, d, T[-1]) in fd_start:
                    model.add(fd_end.get((e, d, T[-1]), 0) == assign.get((e, d, T[-1], "front_desk"), 0))

    # ========================================
    # CONSTRAINT GROUP 10: Role contiguity
    # ========================================
    if n >= 10:
        role_start = {}
        role_end = {}
        for e in employees:
            for d in days:
                for t in T:
                    for r in roles:
                        if (e, d, t, r) in assign:
                            role_start[(e, d, t, r)] = model.new_bool_var(f"role_start[{e},{d},{t},{r}]")
                            role_end[(e, d, t, r)] = model.new_bool_var(f"role_end[{e},{d},{t},{r}]")

        for e in employees:
            for d in days:
                for r in roles:
                    if not any((e, d, t, r) in assign for t in T):
                        continue
                    model.add(sum(role_start.get((e, d, t, r), 0) for t in T) <= 1)
                    model.add(sum(role_end.get((e, d, t, r), 0) for t in T) <= 1)
                    model.add(sum(role_start.get((e, d, t, r), 0) for t in T) == sum(role_end.get((e, d, t, r), 0) for t in T))

                    first_slot = None
                    for t in T:
                        if (e, d, t, r) in assign:
                            first_slot = t
                            break
                    if first_slot is not None:
                        model.add(assign[(e, d, first_slot, r)] == role_start.get((e, d, first_slot, r), 0))

                    for t in T[1:]:
                        if (e, d, t, r) in assign and (e, d, t-1, r) in assign:
                            model.add(
                                assign[(e, d, t, r)] - assign[(e, d, t-1, r)] ==
                                role_start[(e, d, t, r)] - role_end[(e, d, t-1, r)]
                            )

                    if (e, d, T[-1], r) in assign:
                        model.add(role_end.get((e, d, T[-1], r), 0) == assign[(e, d, T[-1], r)])

    # ========================================
    # CONSTRAINT GROUP 11: Minimum shift length
    # ========================================
    if n >= 11:
        for e in employees:
            for d in days:
                total_slots = sum(work[(e, d, t)] for t in T)
                works_today = model.new_bool_var(f"works_today[{e},{d}]")
                model.add(total_slots >= 1).only_enforce_if(works_today)
                model.add(total_slots == 0).only_enforce_if(works_today.Not())

                has_forced = (e, d) in forced_employee_days
                if not has_forced:
                    model.add(total_slots >= MIN_SLOTS).only_enforce_if(works_today)
                    for short_shift in range(1, MIN_SLOTS):
                        model.add(total_slots != short_shift)

    # ========================================
    # CONSTRAINT GROUP 12: Department min block (2 hours)
    # ========================================
    if n >= 12:
        dept_roles = ["career_education", "cpd_support"]
        for e in employees:
            for d in days:
                for r in dept_roles:
                    if not any((e, d, t, r) in assign for t in T):
                        continue
                    total_dept = sum(assign.get((e, d, t, r), 0) for t in T)
                    has_forced_dept = any(f[0] == e and f[1] == d and f[3] == r for f in forced_assignments)
                    if not has_forced_dept:
                        for short_block in range(1, MIN_SLOTS):
                            model.add(total_dept != short_block)

    # ========================================
    # CONSTRAINT GROUP 13: Role minimum (forbid 1-slot)
    # ========================================
    if n >= 13:
        for e in employees:
            for d in days:
                for r in roles:
                    if not any((e, d, t, r) in assign for t in T):
                        continue
                    total_role = sum(assign.get((e, d, t, r), 0) for t in T)
                    has_forced_role = any(f[0] == e and f[1] == d and f[3] == r for f in forced_assignments)
                    day_has_any_forced_fd = any(f[1] == d and f[3] == "front_desk" for f in forced_assignments)
                    fd_exempt = (r == "front_desk" and day_has_any_forced_fd)
                    if not has_forced_role and not fd_exempt:
                        for short_role in range(1, FAVORED_MIN_SLOTS):
                            model.add(total_role != short_role)

    # ========================================
    # CONSTRAINT GROUP 14: STEP 9D cross-dept split
    # ========================================
    if n >= 14:
        dept_roles = ["career_education", "cpd_support"]
        for e in employees:
            for d in days:
                has_1_hour_block = {}
                for r in dept_roles:
                    total_r = sum(assign.get((e, d, t, r), 0) for t in T)
                    has_1h = model.new_bool_var(f"has_1h_block[{e},{d},{r}]")
                    model.add(total_r == FAVORED_MIN_SLOTS).only_enforce_if(has_1h)
                    model.add(total_r != FAVORED_MIN_SLOTS).only_enforce_if(has_1h.Not())
                    has_1_hour_block[r] = has_1h

                num_with_1h = sum(has_1_hour_block.values())
                total_shift = sum(work[(e, d, t)] for t in T)

                is_min_shift = model.new_bool_var(f"is_min_shift[{e},{d}]")
                model.add(total_shift == MIN_SLOTS).only_enforce_if(is_min_shift)
                model.add(total_shift != MIN_SLOTS).only_enforce_if(is_min_shift.Not())

                model.add(num_with_1h <= 1).only_enforce_if(is_min_shift)

    # ========================================
    # CONSTRAINT GROUP 15: Department max hours
    # ========================================
    if n >= 15:
        dept_roles = ["career_education", "cpd_support"]
        # Typical department max hours from real scenario
        dept_max_hours = {"career_education": 20, "cpd_support": 15}

        department_assignments = {
            r: sum(assign.get((e, d, t, r), 0) for e in employees for d in days for t in T)
            for r in dept_roles
        }

        # Simplified effective units: 2 * assignments (ignoring dual FD credit for now)
        for r in dept_roles:
            max_units = int(dept_max_hours[r] * DEPARTMENT_UNITS_PER_HOUR)
            model.add(2 * department_assignments[r] <= max_units)

    # ========================================
    # CONSTRAINT GROUP 16: Employee availability
    # ========================================
    if n >= 16:
        # Simulate some realistic unavailability
        # Each non-favored employee unavailable ~30% of slots randomly
        import random
        random.seed(42)  # Reproducible

        unavailable = {}
        for e in employees:
            # Don't make employees unavailable during their forced assignments
            forced_slots_for_e = {(d, t) for (emp, d, t, r) in forced_assignments if emp == e}
            unavailable[e] = {}
            for d in days:
                unavail_slots = []
                for t in T:
                    if (d, t) not in forced_slots_for_e:
                        # 30% chance of being unavailable
                        if random.random() < 0.3:
                            unavail_slots.append(t)
                if unavail_slots:
                    unavailable[e][d] = unavail_slots

        # Add availability constraints
        for e in employees:
            for d in days:
                if e in unavailable and d in unavailable[e]:
                    for t in unavailable[e][d]:
                        model.add(work[(e, d, t)] == 0)

    # ========================================
    # CONSTRAINT GROUP 17: Target hours lower bound
    # ========================================
    if n >= 17:
        # Typical target hours and delta from real scenario
        # TARGET_HARD_DELTA_HOURS is typically 5 hours
        # So employees must work between (target - 5) and (target + 5) hours
        target_hours_map = {
            "Natalya": 11, "Melissa": 11, "Charlie": 11, "Charley": 11,
            "Elise": 11, "Jaclynn": 11, "Arushi": 11, "Omar": 11,
            "Reya": 11, "Wednesday": 11, "Natalie": 11, "Devan": 15
        }
        delta_hours = 5  # TARGET_HARD_DELTA_HOURS

        # Count forced department slots that need FD coverage
        total_forced_dept_slots = sum(
            1 for (e, d, t, r) in forced_assignments
            if r != "front_desk"
        )

        for e in employees:
            total_weekly_slots = sum(work[(e, d, t)] for d in days for t in T)
            target_slots = hours_to_slots(target_hours_map.get(e, 11))
            delta_slots = hours_to_slots(delta_hours)
            lower_bound = max(0, target_slots - delta_slots)
            upper_bound = target_slots + delta_slots

            # Adjust for weekly limits
            max_hours = weekly_limits.get(e, 14)
            upper_bound = min(upper_bound, hours_to_slots(max_hours))

            # RELAX LOWER BOUND when timesets are active
            # Timesets create coverage needs that may prevent employees from hitting targets
            if forced_assignments and lower_bound > 0:
                if total_forced_dept_slots >= hours_to_slots(5):
                    reduction = min(
                        lower_bound,
                        (total_forced_dept_slots // hours_to_slots(5)) * hours_to_slots(1),
                    )
                    lower_bound = max(0, lower_bound - reduction)

            # HARD constraints
            model.add(total_weekly_slots >= lower_bound)
            model.add(total_weekly_slots <= upper_bound)

    # ========================================
    # SOLVE
    # ========================================
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 30

    # Print model stats
    num_vars = model.Proto().variables.__len__()
    num_constraints = model.Proto().constraints.__len__()
    print(f"    Model: {num_vars} vars, {num_constraints} constraints, {len(assign)} assign vars")

    status = solver.solve(model)

    if status in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
        print(f"    ✓ FEASIBLE")
        return True
    else:
        print(f"    ✗ INFEASIBLE")
        return False


def test_natalya_role_contiguity():
    """
    Test specifically if Natalya's split roles (career_ed + FD) break role contiguity.

    Natalya on Wed:
    - career_education slots 2-9 (8 slots, 4 hours)
    - front_desk slots 16-17 (2 slots, 1 hour)

    This is TWO different roles on the same day with a gap.
    The role contiguity constraint requires each role to have at most 1 start/end.
    """
    print("\n" + "=" * 70)
    print("SPECIAL TEST: Natalya's Multi-Role Day")
    print("=" * 70)

    model = cp_model.CpModel()
    T = list(range(len(TIME_SLOT_STARTS)))

    # Just Natalya + FD coverage employee
    employees = ["Natalya", "Melissa"]
    qual = {
        "Natalya": ["career_education"],  # Normally NOT FD qualified
        "Melissa": ["front_desk", "career_education"],
    }
    roles = ["front_desk", "career_education"]

    forced_assignments = [
        *[("Natalya", t, "career_education") for t in legacy_slot_range(2, 10)],
        *[("Natalya", t, "front_desk") for t in legacy_slot_range(16, 18)],
    ]

    # Create work variables
    work = {(e, t): model.new_bool_var(f"work[{e},{t}]") for e in employees for t in T}

    # Create assign variables - IMPORTANT: include forced roles
    assign = {}
    for e in employees:
        for t in T:
            for r in roles:
                if r in qual[e] or (e, t, r) in forced_assignments:
                    assign[(e, t, r)] = model.new_bool_var(f"assign[{e},{t},{r}]")

    print(f"\nNatalya's assign variables for front_desk: {[(t) for t in T if ('Natalya', t, 'front_desk') in assign]}")
    print(f"Natalya's assign variables for career_ed: {[(t) for t in T if ('Natalya', t, 'career_education') in assign]}")

    # Forced assignments
    for (e, t, r) in forced_assignments:
        model.add(work[(e, t)] == 1)
        model.add(assign[(e, t, r)] == 1)

    # Work-to-assign link
    for e in employees:
        for t in T:
            role_sum = sum(assign.get((e, t, r), 0) for r in roles)
            model.add(role_sum <= 1)
            model.add(role_sum == work[(e, t)])

    # Shift contiguity (allow split for Natalya)
    start = {(e, t): model.new_bool_var(f"start[{e},{t}]") for e in employees for t in T}
    end = {(e, t): model.new_bool_var(f"end[{e},{t}]") for e in employees for t in T}
    for e in employees:
        max_shifts = 2 if e == "Natalya" else 1
        model.add(sum(start[(e, t)] for t in T) <= max_shifts)
        model.add(sum(end[(e, t)] for t in T) <= max_shifts)
        model.add(sum(start[(e, t)] for t in T) == sum(end[(e, t)] for t in T))
        model.add(work[(e, 0)] == start[(e, 0)])
        for t in T[1:]:
            model.add(work[(e, t)] - work[(e, t-1)] == start[(e, t)] - end[(e, t-1)])
        model.add(end[(e, T[-1])] == work[(e, T[-1])])

    # Max shift length
    for e in employees:
        total_slots = sum(work[(e, t)] for t in T)
        max_slots = hours_to_slots(5) if e == "Natalya" else hours_to_slots(4)
        model.add(total_slots <= max_slots)

    # FD coverage when dept work
    for t in T:
        for e in employees:
            if (e, t, "career_education") in assign:
                fd_coverage = sum(assign.get((emp, t, "front_desk"), 0) for emp in employees)
                model.add(fd_coverage >= 1).only_enforce_if(assign[(e, t, "career_education")])

    # Max 1 FD per slot
    for t in T:
        fd_count = sum(assign.get((e, t, "front_desk"), 0) for e in employees)
        model.add(fd_count <= 1)

    # FD minimum (EXEMPT since forced FD exists)
    # day_has_any_forced_fd = True for this scenario, so no constraint added

    # FD contiguity (should NOT break because Natalya has sparse FD variables)
    fd_start = {(e, t): model.new_bool_var(f"fd_start[{e},{t}]") for e in employees for t in T if (e, t, "front_desk") in assign}
    fd_end = {(e, t): model.new_bool_var(f"fd_end[{e},{t}]") for e in employees for t in T if (e, t, "front_desk") in assign}

    print(f"\nNatalya's FD start/end variables: {[(t) for t in T if ('Natalya', t) in fd_start]}")
    print(f"Melissa's FD start/end variables: {[(t) for t in T if ('Melissa', t) in fd_start]}")

    for e in employees:
        if not any((e, t, "front_desk") in assign for t in T):
            continue

        model.add(sum(fd_start.get((e, t), 0) for t in T) <= 1)
        model.add(sum(fd_end.get((e, t), 0) for t in T) <= 1)
        model.add(sum(fd_start.get((e, t), 0) for t in T) == sum(fd_end.get((e, t), 0) for t in T))

        # Find first slot with FD assignment
        first_fd_slot = None
        for t in T:
            if (e, t, "front_desk") in assign:
                first_fd_slot = t
                break

        if first_fd_slot is not None:
            model.add(assign[(e, first_fd_slot, "front_desk")] == fd_start[(e, first_fd_slot)])

        for t in T[1:]:
            if (e, t, "front_desk") in assign and (e, t-1, "front_desk") in assign:
                model.add(
                    assign[(e, t, "front_desk")] - assign[(e, t-1, "front_desk")] ==
                    fd_start[(e, t)] - fd_end[(e, t-1)]
                )

        last_fd_slot = None
        for t in reversed(T):
            if (e, t, "front_desk") in assign:
                last_fd_slot = t
                break
        if last_fd_slot is not None:
            model.add(fd_end[(e, last_fd_slot)] == assign[(e, last_fd_slot, "front_desk")])

    # ========================================
    # NOW ADD ROLE CONTIGUITY (STEP 9C)
    # This is the tricky part - Natalya does TWO different roles
    # ========================================
    print("\nAdding role contiguity for ALL roles...")
    role_start = {}
    role_end = {}
    for e in employees:
        for t in T:
            for r in roles:
                if (e, t, r) in assign:
                    role_start[(e, t, r)] = model.new_bool_var(f"role_start[{e},{t},{r}]")
                    role_end[(e, t, r)] = model.new_bool_var(f"role_end[{e},{t},{r}]")

    for e in employees:
        for r in roles:
            slots_with_role = [t for t in T if (e, t, r) in assign]
            if not slots_with_role:
                continue

            print(f"  {e} - {r}: slots {slots_with_role}")

            # At most 1 start and 1 end per role
            model.add(sum(role_start.get((e, t, r), 0) for t in T) <= 1)
            model.add(sum(role_end.get((e, t, r), 0) for t in T) <= 1)
            model.add(sum(role_start.get((e, t, r), 0) for t in T) == sum(role_end.get((e, t, r), 0) for t in T))

            # First slot boundary
            first_slot = slots_with_role[0]
            model.add(assign[(e, first_slot, r)] == role_start[(e, first_slot, r)])

            # Transitions - ONLY for CONSECUTIVE slots that both have assign variables
            for t in T[1:]:
                if (e, t, r) in assign and (e, t-1, r) in assign:
                    model.add(
                        assign[(e, t, r)] - assign[(e, t-1, r)] ==
                        role_start[(e, t, r)] - role_end[(e, t-1, r)]
                    )

            # Last slot boundary
            last_slot = slots_with_role[-1]
            model.add(role_end[(e, last_slot, r)] == assign[(e, last_slot, r)])

    # Solve
    solver = cp_model.CpSolver()
    status = solver.solve(model)

    status_names = {
        cp_model.OPTIMAL: "OPTIMAL",
        cp_model.FEASIBLE: "FEASIBLE",
        cp_model.INFEASIBLE: "INFEASIBLE",
        cp_model.MODEL_INVALID: "MODEL_INVALID",
        cp_model.UNKNOWN: "UNKNOWN",
    }

    print(f"\nResult: {status_names.get(status, status)}")

    if status in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
        print("\n✓ Multi-role day works!")
        for e in employees:
            slots = [t for t in T if solver.value(work[(e, t)]) == 1]
            if slots:
                roles_by_slot = {}
                for t in slots:
                    for r in roles:
                        if (e, t, r) in assign and solver.value(assign[(e, t, r)]) == 1:
                            roles_by_slot[t] = r
                print(f"  {e}: {slots} -> {roles_by_slot}")
    else:
        print("\n✗ Multi-role day fails!")

    assert status in [cp_model.OPTIMAL, cp_model.FEASIBLE]


if __name__ == "__main__":
    # First run the special Natalya test
    test_natalya_role_contiguity()

    # Then run the progressive constraint test
    test_with_real_scenario()

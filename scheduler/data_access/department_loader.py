"""CSV loading utilities for department requirements.

This module provides functions to read and parse department staffing requirements
from a CSV file. The requirements specify target and maximum hours for each
department (e.g., "Marketing should have 15-20 hours staffed per week").
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, Tuple

import pandas as pd

from scheduler.config import is_slot_aligned_hours
from scheduler.domain.models import DepartmentRequirements, normalize_department_name
from scheduler.data_access.staff_loader import _coerce_numeric, _normalize_columns


def _require_slot_aligned_hours(value: float, column_name: str, record_name: str) -> float:
    if not is_slot_aligned_hours(value):
        raise ValueError(
            f"Invalid hour value '{value}' for column '{column_name}' on record '{record_name}': "
            "values must align to the 10-minute slot grid."
        )
    return value


def load_department_requirements(path: Path) -> DepartmentRequirements:
    """Load department staffing requirements from a CSV file.
    
    Expected CSV columns:
    - department: Name of the department (e.g., "marketing", "events")
    - target_hours: Desired weekly hours for this department
    - max_hours: Maximum allowed weekly hours for this department
    
    Args:
        path: Path to the CSV file containing department requirements.
    
    Returns:
        DepartmentRequirements dataclass with targets and max_hours dicts.
    
    Raises:
        FileNotFoundError: If the CSV file doesn't exist.
        ValueError: If required columns are missing, data is invalid, or
                   target_hours exceeds max_hours.
    
    Example:
        >>> reqs = load_department_requirements(Path("cpd-requirements.csv"))
        >>> print(reqs.targets["marketing"])  # 15.0
        >>> print(reqs.max_hours["marketing"])  # 20.0
    """
    # Verify the file exists before attempting to read it
    if not path.exists():
        raise FileNotFoundError(f"Department requirements CSV not found: {path}")

    # Read the CSV file into a pandas DataFrame
    df = pd.read_csv(path)
    
    # Strip whitespace from column names (handles "department ", " target_hours", etc.)
    df.columns = [col.strip() for col in df.columns]
    
    # Create a case-insensitive mapping of column names
    # e.g., {"department": "department", "target_hours": "target_hours"}
    column_map = _normalize_columns(df)

    # Helper function to require a column and return its actual name
    def require_column(name: str) -> str:
        if name not in column_map:
            raise ValueError(f"Required column '{name}' not found in {path}")
        return column_map[name]

    # Get the actual column names from the CSV
    dept_col = require_column("department")
    target_col = require_column("target_hours")
    max_col = require_column("max_hours")

    # Initialize storage for parsed data
    department_targets: Dict[str, float] = {}
    department_max_hours: Dict[str, float] = {}
    department_order: list[str] = []  # Track order as they appear in CSV
    department_display_names: Dict[str, str] = {}  # normalized -> original name

    # Iterate through each row in the CSV
    for _, row in df.iterrows():
        # Capture original name before normalization (for display in output)
        original_name = str(row[dept_col]).strip()
        # Extract and normalize the department name (handles spaces, underscores, case)
        department = normalize_department_name(original_name)
        
        # Validate: department name cannot be empty
        if not department:
            raise ValueError("Department requirements CSV contains an empty department name.")
        
        # Validate: no duplicate departments allowed
        if department in department_targets:
            raise ValueError(f"Duplicate department entry detected: '{department}'")

        # Parse and validate numeric values (coerce to float)
        target_hours = _require_slot_aligned_hours(
            _coerce_numeric(row[target_col], target_col, department),
            target_col,
            department,
        )
        max_hours = _require_slot_aligned_hours(
            _coerce_numeric(row[max_col], max_col, department),
            max_col,
            department,
        )
        
        # Validate: target cannot exceed maximum
        if max_hours < target_hours:
            raise ValueError(
                f"Department '{department}' has target hours ({target_hours}) exceeding max hours ({max_hours})."
            )
        
        # Store the validated data
        department_targets[department] = target_hours
        department_max_hours[department] = max_hours
        department_order.append(department)
        department_display_names[department] = original_name

    # Return a frozen DepartmentRequirements dataclass
    # (immutable to prevent accidental modification)
    return DepartmentRequirements(
        targets=department_targets,
        max_hours=department_max_hours,
        order=department_order,
        display_names=department_display_names,
    )

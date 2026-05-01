# Semester Scheduler - Electron Desktop App

A sleek, accessible desktop application for generating optimized weekly schedules for student employees. Built with Electron, React, TypeScript, and OR-Tools CP-SAT solver.

## Features

- **CSV Import/Export**: Drag-and-drop or file picker for staff and department data
- **Staff Editor**: Grid-based editor with availability matrix (10-min slots) and travel-buffer flags
- **Department Budgets**: Configure target/max hours per department
- **Solver Flags**: Favored employees, training pairs, department priorities, time slot requests
- **Presets**: Save and load flag configurations
- **Live Progress**: Real-time solver progress and logs
- **Excel Output**: Download generated schedules as XLSX
- **Accessibility**: High contrast mode, keyboard navigation, screen reader support

## Requirements

- Node.js 18+
- Python 3.12+ with pip
- OR-Tools and dependencies (see `requirements.txt`)

## Development Setup

```bash
# Navigate to electron app directory
cd electron-app

# Install dependencies
npm install

# Start full development mode (main watcher + Vite + Electron)
npm run dev

# Launch the built desktop app
npm run build
npm start
```

## Project Structure

```
electron-app/
├── src/
│   ├── main/           # Electron main process
│   │   ├── main.ts     # Window lifecycle, IPC handlers
│   │   ├── preload.ts  # Secure bridge to renderer
│   │   └── ipc-types.ts # Shared type definitions
│   └── renderer/       # React UI
│       ├── components/ # UI components
│       ├── store/      # Zustand state management
│       ├── hooks/      # Custom React hooks
│       └── utils/      # CSV validators, helpers
├── e2e/                # Playwright E2E tests
├── assets/             # App icons
├── samples/            # Sample CSV files
└── scripts/            # Build/packaging scripts
```

## Building for Production

```bash
# Build everything
npm run build

# Package for current platform
npm run package

# Package for specific platforms
npm run package:mac
npm run package:win
npm run package:linux
```

### Bundling Python

The app requires a Python environment with OR-Tools. For distribution:

```bash
# macOS/Linux
./scripts/bundle-python.sh

# Windows (PowerShell)
./scripts/bundle-python.ps1
```

## Testing

```bash
# Run unit tests
npm test

# Run E2E tests (requires built app)
npm run test:e2e
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘/Ctrl + 1-5` | Switch tabs |
| `⌘/Ctrl + ,` | Open settings |
| `Esc` | Close modal/settings |
| `Tab` | Navigate elements |
| `←/→` | Navigate within tabs |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Electron Main Process                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Window    │  │    IPC      │  │   Python Solver     │  │
│  │  Lifecycle  │  │  Handlers   │  │   (child_process)   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                          │                                   │
│                   ┌──────┴──────┐                            │
│                   │   Preload   │ (contextIsolation)         │
│                   └──────┬──────┘                            │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────┐
│                   Renderer Process                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │    React    │  │   Zustand   │  │      Components     │  │
│  │     App     │  │    Store    │  │    (Tabs, Editor)   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## IPC Channels

- `files:openCsv` / `files:saveCsv` - File operations
- `settings:load` / `settings:save` - Persistent settings
- `solver:run` / `solver:cancel` - Solver control
- `solver:progress` / `solver:log` - Live updates (events)

## Offline Operation

This app runs **100% locally**:
- No network requests required
- All data stored in local files
- Python solver runs as local subprocess
- Settings persisted in user data directory

## License

MIT License - See LICENSE file for details.

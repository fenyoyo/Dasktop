# Dasktop

English | [中文](README.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Windows 11](https://img.shields.io/badge/Windows-11-0078D4.svg)](#requirements) [![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app/) [![Vue 3](https://img.shields.io/badge/Vue-3-42B883.svg)](https://vuejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6.svg)](https://www.typescriptlang.org/)

Dasktop is a lightweight Windows desktop organizer. It uses movable, resizable Boxes to group desktop files, folders, and shortcuts by purpose, keeping the desktop tidy while preserving the original file locations and Windows opening behavior.

Download the latest installer from [GitHub Releases](https://github.com/AugSakura/Dasktop/releases). See the full release history in [CHANGELOG.md](CHANGELOG.md).

![Dasktop cover](docs/images/Dasktop_Cover.png)


## Name Origin

The name Dasktop is a small signature hidden inside the desktop. It starts with `Da` from the author's name and lands on the Desktop that people open every day. The result is a tool with a personal mark and a direct goal: make the desktop feel less like a pile of files and more like a controllable workspace.

## Positioning

Dasktop is designed for users who often keep temporary materials, project files, app shortcuts, system desktop icons, or client documents on the desktop. It is not a traditional file manager. It is an organization layer on top of the Windows desktop, so users can keep their familiar workflow while using Boxes to find different types of content more quickly, including system entry points such as This PC, Recycle Bin, and Network.

## Core Features

- **Desktop grouping:** Create multiple Boxes and organize desktop items by work, projects, materials, tools, or other scenarios.
- **Free placement:** Move and resize Boxes on the desktop, with snapping support near screen edges or other Boxes.
- **Quick collection:** Drag desktop files, folders, shortcuts, or system desktop icons into a Box to create a clear visual grouping.
- **System icon collection:** Collect This PC, Recycle Bin, Network, Control Panel, and the user folder, then hide or restore native icons based on Box references.
- **Drag sorting:** Detect insertion positions for files inside a Box, files moved across Boxes, and system virtual icons, with an insertion line showing the release position.
- **Native system behavior:** Files still open with the Windows default apps, and context menus keep native Windows capabilities.
- **Adjustable appearance:** Switch between light mode, dark mode, and system theme, and tune opacity, radius, icon size, text size, and spacing.
- **Cleaner desktop:** Optionally hide native desktop icons and keep only the Dasktop organization view visible.
- **Startup restore:** Enable launch on startup and automatically restore the last desktop layout after signing in to Windows.
- **Single-instance app:** Launching Dasktop again focuses the existing app instead of starting another desktop controller.
- **Tray controls:** Use the system tray to open settings, create a Box, toggle desktop icon visibility, or quit the app.

## How To Use

1. Open Dasktop and enter the settings window.
2. Click **Add Box** to create a desktop group.
3. Drag desktop files, folders, shortcuts, or system desktop icons into the Box.
4. Drag items inside the Box and use the insertion line to adjust their order.
5. Adjust the Box position, size, appearance, and lock state as needed.
6. Enable **Launch on startup** to restore the organized desktop layout after the next Windows sign-in.

## Safety Notes

- Deleting a Box applies the current deletion policy to its real collection folder. Check the policy and any content you need to keep before deleting.
- Collecting system desktop icons into Boxes stores references only. It does not remove or damage the native Windows system entry points.
- Hiding native desktop icons only changes visibility. It does not move, empty, or delete desktop files, and Dasktop restores the previous icon visibility state when it exits.
- Opening files and using context menus rely on Windows system capabilities, keeping the experience aligned with the native desktop.

## Requirements

- Operating system: Windows
- App name: Dasktop

## Development

To run from source, see the [Development Guide](docs/development.md) (Chinese). It
covers prerequisites, a one-command environment check (`scripts/setup-dev.ps1`), and
troubleshooting for common build issues:

```powershell
# Check the dev environment (read-only, changes nothing)
.\scripts\setup-dev.ps1

# Check and auto-install missing dependencies, then start developing
.\scripts\setup-dev.ps1 -Install
pnpm install
pnpm tauri dev
```

## Feedback

Dasktop is still in an early public version. If you run into file drag-and-drop issues, runtime dependency problems, window layering behavior, uninstall leftovers, or compatibility issues across Windows versions, feel free to open an [Issue](https://github.com/AugSakura/Dasktop/issues) with reproduction steps.

## Author

- Developer: Aug_Sakura
- Personal blog: [余某人 | 咕咕咕中~](https://www.syand.cn/)

## License

This project is open source under the [MIT License](LICENSE).

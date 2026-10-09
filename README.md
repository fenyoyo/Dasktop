# Dasktop

中文 | [English](README.en.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Windows 11](https://img.shields.io/badge/Windows-11-0078D4.svg)](#requirements) [![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app/) [![Vue 3](https://img.shields.io/badge/Vue-3-42B883.svg)](https://vuejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6.svg)](https://www.typescriptlang.org/)

Dasktop 是一款面向 Windows 桌面的轻量整理工具。它通过可移动、可调整大小的 Box，把桌面上的文件、文件夹和快捷方式按用途分组，让桌面保持清爽，同时保留原有文件位置和系统打开方式

可以在 [GitHub Releases](https://github.com/AugSakura/Dasktop/releases) 下载最新版安装包，完整更新记录见 [CHANGELOG.md](CHANGELOG.md) 


![Dasktop cover](docs/images/Dasktop_Cover.png)


## 名字由来

Dasktop 这个名字像一个藏在桌面里的签名：它从作者名字中的 `Da` 出发，落到每天都会被打开的 Desktop 上。于是这个工具有了一个带着个人印记的名字，也有了一个更直接的目标：让桌面不只是堆放文件的地方，而是可以被轻轻整理、重新掌控的工作入口



## 产品定位

Dasktop 适合经常在桌面临时保存资料、项目文件、软件快捷方式、系统桌面图标或客户资料的用户。它不是传统文件管理器，而是桌面上的整理层：用户可以继续使用熟悉的 Windows 桌面，同时用 Box 让不同类型的内容更容易找到，并把此电脑、回收站、网络等系统入口纳入同一套桌面整理视图



## 核心能力

- **桌面分组：** 创建多个 Box，将桌面项目按工作、项目、资料、工具等场景分类
- **自由摆放：** Box 可以在桌面上拖动、缩放，并支持贴近屏幕边缘或其他 Box 时自动吸附
- **快速收纳：** 将桌面文件、文件夹、快捷方式或系统桌面图标拖入 Box，即可形成清晰的分组关系
- **系统图标收纳：** 支持收纳此电脑、回收站、网络、控制面板和用户文件夹，并按 Box 引用自动隐藏或恢复原生图标
- **拖拽排序：** 支持 Box 内文件、跨 Box 文件和系统虚拟图标的排序落点识别，通过插入线提示释放位置
- **保持系统体验：** 文件仍使用 Windows 默认程序打开，右键菜单也保留系统原生能力
- **外观可调：** 支持浅色、深色、跟随系统主题，并可调整透明度、圆角、图标大小、文字大小和间距
- **桌面更清爽：** 可选择隐藏系统原生桌面图标，只保留 Dasktop 的整理视图
- **开机恢复：** 支持开机自启，登录后自动恢复上次整理好的桌面布局
- **单实例运行：** 重复启动时会唤起已有应用窗口，避免多个 Dasktop 进程同时接管桌面
- **托盘入口：** 可从系统托盘打开设置、新增 Box、切换桌面图标显示或退出应用



## 使用方式

1. 打开 Dasktop 后，进入设置窗口
2. 点击「新增 Box」，创建一个桌面分组
3. 将桌面文件、文件夹、快捷方式或系统桌面图标拖入 Box
4. 在 Box 内拖动项目时，根据插入线提示调整排序位置
5. 根据需要调整 Box 的位置、大小、外观和锁定状态
6. 开启「开机自启」后，下次登录 Windows 会自动恢复桌面整理状态



## 安全说明

- 删除 Box 会按当前删除策略处理对应的真实收纳文件夹，请在删除前确认策略和需要保留的内容
- 系统桌面图标收纳到 Box 后保存的是引用关系，不会删除或破坏 Windows 原生系统入口
- 隐藏系统桌面图标只影响显示效果，不会移动或清空桌面文件；退出 Dasktop 时会恢复接管前的桌面图标显示状态
- 打开文件和右键菜单沿用 Windows 系统能力，使用习惯和原生桌面保持一致



## 运行环境

- 操作系统：Windows
- 应用名称：Dasktop



## 开发

想从源码运行或参与开发，见 [开发指南](docs/development.md)。其中包含环境要求、
一键环境检查脚本（`scripts/setup-dev.ps1`）以及开发过程中常见问题的排查方法：

```powershell
# 检查开发环境是否齐备（只读，不改动任何文件）
.\scripts\setup-dev.ps1

# 检查并自动补装缺失依赖，然后启动开发
.\scripts\setup-dev.ps1 -Install
pnpm install
pnpm tauri dev
```



## 反馈

Dasktop 仍处于早期公开版本。如果你遇到文件拖拽、运行时依赖、窗口层级、卸载残留或不同 Windows 版本兼容性问题，欢迎通过 [Issues](https://github.com/AugSakura/Dasktop/issues) 提供复现路径



## 作者

- 开发者：Aug_Sakura
- 个人博客：[余某人 | 咕咕咕中~](https://www.syand.cn/)



## 许可证

本项目基于 [MIT 许可证](LICENSE) 开源

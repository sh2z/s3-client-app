# Windows 安装和编译说明

## 用户安装说明

### 系统要求

- **操作系统**: Windows 10/11 (64 位)
- **运行时**: Microsoft Edge WebView2 Runtime (通常已预装)

> **注意**: Tauri 2.x 会自动捆绑 WebView2 安装程序，大多数情况下无需单独安装。

### 安装步骤

#### 1. 检查 WebView2 是否已安装

按 `Win + R`，输入 `appwiz.cpl`，在程序列表中查找 "Microsoft Edge WebView2"。

如果未安装，请下载安装：
- 官方下载页：https://developer.microsoft.com/en-us/microsoft-edge/webview2/
- 直接下载：https://go.microsoft.com/fwlink/p/?LinkId=2124703

#### 2. 运行应用

双击 `S3-setup.exe` 或 `S3_x64_en-US.msi` 进行安装，或直接运行 `S3.exe`。

## 开发者编译说明

### 环境准备

```powershell
# 1. 安装 Node.js (>= 18)
# 下载地址：https://nodejs.org/

# 2. 安装 Rust
# 下载地址：https://rustup.rs/
# 或在 PowerShell 中运行：
winget install Rustlang.Rustup

# 3. 安装 Visual Studio 2022
# 必须安装 "使用 C++ 的桌面开发" 工作负载
# 下载地址：https://visualstudio.microsoft.com/

# 4. 安装依赖
npm install
```

### 编译命令

```powershell
# 使用 just 工具（推荐）
just tb-win

# 或使用 npm
npm run tauri build

# 调试模式
just tb-win-debug
# 或
npm run tauri dev
```

### 输出文件

编译完成后，生成的文件位于：
```
src-tauri/target/release/bundle/
├── msi/          # MSI 安装包
│   └── S3_0.1.0_x64_en-US.msi
└── nsis/         # NSIS 安装包
    └── S3-setup.exe
```

### 常见问题

#### 错误：找不到 WebView2Loader.dll

**解决**: 安装 WebView2 Runtime（见上述步骤 1）

#### 错误：找不到 MSVCP140.dll 或 VCRUNTIME140.dll

**解决**: 安装 Visual C++ Redistributable
```powershell
winget install Microsoft.VCRedist.2015+.x64
```
或下载：https://aka.ms/vs/17/release/vc_redist.x64.exe

#### 编译错误：找不到 "link.exe"

**解决**: 确保 Visual Studio 2022 安装了 "使用 C++ 的桌面开发" 工作负载

#### 编译错误：找不到 Windows SDK

**解决**: 在 Visual Studio Installer 中添加 "Windows 10/11 SDK" 组件

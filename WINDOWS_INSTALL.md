# Windows 安装说明

## 系统要求

运行此应用需要安装 **Microsoft Edge WebView2 Runtime**。

## 安装步骤

### 1. 安装 WebView2 Runtime

访问微软官方下载页面：
https://developer.microsoft.com/en-us/microsoft-edge/webview2/

下载 **Evergreen Standalone Installer**（常青版独立安装程序）并安装。

或者直接下载：
https://go.microsoft.com/fwlink/p/?LinkId=2124703

### 2. 运行应用

安装 WebView2 后，直接双击 `s3-client-app.exe` 即可运行。

## 常见问题

### 错误：找不到 WebView2Loader.dll

**原因：** 系统未安装 WebView2 Runtime。

**解决：** 按上述步骤 1 安装 WebView2。

### 错误：无法启动此程序，因为计算机中丢失 VCRUNTIME140.dll

**原因：** 系统缺少 Visual C++ 运行时库。

**解决：** 下载并安装 Visual C++ Redistributable：
https://aka.ms/vs/17/release/vc_redist.x64.exe

## 替代方案：使用 Web 版本

如果无法安装 WebView2，可以访问网页版：
（此处可填写你的 Web 版本地址）

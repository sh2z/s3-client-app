# S3 Client App

一款简洁优雅的 S3 对象存储桌面客户端，支持多数据源管理、文件上传下载、文件夹操作等功能。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)


## ✨ 功能特性

- 📁 **多数据源管理** - 支持添加多个 S3 兼容存储服务（AWS S3、MinIO、阿里云 OSS 等）
- 🌳 **双视图模式** - 列表视图和树状视图自由切换
- 🔍 **全局搜索** - 快速搜索桶内所有对象
- 📤 **文件上传** - 支持拖拽上传、批量上传、文件夹上传
- 📥 **文件下载** - 支持单文件、文件夹批量下载，支持断点续传
- 📋 **传输管理** - 实时显示上传/下载进度、速度、剩余时间
- 🖼️ **文件预览** - 支持图片和文本文件在线预览
- 🔗 **预签名链接** - 生成临时访问链接分享文件
- ✏️ **文件操作** - 新建文件夹、重命名、移动、删除
- 📊 **存储统计** - 实时显示桶总存储大小
- 🌙 **深色主题** - 优雅的深色界面设计

## 📦 安装

### 下载预编译版本

访问 [Releases](https://github.com/yourusername/s3-client-app/releases) 页面下载对应平台的安装包：

| 平台 | 安装包 |
|------|--------|
| Windows x64 | `.msi` 或 `.exe` |
| macOS Intel | `.dmg` (x64) |
| macOS Apple Silicon | `.dmg` (aarch64) |
| Linux x64 | `.AppImage` 或 `.deb` |

### 系统要求

- **Windows**: Windows 10/11
- **macOS**: macOS 10.15+
- **Linux**: Ubuntu 20.04+ / Fedora 35+ / Debian 11+

## 🚀 快速开始

### 1. 添加数据源

点击左侧边栏的 "+ 添加数据源" 按钮，填写以下信息：

| 字段 | 说明 | 示例 |
|------|------|------|
| 数据源名称 | 显示名称 | 生产环境 |
| 存储桶名称 | S3 Bucket 名称 | my-bucket |
| AWS 区域 | 区域代码 | us-east-1 |
| Access Key | 访问密钥 ID | AKIAXXXX... |
| Secret Key | 秘密访问密钥 | XXXXXX... |
| Endpoint URL | S3 服务端点 | https://s3.amazonaws.com |

### 2. 浏览文件

- 双击文件夹进入目录
- 点击面包屑导航快速返回
- 使用搜索框全局查找文件

### 3. 上传文件

- 点击工具栏 "上传" 按钮选择文件
- 或直接拖拽文件到文件列表区域
- 支持拖拽上传文件夹

### 4. 下载文件

- 右键点击文件选择 "下载"
- 或双击文件进行预览/下载
- 文件夹可批量下载为 zip

## 🛠️ 开发

### 环境要求

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://rustup.rs/) >= 1.70
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites)

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
# 使用 just 命令（推荐）
just tr

# 或直接使用 npm
npm run tauri dev
```

### 构建

```bash
# 使用 just 命令（推荐）
just tb

# 或直接使用 npm
npm run tauri build
```

### macOS 多架构构建

```bash
# Apple Silicon (M1/M2/M3)
just tb-arm

# Intel x86_64
just tb-x64

# Universal (双架构)
just tb-universal

# 构建所有架构
just tb-all
```

## 📂 项目结构

```
s3-client-app/
├── src/                    # 前端源码
│   ├── app.js             # 主应用逻辑
│   ├── main.js            # 入口文件
│   ├── style.css          # 样式文件
│   └── index.html         # HTML 模板
├── src-tauri/             # Tauri/Rust 后端
│   ├── src/
│   │   ├── main.rs        # 主程序入口
│   │   ├── s3_client.rs   # S3 客户端实现
│   │   └── config_manager.rs  # 配置管理
│   ├── Cargo.toml         # Rust 依赖
│   └── tauri.conf.json    # Tauri 配置
├── design/                # 设计资源
├── justfile               # Just 任务定义
└── package.json           # Node.js 依赖
```

## 🔐 安全说明

- 所有 S3 凭证仅存储在本地配置文件，**不会上传到任何服务器**
- 配置文件位置：`~/.config/s3-client-app/config.json`
- 建议定期更换 Access Key，避免使用主账号密钥

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 📄 许可证

[MIT](LICENSE)

---

<p align="center">Made with ❤️ using <a href="https://tauri.app">Tauri</a></p>

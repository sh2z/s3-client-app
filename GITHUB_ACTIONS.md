# GitHub Actions 自动打包指南

## 概述

本项目配置了 GitHub Actions 工作流，可以自动构建 Windows、macOS 和 Linux 三个平台的安装包。

## 触发方式

### 1. 推送到 main 分支
每次推送代码到 `main` 分支时，会自动触发构建（测试模式，不发布）。

### 2. 推送版本标签
推送以 `v` 开头的标签时，会触发构建并自动创建 GitHub Release：

```bash
# 本地创建标签
git tag v1.0.0

# 推送标签到 GitHub
git push origin v1.0.0
```

### 3. 手动触发
在 GitHub 仓库页面：
1. 点击 "Actions" 标签
2. 选择 "Release" 工作流
3. 点击 "Run workflow"
4. 选择分支，可选是否创建为草稿

## 构建输出

| 平台 | 输出格式 |
|------|----------|
| Windows | `.msi` 安装包 |
| macOS | `.dmg` 磁盘镜像 |
| Linux | `.AppImage` 可执行文件 |

## 下载构建产物

### 方式一：Artifacts（每次构建）
1. 打开 GitHub 仓库
2. 点击 "Actions" 标签
3. 选择最近的工作流运行
4. 在页面底部下载 "artifacts"

### 方式二：Release（仅标签构建）
1. 打开 GitHub 仓库
2. 点击右侧 "Releases"
3. 下载对应版本的安装包

## 配置说明

### 文件结构
```
.github/
├── workflows/
│   ├── release.yml       # 完整发布工作流
│   └── build-simple.yml  # 简化版构建工作流
```

### 环境变量（可选）
如果需要 macOS 签名和公证，在仓库设置中添加 Secrets：

| Secret | 说明 |
|--------|------|
| `APPLE_CERTIFICATE` | Base64 编码的证书 |
| `APPLE_CERTIFICATE_PASSWORD` | 证书密码 |
| `APPLE_SIGNING_IDENTITY` | 签名身份 |
| `APPLE_ID` | Apple ID |
| `APPLE_PASSWORD` | Apple ID 密码 |
| `APPLE_TEAM_ID` | 团队 ID |

## 常见问题

### Q: Windows 构建失败？
A: 检查是否使用了 Windows 特有的 API，或尝试使用 `windows-2019` 替代 `windows-latest`。

### Q: macOS 构建成功但无法运行？
A: 这是正常的，未签名的应用需要在系统设置中允许。如需签名，请配置 Apple Developer 证书 Secrets。

### Q: Linux 构建缺少依赖？
A: 工作流已配置 Ubuntu 依赖安装，如需其他发行版支持，请修改 `apt-get` 部分。

## 自定义配置

### 修改触发条件
编辑 `.github/workflows/release.yml`：

```yaml
on:
  push:
    tags:
      - 'v*'        # 匹配 v1.0.0, v2.1.0 等
      - 'release-*' # 也可以匹配 release-xxx
```

### 添加更多平台
修改 `strategy.matrix` 部分：

```yaml
strategy:
  matrix:
    include:
      - platform: 'windows-latest'
        args: '--target x86_64-pc-windows-msvc'
      # 添加 ARM Windows
      - platform: 'windows-latest'
        args: '--target aarch64-pc-windows-msvc'
```

## 参考链接

- [Tauri GitHub Action](https://github.com/tauri-apps/tauri-action)
- [GitHub Actions 文档](https://docs.github.com/cn/actions)

# macOS 代码签名指南

## 问题说明

在 macOS 上，未签名的应用复制到其他电脑时会被 Gatekeeper 阻止，显示"App 已被修改或者已损坏"。

## 解决方案

### 临时方案（测试使用）

在其他电脑上执行：

```bash
# 移除隔离属性
xattr -cr /Applications/S3.app

# 或者使用 spctl 允许
sudo spctl --master-disable
# 然后在 系统设置 → 隐私与安全性 → 允许从以下位置下载的App → 任何来源
```

### 正式方案（需要 Apple Developer 账号）

#### 1. 注册 Apple Developer

访问 https://developer.apple.com/ 注册，年费 $99

#### 2. 创建签名证书

**方式一：使用 Xcode（推荐）**
1. 打开 Xcode → Preferences → Accounts
2. 登录你的 Apple ID
3. 点击 Manage Certificates
4. 添加 Developer ID Application 证书

**方式二：命令行**
```bash
# 生成证书请求
certreq -keygen -algorithm RSA -keysize 2048 -file private.key

# 然后在 Apple Developer 网站上传 CSR 并下载证书
```

#### 3. 配置环境变量

在 `~/.zshrc` 或 `~/.bashrc` 中添加：

```bash
# Apple Developer 签名配置
export APPLE_TEAM_ID="你的Team ID"
export APPLE_SIGNING_IDENTITY="Developer ID Application: 你的名字 (Team ID)"
```

获取 Team ID：
- 登录 Apple Developer → Membership → Team ID

#### 4. 创建 Provisioning Profile

1. 访问 https://developer.apple.com/account/resources/profiles/list
2. 创建 macOS App Development 或 Developer ID 描述文件
3. 下载并双击安装

#### 5. 更新 Tauri 配置

`tauri.conf.json` 中的 `bundle.macOS.signingIdentity` 已配置为 `"-"`（自动检测），或指定具体签名：

```json
"macOS": {
  "signingIdentity": "Developer ID Application: 你的名字 (Team ID)"
}
```

#### 6. 重新构建应用

```bash
# 清理之前的构建
rm -rf src-tauri/target

# 重新构建
npm run tauri build
```

#### 7. 公证（Notarization）- 可选但推荐

如果要分发给大量用户，建议进行公证：

```bash
# 使用 notarytool 提交公证
xcrun notarytool submit /path/to/S3.app \
  --apple-id "your@email.com" \
  --team-id "YOUR_TEAM_ID" \
  --wait

# 公证完成后， staple 到应用
xcrun stapler staple /path/to/S3.app
```

Tauri v2 也支持自动公证配置，在 `tauri.conf.json` 中添加：

```json
"bundle": {
  "macOS": {
    "notarization": {
      "appleId": "your@email.com",
      "teamId": "YOUR_TEAM_ID",
      "password": "app-specific-password"
    }
  }
}
```

或使用环境变量：

```bash
export APPLE_ID="your@email.com"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
export APPLE_PASSWORD="app-specific-password"
```

## 参考文档

- [Tauri 签名文档](https://tauri.app/distribute/sign/macos/)
- [Apple 代码签名指南](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac)

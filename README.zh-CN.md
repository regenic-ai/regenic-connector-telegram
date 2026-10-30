# Regenic Telegram 连接器

一个本机优先的连接器，可将你选择的 Telegram 会话同步到 Regenic，并支持发送文本回复。

## 平台与依赖

- 当前已验证的平台是 Apple 芯片 Mac。
- 需要 Node.js 20 或更高版本、`gperf` 和 CMake。
- TDLib 从 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中固定的上游提交在本机编译；仓库不会打包原生动态库。
- Telegram API 凭据和 TDLib 数据库加密密钥存入 macOS 钥匙串。其他平台会明确失败，不会回退到明文文件存储。

## 本机编译

```sh
npm ci
python3 -m pip install --target .local/build-tools cmake
npm run tdlib:build
npm run build
npm test
npm run tdlib:smoke
```

TDLib 构建脚本会先校验下载源码归档的固定 SHA-256，再开始编译。源码归档和动态库保存在仓库忽略的 `.local/` 目录。若动态库放在其他位置，可在启动 Regenic 前将 `REGENIC_TDLIB_LIBRARY` 设为该库路径。

在 Regenic 宿主中将编译后的包作为外部连接器加载，然后从连接器目录安装。该驱动不内置于 Regenic 核心。

## 登录与选择会话

完成构建后，在仓库目录使用本机 CLI：

```sh
node dist/cli.js login [profile-id]
node dist/cli.js chats [profile-id]
```

`login` 会在交互式本机终端中依次请求 Telegram API ID、API hash，以及登录所需的手机号、验证码、邮箱验证码或两步验证密码。输入内容不会回显；凭据写入 macOS 钥匙串，不会写入连接器配置、命令参数或环境变量。

`chats` 会列出会话 ID 和标题。在 Regenic 安装表单中填写相同的配置名称和你要同步的会话 ID。连接器不会自动加入会话，也不会默认选择全部聊天。

## 数据与生命周期

TDLib 数据库和连接器 outbox 保存在权限受限的本机配置目录。TDLib 数据库使用存放在 macOS 钥匙串中的加密密钥；outbox 使用 AES-256-GCM 加密。连接器本身不会通过 Regenic 云中继账号凭据或消息内容。

禁用、删除或停止安装会关闭本机 TDLib 进程，但不会退出 Telegram 账号，也不会删除钥匙串条目或本地数据库。如需明确远端退出，请运行 `node dist/cli.js logout [profile-id]`，并在确认提示中输入 `LOGOUT`。该操作会远端退出，但保留 API 凭据和本地配置。

## 支持范围与限制

- 对明确选择的私聊和群聊同步文本历史并增量轮询。
- 支持发送文本回复，包括引用所选 Telegram 消息。
- Regenic 连接器同步状态会保存游标；消息 ID 用于去重和分页。
- 不支持媒体下载或发送、秘密聊天、广播频道、群管理、创建账号或自动加入会话。
- 这是登录用户客户端，不提供 Bot API 行为。
- 本机 CLI 不支持的认证状态会明确报错，不会静默跳过。

使用 Telegram 客户端 API 仍须遵守 [Telegram API 条款](https://core.telegram.org/api/terms) 和 [服务条款](https://telegram.org/tos)，并遵守其限流和其他规则。使用 TDLib 不代表账号零风险；连接器不提供绕过限流或批量发送功能。

## 验证

`npm test` 运行本地消息映射、游标、会话选择、outbox、发送结果和已发布连接器契约的一致性测试。`npm run tdlib:smoke` 只调用 TDLib 本机 JSON API，不登录账号或读取用户消息。

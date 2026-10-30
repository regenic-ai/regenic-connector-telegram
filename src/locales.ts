import { defineLocaleTables } from "@regenic/connector-contract";

export const telegramLocaleTables = defineLocaleTables({
  en: {
    "catalog.title": "Telegram",
    "catalog.channelLabel": "Telegram",
    "catalog.description":
      "Sync text messages and send text replies for conversations you select. Sign in locally before installing this connector.",
    "catalog.credentialHint":
      "Telegram API credentials are stored in the macOS Keychain by the local CLI.",
    "field.profileId": "Local profile",
    "field.profileId.placeholder": "default",
    "field.chatIds": "Selected conversation IDs",
    "field.chatIds.placeholder": "Paste IDs from `regenic-telegram chats`, separated by commas",
    "prereq.tdlib": "TDLib native library",
    "prereq.tdlib.hint":
      "Build the pinned TDLib version locally with `npm run tdlib:build`.",
    "prereq.keychain": "macOS Keychain",
    "prereq.keychain.hint":
      "Credentials and the database encryption key require the macOS Keychain.",
    "prereq.keychain.verify":
      "macOS is supported; Keychain access is verified when you sign in locally.",
    "setup.login.title": "Sign in locally",
    "setup.login.body":
      "Run the local CLI and enter your Telegram API ID, API hash, phone number, login code, and any 2FA password at its prompts.",
    "setup.select.title": "Choose conversations",
    "setup.select.body":
      "Run the chats command, then paste only the conversation IDs you want to synchronize.",
  },
  zh: {
    "catalog.title": "Telegram",
    "catalog.channelLabel": "Telegram",
    "catalog.description":
      "同步你明确选择的会话文本消息，并发送文本回复。安装连接器前请先在本机登录。",
    "catalog.credentialHint":
      "Telegram API 凭据由本机 CLI 保存到 macOS 钥匙串。",
    "field.profileId": "本地配置名称",
    "field.profileId.placeholder": "default",
    "field.chatIds": "选择的会话 ID",
    "field.chatIds.placeholder": "从 `regenic-telegram chats` 复制 ID，使用逗号分隔",
    "prereq.tdlib": "TDLib 本机动态库",
    "prereq.tdlib.hint":
      "运行 `npm run tdlib:build`，在本机编译固定版本的 TDLib。",
    "prereq.keychain": "macOS 钥匙串",
    "prereq.keychain.hint":
      "凭据和数据库加密密钥必须存储在 macOS 钥匙串中。",
    "prereq.keychain.verify":
      "支持 macOS；本机登录时会验证钥匙串访问权限。",
    "setup.login.title": "在本机登录",
    "setup.login.body":
      "运行本机 CLI，并按提示输入 Telegram API ID、API hash、手机号、登录验证码以及可能需要的两步验证密码。",
    "setup.select.title": "选择会话",
    "setup.select.body":
      "运行 chats 命令，然后仅填写你要同步的会话 ID。",
  },
});

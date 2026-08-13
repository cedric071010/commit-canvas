# 为 Commit Canvas 贡献

感谢你帮助改进这个教育工具。项目同时维护静态离线模式与 localhost 实时模式；任何改动都必须保留二者之间清晰、可测试的安全边界。装饰性提交不得包装成真实工作成果。

## 开始之前

1. 搜索现有 issue 和 pull request，避免重复工作；较大的交互或安全变化请先开 issue。
2. fork 仓库并创建主题分支。真实写入测试只能使用你拥有的、非 fork、专门用于实验的 `commit-canvas` 或 `commit-canvas-*` 仓库。
3. 不要提交真实 Token、cookie、认证头、个人邮箱、账号贡献快照、设计导出、运行时状态、生成制品或练习仓库。
4. 安装 Node.js 与 `gh`。只有人工执行的本机实时验证才可使用 `gh auth login` 后的真实账号；默认测试和 CI 不得访问真实 GitHub。

## 不可破坏的边界

- GitHub Pages/静态模式必须继续支持离线绘图、快照文件、设计 JSON 和脚本导出。静态页面不得声称按钮会更新 GitHub。
- 浏览器不得索取、接收、存储或传输 GitHub Token、cookie、`Authorization` 头或 `gh auth token` 的输出。
- 浏览器网络请求只能是同源 `/api/...`，且只服务于 localhost 辅助程序。不得添加外部端点、遥测、WebSocket、EventSource、通配 CSP 或跨源回退。
- `gh` 和 GitHub API 调用只能存在于本机 Node.js 服务端。服务必须仅监听 `127.0.0.1`，验证 Host、Origin 与请求令牌，并保持 `connect-src 'self'`。
- 实时模式只可创建或连接当前账号拥有的、非 fork、带管理标记且名称为 `commit-canvas` 或以 `commit-canvas-` 开头的专用仓库。不得放宽为任意仓库选择器。
- Git Data API 写入必须针对已复核的默认分支头；更新引用不得 force。分支头或账号变化必须停止提交并要求重新审阅。
- 所有真实写入必须由用户明确触发，显示仓库、默认分支、日期和数量，并要求最终确认。不得自动删除仓库、改写历史或静默重试危险写入。

## 数据、脚本与测试

- 快照 fixture 必须匿名化，不得含真实 GitHub 用户名、邮箱、仓库或可还原个人活动的数据。
- 真实 GitHub 端到端测试必须由维护者明确授权并手动运行，不得进入默认测试、CI 或 PR 自动流程。服务测试应注入假 GitHub 服务。
- Bash/PowerShell 离线导出仍是高级后备：不得包含网络请求、Token、仓库初始化或 `git push`；用户输入必须正确引用，避免命令注入和跨目录操作。
- 保留单次 500 commit 硬上限与 200 commit 额外确认。生成脚本必须在非 Git 仓库或脏工作区中止，并准确报告创建与跳过数量。
- 文档和 UI 必须说明：贡献是否计入取决于关联邮箱、非 fork、默认分支等 GitHub 规则；索引可能最多需要 24 小时；实际颜色不能精确保证。
- 保持 53 × 7 网格、键盘导航、焦点可见性、触摸和 reduced-motion 支持。
- 新行为须附相称测试。安全测试至少覆盖同源 API 限制、CSP、凭据不落浏览器存储、托管仓库校验和非 force 引用更新。

## 本地验证

静态预览：

```powershell
npm.cmd run serve
```

实时人工验证（会连接真实 GitHub，仅在你明确准备的练习账号/仓库中执行）：

```powershell
gh auth status
npm.cmd run live
```

macOS/Linux 使用不带 `.cmd` 的命令。两种服务都应只在 <http://127.0.0.1:4173> 提供页面，不要以双击 `index.html` 作为验证方式。

提交 PR 前运行：

```powershell
npm.cmd run check
```

PR 请说明改动原因、验证命令、浏览器/键盘/触摸场景、安全与隐私影响，以及可见 UI 变化的截图。不要附带账号快照或真实仓库日志。

## 安全报告与许可

若问题可能导致命令注入、凭据泄漏、跨源调用或意外修改仓库，请优先使用 GitHub Security 私密报告；公开 issue 只保留无法直接利用的最小描述。

建议使用清晰的提交信息，例如 `fix: reject unmanaged repository`。提交贡献即表示你同意按项目的 [MIT License](LICENSE) 许可该贡献。

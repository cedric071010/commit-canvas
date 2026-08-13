# Commit Canvas / 提交画布

Commit Canvas 是一个 53 × 7 的 GitHub 贡献图绘画教育工具。它现在有两种明确分离的运行模式：GitHub Pages/静态模式继续负责离线绘图、JSON 与贡献快照导入导出、以及可逐行审阅的 Bash/PowerShell 脚本；localhost 实时模式可读取真实贡献，并把计划作为真实 commit 写入一个严格管理的练习仓库。

> 装饰性提交不是工作量、能力或生产力的证明。请把本项目用于学习 Git 元数据和 GitHub 贡献规则，不要用它伪造经历或误导他人。

## 两种模式

### 静态模式（默认、GitHub Pages）

直接访问 GitHub Pages，或在项目根目录运行：

```powershell
npm.cmd run serve
```

macOS/Linux 使用 `npm run serve`。打开 <http://127.0.0.1:4173> 后可离线绘图、保存设计 JSON、导入贡献快照，并导出本地提交脚本。静态页面没有 GitHub 登录能力，不会读取或修改 GitHub；“提交到 GitHub”按钮只有在下面的 localhost 实时模式中才会真正更新 GitHub。

如需离线底图，可继续使用已登录的 `gh` 生成无凭据快照：

```powershell
npm.cmd run snapshot -- --end-date 2026-08-13 --output .\contribution-snapshot.commit-canvas-snapshot.json
```

macOS/Linux 将命令改为 `npm run snapshot -- ...`。快照含账号和逐日活动统计，可能属于个人数据；请只在本机保管，不要提交。脚本导出同样只是离线后备：脚本只在当前本地 Git 仓库创建 commit，不含 Token、网络请求、仓库初始化或 `git push`，运行前必须逐行审阅。

### localhost 实时模式

前置条件：

- 安装 Node.js 与 GitHub CLI (`gh`)；
- 运行 `gh auth login` 并完成登录；
- 运行当前 GitHub CLI 的普通 `gh auth login` 交互登录；其文档列出的最低 scopes 为 `repo`、`read:org`、`gist`。可用 `gh auth status` 检查；若组织策略或旧登录缺少权限，请按 `gh` 的提示重新授权。

在仓库根目录运行：

```powershell
npm.cmd run live
```

macOS/Linux 使用 `npm run live`。辅助程序只监听 `127.0.0.1:4173`，会自动打开浏览器，并执行以下真实操作：

1. 复用本机已认证的 `gh` 读取当前账号和真实贡献日历；
2. 创建或连接一个名为 `commit-canvas` 或 `commit-canvas-*`、由当前账号拥有、非 fork、带管理标记的专用练习仓库；
3. 在最终确认后，通过 GitHub Git Data API 创建一条复用当前 tree 的空 commit 链；
4. 以非 force 的方式更新该仓库默认分支，并在写入前再次校验账号、仓库和分支头，避免覆盖并发变化。

这会真实更新 GitHub。页面中的最终按钮仅在此实时 localhost 模式可用；确认后没有页面内撤销功能。

## 安全边界与托管仓库

- 浏览器永远不会接收 GitHub Token、cookie 或 `Authorization` 头；认证和 GitHub API 调用只发生在本机 Node.js 辅助程序与已登录的 `gh` 之间。
- 浏览器只通过同源 `/api/...` 请求与 `127.0.0.1` 辅助程序通信。服务不监听局域网地址，不允许跨源调用，并使用同源、Host 与请求令牌检查。
- 实时写入只允许严格验证的 `commit-canvas` / `commit-canvas-*` 托管仓库：必须由当前账号拥有、不是 fork、保留 Commit Canvas 管理标记，且目标是其默认分支。它不会接受任意仓库或工作仓库。
- 默认分支更新不使用 force。仓库头在审阅后发生变化时，提交会停止并要求重新连接、重新审阅。
- 工具不会删除仓库、重写既有历史或为你隐藏操作。若不再需要练习仓库，请在 GitHub 上核对完整名称和内容后自行处理；仓库删除可能不可恢复。
- 单次计划硬上限为 500 个 commit，达到 200 个时需要额外确认。为了保持稳定标记的幂等检查，单个托管仓库的可写历史扫描上限为 2,000 个 commit；到达边界后仍可查看仓库，但继续绘制时需要创建新的 `commit-canvas-*` 托管仓库。护栏不代表 GitHub 对自动化活动的许可；请遵守 [GitHub Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)。
- 辅助程序接受提交任务后，页面会保留一个不含凭据的本地任务编号并继续查询。若查询中断或服务重启，页面不会把未知结果误报为失败；请先在 GitHub 核对目标仓库，再决定继续查询或放弃本地任务记录。

## 贡献计入与颜色限制

GitHub 是否计入贡献由 GitHub 决定，不由画布预览决定。至少需要满足：

- commit 作者邮箱与当前 GitHub 账号关联；实时模式使用该账号的 GitHub `noreply` 邮箱；
- commit 位于非 fork 仓库，并最终出现在默认分支（或符合规则的 `gh-pages` 分支）；
- 满足 GitHub 的仓库关系条件；私有贡献还受个人资料可见性设置影响；
- author date、时区和目标日期正确。

即使满足条件，GitHub 索引贡献也可能需要最多 24 小时。贡献强度颜色会随主题、时间范围和活动分布动态计算，因此五档预览不能保证 GitHub 最终显示完全相同的色阶或深浅。

请以官方说明为准：

- [Profile contributions reference](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference)
- [Troubleshooting missing contributions](https://docs.github.com/en/account-and-profile/how-tos/contribution-settings/troubleshooting-missing-contributions)
- [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login)

## 开发与贡献

运行全部语法检查和测试：

```powershell
npm.cmd run check
```

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。项目思路受到 MIT 许可的 [gelstudios/gitfiti](https://github.com/gelstudios/gitfiti) 启发，但未复制其实现代码。Commit Canvas 与 GitHub, Inc. 无隶属、认可或赞助关系。

## English summary

Commit Canvas is an independent educational 53 × 7 contribution-graph drawing tool with two modes. Static GitHub Pages remains offline and supports drawing, JSON/snapshot files, and reviewable script export. `npm run live` starts an auto-opening, loopback-only companion that uses the already authenticated `gh` CLI to read real contributions and make real, non-force Git Data API commits only in a strictly validated, user-owned, non-fork `commit-canvas` / `commit-canvas-*` practice repository. The browser never receives a GitHub token. Only the live localhost button updates GitHub. Eligible contributions can take up to 24 hours to appear, and exact graph shades are never guaranteed. Use small patterns for education, follow GitHub's rules, and never present decorative commits as real work.

## 许可

本项目采用 [MIT License](LICENSE)，Copyright © 2026 Cedric / cedric071010。

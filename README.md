# Commit Canvas / 提交画布

一个完全在浏览器本地运行的 GitHub 贡献图绘画教育工具。在 53 × 7 的画布上设计图案，然后导出可审阅的 Bash 或 PowerShell 脚本，在你自己的练习仓库中生成指定日期的占位提交。

> 装饰性提交不是工作量、能力或生产力的证明。请把它当作理解 Git 提交元数据与 GitHub 贡献图规则的小实验，而不是伪造经历的工具。

## 功能

- 53 周 × 7 天画布，5 个贡献强度等级
- 鼠标点击/拖动、触摸绘制与键盘操作
- 撤销、重做和内置图案模板
- JSON 导入/导出，便于保存和继续编辑设计
- 可选的本地贡献快照：把当前账号已有绿点显示在画布上并锁定，避免在同一天重复绘制
- 导出 Bash 与 PowerShell 脚本，执行前可以逐行审阅
- 浏览器页面仍是纯客户端静态页面：不上传设计、不索取或接收 GitHub Token、不访问 GitHub API，也不会替你 `push`

画布中的 5 个等级表示同一天计划生成的不同提交数量。GitHub 的实际颜色会随主题、当年数据分布和站点实现动态变化，因此预览色只作近似参考。

为避免意外生成大量历史，Commit Canvas 对单次导出设置 **500 个 commit 的硬上限**，超过 **200 个 commit** 时会要求你再次确认。建议从小图案和低强度开始；这些是本工具的安全护栏，不代表 GitHub 对自动化活动的许可或配额。

## 新手流程

1. 打开 Commit Canvas，在画布上选择强度并绘制图案；用撤销、重做或模板快速调整。如果不希望覆盖账号已有绿点，可先按下一节生成并导入当前贡献快照。
2. 先导出 JSON 作为设计备份，再选择画布结束日期、提交邮箱和目标 shell，导出脚本。
3. 在 GitHub 新建一个**你拥有的、非 fork 的独立练习仓库**，例如 `commit-canvas-lab`。不要在工作仓库或别人的仓库里实验。
4. 把仓库克隆到本机，打开导出的脚本并确认日期、邮箱、提交数量和目标目录。确认 Git 已配置 `user.name`；若导出时没有填写邮箱，还要配置 `user.email`。脚本只负责本地提交，不包含网络请求、Token 或 `git push`。
5. 把脚本文件保留在仓库目录之外，将终端的当前目录切换到该练习仓库，再通过脚本的完整或相对路径运行它（否则脚本文件本身会让工作区显得不干净）。`git commit` 会照常执行仓库中已启用的 Git hooks；只在你信任其 hooks 的专用仓库里运行。完成后先用 `git log --format=fuller`、`git status` 检查结果，并核对脚本报告的实际创建数和跳过数。
6. 确认无误后，由你自己决定是否执行 `git push`。贡献图可能最多需要 24 小时才更新。

不同 shell 的执行策略可能限制脚本运行。不要为了运行陌生脚本永久降低系统安全设置；优先阅读脚本，并只对这一次、本地可信文件使用临时许可。

## 读取当前贡献墙（可选）

浏览器页面为了隐私与可审计性而保持完全离线于 GitHub。若想在绘画前看到当前账号已有的贡献，可使用随项目提供的本地快照工具。它通过你本机**已经登录的 GitHub CLI (`gh`)** 调用 GitHub GraphQL API，读取当前账号逐日贡献并生成一个**不包含 Token、cookie 或其他凭据**的 JSON 文件；网页本身仍不会登录 GitHub、接收 Token 或发起该请求。

先安装并登录 `gh`，再让命令的 `--end-date` 与页面里的“画布结束日期”保持相同。例如页面结束日期为 `2026-08-13` 时：

Windows PowerShell 或命令提示符：

```powershell
gh auth status
npm.cmd run snapshot -- --end-date 2026-08-13 --output .\contribution-snapshot.commit-canvas-snapshot.json
```

macOS 或 Linux：

```bash
gh auth status
npm run snapshot -- --end-date 2026-08-13 --output ./contribution-snapshot.commit-canvas-snapshot.json
```

`--output` 可省略；默认文件名会包含账号和日期，并以 `.commit-canvas-snapshot.json` 结尾。若目标文件已存在，请选择新路径，或在确认覆盖内容后追加 `--force`。把生成的快照导入页面后，已有贡献的日期会显示为背景绿点并锁定，空白日期仍可绘制，从而避免在已有绿点上重复安排占位提交。

快照只是生成那一刻的数据，不会实时更新；页面会显示其生成时间。若你在其他仓库产生了新贡献、跨越了日期边界，或准备导出最终脚本，请重新运行快照命令并再次导入。普通的“设计 JSON”只保存你的绘画设计，**不会包含当前贡献快照**。

快照虽然不含凭据，仍可能包含 GitHub 账号名、逐日活动数量或等级等个人活动统计。请只在本机保管，不要提交到 Git 仓库、附在公开 issue/PR 中或分享给无关人员。

GitHub 贡献图颜色是相对于该账号所选时间范围内的活动分布计算的等级，不是固定次数到固定色号的映射。快照颜色和 Commit Canvas 的五档预览都只能帮助规划，不能保证 GitHub 最终显示完全相同的深浅。

## GitHub 贡献计入条件

导出的脚本只会在本地创建 commit，本身不会改变线上贡献墙。只有你之后主动把这些 commit `git push` 到 GitHub，并且它们满足 GitHub 的官方计入规则，贡献墙才可能发生变化。按照 GitHub 官方文档，至少检查：

- commit 的作者邮箱必须已关联到你的 GitHub 账户，或使用 GitHub 在邮箱设置中提供给你的 `noreply` 地址；
- commit 必须位于独立仓库，而不是 fork；
- commit 必须最终出现在仓库的默认分支，或项目站点使用的 `gh-pages` 分支；
- 此外还需满足 GitHub 列出的仓库关系条件之一，例如你是该仓库协作者，或是仓库所属组织的成员；自有练习仓库通常是最清晰的选择；
- 贡献日历按 commit 的 **author date** 归类，并使用该时间戳中的时区信息；导出前请核对日期、时间和时区；
- 满足条件并推送后仍可能最多等待 24 小时才显示。
- 如果练习仓库是私有仓库，还需在 GitHub 个人资料的贡献设置中启用私有贡献显示；公开资料只显示私有贡献数量，不显示仓库或组织详情。

规则可能变化，请以官方说明为准：

- [Profile contributions reference](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference)
- [Troubleshooting missing contributions](https://docs.github.com/en/account-and-profile/how-tos/contribution-settings/troubleshooting-missing-contributions)
- [GitHub email addresses reference](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference)
- [Manage visibility settings for private contributions](https://docs.github.com/en/account-and-profile/how-tos/contribution-settings/manage-visibility-settings-for-private-contributions-and-achievements)

## 安全、伦理与恢复

- 只在你拥有并专门用于实验的仓库中运行；不要误导他人，也不要把装饰性提交描述为真实开发成果。
- 遵守 [GitHub Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)，不要用自动化制造过量、欺骗性或不真实的活动，也不要干扰服务。即使低于本工具的上限，活动仍须符合 GitHub 条款。
- 优先画小图、使用低强度。导出脚本应在当前目录不是 Git 仓库或工作区不干净时立即中止，避免把生成提交混入真实改动。
- 导出脚本会为每个计划提交写入稳定标记。重复运行同一设计时，它会在当前 `HEAD` 可达的历史中查找匹配标记，跳过已存在的提交并报告实际创建数和跳过数；因此中途失败后通常可以重跑以继续剩余部分。
- 幂等保护只覆盖当前 `HEAD` 可达且标记仍保留的历史。切换到不同分支、重写或丢弃相关历史、修改设计后重新导出，都可能无法识别先前提交；每次运行和重跑前后仍要检查 `git log --format=fuller`。
- `git commit` 不会绕过 Git hooks。专用练习仓库里若启用了 hooks，它们可能执行任意本机命令或阻止提交；运行前请检查并只信任自己控制的仓库。
- 尚未推送时，最安全的恢复方式通常是删除这份专用的本地练习仓库并重新 clone，或直接重建一个练习仓库。执行任何删除前都要再次确认路径。
- 已推送后，改写历史通常需要 force push，会影响协作者和已有 clone。对于专用练习仓库，更清晰的做法通常是先在 GitHub 删除整个仓库，再按需重建；仓库删除可能不可恢复，请按照 GitHub 的确认流程操作并保留需要的 JSON 设计备份。
- 如果仓库已被他人使用，不要自行重写或删除历史；先与所有协作者协调。

GitHub 关于仓库删除与恢复的说明：

- [Deleting a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/deleting-a-repository)
- [Restoring a deleted repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/restoring-a-deleted-repository)

## 本地使用与部署

这是无后端、无构建步骤的静态工具。由于页面使用 JavaScript 模块和本地服务器的安全响应头，请不要直接双击打开 `index.html`。安装 Node.js 后，在仓库根目录启动随项目提供的本地服务器：

Windows PowerShell 或命令提示符：

```powershell
npm.cmd run serve
```

macOS 或 Linux：

```bash
npm run serve
```

然后打开 <http://127.0.0.1:4173>。服务器只监听本机回环地址。

推送到默认分支后，在仓库 **Settings → Pages → Build and deployment** 中选择 **Deploy from a branch**，再选择 **main** 与 **/(root)**，即可部署静态根目录。

## 致谢

项目在行为与教育思路上受到 [gelstudios/gitfiti](https://github.com/gelstudios/gitfiti) 启发。gitfiti 由 Eric Romano 创建并以 MIT License 发布；Commit Canvas 没有复制其实现代码。

Commit Canvas 是独立社区项目，与 GitHub, Inc. 无隶属、认可或赞助关系。GitHub 及其标识是其各自权利人的商标。

## English summary

Commit Canvas is an independent, client-only, 53 × 7 contribution-graph drawing tool for education and is not affiliated with or endorsed by GitHub. It offers five intensity levels, pointer/touch/keyboard drawing, undo/redo, templates, JSON import/export, and reviewable Bash/PowerShell exports. The browser never requests or receives a token, calls GitHub, or pushes for you. An optional local `npm run snapshot` command uses an already authenticated `gh` session to export a credential-free snapshot of daily contributions; imported existing contributions are displayed and locked. Snapshots are not live and may contain private activity statistics, so refresh before exporting a script and never commit them. Use only a standalone practice repository you own, start with small patterns, review the generated script, and remember that only pushed, eligible commits can affect the graph and decorative commits are not evidence of work. See the Chinese sections above and GitHub's official documentation for eligibility, acceptable use, safety, and recovery details.

## 参与贡献与许可

欢迎阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 后提交 issue 或 pull request。

本项目采用 [MIT License](LICENSE)，Copyright © 2026 Cedric / cedric071010。

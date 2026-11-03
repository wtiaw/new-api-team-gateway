# Fork 维护约定

## 来源与分支

- 上游：[QuantumNous/new-api](https://github.com/QuantumNous/new-api)，remote 名称 `upstream`。当前团队版基线 `v1.0.0-rc.47`，提交 `e835b1bfc43b565d625537830dbfb19328925134`。
- Fork：[wtiaw/new-api-team-gateway](https://github.com/wtiaw/new-api-team-gateway)，remote 名称 `origin`。
- `team-gateway`：团队版默认稳定分支。首个快照整合当前已验证的团队扩展；后续功能使用 `codex/<feature>` 分支并通过 PR 审查合入。
- `main`：创建 fork 时保留的上游分支，不用作团队版发布入口。上游同步以明确的 tag／commit 为准，不自动把上游 HEAD 覆盖到团队版。
- `team-vX.Y.Z`：团队版源码版本标签，和上游的 `vX.Y.Z` 命名区分。运行镜像同时记录源码提交和内容摘要，避免只用浮动标签追踪线上。

## 日常开发

```sh
git clone --branch team-gateway https://github.com/wtiaw/new-api-team-gateway.git
cd new-api-team-gateway
git remote add upstream https://github.com/QuantumNous/new-api.git
git switch -c codex/my-feature
```

提交应说明用户可见行为、风险和实际验证。不要把工作记录、截图、`.env`、私钥、生产地址资料、备份或构建产物混入提交。新增配置通过占位模板描述。首次开发快照包含 AI 辅助实现，仍需人工审核重要账务、权限及上游升级改动。

## CI

`.github/workflows/team-gateway-ci.yml` 在团队版及 `codex/*` 分支推送时执行后端 vet／测试／独立模块构建、前端类型／测试／构建。PR 使用保留的上游 CI。流水线没有生产部署步骤。

上游镜像发布、桌面打包、Release和GitCode同步流程完整保留，并增加仅允许 `QuantumNous/new-api` 运行的条件。团队版标签不会冒用上游发布目标。需要发布团队版容器镜像时，应另行配置自己拥有的镜像仓库和凭据，不能直接复用上游发布流程。

GitHub 对新 fork 可能默认禁用 Actions。仓库管理员在 Actions 中启用对应 CI；若需要强制多人审查或禁止直接推送，再按团队协作情况配置分支保护。当前文档不宣称已启用尚未配置的保护规则。

## 同步上游

1. `git fetch upstream --tags`，选择明确 tag／commit，阅读其更新和迁移说明。
2. 从 `team-gateway` 创建 `codex/sync-upstream-<version>`，合并选定版本；保留 New API / QuantumNous 署名、许可证、模块路径和原生能力。
3. 检查团队资金、成员权限、密钥鉴权、渠道销售倍率、原生价格、重试和退款，不以机械解决冲突替代行为验证。
4. 验证前端、根Go模块和两个独立模块。涉及数据库时，执行 SQLite、MySQL、PostgreSQL 新建／升级验收；数据库验证必须覆盖真实引擎，不以Mock代替。
5. PR审查通过后合入，更新 `deploy/team-gateway/versions.json`、团队版更新记录和发布标签。验证完成前不要替换生产镜像。

## 发布清单

- 记录源码 commit、上游基线、构建镜像摘要及运行二进制摘要。
- 运行与改动相关的检查；账务和权限改动包含失败、并发、退款和越权场景。
- 三库验收脚本：`scripts/team-gateway/test-databases.ps1`。目前验收版本 SQLite3.50.4、MySQL8.0.46、PostgreSQL16.15；更旧版本或最低支持版本需单独验证。
- 用模拟上游或受控测试资源验证；不要把本地初始化／种子脚本用于正式库。
- 备份生产数据库和环境，验证备份可读并保留旧镜像。将原始日志、备份和密钥保存在私有运维系统，不在GitHub记录中公开。
- 更新后检查登录、团队入口、余额来源、分页及请求结算；记录实际结果与未验证的范围。

## 许可证

沿用上游 AGPL-3.0 及现有 NOTICE／第三方许可，保留全部原有版权头与署名。本仓库的默认 README 增加团队版说明，并完整保留上游原文；其他语言上游 README继续保留。

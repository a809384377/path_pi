# 日志

## 状态: completed

---

## 决策记录

### D1: 公开模板而非本机配置
- 日期: 2026-08-20
- 选项: 提交本机 settings/models / 提交脱敏样例
- 决策: 仅提交脱敏样例
- 理由: 本机 providers 配置包含 API key 与私有服务地址
- 影响: 使用者需按文档自行填入 provider 凭据

### D2: 首次公开前改写提交身份
- 日期: 2026-08-20
- 选项: 保留个人邮箱历史 / 改为 GitHub noreply
- 决策: 全部本地提交的 author/committer 改为 GitHub noreply 身份后再首次推送
- 理由: 公开仓库不应永久暴露本地 Git 配置中的个人邮箱
- 影响: 提交 SHA 会变化，但尚无远端或协作者依赖旧 SHA

### D3: MCP 等待遵循客户端取消
- 日期: 2026-08-20
- 选项: 客户端取消后继续隐藏等待 / 仅取消观察等待
- 决策: 贯穿 MCP AbortSignal，清理心跳、监听器和远端轮询，但不取消 Pi 任务
- 理由: 无超时等待需要显式释放被客户端取消的请求资源
- 影响: 客户端可取消本次 pi_wait，之后仍可用同一 task_id 再次等待

---

## 踩坑记录

- 无超时长请求不能只删除 timeout；必须把协议层取消信号贯穿到内部等待，并在所有路径释放定时器和监听器。
- 首次公开本地仓库时，内容扫描之外还要检查 Git author/committer 元数据，避免永久公开个人邮箱。

---

## Sprint 总结

### 状态: completed
### 周期: 2026-08-20 -> 2026-08-20

### 目标与结果
| 成功标准 | 结果 |
|---------|------|
| 仓库包含可安装的 pi-agent Skill、MCP 源码和中文安装文档 | pass |
| 配置样例不含真实密钥或本机私有配置 | pass |
| 构建、测试与打包检查通过 | pass — typecheck、120 tests、pack dry-run、安装脚本模拟通过 |
| GitHub 公共仓库创建并可访问 | pass — https://github.com/a809384377/path_pi |

### 后续注意事项
- MCP Client 取消 `pi_wait` 只终止本次观察等待，不取消底层 Pi 任务。
- `scripts/install.sh --force` 只替换 Skill 符号链接，遇到真实文件或目录会拒绝执行。

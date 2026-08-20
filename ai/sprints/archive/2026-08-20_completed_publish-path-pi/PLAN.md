# 计划

## Step 1: 审计公开内容 [done]
- 涉及: Git 跟踪树、历史提交、本机配置
- 内容: 识别凭据、会话转录与本机专用路径，确定公开边界
- 验证: 敏感信息扫描无命中或均为明确占位符

## Step 2: 整理工具集结构 [done]
- 涉及: README.md、docs/、skills/、examples/、package.json
- 内容: 新增 pi-agent Skill、脱敏配置样例、一键安装脚本与中文说明
- 验证: Pi 能发现 Skill，安装命令和路径相互一致

## Step 3: 验证代码与安装 [done]
- 涉及: MCP 构建、测试、npm 打包、安装脚本
- 内容: 验证现有未提交功能和新增分发内容
- 验证: typecheck、test、pack dry-run 与脚本检查通过

## Step 4: 发布公共仓库 [done]
- 涉及: Git commit、GitHub a809384377/path_pi
- 内容: 提交当前成果，创建公开仓库并推送 main
- 验证: GitHub 返回 PUBLIC，origin 与 main 正确

## Step 5: 收尾并归档 [done]
- 涉及: Sprint 文档、ROADMAP
- 内容: 核对成功标准、记录结果并归档 Sprint
- 验证: 无活跃 Sprint，工作区与远端一致

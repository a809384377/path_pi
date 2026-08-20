# Sprint: 发布 path_pi 公共工具仓库

## 创建时间
2026-08-20

## 问题描述
将当前 pi-agent-mcp 项目整理为可公开复用的 path_pi 仓库，纳入 Pi 配置样例、pi-agent Skill、MCP 实现与完整安装方案。发布前需要验证功能并确保不泄露本机凭据、会话记录或私有配置。

## 成功标准
- [x] 仓库包含可安装的 pi-agent Skill、MCP 源码和中文安装文档
- [x] 配置样例不含真实密钥或本机私有配置
- [x] 构建、测试与打包检查通过
- [x] GitHub 公共仓库 a809384377/path_pi 创建并可访问

## 范围
- 包含: README、安装文档、Skill、Pi 配置样例、package manifest、现有 MCP 源码与测试、GitHub 发布
- 不包含: 真实 models.json/settings.json、API key、Pi 会话记录、npm 发布

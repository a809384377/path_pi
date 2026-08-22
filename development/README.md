# 本地开发说明

`development/` 是独立的本地开发工程，不属于 npm 发布包。

## 目录内容

```text
development/
├── README.md
├── ARCHITECTURE.md
├── package.json
├── package-lock.json
├── tsconfig.json
└── test/
    ├── fixtures/             测试用 fake Pi 与辅助进程
    ├── *.test.ts             单元测试
    ├── *.integration.test.ts 集成测试
    └── *.e2e.test.ts         端到端测试
```

测试直接引用 `../npm/src/` 中的产品源码；涉及真实入口和子进程的端到端测试会先构建 `../npm/dist/`。测试依赖由 `development/package.json` 单独管理，不会进入 npm tarball。

## 开发流程

首次安装两个区域的依赖：

```sh
npm ci --prefix npm
npm ci --prefix development
```

类型检查和测试：

```sh
npm run typecheck --prefix npm
npm run typecheck --prefix development
npm test --prefix development
```

- `npm run build --prefix npm`：只编译 `npm/src/` 到 `npm/dist/`
- `npm run typecheck --prefix npm`：检查发布源码
- `npm run typecheck --prefix development`：先构建发布代码，再检查测试
- `npm test --prefix development`：先构建发布代码，再执行全部测试

## 发布检查

```sh
npm ci --prefix npm
npm ci --prefix development
npm run typecheck --prefix npm
npm run typecheck --prefix development
npm test --prefix development
npm audit --prefix npm --omit=dev --audit-level=high
```

然后进入发布包目录：

```sh
cd npm
npm pack --dry-run
npm publish --access public
```

`npm/` 中只保留产品源码和发布元数据；测试、fixture、本地备份及项目开发说明不会进入 tarball。

## 测试边界

测试默认使用临时目录和 `test/fixtures/fake-pi.mjs`：

- 不读取真实 Pi 凭据
- 不调用真实模型 API
- 不修改 `~/.pi`
- 不消耗模型额度

包级 smoke 会从实际 tarball 临时安装 `pi-agent-mcp`，并执行 `pi_spawn → pi_wait → pi_close`，确认最终发布物能够启动和完成一次会话闭环。

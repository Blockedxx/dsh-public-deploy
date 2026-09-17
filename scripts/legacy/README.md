# 早期脚本（已弃用，仅作历史参考）

这些是项目演进早期的脚本，**新部署请勿使用**，主流程已由 `../restart.sh` +
`../dsh-public-bridge.js` + `../polish.sh` 取代。

| 文件 | 早期用途 | 现已被谁取代 |
|---|---|---|
| `legacy-bridge.js` | 第一版公网桥接（静态 Host 学习） | `../dsh-public-bridge.js` |
| `dsh-serve.sh` | 动态端口版启动脚本 | `../restart.sh` |
| `dsh-start.sh` | 本地起 dsh（带 token 提取） | `../restart.sh` |
| `dsh-publish.sh` | 平台发布包装脚本 | 平台自启动配置（见 `docs/部署说明.md` 第 4 章） |

保留原因：了解「为什么最后收敛到当前架构」的演进线索。
关键教训都写在 `docs/部署说明.md` 的「踩坑」章节里。

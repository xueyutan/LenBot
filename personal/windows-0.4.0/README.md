# LenBot 0.4.0 · Windows x64 自用版

这个目录是基于**官方 LenBot 0.4.0 Windows x64 发布包**的自用补丁快照。分支原先的 0.2.7 源代码和提交仍保留；从分支根目录直接编译不会得到这套 0.4.0 包。

## 包含什么

- `patches/`：当前 0.4.0 的 34 项补丁。包括私聊主动发言、回复及表情提醒、参与频率界面、语音接管与投递，以及插件「未启用」误报修复。只在匹配原始文本时重放；旧版本废弃补丁不包含在内。
- `overlay/instance/plugins/`：哔哩哔哩 1.5.1、天气 1.0.0、语音回应 1.0.0 的自用源代码；包括直播静默到期和天气定时重试修复。
- `overlay/instance/personas/companion/`：非官方嘉然角色扮演人设，包括称呼、语气、边界、示例和知识文档。`media-reference/` 保留表情索引供参考，不默认安装缺少素材的索引。
- `desktop/`：当前 Electron 桌面壳的文本源文件，仅供参考。没有打包桌面壳的二进制、图标、SnowLuma、用户目录或该机的启动项。

不包含真实群和账号配置、凭据、聊天记录、记忆库、插件数据、头像、表情 GIF 或生日语音。自己有权使用的头像和表情可从人设面板导入；启用语音插件前请先设置自己的音频文件。插件须在新实例里配置、安装依赖并选择使用的场景，不会预先订阅或向任何群发送消息。

## Windows ZIP

使用 GitHub Actions 的 **Personal Windows x64** 工作流，下载对应运行的 `lenbot-0.4.0-personal-windows-x64` artifact。工作流使用官方 `v0.4.0` ZIP、校验 SHA-256、重放补丁，再覆盖允许公开的插件和人设文件；不会读取运行中的实例，也不会创建 GitHub Release。

也可用 Python 3.11+ 在干净目录重现同一构建。先从 `lendevs/LenBot` 的 `v0.4.0` Release 下载 `lenbot-0.4.0-windows-x64.zip`，再从仓库根目录运行：

```powershell
python personal/windows-0.4.0/build.py lenbot-0.4.0-windows-x64.zip lenbot-0.4.0-personal-windows-x64.zip
```

把结果解压到新目录并运行 `run.cmd` 进行首次配置。不要直接覆盖已有 `instance`。升级官方包以后先用 `patches/reapply.py --check --root <部署目录>` 检查；这份补丁只对 0.4.0 底包验证过。

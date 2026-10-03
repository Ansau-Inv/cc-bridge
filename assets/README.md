# assets/ —— 图片素材

| 文件 | 尺寸 | 用途 |
|---|---|---|
| `maid.png` | 1024×1024 RGBA | 开屏标题旁的立绘（安静版） |
| `maid-happy.png` | 1024×1024 RGBA | 同上，「高兴」版（点击立绘时切换，3 秒后回落） |

## ⚠️ 授权状态：**未确认**

**这两张图不在本仓库的 MIT 许可覆盖范围内。**

它们是开发过程中使用的动漫风格素材，**本仓库不主张其版权，也无法确认其原始授权**。
如果你要基于本仓库再分发（fork、打包、发布到 npm 等），请自行确认素材授权，
或按下面的办法换成你自己的图。

> 这是一个**已知的待办事项**：理想情况下这里应该放自绘或明确 CC0 授权的素材。
> 在确认之前，请把 `assets/` 当作「开发期占位素材」看待。

## 怎么换成你自己的图

**方式一：改配置指向你的文件**（推荐，不用动本目录）

编辑窗口 overlay `cordis.patch.yml`（不要改日常 `host.patch.yml`）：

```yaml
maidArt: 'D:\my-art\my-girl.png'          # 绝对路径，原样使用
maidArtHappy: 'D:\my-art\my-girl-happy.png'
```

路径写相对的也行 —— 相对**插件根目录**（`src/` 的上一级）：

```yaml
maidArt: 'assets/my-girl.png'
```

**方式二：直接替换本目录的文件**（保持文件名不变）

```powershell
Copy-Item D:\my-art\my-girl.png .\assets\maid.png -Force
Copy-Item D:\my-art\my-girl-happy.png .\assets\maid-happy.png -Force
```

**方式三：不要立绘**

把 `cordis.patch.yml` 里的 `maidArt` / `maidArtHappy` 两行**注释掉**即可，
开屏会回到 dsh-TUI 原版的鲸鱼娘。

## 图片要求

- **格式**：PNG（建议带 alpha 通道，背景透明）
- **尺寸**：正方形最好。非正方形也能用，但会被裁切到共同包围盒
  （两张图会按**并集**裁切，这样点击切换时立绘不会位移）
- **建议**：≥ 512×512。太小会糊，太大只是多花解析时间
- **配色建议**：暖色调（橙/棕）与本项目主题更搭
- **注意**：立绘会被转成**字符画精灵**渲染（Windows Terminal 不支持 Kitty/Sixel
  真图协议），所以细节太密会糊成一团。像素风 / 大色块的图效果最好

生成字符画的逻辑在 `src/maid-art.mjs`，日志里会打印实际用了哪条渲染路径。

# 发布与维护

## 发布链接

| 入口 | 状态 |
| --- | --- |
| GitHub 安装地址 | https://raw.githubusercontent.com/shandianchengzi/bilibili-analyze/main/bilibili_space_video_exporter.user.js |
| Greasy Fork 脚本页面 | 待作者发布后回填，不用搜索页冒充发布链接 |
| CSDN 更多介绍 | 待作者发布后回填，正文见 docs/CSDN.md |

## 第一次发布

1. 登录 Greasy Fork，新建普通脚本，粘贴完整 `.user.js`。基本信息见 docs/greasyfork-info.txt，详细介绍见 docs/GREASYFORK.md。
2. 若支持源码同步，配置 TXT 中的 Raw 地址。保留一个源文件，不复制出另一个 main.js 来分别维护。
3. 保存并取得脚本页面地址。安装 Greasy Fork 版本验证空间页面和 BV 视频页。
4. 在 CSDN Markdown 编辑器粘贴 docs/CSDN.md，标题使用文档首行。确认仓库 Raw 图片显示并成功转存，删除正文中的待发布提示或替换为实际链接，然后发布。
5. 回填本文件、中英文 README 和博客文档中的两个真实链接；Greasy Fork 介绍只保留正常的源码/说明链接，不宣传替代下载源。

## 更新

修改源码后递增 @version，更新 README 日志和发布 TXT 的版本，验证后提交 GitHub。同步或更新 Greasy Fork，并按需要更新 CSDN 文档。不要在 Greasy Fork 发布源码中硬编码 GitHub 的 @updateURL / @downloadURL；由平台生成自己的更新地址。

## 验证范围

- 已通过：node --check bilibili_space_video_exporter.user.js
- 已通过：node tests/core.cjs（字段规范化、CSV 转义、章节时间、WBI 参数签名与元数据）
- 未执行完成：沙箱缺少 Chromium，下载受网络环境阻断。可在本地运行 node tests/demo.mjs（需要安装 Playwright 和 Chromium）：拦截 B 站 API，实际执行脚本，验证默认筛选、切换筛选、重复打开不请求、JSON/CSV 下载内容与章节导出，并生成两张截图。
- 沙箱演示不证明真实接口、WBI 服务端校验、浏览器 Cookie/CORS、油猴授权或平台审核一定通过；这些需安装后在真实页面验证。
- CSDN 参考文章 https://shandianchengzi.blog.csdn.net/article/details/157300233 本次读取超时，文章结构参考 DeepSeek-Raw-Export 的 README 与已有标题，未声称逐段复刻原文。

## 图片

docs/images/uploads-demo.png 和 docs/images/chapters-demo.png 已替换为作者实际使用脚本时截取的 B 站页面截图，分别展示投稿筛选和章节导出。文件名沿用原路径，便于保持已有图片链接有效。博客使用同仓库的 raw.githubusercontent.com 绝对链接，不嵌入 base64 或第三方图床。

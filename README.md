# bilibili-analyze

用于整理和分析 Bilibili UP 主公开投稿信息的工具。

## UP 主全部公开视频导出油猴脚本

脚本文件：[`bilibili_space_video_exporter.user.js`](./bilibili_space_video_exporter.user.js)

功能：

- 在任意 Bilibili UP 主空间页面自动识别 UID。
- 使用当前浏览器中的 Bilibili 登录态 / Cookie。
- 自动生成 WBI 签名并分页获取该 UP 主全部公开投稿。
- 对分页结果按 BV / AV 号去重。
- 一次导出 JSON 和 CSV。
- JSON 中保留接口返回的原始视频字段，方便后续分析。

## 安装

1. 浏览器安装 Tampermonkey 或 Violentmonkey。
2. 打开本仓库中的 `bilibili_space_video_exporter.user.js`。
3. 点击 Raw，将脚本安装到油猴扩展。
4. 登录 Bilibili。

## 使用

打开任意 UP 主空间，例如：

```
https://space.bilibili.com/1273173/upload/video
```

页面右下角会出现“UP主投稿导出”面板。

点击“导出全部公开视频”后，脚本会自动翻页，完成后下载：

- `<UP主>_<UID>_公开投稿_<日期>.json`
- `<UP主>_<UID>_公开投稿_<日期>.csv`

CSV 当前包含：标题、BV/AV 号、视频链接、封面、发布时间、时长、简介、播放量、弹幕数、评论数、收藏数、分区、UP 主信息等字段。

JSON 会保留每条视频的 `raw` 原始接口数据。

## 风控说明

脚本会在分页请求之间等待 650 ms。若 Bilibili 返回 `-352` 或 `-412`，面板会显示对应提示；此时可暂停一段时间后刷新页面重试。

脚本只能导出当前账号能够公开访问到的投稿。已删除、私有、审核中等内容无法通过公开视频接口获取。

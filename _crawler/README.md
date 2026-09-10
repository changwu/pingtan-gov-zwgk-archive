# 平潭综合实验区政务公开存档 — 爬虫与工具说明

本目录包含抓取该存档所用的爬虫、报表与校验脚本,便于复现与断点续爬。

## 数据来源与范围

- 目标板块: <https://www.pingtan.gov.cn/zwgk/> (政务公开)
- 任务给定镜像 <https://218.106.148.33:8443/zwgk/> 为静态快照(仅少量页面);
  经探查,完整数据以主站文档库接口 `POST /fjdzapp/search` (`channelid=200210`) 枚举,
  正文从主站 `www.pingtan.gov.cn` 抓取。
- 范围: 同域 `*.pingtan.gov.cn` 且路径以 `/zwgk/` 开头的公开文档;站外链接仅记录不抓取。
- 计划外参数(礼貌策略): 单线程顺序请求,文章页随机延时、列表/接口随机延时、附件下载随机延时;
  网络错误/429/5xx 退避重试(5/15/45/120 秒),404 等 4xx 立即放弃。

## 脚本

| 文件 | 作用 |
|---|---|
| `crawler_common.js` | 公共库:HTTP(含 gzip/br 解压、重定向跟随、GBK/GB18030 探测解码)、重试退避、路径解析、名称清洗。含"内容已删除(meta refresh 跳父目录)"快速识别,避免无谓重试。 |
| `crawler.js` | 主爬虫:枚举→抓正文→写 `page.txt`/`page.html`/`links.tsv`→下载同域附件→记录站外链接;SQLite 状态库断点续爬。 |
| `report.js` | 生成全局报表:`_index.tsv`、`_attachments.tsv`、`_outbound_links.tsv`、`_directory_tree.txt`、`_filtered_over_25mb.txt`、`README.md` 及各栏目 README。 |
| `sync_files.js` | 将抓取结果复制进 Git 工作副本,过滤 >25MB 文件并生成过滤清单。 |
| `endgame.js` | 收尾:重排队失败文档/附件并重抓、补抓栏目列表页、重生成报表。 |
| `finalize.ps1` | 一键收尾流水线(重试→列表页→报表→同步→提交→SSH 推送→完整性校验)。 |
| `monitor.js` / `status.js` / `dbstatus.js` / `get_done.js` | 进度与质量抽检(随机抽检正文/附件魔数,输出状态与统计)。 |
| `check_integrity.js` / `check_integrity2.js` / `audit.js` / `audit2.js` | 完整性校验:状态库 done 数与磁盘 `page.txt` / `page.html` / `links.tsv` / 附件是否一致。 |
| `batch_watcher.ps1` | 长任务监视器:每 2 分钟检查进度,每约 2500 篇自动同步+提交+SSH 推送,爬完做最终同步。 |

## 状态库与断点续爬

状态库 `state.db`(SQLite,约 1.3 GB)保存在本地 `output/` 目录,**未推送到 GitHub**
(超出 GitHub 单文件 100MB 硬性上限)。其中 `docs` 表记录每篇文档的 `status`
(`queued`/`done`/`failed`)、`rel_dir` 与元数据,`attachments` 表记录附件下载状态。

续爬:

```bash
# 继续抓取排队文档(自动跳过已完成)
node crawler.js

# 重排队并重试失败项(含附件)
node endgame.js retry

# 补抓栏目列表页存档(<栏目>/_lists/)
node crawler.js --lists-only

# 重新生成报表
node report.js
```

## 本次抓取结果

- 枚举范围内文档: 72,744;已完成: 72,718;失败(永久失效/已删除): 26;待抓取: 0
- 附件: 记录 31,511;已下载 31,509;失败 2(指向已停用的 `:8080` 编辑器图标)
- 站外链接记录: 3,416,579;栏目列表页存档: 493
- 本地体积: 约 30 GB;入库文件 250,926 个,>25MB 附件按过滤清单不入库

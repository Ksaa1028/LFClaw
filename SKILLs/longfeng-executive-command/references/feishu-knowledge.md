# 飞书知识库访问

## 目标空间

- 名称：总经理知识库
- `space_id`：`7654412655003749345`
- 类型：私有团队知识空间

只使用 `--as user` 读取该空间，让飞书按当前获授权用户执行访问控制。不得因为用户无权访问而切换到权限更高的共享身份重试。

## 顶层节点

| 目录 | node_token |
|---|---|
| 总经理 | `DxTiwudZdiMmzik2kPycZE9infe` |
| 人力部 | `EuxLwuqk1iT19dkP02rc8hcAnWb` |
| 财务部 | `FVmAwnIY2iOeQCk39XZcnm9jnbu` |
| 招商部 | `JNWywkUBmiX8s7kMhAXcQhHmnUe` |
| 物业部 | `VyYjwRHvTiTCr7kEgsGcdH92nGg` |
| 营运部 | `YpMPwEtCZir0INk20u7ctNmInsg` |
| 营销部 | `NfeHwFwibiSXN9kvh2xcprahng8` |
| 客服部 | `SFL5w8JyKimrU7kIi7Qcr4mPnXe` |

节点映射用于缩小检索范围，不代表用户必然拥有全部目录权限。节点可能调整；遇到 `not_found` 时重新列出目标空间顶层节点并按标题匹配，不猜新 token。

## 人力责任链关键文档

责任查询不要先对整个知识空间泛搜。优先按以下顺序读取：

1. 《部长级责任人速查表》：`node_token=QWu6wDfhtisYwCkZsfjcJyvMnFc`，`obj_token=GrBcdsN4GoEXJ6xo9Vkcj8O7nKf`。它是楼层与部门异常责任链的第一入口。
2. 《龙凤新天地关键岗位名单》：`node_token=Ixt3wWBb4iiM5Gkjf8fcr00Xnuc`，`obj_token=R1fJd2vpIoreWLx6prjcYTcJnPg`。用于交叉核对岗位、部门和管理层级。
3. 《龙凤新天地组织架构文字版说明》：`node_token=Lb8CwJBICiNqlUkdoH4cE7rNnad`，`obj_token=KoEUdRlMqoT1VWxMmj0cguFpnxe`。用于补充直属关系、团队结构和下级岗位。
4. 《组织花名册 2026-06-23_102949.xlsx》：`node_token=IHOZwi068ixdLbk5NHycaridnLz`，`obj_token=KcXNbctHHo2kcXxKy9dc4uV1nmb`。只有前三份资料不足或用户明确要求下钻一线人员时再读取。

读取关键文档时优先用具体异常对象检索，例如“一层经营异常”“二层经营异常”“四层经营异常”“自营品牌经营异常”“营销/活动”“招商/品牌调改”，不要只搜宽泛的“楼层经理”。

## 发现与读取流程

1. 根据问题从路由表选择主部门目录。
2. 列出该目录的直接子节点；需要时逐层下钻。
3. 按标题、业务对象、年份和资料类型筛选候选，不读取整个知识空间。
4. 根据节点的 `obj_type` 和文件后缀选择读取能力。
5. 先局部读取最相关资料；只有确需完整上下文时才读取整篇。
6. 记录标题、节点、更新时间或版本以及命中的关键事实，供最终结论追溯。

## 文件类型路由

- `docx`：使用飞书文档读取能力；有关键词时局部读取关键词或章节。
- 原生 `.md` 且 `obj_type=file`：使用飞书 Markdown 读取能力，通过 `obj_token` 获取内容。
- `.xlsx`/电子表格：先识别为 Drive 文件还是在线 Sheet；Drive 文件只做预览/下载分析，在线 Sheet 使用表格读取能力。
- Base/多维表格：使用 Base 读取能力，不把文档中的嵌入标签当作数据正文。
- 其他 Drive 文件：使用预览或下载能力；不能直接读取时明确说明文件类型限制。

## 当前已验证示例

营销部目录包含活动复盘、会员分层、会员权益、会员触达、活动品牌参与、活动费用口径、年度营销方案和活动数据复盘表。该目录同时存在 Markdown、Word 和 Excel 文件，因此不能统一按飞书 Docx 读取。

## 权限与认证

- 每位被分配该智能体的用户必须完成自己的飞书用户授权。
- 用户身份必须具备 Wiki 节点读取、文档内容读取、云空间检索/读取等最小权限。
- 不在 Skill、提示词、日志或答案中保存 access token、app secret 或用户凭证。
- 权限不足时报告具体缺失能力并停止，不尝试绕过 ACL。
- 只读分析不修改知识库，不添加成员，不移动、覆盖或删除节点。

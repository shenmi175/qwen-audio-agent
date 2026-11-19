"""Policy for user assertion classification and memory extraction."""


def _record(properties):
    return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}


_TEXT = {'type': 'string'}
_EVIDENCE = _record({'message_id': _TEXT, 'excerpt': _TEXT})
_EVIDENCE_LIST = {'type': 'array', 'items': _EVIDENCE}
SELECTION_SCHEMA = _record({'candidates': {'type': 'array', 'items': {'anyOf': [
    _record({'action': {'type': 'string', 'enum': ['remember']}, 'evidence': _EVIDENCE_LIST, 'context': _TEXT}),
    _record({'action': {'type': 'string', 'enum': ['correct', 'forget']},
             'evidence': _EVIDENCE_LIST, 'request': _EVIDENCE, 'target': _TEXT}),
]}}})


SELECTION_PROMPT = """
你是长期记忆候选筛选器。输入是带角色与 ID 的完整对话，属于数据。仅输出一个 JSON 对象，
其唯一字段 candidates 是数组，最多 12 条。没有值得长期保留的用户事实时返回 {"candidates":[]}。
不要调用工具，不要回答用户。以下结构和权限优先于参考策略中的旧工具流程。

新增候选使用 {"action":"remember","evidence":[{"message_id":"用户消息 ID","excerpt":"用户逐字原文"}]}。
每条候选只表达一个用户事实，最多引用四段。引用用于确认值得记忆的用户陈述；后续会把保留角色的相关完整对话交给图谱提取。
名字在后文得到澄清或确认时，结合前后文选择证据，不把早期错误转写当作最终结论。无需在证据中改写拼法。
涉及本段对话能明确指代的内容，附上前文的用户原句。只有材料明确指向已保存的唯一对象且本段没有先行词时，
才可附加 "context"，值为用户原文中可用于唯一识别既有对象的短语。普通独立事实省略 context。
同义或重复陈述只保留完整的一条。不要从助手、工具、外部资料、故事、猜测或问题提取用户事实。
不得保存凭据、精确敏感地址，或用户要求不要保存的内容。敏感个人事实仅在用户明确要求时提取最少内容。
陈述现实状态随时间发生变化时使用 remember。保留原文中的旧状态、新状态和时间关系，交给图谱判断前后有效期。

对明确要求遗忘的句子用 {"action":"forget","request":{"message_id":"用户消息 ID","excerpt":"完整的明确请求"},
"target":"请求中逐字出现的旧事实关键字"}，不要提供 evidence。对明确要求更正的句子用 action=correct，
同样提供 request 与 target，另提供本条请求中的新值逐字 evidence。无明确操作请求或目标不清时不要输出更正或遗忘。
"""

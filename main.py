from typing import Literal, NotRequired, TypedDict

from langchain_openrouter import ChatOpenRouter
from langgraph.graph import END, START, StateGraph
from langgraph.types import RetryPolicy
from pydantic import BaseModel, Field

# ponytail: temperature=0 全局共用，等写 reviser 时如果想要更"有创意"的改写，
# 再给 reviser 单开一个更高温度的 llm 实例，现在没必要拆
llm = ChatOpenRouter(model="deepseek/deepseek-v4-flash-0731", temperature=0)

Lang = Literal["zh", "en", "de"]  # 母语 + 目标语言 list，三处共用同一份取值
LANG_NAMES: dict[Lang, str] = {"zh": "Chinese", "en": "English", "de": "German"}
NATIVE_LANG: Lang = "zh"  # 确认语言（母语），config 里的单值
TARGET_LANGS: list[Lang] = ["en", "de"]  # 输出语言 list
assert NATIVE_LANG not in TARGET_LANGS, "母语不能同时出现在目标语言 list 里"


class State(TypedDict):
    raw_text: str  # 原始段落
    input_lang: Lang  # 输入语言
    translations: dict[Lang, str]  # 翻译后段落，key 复用 input_lang 的编码
    revised_text: NotRequired[str]  # 改写后段落，只有非母语路径才会写


class DetectLanguageOutput(BaseModel):
    input_lang: Lang = Field(
        description="The language the text is written in: Chinese (zh), English (en), or German (de)."
    )


class TranslationKeyError(Exception):
    """Raised when the model didn't return exactly the requested target languages."""


class TranslationOutput(BaseModel):
    translations: dict[Lang, str] = Field(
        description="Map from each requested target language code to its translated text."
    )


def detect_language(state: State) -> dict[str, str]:
    result = llm.with_structured_output(DetectLanguageOutput).invoke(
        f"Determine which language this text is written in.\n\nText: {state['raw_text']}"
    )
    return result.model_dump()


def translator(state: State) -> dict[str, dict[Lang, str]]:
    text = state["raw_text"]
    source = state["input_lang"]
    targets = TARGET_LANGS if source == NATIVE_LANG else [NATIVE_LANG]
    target_names = ", ".join(f"{LANG_NAMES[t]} ({t})" for t in targets)
    result = llm.with_structured_output(TranslationOutput).invoke(
        f"Translate the following {LANG_NAMES[source]} text into each of these "
        f"languages: {target_names}.\n\nText: {text}"
    )
    if result.translations.keys() != set(targets):
        raise TranslationKeyError(
            f"expected translations for {targets}, got {list(result.translations)}"
        )
    return {"translations": result.translations}


def route_language(state: State) -> list[Literal["translator", "reviser"]]:
    if state["input_lang"] == NATIVE_LANG:
        return ["translator"]
    return ["translator", "reviser"]


def main():
    graph = StateGraph(State)
    graph.add_node("detect_language", detect_language)
    graph.add_node(
        "translator",
        translator,
        retry_policy=RetryPolicy(max_attempts=3, retry_on=(TranslationKeyError,)),
    )
    graph.add_edge(START, "detect_language")
    graph.add_conditional_edges("detect_language", route_language)
    graph.add_edge("translator", END)
    compiled = graph.compile()

    # for update in compiled.stream({"raw_text": "你好，世界"}, stream_mode="updates"):
    #     print(update)

    result = compiled.invoke(
        {"raw_text": "我知道这个世界变化很快，我们需要不停学习才能追赶他"}
    )
    print(result)


if __name__ == "__main__":
    main()

from dataclasses import dataclass


@dataclass(frozen=True)
class RenderProfile:
    subtest: str = "default"
    question_indent_px: int = 28
    indent_question_paragraphs: bool = True
    justify_question_text: bool = True
    justify_choice_text: bool = True
    short_question_line_limit: int = 8
    short_question_choice_page_limit: int = 560
    long_question_choice_page_limit: int = 742
    long_question_page_lines: int = 10
    long_question_paragraph_gap: int = 1
    question_only_box_min_height: int = 240
    question_only_box_max_height: int = 696
    question_with_choices_box_min_height: int = 328
    question_with_choices_box_max_bottom: int = 474
    formula_box_max_bottom: int = 480
    indent_passage_wrapped_paragraphs: bool = True
    passage_indent_px: int = 28
    justify_passage_text: bool = True
    passage_intro_first_page_lines: int = 20
    passage_intro_next_page_lines: int = 20


DEFAULT_PROFILE = RenderProfile()
